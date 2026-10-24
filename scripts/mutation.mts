import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { z } from "zod";
import { resolveTarget, targetIds } from "./mutation-targets.mts";

export const root = fileURLToPath(new URL("../", import.meta.url));

export function parseArguments(
  args: string[]
): { target: string; mode: "dry-run" | "full" } | null {
  if (args.length === 1 && args[0] === "--list") return null;

  if (
    args.length !== 4 ||
    args[0] !== "--target" ||
    args[2] !== "--mode" ||
    (args[3] !== "dry-run" && args[3] !== "full")
  )
    throw new Error(`Usage: --list | --target <${targetIds().join("|")}> --mode dry-run|full`);

  resolveTarget(args[1]);

  return { target: args[1], mode: args[3] };
}

const reportSchema = z.object({
  files: z.record(
    z.string(),
    z.object({
      mutants: z.array(
        z.object({
          status: z.enum([
            "Killed",
            "Survived",
            "NoCoverage",
            "Timeout",
            "RuntimeError",
            "CompileError",
            "Ignored",
            "Pending",
          ]),
        })
      ),
    })
  ),
});

export function outcomeCounts(reportJson: string) {
  const counts = {
    killed: 0,
    survived: 0,
    noCoverage: 0,
    timeout: 0,
    runtimeError: 0,
    compileError: 0,
    ignored: 0,
    pending: 0,
  };

  const keys = {
    Killed: "killed",
    Survived: "survived",
    NoCoverage: "noCoverage",
    Timeout: "timeout",
    RuntimeError: "runtimeError",
    CompileError: "compileError",
    Ignored: "ignored",
    Pending: "pending",
  } as const;

  for (const file of Object.values(reportSchema.parse(JSON.parse(reportJson)).files)) {
    for (const mutant of file.mutants) counts[keys[mutant.status]]++;
  }

  return counts;
}

// Shared runner, config and image inputs; the resolved target adds its scope,
// direct dependencies and focused tests.
export function fingerprintFiles(target: {
  directDependencies: string[];
  mutate: string[];
  testFiles: string[];
}): string[] {
  return [
    "stryker.config.mts",
    "scripts/mutation.mts",
    "scripts/mutation-targets.mts",
    "scripts/mutation-cloud/Dockerfile",
    "scripts/mutation-cloud/entrypoint.sh",
    "package.json",
    "pnpm-lock.yaml",
    "scripts/run-tests.cts",
    "scripts/test-selection.cts",
    "scripts/ensure-sqlite-runtime.cts",
    "test/test-groups.json",
    ...target.directDependencies,
    ...target.mutate,
    ...target.testFiles,
  ];
}

export function fingerprintDigest(inputs: Array<{ path: string; content: string | Buffer }>) {
  const fingerprint = createHash("sha256");

  for (const input of inputs) fingerprint.update(input.path).update(input.content);

  return fingerprint.digest("hex");
}

function utcOffsetLabel(date: Date) {
  const minutes = -date.getTimezoneOffset();
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);

  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

async function main() {
  const selected = parseArguments(process.argv.slice(2));

  if (!selected) {
    console.log(targetIds().join("\n"));

    return;
  }

  const target = resolveTarget(selected.target);
  // Stryker evaluates stryker.config.mts in this process; export the validated selection.
  process.env.MUTATION_TARGET = selected.target;
  const { default: config } = await import("../stryker.config.mts");

  const startedAt = new Date();
  const artifactDirectory = path.join(root, target.artifactDirectory);
  // Remove prior reports so a failed dry/full run cannot inherit successful evidence.
  await rm(artifactDirectory, { recursive: true, force: true });
  await mkdir(artifactDirectory, { recursive: true });
  const files = fingerprintFiles(target);
  const inputs: Array<{ path: string; content: Buffer }> = [];

  for (const file of files)
    inputs.push({ path: file, content: await readFile(path.join(root, file)) });
  const targetFingerprint = fingerprintDigest(inputs);

  const commit = process.env.CLOUD_RUN_EXECUTION
    ? z
        .string()
        .regex(/^[a-f0-9]{40}$/)
        .parse(process.env.MUTATION_COMMIT)
    : execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();

  const dirty = process.env.CLOUD_RUN_EXECUTION
    ? process.env.MUTATION_DIRTY === "true"
    : execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim()
        .length > 0;

  let exitCode = 1;
  let status = "failed";
  let counts = null;
  let failureReason: string | undefined;

  const command = [
    "exec",
    "stryker",
    "run",
    "stryker.config.mts",
    ...(selected.mode === "dry-run" ? ["--dryRunOnly"] : []),
  ];

  try {
    exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn("pnpm", command, { cwd: root, stdio: "inherit", detached: true });
      let forcedCode = 0;
      let escalation: ReturnType<typeof setTimeout> | undefined;

      const kill = (signal: NodeJS.Signals) => {
        if (child.pid) {
          try {
            process.kill(-child.pid, signal);
          } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
          }
        }
      };

      const stop = (code: number) => {
        if (forcedCode) return;
        forcedCode = code;

        kill("SIGTERM");
        escalation = setTimeout(() => kill("SIGKILL"), 5_000);
      };

      const timeout = setTimeout(() => stop(124), target.timeoutMs[selected.mode]);
      const interrupt = () => stop(130);
      const terminate = () => stop(143);
      process.once("SIGINT", interrupt);
      process.once("SIGTERM", terminate);

      const cleanup = () => {
        clearTimeout(timeout);

        if (escalation) clearTimeout(escalation);
        process.off("SIGINT", interrupt);
        process.off("SIGTERM", terminate);
      };

      child.once("error", (error) => {
        cleanup();
        reject(error);
      });
      child.once("close", (code) => {
        if (forcedCode) kill("SIGKILL");
        cleanup();
        resolve(forcedCode || code || (code === 0 ? 0 : 1));
      });
    });
    status = exitCode === 0 ? "completed" : exitCode === 124 ? "timed-out" : "failed";

    if (selected.mode === "full" && exitCode === 0) {
      counts = outcomeCounts(
        await readFile(path.join(artifactDirectory, "mutation-report.json"), "utf8")
      );
      await readFile(path.join(artifactDirectory, "mutation-report.html"));
    }
  } catch (error) {
    failureReason = error instanceof Error ? error.message : String(error);
    status = "failed";
    exitCode ||= 1;
  } finally {
    const finishedAt = new Date();
    await writeFile(
      path.join(artifactDirectory, "metadata.json"),
      JSON.stringify(
        {
          target: selected.target,
          commit,
          dirty,
          provider: process.env.CLOUD_RUN_EXECUTION ? "cloud-run" : "local",
          providerRunId: process.env.CLOUD_RUN_EXECUTION,
          mode: selected.mode,
          workers: config.concurrency,
          config: "stryker.config.mts",
          mutate: target.mutate,
          testFiles: target.testFiles,
          targetFingerprint,
          fingerprintInputs: files,
          node: process.version,
          tz: `${Intl.DateTimeFormat().resolvedOptions().timeZone} UTC${utcOffsetLabel(finishedAt)}`,
          locale: process.env.LC_ALL ?? process.env.LANG ?? null,
          thresholds: config.thresholds,
          command: ["pnpm", ...command],
          timings: {
            startedAt: startedAt.toISOString(),
            finishedAt: finishedAt.toISOString(),
            durationMs: finishedAt.getTime() - startedAt.getTime(),
          },
          status,
          exitCode,
          failureReason,
          outcomeCounts: counts,
        },
        null,
        2
      ) + "\n"
    );
  }

  process.exitCode = exitCode;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
