const { spawn } = require("child_process");
const EventEmitter = require("events");
const debugLogger = require("./debugLogger");
const { resolveBundledBinary } = require("./binaryResolver");
const { getOwnProcessPids } = require("./ownProcessPids");


const SUSTAINED_EVENT_DRIVEN_MS = 2 * 1000;
const COOLDOWN_MS = 5 * 60 * 1000;
const INACTIVE_RESET_MS = 60 * 1000;
// PipeWire/PulseAudio emit 'change' subscribe events several times a second on
// cork/volume churn, and every reconcile forks a pactl subprocess.
// macOS has no polling fallback, so a lost listener is respawned instead.
const LISTENER_RESPAWN_BASE_MS = 5 * 1000;
const LISTENER_RESPAWN_MAX_MS = 60 * 1000;

class AudioActivityDetector extends EventEmitter {
  // `getExcludedProcessIds` lists every pid whose mic use is OpenHercules' own:
  // the Electron process tree by default, plus any live capture helpers when
  // main.js composes them in (see electronProcessIds.js). `isMeetingAppRunning`
  // corroborates macOS device activity that cannot be attributed to a process;
  // without it such activity never prompts.
  constructor(
    getExcludedProcessIds = () => [...getOwnProcessPids()],
    isMeetingAppRunning = () => false
  ) {
    super();
    this._getExcludedProcessIds = getExcludedProcessIds;
    this._isMeetingAppRunning = isMeetingAppRunning;
    this.audioActiveStart = null;
    this.hasPrompted = false;
    this.lastDismissedAt = null;
    this._userRecording = false;
    this._listenerProcess = null;
    this._activeMicPids = new Set();
    this._sustainedTimer = null;
    this._running = false;
    this._eventDriven = false;
    this._resetTimer = null;
    this._startGeneration = 0;
    this._micWarmHold = false;
    this._lastKnownMicState = false;
    this._lastKnownMicAttributed = true;
    this._cooldownReevalTimer = null;
    this._respawnTimer = null;
    this._respawnAttempts = 0;
    this._pidScopedCapability = false;
    this._externalMicReliable = false;
    this._externalMicActive = false;
    this._lastEmittedExternalMicReliable = false;
    this._lastEmittedExternalMicActive = false;
    this._externalCapturePids = new Set();
    this._promptedCapturePids = new Set();
    this._captureIdleSincePrompt = false;
  }

  _markPrompted() {
    this.hasPrompted = true;
    this._promptedCapturePids = new Set(this._externalCapturePids);
    this._captureIdleSincePrompt = false;
  }

  // A later call re-arms the prompt, but only after the capture that was
  // prompted for has actually gone quiet. A pid set that merely differs is not
  // evidence the call ended: an app rebuilds its input unit when screen share
  // starts, and a capture helper can die and respawn under a new pid inside a
  // single reconcile window, so the swap is observed with no idle gap at all.
  // Prompting again there would drop a card over a live call, which is exactly
  // what hasPrompted exists to prevent.
  _rearmPromptForSourceChange(active) {
    if (!active) this._captureIdleSincePrompt = true;
    if (!this.hasPrompted || !this._pidScopedCapability || !this._externalCapturePids.size) return;
    if (!this._promptedCapturePids.size) {
      this._promptedCapturePids = new Set(this._externalCapturePids);
      return;
    }
    if (!this._captureIdleSincePrompt) return;

    const previousSourceGone = [...this._promptedCapturePids].every(
      (pid) => !this._externalCapturePids.has(pid)
    );
    if (!previousSourceGone) return;

    this.hasPrompted = false;
    this._promptedCapturePids.clear();
    this._captureIdleSincePrompt = false;
    debugLogger.info("Re-armed meeting prompt for a changed capture source", {}, "meeting");
  }

  getExternalMicState() {
    this._updateExternalMicState(false);
    return {
      reliable: this._externalMicReliable,
      externalMicActive: this._externalMicActive,
    };
  }

  setUserRecording(active) {
    this._userRecording = active;
    if (active) {
      this.audioActiveStart = null;
      this._clearSustainedTimer();
    } else {
      this._reevaluateAfterGate();
    }
    debugLogger.debug("User recording state changed", { active }, "meeting");
  }

