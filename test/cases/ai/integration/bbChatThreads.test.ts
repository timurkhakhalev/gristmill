const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const fs: typeof import("node:fs") = require("node:fs");

const os: typeof import("node:os") = require("node:os");

const path: typeof import("node:path") = require("node:path");

const Module = require("node:module");

type Bb = typeof import("../../../../src/helpers/bbCli.ts");

type Registration = typeof import("../../../../src/helpers/bbIpcHandlers.ts");

type Handler = Parameters<Parameters<Registration["registerBbHandlers"]>[0]["handle"]>[1];

type Sender = Parameters<Handler>[0]["sender"];

type AgentSelection = import("../../../../src/contracts/bb.ts").BbSelection;

type Envelope = import("../../../../src/contracts/bb.ts").BbStreamEnvelope;

function deferred<T>() {
  let resolve!: (value: T) => void;

  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });

  return { promise, resolve };
}

async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  assert.fail("expected asynchronous operation did not complete");
}

let spawns: string[];

let tells: Array<{ id: string; prompt: string; selection?: AgentSelection }>;

let stops: string[];

let watches: Array<{ id: string; afterSeq: number }>;

let spawnGate: ReturnType<typeof deferred<string>> | null;

let watchGate: ReturnType<typeof deferred<void>> | null;

let stopGate: ReturnType<typeof deferred<void>> | null;

let historyError: Error | null;

let historyCompleted: boolean;

class BbCliError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

const bb: Pick<
  Bb,
  | "BbCliError"
  | "getBbHostPreferences"
  | "getBbThreadHistory"
  | "getBbThreadOutput"
  | "getBbThreadTitle"
  | "listBbHarnesses"
  | "listBbModels"
  | "spawnBbThread"
  | "stopBbThread"
  | "tellBbThread"
  | "watchBbThread"
> = {
  BbCliError,
  async getBbHostPreferences() {
    return { providerOrder: [], defaultProviderId: null };
  },
  async listBbHarnesses() {
    return [];
  },
  async listBbModels() {
    return [];
  },
  async getBbThreadTitle() {
    return "Meeting discussion";
  },
  async getBbThreadOutput() {
    return "Answer";
  },
  async getBbThreadHistory() {
    if (historyError) throw historyError;

    return { sequence: 10, completed: historyCompleted, failed: false };
  },
  async spawnBbThread(prompt) {
    spawns.push(prompt);

    return spawnGate ? spawnGate.promise : `thr_${spawns.length}`;
  },
  async tellBbThread(id, prompt, _signal, selection) {
    tells.push({ id, prompt, selection });
  },
  async stopBbThread(id) {
    stops.push(id);
    await stopGate?.promise;
  },
  async *watchBbThread(id, signal, afterSeq = 0) {
    watches.push({ id, afterSeq });

    if (watchGate && !signal?.aborted) {
      let onAbort!: () => void;

      const cancelled = new Promise<void>((resolve) => {
        onAbort = resolve;
      });

      signal?.addEventListener("abort", onAbort, { once: true });

      try {
        await Promise.race([watchGate.promise, cancelled]);
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    }

    if (signal?.aborted) return;
    historyCompleted = true;
    yield "New answer";
  },
};

const originalLoad = Module._load;

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "./bbCli.js") return bb;

  return originalLoad.call(this, request, parent, isMain);
};

const { registerBbHandlers }: Registration = require("../../../../src/helpers/bbIpcHandlers.ts");

Module._load = originalLoad;

const selection: AgentSelection = {
  provider: "codex",
  model: "first-model",
  reasoningLevel: "low",
};

function setup(t: import("node:test").TestContext) {
  spawns = [];
  tells = [];
  stops = [];
  watches = [];
  spawnGate = null;
  watchGate = null;
  stopGate = null;
  historyError = null;
  historyCompleted = true;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-bb-chat-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bindings = new Map<number, { thread_id: string; provider: string }>();

  const database: Parameters<Registration["registerBbHandlers"]>[2] = {
    getAgentConversation(id) {
      return {
        id: Number(id),
        title: "Chat",
        note_id: null,
        space_id: null,
        folder_id: null,
        archived_at: null,
        created_at: "",
        updated_at: "",
        messages: [],
      };
    },
    getAgentBbThread(id) {
      return bindings.get(id) ?? null;
    },
    saveAgentBbThread(id, threadId, provider) {
      bindings.set(id, { thread_id: threadId, provider });
    },
  };

  const events: Array<Envelope & { sender: number }> = [];
  const senders = new Map<number, Sender>();
  const destroyed = new Map<number, () => void>();

  function sender(id: number) {
    let value = senders.get(id);

    if (!value) {
      value = {
        id,
        isDestroyed: () => false,
        send: (_channel: string, payload: unknown) => {
          events.push({ ...(payload as Envelope), sender: id });
        },
        once: (_event: string, callback: () => void) => {
          destroyed.set(id, callback);
        },
      };
      senders.set(id, value);
    }

    return value;
  }

  let handlers = new Map<
    string,
    (event: { sender: ReturnType<typeof sender> }, ...args: unknown[]) => unknown
  >();

  function register() {
    handlers = new Map();
    registerBbHandlers(
      { handle: (channel, callback) => handlers.set(channel, callback) },
      directory,
      database
    );
  }

  register();

  function start(
    conversationId: number,
    prompt: string,
    providerSelection = selection,
    senderId = 1
  ) {
    const streamId = crypto.randomUUID();

    const result = handlers.get("bb-stream-start")!(
      { sender: sender(senderId) },
      {
        streamId,
        conversationId,
        prompt,
        initialPrompt: `History and ${prompt}`,
        selection: providerSelection,
      }
    );

    return { streamId, result };
  }

  const cancel = (streamId: string, senderId = 1) =>
    handlers.get("bb-stream-cancel")!({ sender: sender(senderId) }, streamId);

  const finished = (streamId: string) =>
    events.some((event) => event.streamId === streamId && (event.done || event.error));

  return { start, cancel, finished, bindings, database, events, register, destroyed };
}

