const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const fs: typeof import("node:fs") = require("node:fs");
const os: typeof import("node:os") = require("node:os");
const path: typeof import("node:path") = require("node:path");
const { installElectronStub, setUserDataDir } = require("../../../helpers/harness/electronStub.ts") as typeof import("../../../helpers/harness/electronStub.js");
installElectronStub();
const Llama = require("../../../../src/helpers/llamaServer.ts") as typeof import("../../../../src/helpers/llamaServer.js");
const Whisper = require("../../../../src/helpers/whisperServer.ts") as typeof import("../../../../src/helpers/whisperServer.js");
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness(kind: "llama" | "whisper", gates: ReturnType<typeof deferred>[], stopGate?: ReturnType<typeof deferred>) {
  const manager = kind === "llama" ? new Llama.LlamaServerManager() : new Whisper.WhisperServerManager();
  const starts: Array<{ model: string; options: Record<string, unknown> }> = [];
  let live = 0, maxLive = 0, stops = 0;
  Object.defineProperty(manager, "stopProcess", { value: async () => {
    stops++;
    await stopGate?.promise;
    if (manager.process) live--;
    manager.process = null;
    manager.ready = false;
  } });
  Object.defineProperty(manager, "_doStart", { value: async (model: string, options: Record<string, unknown>) => {
    const index = starts.length;
    starts.push({ model, options });
    live++;
    maxLive = Math.max(live, maxLive);
    Object.defineProperty(manager, "process", { value: { model }, writable: true, configurable: true });
    manager.modelPath = model;
    await gates[index]?.promise;
    manager.ready = true;
  } });
  return { manager, starts, maxLive: () => maxLive, stops: () => stops };
}
for (const kind of ["llama", "whisper"] as const) {
  test(`${kind}: concurrent different models confirm their own readiness and keep one process`, async () => {
    const first = deferred(), second = deferred();
    const h = harness(kind, [first, second]);
    const confirmed: Array<string | null> = [];
    const a = h.manager.start("A").then(() => confirmed.push(h.manager.modelPath));
    const b = h.manager.start("B").then(() => confirmed.push(h.manager.modelPath));
    await flush();
    assert.deepEqual(h.starts.map((item) => item.model), ["A"]);
    first.resolve();
    await flush();
    assert.deepEqual(confirmed, ["A"]);
    assert.deepEqual(h.starts.map((item) => item.model), ["A", "B"]);
    second.resolve();
    await Promise.all([a, b]);
    assert.deepEqual(confirmed, ["A", "B"]);
    assert.equal(h.maxLive(), 1);
    await h.manager.stop();
  });

  test(`${kind}: identical pending requests share success and failure`, async () => {
    for (const fail of [false, true]) {
      const gate = deferred();
      const h = harness(kind, [gate]);
      const first = h.manager.start("A");
      const second = h.manager.start("A");
      const results = Promise.allSettled([first, second]);
      await flush();
      assert.equal(h.starts.length, 1);
      if (fail) gate.reject(new Error("startup failed"));
      else gate.resolve();
      assert.deepEqual((await results).map((result) => result.status), fail ? ["rejected", "rejected"] : ["fulfilled", "fulfilled"]);
      await h.manager.stop();
    }
  });

  test(`${kind}: ownership covers delayed stop and queued replacements`, async () => {
    const stop = deferred(), first = deferred(), second = deferred();
    const h = harness(kind, [first, second], stop);
    Object.defineProperty(h.manager, "process", { value: { model: "old" }, writable: true, configurable: true });
    h.manager.ready = true;
    h.manager.modelPath = "old";
    const a = h.manager.start("A");
    const b = h.manager.start("B");
    assert.ok(h.manager.startupPromise, "ownership is published before the first await");
    await flush();
    assert.equal(h.stops(), 1);
    assert.equal(h.starts.length, 0);
    stop.resolve();
    await flush();
    first.resolve();
    await a;
    await flush();
    second.resolve();
    await b;
    assert.deepEqual(h.starts.map((item) => item.model), ["A", "B"]);
    await h.manager.stop();
  });

  test(`${kind}: failed model A cannot poison queued model B`, async () => {
    const first = deferred(), second = deferred();
    const h = harness(kind, [first, second]);
    const a = h.manager.start("A");
    const rejected = assert.rejects(a, /startup failed/);
    const b = h.manager.start("B");
    await flush();
    first.reject(new Error("startup failed"));
    await rejected;
    await flush();
    assert.deepEqual(h.starts.map((item) => item.model), ["A", "B"]);
    second.resolve();
    await b;
    assert.equal(h.manager.modelPath, "B");
    assert.equal(h.maxLive(), 1);
    await h.manager.stop();
  });

  test(`${kind}: Stop invalidates queued startups and a later fresh start still works`, async () => {
    const first = deferred();
    const h = harness(kind, [first]);
    const a = h.manager.start("A"), b = h.manager.start("B");
    const results = Promise.allSettled([a, b]);
    await flush();
    const stopping = h.manager.stop();
    first.resolve();
    await stopping;
    assert.equal(h.manager.ready, false, "late readiness cannot survive Stop");
    assert.deepEqual((await results).map((result) => result.status), ["rejected", "rejected"]);
    assert.deepEqual(h.starts.map((item) => item.model), ["A"]);
    await h.manager.start("C");
    assert.equal(h.manager.modelPath, "C");
    await h.manager.stop();
  });
  test(`${kind}: a fresh request during Stop waits for the old startup to settle`, async () => {
    const first = deferred();
    const h = harness(kind, [first]);
    const original = h.manager.start("A");
    const rejected = assert.rejects(original, /interrupted by stop/);
    await flush();
    const stopping = h.manager.stop();
    const fresh = h.manager.start("C");
    await flush();
    assert.deepEqual(h.starts.map((item) => item.model), ["A"]);
    first.resolve();
    await stopping;
    await rejected;
    await fresh;
    assert.equal(h.manager.modelPath, "C");
    assert.equal(h.manager.ready, true);
    assert.deepEqual(h.starts.map((item) => item.model), ["A", "C"]);
    await h.manager.stop();
  });

}

