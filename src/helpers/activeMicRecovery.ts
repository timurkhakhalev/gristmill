const DEFAULT_DEBOUNCE_MS = 250;
const DEFAULT_MUTE_GRACE_MS = 800;
const DEFAULT_RETRY_MS = 2000;

export interface AudioInputDevice {
  kind?: string;
  deviceId?: string;
  groupId?: string;
  label?: string;
}

export interface AudioInputSnapshot {
  defaultKey: string;
  keys: Set<string>;
  deviceIds: Set<string>;
  groupIds: Set<string>;
}

export interface RecoverableAudioTrack {
  readyState: string;
  muted: boolean;
  getSettings?: () => { deviceId?: string; groupId?: string };
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
  stop(): void;
}

export interface RecoverableAudioStream {
  getAudioTracks?: () => RecoverableAudioTrack[];
  getTracks?: () => RecoverableAudioTrack[];
}

export interface MicRecoveryMediaDevices {
  enumerateDevices(): Promise<readonly AudioInputDevice[]>;
  addEventListener?: (type: "devicechange", listener: () => void) => void;
  removeEventListener?: (type: "devicechange", listener: () => void) => void;
}

export type ActiveMicRecoveryStatus = "inactive" | "active" | "reconnecting" | "unavailable";

export interface ActiveMicRecoveryOptions<Stream extends RecoverableAudioStream = RecoverableAudioStream> {
  mediaDevices: MicRecoveryMediaDevices;
  acquire(reason: string): Promise<Stream>;
  onRecovered(
    replacement: Stream,
    oldStream: Stream | null,
    reason: string
  ): Promise<void>;
  onStatusChange?: (status: ActiveMicRecoveryStatus) => void;
  debounceMs?: number;
  muteGraceMs?: number;
  retryMs?: number;
}

const deviceKey = (device?: AudioInputDevice | null): string =>
  [device?.deviceId || "", device?.groupId || "", device?.label || ""].join("\u0000");

export const describeAudioInputs = (devices: readonly AudioInputDevice[] = []): AudioInputSnapshot => {
  const inputs = devices.filter((device) => device.kind === "audioinput");
  return {
    defaultKey: inputs.length > 0 ? deviceKey(inputs[0]) : "",
    keys: new Set(inputs.map(deviceKey)),
    deviceIds: new Set(inputs.map((device) => device.deviceId).filter(Boolean)),
    groupIds: new Set(inputs.map((device) => device.groupId).filter(Boolean)),
  };
};

export const activeTrackIsAvailable = (
  track: RecoverableAudioTrack | null,
  inputs: AudioInputSnapshot
): boolean => {
  if (!track || track.readyState === "ended") return false;
  const settings = track.getSettings?.() || {};
  if (settings.deviceId && inputs.deviceIds.has(settings.deviceId)) return true;
  if (settings.groupId && inputs.groupIds.has(settings.groupId)) return true;
  // Device labels are not a stable identity, but a live track with no exposed IDs
  // is healthier than guessing that a permission-redacted enumeration removed it.
  return !settings.deviceId && !settings.groupId;
};

export class ActiveMicRecoveryController<Stream extends RecoverableAudioStream = RecoverableAudioStream> {
  private mediaDevices: MicRecoveryMediaDevices;
  private acquire: ActiveMicRecoveryOptions<Stream>["acquire"];
  private onRecovered: ActiveMicRecoveryOptions<Stream>["onRecovered"];
  private onStatusChange?: ActiveMicRecoveryOptions<Stream>["onStatusChange"];
  private debounceMs: number;
  private muteGraceMs: number;
  private retryMs: number;
  private status: ActiveMicRecoveryStatus;
  private stream: Stream | null;
  private track: RecoverableAudioTrack | null;
  private followDefault: boolean;
  private inputs: AudioInputSnapshot;
  private generation: number;
  private recoveryPromise: Promise<boolean> | null;
  private debounceTimer: ReturnType<typeof setTimeout> | null;
  private muteTimer: ReturnType<typeof setTimeout> | null;
  private retryTimer: ReturnType<typeof setTimeout> | null;
  private started: boolean;
  private readonly onDeviceChange: () => void;
  private readonly onTrackEnded: () => void;
  private readonly onTrackMute: () => void;
  private readonly onTrackUnmute: () => void;

  constructor({
    mediaDevices,
    acquire,
    onRecovered,
    onStatusChange,
    debounceMs = DEFAULT_DEBOUNCE_MS,
    muteGraceMs = DEFAULT_MUTE_GRACE_MS,
    retryMs = DEFAULT_RETRY_MS,
  }: ActiveMicRecoveryOptions<Stream>) {
    this.mediaDevices = mediaDevices;
    this.acquire = acquire;
    this.onRecovered = onRecovered;
    this.onStatusChange = onStatusChange;
    this.debounceMs = debounceMs;
    this.muteGraceMs = muteGraceMs;
    this.retryMs = retryMs;
    this.status = "inactive";
    this.stream = null;
    this.track = null;
    this.followDefault = true;
    this.inputs = describeAudioInputs();
    this.generation = 0;
    this.recoveryPromise = null;
    this.debounceTimer = null;
    this.muteTimer = null;
    this.retryTimer = null;
    this.started = false;
    this.onDeviceChange = () => this.scheduleEvaluation();
    this.onTrackEnded = () => this.recover("ended");
    this.onTrackMute = () => {
      clearTimeout(this.muteTimer);
      this.muteTimer = setTimeout(() => {
        if (this.track?.muted) this.recover("muted");
      }, this.muteGraceMs);
    };
    this.onTrackUnmute = () => clearTimeout(this.muteTimer);
  }

