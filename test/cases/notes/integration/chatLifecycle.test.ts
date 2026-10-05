import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} from "../../../lib/rendererTestHarness.ts";
import { createDb } from "../../../helpers/harness/db.ts";
import type { ConversationDetail, MessageRow } from "../../../../src/contracts/chatPersistence.ts";
import type { AgentStreamChunk } from "../../../../src/services/ReasoningService.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((ok, no) => {
    resolve = ok;
    reject = no;
  });
  return { promise, resolve, reject };
}
const flush = async () => {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
};

async function mount(t: import("node:test").TestContext, { home = false, bb = false } = {}) {
  let root: ReturnType<typeof createRoot> | null = null;
  t.after(async () => {
    if (root) await act(async () => root!.unmount());
  });
  const db = createDb(t)!;
  const noteA = db.saveNote("A", "manual A", "personal").note!,
    noteB = db.saveNote("B", "manual B", "personal").note!;
  const A = db.createAgentConversation("A", noteA.id)!,
    B = db.createAgentConversation("B", noteB.id)!,
    C = db.createAgentConversation("C", noteA.id)!;
  for (const conv of [A, B, C]) db.addAgentMessage(conv.id, "user", `history ${conv.title}`, undefined);
  const reads = new Map<number, ReturnType<typeof deferred<ConversationDetail | null>>>();
  const histories = new Map<
    number,
    ReturnType<typeof deferred<ReturnType<typeof db.getConversationsForNote>>>
  >();
  const writes: Array<{ id: number; role: string; text: string }> = [];
  let write:
    | ((
        id: number,
        role: "user" | "assistant",
        text: string,
        metadata?: Record<string, unknown>
      ) => Promise<MessageRow | null>)
    | null = null;
  let createGate: ReturnType<typeof deferred<ConversationDetail | null>> | null = null;
  const streams: Array<{ gate: ReturnType<typeof deferred<void>>; partial: string }> = [];
  const requests: unknown[][] = [];
  let cancellations = 0;
  const provider = {
    cancelActiveStream() {
      cancellations++;
    },
    async *processTextStreamingAI(...args: unknown[]): AsyncGenerator<AgentStreamChunk> {
      requests.push(args);
      const planned = streams.shift();
      yield { type: "content", text: planned?.partial ?? "complete reply" };
      if (planned) {
        await planned.gate.promise;
        yield { type: "content", text: " late tail" };
      }
    },
  };
  const globals = globalThis as unknown as { __chatLifecycleProvider?: typeof provider };
  const old = globals.__chatLifecycleProvider;
  globals.__chatLifecycleProvider = provider;
  t.after(() => {
    if (old) globals.__chatLifecycleProvider = old;
    else delete globals.__chatLifecycleProvider;
  });
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getConversationsForNote: async (id: number) =>
          histories.get(id)?.promise ?? db.getConversationsForNote(id),
        getAgentConversations: async () => db.getAgentConversations(),
        getAgentConversation: async (id: number) =>
          reads.get(id)?.promise ?? db.getAgentConversation(id),
        createAgentConversation: async (title: string, noteId?: number) =>
          createGate?.promise ?? db.createAgentConversation(title, noteId),
        addAgentMessage: async (
          id: number,
          role: "user" | "assistant",
          text: string,
          metadata?: Record<string, unknown>
        ) => {
          writes.push({ id, role, text });
          return write
            ? write(id, role, text, metadata)
            : db.addAgentMessage(id, role, text, metadata);
        },
        updateAgentConversationTitle: async (id: number, title: string) =>
          db.updateAgentConversationTitle(id, title),
      },
    },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "chat-lifecycle-",
    mockModules: {
      "services/ReasoningService": "export default globalThis.__chatLifecycleProvider;",
      "react-i18next": "const t=(key)=>key;export function useTranslation(){return {t};}",
    },
  });
  const { useSettingsStore } = (await vite.ssrLoadModule(
    "/stores/settingsStore.ts"
  )) as typeof import("../../../../src/stores/settingsStore.ts");
  useSettingsStore.setState({
    chatAgentMode: bb ? "agent" : "local",
    chatAgentProvider: "ollama",
    chatAgentModel: "qwen3-0.6b",
    bbAgentPreferences: {
      order: ["codex"],
      disabled: [],
      defaultProvider: "codex",
      defaults: { codex: { model: "test-model", reasoningLevel: "low" } },
    },
  });
  const { useEmbeddedChat } = (await vite.ssrLoadModule(
    "/hooks/useEmbeddedChat.ts"
  )) as typeof import("../../../../src/hooks/useEmbeddedChat.ts");
  const { useHomeChat } = (await vite.ssrLoadModule(
    "/hooks/useHomeChat.ts"
  )) as typeof import("../../../../src/hooks/useHomeChat.ts");
  let noteId = noteA.id;
  let chat!: ReturnType<typeof useEmbeddedChat> | ReturnType<typeof useHomeChat>;
  function Harness() {
    chat = home
      ? useHomeChat([])
      : useEmbeddedChat({
          noteId,
          folderId: null,
          noteTitle: `Note ${noteId}`,
          noteContent: "manual",
        });
    return null;
  }
  root = createRoot(container as unknown as Element);
  const render = async () => {
    await act(async () => {
      root!.render(createElement(Harness));
      await flush();
    });
  };
  const unmount = async () => {
    await act(async () => root!.unmount());
    root = null;
  };
  return {
    db,
    A,
    B,
    C,
    noteA,
    noteB,
    reads,
    histories,
    writes,
    requests,
    streams,
    render,
    unmount,
    get chat() {
      return chat;
    },
    get cancellations() {
      return cancellations;
    },
    setNote: async (id: number) => {
      noteId = id;
      await render();
    },
    setWrite: (fn: typeof write) => {
      write = fn;
    },
    setCreate: (gate: typeof createGate) => {
      createGate = gate;
    },
  };
}

