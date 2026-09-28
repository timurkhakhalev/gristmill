const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const {
  DEFAULT_RETENTION_SETTINGS,
  applyRetentionSettings,
  createRetentionSettingsHandler,
} = require("../../src/helpers/retentionSettings");

test("reports a change when a retention period is shortened", () => {
  assert.deepEqual(
    applyRetentionSettings(DEFAULT_RETENTION_SETTINGS, {
      audioRetentionDays: 1,
      transcriptRetentionDays: 1,
    }),
    {
      changed: true,
      settings: {
        audioRetentionDays: 1,
        transcriptRetentionDays: 1,
        dataRetentionEnabled: true,
        localHistoryPolicyResolved: false,
      },
    }
  );
});

test("is idempotent when both values are unchanged — dual-window mount sync", () => {
  const { changed } = applyRetentionSettings(DEFAULT_RETENTION_SETTINGS, {
    audioRetentionDays: DEFAULT_RETENTION_SETTINGS.audioRetentionDays,
    transcriptRetentionDays: DEFAULT_RETENTION_SETTINGS.transcriptRetentionDays,
  });
  assert.equal(changed, false);
});

test("default is seven days while persisted 30-day and unlimited settings remain explicit", () => {
  assert.equal(DEFAULT_RETENTION_SETTINGS.audioRetentionDays, 7);
  const saved = applyRetentionSettings(DEFAULT_RETENTION_SETTINGS, {
    audioRetentionDays: 30,
    transcriptRetentionDays: 0,
  });
  assert.equal(saved.settings.audioRetentionDays, 30);
  assert.equal(saved.settings.transcriptRetentionDays, 0);
  assert.equal(saved.changed, true);
  const unlimited = applyRetentionSettings(saved.settings, {
    audioRetentionDays: 0,
    transcriptRetentionDays: 0,
  });
  assert.equal(unlimited.settings.audioRetentionDays, 0);
  assert.equal(unlimited.changed, true);
});

test("keeps the current value when an incoming value is missing or unusable", () => {
  const current = {
    audioRetentionDays: 7,
    transcriptRetentionDays: 1,
    dataRetentionEnabled: true,
    localHistoryPolicyResolved: false,
  };
  for (const incoming of [
    undefined,
    {},
    { audioRetentionDays: "abc", transcriptRetentionDays: -5 },
  ]) {
    assert.deepEqual(applyRetentionSettings(current, incoming), {
      changed: false,
      settings: current,
    });
  }
});

test("only the main renderer can replace process-global retention settings", () => {
  const mainRenderer = {};
  const auxiliaryRenderers = [{}, {}, {}];
  const managedSettings = {
    audioRetentionDays: 7,
    transcriptRetentionDays: 30,
    dataRetentionEnabled: true,
    localHistoryPolicyResolved: false,
  };
  let current = { ...DEFAULT_RETENTION_SETTINGS };
  let cleanupRuns = 0;
  let synced = false;
  const handleRetentionSettingsChanged = createRetentionSettingsHandler({
    getCurrentSettings: () => current,
    getOwner: () => mainRenderer,
    hasSynced: () => synced,
    onSettingsChanged: (settings: unknown) => {
      current = settings;
      synced = true;
      cleanupRuns += 1;
    },
  });

  handleRetentionSettingsChanged({ sender: mainRenderer }, managedSettings);
  assert.deepEqual(current, managedSettings);
  assert.equal(cleanupRuns, 1);

  for (const auxiliaryRenderer of auxiliaryRenderers) {
    handleRetentionSettingsChanged(
      { sender: auxiliaryRenderer },
      { audioRetentionDays: 90, transcriptRetentionDays: 0 }
    );
    assert.deepEqual(current, managedSettings);
    assert.equal(cleanupRuns, 1);
  }

  handleRetentionSettingsChanged(
    { sender: mainRenderer },
    { audioRetentionDays: 90, transcriptRetentionDays: 0 }
  );
  assert.deepEqual(current, {
    audioRetentionDays: 90,
    transcriptRetentionDays: 0,
    dataRetentionEnabled: true,
    localHistoryPolicyResolved: false,
  });
  assert.equal(cleanupRuns, 2);
});

