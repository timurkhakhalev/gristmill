const test: typeof import("node:test") = require("node:test");

const { afterEach }: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const Module = require("node:module");

const { EventEmitter } = require("node:events");

const childProcess: typeof import("node:child_process") = require("node:child_process");

const openerModulePath = require.resolve("../../src/helpers/externalUrlOpener");

const originalLoad = Module._load;

const originalPlatform = process.platform;

const originalSystemRoot = process.env.SystemRoot;

function setPlatform(platform: string) {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

function setSystemRoot(value: string | undefined) {
  if (value === undefined) delete process.env.SystemRoot;
  else process.env.SystemRoot = value;
}

function makeChild() {
  const child = new EventEmitter();
  child.unrefCalls = 0;
  child.unref = () => {
    child.unrefCalls += 1;
  };

  return child;
}

// Returns the helper plus the spawn and shell.openExternal calls it made.
// spawnOutcome picks which child-process event the mock spawn fires.
function loadOpener({ spawnOutcome = "spawn" } = {}) {
  delete require.cache[openerModulePath];

  const spawnCalls: unknown[] = [];
  const openExternalCalls: unknown[] = [];

  const spawn = (command: string, args: unknown, options: unknown) => {
    const child = makeChild();
    spawnCalls.push({ command, args, options, child });
    process.nextTick(() => {
      if (spawnOutcome === "error") {
        child.emit("error", new Error("spawn failed"));
      } else {
        child.emit("spawn");
      }
    });

    return child;
  };

  Module._load = function loadWithMocks(request: string, parent: unknown, isMain: boolean) {
    if (request === "electron") {
      return {
        shell: {
          openExternal: (url: string) => {
            openExternalCalls.push(url);

            return Promise.resolve();
          },
        },
      };
    }

    if (request === "child_process") {
      return { ...childProcess, spawn };
    }

    return originalLoad(request, parent, isMain);
  };

  try {
    const { openExternalUrl }: typeof import("../../src/helpers/externalUrlOpener.ts") = require(
      openerModulePath
    );

    return { openExternalUrl, spawnCalls, openExternalCalls };
  } finally {
    Module._load = originalLoad;
  }
}

afterEach(() => {
  Module._load = originalLoad;
  setPlatform(originalPlatform);
  setSystemRoot(originalSystemRoot);
});

test("invalid URLs reject without launching anything", async () => {
  const { openExternalUrl, spawnCalls, openExternalCalls } = loadOpener();
  setPlatform("win32");

  await assert.rejects(openExternalUrl("not a url"), TypeError);

  assert.equal(spawnCalls.length, 0);
  assert.equal(openExternalCalls.length, 0);
});