test("late Note A load cannot replace Note B or redirect its next saved turn", async (t) => {
  const h = await mount(t);
  const gate = deferred<ConversationDetail | null>();
  h.reads.set(h.C.id, gate);
  // A's most recent conversation is C; its detail stays pending.
  await h.render();
  await h.setNote(h.noteB.id);
  assert.equal(h.chat.activeConversationId, h.B.id);
  await act(async () => {
    gate.resolve(h.db.getAgentConversation(h.C.id));
    await flush();
  });
  assert.equal(h.chat.activeConversationId, h.B.id);
  assert.deepEqual(
    h.chat.messages.map((m) => m.content),
    ["history B"]
  );
  await act(async () => h.chat.sendMessage("question B"));
  assert.ok(h.writes.every((w) => w.id === h.B.id));
  assert.deepEqual(
    h.db.getAgentConversation(h.B.id)!.messages.map((m) => m.content),
    ["history B", "question B", "complete reply"]
  );
});

test("Home switching, New Chat and missing late details share the same invalidation", async (t) => {
  const h = await mount(t, { home: true });
  await h.render();
  const gateA = deferred<ConversationDetail | null>(),
    gateB = deferred<ConversationDetail | null>();
  h.reads.set(h.A.id, gateA);
  h.reads.set(h.B.id, gateB);
  let old!: Promise<void>, current!: Promise<void>;
  await act(async () => {
    old = h.chat.switchConversation(h.A.id);
    current = h.chat.switchConversation(h.B.id);
  });
  await act(async () => {
    gateB.resolve(h.db.getAgentConversation(h.B.id));
    await current;
  });
  await act(async () => {
    gateA.resolve(null);
    await old;
  });
  assert.equal(h.chat.activeConversationId, h.B.id);
  const gateC = deferred<ConversationDetail | null>();
  h.reads.set(h.C.id, gateC);
  await act(async () => {
    old = h.chat.switchConversation(h.C.id);
    h.chat.startNewChat();
  });
  await act(async () => {
    gateC.resolve(h.db.getAgentConversation(h.C.id));
    await old;
  });
  assert.equal(h.chat.activeConversationId, null);
  assert.deepEqual(h.chat.messages, []);
});

