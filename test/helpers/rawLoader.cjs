// Test-only loader: Node and tsx do not understand Vite's `?raw` suffix, and the
// worklet cannot execute outside an AudioWorkletGlobalScope.
// `module.register` cannot be used here: registering any loader makes tsx take
// its ESM path, which bypasses the suite's electron Module._load stub.
const Module = require("node:module");
const fs = require("node:fs");
const path = require("node:path");

const RAW_JS = /\.js\?raw=?$/;
// SAFETY: same loader seam as harness/electronStub.ts; tsx compiles `?raw`
// imports to CJS require, so this intercepts before the file executes.
const moduleLoad = Module._load;

Module._load = function (request, parent, isMain) {
  if (RAW_JS.test(request)) {
    const file = path.resolve(path.dirname(parent.filename), request.replace(/\?raw=?$/, ""));
    return { __esModule: true, default: fs.readFileSync(file, "utf8") };
  }

  return moduleLoad.call(this, request, parent, isMain);
};
