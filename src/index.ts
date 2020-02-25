import YAML from "yaml";
import path from "path";
import util from "util";
import md5 from "md5";
import { switchMap, pairwise, startWith, debounceTime } from "rxjs/operators";
import { Observable, Subscription } from "rxjs";
import { exists, readFile, writeFile } from "fs";
import { once, mapValues } from "lodash";

import { getConfigFromArgv, Config, ImageSet, AuthConfig } from "./config";
import { runCommand, spawnProcess, Process } from "./processes";
import {
  DockerComposeConfig,
  assertDockerComposeConfig,
  TaggedImages,
  pullChangedImages,
  assertTaggedImageList,
  loginToContainerRepositories,
  restartVeryUnhealthyContainers,
} from "./docker";
import { getVeryUnhealthyDockerContainers } from "./healthcheck";
import pollImagesForUpdate from "./pollImagesForUpdate";
import {
  isDefined,
  debugLog,
  promiseFactoryToObservable,
  logErrorAndRetry,
} from "./util";

const pExists = util.promisify(exists);
const pReadFile = util.promisify(readFile);
const pWriteFile = util.promisify(writeFile);

const DOCKER_COMPOSE_YML = "docker-compose.yml";

// friendship-blaster calls docker-compose, not with the original docker-compose.yml
// but this file which is a rewritten version of the original. This allows
// friendship-blaster to modify the versions.
export const FBLASTER_COMPOSE_FILE = "fblaster-docker-compose.yml";
export const FBLASTER_VERSION_FILE = "fblaster-versions.yml";

const DOCKER_PULL_RETRY_INTERVAL = 3000;
const DOCKER_COMPOSE_RESTART_RETRY_INTERVAL = 3000;

declare module "yaml" {
  // the type declaraction incorrectly specifies the return type as "any"
  export function parse(file: string): Promise<unknown>;
}

/**
 * Signal a running version of friendship-blaster to poll for updates.
 */
async function runSignalPoll(directoryPath: string): Promise<void> {
  console.log("Signalling existing friendship-blaster to poll for updates");
  try {
    const containerName = `fblaster-${md5(directoryPath)}`;
    await spawnProcess(["docker", "kill", "-s", "SIGUSR2", containerName], {
      showStderr: true,
    }).wait();
    console.log("Signalled existing friendship-blaster to poll for updates");
  } catch (e) {
    console.warn(
      "Failed to signal existing friendship-blaster to poll for updates",
    );
    process.exit(1);
  }
}

/**
 * It returns the TaggedImage objects representing the repositories which match
 * the configured pollable images from the parsed docker-compose.yml.
 */
async function getPollableImages(
  dockerComposeConfig: DockerComposeConfig,
  pollSpec: ImageSet,
): Promise<TaggedImages> {
  const pollableImages = Object.values(dockerComposeConfig.services)
    .map(service => {
      if (typeof service !== "object") {
        throw new Error(`Invalid service found in ${DOCKER_COMPOSE_YML}`);
      }

      const imageStr = (service as { image?: string }).image;
      if (!imageStr) {
        return undefined;
      }

      const [repoUrl, imageAndTag] = imageStr.split("/");
      if (!repoUrl || !imageAndTag) {
        return undefined;
      }
      const [image, tag] = imageAndTag.split(":");
      if (!image || !tag) {
        return undefined;
      }

      const repoAndImage = `${repoUrl}/${image}`;
      return pollSpec.has(repoAndImage) || pollSpec.has(image)
        ? { repoUrl, image, tag }
        : undefined;
    })
    .filter(isDefined);

  return Object.freeze(pollableImages);
}

/**
 * Write the fblaster-docker-compose.yml containing the latest versions of
 * the images that should be run.
 */
async function writeFblasterDockerCompose(
  filePath: string,
  dockerComposeConfig: DockerComposeConfig,
): Promise<void> {
  const yamlString = YAML.stringify(dockerComposeConfig);
  await pWriteFile(filePath, yamlString);
}

