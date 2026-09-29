import fs from "fs";
import path from "path";
import { app } from "electron";

type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

const LOG_LEVELS: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

const MAX_CAPTURE_ERROR_LOG_BYTES = 1024 * 1024;
const MAX_CAPTURE_ERROR_ENTRY_BYTES = 16 * 1024;

const normalizeLevel = (value: unknown): LogLevel | null => {
  if (!value) return null;
  const lower = String(value).toLowerCase();
  return Object.prototype.hasOwnProperty.call(LOG_LEVELS, lower) ? (lower as LogLevel) : null;
};

const readArgLogLevel = (): string | null => {
  const argv = process.argv || [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--log-level" && argv[i + 1]) {
      return argv[i + 1];
    }
    if (arg.startsWith("--log-level=")) {
      return arg.split("=", 2)[1];
    }
  }
  return null;
};

const hasConsoleLogOptIn = (): boolean => (process.argv || []).includes("--console-logs");

class DebugLogger {
  logLevel: LogLevel;
  levelValue: number;
  debugMode: boolean;
  logFile: string | null;
  logStream: fs.WriteStream | null;
  fileLoggingEnabled: boolean;
  fileLoggingPending: boolean;
  consoleLoggingEnabled: boolean;

  constructor() {
    this.logLevel = this.resolveLogLevel();
    this.levelValue = LOG_LEVELS[this.logLevel] || LOG_LEVELS.info;
    this.debugMode = this.isDebugEnabled();
    this.logFile = null;
    this.logStream = null;
    this.fileLoggingEnabled = false;
    this.fileLoggingPending = this.debugMode; // Track if we need to initialize file logging later
    this.consoleLoggingEnabled = this.resolveConsoleLogging();

    // IMPORTANT: Do NOT call initializeFileLogging() here!
    // It uses app.getPath() which is unsafe before app.whenReady().
    // File logging will be initialized on first log write or via ensureFileLogging().
  }

  initializeFileLogging(): void {
    if (this.fileLoggingEnabled) return;

    // Check if app is ready before accessing app.getPath()
    // This is critical because app.getPath() can hang or fail before app.whenReady()
    if (!app.isReady()) {
      // App not ready yet, will try again later via ensureFileLogging() or write()
      return;
    }

    try {
      const logsDir = path.join(app.getPath("userData"), "logs");
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      this.logFile = path.join(logsDir, `debug-${timestamp}.log`);

      this.logStream = fs.createWriteStream(this.logFile, { flags: "a" });
      this.fileLoggingEnabled = true;
      this.fileLoggingPending = false;

      this.debug("Debug logging enabled", { logFile: this.logFile });
      this.info("System Info", {
        appVersion: app.getVersion(),
        platform: process.platform,
        nodeVersion: process.version,
        electronVersion: process.versions.electron,
        appPath: app.getAppPath(),
        userDataPath: app.getPath("userData"),
        resourcesPath: process.resourcesPath,
        environment: process.env.NODE_ENV,
      });
    } catch (error) {
      this.fileLoggingEnabled = false;
      this.fileLoggingPending = false;
      console.error("Failed to initialize debug logging:", error);
    }
  }

  /**
   * Ensures file logging is initialized if debug mode is enabled.
   * This should be called after app.whenReady() to safely initialize file logging.
   */
  ensureFileLogging(): void {
    if (this.fileLoggingPending && !this.fileLoggingEnabled) {
      this.initializeFileLogging();
    }
  }

  resolveLogLevel(): LogLevel {
    const argLevel = normalizeLevel(readArgLogLevel());
    if (argLevel) {
      return argLevel;
    }

    const envLevel = normalizeLevel(process.env.GRISTMILL_LOG_LEVEL || process.env.LOG_LEVEL);
    if (envLevel) {
      return envLevel;
    }

    return "info";
  }

  resolveConsoleLogging(): boolean {
    // Packaged Windows apps can inherit the launching shell's standard handles.
    return process.platform !== "win32" || !app.isPackaged || hasConsoleLogOptIn();
  }

