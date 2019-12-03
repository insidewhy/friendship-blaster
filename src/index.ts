import YAML from "yaml";
import path from "path";
import util from "util";
import {
  switchMap,
  pairwise,
  startWith,
  retryWhen,
  delay,
  tap,
  debounceTime,
} from "rxjs/operators";
import { Observable } from "rxjs";
import { exists, readFile, writeFile } from "fs";
import { once, mapValues } from "lodash";

import { getConfigFromArgv, Config, ImageSet, AuthConfig } from "./config";
import { spawnProcess, Process } from "./processes";
import {
  DockerComposeConfig,
  assertDockerComposeConfig,
  TaggedImages,
  pullChangedImages,
  assertTaggedImageList,
} from "./docker";
import pollImagesForUpdate from "./pollImagesForUpdate";
import { isDefined, debugLog, promiseFactoryToObservable } from "./util";

const pExists = util.promisify(exists);
const pReadFile = util.promisify(readFile);
const pWriteFile = util.promisify(writeFile);

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
        throw new Error("Invalid service found in docker-compose.yml");
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
  const composeFilePath = path.join(directoryPath, "docker-compose.yml");
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
  const respawn = async (
    dockerComposeConfig: DockerComposeConfig,
  ): Promise<void> => {
    await writeFblasterDockerCompose(
      fblasterComposeConfigPath,
      dockerComposeConfig,
    );

    if (proc) {
      const procCopy = proc;
      proc = undefined;
      await procCopy.shutdown();
    }
    proc = spawnProcess([
      "docker-compose",
      "-f",
      fblasterComposeConfigPath,
      "up",
      "-t",
      config.shutdownTimeout.toString(),
    ]);
  };

  respawn(initialDockerComposeConfig);

  return Object.freeze({
    respawn,

    shutdown(): void {
      if (proc) {
        proc.shutdown();
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
    tap(null, error => {
      console.warn("Error pulling changed images, retrying: %O", error);
    }),
    retryWhen(e => e.pipe(delay(DOCKER_PULL_RETRY_INTERVAL))),
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
    tap(null, error => {
      console.warn("Error restarting docker, retrying: %O", error);
    }),
    retryWhen(e => e.pipe(delay(DOCKER_COMPOSE_RESTART_RETRY_INTERVAL))),
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
 */
async function runFriendshipBlaster(config: Config): Promise<() => void> {
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
        console.info("Updated to latest configuration: %O", pollableImages);
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
    const onExit = once(await runFriendshipBlaster(config));

    process.on("exit", onExit);
    process.on("SIGINT", onExit);
    process.on("SIGTERM", onExit);
    process.on("uncaughtException", onExit);
  } catch (e) {
    console.warn(e.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