/**
 * Returns an observable that emits all updates to the pollable images as they
 * are detected. The emitted docker images always represent the full set of
 * pollable images, not just those that have changed.
 */
function subscribeToImageUpdates(
  pollableImages: TaggedImages,
  config: Config,
): Observable<TaggedImages> {
  return pollImagesForUpdate(
    pollableImages,
    config.pollInterval,
    config.allowInsecureHttps,
    config.auth,
  );
}

/**
 * Parse the docker-compose.yml at the specified directory into the
 * corresponding DockerComposeConfig object.
 */
async function getDockerComposeConfig(
  directoryPath: string,
): Promise<DockerComposeConfig> {
  const composeFilePath = path.join(directoryPath, DOCKER_COMPOSE_YML);
  if (!(await pExists(composeFilePath))) {
    throw new Error(`${composeFilePath} must exit`);
  }

  const dockerComposeConfig = await YAML.parse(
    (await pReadFile(composeFilePath)).toString(),
  );
  assertDockerComposeConfig(dockerComposeConfig);
  return Object.freeze(dockerComposeConfig);
}

type RespawnDockerCompose = (
  dockerComposeConfig: DockerComposeConfig,
) => Promise<void>;

/**
 * A simple interface that can be used to respawn and shutdown a docker-compose
 * process.
 */
interface DockerComposeProcess {
  // Shut down existing process and then start new one with new configuration
  respawn: RespawnDockerCompose;

  shutdown: () => void;
}

/**
 * Shutdown docker-compose process because docker-compose often fails to shutdown
 * properly. It leaves containers around etc.
 */
async function shutdownDockerCompose(
  proc: Process,
  fblasterComposeConfigPath: string,
  shutdownTimeout: number,
): Promise<void> {
  try {
    await proc.shutdown();
  } catch (e) {
    console.warn("Error stopping docker-compose process: %O", e);
  }

  try {
    // try to clean up by running the stop command... this is done even after a
    // clean exit because even in that instance, docker-compose still manages
    // to leave containers running
    await runCommand([
      "docker-compose",
      "-f",
      fblasterComposeConfigPath,
      "stop",
      "-t",
      shutdownTimeout.toString(),
    ]);
  } catch (e) {
    console.warn("Error running `docker-compose stop`: %O", e);
  }
}

/**
 * Spawn docker compose and return a function that can be used to respawn it
 * with a new configuration.
 */
function spawnDockerCompose(
  config: Config,
  initialDockerComposeConfig: DockerComposeConfig,
): DockerComposeProcess {
  const fblasterComposeConfigPath = path.join(
    config.directory,
    FBLASTER_COMPOSE_FILE,
  );

  let proc: Process | undefined;
  let healthCheck: Subscription | undefined;

  const respawn = async (
    dockerComposeConfig: DockerComposeConfig,
  ): Promise<void> => {
    await writeFblasterDockerCompose(
      fblasterComposeConfigPath,
      dockerComposeConfig,
    );

    if (healthCheck) {
      healthCheck.unsubscribe();
    }
    if (proc) {
      const procCopy = proc;
      proc = undefined;
      await shutdownDockerCompose(
        procCopy,
        fblasterComposeConfigPath,
        config.shutdownTimeout,
      );
    }

    proc = spawnProcess([
      "docker-compose",
      "-f",
      fblasterComposeConfigPath,
      "up",
      "-t",
      config.shutdownTimeout.toString(),
    ]);

    healthCheck = getVeryUnhealthyDockerContainers(
      config.healthCheckInterval,
      config.illHealthTolerance,
      dockerComposeConfig,
    )
      .pipe(restartVeryUnhealthyContainers(config.shutdownTimeout))
      .subscribe();
  };

  respawn(initialDockerComposeConfig);

  return Object.freeze({
    respawn,

    async shutdown(): Promise<void> {
      if (healthCheck) {
        healthCheck.unsubscribe();
      }
      if (proc) {
        await shutdownDockerCompose(
          proc,
          fblasterComposeConfigPath,
          config.shutdownTimeout,
        );
      }
    },
  });
}

