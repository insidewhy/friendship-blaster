import Docker from "dockerode";
import { OperatorFunction } from "rxjs";
import { mergeMap } from "rxjs/operators";

import { debugLog } from "./util";
import { AuthConfig, RepoAuthConfig } from "./config";
import { runCommand } from "./processes";

/**
 * This represents the section of the docker-compose.yml that friendship-blaster cares about
 */
export interface DockerComposeConfig {
  services: {
    [serviceProp: string]: {
      image: string;

      // This code does not care about the rest of the images but it's nice to
      // document they exist to remind users of this configuration to clone the
      // service properly when needed.
      [imageProp: string]: unknown;
    };
  };
}

/**
 * Represent a docker image together with its repo url and tag.
 */
export interface TaggedImage {
  repoUrl: string;
  image: string;
  tag: string;
}

/**
 * A readonly array of tagged docker images.
 */
export type TaggedImages = readonly TaggedImage[];

/**
 * Ensure the passed argument represents a `TaggedImages` type and narrow its
 * type.
 */
export function assertTaggedImageList(
  thing: unknown,
): asserts thing is TaggedImages {
  if (!Array.isArray(thing)) {
    throw new Error("Version file should contain a list");
  }

  (thing as TaggedImages).forEach((dockerImage) => {
    if (typeof dockerImage.image !== "string") {
      throw new Error("Version entry did not contain string image property");
    }
    if (typeof dockerImage.tag !== "string") {
      throw new Error("Version entry did not contain string tag property");
    }
    if (typeof dockerImage.repoUrl !== "string") {
      throw new Error("Version entry did not contain string repoUrl property");
    }
  });
}

/**
 * Login to all the docker repositories specified in authConfig
 */
export async function loginToContainerRepositories(
  authConfig: AuthConfig,
): Promise<void> {
  await Promise.all(
    Array.from(authConfig.keys()).map(async (repoUrl) => {
      const repoAuth: RepoAuthConfig = authConfig.get(repoUrl)!;
      debugLog("Logging in to container registry", repoUrl);
      await runCommand([
        "docker",
        "login",
        repoUrl,
        "-u",
        repoAuth.username,
        "-p",
        repoAuth.password,
      ]);
      debugLog("Logged in to container registry", repoUrl);
    }),
  );
}

/**
 * Ensure the passed argument represents a `DockerComposeConfig` type and
 * narrow its type.
 */
export function assertDockerComposeConfig(
  thing: unknown,
): asserts thing is DockerComposeConfig {
  if (typeof thing !== "object") {
    throw new Error("Invalid docker-compose.yml");
  }

  const services = (thing as DockerComposeConfig)?.services;
  if (!services) {
    throw new Error("Invalid docker-compose.yml: did not contain services");
  }

  return Object.values(services).forEach((service) => {
    if (typeof service !== "object") {
      throw new Error("Invalid service found in docker-compose.yml");
    }

    const imageStr = (service as { image?: string }).image;
    if (!imageStr) {
      throw new Error("Invalid service image found in docker-compose.yml");
    }
  });
}

/**
 * Wait for dockerode to finishing doing something.
 * The dockerode typings are terrible so we need to use `unknown`.
 */
export const waitForDocker = (docker: Docker, stream: unknown): Promise<void> =>
  new Promise((resolve) => docker.modem.followProgress(stream, resolve));

/**
 * Returns a type of Record<string, unknown> because dockerode typings are
 * broken and also not extendable.
 */
const getAuthOptions = (
  repoUrl: string,
  auth?: AuthConfig,
): Record<string, unknown> => {
  const repoAuth = auth?.get(repoUrl);
  if (!repoAuth) {
    return {};
  }

  return {
    authconfig: { username: repoAuth.username, password: repoAuth.password },
  };
};

/**
 * Compares `prevImages` to `newPollableImages` and pulls those which have
 * changed.
 */
export async function pullChangedImages(
  auth: AuthConfig | undefined,
  prevImages: TaggedImages,
  newPollableImages: TaggedImages,
): Promise<void> {
  const changedImages = newPollableImages.filter(({ repoUrl, image, tag }) => {
    const matchingPrev = prevImages.find(
      (prev) => prev.repoUrl == repoUrl && prev.image === image,
    );
    return matchingPrev!.tag !== tag;
  });

  const docker = new Docker();

  debugLog("Pull changed images: %O", changedImages);
  await Promise.all(
    changedImages.map(async (image) => {
      // see https://github.com/Microsoft/TypeScript/issues/14080 for why it is
      // impossible to augment the type of Docker :(
      const pullStream = await docker.pull(
        `${image.repoUrl}/${image.image}:${image.tag}`,
        getAuthOptions(image.repoUrl, auth),
      );
      await waitForDocker(docker, pullStream);
    }),
  );

  debugLog("Pulled changed images");
}

/**
 * This operator restarts unhealthy containers and ensures that `docker-compose restart`
 * isn't called for a container while a previous instance of `docker-compose restart` is
 * running for the same container.
 */
export const restartVeryUnhealthyContainers = (
  shutdownTimeout: number,
): OperatorFunction<string, void> => {
  const pendingRestarts: Set<string> = new Set();

  return mergeMap(
    async (containerLabel: string): Promise<void> => {
      if (pendingRestarts.has(containerLabel)) {
        return;
      }

      pendingRestarts.add(containerLabel);
      try {
        console.warn("Restarting unhealthy container: %s", containerLabel);
        await runCommand([
          "docker-compose",
          "restart",
          "-t",
          shutdownTimeout.toString(),
          containerLabel,
        ]);
        console.warn("Restarted unhealthy container: %s", containerLabel);
      } finally {
        pendingRestarts.delete(containerLabel);
      }
    },
  );
};
