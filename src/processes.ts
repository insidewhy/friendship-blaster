import { ChildProcess, spawn, SpawnOptions } from "child_process";

/**
 * A promise-friendly wrapper around "child_process".
 */
export class Process {
  private shutdownPromise: Promise<void>;

  // This should only be called by `spawnProcess`.
  constructor(
    private proc: ChildProcess,
    commandAndArgs: string[],
    showStderr?: boolean,
  ) {
    this.shutdownPromise = new Promise<void>((resolve, reject) => {
      let stderr = "";
      proc.stderr!.on("data", (stderrLine: Buffer) => {
        if (showStderr) {
          console.warn(stderrLine.toString().trimRight());
        }
        stderr += stderrLine;
      });

      proc.on("close", (exitCode: number) => {
        if (!exitCode) {
          resolve();
        } else {
          const prefix = `Error running "${commandAndArgs.join(" ")}": `;
          reject(new Error(prefix + (stderr || "Unknown error")));
        }
      });
    });
  }

  /**
   * Send the process SIGTERM then call and return the value of `wait`.
   */
  shutdown(): Promise<void> {
    this.proc.kill("SIGTERM");
    return this.wait();
  }

  /**
   * Wait for the process to exit. If it exits with a non-zero error code then
   * the rejected promise will contain all of the data the process wrote to
   * stderr.
   */
  wait(): Promise<void> {
    return this.shutdownPromise;
  }
}

interface ProcessOptions {
  // Forward the stdout of the process to the stdout of the current process.
  showStdout?: boolean;
  // Forward the stderr of the process to the stderr of the current process.
  showStderr?: boolean;
}

/**
 * Spawn a process and return a Process object that can be used to manipulate
 * it.
 */
export const spawnProcess = (
  commandAndArgs: string[],
  options: ProcessOptions = {},
): Process => {
  const spawnOptions: SpawnOptions = {};
  spawnOptions.stdio = [
    "pipe",
    options.showStdout ? "inherit" : "ignore",
    "pipe",
  ];
  const proc = spawn(commandAndArgs[0], commandAndArgs.slice(1), spawnOptions);
  return new Process(proc, commandAndArgs, options.showStderr);
};

/**
 * A simpler version of spawnProcess which returns a promise that can be used to
 * wait for it to exit directly.
 */
export const runCommand = (
  commandAndArgs: string[],
  options: ProcessOptions = {},
): Promise<void> => spawnProcess(commandAndArgs, options).wait();

/**
 * Like child_process.exec but without the overhead of a subshell and
 * only returns the stdout.
 */
export const execCommand = (commandAndArgs: string[]): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    const proc = spawn(commandAndArgs[0], commandAndArgs.slice(1), {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    proc.stdout!.on("data", (stdoutLine: Buffer) => {
      stdout += stdoutLine;
    });

    let stderr = "";
    proc.stderr!.on("data", (stderrLine: Buffer) => {
      stderr += stderrLine;
    });

    proc.on("close", (exitCode: number) => {
      if (!exitCode) {
        resolve(stdout);
      } else {
        const prefix = `Error running "${commandAndArgs.join(" ")}": `;
        reject(new Error(prefix + (stderr || "Unknown error")));
      }
    });
  });