test("llama: pending context/draft changes are distinct and options are captured", async () => {
  const first = deferred(), second = deferred();
  const h = harness("llama", [first, second]);
  const options = { contextSize: 4096, draftModelPath: "draft-A" };
  const a = h.manager.start("A", options);
  const b = h.manager.start("A", { contextSize: 8192, draftModelPath: "draft-B" });
  options.contextSize = 32768;
  first.resolve();
  await a;
  second.resolve();
  await b;
  assert.deepEqual(h.starts.map((item) => [item.options.contextSize, item.options.draftModelPath]), [[4096, "draft-A"], [8192, "draft-B"]]);
  assert.equal(h.manager.contextSize, 8192);
  await h.manager.stop();
});

test("whisper: pending VAD/thread changes retain the current wake options", async () => {
  const first = deferred(), second = deferred();
  const h = harness("whisper", [first, second]);
  const options = { threads: 2, vadEnabled: true, vadModelPath: "vad-A", vadConfig: { threshold: 0.2 } };
  const a = h.manager.start("A", options);
  const b = h.manager.start("A", { threads: 4, vadEnabled: true, vadModelPath: "vad-B", vadConfig: { threshold: 0.4 } });
  options.vadConfig.threshold = 0.9;
  first.resolve();
  await a;
  second.resolve();
  await b;
  assert.equal((h.starts[0].options.vadConfig as { threshold: number }).threshold, 0.2);
  const manager = h.manager as InstanceType<typeof Whisper.WhisperServerManager>;
  assert.equal(manager.lastStartOptions.threads, 4);
  assert.equal(manager.lastStartOptions.vadModelPath, "vad-B");
  await manager.start("A", manager.lastStartOptions);
  assert.equal(h.starts.length, 2, "wake options reuse the current server");
  await manager.stop();
});