test("messages and reopened chats reuse one BB thread; new chats use another", async (t) => {
  const context = setup(t);
  const first = context.start(1, "First");
  await until(() => context.finished(first.streamId));
  assert.deepEqual(context.bindings.get(1), { thread_id: "thr_1", provider: "codex" });
  context.register();
  const changed = { ...selection, model: "second-model", reasoningLevel: "high" };
  const second = context.start(1, "Second", changed);
  await until(() => context.finished(second.streamId));
  assert.deepEqual(spawns, ["History and First"]);
  assert.deepEqual(tells, [{ id: "thr_1", prompt: "Second", selection: changed }]);
  assert.deepEqual(watches, [
    { id: "thr_1", afterSeq: 0 },
    { id: "thr_1", afterSeq: 10 },
  ]);
  assert.deepEqual(
    context.events
      .filter((event) => event.streamId === second.streamId && event.text)
      .map((event) => event.text),
    ["New answer"]
  );
  const third = context.start(2, "Separate");
  await until(() => context.finished(third.streamId));
  assert.equal(context.bindings.get(2)?.thread_id, "thr_2");
});

test("two windows serialize turns; cancelling a queued turn cannot stop the active turn", async (t) => {
  const context = setup(t);
  watchGate = deferred<void>();
  const first = context.start(1, "First");
  await until(() => watches.length === 1);
  const cancelled = context.start(1, "Cancelled", selection, 2);
  const next = context.start(1, "Next", selection, 2);
  await context.cancel(first.streamId, 2);
  await context.cancel(cancelled.streamId, 2);
  assert.equal(tells.length, 0);
  assert.deepEqual(stops, []);
  const gate = watchGate;
  watchGate = null;
  gate.resolve();
  await until(() => context.finished(next.streamId));
  assert.deepEqual(
    tells.map((tell) => tell.prompt),
    ["Next"]
  );
  assert.equal(spawns.length, 1);
});

test("cancel during spawn saves the accepted ID and waits for Stop before continuing", async (t) => {
  const context = setup(t);
  spawnGate = deferred<string>();
  stopGate = deferred<void>();
  const first = context.start(1, "First");
  await until(() => spawns.length === 1);
  await context.cancel(first.streamId);
  const next = context.start(1, "Next");
  spawnGate.resolve("thr_accepted");
  await until(() => stops.length === 1);
  assert.equal(context.bindings.get(1)?.thread_id, "thr_accepted");
  assert.equal(tells.length, 0);
  stopGate.resolve();
  await until(() => context.finished(next.streamId));
  assert.equal(spawns.length, 1);
  assert.equal(tells[0]?.id, "thr_accepted");
  assert.equal(context.finished(first.streamId), false);
});

test("a running persisted turn settles before tell; old deltas are not emitted", async (t) => {
  const context = setup(t);
  context.bindings.set(1, { thread_id: "thr_existing", provider: selection.provider });
  historyCompleted = false;
  watchGate = deferred<void>();
  const next = context.start(1, "Next");
  await until(() => watches.length === 1);
  assert.equal(tells.length, 0);
  const gate = watchGate;
  watchGate = null;
  gate.resolve();
  await until(() => context.finished(next.streamId));
  assert.equal(
    context.events.filter((event) => event.streamId === next.streamId && event.text).length,
    1
  );
  assert.equal(tells[0]?.id, "thr_existing");
});

test("missing threads and harness changes report errors without replacing the saved thread", async (t) => {
  const context = setup(t);
  context.bindings.set(1, { thread_id: "thr_existing", provider: selection.provider });
  historyError = new Error("thread missing");
  const missing = context.start(1, "Next");
  await until(() => context.finished(missing.streamId));
  assert.match(
    context.events.find((event) => event.streamId === missing.streamId)?.error ?? "",
    /thread missing/
  );
  historyError = null;
  const changed = context.start(1, "Next", { ...selection, provider: "opencode" });
  await until(() => context.finished(changed.streamId));
  assert.match(
    context.events.find((event) => event.streamId === changed.streamId)?.error ?? "",
    /new Chat/
  );
  assert.equal(spawns.length, 0);
  assert.equal(tells.length, 0);
  assert.equal(context.bindings.get(1)?.thread_id, "thr_existing");
});

test("closing a window stops its turn and preserves the thread for another window", async (t) => {
  const context = setup(t);
  watchGate = deferred<void>();
  const first = context.start(1, "First");
  await until(() => watches.length === 1);
  const next = context.start(1, "Next", selection, 2);
  watchGate = null;
  context.destroyed.get(1)!();
  await until(() => context.finished(next.streamId));
  assert.deepEqual(stops, ["thr_1"]);
  assert.equal(context.finished(first.streamId), false);
  assert.equal(spawns.length, 1);
  assert.equal(tells[0]?.id, "thr_1");
});

test("failure to save the binding stops the orphan and reports the error", async (t) => {
  const context = setup(t);
  context.database.saveAgentBbThread = () => {
    throw new Error("save failed");
  };

  const first = context.start(1, "First");
  await until(() => context.finished(first.streamId));
  assert.deepEqual(stops, ["thr_1"]);
  assert.equal(context.bindings.size, 0);
  assert.match(
    context.events.find((event) => event.streamId === first.streamId)?.error ?? "",
    /save failed/
  );
});
