import { execFile } from "child_process";
import { EventEmitter } from "events";
import { promisify } from "util";
import { resolveBundledBinary } from "./binaryResolver.js";
import debugLogger from "./debugLogger.js";

const execFileAsync = promisify(execFile);

const POLL_MS = 3000;

const CALL_KEY = /^(?:zoom:\d+|meet:[a-f0-9]{64})$/;

export class MeetingCallDetector extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private generation = 0;
  private readonly activeKeys = new Set<string>();
  private readonly absentCounts = new Map<string, number>();
  private readonly lastStates = new Map<string, string>();
  private lastUnknown: string | null = null;
  private readonly scan: () => Promise<string>;

  constructor(scan?: () => Promise<string>) {
    super();
    let binary: string | null | undefined;
    this.scan =
      scan ??
      (async () => {
        binary ??= resolveBundledBinary("macos-meeting-ax", "meeting");

        if (!binary) return "unknown\tbinary";
        const { stdout } = await execFileAsync(binary, [], { timeout: 2500, maxBuffer: 64 * 1024 });

        return stdout;
      });
  }

  start(): void {
    if (this.timer || process.platform !== "darwin") return;
    this.generation += 1;
    void this.poll().catch(() => undefined);
    this.timer = setInterval(() => void this.poll().catch(() => undefined), POLL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    this.generation += 1;

    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    const generation = this.generation;

    try {
      const lines = (await this.scan())
        .trim()
        .split("\n")
        .map((line) => line.trim().split("\t"));

      if (generation !== this.generation) return;
      const reason = lines.find(([state]) => state === "unknown")?.[1] ?? null;
      const unknown = reason !== null;

      if (reason !== this.lastUnknown) {
        if (reason === "accessibility") {
          debugLogger.warn(
            "Accessibility permission required for meeting detection",
            {},
            "meeting"
          );
        } else if (reason) {
          debugLogger.info("Meeting AX unavailable or incomplete", { reason }, "meeting");
        }

        this.lastUnknown = reason;
      }

      const presentZoom = new Set<string>();
      const inactive = new Set<string>();

      for (const [state, key] of lines) {
        if (!CALL_KEY.test(key ?? "")) continue;

        if (state === "present") presentZoom.add(key);

        if (state === "inactive") inactive.add(key);

        if ((state === "active" || state === "inactive") && this.lastStates.get(key) !== state) {
          debugLogger.info(
            "Meeting AX signal",
            {
              service: key.startsWith("zoom:") ? "zoom" : "meet",
              state,
              reason: state === "inactive" ? "no-visible-leave-control" : "visible-leave-control",
            },
            "meeting"
          );
          this.lastStates.set(key, state);
        }

        if (state !== "active") continue;
        this.activeKeys.add(key);
        this.absentCounts.delete(key);
        this.emit("call-active", { key, service: key.startsWith("zoom:") ? "zoom" : "meet" });
      }

      for (const key of this.activeKeys) {
        if (!inactive.has(key) && !(key.startsWith("zoom:") && !presentZoom.has(key) && !unknown)) {
          continue;
        }

        const count = (this.absentCounts.get(key) ?? 0) + 1;

        if (count < 2) {
          this.absentCounts.set(key, count);
          continue;
        }

        this.activeKeys.delete(key);
        this.absentCounts.delete(key);
        this.lastStates.delete(key);
        this.emit("call-ended", { key });
      }
    } catch (error) {
      debugLogger.warn(
        "Meeting AX snapshot failed",
        { reason: error instanceof Error ? error.name : "error" },
        "meeting"
      );
    } finally {
      this.polling = false;
    }
  }
}