  private setStatus(status: ActiveMicRecoveryStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.onStatusChange?.(status);
  }

  async start(
    stream: Stream,
    { followDefault = true }: { followDefault?: boolean } = {}
  ): Promise<void> {
    this.stop();
    this.started = true;
    this.generation += 1;
    this.followDefault = followDefault;
    this.mediaDevices?.addEventListener?.("devicechange", this.onDeviceChange);
    this.attachStream(stream);
    await this.refreshInputs();
    if (!this.started) return;
    // The track may have died (or come up muted) before our listeners attached;
    // those events won't replay, so evaluate the track's state directly.
    const alive = this.track && this.track.readyState !== "ended";
    this.setStatus(alive ? "active" : "unavailable");
    if (!alive) {
      this.recover("start");
    } else if (this.track.muted) {
      this.onTrackMute();
    }
  }

  private attachStream(stream: Stream | null): void {
    this.detachTrack();
    this.stream = stream || null;
    this.track = stream?.getAudioTracks?.()[0] || null;
    this.track?.addEventListener?.("ended", this.onTrackEnded);
    this.track?.addEventListener?.("mute", this.onTrackMute);
    this.track?.addEventListener?.("unmute", this.onTrackUnmute);
  }

  private detachTrack(): void {
    this.track?.removeEventListener?.("ended", this.onTrackEnded);
    this.track?.removeEventListener?.("mute", this.onTrackMute);
    this.track?.removeEventListener?.("unmute", this.onTrackUnmute);
    this.track = null;
    clearTimeout(this.muteTimer);
    this.muteTimer = null;
  }

  private async refreshInputs(): Promise<AudioInputSnapshot | null> {
    try {
      this.inputs = describeAudioInputs(await this.mediaDevices.enumerateDevices());
      return this.inputs;
    } catch {
      return null;
    }
  }

  private scheduleEvaluation(): void {
    if (!this.started) return;
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.evaluateDeviceChange(), this.debounceMs);
  }

  private async evaluateDeviceChange(): Promise<void> {
    if (!this.started) return;
    const previous = this.inputs;
    const current = await this.refreshInputs();
    if (!this.started || !current) {
      if (this.track?.readyState === "ended") this.recover("devicechange-ended");
      return;
    }

    const defaultChanged = previous.defaultKey !== current.defaultKey;
    const activeMissing = !activeTrackIsAvailable(this.track, current);
    if ((this.followDefault && defaultChanged) || activeMissing || this.status === "unavailable") {
      this.recover("devicechange");
    }
  }

  recover(reason: string): Promise<boolean> {
    if (!this.started) return Promise.resolve(false);
    if (this.recoveryPromise) return this.recoveryPromise;

    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const generation = this.generation;
    const oldStream = this.stream;
    this.setStatus("reconnecting");

    const attempt = async () => {
      let replacement: Stream | null = null;
      try {
        replacement = await this.acquire(reason);
        if (!replacement?.getAudioTracks?.()[0]) throw new Error("No audio track returned");
        if (!this.started || generation !== this.generation) {
          replacement.getTracks?.().forEach((track) => track.stop());
          return false;
        }
        await this.onRecovered(replacement, oldStream, reason);
        if (!this.started || generation !== this.generation) {
          replacement.getTracks?.().forEach((track) => track.stop());
          return false;
        }
        this.attachStream(replacement);
        await this.refreshInputs();
        this.setStatus("active");
        return true;
      } catch {
        if (replacement && replacement !== this.stream) {
          replacement.getTracks?.().forEach((track) => track.stop());
        }
        if (this.started && generation === this.generation) {
          this.setStatus("unavailable");
          this.scheduleRetry();
        }
        return false;
      }
    };
    // Only clear our own handle: a stale attempt settling after stop()+start()
    // must not clobber a newer in-flight recovery's dedup handle.
    const promise = attempt().finally(() => {
      if (this.recoveryPromise === promise) this.recoveryPromise = null;
    });
    this.recoveryPromise = promise;
    return promise;
  }

  private scheduleRetry(): void {
    if (!this.started || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.recover("retry");
    }, this.retryMs);
  }

  stop(): void {
    this.started = false;
    this.generation += 1;
    this.mediaDevices?.removeEventListener?.("devicechange", this.onDeviceChange);
    this.detachTrack();
    clearTimeout(this.debounceTimer);
    clearTimeout(this.retryTimer);
    this.debounceTimer = null;
    this.retryTimer = null;
    this.recoveryPromise = null;
    this.stream = null;
    this.setStatus("inactive");
  }
}
