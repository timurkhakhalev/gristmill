const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "../..");
const configPath = path.join(root, "tsconfig.main.json");

// Compiles a probe source under the strict main settings and returns all
// program diagnostics. Negative probes expect specific codes; positive
// probes expect none.
function probeDiagnostics(source) {
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  assert.equal(parsed.options.strict, true);
  const probe = path.join(root, "calendar-availability-type-probe.ts");
  const host = ts.createCompilerHost(parsed.options);
  const readSource = host.getSourceFile.bind(host);
  host.getSourceFile = (file, languageVersion, ...args) =>
    file === probe
      ? ts.createSourceFile(file, source, languageVersion, true)
      : readSource(file, languageVersion, ...args);
  const program = ts.createProgram([probe], { ...parsed.options, noEmit: true }, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  return {
    codes: diagnostics.map((d) => d.code).sort((a, b) => a - b),
    cleanup: () => {
      if (fs.existsSync(probe)) fs.rmSync(probe, { force: true });
    },
  };
}

const IPC_MAIN = `declare const ipcMain: { handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void };`;

test("an incomplete dependency set fails compilation", () => {
  const { codes, cleanup } = probeDiagnostics(`
import { registerCalendarAvailabilityHandler } from "./src/helpers/calendarAvailabilityIpcHandler.js";

${IPC_MAIN}

// A handler without calendarProviders would never see a connected calendar;
// the compiler must reject the registration.
registerCalendarAvailabilityHandler(ipcMain, {
  databaseManager: { getCalendarEventsInRange: () => [] },
  logWarn: () => {},
});
`);
  try {
    assert.deepEqual(codes, [2345]);
  } finally {
    cleanup();
  }
});

test("a wrong bridge-level response usage fails compilation", () => {
  const { codes, cleanup } = probeDiagnostics(`
import { createCalendarAvailabilityBridge } from "./src/preload/calendarAvailabilityBridge.js";

declare const ipcRendererLike: {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
};
const bridge = createCalendarAvailabilityBridge(ipcRendererLike);

async function misuse(): Promise<number> {
  const response = await bridge.calendarGetAvailability({
    start: "2026-08-25T07:00:00.000Z",
    end: "2026-08-25T12:00:00.000Z",
  });
  // Availability only exists on the success arm of the union.
  return response.availability.availableSlots.length;
}
void misuse;
`);
  try {
    assert.deepEqual(codes, [2339]);
  } finally {
    cleanup();
  }
});

test("the full registration, service and bridge compile under strict settings", () => {
  const { codes, cleanup } = probeDiagnostics(`
import { registerCalendarAvailabilityHandler } from "./src/helpers/calendarAvailabilityIpcHandler.js";
import { createCalendarAvailabilityBridge } from "./src/preload/calendarAvailabilityBridge.js";
import { validateCalendarAvailabilityRequest, computeCalendarAvailability } from "./src/helpers/calendarAvailability.js";
import type { AvailabilityResult } from "./src/contracts/calendarAvailability.js";

${IPC_MAIN}

registerCalendarAvailabilityHandler(ipcMain, {
  databaseManager: { getCalendarEventsInRange: () => [] },
  calendarProviders: [
    { provider: "google", manager: { isConnected: () => true } },
    { provider: "apple", manager: { isConnected: () => true } },
  ],
  clock: () => new Date("2026-08-25T06:00:00.000Z"),
  logWarn: () => {},
});

declare const ipcRendererLike: {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
};
const bridge = createCalendarAvailabilityBridge(ipcRendererLike);
async function useResponse(): Promise<string[]> {
  const response = await bridge.calendarGetAvailability({
    start: "2026-08-25T07:00:00.000Z",
    end: "2026-08-25T12:00:00.000Z",
  });
  if (!response.success) return [response.error];
  return response.availability.availableSlots.map((slot) => slot.start);
}
void useResponse;

const normalized = validateCalendarAvailabilityRequest({
  start: "2026-08-25T07:00:00.000Z",
  end: "2026-08-25T12:00:00.000Z",
}, new Date("2026-08-25T06:00:00.000Z"));
const computed = computeCalendarAvailability([], normalized);
const slots: number = computed.availableSlots.length;
void slots;

const result: AvailabilityResult | null = null;
void result;
`);
  try {
    assert.deepEqual(codes, []);
  } finally {
    cleanup();
  }
});