  refreshLogLevel(): void {
    const nextLevel = this.resolveLogLevel();
    if (nextLevel === this.logLevel) return;

    this.logLevel = nextLevel;
    this.levelValue = LOG_LEVELS[this.logLevel] || LOG_LEVELS.info;
    this.debugMode = this.isDebugEnabled();

    if (this.debugMode && !this.fileLoggingEnabled) {
      this.initializeFileLogging();
    }
  }

  getLevel(): LogLevel {
    return this.logLevel;
  }

  isDebugEnabled(): boolean {
    return this.levelValue <= LOG_LEVELS.debug;
  }

  shouldLog(level: string): boolean {
    const normalized: LogLevel = normalizeLevel(level) || "info";
    return LOG_LEVELS[normalized] >= this.levelValue;
  }

  serializeValue(value: unknown): unknown {
    if (value instanceof Error) {
      const code = (value as NodeJS.ErrnoException).code;
      return {
        name: value.name,
        message: value.message,
        ...(code ? { code } : {}),
        ...(value.stack ? { stack: value.stack } : {}),
        ...(value as unknown as Record<string, unknown>),
      };
    }
    return value;
  }

  formatArgs(args: unknown[]): string {
    return args
      .map((arg) => {
        if (arg !== null && typeof arg === "object") {
          try {
            return JSON.stringify(this.serializeValue(arg), null, 2);
          } catch {
            return String(arg);
          }
        }
        return String(arg);
      })
      .join(" ");
  }

  formatMeta(meta: unknown): string {
    if (meta === undefined) return "";
    if (typeof meta === "string") return meta;
    try {
      return JSON.stringify(this.serializeValue(meta), null, 2);
    } catch {
      return String(meta);
    }
  }

  write(
    level: string,
    message: string,
    meta?: unknown,
    scope?: string,
    source?: string
  ): void {
    const normalized = normalizeLevel(level) || "info";
    const captureFailure = scope === "meeting-capture" && (normalized === "error" || normalized === "fatal");
    if (!this.shouldLog(normalized) && !captureFailure) return;

    // Try to initialize file logging if pending and app is ready
    if (this.fileLoggingPending && !this.fileLoggingEnabled) {
      this.initializeFileLogging();
    }

    const timestamp = new Date().toISOString();
    const scopeTag = scope ? `[${scope}]` : "";
    const sourceTag = source ? `[${source}]` : "";
    const levelTag = `[${normalized.toUpperCase()}]`;
    const baseLine = `[${timestamp}] ${levelTag}${scopeTag}${sourceTag} ${message}`;
    const metaText = this.formatMeta(meta);
    const logLine = metaText ? `${baseLine} ${metaText}\n` : `${baseLine}\n`;

    if (this.consoleLoggingEnabled) {
      const consoleFn =
        normalized === "error" || normalized === "fatal"
          ? console.error
          : normalized === "warn"
            ? console.warn
            : console.log;

      if (meta !== undefined) {
        // Pass the prefix as a %s arg, not as a format string. See CodeQL js/tainted-format-string.
        consoleFn("%s", `${levelTag}${scopeTag}${sourceTag} ${message}`, meta);
      } else {
        consoleFn(`${levelTag}${scopeTag}${sourceTag} ${message}`);
      }
    }

    if (this.logStream) {
      this.logStream.write(logLine);
    }
    if (captureFailure) {
      this.writeCaptureErrorFile(logLine);
    }
  }

