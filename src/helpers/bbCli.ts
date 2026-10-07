import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import {
  bbProviderSchema,
  bbModelSchema,
  bbEventSchema,
  type BbHarness,
  type BbHostPreferences,
  type BbLogo,
  type BbProvider,
  type BbModel,
  type BbSelection,
} from "../contracts/bb.js";

// Update this together with the JSON fixtures and the runtime smoke check.
export const SUPPORTED_BB_VERSION = "0.44.0";

// bb's stdout is opaque JSON until a caller parses it with its operation
// schema. jsonCommand validates the JSON value shape at its boundary.
type BbJson = z.infer<ReturnType<typeof z.json>>;

// Narrow an opaque JSON field to the primitive types bb statuses use.
function isDisplayValue(value: unknown): value is string | number | boolean | bigint {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  );
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

interface TurnInputItem {
  type: string;
  text: string;
}

function isTurnInputTextItem(value: unknown): value is TurnInputItem {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "text" &&
    "text" in value &&
    typeof value.text === "string"
  );
}

export class BbCliError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

function binaryPath(): string {
  if (process.env.BB_CLI) return process.env.BB_CLI;

  const candidates = [
    join(homedir(), ".local", "bin", "bb"),
    "/Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/host-daemon/dist/bb",
  ];

  return candidates.find(existsSync) ?? candidates[0];
}

async function execute(args: string[], input?: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();

  return new Promise((resolve, reject) => {
    let failure: Error | undefined;
    let stdout = "";
    let stderr = "";

    const child = spawn(process.execPath, [binaryPath(), ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      signal,
      timeout: 30_000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });

    const failAndKill = (error: Error) => {
      failure ??= error;
      child.kill();
    };

    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      if (failure) return;
      stdout += chunk;

      if (stdout.length > 8_000_000) {
        failAndKill(new BbCliError("bb-response-too-large", "bb response exceeded the size limit"));
      }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    child.stdin.on("error", (error) =>
      failAndKill(new BbCliError("bb-stdin-error", error.message))
    );
    child.on("error", (error: NodeJS.ErrnoException) => {
      failure ??=
        error.name === "AbortError"
          ? error
          : new BbCliError(
              error.code === "ENOENT" ? "bb-not-installed" : "bb-cli-error",
              error.message
            );
    });
    child.on("close", (code) => {
      // AbortError can arrive while the child is still alive. Settlement owns close.
      if (failure) return reject(failure);

      if (code === 0) resolve(stdout.trim());
      else {
        try {
          const failure = z
            .object({
              ok: z.literal(false),
              error: z.object({ code: z.string(), message: z.string() }),
            })
            .parse(JSON.parse(stdout));

          reject(new BbCliError(failure.error.code, failure.error.message));
        } catch {
          reject(new BbCliError("bb-cli-error", stderr.trim() || "bb command failed"));
        }
      }
    });
    child.stdin.end(input);
  });
}

async function jsonCommand(args: string[], input?: string, signal?: AbortSignal): Promise<BbJson> {
  const raw = await execute([...args, "--json"], input, signal);

  try {
    const data: unknown = JSON.parse(raw);

    const failure = z
      .object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) })
      .safeParse(data);

    if (failure.success) throw new BbCliError(failure.data.error.code, failure.data.error.message);

    return z.json().parse(data);
  } catch (error) {
    if (error instanceof BbCliError) throw error;
    throw new BbCliError("bb-invalid-response", "bb returned invalid JSON");
  }
}

// Pickers query the catalog on every open; a short-lived cache keeps that from
// spawning several bb processes each time while still noticing an upgrade soon.
const VERSION_TTL_MS = 60_000;

const MODELS_TTL_MS = 5 * 60_000;

let versionCheckedAt = 0;

const modelCache = new Map<string, { at: number; models: BbModel[] }>();

const logoCache = new Map<string, BbLogo | null>();

export function clearBbCaches(): void {
  versionCheckedAt = 0;
  modelCache.clear();
  logoCache.clear();
}

export async function assertBbVersion(): Promise<void> {
  if (Date.now() - versionCheckedAt < VERSION_TTL_MS) return;
  const version = await execute(["--version"]);

  if (version !== SUPPORTED_BB_VERSION) {
    throw new BbCliError(
      "bb-version-unsupported",
      `bb ${SUPPORTED_BB_VERSION} is required; found ${version}`
    );
  }

  versionCheckedAt = Date.now();
}

export async function listBbProviders(): Promise<BbProvider[]> {
  await assertBbVersion();

  return z.array(bbProviderSchema).parse(await jsonCommand(["provider", "list"]));
}

export async function listBbModels(provider: string): Promise<BbModel[]> {
  await assertBbVersion();
  const cached = modelCache.get(provider);

  if (cached && Date.now() - cached.at < MODELS_TTL_MS) return cached.models;
  const models = z.array(bbModelSchema).parse(await jsonCommand(["provider", "models", provider]));
  modelCache.set(provider, { at: Date.now(), models });

  return models;
}

