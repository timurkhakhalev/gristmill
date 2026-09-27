import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { bbProviderSchema, bbModelSchema, bbEventSchema, type BbProvider, type BbModel, type BbSelection } from "../contracts/bb.js";

// Update this together with the JSON fixtures and the runtime smoke check.
export const SUPPORTED_BB_VERSION = "0.44.0";

export class BbCliError extends Error {
  constructor(readonly code: string, message: string) {
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
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(binaryPath(), args, { stdio: ["pipe", "pipe", "pipe"], signal, timeout: 30_000 });
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 8_000_000) {
        child.kill();
        reject(new BbCliError("bb-response-too-large", "bb response exceeded the size limit"));
      }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    child.stdin.on("error", (error) => reject(new BbCliError("bb-stdin-error", error.message)));
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.name === "AbortError") return reject(error);
      reject(new BbCliError(error.code === "ENOENT" ? "bb-not-installed" : "bb-cli-error", error.message));
    });
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else {
        try {
          const failure = z.object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) }).parse(JSON.parse(stdout));
          reject(new BbCliError(failure.error.code, failure.error.message));
        } catch {
          reject(new BbCliError("bb-cli-error", stderr.trim() || "bb command failed"));
        }
      }
    });
    child.stdin.end(input);
  });
}

async function jsonCommand(args: string[], input?: string, signal?: AbortSignal): Promise<unknown> {
  const raw = await execute([...args, "--json"], input, signal);
  try {
    const data: unknown = JSON.parse(raw);
    const failure = z.object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) }).safeParse(data);
    if (failure.success) throw new BbCliError(failure.data.error.code, failure.data.error.message);
    return data;
  } catch (error) {
    if (error instanceof BbCliError) throw error;
    throw new BbCliError("bb-invalid-response", "bb returned invalid JSON");
  }
}

export async function assertBbVersion(): Promise<void> {
  const version = await execute(["--version"]);
  if (version !== SUPPORTED_BB_VERSION) {
    throw new BbCliError("bb-version-unsupported", `bb ${SUPPORTED_BB_VERSION} is required; found ${version}`);
  }
}

export async function listBbProviders(): Promise<BbProvider[]> {
  await assertBbVersion();
  return z.array(bbProviderSchema).parse(await jsonCommand(["provider", "list"]));
}

export async function listBbModels(provider: string): Promise<BbModel[]> {
  await assertBbVersion();
  return z.array(bbModelSchema).parse(await jsonCommand(["provider", "models", provider]));
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
        const project = z.object({ id: z.string(), sources: z.array(z.object({ path: z.string() })) }).parse(
          await jsonCommand(["project", "show", saved])
        );
        if (!project.sources.some((source) => source.path === environment)) {
          throw new BbCliError("bb-project-mismatch", "Saved bb project points to a different workspace");
        }
        return project.id;
      } catch (error) {
        if (!(error instanceof BbCliError) || error.code !== "project_not_found") throw error;
      }
    }
    const project = z.object({ id: z.string().min(1) }).parse(await jsonCommand([
      "project", "create", "--name", "OpenHercules Agent", "--root", environment,
    ]));
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
  const response = z.object({ id: z.string().min(1) }).parse(await jsonCommand([
    "thread", "spawn", "--project", projectId, "--environment", environment,
    "--provider", config.provider, "--model", config.model,
    "--reasoning-level", config.reasoningLevel,
    "--permission-mode", "full", "--visibility", "hidden",
    "--prompt-file", "-",
  ], prompt, signal));
  return response.id;
}

export async function tellBbThread(threadId: string, prompt: string, signal?: AbortSignal): Promise<void> {
  await jsonCommand(["thread", "tell", threadId, "--message-file", "-"], prompt, signal);
}

export async function stopBbThread(threadId: string): Promise<void> {
  await jsonCommand(["thread", "stop", threadId]);
}

export async function getBbThreadOutput(threadId: string): Promise<string> {
  const result = z.object({ output: z.string().nullable() }).parse(await jsonCommand(["thread", "output", threadId]));
  return result.output ?? "";
}

export async function getBbThreadHistory(threadId: string): Promise<{ sequence: number; completed: boolean; failed: boolean }> {
  let sequence = 0;
  let completed = false;
  let failed = false;
  while (true) {
    const previousSequence = sequence;
    const events = z.array(bbEventSchema).parse(await jsonCommand(
      ["thread", "log", threadId, "--after-seq", String(sequence)]
    ));
    for (const event of events) {
      sequence = Math.max(sequence, event.seq);
      if (event.type === "client/turn/requested" || event.type === "turn/started") {
        completed = false;
        failed = false;
      } else if (event.type === "turn/completed") {
        completed = event.data?.status === "completed";
        failed = !completed;
      }
    }
    if (events.length < 100) return { sequence, completed, failed };
    if (sequence === previousSequence) throw new BbCliError("bb-invalid-log", "bb log did not advance");
  }
}

export async function* watchBbThread(
  threadId: string,
  signal?: AbortSignal,
  afterSeq = 0
): AsyncGenerator<string, void, unknown> {
  let sequence = afterSeq;
  while (!signal?.aborted) {
    const events = z.array(bbEventSchema).parse(await jsonCommand(
      ["thread", "log", threadId, "--after-seq", String(sequence)], undefined, signal
    ));
    for (const event of events) {
      sequence = Math.max(sequence, event.seq);
      if (event.type === "item/agentMessage/delta" && typeof event.data?.delta === "string") {
        yield event.data.delta;
      }
      if (event.type === "turn/completed") {
        if (event.data?.status !== "completed") {
          throw new BbCliError("bb-turn-failed", `bb turn ended: ${String(event.data?.status ?? "unknown")}`);
        }
        return;
      }
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => { clearTimeout(timer); reject(signal?.reason); };
      const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, 400);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}
