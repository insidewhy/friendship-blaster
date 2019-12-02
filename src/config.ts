import yargs from "yargs";
import { once } from "lodash";
import path from "path";

export type ImageSet = Readonly<Set<string>>;

/**
 * Represents the friendship-blaster configuration as specified via commandline
 * arguments.
 */
export interface Config {
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

/**
 * Parse the commandline arguments into the Config structure.
 */
export const getConfigFromArgv = (): Config => {
  const argBuilder = yargs
    // .option("credentials", {
    //   describe: "path to an htpasswd format file specifying the container registry credentials",
    //   alias: "c",
    //   type: "string",
    //   required: true,
    // })
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

  return Object.freeze({
    images: Object.freeze(new Set(rawConfig.images.split(/\s*,\s*/))),

    // how long to wait for containers to stop in seconds
    shutdownTimeout: rawConfig["shutdown-timeout"] || 10,

    // in most cases the wrapper in "bin" will set this, use process.cwd() as a
    // backup just in case it is executed directly
    directory: rawConfig.directory || process.cwd(),

    pollInterval: rawConfig["poll-interval"],

    debounce: rawConfig.debounce,

    allowInsecureHttps: !!rawConfig.insecure,
  });
};

/**
 * Read the software version from `package.json`.
 */
export const getVersion = once((): string => {
  return require(path.join(__dirname, "..", "package.json")).version;
});
