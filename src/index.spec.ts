import delay from "delay";
import { unlink } from "fs";
import { promisify } from "util";
import {
  startTestContainerRegistry,
  stopTestContainerRegistry,
  buildAndPushTestImage,
  chdirToTestConfig,
  emptyDirectory,
  pollFileForLines,
  spawnTestFriendshipBlaster,
  removeTestImage,
} from "./testUtils";
import { Process, runCommand } from "./processes";
import { FBLASTER_VERSION_FILE } from ".";

const pUnlink = promisify(unlink);

describe("friendship-blaster", () => {
  jest.setTimeout(60000);

  let fblasterProcess: Process | undefined = undefined;

  const shutdownFblaster = async (): Promise<void> => {
    if (fblasterProcess) {
      await fblasterProcess.shutdown();
      fblasterProcess = undefined;
    }
  };

  beforeEach(() => startTestContainerRegistry());
  afterEach(() =>
    Promise.all([stopTestContainerRegistry(), shutdownFblaster()]),
  );

  // In this configuration, running each container causes it to echo a line to
  // a mounted directory and then sleep forever. The line differs for each new
  // version that is pushed, this way the number of restarts and the version
  // of each restart can be precisely determined.
  describe("with simple configuration", () => {
    const ECHO_SERVER = "echo-server";
    const TYPE1 = "type1";
    const TYPE2 = "type2";
    const INITIAL_VERSION_TYPE1 = "10.0.0";
    const INITIAL_VERSION_TYPE2 = "8.0.0";
    const UPDATED_VERSION_TYPE1 = "10.0.1";
    const UPDATED_VERSION_TYPE2 = "8.0.1";

    const spawnFriendshipBlasterWithSimpleConfig = (): void => {
      fblasterProcess = spawnTestFriendshipBlaster(
        "echo-server-type1,echo-server-type2",
      );
    };

    const waitForInitialState = async (): Promise<void> => {
      // poll for outputs created by container
      const [lines1, lines2] = await Promise.all([
        pollFileForLines("mnt/type1", 1),
        pollFileForLines("mnt/type2", 1),
      ]);
      expect(lines1).toEqual([INITIAL_VERSION_TYPE1]);
      expect(lines2).toEqual([INITIAL_VERSION_TYPE2]);
    };

    beforeEach(async () => {
      await chdirToTestConfig("simple");
      await Promise.all([
        pUnlink(FBLASTER_VERSION_FILE).catch(() => {}),
        buildAndPushTestImage(ECHO_SERVER, TYPE1, INITIAL_VERSION_TYPE1),
        buildAndPushTestImage(ECHO_SERVER, TYPE2, INITIAL_VERSION_TYPE2),
        emptyDirectory("mnt"),
      ]);
      spawnFriendshipBlasterWithSimpleConfig();
    });

    afterEach(async () => {
      // delete docker containers created by friendship-blaster process
      await runCommand(["docker-compose", "down"]);
      // then remove the docker images created by the test
      await Promise.all([
        removeTestImage(ECHO_SERVER, TYPE1, INITIAL_VERSION_TYPE1),
        removeTestImage(ECHO_SERVER, TYPE2, INITIAL_VERSION_TYPE2),
        removeTestImage(ECHO_SERVER, TYPE1, UPDATED_VERSION_TYPE1),
        removeTestImage(ECHO_SERVER, TYPE2, UPDATED_VERSION_TYPE2),
      ]);
    });

    it("is able to run simple docker-compose.yml configuration", async () => {
      await waitForInitialState();
      await shutdownFblaster();
    });

    it("is able to poll for updates and restart configuration when a single update is found", async () => {
      await waitForInitialState();

      await buildAndPushTestImage(ECHO_SERVER, TYPE1, UPDATED_VERSION_TYPE1);
      // remove the local copy of the image, otherwise fblaster won't be able
      // to pull it... if its interval triggers before this happens then this
      // would mess up the test, but the poll interval of 3s should ensure it
      // that this won't happen
      await removeTestImage(ECHO_SERVER, TYPE1, UPDATED_VERSION_TYPE1);

      const [lines1, lines2] = await Promise.all([
        pollFileForLines("mnt/type1", 2),
        pollFileForLines("mnt/type2", 2),
      ]);
      expect(lines1).toEqual([INITIAL_VERSION_TYPE1, UPDATED_VERSION_TYPE1]);
      expect(lines2).toEqual([INITIAL_VERSION_TYPE2, INITIAL_VERSION_TYPE2]);

      await shutdownFblaster();
    });

    it("skips incompatible versions", async () => {
      await waitForInitialState();

      const stupidlyHighVersion = "400.0.0";
      await buildAndPushTestImage(ECHO_SERVER, TYPE1, stupidlyHighVersion);
      // give the debounce + interval a chance to ignore the update
      await delay(20000);

      await buildAndPushTestImage(ECHO_SERVER, TYPE1, UPDATED_VERSION_TYPE1);
      // remove the local copy of the image, otherwise fblaster won't be able
      // to pull it... if its interval triggers before this happens then this
      // would mess up the test, but the poll interval of 3s should ensure it
      // that this won't happen
      await removeTestImage(ECHO_SERVER, TYPE1, UPDATED_VERSION_TYPE1);

      const [lines1, lines2] = await Promise.all([
        pollFileForLines("mnt/type1", 2),
        pollFileForLines("mnt/type2", 2),
      ]);
      expect(lines1).toEqual([INITIAL_VERSION_TYPE1, UPDATED_VERSION_TYPE1]);
      expect(lines2).toEqual([INITIAL_VERSION_TYPE2, INITIAL_VERSION_TYPE2]);

      await shutdownFblaster();
      await removeTestImage(ECHO_SERVER, TYPE1, stupidlyHighVersion);
    });

    it("debounces multiple changes to avoid unnecessary restarts", async () => {
      await waitForInitialState();

      await Promise.all([
        buildAndPushTestImage(ECHO_SERVER, TYPE1, UPDATED_VERSION_TYPE1),
        buildAndPushTestImage(ECHO_SERVER, TYPE2, UPDATED_VERSION_TYPE2),
      ]);
      await Promise.all([
        await removeTestImage(ECHO_SERVER, TYPE1, UPDATED_VERSION_TYPE1),
        await removeTestImage(ECHO_SERVER, TYPE2, UPDATED_VERSION_TYPE2),
      ]);

      const [lines1, lines2] = await Promise.all([
        pollFileForLines("mnt/type1", 2),
        pollFileForLines("mnt/type2", 2),
      ]);
      expect(lines1).toEqual([INITIAL_VERSION_TYPE1, UPDATED_VERSION_TYPE1]);
      expect(lines2).toEqual([INITIAL_VERSION_TYPE2, UPDATED_VERSION_TYPE2]);

      await shutdownFblaster();
    });

    it("responds to multiple changes outside of debounce period", async () => {
      await waitForInitialState();

      await buildAndPushTestImage(ECHO_SERVER, TYPE1, UPDATED_VERSION_TYPE1);
      await removeTestImage(ECHO_SERVER, TYPE1, UPDATED_VERSION_TYPE1);

      const [firstLines1, firstLines2] = await Promise.all([
        pollFileForLines("mnt/type1", 2),
        pollFileForLines("mnt/type2", 2),
      ]);
      expect(firstLines1).toEqual([
        INITIAL_VERSION_TYPE1,
        UPDATED_VERSION_TYPE1,
      ]);
      expect(firstLines2).toEqual([
        INITIAL_VERSION_TYPE2,
        INITIAL_VERSION_TYPE2,
      ]);

      await buildAndPushTestImage(ECHO_SERVER, TYPE2, UPDATED_VERSION_TYPE2);
      await removeTestImage(ECHO_SERVER, TYPE2, UPDATED_VERSION_TYPE2);
      const [lines1, lines2] = await Promise.all([
        pollFileForLines("mnt/type1", 3),
        pollFileForLines("mnt/type2", 3),
      ]);
      expect(lines1).toEqual([
        INITIAL_VERSION_TYPE1,
        UPDATED_VERSION_TYPE1,
        UPDATED_VERSION_TYPE1,
      ]);
      expect(lines2).toEqual([
        INITIAL_VERSION_TYPE2,
        INITIAL_VERSION_TYPE2,
        UPDATED_VERSION_TYPE2,
      ]);

      await shutdownFblaster();
    });

    it("picks up latest image versions when restarted", async () => {
      await waitForInitialState();

      await Promise.all([
        buildAndPushTestImage(ECHO_SERVER, TYPE1, UPDATED_VERSION_TYPE1),
        buildAndPushTestImage(ECHO_SERVER, TYPE2, UPDATED_VERSION_TYPE2),
      ]);
      await Promise.all([
        await removeTestImage(ECHO_SERVER, TYPE1, UPDATED_VERSION_TYPE1),
        await removeTestImage(ECHO_SERVER, TYPE2, UPDATED_VERSION_TYPE2),
      ]);

      const [preRestartLines1, preRestartLines2] = await Promise.all([
        pollFileForLines("mnt/type1", 2),
        pollFileForLines("mnt/type2", 2),
      ]);
      expect(preRestartLines1).toEqual([
        INITIAL_VERSION_TYPE1,
        UPDATED_VERSION_TYPE1,
      ]);
      expect(preRestartLines2).toEqual([
        INITIAL_VERSION_TYPE2,
        UPDATED_VERSION_TYPE2,
      ]);

      await shutdownFblaster();

      // restart it and make sure still on latest versions
      spawnFriendshipBlasterWithSimpleConfig();
      const [lines1, lines2] = await Promise.all([
        pollFileForLines("mnt/type1", 3),
        pollFileForLines("mnt/type2", 3),
      ]);
      expect(lines1).toEqual([
        INITIAL_VERSION_TYPE1,
        UPDATED_VERSION_TYPE1,
        UPDATED_VERSION_TYPE1,
      ]);
      expect(lines2).toEqual([
        INITIAL_VERSION_TYPE2,
        UPDATED_VERSION_TYPE2,
        UPDATED_VERSION_TYPE2,
      ]);

      await shutdownFblaster();
    });
  });
});
