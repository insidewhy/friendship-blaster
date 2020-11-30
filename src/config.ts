import yargs from "yargs";
import { once } from "lodash";
import path from "path";
import { readFile } from "fs";
import { promisify } from "util";

import { debugLog } from "./util";

const pReadFile = promisify(readFile);

export type ImageSet = Readonly<Set<string>>;

export interface RepoAuthConfig {
  username: string;
  password: string;
}

export type AuthConfig = Map<string, RepoAuthConfig>;

/**
 * Represents the friendship-blaster configuration as specified via commandline
 * arguments.
 */
export interface Config {
  /// Container registry authorisation parameters.
  auth?: AuthConfig;
  /// Images to watch for changes.
  images: ImageSet;
  /// How long to give docker-compose to exit.
  shutdownTimeout: number;
  /// Directory containing docker-compose.yml
  directory: string;
  /// How often to poll container repository, in seconds.
  pollInterval: number;
  /// Debounce detected updates for this number of seconds before restarting docker-compose
  debounce: number;
  /// Allow self-signed SSL certificates for container registry
  allowInsecureHttps: boolean;
  /// How often to check health of docker processes in seconds
  healthCheckInterval: number;
  /// How long to tolerate a server being unhealthy for
  illHealthTolerance: number;
  /// Set to tell friendship-blaster to signal an existing instance rather than run
  signalPoll: boolean;
}

const getAuthConfig = async (
  credentialArgs?: string[],
): Promise<AuthConfig | undefined> => {
  if (!credentialArgs) {
    return undefined;
  }

  const authConfig: AuthConfig = new Map();

  await Promise.all(
    credentialArgs.map(async (credentials) => {
      const lastColon = credentials.lastIndexOf(":");
      if (lastColon === -1) {
        throw new Error(
          `Credentials ${lastColon} should be in format repository-url:file-path`,
        );
      }

      const repoUrl = credentials.substr(0, lastColon);
      const credentialsFilePath = credentials.substr(lastColon + 1);

      const credentialsLine = await pReadFile(credentialsFilePath);
      const [username, password] = credentialsLine.toString().trim().split(":");
      if (!username || !password) {
        throw new Error(
          "Credential file must have the format `username:password'",
        );
      }

      authConfig.set(repoUrl, { username, password });
    }),
  );

  debugLog("Read credentials %O", authConfig);
  return authConfig;
};

function isSubDirectory(referencePath: string, childPath: string): boolean {
  return !path.relative(referencePath, childPath).startsWith("../");
}

/**
 * Parse the commandline arguments into the Config structure.
 */
export const getConfigFromArgv = async (): Promise<Config> => {
  const argBuilder = yargs
    .option("credentials", {
      describe:
        "repo url followed by colon followed by path to an file specifying the colon separated container registry credentials",
      alias: "c",
      type: "array",
      string: true,
    })
    .option("images", {
      describe: "comma separated list of images to watch for updates",
      type: "string",
      alias: "i",
    })
    .option("shutdown-timeout", {
      describe: "how long to wait in seconds for docker container to shut down",
      alias: "s",
      type: "number",
    })
    .option("directory", {
      describe: "directory containing docker-compose.yml",
      alias: "d",
      type: "string",
    })
    .option("debounce", {
      describe:
        "number of seconds to debounce detected tags before restarting docker-compose",
      alias: "D",
      type: "number",
      default: 60,
    })
    .option("poll-interval", {
      describe:
        "how often to poll container repositories for updates in seconds",
      alias: "I",
      type: "number",
      default: 60,
    })
    .option("health-check-interval", {
      describe: "how often to check for health of docker containers in seconds",
      alias: "H",
      type: "number",
      default: 60,
    })
    .option("ill-health-tolerance", {
      describe:
        "how many seconds a container is allowed to be unhealthy before it is terminated",
      alias: "t",
      type: "number",
      default: 60,
    })
    .option("insecure", {
      describe: "Allow insecure HTTPS certificates for container registry",
      alias: "k",
      type: "boolean",
    })
    .option("signal-poll", {
      describe:
        "Send signal to existing friendship-blaster to force an update poll",
      alias: "S",
      type: "boolean",
    })
    .alias("h", "help")
    .help();

  const rawConfig = argBuilder.strict().argv;

  // in most cases the wrapper in "bin" will set this, use process.cwd() as a
  // backup just in case it is executed directly
  const { directory = process.cwd() } = rawConfig;
  const { credentials } = rawConfig;
  if (credentials) {
    credentials.forEach((oneCredential) => {
      if (!isSubDirectory(directory, oneCredential)) {
        throw new Error(
          `${oneCredential} must be within the directory ${directory}`,
        );
      }
    });
  }

  return Object.freeze({
    images: Object.freeze(new Set((rawConfig.images || "").split(/\s*,\s*/))),

    // how long to wait for containers to stop in seconds
    shutdownTimeout: rawConfig["shutdown-timeout"] || 10,

    directory,

    pollInterval: rawConfig["poll-interval"],

    debounce: rawConfig.debounce,

    allowInsecureHttps: !!rawConfig.insecure,

    healthCheckInterval: rawConfig["health-check-interval"],

    illHealthTolerance: rawConfig["ill-health-tolerance"],

    auth: await getAuthConfig(credentials),

    signalPoll: !!rawConfig["signal-poll"],
  });
};

/**
 * Read the software version from `package.json`.
 */
export const getVersion = once((): string => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(path.join(__dirname, "..", "package.json")).version;
});
