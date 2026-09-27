import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
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
  return process.env.BB_CLI || join(homedir(), ".local", "bin", "bb");
}

async function execute(args: string[], input?: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(binaryPath(), args, { stdio: ["pipe", "pipe", "pipe"], signal });
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 8_000_000) child.kill();
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      reject(new BbCliError(error.code === "ENOENT" ? "bb-not-installed" : "bb-cli-error", error.message));
    });
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new BbCliError("bb-cli-error", stderr.trim() || "bb command failed"));
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

export async function spawnBbThread(
  prompt: string,
  config: BbSelection,
  environment: string,
  signal?: AbortSignal
): Promise<string> {
  await assertBbVersion();
  const response = z.object({ id: z.string().min(1) }).parse(await jsonCommand([
    "thread", "spawn", "--environment", environment,
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
    const events = z.array(bbEventSchema).parse(await jsonCommand(
      ["thread", "log", threadId, "--after-seq", String(sequence)]
    ));
    for (const event of events) {
      sequence = Math.max(sequence, event.seq);
      if (event.type === "turn/completed") {
        completed = event.data?.status === "completed";
        failed = !completed;
      }
    }
    if (events.length < 100) return { sequence, completed, failed };
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
      const timer = setTimeout(resolve, 400);
      signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    });
  }
}
