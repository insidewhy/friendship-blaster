import yargs from "yargs";
import { once } from "lodash";
import path from "path";
import { readFile } from "fs";
import { promisify } from "util";

const pReadFile = promisify(readFile);

export type ImageSet = Readonly<Set<string>>;

export interface AuthConfig {
  username: string;
  password: string;
}

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
}

const getAuthConfig = async (
  credentialsFilePath?: string,
): Promise<AuthConfig | undefined> => {
  if (!credentialsFilePath) {
    return undefined;
  }

  const credentialsLine = await pReadFile(credentialsFilePath);
  const [username, password] = credentialsLine
    .toString()
    .trim()
    .split(":");
  if (!username || !password) {
    throw new Error("Credential file must have the format `username:password'");
  }
  return { username, password };
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
        "path to an file specifying the colon separated container registry credentials",
      alias: "c",
      type: "string",
    })
    .option("images", {
      describe: "comma separated list of images to watch for updates",
      type: "string",
      alias: "i",
      required: true,
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
      describe: "how often to poll container repositories for updates",
      alias: "I",
      type: "number",
      default: 60,
    })
    .option("insecure", {
      describe: "Allow insecure HTTPS certificates for container registry",
      alias: "k",
      type: "boolean",
    })
    .alias("h", "help")
    .help();

  const rawConfig = argBuilder.strict().argv;

  // in most cases the wrapper in "bin" will set this, use process.cwd() as a
  // backup just in case it is executed directly
  const { directory = process.cwd() } = rawConfig;
  const { credentials } = rawConfig;
  if (credentials && !isSubDirectory(directory, credentials)) {
    throw new Error(`${credentials} must be within the directory ${directory}`);
  }

  return Object.freeze({
    images: Object.freeze(new Set(rawConfig.images.split(/\s*,\s*/))),

    // how long to wait for containers to stop in seconds
    shutdownTimeout: rawConfig["shutdown-timeout"] || 10,

    directory,

    pollInterval: rawConfig["poll-interval"],

    debounce: rawConfig.debounce,

    allowInsecureHttps: !!rawConfig.insecure,

    auth: await getAuthConfig(credentials),
  });
};

/**
 * Read the software version from `package.json`.
 */
export const getVersion = once((): string => {
  return require(path.join(__dirname, "..", "package.json")).version;
});