const bbSettingsSchema = z.object({
  serverUrl: z.string(),
  generalSettings: z.object({
    providerOrder: z.array(z.string()).optional(),
    defaultProviderId: z.string().nullable().optional(),
  }),
});

async function readBbSettings(): Promise<z.infer<typeof bbSettingsSchema>> {
  await assertBbVersion();

  return bbSettingsSchema.parse(await jsonCommand(["settings", "show"]));
}

/** bb's own provider order and default, used once to seed Gristmill preferences. */
export async function getBbHostPreferences(): Promise<BbHostPreferences> {
  const settings = await readBbSettings();

  return {
    providerOrder: settings.generalSettings.providerOrder ?? [],
    defaultProviderId: settings.generalSettings.defaultProviderId ?? null,
  };
}

const MAX_LOGO_BYTES = 64 * 1024;

/** Accepts only a bounded SVG document; the renderer shows it as an image, never inline markup. */
export function toBbLogo(contentType: string | null, body: string): BbLogo | null {
  if (!contentType?.startsWith("image/svg+xml")) return null;

  if (Buffer.byteLength(body) > MAX_LOGO_BYTES || !/^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(body))
    return null;

  return {
    dataUrl: `data:image/svg+xml;base64,${Buffer.from(body).toString("base64")}`,
    monochrome: /currentColor/i.test(body),
  };
}

async function fetchBbLogo(serverUrl: string, logoUrl: string): Promise<BbLogo | null> {
  if (logoCache.has(logoUrl)) return logoCache.get(logoUrl) ?? null;
  let logo: BbLogo | null = null;

  try {
    const server = new URL(serverUrl);
    const url = new URL(logoUrl, server);

    // Only bb's loopback provider-logo route; a catalog entry cannot redirect the fetch elsewhere.
    if (
      server.protocol === "http:" &&
      ["127.0.0.1", "localhost"].includes(server.hostname) &&
      url.origin === server.origin &&
      url.pathname.startsWith("/api/v1/system/providers/")
    ) {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000), redirect: "error" });

      if (response.ok) logo = toBbLogo(response.headers.get("content-type"), await response.text());
    }
  } catch {
    logo = null;
  }

  logoCache.set(logoUrl, logo);

  return logo;
}

/** Providers with their logos; a missing logo falls back to a generic icon in the renderer. */
export async function listBbHarnesses(): Promise<BbHarness[]> {
  const providers = await listBbProviders();

  const serverUrl = providers.some((provider) => provider.logoUrl)
    ? await readBbSettings().then(
        (settings) => settings.serverUrl,
        () => null
      )
    : null;

  return Promise.all(
    providers.map(async ({ logoUrl, ...provider }) => ({
      ...provider,
      logo: serverUrl && logoUrl ? await fetchBbLogo(serverUrl, logoUrl) : null,
    }))
  );
}

const projectRequests = new Map<string, Promise<string>>();

async function ensureBbProject(environment: string): Promise<string> {
  const existing = projectRequests.get(environment);

  if (existing) return existing;

  const pending = (async () => {
    const file = join(environment, "project.json");

    const saved = existsSync(file)
      ? z.object({ id: z.string().min(1) }).parse(JSON.parse(readFileSync(file, "utf8"))).id
      : null;

    if (saved) {
      try {
        const project = z
          .object({ id: z.string(), sources: z.array(z.object({ path: z.string() })) })
          .parse(await jsonCommand(["project", "show", saved]));

        if (!project.sources.some((source) => source.path === environment)) {
          throw new BbCliError(
            "bb-project-mismatch",
            "Saved bb project points to a different workspace"
          );
        }

        return project.id;
      } catch (error) {
        if (!(error instanceof BbCliError) || error.code !== "project_not_found") throw error;
      }
    }

    const project = z
      .object({ id: z.string().min(1) })
      .parse(
        await jsonCommand(["project", "create", "--name", "Gristmill Agent", "--root", environment])
      );

    writeFileSync(file, JSON.stringify({ id: project.id }), { mode: 0o600 });

    return project.id;
  })();

  projectRequests.set(environment, pending);
  pending.catch(() => projectRequests.delete(environment));

  return pending;
}

export async function spawnBbThread(
  prompt: string,
  config: BbSelection,
  environment: string,
  signal?: AbortSignal
): Promise<string> {
  await assertBbVersion();
  const projectId = await ensureBbProject(environment);

  const response = z
    .object({ id: z.string().min(1) })
    .parse(
      await jsonCommand(
        [
          "thread",
          "spawn",
          "--project",
          projectId,
          "--environment",
          environment,
          "--provider",
          config.provider,
          "--model",
          config.model,
          "--reasoning-level",
          config.reasoningLevel,
          "--permission-mode",
          "full",
          "--visibility",
          "hidden",
          "--prompt-file",
          "-",
        ],
        prompt,
        signal
      )
    );

  return response.id;
}

