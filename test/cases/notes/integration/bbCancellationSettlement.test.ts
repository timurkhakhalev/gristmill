const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const fs: typeof import("node:fs") = require("node:fs");

const os: typeof import("node:os") = require("node:os");

const path: typeof import("node:path") = require("node:path");

const childProcess: typeof import("node:child_process") = require("node:child_process");

const {
  createMeetingAudioOperationRegistry,
}: typeof import("../../../../src/helpers/meetingAudioExport.ts") = require("../../../../src/helpers/meetingAudioExport.ts");

for (const failure of ["abort", "oversized", "stdin"] as const) {
  test(
    `BB ${failure} cancellation waits for actual child close before ownership settles`,
    { timeout: 10_000 },
    async (t) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-bb-settlement-"));
      const binary = path.join(directory, "bb-fake.cjs");
      const marker = (name: string) => path.join(directory, name);
      const watchers = new Set<import("node:fs").FSWatcher>();

      const waitForFile = (name: string) =>
        new Promise<void>((resolve) => {
          const watcher = fs.watch(directory, check);
          watchers.add(watcher);

          function check() {
            if (!fs.existsSync(marker(name))) return;
            watcher.close();
            watchers.delete(watcher);
            resolve();
          }

          check();
        });

      const previousBinary = process.env.BB_CLI;
      const originalSpawn = childProcess.spawn;
      let child: import("node:child_process").ChildProcess | undefined;
      let closed: Promise<void> | undefined;
      childProcess.spawn = ((...args: Parameters<typeof originalSpawn>) => {
        const created = originalSpawn(...args);
        child = created;
        closed = new Promise<void>((resolve) => {
          created.once("close", () => resolve());
        });

        return created;
      }) as typeof originalSpawn;
      process.env.BB_CLI = binary;
      t.after(async () => {
        childProcess.spawn = originalSpawn;
        child?.kill("SIGKILL");
        await closed;

        for (const watcher of watchers) watcher.close();

        if (previousBinary === undefined) delete process.env.BB_CLI;
        else process.env.BB_CLI = previousBinary;
        fs.rmSync(directory, { recursive: true, force: true });
      });
      fs.writeFileSync(
        binary,
        `
const fs = require("node:fs");
const path = require("node:path");
const directory = ${JSON.stringify(directory)};
const marker = name => path.join(directory, name);
process.on("SIGTERM", () => fs.writeFileSync(marker("aborted"), ""));
fs.watch(directory, () => {
  if (fs.existsSync(marker("release"))) process.exit(0);
});
if (${JSON.stringify(failure)} === "stdin") fs.closeSync(0);
fs.writeFileSync(marker("ready"), "");
if (${JSON.stringify(failure)} === "oversized") process.stdout.write("x".repeat(8_100_000));
`
      );

      const {
        tellBbThread,
      }: typeof import("../../../../src/helpers/bbCli.ts") = require("../../../../src/helpers/bbCli.ts");

      const registry = createMeetingAudioOperationRegistry();
      let operationSettled = false;

      const operation = registry.run("owned", (signal) =>
        tellBbThread("synthetic", failure === "stdin" ? "x".repeat(16_000_000) : "prompt", signal)
      );

      void operation.then(
        () => {
          operationSettled = true;
        },
        () => {
          operationSettled = true;
        }
      );

      const rejected = assert.rejects(operation, (error: unknown) => {
        assert.ok(error instanceof Error);

        if (failure === "abort") assert.equal(error.name, "AbortError");
        else
          assert.equal(
            (error as { code?: string }).code,
            failure === "oversized" ? "bb-response-too-large" : "bb-stdin-error"
          );

        return true;
      });

      await waitForFile("ready");
      let barrierSettled = false;
      let barrier: Promise<void>;

      if (failure === "abort") {
        barrier = registry.stop().then(() => {
          barrierSettled = true;
        });
        await waitForFile("aborted");
      } else {
        await waitForFile("aborted");
        barrier = registry.stop().then(() => {
          barrierSettled = true;
        });
      }

      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(child?.exitCode, null, "the child holds SIGTERM until the test releases it");
      assert.equal(operationSettled, false);
      assert.equal(barrierSettled, false);
      fs.writeFileSync(marker("release"), "");
      await rejected;
      await barrier;
      await closed;
      assert.equal(child?.exitCode, 0);
    }
  );
}