test("pending creation and history do not resurrect a replaced Note or New Chat", async (t) => {
  const h = await mount(t);
  const history = deferred<ReturnType<typeof h.db.getConversationsForNote>>();
  h.histories.set(h.noteA.id, history);
  await h.render();
  await act(async () => h.chat.sendMessage("first"));
  const created = h.chat.activeConversationId;
  assert.ok(created);
  await act(async () => {
    history.resolve([h.A]);
    await flush();
  });
  assert.equal(h.chat.activeConversationId, created);
  await act(async () => h.chat.startNewChat());
  const gate = deferred<ConversationDetail | null>();
  h.setCreate(gate);
  let send!: Promise<void>;
  await act(async () => {
    send = h.chat.sendMessage("pending create");
    await flush();
  });
  await h.setNote(h.noteB.id);
  await act(async () => {
    gate.resolve(h.db.getAgentConversation(h.db.createAgentConversation("late", h.noteA.id)!.id));
    await send;
  });
  assert.equal(h.chat.activeConversationId, h.B.id);
  assert.equal(h.requests.length, 1);
});

for (const bb of [false, true])
  test(`${bb ? "BB" : "Local"} completion after a switch or New Chat never saves into the new conversation`, async (t) => {
    const h = await mount(t, { bb });
    await h.render();
    const gate = deferred<void>();
    h.streams.push({ gate, partial: "partial A" });
    let send!: Promise<void>;
    await act(async () => {
      send = h.chat.sendMessage("question A");
      await flush();
    });
    assert.equal(h.requests.length, 1);
    await h.setNote(h.noteB.id);
    await act(async () => {
      gate.resolve();
      await send;
    });
    assert.deepEqual(
      h.chat.messages.map((m) => m.content),
      ["history B"]
    );
    assert.equal(h.writes.filter((w) => w.role === "assistant").length, 0);
    if (bb)
      assert.equal(
        (h.requests[0][3] as { agentConversationId: number }).agentConversationId,
        h.C.id
      );
    const second = deferred<void>();
    h.streams.push({ gate: second, partial: "partial B" });
    await act(async () => {
      send = h.chat.sendMessage("question B");
      await flush();
      h.chat.startNewChat();
    });
    await act(async () => {
      second.resolve();
      await send;
    });
    assert.deepEqual(h.chat.messages, []);
    assert.equal(h.writes.filter((w) => w.role === "assistant").length, 0);
  });

test("AI waits for the saved user row; rejected/null writes stay visible and can be retried", async (t) => {
  const h = await mount(t);
  await h.render();
  const gate = deferred<MessageRow | null>();
  h.setWrite(() => gate.promise);
  let send!: Promise<void>;
  await act(async () => {
    send = h.chat.sendMessage("held question");
    await flush();
  });
  assert.equal(h.requests.length, 0);
  assert.equal(h.writes.length, 1);
  await act(async () => {
    gate.resolve(null);
    await send;
  });
  assert.equal(h.requests.length, 0);
  assert.ok(h.chat.messages.at(-1)?.persistenceError);
  await act(async () => h.chat.sendMessage("blocked until save"));
  assert.equal(h.writes.length, 1);
  h.setWrite(null);
  await act(async () => h.chat.retrySaveMessage(h.chat.messages.at(-1)!.id));
  assert.equal(h.chat.messages.at(-1)?.persistenceError, undefined);
  h.setWrite(async () => {
    throw Error("write rejected");
  });
  await act(async () => h.chat.sendMessage("rejected"));
  assert.equal(h.requests.length, 0);
  assert.equal(h.chat.messages.at(-1)?.persistenceError, "write rejected");
});