test("no sweep runs before the renderer has synced the persisted settings", () => {
  const IPCHandlers: typeof import("../../src/helpers/ipcHandlers").IPCHandlers = require("../../src/helpers/ipcHandlers");
  const sweeps: unknown[] = [];
  const context = {
    _retentionCleanupInterval: null as ReturnType<typeof setInterval> | null,
    _retentionSettingsSynced: false,
    _retentionSettings: { ...DEFAULT_RETENTION_SETTINGS },
    _runRetentionCleanup() {
      sweeps.push({ ...this._retentionSettings });
    },
  };

  IPCHandlers.prototype._setupRetentionCleanup.call(context);
  const interval = () => context._retentionCleanupInterval;
  const activeInterval = interval();
  if (activeInterval) clearInterval(activeInterval);

  // The 30-day default would have deleted audio a "Disabled" user asked to keep.
  assert.deepEqual(sweeps, []);
});

test("the first sync sweeps even when the user's settings match the defaults", () => {
  let current = { ...DEFAULT_RETENTION_SETTINGS };
  let synced = false;
  let cleanupRuns = 0;
  const owner = {};
  const handle = createRetentionSettingsHandler({
    getCurrentSettings: () => current,
    getOwner: () => owner,
    hasSynced: () => synced,
    onSettingsChanged: (settings: unknown) => {
      current = settings;
      synced = true;
      cleanupRuns += 1;
    },
  });

  handle({ sender: owner }, { ...DEFAULT_RETENTION_SETTINGS });
  assert.equal(cleanupRuns, 1);

  // A second window mounting must not sweep again.
  handle({ sender: owner }, { ...DEFAULT_RETENTION_SETTINGS });
  assert.equal(cleanupRuns, 1);
});

test("a disabled retention setting reaches the sweep before it can delete", () => {
  let current = { ...DEFAULT_RETENTION_SETTINGS };
  let synced = false;
  const sweptWith: unknown[] = [];
  const owner = {};
  const handle = createRetentionSettingsHandler({
    getCurrentSettings: () => current,
    getOwner: () => owner,
    hasSynced: () => synced,
    onSettingsChanged: (settings: any) => {
      current = settings;
      synced = true;
      sweptWith.push({ ...settings });
    },
  });

  handle({ sender: owner }, { audioRetentionDays: 0, transcriptRetentionDays: 0 });
  assert.deepEqual(sweptWith, [
    {
      audioRetentionDays: 0,
      transcriptRetentionDays: 0,
      dataRetentionEnabled: true,
      localHistoryPolicyResolved: false,
    },
  ]);
});

test("carries the effective local-history switch, and reports it changing", () => {
  const current = { ...DEFAULT_RETENTION_SETTINGS, dataRetentionEnabled: true };

  const off = applyRetentionSettings(current, {
    audioRetentionDays: current.audioRetentionDays,
    transcriptRetentionDays: current.transcriptRetentionDays,
    dataRetentionEnabled: false,
  });
  assert.equal(off.settings.dataRetentionEnabled, false);
  assert.equal(off.changed, true, "turning local history off is a change worth acting on");

  // A renderer that predates this field must not be read as "history off".
  const legacy = applyRetentionSettings(current, {
    audioRetentionDays: current.audioRetentionDays,
    transcriptRetentionDays: current.transcriptRetentionDays,
  });
  assert.equal(legacy.settings.dataRetentionEnabled, true);
  assert.equal(legacy.changed, false);
});

test("carries whether the local-history policy has resolved, and reports it changing", () => {
  assert.equal(
    DEFAULT_RETENTION_SETTINGS.localHistoryPolicyResolved,
    false,
    "an unreported policy must never read as a resolved one"
  );

  const arrival = applyRetentionSettings(DEFAULT_RETENTION_SETTINGS, {
    audioRetentionDays: 30,
    transcriptRetentionDays: 0,
    dataRetentionEnabled: true,
    localHistoryPolicyResolved: true,
  });
  assert.equal(
    arrival.changed,
    true,
    "the policy settling is the change that unblocks reconstruction"
  );
  assert.equal(arrival.settings.localHistoryPolicyResolved, true);
});