/**
 * Returns a copy of the passed docker compose config but with the docker
 * images in the `services` configuration updated to match the docker
 * image tags as specified by `pollableImages`.
 */
function mergePollableImagesWithDockerComposeConfig(
  pollableImages: TaggedImages,
  dockerComposeConfig: DockerComposeConfig,
): DockerComposeConfig {
  const newConfig = { ...dockerComposeConfig };
  newConfig.services = mapValues(newConfig.services, service => {
    const [repoUrl, imageAndTag] = service.image.split("/");
    if (!repoUrl || !imageAndTag) {
      return service;
    }
    const [image, tag] = imageAndTag.split(":");
    if (!image || !tag) {
      return service;
    }

    const matchingImage = pollableImages.find(
      pollableImage =>
        pollableImage.image === image && pollableImage.repoUrl === repoUrl,
    );

    if (matchingImage) {
      return {
        ...service,
        image: `${repoUrl}/${image}:${matchingImage.tag}`,
      };
    } else {
      return service;
    }
  });
  return newConfig;
}

/**
 * Merges the images represented by pollableImages into the docker compose
 * configuration, write this new configuration to fblaster-docker-compose.yml
 * and then restart docker-compose with this latest configuration.
 */
async function respawnDockerComposeWithNewConfig(
  pollableImages: TaggedImages,
  dockerComposeConfig: DockerComposeConfig,
  respawnDockerCompose: RespawnDockerCompose,
): Promise<void> {
  debugLog(
    "Restart docker-compose process with new config: %O - %O",
    pollableImages,
    dockerComposeConfig,
  );

  const newConfig = mergePollableImagesWithDockerComposeConfig(
    pollableImages,
    dockerComposeConfig,
  );
  await respawnDockerCompose(newConfig);
}

/**
 * Return an observable that tries to pull images again and again until
 * success. Due to the lazy nature of observables this retry process can be
 * cancelled by an unsubscription.
 */
const tryToPullImages = (
  auth: AuthConfig | undefined,
  [prevImages, newPollableImages]: [TaggedImages, TaggedImages],
): Observable<TaggedImages> => {
  return promiseFactoryToObservable(async () => {
    await pullChangedImages(auth, prevImages, newPollableImages);
    return newPollableImages;
  }).pipe(
    logErrorAndRetry(
      "Error pulling changed images, retrying: %O",
      DOCKER_PULL_RETRY_INTERVAL,
    ),
  );
};

interface DockerComposeConfigAndImages {
  config: DockerComposeConfig;
  images: TaggedImages;
}

/**
 * Return an observable that tries to restart docker-compose again and again
 * until success.
 */
const tryToRestartDockerCompose = (
  dockerComposeConfig: DockerComposeConfig,
  dockerComposeProc: DockerComposeProcess,
  newPollableImages: TaggedImages,
): Observable<DockerComposeConfigAndImages> => {
  return promiseFactoryToObservable(async () => {
    await respawnDockerComposeWithNewConfig(
      newPollableImages,
      dockerComposeConfig,
      dockerComposeProc.respawn,
    );
    return {
      images: newPollableImages,
      config: dockerComposeConfig,
    };
  }).pipe(
    logErrorAndRetry(
      "Error restarting docker, retrying: %O",
      DOCKER_COMPOSE_RESTART_RETRY_INTERVAL,
    ),
  );
};

async function writeVersionFile(
  directoryPath: string,
  pollableImages: TaggedImages,
): Promise<void> {
  const versionFilePath = path.join(directoryPath, FBLASTER_VERSION_FILE);
  const yamlString = YAML.stringify(pollableImages);
  await pWriteFile(versionFilePath, yamlString);
}

/**
 * Get the latest pollable image tags by parsing the fblaster version state
 * file if it exists. When it does not exist the original pollable image array
 * is returned.
 */
