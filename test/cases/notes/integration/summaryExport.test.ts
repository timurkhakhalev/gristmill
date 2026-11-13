// The Summary download writes the shown Markdown to the file that the user
// selects, and the call title names the proposed file. This drives the real
// export-summary IPC handler and stubs only the Electron save dialog.
const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const fs: typeof import("node:fs") = require("node:fs");

const os: typeof import("node:os") = require("node:os");

const path: typeof import("node:path") = require("node:path");

const Module = require("node:module");

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-summary-export-"));

const dialogCalls: Array<{ defaultPath?: string }> = [];

let dialogResult: { canceled: boolean; filePath?: string } = { canceled: true };

const originalLoad = Module._load;

Module._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
  if (request === "electron") {
    return {
      app: {
        getPath: () => directory,
        getAppPath: () => process.cwd(),
        isReady: () => false,
      },
      dialog: {
        showSaveDialog: async (options: { defaultPath?: string }) => {
          dialogCalls.push(options);

          return dialogResult;
        },
      },
    };
  }

  return originalLoad.call(this, request, parent, isMain);
};

test.after(() => {
  Module._load = originalLoad;
  fs.rmSync(directory, { recursive: true, force: true });
});

process.env.NODE_ENV = "test";

const {
  registerTranscriptionDataHandlers,
  summaryFileName,
}: typeof import("../../../../src/helpers/transcriptionDataIpcHandlers.ts") = require("../../../../src/helpers/transcriptionDataIpcHandlers.ts");

const notes = new Map([
  [7, { id: 7, title: "Q3 planning: Acme / Example Co" }],
  [8, { id: 8, title: "" }],
]);

function exportSummary() {
  const handlers = new Map();
  registerTranscriptionDataHandlers(
    { handle: (channel: string, fn: unknown) => handlers.set(channel, fn), on: () => {} },
    {
      database: { getNote: (id: number) => notes.get(id) ?? null },
      logger: { log: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
      retention: { onSettingsChanged: () => {} },
    } as never
  );

  return handlers.get("export-summary");
}

test("Summary download proposes the call title and writes the shown Markdown", async () => {
  const handler = exportSummary();
  const target = path.join(directory, "chosen.md");
  dialogResult = { canceled: false, filePath: target };
  dialogCalls.length = 0;

  const markdown = "## Decisions\n\n- Ship the beta on Friday\n";

  assert.deepEqual(await handler({}, 7, markdown), { success: true });
  assert.equal(dialogCalls[0]?.defaultPath, "Q3 planning- Acme - Example Co.md");
  assert.equal(fs.readFileSync(target, "utf8"), markdown);
});

test("Summary download writes nothing when canceled or the request is invalid", async () => {
  const handler = exportSummary();
  dialogResult = { canceled: true };
  dialogCalls.length = 0;

  assert.deepEqual(await handler({}, 8, "Summary"), { success: false });
  assert.equal(dialogCalls[0]?.defaultPath, "Untitled.md");

  dialogCalls.length = 0;
  assert.equal((await handler({}, 7, "   ")).success, false);
  assert.equal((await handler({}, 99, "Summary")).error, "Note not found");
  assert.equal(dialogCalls.length, 0, "an invalid request must not open the save dialog");
});

test("Summary file names drop path, reserved and control characters", () => {
  assert.equal(summaryFileName("../../etc/passwd"), "-..-etc-passwd");
  assert.equal(summaryFileName("Sync\n\twith  team"), "Sync with team");
  assert.equal(summaryFileName("..."), "Untitled");
  assert.equal(summaryFileName(null), "Untitled");
});
