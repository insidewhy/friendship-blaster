import path from "path";
import rimraf from "rimraf";
import util from "util";
import delay from "delay";
import { mkdir, exists, readFile, unlink } from "fs";
import Docker from "dockerode";

import { runCommand, spawnProcess, Process } from "./processes";
import { FBLASTER_COMPOSE_FILE } from ".";

const pRimraf = util.promisify(rimraf);
const pMkdir = util.promisify(mkdir);
const pExists = util.promisify(exists);
const pReadFile = util.promisify(readFile);
const pUnlink = util.promisify(unlink);

const TEST_CONTAINER_REPO_PORT = "5000";
const TEST_CONTAINER_REPO = `localhost:${TEST_CONTAINER_REPO_PORT}`;
const TEST_CONTAINER_REPO_USER = "testuser";
const TEST_CONTAINER_REPO_PASSWORD = "testpassword";

const REGISTRY_CONTAINER_NAME = "friendship-blaster-test-registry";
const FRIENDSHIP_BLASTER_BIN = path.join(
  __dirname,
  "..",
  "bin",
  "friendship-blaster",
);

// Give registry container 10 seconds to start
const REGISTRY_CONTAINER_WAIT_DURATION = 10000;

const TEST_DOCKER_COMPOSE_CONFIG = path.join(
  __dirname,
  "..",
  "test",
  "docker-compose.yml",
);
// extend the previous config file to require authentication
const TEST_DOCKER_COMPOSE_WITH_AUTH_CONFIG = path.join(
  __dirname,
  "..",
  "test",
  "docker-compose-with-auth.yml",
);

const createDocker = (): Docker =>
  new Docker({ socketPath: "/var/run/docker.sock" });

// only one docker registry process may be running on the system at any one
// time so cache the instance when it is running in a global variable.
let testDockerComposeProc: Process | undefined = undefined;

// start test container registry and wait for it to be ready
export const startTestContainerRegistry = async (
  withAuth: boolean,
): Promise<void> => {
  // ensure previous registry is deleted
  await runCommand([
    "docker-compose",
    "-f",
    TEST_DOCKER_COMPOSE_CONFIG,
    ...(withAuth ? ["-f", TEST_DOCKER_COMPOSE_WITH_AUTH_CONFIG] : []),
    "down",
  ]);

  testDockerComposeProc = spawnProcess([
    "docker-compose",
    "-f",
    TEST_DOCKER_COMPOSE_CONFIG,
    "up",
    "-t",
    "2",
  ]);

  const docker = createDocker();
  const started = Date.now();
  // dockerode includes a slash prefix on every name
  const compareName = `/${REGISTRY_CONTAINER_NAME}`;
  do {
    const containers = await docker.listContainers();
    const [registryContainer] = containers.filter(container =>
      container.Names.some(name => name === compareName),
    );
    if (registryContainer && /^Up/.test(registryContainer.Status)) {
      return;
    }
    await delay(200);
  } while (Date.now() < started + REGISTRY_CONTAINER_WAIT_DURATION);

  // timeout exceeded
  throw new Error("Registry container did not start in time");
};

export const loginToTestContainerRegistry = async (): Promise<void> =>
  runCommand([
    "docker",
    "login",
    TEST_CONTAINER_REPO,
    "-u",
    TEST_CONTAINER_REPO_USER,
    "-p",
    TEST_CONTAINER_REPO_PASSWORD,
  ]);

// stop the docker container registry used by the tests if it is running.
export const stopTestContainerRegistry = async (): Promise<void> => {
  if (testDockerComposeProc) {
    const proc = testDockerComposeProc;
    testDockerComposeProc = undefined;
    await proc.shutdown();
  }
};

// turn the components of a docker image name into the full name.
const buildImageName = (
  baseName: string,
  variant: string,
  tag: string,
): string => `${TEST_CONTAINER_REPO}/${baseName}-${variant}:${tag}`;

// cannot test image pulls when they are left cached in the local docker
// container instance (outside of the container registry) by previous tests so
// use this function to remove them from said cache.
export const buildAndPushTestImage = async (
  baseName: string,
  variant: string,
  tag: string,
): Promise<void> => {
  const imageName = buildImageName(baseName, variant, tag);
  const directory = path.join(__dirname, "..", "test", "containers", baseName);

  // TODO: Tried to use dockerode for these and failed, maybe have another go,
  //       at least they are just for tests.
  await runCommand([
    "docker",
    "build",
    "-t",
    imageName,
    "--build-arg",
    `IMAGE_TAG=${tag}`,
    "--build-arg",
    `VARIANT=${variant}`,
    directory,
  ]);
  await runCommand(["docker", "push", imageName]);
};

// remove the specified docker image using dockerode.
export const removeTestImage = async (
  baseName: string,
  variant: string,
  tag: string,
): Promise<void> => {
  const imageName = buildImageName(baseName, variant, tag);
  const docker = createDocker();
  try {
    // this one doesn't return a waitable stream, it removes immediately
    await docker.getImage(imageName).remove();
  } catch (e) {
    // ignore "no image" error, it may not exist if the test failed etc.
  }
};

// change directory to that containing test config and remove the fblaster-docker-compose.yml
export const chdirToTestConfig = async (configName: string): Promise<void> => {
  process.chdir(path.join(__dirname, "..", "test", "configs", configName));
  try {
    await pUnlink(FBLASTER_COMPOSE_FILE);
  } catch (e) {}
};

// ensure the directory at `dirPath` exists and is empty.
export const emptyDirectory = async (dirPath: string): Promise<void> => {
  await pRimraf(dirPath);
  await pMkdir(dirPath);
};

// keep polling the file at `filePath` until it contains at least `lineCount` lines.
export const pollFileForLines = async (
  filePath: string,
  lineCount: number,
): Promise<string[]> => {
  while (!(await pExists(filePath))) {
    await delay(100);
  }

  for (;;) {
    const lines = (await pReadFile(filePath))
      .toString()
      .trim()
      .split("\n");
    if (lines.length >= lineCount) {
      return lines;
    }
    await delay(100);
  }
};

// spawn friendship-blaster inside of a docker container.
export const spawnTestFriendshipBlaster = (
  imageArg: string,
  withAuth: boolean,
): Process =>
  spawnProcess(
    [
      FRIENDSHIP_BLASTER_BIN,
      "--host-net",
      "--images",
      imageArg,
      "--shutdown-timeout",
      "2",
      "--poll-interval",
      "5",
      "--debounce",
      "5",
      ...(withAuth ? ["--credentials", "credentials.txt"] : []),
      // to allow the self-signed HTTPS certificate used for the tests
      "--insecure",
    ],
    {
      // showStdout: true,
      showStderr: true,
    },
  );
