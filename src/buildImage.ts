import path from "path";
import { runCommand } from "./processes";
import { getVersion } from "./config";

/**
 * Build the container used to run friendship-blaster using the docker command.
 * This function is used by the build system only.
 */
async function buildContainer(): Promise<void> {
  const containerPath = path.join(__dirname, "..");
  const version = getVersion();
  await runCommand(
    [
      "docker",
      "build",
      "-t",
      `xlos/friendship-blaster:${version}`,
      containerPath,
    ],
    {
      showStdout: true,
    },
  );
}

export default buildContainer;

if (require.main === module) {
  buildContainer();
}