export async function tellBbThread(
  threadId: string,
  prompt: string,
  signal?: AbortSignal,
  selection?: BbSelection
): Promise<void> {
  await jsonCommand(
    [
      "thread",
      "tell",
      threadId,
      "--message-file",
      "-",
      ...(selection
        ? ["--model", selection.model, "--reasoning-level", selection.reasoningLevel]
        : []),
    ],
    prompt,
    signal
  );
}

export async function stopBbThread(threadId: string): Promise<void> {
  await jsonCommand(["thread", "stop", threadId]);
}

export async function getBbThreadTitle(threadId: string): Promise<string | null> {
  const result = z
    .object({ thread: z.object({ title: z.string().nullable().optional() }) })
    .parse(await jsonCommand(["thread", "show", threadId]));

  return result.thread.title?.trim() || null;
}

export async function getBbThreadOutput(threadId: string): Promise<string> {
  const result = z
    .object({ output: z.string().nullable() })
    .parse(await jsonCommand(["thread", "output", threadId]));

  return result.output ?? "";
}

export async function getBbThreadHistory(
  threadId: string,
  onUserText?: (text: string) => void,
  onAssistantText?: (text: string) => void,
  onContextReset?: () => void
): Promise<{ sequence: number; completed: boolean; failed: boolean }> {
  let sequence = 0;
  let completed = false;
  let failed = false;
  const pendingInputs = new Map<string, string>();
  let assistantText: string | undefined;
  let providerThreadId: string | undefined;

  while (true) {
    const previousSequence = sequence;

    const events = z
      .array(bbEventSchema)
      .parse(await jsonCommand(["thread", "log", threadId, "--after-seq", String(sequence)]));

    for (const event of events) {
      sequence = Math.max(sequence, event.seq);
      const providerId = event.data?.providerThreadId;

      if (
        event.type === "thread/context/cleared" ||
        event.type === "thread/compacted" ||
        (isString(providerId) && providerThreadId !== undefined && providerId !== providerThreadId)
      ) {
        pendingInputs.clear();
        assistantText = undefined;
        onContextReset?.();
      }

      if (isString(providerId)) providerThreadId = providerId;

      const parsedItem = z
        .object({
          type: z.string(),
          text: z.string().optional(),
          parentToolCallId: z.string().optional(),
        })
        .safeParse(event.data?.item);

      const item = parsedItem.success ? parsedItem.data : undefined;

      if (
        event.type === "item/completed" &&
        item?.type === "agentMessage" &&
        !item.parentToolCallId &&
        isString(item.text)
      )
        assistantText = item.text;

      const requestId = event.data?.requestId;
      const input = event.data?.input;

      if (
        onUserText &&
        event.type === "client/turn/requested" &&
        isString(requestId) &&
        Array.isArray(input)
      ) {
        pendingInputs.set(
          requestId,
          input
            .filter(isTurnInputTextItem)
            .map((entry) => entry.text)
            .join("\n\n")
        );
      }

      if (event.type === "turn/input/accepted" && isString(event.data?.clientRequestId)) {
        const text = pendingInputs.get(event.data.clientRequestId);

        if (text) onUserText?.(text);
        pendingInputs.delete(event.data.clientRequestId);
      }

      if (event.type === "client/turn/requested" || event.type === "turn/started") {
        assistantText = undefined;
        completed = false;
        failed = false;
      } else if (event.type === "turn/completed") {
        completed = event.data?.status === "completed";
        failed = !completed;

        if (completed && assistantText !== undefined) onAssistantText?.(assistantText);
        assistantText = undefined;
      }
    }

    if (events.length < 100) return { sequence, completed, failed };

    if (sequence === previousSequence)
      throw new BbCliError("bb-invalid-log", "bb log did not advance");
  }
}

export async function* watchBbThread(
  threadId: string,
  signal?: AbortSignal,
  afterSeq = 0
): AsyncGenerator<string, void, unknown> {
  let sequence = afterSeq;

  while (!signal?.aborted) {
    const events = z
      .array(bbEventSchema)
      .parse(
        await jsonCommand(
          ["thread", "log", threadId, "--after-seq", String(sequence)],
          undefined,
          signal
        )
      );

    for (const event of events) {
      sequence = Math.max(sequence, event.seq);

      if (event.type === "item/agentMessage/delta" && isString(event.data?.delta)) {
        yield event.data.delta;
      }

      if (event.type === "turn/completed") {
        if (event.data?.status !== "completed") {
          throw new BbCliError(
            "bb-turn-failed",
            `bb turn ended: ${isDisplayValue(event.data?.status) ? String(event.data.status) : "unknown"}`
          );
        }

        return;
      }
    }

    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal?.reason);
      };

      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, 400);

      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}
