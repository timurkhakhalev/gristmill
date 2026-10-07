type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

const LOG_LEVELS: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

function isLogLevel(value: string): value is LogLevel {
  return value in LOG_LEVELS;
}

const normalizeLevel = (value?: string | null): LogLevel | null => {
  if (!value) return null;
  const lower = value.toLowerCase();

  return isLogLevel(lower) ? lower : null;
};

const defaultLevel: LogLevel = "info";

let cachedLevel: LogLevel | null = null;

let levelPromise: Promise<LogLevel> | null = null;

const resolveLogLevel = async (): Promise<LogLevel> => {
  if (cachedLevel) {
    return cachedLevel;
  }

  if (!levelPromise) {
    levelPromise = (async () => {
      if (typeof window !== "undefined" && window.electronAPI?.getLogLevel) {
        try {
          const level = normalizeLevel(await window.electronAPI.getLogLevel());

          if (level) {
            cachedLevel = level;

            return level;
          }
        } catch {
          // Fall back to default level
        }
      }

      cachedLevel = defaultLevel;

      return cachedLevel;
    })();
  }

  return levelPromise;
};

const shouldLog = (level: LogLevel, current: LogLevel) => {
  return LOG_LEVELS[level] >= LOG_LEVELS[current];
};

const logToConsole = (level: LogLevel, message: string, meta?: unknown, scope?: string) => {
  const levelTag = `[${level.toUpperCase()}]`;
  const scopeTag = scope ? `[${scope}]` : "";

  const consoleFn =
    level === "error" || level === "fatal"
      ? console.error
      : level === "warn"
        ? console.warn
        : console.log;

  if (meta !== undefined) {
    consoleFn(`${levelTag}${scopeTag} ${message}`, meta);
  } else {
    consoleFn(`${levelTag}${scopeTag} ${message}`);
  }
};

const log = async (
  level: LogLevel,
  message: string,
  meta?: unknown,
  scope?: string
): Promise<void> => {
  const currentLevel = await resolveLogLevel();

  if (!shouldLog(level, currentLevel)) return;

  if (typeof window !== "undefined" && window.electronAPI?.log) {
    try {
      await window.electronAPI.log({
        level,
        message: String(message),
        meta,
        scope,
        source: "renderer",
      });

      return;
    } catch {
      // Fall back to console
    }
  }

  logToConsole(level, String(message), meta, scope);
};

// Fire-and-forget by contract: log() handles every failure internally
// (bridge errors fall back to console) and no caller awaits logging, so the
// public API returns void and the promise is observed here.
const logFireAndForget = (
  level: LogLevel,
  message: string,
  meta?: unknown,
  scope?: string
): void => {
  log(level, message, meta, scope).catch((error: unknown) =>
    logToConsole("error", error instanceof Error ? error.message : String(error))
  );
};

const logger = {
  trace: (message: string, meta?: unknown, scope?: string) =>
    logFireAndForget("trace", message, meta, scope),
  debug: (message: string, meta?: unknown, scope?: string) =>
    logFireAndForget("debug", message, meta, scope),
  info: (message: string, meta?: unknown, scope?: string) =>
    logFireAndForget("info", message, meta, scope),
  warn: (message: string, meta?: unknown, scope?: string) =>
    logFireAndForget("warn", message, meta, scope),
  error: (message: string, meta?: unknown, scope?: string) =>
    logFireAndForget("error", message, meta, scope),
  fatal: (message: string, meta?: unknown, scope?: string) =>
    logFireAndForget("fatal", message, meta, scope),
  logReasoning: (stage: string, details?: unknown) =>
    logFireAndForget("debug", stage, details, "reasoning"),
  refreshLogLevel: () => {
    cachedLevel = null;
    levelPromise = null;
  },
};

export default logger;
