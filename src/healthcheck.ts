import Docker, { ContainerInspectInfo } from "dockerode";
import delay from "delay";
import { Observable, interval, merge } from "rxjs";
import { filter, map, mergeMap } from "rxjs/operators";

import { DockerComposeConfig } from "./docker";
import {
  isDefined,
  promiseFactoryToObservable,
  switchScan,
  PromiseFactory,
  logErrorAndRetry,
} from "./util";
import { execCommand } from "./processes";

// The number of milliseconds in a second
const MILISECS_IN_A_SECOND = 1000;

// Check the container ID every second, it is not available until the container
// is fully started
const CONTAINER_ID_CHECK_INTERVAL = 1000;
const MONITOR_HEALTH_RECOVERY_INTERVAL = 10000;

interface ContainerStatus {
  label: string;
  // Can't check for the containerId up-front as it might be a container from a
  // previous run, so it is lazily read when needed, remaining `undefined`
  // until first needed.
  containerId?: string;
  lastHealthyTime: Date;
}

// The dockerode typings lack the `Health` property.
type ContainerHealthInfo = ContainerInspectInfo["State"] & {
  Health?: { Status: string };
};

/**
 * Gets the container id from the docker compose label. Runs this check in a loop
 * in case the container does not yet exist.
 */
async function getContainerIdFromDockerComposeLabel(
  label: string,
): Promise<string> {
  while (true) {
    try {
      // check for container ID in a loop until it becomes available
      const containerId = (
        await execCommand(["docker-compose", "ps", "-q", label])
      ).trimRight();
      if (containerId.length) {
        return containerId;
      }
    } catch (e) {
      console.warn("Found error while checking for container ID: %O", e);
    }
    await delay(CONTAINER_ID_CHECK_INTERVAL);
  }
}

const checkContainerDockerHealth = (
  containerStatus: ContainerStatus,
): PromiseFactory<ContainerStatus> => async (): Promise<ContainerStatus> => {
  const docker = new Docker();

  const containerId =
    containerStatus.containerId ||
    (await getContainerIdFromDockerComposeLabel(containerStatus.label));

  try {
    const inspection = await docker.getContainer(containerId).inspect();
    const health = (inspection.State as ContainerHealthInfo).Health;
    if (!health || health.Status !== "unhealthy") {
      // the Health property is not defined when the container has no
      // health-check, for this and all states other than "unhealthy" (e.g.
      // starting/healthy) assume the container is healthy
      return {
        ...containerStatus,
        containerId,
        lastHealthyTime: new Date(),
      };
    } else {
      // preserve the current last known healthy time
      return { ...containerStatus, containerId };
    }
  } catch (e) {
    if (e.reason === "no such container") {
      console.warn(
        "Found stale container while performing healthcheck: %s",
        containerId,
      );
      // Had the wrong container ID, this can happen (rarely) when a
      // container that was being upgraded and its ID was cached by the
      // healthcheck before the replacement container with the same label
      // was started. In this case reset the containerId for the next run.
      return {
        label: containerStatus.label,
        containerId: undefined,
        lastHealthyTime: new Date(),
      };
    } else {
      throw e;
    }
  }
};

/**
 * Monitor the containers and emit labels of containers that have exceeded
 * `illHealthTolerance`.
 */
export function getVeryUnhealthyDockerContainers(
  healthPollFrequency: number,
  illHealthTolerance: number,
  dockerComposeConfig: DockerComposeConfig,
): Observable<string> {
  const initialContainerStatuses = Object.keys(
    dockerComposeConfig.services,
  ).map((label: string) => ({
    label,
    containerId: undefined,
    lastHealthyTime: new Date(),
  }));

  return merge(initialContainerStatuses).pipe(
    mergeMap(initialContainerStatus => {
      return interval(healthPollFrequency * MILISECS_IN_A_SECOND).pipe(
        switchScan((containerStatus: ContainerStatus) => {
          return promiseFactoryToObservable(
            checkContainerDockerHealth(containerStatus),
          ).pipe(
            logErrorAndRetry(
              "Error monitoring docker container health, retrying: %O",
              MONITOR_HEALTH_RECOVERY_INTERVAL,
            ),
          );
        }, initialContainerStatus),

        map((containerStatus: ContainerStatus): string | undefined => {
          const now = Date.now();
          if (
            (now - containerStatus.lastHealthyTime.getTime()) /
              MILISECS_IN_A_SECOND >
            illHealthTolerance
          ) {
            return containerStatus.label;
          } else {
            return undefined;
          }
        }),
        filter(isDefined),
      );
    }),
  );
}