for (const kind of ["llama", "whisper"] as const) {
  test(`${kind}: Stop during awaited port selection prevents a late spawn`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-start-stop-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    setUserDataDir(root);
    const model = path.join(root, "model");
    fs.writeFileSync(model, "fixture");
    const manager = kind === "llama" ? new Llama.LlamaServerManager() : new Whisper.WhisperServerManager();
    const port = deferred();
    Object.defineProperty(manager, "findAvailablePort", { value: async () => { await port.promise; return 8239; } });
    Object.defineProperty(manager, "getServerBinaryPaths", { value: () => ({ default: "/unused" }) });
    Object.defineProperty(manager, "getServerBinaryPath", { value: () => "/unused" });
    const starting = manager.start(model);
    const rejected = assert.rejects(starting, /interrupted by stop/);
    await flush();
    const stopping = manager.stop();
    port.resolve();
    await stopping;
    await rejected;
    assert.equal(manager.process, null);
    assert.equal(manager.ready, false);
  });
}

for (const kind of ["llama", "whisper"] as const) {
  test(`${kind}: actual child readiness and close keep concurrent A/B ownership ordered`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-server-process-"));
    setUserDataDir(root);
    const log = path.join(root, "events.jsonl");
    const script = path.join(root, "server.cjs");
    const binary = path.join(root, "server");
    const modelA = path.join(root, "A.model"), modelB = path.join(root, "B.model");
    fs.writeFileSync(modelA, "fixture-A");
    fs.writeFileSync(modelB, "fixture-B");
    fs.writeFileSync(script, `const http=require('node:http'),fs=require('node:fs');
const args=process.argv.slice(2),get=key=>args[args.indexOf(key)+1];
const model=get('--model'),port=Number(get('--port'));
const log=${JSON.stringify(log)};
const event=type=>fs.appendFileSync(log,JSON.stringify({type,model,pid:process.pid})+'\\n');
const server=http.createServer((request,response)=>{response.setHeader('Content-Type','application/json');response.end(JSON.stringify({model,default_generation_settings:{n_ctx:Number(get('--ctx-size'))||4096}}));});
server.listen(port,'127.0.0.1',()=>event('ready'));
process.on('SIGTERM',()=>server.close(()=>{event('closed');process.exit(0)}));`);
    const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
    fs.writeFileSync(binary, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`, { mode: 0o755 });
    const manager = kind === "llama" ? new Llama.LlamaServerManager() : new Whisper.WhisperServerManager();
    Object.defineProperty(manager, "getServerBinaryPaths", { value: () => ({ default: binary }) });
    Object.defineProperty(manager, "getServerBinaryPath", { value: () => binary });
    Object.defineProperty(manager, "getFFmpegPath", { value: () => null });
    try {
      const confirmed: Array<string | null> = [];
      const a = manager.start(modelA).then(() => confirmed.push(manager.modelPath));
      const sameA = manager.start(modelA);
      const b = manager.start(modelB).then(() => confirmed.push(manager.modelPath));
      await Promise.all([a, sameA, b]);
      assert.deepEqual(confirmed, [modelA, modelB]);
      const response = await fetch(`http://127.0.0.1:${manager.port}/identity`);
      assert.equal((await response.json() as { model: string }).model, modelB);
      const events = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      assert.deepEqual(events.map((event) => [event.type, event.model]), [["ready", modelA], ["closed", modelA], ["ready", modelB]]);
      assert.notEqual(events[0].pid, events[2].pid);
    } finally {
      await manager.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
    assert.equal(manager.process, null);
    assert.equal(manager.ready, false);
  });
}

test("Whisper explicit thread request cannot reuse an auto-fallback identity", async () => {
  const automatic = Whisper.resolveWhisperThreads({});
  const h = harness("whisper", []);
  await h.manager.start("A");
  const manager = h.manager as InstanceType<typeof Whisper.WhisperServerManager>;
  manager.threadSignature = "threads:default";
  await manager.start("A", { threads: automatic.threads });
  assert.equal(h.starts.length, 2, "explicit thread policy must not join/reuse an auto-fallback request");
  assert.equal((h.starts[1].options.threadResolution as { source: string }).source, "options");
  await manager.stop();
});
