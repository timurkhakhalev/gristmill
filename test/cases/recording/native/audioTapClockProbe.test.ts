const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const fs: typeof import("node:fs") = require("node:fs");

const path: typeof import("node:path") = require("node:path");

const { randomUUID } = require("node:crypto");

const { spawn }: typeof import("node:child_process") = require("node:child_process");

test("native audio tap answers bounded clock probes while stdout remains PCM", async (t) => {
  if (process.platform !== "darwin") {
    t.skip("requires the macOS system-audio tap and its live host clock");

    return;
  }

  const binaryPath = path.resolve(__dirname, "../../../../resources/bin/macos-audio-tap");
  assert.ok(fs.existsSync(binaryPath), "compile the macOS audio tap before native verification");

  const child = spawn(binaryPath, ["--sample-rate", "24000", "--chunk-ms", "100"], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const forceKill = setTimeout(() => child.kill("SIGKILL"), 1_000);
      child.once("close", () => {
        clearTimeout(forceKill);
        resolve();
      });
    });
  });

  const messages: Array<Record<string, unknown>> = [];

  const waiters: Array<{
    predicate: (message: Record<string, unknown>) => boolean;
    resolve(message: Record<string, unknown>): void;
    reject(error: Error): void;
    timeout: ReturnType<typeof setTimeout>;
  }> = [];

  let stderrBuffer = "";
  let malformedMetadata = false;
  let stdoutBytes = 0;

  const waitForMessage = (predicate: (message: Record<string, unknown>) => boolean) => {
    const found = messages.find(predicate);

    if (found) return Promise.resolve(found);

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        timeout: setTimeout(() => {
          const index = waiters.indexOf(waiter);

          if (index >= 0) waiters.splice(index, 1);
          reject(new Error("Native audio helper metadata timed out"));
        }, 5_000),
      };

      waiters.push(waiter);
    });
  };

  child.stderr.on("data", (chunk: Buffer) => {
    stderrBuffer += chunk.toString("utf8");

    while (true) {
      const newline = stderrBuffer.indexOf("\n");

      if (newline < 0) break;
      const line = stderrBuffer.slice(0, newline);
      stderrBuffer = stderrBuffer.slice(newline + 1);

      if (!line) continue;

      try {
        const message = JSON.parse(line) as Record<string, unknown>;

        if (message.type === "stop") continue;
        messages.push(message);

        for (let index = waiters.length - 1; index >= 0; index -= 1) {
          const waiter = waiters[index];

          if (!waiter.predicate(message)) continue;
          waiters.splice(index, 1);
          clearTimeout(waiter.timeout);
          waiter.resolve(message);
        }
      } catch {
        malformedMetadata = true;
      }
    }
  });
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.length;
  });
  child.once("error", (error) => {
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
  });

  const start = await waitForMessage((message) => message.type === "start");
  assert.match(String(start.generation ?? ""), /^[0-9a-f-]{36}$/i);
  assert.match(String(start.monotonicOriginNs ?? ""), /^\d{1,20}$/);
  assert.equal(start.sampleRate, 24_000);
  assert.equal(start.channels, 1);

  const nonce = randomUUID();
  child.stdin.write(`${JSON.stringify({ type: "probe", nonce })}\n`);

  const reply = await waitForMessage(
    (message) => message.type === "probe" && message.nonce === nonce
  );

  assert.match(String(reply.helperReceiveNs ?? ""), /^\d{1,20}$/);
  assert.match(String(reply.helperSendNs ?? ""), /^\d{1,20}$/);
  assert.equal(reply.helperGeneration, start.generation);
  assert.ok(Number.isSafeInteger(reply.helperFrame) && Number(reply.helperFrame) >= 0);

  const bytesBeforeEof = stdoutBytes;
  child.stdin.end();
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("PCM did not continue after probe stdin EOF")),
      2_000
    );

    const onData = () => {
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      resolve();
    };

    if (stdoutBytes > bytesBeforeEof) {
      clearTimeout(timeout);
      resolve();

      return;
    }

    child.stdout.on("data", onData);
  });
  assert.equal(child.exitCode, null, "stdin EOF must end probe input without stopping capture");
  assert.equal(malformedMetadata, false);
  assert.ok(
    stdoutBytes > bytesBeforeEof,
    "PCM stdout should continue independently of probe metadata"
  );
  assert.equal(stdoutBytes % 2, 0, "PCM remains 16-bit mono");
});