  private writeCaptureErrorFile(line: string): void {
    if (!app.isReady()) return;
    try {
      const logsDir = path.join(app.getPath("userData"), "logs");
      fs.mkdirSync(logsDir, { recursive: true });
      const active = path.join(logsDir, "capture-errors.log");
      const previous = path.join(logsDir, "capture-errors.1.log");
      const bytes = Buffer.from(`[${app.getVersion()}] ${line}`);
      const entry = bytes.length <= MAX_CAPTURE_ERROR_ENTRY_BYTES
        ? bytes
        : Buffer.concat([
            bytes.subarray(0, MAX_CAPTURE_ERROR_ENTRY_BYTES - 14),
            Buffer.from(" [truncated]\n"),
          ]);
      if (fs.existsSync(active) && fs.statSync(active).size + entry.length > MAX_CAPTURE_ERROR_LOG_BYTES) {
        fs.rmSync(previous, { force: true });
        fs.renameSync(active, previous);
      }
      fs.appendFileSync(active, entry, { mode: 0o600 });
    } catch (error) {
      console.error("Failed to write capture error log:", error);
    }
  }

  log(...args: unknown[]): void {
    this.write("debug", this.formatArgs(args));
  }

  debug(message: string, meta?: unknown, scope?: string, source?: string): void {
    this.write("debug", message, meta, scope, source);
  }

  trace(message: string, meta?: unknown, scope?: string, source?: string): void {
    this.write("trace", message, meta, scope, source);
  }

  info(message: string, meta?: unknown, scope?: string, source?: string): void {
    this.write("info", message, meta, scope, source);
  }

  warn(message: string, meta?: unknown, scope?: string, source?: string): void {
    this.write("warn", message, meta, scope, source);
  }

  logReasoning(stage: string, details: unknown): void {
    this.debug(stage, details, "reasoning");
  }

  error(...args: unknown[]): void {
    const message = `ERROR: ${this.formatArgs(args)}`;
    this.write("error", message);
  }

  fatal(...args: unknown[]): void {
    const message = `FATAL: ${this.formatArgs(args)}`;
    this.write("fatal", message);
  }

  logEntry(entry: unknown): void {
    if (!entry || typeof entry !== "object") return;
    const record = entry as Record<string, unknown>;
    const normalized =
      normalizeLevel(typeof record.level === "string" ? record.level : undefined) || "info";
    const message = record.message ? String(record.message) : "";
    const scope = record.scope ? String(record.scope) : undefined;
    const source = record.source ? String(record.source) : "renderer";
    this.write(normalized, message, record.meta, scope, source);
  }

  logFFmpegDebug(
    context: string,
    ffmpegPath: string | null | undefined,
    additionalInfo: Record<string, unknown> = {}
  ): void {
    if (!this.isDebugEnabled()) return;

    const debugInfo: Record<string, unknown> = {
      context,
      ffmpegPath,
      exists: ffmpegPath ? fs.existsSync(ffmpegPath) : false,
      platform: process.platform,
      ...additionalInfo,
    };

    if (ffmpegPath && fs.existsSync(ffmpegPath)) {
      try {
        const stats = fs.statSync(ffmpegPath);
        debugInfo.fileInfo = {
          size: stats.size,
          isFile: stats.isFile(),
          // Skip X_OK check on Windows (not reliable)
          isExecutable: process.platform !== "win32" ? !!(stats.mode & fs.constants.X_OK) : false,
          executableCheckSkipped: process.platform === "win32",
          permissions: stats.mode.toString(8),
          modified: stats.mtime,
        };
      } catch (e) {
        debugInfo.statError = (e as Error).message;
      }
    }

    // Check parent directory permissions
    if (ffmpegPath) {
      const dir = path.dirname(ffmpegPath);
      try {
        fs.accessSync(dir, fs.constants.R_OK);
        debugInfo.dirReadable = true;
      } catch (e) {
        debugInfo.dirReadable = false;
        debugInfo.dirError = (e as Error).message;
      }
    }

    // Platform-specific path checks
    let possiblePaths: (string | null | undefined)[] = [];
    if (process.platform === "win32") {
      possiblePaths = [
        ffmpegPath,
        ffmpegPath?.replace(/app\.asar([/\\])/, "app.asar.unpacked$1"),
        path.join(
          process.resourcesPath || "",
          "app.asar.unpacked",
          "node_modules",
          "ffmpeg-static",
          "ffmpeg.exe"
        ),
        path.join(process.env.ProgramFiles || "C:\\Program Files", "ffmpeg", "bin", "ffmpeg.exe"),
        "C:\\ffmpeg\\bin\\ffmpeg.exe",
      ].filter(Boolean);
    } else {
      possiblePaths = [
        ffmpegPath,
        ffmpegPath?.replace("app.asar", "app.asar.unpacked"),
        path.join(
          process.resourcesPath || "",
          "app.asar.unpacked",
          "node_modules",
          "ffmpeg-static",
          "ffmpeg"
        ),
        "/usr/local/bin/ffmpeg",
        "/opt/homebrew/bin/ffmpeg",
        "/usr/bin/ffmpeg",
      ].filter(Boolean);
    }

    debugInfo.pathChecks = possiblePaths.map((p) => ({
      path: p,
      exists: p ? fs.existsSync(p) : false,
      normalized: p ? path.normalize(p) : "",
    }));

    this.debug(`FFmpeg Debug - ${context}`, debugInfo, "ffmpeg");
  }