  // Our own idle-hold keeps the device "in use" after a dictation ends, and the
  // macOS/Linux mic signals are device-global — they cannot tell us apart from
  // a meeting app. Mic evidence during the hold is dropped outright (never
  // queued: it is not a meeting). Sustained state resets on both transitions so
  // a half-armed detection from before the hold cannot fire after it.
  setMicWarmHold(active) {
    this._micWarmHold = active;
    this.audioActiveStart = null;
    this._clearSustainedTimer();
    if (!active) {
      this._reevaluateAfterGate();
    }
    debugLogger.debug("Mic warm-hold state changed", { active }, "meeting");
  }

  // Unattributed device activity is gated on a running meeting app, so an app
  // launching after the device edge is one more gate lifting.
  notifyMeetingAppsChanged() {
    if (!this._lastKnownMicAttributed) this._reevaluateAfterGate();
  }

  async start() {
    if (this._running) return;
    this._running = true;
    this._respawnAttempts = 0;
    const generation = ++this._startGeneration;

    const started = await this._tryEventDriven(generation);
    if (this._isStale(generation)) return;

    if (started) {
      this._eventDriven = true;
      debugLogger.info(
        "Audio activity detector started (event-driven)",
        { platform: process.platform },
        "meeting"
      );
    } else {
      this._eventDriven = false;
      this._pauseAutomaticPrompts();
    }
  }

  stop() {
    if (!this._running) return;
    this._running = false;
    this._killListenerProcess();
    this._clearRespawnTimer();
    this._clearSustainedTimer();
    this._clearResetTimer();
    this._resetListenerState();
    this._reset();
    this._eventDriven = false;
    debugLogger.info("Audio activity detector stopped", {}, "meeting");
  }

  dismiss() {
    this.lastDismissedAt = Date.now();
    this._reset();
    this._clearSustainedTimer();
    this._clearResetTimer();
    // Polling parity: polling re-detects a still-running call once the cooldown
    // lapses, but the edge-triggered listeners will never re-announce it.
    if (this._eventDriven && this._lastKnownMicState) {
      this._scheduleCooldownReeval(COOLDOWN_MS);
    }
    debugLogger.info(
      "Audio detection dismissed, cooldown started",
      { cooldownMs: COOLDOWN_MS },
      "meeting"
    );
  }

  resetPrompt() {
    this.hasPrompted = false;
    this._promptedCapturePids.clear();
    this._captureIdleSincePrompt = false;
    this._clearSustainedTimer();
    this.audioActiveStart = null;
    debugLogger.info("Audio detection prompt reset (no cooldown)", {}, "meeting");
  }

  _reset() {
    this.audioActiveStart = null;
    this.hasPrompted = false;
    this._promptedCapturePids.clear();
    this._captureIdleSincePrompt = false;
    this._clearResetTimer();
  }

  // The pid set, source count, and ownership snapshot mirror what the OS told
  // us is open, not our own detection state — only losing the listener
  // invalidates them. Clearing them on dismissal would desync the reference
  // count, so an unrelated app's mic session ending would report the
  // still-running call as gone.
  _resetListenerState() {
    this._activeMicPids.clear();
    this._lastKnownMicState = false;
    this._externalCapturePids.clear();
    this._clearCooldownReevalTimer();
    this._pidScopedCapability = false;
    this._externalMicReliable = false;
    this._externalMicActive = false;
    this._lastEmittedExternalMicReliable = false;
    this._lastEmittedExternalMicActive = false;
  }

  _clearSustainedTimer() {
    if (this._sustainedTimer) {
      clearTimeout(this._sustainedTimer);
      this._sustainedTimer = null;
    }
  }

  _startResetTimer() {
    this._clearResetTimer();
    this._resetTimer = setTimeout(() => {
      this._resetTimer = null;
      this.hasPrompted = false;
      this._promptedCapturePids.clear();
      debugLogger.debug("hasPrompted reset after sustained inactivity", {}, "meeting");
    }, INACTIVE_RESET_MS);
  }

  _clearResetTimer() {
    if (this._resetTimer) {
      clearTimeout(this._resetTimer);
      this._resetTimer = null;
    }
  }

  _killListenerProcess() {
    if (this._listenerProcess) {
      try {
        this._listenerProcess.kill();
      } catch {
        // already exited
      }
      this._listenerProcess = null;
    }
  }

  // True once stop() or a newer start() has superseded the run that owns `generation`.
  _isStale(generation) {
    return !this._running || generation !== this._startGeneration;
  }

