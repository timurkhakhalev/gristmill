const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

test("binary downloads drain redirects and disable the old request timeout", async () => {
  const requests = [];
  const responses = [];
  const file = new PassThrough();
  file.close = () => {};
  file.resume();
  const module = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "../../scripts/lib/download-utils.js"), "utf8"),
    {
      module,
      URL,
      console: { log() {} },
      process: { stdout: { write() {} } },
      require(name) {
        if (name === "fs") return { createWriteStream: () => file };
        if (name === "https")
          return {
            get(url, callback) {
              const request = new EventEmitter();
              request.timeouts = [];
              request.setTimeout = (timeout) => request.timeouts.push(timeout);
              request.destroy = () => {};
              requests.push(request);
              const response = new PassThrough();
              responses.push(response);
              response.statusCode = requests.length === 1 ? 302 : 200;
              response.headers = { location: "/binary", "content-length": "4" };
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
  await module.exports.downloadFile("https://example.com/redirect", "/unused");
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].timeouts, [30000, 0]);
  assert.equal(responses[0].readableEnded, true);
});