  logAudioData(context: string, audioBlob: unknown): void {
    if (!this.isDebugEnabled()) return;

    const blob = (audioBlob ?? null) as {
      type?: string;
      size?: number;
      constructor?: { name?: string };
    } | null;
    const audioInfo: Record<string, unknown> = {
      context,
      type: blob?.type || "unknown",
      size: blob?.size || 0,
      constructor: blob?.constructor?.name || "unknown",
    };

    if (audioBlob instanceof ArrayBuffer) {
      audioInfo.byteLength = audioBlob.byteLength;
      // Check first few bytes
      const view = new Uint8Array(audioBlob, 0, Math.min(16, audioBlob.byteLength));
      audioInfo.firstBytes = Array.from(view)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(" ");
    } else if (audioBlob instanceof Uint8Array) {
      audioInfo.byteLength = audioBlob.byteLength;
      const view = audioBlob.slice(0, Math.min(16, audioBlob.byteLength));
      audioInfo.firstBytes = Array.from(view)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(" ");
    }

    this.debug("Audio Data Debug", audioInfo, "audio");
  }

  logProcessStart(
    command: string,
    args: readonly string[] | string,
    options: { cwd?: string; env?: Record<string, string | undefined> } = {}
  ): void {
    if (!this.isDebugEnabled()) return;

    this.debug(
      "Starting process",
      {
        command,
        args,
        cwd: options.cwd || process.cwd(),
        env: {
          FFMPEG_PATH: options.env?.FFMPEG_PATH,
          FFMPEG_EXECUTABLE: options.env?.FFMPEG_EXECUTABLE,
          FFMPEG_BINARY: options.env?.FFMPEG_BINARY,
          PATH_preview: options.env?.PATH?.substring(0, 200) + "...",
        },
      },
      "process"
    );
  }

  logProcessOutput(processName: string, type: string, data: Buffer | string): void {
    if (!this.isDebugEnabled()) return;

    const output = data.toString().trim();
    if (output) {
      this.debug(`${processName} ${type}`, output, "process");
    }
  }

  logWhisperPipeline(stage: string, details: unknown): void {
    if (!this.isDebugEnabled()) return;
    this.debug(`Whisper Pipeline - ${stage}`, details, "whisper");
  }

  logSTTPipeline(stage: string, details: unknown): void {
    if (!this.isDebugEnabled()) return;
    this.debug(`STT Pipeline - ${stage}`, details, "stt");
  }

  getLogPath(): string | null {
    return this.logFile;
  }

  isEnabled(): boolean {
    return this.isDebugEnabled();
  }

  close(): void {
    if (this.logStream) {
      this.log("📝 Debug logger closing");
      this.logStream.end();
      this.logStream = null;
    }
  }
}

// Singleton instance
const debugLogger = new DebugLogger();
export default debugLogger;
module.exports = debugLogger;