test("deferred successful user save starts AI only after confirmation; assistant failure retains the answer for retry and reopen", async (t) => {
  const h = await mount(t);
  await h.render();
  const gate = deferred<MessageRow | null>();
  h.setWrite(async (id, role, _text) => {
    if (role === "user") return gate.promise;
    throw Error("assistant save rejected");
  });
  let send!: Promise<void>;
  await act(async () => {
    send = h.chat.sendMessage("held question");
    await flush();
  });
  assert.equal(h.requests.length, 0);
  await act(async () => {
    gate.resolve(h.db.addAgentMessage(h.C.id, "user", "held question", undefined));
    await send;
  });
  assert.equal(h.requests.length, 1);
  const reply = h.chat.messages.at(-1)!;
  assert.equal(reply.content, "complete reply");
  assert.equal(reply.persistenceError, "assistant save rejected");
  assert.equal(reply.isStreaming, false);
  h.setWrite(null);
  await act(async () => h.chat.retrySaveMessage(reply.id));
  assert.equal(h.chat.messages.at(-1)?.persistenceError, undefined);
  await act(async () => h.chat.switchConversation(h.C.id));
  assert.deepEqual(
    h.chat.messages.map((m) => m.content),
    ["history C", "held question", "complete reply"]
  );
});

test("explicit Stop drops partial persistence while unmount saves it to the original destination", async (t) => {
  const h = await mount(t);
  await h.render();
  const gate = deferred<void>();
  h.streams.push({ gate, partial: "stopped partial" });
  let send!: Promise<void>;
  await act(async () => {
    send = h.chat.sendMessage("stop");
    await flush();
    h.chat.cancelStream();
  });
  await act(async () => {
    gate.resolve();
    await send;
  });
  assert.equal(h.writes.filter((w) => w.role === "assistant").length, 0);
  const unmounted = deferred<void>();
  h.streams.push({ gate: unmounted, partial: "kept partial" });
  await act(async () => {
    send = h.chat.sendMessage("unmount");
    await flush();
  });
  await h.unmount();
  unmounted.resolve();
  await send;
  assert.deepEqual(
    h.writes.filter((w) => w.role === "assistant"),
    [{ id: h.C.id, role: "assistant", text: "kept partial" }]
  );
});

test("late cancelled chunks neither reset nor cancel a newer active stream", async t => {
  const h=await mount(t);await h.render();
  const oldGate=deferred<void>(),newGate=deferred<void>();
  h.streams.push({gate:oldGate,partial:"old reply"});let old!:Promise<void>,current!:Promise<void>;
  await act(async()=>{old=h.chat.sendMessage("old question");await flush();});
  await h.setNote(h.noteB.id);
  h.streams.push({gate:newGate,partial:"new reply"});
  await act(async()=>{current=h.chat.sendMessage("new question");await flush();});
  const before=h.cancellations;
  await act(async()=>{oldGate.resolve();await old;});
  assert.equal(h.cancellations,before);assert.equal(h.chat.agentState,"streaming");
  assert.equal(h.chat.messages.at(-1)?.content,"new reply");
  await act(async()=>{newGate.resolve();await current;});
  assert.deepEqual(h.writes.filter(w=>w.role==="assistant"),[{id:h.B.id,role:"assistant",text:"new reply late tail"}]);
});

test("switch while the user save is pending never starts the old provider request", async t => {
  const h=await mount(t);await h.render();const gate=deferred<MessageRow|null>();h.setWrite(()=>gate.promise);let send!:Promise<void>;
  await act(async()=>{send=h.chat.sendMessage("held A");await flush();});
  await h.setNote(h.noteB.id);
  await act(async()=>{gate.resolve(h.db.addAgentMessage(h.C.id,"user","held A",undefined));await send;});
  assert.equal(h.requests.length,0);assert.equal(h.chat.activeConversationId,h.B.id);
  assert.deepEqual(h.chat.messages.map(m=>m.content),["history B"]);
});

