import delay from "delay";
import { unlink } from "fs";
import { promisify } from "util";
import { fill } from "lodash";

import {
  startTestContainerRegistry,
  stopTestContainerRegistry,
  buildAndPushTestImage,
  chdirToTestConfig,
  emptyDirectory,
  pollFileForLines,
  spawnTestFriendshipBlaster,
  removeTestImage,
  loginToTestContainerRegistry,
  spawnFriendshipBlasterSignaller,
  getMatchingDescendentProc,
  getMatchingProc,
} from "./testUtils";
import { Process, runCommand } from "./processes";
import { FBLASTER_VERSION_FILE } from ".";

const pUnlink = promisify(unlink);

describe("friendship-blaster", () => {
  jest.setTimeout(70000);

  let fblasterProcess: Process | undefined = undefined;

  const shutdownFblaster = async (): Promise<void> => {
    if (fblasterProcess) {
      const procCopy = fblasterProcess;
      fblasterProcess = undefined;
      await procCopy.shutdown();
    }
  };

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

    const spawnFriendshipBlasterWithSimpleConfig = (
      withAuth: boolean,
      pollInterval = 5,
    ): void => {
      fblasterProcess = spawnTestFriendshipBlaster(
        "echo-server-type1,echo-server-type2",
        { withAuth, pollInterval },
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

    const prepareTestConfigurationDirectory = async (): Promise<void> => {
      await chdirToTestConfig("simple");
      await Promise.all([
        pUnlink(FBLASTER_VERSION_FILE).catch(() => {}),
        buildAndPushTestImage(ECHO_SERVER, TYPE1, INITIAL_VERSION_TYPE1),
        buildAndPushTestImage(ECHO_SERVER, TYPE2, INITIAL_VERSION_TYPE2),
        emptyDirectory("mnt"),
      ]);
    };

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

    describe("and no authentication", () => {
      beforeEach(async () => {
        await startTestContainerRegistry(false);
        await prepareTestConfigurationDirectory();
        spawnFriendshipBlasterWithSimpleConfig(false);
      });

      it("is able to run simple docker-compose.yml configuration", async () => {
        await waitForInitialState();
      });
    });

    describe("and authentication", () => {
      beforeEach(async () => {
        await startTestContainerRegistry(true);
        await loginToTestContainerRegistry();
        await prepareTestConfigurationDirectory();
        spawnFriendshipBlasterWithSimpleConfig(true);
      });

      it("is able to run simple docker-compose.yml configuration", async () => {
        await waitForInitialState();
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
          removeTestImage(ECHO_SERVER, TYPE1, UPDATED_VERSION_TYPE1),
          removeTestImage(ECHO_SERVER, TYPE2, UPDATED_VERSION_TYPE2),
        ]);

        const [lines1, lines2] = await Promise.all([
          pollFileForLines("mnt/type1", 2),
          pollFileForLines("mnt/type2", 2),
        ]);
        expect(lines1).toEqual([INITIAL_VERSION_TYPE1, UPDATED_VERSION_TYPE1]);
        expect(lines2).toEqual([INITIAL_VERSION_TYPE2, UPDATED_VERSION_TYPE2]);
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
      });

      it("picks up latest image versions when restarted", async () => {
        await waitForInitialState();

        await Promise.all([
          buildAndPushTestImage(ECHO_SERVER, TYPE1, UPDATED_VERSION_TYPE1),
          buildAndPushTestImage(ECHO_SERVER, TYPE2, UPDATED_VERSION_TYPE2),
        ]);
        await Promise.all([
          removeTestImage(ECHO_SERVER, TYPE1, UPDATED_VERSION_TYPE1),
          removeTestImage(ECHO_SERVER, TYPE2, UPDATED_VERSION_TYPE2),
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
        spawnFriendshipBlasterWithSimpleConfig(true);
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
      });

      it("restarts docker-compose when it exits unexpectedly", async () => {
        await waitForInitialState();

        // this pid will not be a descendent of fblasterProcess as it will be
        // executed via docker (except when `yarn test-dev` is used)
        const pid = await getMatchingProc(
          args =>
            args.length > 1 &&
            /f(?:riendship-)?blaster\/(?:.*\/)?dist\/index.js$/.test(args[1]),
        );
        expect(pid).not.toEqual(0);

        // grab the docker-compose that fblaster spawned and kill it
        const dockerComposePid = await getMatchingDescendentProc(
          pid,
          args => args.length > 1 && /docker-compose$/.test(args[1]),
        );
        expect(dockerComposePid).not.toEqual(0);

        try {
          process.kill(dockerComposePid);
        } catch (e) {
          // when not running via test-dev, root permissions are needed to kill
          // the docker-compose process running inside of the container
          await runCommand(["sudo", "kill", dockerComposePid.toString()]);
        }

        // ensure that docker-compose was restarted by fblaster
        const [lines1, lines2] = await Promise.all([
          pollFileForLines("mnt/type1", 2),
          pollFileForLines("mnt/type2", 2),
        ]);
        expect(lines1).toEqual([INITIAL_VERSION_TYPE1, INITIAL_VERSION_TYPE1]);
        expect(lines2).toEqual([INITIAL_VERSION_TYPE2, INITIAL_VERSION_TYPE2]);
      });
    });

    describe("responds to SIGUSR2 signal", () => {
      beforeEach(async () => {
        await startTestContainerRegistry(false);
        await prepareTestConfigurationDirectory();
        // really large poll interval the test can be sure all polls came from the signal
        spawnFriendshipBlasterWithSimpleConfig(false, 999999);
      });

      it("by polling for updates", async () => {
        if (process.env.LOCAL_COMPOSE) {
          console.warn("SIGUSR2 tests do not work when LOCAL_COMPOSE is set");
          return;
        }

        await waitForInitialState();
        await buildAndPushTestImage(ECHO_SERVER, TYPE1, UPDATED_VERSION_TYPE1);
        await removeTestImage(ECHO_SERVER, TYPE1, UPDATED_VERSION_TYPE1);
        await delay(2000);
        await spawnFriendshipBlasterSignaller();

        const [lines1, lines2] = await Promise.all([
          pollFileForLines("mnt/type1", 2),
          pollFileForLines("mnt/type2", 2),
        ]);
        expect(lines1).toEqual([INITIAL_VERSION_TYPE1, UPDATED_VERSION_TYPE1]);
        expect(lines2).toEqual([INITIAL_VERSION_TYPE2, INITIAL_VERSION_TYPE2]);
      }, 150000);
    });
  });

  describe("with healthcheck configuration", () => {
    const HEALTH_SERVER = "unhealthy-server";
    const VARIANT1 = "2";
    const VARIANT2 = "3";
    const INITIAL_VERSION_VARIANT1 = "1.0.0";
    const INITIAL_VERSION_VARIANT2 = "1.0.0";
    const UPDATED_VERSION_VARIANT1 = "1.0.1";

    const waitForInitialState = async (): Promise<void> => {
      // poll for outputs created by container
      const [lines1, lines2] = await Promise.all([
        pollFileForLines(`mnt/${VARIANT1}`, 1),
        pollFileForLines(`mnt/${VARIANT2}`, 1),
      ]);
      expect(lines1).toEqual([INITIAL_VERSION_VARIANT1]);
      expect(lines2).toEqual([INITIAL_VERSION_VARIANT2]);
    };

    const prepareTestConfigurationDirectory = async (): Promise<void> => {
      await chdirToTestConfig("health");
      await Promise.all([
        pUnlink(FBLASTER_VERSION_FILE).catch(() => {}),
        buildAndPushTestImage(
          HEALTH_SERVER,
          VARIANT1,
          INITIAL_VERSION_VARIANT1,
        ),
        buildAndPushTestImage(
          HEALTH_SERVER,
          VARIANT2,
          INITIAL_VERSION_VARIANT2,
        ),
        emptyDirectory("mnt"),
      ]);
    };

    const spawnFriendshipBlasterWithHealthConfig = (): void => {
      fblasterProcess = spawnTestFriendshipBlaster(
        `unhealthy-server-${VARIANT1},unhealthy-server-${VARIANT2}`,
        { withAuth: false },
      );
    };

    beforeEach(async () => {
      await startTestContainerRegistry(false);
      await prepareTestConfigurationDirectory();
      spawnFriendshipBlasterWithHealthConfig();
    });

    afterEach(async () => {
      // must shutdown friendship blaster first, otherwise the "down" won't
      // work since friendship-blaster's exit process will ensure all
      // containers are stopped
      await shutdownFblaster();

      await Promise.all([
        runCommand(["docker-compose", "down"]),
        removeTestImage(HEALTH_SERVER, VARIANT1, INITIAL_VERSION_VARIANT1),
        removeTestImage(HEALTH_SERVER, VARIANT2, INITIAL_VERSION_VARIANT2),
        removeTestImage(HEALTH_SERVER, VARIANT1, UPDATED_VERSION_VARIANT1),
      ]);
    });

    const waitForServersToGetHealthy = async (): Promise<void> => {
      await waitForInitialState();
      const [lines1, lines2] = await Promise.all([
        pollFileForLines(`mnt/${VARIANT1}`, 2, true),
        pollFileForLines(`mnt/${VARIANT2}`, 3, true),
      ]);
      expect(lines1).toEqual(fill(new Array(2), INITIAL_VERSION_VARIANT1));
      expect(lines2).toEqual(fill(new Array(3), INITIAL_VERSION_VARIANT2));
    };

    it("restarts servers until they are healthy", async () => {
      await waitForServersToGetHealthy();
    });

    it("responds to image update after restarting unhealthy servers", async () => {
      await waitForServersToGetHealthy();

      await buildAndPushTestImage(
        HEALTH_SERVER,
        VARIANT1,
        UPDATED_VERSION_VARIANT1,
      );

      const [lines1] = await Promise.all([
        pollFileForLines(`mnt/${VARIANT1}`, 3, true),
        pollFileForLines(`mnt/${VARIANT2}`, 3, true),
      ]);
      expect(lines1).toEqual([
        INITIAL_VERSION_VARIANT1,
        INITIAL_VERSION_VARIANT1,
        UPDATED_VERSION_VARIANT1,
      ]);
    });

    it("restarts updated unhealthy servers", async () => {
      await waitForServersToGetHealthy();

      await buildAndPushTestImage(
        HEALTH_SERVER,
        VARIANT1,
        UPDATED_VERSION_VARIANT1,
      );

      await Promise.all([
        pollFileForLines(`mnt/${VARIANT1}`, 3, true),
        pollFileForLines(`mnt/${VARIANT2}`, 3, true),
      ]);

      // make server variant1 unhealthy again
      await pUnlink(`mnt/${VARIANT1}`);

      // then wait for server variant 1 to become healthy again
      const [lines1, lines2] = await Promise.all([
        // goes back up to 2
        pollFileForLines(`mnt/${VARIANT1}`, 2, true),
        // increments by one due to the restart of docker-compose
        pollFileForLines(`mnt/${VARIANT2}`, 4, true),
      ]);

      expect(lines1).toEqual(fill(new Array(2), UPDATED_VERSION_VARIANT1));
      expect(lines2).toEqual(fill(new Array(4), INITIAL_VERSION_VARIANT2));
    }, 130000);
  });
});