  // ---------------------------------------------------------------------------
  // Event-driven approach
  // ---------------------------------------------------------------------------

  async _tryEventDriven(generation) {
    return this._tryEventDrivenDarwin(generation);
  }

  // Spawns a listener and resolves only once the OS has confirmed it started, so a
  // failure to launch (missing binary, not executable) is reported as false instead
  // of being raced by the asynchronous "error" event.
  _spawnListener({ command, args = [], options, label, generation, onLine }) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(command, args, options);
      } catch (err) {
        debugLogger.warn(`Failed to spawn ${label}`, { error: err.message }, "meeting");
        resolve(false);
        return;
      }

      const onSpawn = () => {
        child.removeListener("error", onError);
        if (this._isStale(generation)) {
          child.kill();
          resolve(false);
          return;
        }

        this._listenerProcess = child;
        this._readLines(child.stdout, (line) => {
          // stdout can still drain after exit or after a replacement listener starts.
          if (this._listenerProcess !== child || this._isStale(generation)) return;
          onLine(line);
        });
        child.stderr.on("data", (data) => {
          debugLogger.debug(`${label} stderr`, { output: data.toString().trim() }, "meeting");
        });
        this._attachFallbackHandlers(child, label);
        resolve(true);
      };

      const onError = (err) => {
        child.removeListener("spawn", onSpawn);
        debugLogger.warn(`Failed to spawn ${label}`, { error: err.message }, "meeting");
        resolve(false);
      };

      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
  }

  _readLines(stream, onLine) {
    let buffer = "";
    stream.on("data", (data) => {
      buffer += data.toString();
      let newlineIdx;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        onLine(line);
      }
    });
  }

  _attachFallbackHandlers(child, label) {
    const fallbackToPolling = () => {
      if (this._listenerProcess !== child) return;
      this._listenerProcess = null;
      // Announce the reliability loss before the snapshot is reset, or the
      // emit de-dupe would swallow it.
      this._setPidScopedCapability(false);
      this._resetListenerState();
      if (this._running && this._eventDriven) {
        this._eventDriven = false;
        this._pauseAutomaticPrompts();
        this._scheduleListenerRespawn();
      }
    };

    child.on("error", (err) => {
      debugLogger.warn(`${label} error`, { error: err.message }, "meeting");
      fallbackToPolling();
    });

    child.on("exit", (code) => {
      debugLogger.warn(`${label} exited`, { code }, "meeting");
      fallbackToPolling();
    });
  }

  _tryEventDrivenDarwin(generation) {
    const binaryPath = resolveBundledBinary("macos-mic-listener", "meeting");
    if (!binaryPath) {
      debugLogger.warn("macos-mic-listener binary not found", {}, "meeting");
      return false;
    }

    return this._spawnListener({
      command: binaryPath,
      options: { stdio: ["ignore", "pipe", "pipe"] },
      label: "macos-mic-listener",
      generation,
      onLine: (line) => this._parseDarwinListenerLine(line),
    });
  }

  _parseDarwinListenerLine(line) {
    if (!this._running) return;

    if (line === "CAPABILITY PID" || line === "CAPABILITY AGGREGATE") {
      const pidScoped = line === "CAPABILITY PID";
      debugLogger.info(
        "macOS microphone detection capability",
        { capability: pidScoped ? "PID" : "AGGREGATE" },
        "meeting"
      );
      // The lines that follow re-announce every live capture, so state derived
      // from the previous mode is stale.
      this._activeMicPids.clear();
      this._setPidScopedCapability(pidScoped);
      this._onMicStateChanged(false, pidScoped);
      return;
    }

    // Device-wide activity includes playback on combined input/output devices,
    // so it is recorded as unattributed and only prompts once a running meeting
    // app corroborates it (see _evaluateMicState).
    if (line === "MIC_ACTIVE" || line === "MIC_INACTIVE") {
      this._onMicStateChanged(line === "MIC_ACTIVE", false);
      return;
    }

    if (!this._pidScopedCapability) return;
    this._parsePidScopedListenerLine(line);
  }

  _scheduleListenerRespawn() {
    this._clearRespawnTimer();
    const delayMs = Math.min(
      LISTENER_RESPAWN_BASE_MS * 2 ** this._respawnAttempts,
      LISTENER_RESPAWN_MAX_MS
    );
    this._respawnAttempts++;
    debugLogger.info("Retrying the macOS microphone listener", { delayMs }, "meeting");
    this._respawnTimer = setTimeout(() => {
      this._respawnTimer = null;
      void this._respawnListener();
    }, delayMs);
  }

  async _respawnListener() {
    if (!this._running || this._listenerProcess) return;
    const generation = this._startGeneration;
    const started = await this._tryEventDriven(generation);
    if (this._isStale(generation)) return;

    if (started) {
      this._eventDriven = true;
      debugLogger.info("macOS microphone listener restored", {}, "meeting");
    } else {
      this._scheduleListenerRespawn();
    }
  }

  _clearRespawnTimer() {
    if (this._respawnTimer) {
      clearTimeout(this._respawnTimer);
      this._respawnTimer = null;
    }
  }

  // Our own captures never enter the pid set: dictation opens the mic from
  // Chromium's audio service and the system-audio helpers are child processes,
  // so the OS reports both under pids that are not the main one (#1392). Kept
  // out at ingest so they can neither arm the prompt nor, on their stop, read
  // as "every mic closed" while another app still holds one.
  _isExcludedProcessId(pid) {
    try {
      return this._getExcludedProcessIdSet().has(pid);
    } catch {
      // A failing provider is reported as unreliable by _updateExternalMicState.
      return false;
    }
  }

  _parsePidScopedListenerLine(line) {
    const startMatch = line.match(/^MIC_START\s+(\d+)$/);
    if (startMatch) {
      const pid = parseInt(startMatch[1], 10);
      if (this._isExcludedProcessId(pid)) return;
      this._activeMicPids.add(pid);
      const externalMicActive = this._updateExternalMicState();
      this._onMicStateChanged(externalMicActive);
      return;
    }

    const stopMatch = line.match(/^MIC_STOP\s+(\d+)$/);
    if (stopMatch) {
      const pid = parseInt(stopMatch[1], 10);
      if (this._isExcludedProcessId(pid)) return;
      this._activeMicPids.delete(pid);
      const externalMicActive = this._updateExternalMicState();
      this._onMicStateChanged(externalMicActive);
      return;
    }
  }

  _getExcludedProcessIdSet() {
    const processIds = this._getExcludedProcessIds();
    return new Set(
      [...processIds]
        .map((processId) => Number(processId))
        .filter((processId) => Number.isInteger(processId) && processId > 0)
    );
  }

  _setPidScopedCapability(reliable) {
    this._pidScopedCapability = reliable;
    this._updateExternalMicState();
  }

  // Auto-end may only trust the ownership snapshot while a listener is pushing
  // every transition into it. The poller cannot carry that guarantee: it samples
  // at CHECK_INTERVAL_MS and stops outright while gated by a recording, a warm
  // hold or a dismissal cooldown — so a snapshot taken before a meeting began
  // would still read as "another app holds the mic" for the whole recording,
  // and the controller's ownership mode would never release it.
  _isOwnershipSnapshotLive() {
    return this._listenerProcess !== null;
  }

  _updateExternalMicState(emitChange = true) {
    let excludedProcessIds;
    try {
      excludedProcessIds = this._getExcludedProcessIdSet();
    } catch (err) {
      this._externalCapturePids.clear();
      this._setExternalMicSnapshot(false, false, emitChange);
      debugLogger.warn(
        "Failed to resolve excluded microphone PIDs",
        { error: err.message },
        "meeting"
      );
      return false;
    }

    const externalPids = [...this._activeMicPids].filter(
      (processId) => !excludedProcessIds.has(processId)
    );
    this._externalCapturePids = new Set(externalPids);
    const externalMicActive = externalPids.length > 0;
    if (!this._pidScopedCapability || !this._isOwnershipSnapshotLive()) {
      this._setExternalMicSnapshot(false, false, emitChange);
      return externalMicActive;
    }

    this._setExternalMicSnapshot(true, externalMicActive, emitChange);
    return externalMicActive;
  }

  _setExternalMicSnapshot(reliable, externalMicActive, emitChange) {
    this._externalMicReliable = reliable;
    this._externalMicActive = reliable ? externalMicActive : false;
    if (
      emitChange &&
      (this._externalMicReliable !== this._lastEmittedExternalMicReliable ||
        this._externalMicActive !== this._lastEmittedExternalMicActive) &&
      this._running
    ) {
      this._lastEmittedExternalMicReliable = this._externalMicReliable;
      this._lastEmittedExternalMicActive = this._externalMicActive;
      this.emit("external-mic-state-changed", this.getExternalMicState());
    }
  }

  // ---------------------------------------------------------------------------
  // Shared event-driven handler
  // ---------------------------------------------------------------------------

  // The listeners are edge-triggered: they announce transitions, never steady
  // state. A gate may swallow the only edge a call will ever produce, so the
  // state is recorded unconditionally and re-evaluated when gates lift.
  _onMicStateChanged(active, attributed = true) {
    if (!this._running) return;
    this._lastKnownMicState = active;
    this._lastKnownMicAttributed = attributed;
    this._rearmPromptForSourceChange(active);
    this._evaluateMicState(active);
  }

  _reevaluateAfterGate() {
    if (this._running && this._eventDriven && this._lastKnownMicState) {
      this._evaluateMicState(true);
    }
  }

  _cooldownRemainingMs() {
    if (!this.lastDismissedAt) return 0;
    return Math.max(0, COOLDOWN_MS - (Date.now() - this.lastDismissedAt));
  }

  _scheduleCooldownReeval(delayMs) {
    this._clearCooldownReevalTimer();
    this._cooldownReevalTimer = setTimeout(() => {
      this._cooldownReevalTimer = null;
      this._reevaluateAfterGate();
    }, delayMs);
  }

  _clearCooldownReevalTimer() {
    if (this._cooldownReevalTimer) {
      clearTimeout(this._cooldownReevalTimer);
      this._cooldownReevalTimer = null;
    }
  }

  _isUnattributedActivityCorroborated() {
    return this._lastKnownMicAttributed || this._isMeetingAppRunning();
  }

  _evaluateMicState(active) {
    if (this._userRecording) {
      debugLogger.debug("Mic state changed but user recording, ignoring", { active }, "meeting");
      return;
    }
    if (this._micWarmHold) {
      debugLogger.debug("Mic state changed during warm-hold, ignoring", { active }, "meeting");
      return;
    }
    const cooldownRemainingMs = this._cooldownRemainingMs();
    if (cooldownRemainingMs > 0) {
      debugLogger.debug(
        "Mic state changed but in cooldown",
        { active, remainingMs: cooldownRemainingMs },
        "meeting"
      );
      if (active) {
        this._scheduleCooldownReeval(cooldownRemainingMs);
      } else {
        this._clearCooldownReevalTimer();
      }
      return;
    }
    if (active && !this._isUnattributedActivityCorroborated()) {
      debugLogger.debug("Unattributed mic activity without a meeting app, waiting", {}, "meeting");
      return;
    }

    debugLogger.debug(
      "Mic state changed (event-driven)",
      { active, hasPrompted: this.hasPrompted },
      "meeting"
    );

    if (active) {
      this._clearResetTimer();
      if (this.hasPrompted) {
        debugLogger.debug("Mic active but already prompted, suppressing", {}, "meeting");
        return;
      }
      if (!this.audioActiveStart) this.audioActiveStart = Date.now();

      if (!this._sustainedTimer) {
        this._sustainedTimer = setTimeout(() => {
          this._sustainedTimer = null;
          if (this._userRecording || this._micWarmHold || this.hasPrompted) return;
          if (this.lastDismissedAt && Date.now() - this.lastDismissedAt < COOLDOWN_MS) return;
          if (!this._isUnattributedActivityCorroborated()) return;

          this._markPrompted();
          const now = Date.now();
          const durationMs = now - this.audioActiveStart;
          const attributed = this._lastKnownMicAttributed;
          debugLogger.info(
            "Sustained audio activity detected (event-driven)",
            { durationMs, attributed },
            "meeting"
          );
          this.emit("sustained-audio-detected", { durationMs, detectedAt: now, attributed });
        }, SUSTAINED_EVENT_DRIVEN_MS);
      }
    } else {
      this._clearSustainedTimer();
      this.audioActiveStart = null;
      if (this.hasPrompted) this._startResetTimer();
    }
  }

  // ---------------------------------------------------------------------------
  // Polling fallback
  // ---------------------------------------------------------------------------

  _pauseAutomaticPrompts() {
    this._clearSustainedTimer();
    this.audioActiveStart = null;
    this._lastKnownMicState = false;
    debugLogger.info("macOS microphone listener unavailable; automatic audio prompts paused", {}, "meeting");
  }
}

module.exports = AudioActivityDetector;
