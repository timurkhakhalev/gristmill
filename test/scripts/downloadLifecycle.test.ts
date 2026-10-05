const { stripTypeScriptTypes }: typeof import("node:module") = require("node:module");

const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const fs: typeof import("node:fs") = require("node:fs");

const path: typeof import("node:path") = require("node:path");

const vm: typeof import("node:vm") = require("node:vm");

const { EventEmitter } = require("node:events") as typeof import("node:events");

const { PassThrough } = require("node:stream") as typeof import("node:stream");

test("binary downloads drain redirects and disable the old request timeout", async () => {
  const requests: Array<InstanceType<typeof EventEmitter> & { timeouts: number[] }> = [];
  const responses: InstanceType<typeof PassThrough>[] = [];
  const file = Object.assign(new PassThrough(), { close() {} });
  file.resume();
  const module: { exports: unknown } = { exports: {} };
  vm.runInNewContext(
    stripTypeScriptTypes(
      fs.readFileSync(path.join(__dirname, "../../scripts/lib/download-utils.cts"), "utf8")
    ),
    {
      module,
      URL,
      console: { log() {} },
      process: { stdout: { write() {} } },
      require(name: string) {
        if (name === "fs") return { createWriteStream: () => file };

        if (name === "https")
          return {
            get(url: string, callback: (response: InstanceType<typeof PassThrough>) => void) {
              const request = Object.assign(new EventEmitter(), {
                timeouts: [] as number[],
                setTimeout(timeout: number) {
                  this.timeouts.push(timeout);
                },
                destroy() {},
              });

              requests.push(request);

              const response = Object.assign(new PassThrough(), {
                statusCode: requests.length === 1 ? 302 : 200,
                headers: { location: "/binary", "content-length": "4" },
              });

              responses.push(response);
              queueMicrotask(() => {
                callback(response);
                response.end("data");
              });

              return request;
            },
          };

        return require(name);
      },
    }
  );

  const { downloadFile } = module.exports as {
    downloadFile: (url: string, file: string) => Promise<void>;
  };

  await downloadFile("https://example.com/redirect", "/unused");
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].timeouts, [30000, 0]);
  assert.equal(responses[0].readableEnded, true);
});