async function getLatestPollableImages(
  directoryPath: string,
  pollableImages: TaggedImages,
): Promise<TaggedImages> {
  const versionFilePath = path.join(directoryPath, FBLASTER_VERSION_FILE);
  if (!(await pExists(versionFilePath))) {
    return pollableImages;
  }

  const latestImages = await YAML.parse(
    (await pReadFile(versionFilePath)).toString(),
  );
  assertTaggedImageList(latestImages);

  return pollableImages.map(pollableImage => {
    const matching = latestImages.find(
      latestImage =>
        latestImage.repoUrl === pollableImage.repoUrl &&
        latestImage.image === pollableImage.image,
    );
    return matching ? { ...pollableImage, tag: matching.tag } : pollableImage;
  });
}

/**
 * The main entry point to the friendship blaster API.
 * Returns a promise that resolves to a function which can be used to shutdown
 * friendship blaster.
 */
async function runFriendshipBlaster(config: Config): Promise<() => void> {
  if (config.auth) {
    await loginToContainerRepositories(config.auth);
  }

  // the pure config before the latest versions as described by the
  // docker-compose.yml before the latest versions from the version state file
  // have been merged in
  const pureDockerComposeConfig = await getDockerComposeConfig(
    config.directory,
  );

  // the pollable images with the tags from the pure config
  const initialPollableImages = await getPollableImages(
    pureDockerComposeConfig,
    config.images,
  );

  const pollableImages = await getLatestPollableImages(
    config.directory,
    initialPollableImages,
  );
  const dockerComposeConfig =
    pollableImages === initialPollableImages
      ? pureDockerComposeConfig
      : mergePollableImagesWithDockerComposeConfig(
          pollableImages,
          pureDockerComposeConfig,
        );

  const dockerComposeProc = spawnDockerCompose(config, dockerComposeConfig);

  console.info("Run initial images: %O", pollableImages);

  const pollObservable = subscribeToImageUpdates(pollableImages, config);
  const pollSubscription = pollObservable
    .pipe(
      // the intial pollable images must appear as the previous image in the first pair
      startWith(pollableImages),

      debounceTime(config.debounce * 1000),

      // Emit in pairs of [previous, next]
      pairwise(),

      switchMap(tryToPullImages.bind(null, config.auth)),

      // Due to the chain of switchMap operators, if a new config is detected while the
      // images are still being pulled, the docker-compose restart for this config will
      // be discarded and a new attempt will only be made once the new configuraton has
      // been pulled
      switchMap(
        tryToRestartDockerCompose.bind(
          null,
          dockerComposeConfig,
          dockerComposeProc,
        ),
      ),

      switchMap(async (imagesAndConfig: DockerComposeConfigAndImages) => {
        await writeVersionFile(config.directory, imagesAndConfig.images);
        return imagesAndConfig.images;
      }),
    )
    .subscribe(
      (pollableImages: TaggedImages) => {
        console.info("Updated to latest images: %O", pollableImages);
      },
      (error: Error) => {
        console.error(
          "Error running subscription poller: %O",
          error ? error.message : error,
        );
      },
    );

  return (): void => {
    dockerComposeProc.shutdown();
    pollSubscription.unsubscribe();
  };
}

export default runFriendshipBlaster;

/**
 * The main process suitable for using friendship-blaster from the command-line
 * rather than as an API.
 */
async function main(): Promise<void> {
  try {
    const config = await getConfigFromArgv();

    if (config.signalPoll) {
      await runSignalPoll(config.directory);
    } else {
      if (!config.images.size) {
        console.warn("Must provide one of --images/-i or --signal-poll/-S");
        process.exit(1);
      }

      const onExit = once(await runFriendshipBlaster(config));

      process.on("exit", onExit);
      process.on("SIGINT", onExit);
      process.on("SIGTERM", onExit);
      process.on("uncaughtException", onExit);
    }
  } catch (e) {
    console.warn(e.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