for (const bb of [false, true])
  test(`${bb ? "BB" : "Local"} never starts after a pending user write settles on an unmounted chat`, async (t) => {
    const h = await mount(t, { bb });
    await h.render();
    const gate = deferred<MessageRow | null>();
    h.setWrite(() => gate.promise);
    let send!: Promise<void>;
    await act(async () => {
      send = h.chat.sendMessage("pending before unmount");
      await flush();
    });
    assert.equal(h.requests.length, 0);
    await h.unmount();
    gate.resolve(h.db.addAgentMessage(h.C.id, "user", "pending before unmount", undefined));
    await send;
    assert.equal(h.requests.length, 0);
    assert.equal(h.db.getAgentConversation(h.C.id)?.messages.at(-1)?.content, "pending before unmount");
    assert.equal(h.writes.filter((w) => w.role === "assistant").length, 0);
  });

for (const home of [false, true]) {
  test(`${home ? "Home" : "Note"} retries failed first creation with retained scope and message`, async t => {
    const h = await mount(t, { home });
    await h.render();
    await act(async () => h.chat.startNewChat());
    const failed = deferred<ConversationDetail | null>();
    h.setCreate(failed);
    let sending!: Promise<void>;
    await act(async () => { sending = h.chat.sendMessage("retained first question"); await flush(); });
    await act(async () => { failed.reject(new Error("DB unavailable")); await sending; });
    const message = h.chat.messages[0];
    assert.ok(message.persistenceError);
    assert.equal(h.chat.activeConversationId, null);
    assert.equal(h.requests.length, 0);
    h.setCreate(null);
    const saved = deferred<MessageRow | null>();
    h.setWrite(() => saved.promise);
    let retry!: Promise<void>;
    await act(async () => { retry = h.chat.retrySaveMessage(message.id); await flush(); });
    const id = h.chat.activeConversationId!;
    assert.ok(id);
    const conv = h.db.getAgentConversation(id)!;
    assert.equal(conv.note_id, home ? null : h.noteA.id);
    assert.equal(h.writes.at(-1)?.text, message.content);
    assert.equal(h.requests.length, 0, "AI does not start before confirmation");
    await act(async () => {
      saved.resolve(h.db.addAgentMessage(id, "user", message.content, undefined));
      await retry;
      await flush();
    });
    assert.equal(h.chat.messages[0].persistenceError, undefined);
    assert.ok((home ? (h.chat as any).conversations : (h.chat as any).noteConversations).some((row: any) => row.id === id), "history includes the retried conversation");
    h.setWrite(null);
    await act(async () => h.chat.sendMessage("next question"));
    assert.equal(h.requests.length, 1);
    assert.equal(h.db.getAgentConversation(id)!.messages[0].content, message.content);
  });
}

for (const departure of ["note", "new-chat", "unmount"] as const) {
  test(`late retry creation after ${departure} cannot publish into a new chat`, async t => {
    const h = await mount(t);
    await h.render();
    await act(async () => h.chat.startNewChat());
    const failed = deferred<ConversationDetail | null>();
    h.setCreate(failed);
    let sending!: Promise<void>;
    await act(async () => { sending = h.chat.sendMessage("retained"); await flush(); });
    await act(async () => { failed.reject(new Error("DB unavailable")); await sending; });
    const retryGate = deferred<ConversationDetail | null>();
    h.setCreate(retryGate);
    let retry!: Promise<void>;
    await act(async () => { retry = h.chat.retrySaveMessage(h.chat.messages[0].id); await flush(); });
    if (departure === "note") await h.setNote(h.noteB.id);
    else if (departure === "new-chat") await act(async () => h.chat.startNewChat());
    else await h.unmount();
    await act(async () => {
      const created = h.db.createAgentConversation("late", h.noteA.id)!;
      retryGate.resolve(h.db.getAgentConversation(created.id));
      await retry;
    });
    assert.equal(h.writes.length, 0);
    assert.equal(h.requests.length, 0);
    if (departure !== "unmount") assert.equal(h.chat.activeConversationId, departure === "note" ? h.B.id : null);
  });
}
