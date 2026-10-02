import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { createRendererServer, installBrowserGlobals, installHookDom } from "../../../lib/rendererTestHarness.ts";
import type { useMeetingPlayback } from "../../../../src/hooks/useMeetingPlayback.ts";

type Playback = ReturnType<typeof useMeetingPlayback>;
type PathResult = Awaited<ReturnType<typeof window.electronAPI.meetingRecordingGetPlaybackPath>>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
type AudioListenerArgs = Parameters<EventTarget["addEventListener"]>;
class FakeAudio extends EventTarget {
  src = "";
  currentTime = 0;
  duration = 120;
  readyState = 0;
  paused = true;
  autoMetadata = true;
  playError = false;
  plays = 0;
  pauses = 0;
  listeners = new Map<string, Set<NonNullable<AudioListenerArgs[1]>>>();
  addEventListener(type: string, listener: AudioListenerArgs[1], options?: AudioListenerArgs[2]) {
    super.addEventListener(type, listener, options);
    if (listener) { const set = this.listeners.get(type) ?? new Set(); set.add(listener); this.listeners.set(type, set); }
  }
  removeEventListener(type: string, listener: AudioListenerArgs[1], options?: AudioListenerArgs[2]) {
    super.removeEventListener(type, listener, options);
    if (listener) this.listeners.get(type)?.delete(listener);
  }
  load() {
    this.readyState = 0;
    if (this.src && this.autoMetadata) queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event("loadedmetadata")); });
  }
  async play() {
    if (this.playError) throw new Error("play failed");
    this.plays++;
    this.paused = false;
    this.dispatchEvent(new Event("play"));
  }
  pause() { this.pauses++; this.paused = true; this.dispatchEvent(new Event("pause")); }
  removeAttribute(name: string) { if (name === "src") this.src = ""; }
  listenerCount() { return [...this.listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0); }
}

async function setup(t: TestContext, preview = false) {
  let root: Root | undefined;
  let unmounted = false;
  const unmount = async () => { if (root && !unmounted) { unmounted = true; await React.act(async () => root!.unmount()); } };
  t.after(unmount);
  const audio = new FakeAudio();
  const releases: string[] = [];
  const requests: string[] = [];
  const errors: Array<string | undefined> = [];
  let acquire = async (id: string): Promise<PathResult> => ({ success: true, path: `/tmp/${id}.wav`, leaseId: `lease-${id}` });
  installBrowserGlobals(t, { window: { electronAPI: {
    meetingRecordingGetPlaybackPath: (id: string) => { requests.push(id); return acquire(id); },
    meetingRecordingReleasePlayback: async (id: string) => { releases.push(id); return { success: true }; },
  } } });
  const container = installHookDom(t);
  const mediaDescriptor = Object.getOwnPropertyDescriptor(globalThis, "HTMLMediaElement");
  Object.defineProperty(globalThis, "HTMLMediaElement", { value: { HAVE_METADATA: 1 }, configurable: true });
  t.after(() => { if (mediaDescriptor) Object.defineProperty(globalThis, "HTMLMediaElement", mediaDescriptor); else delete (globalThis as Record<string, unknown>).HTMLMediaElement; });
  const vite = await createRendererServer(t);
  const module = await vite.ssrLoadModule("/hooks/useMeetingPlayback.ts");
  const usePlayback: typeof useMeetingPlayback = module.useMeetingPlayback;
  let current!: Playback;
  let noteId = 1;
  const Harness = () => {
    current = usePlayback({ noteId, recordings: ["one", "two"].map(id => ({ recording: { id, durationSeconds: 120, audioState: "available" } })), preview, onError: message => errors.push(message) });
    current.audioRef.current = audio as unknown as HTMLAudioElement;
    return null;
  };
  root = createRoot(container as unknown as HTMLElement);
  await React.act(async () => { root!.render(React.createElement(Harness)); });
  return { audio, releases, requests, errors, get playback() { return current; }, unmount,
    acquire: (fn: typeof acquire) => { acquire = fn; },
    changeNote: async () => { noteId++; await React.act(async () => { root!.render(React.createElement(Harness)); }); } };
}

test("play/seek/pause and switching recordings release the old lease; ended releases the current lease", async (t) => {
  const h = await setup(t);
  await React.act(async () => { await h.playback.startAudio("one", 30); });
  assert.equal(h.playback.playingId, "one");
  assert.equal(h.playback.isPlaying, true);
  assert.equal(h.audio.currentTime, 30);
  await React.act(async () => { h.playback.seekTo(200); });
  assert.equal(h.audio.currentTime, 120);
  await React.act(async () => { h.playback.skip(-15); });
  assert.equal(h.audio.currentTime, 105);
  await React.act(async () => { h.playback.togglePlay(); });
  assert.equal(h.playback.isPlaying, false);
  await React.act(async () => { h.playback.togglePlay(); });
  assert.equal(h.playback.isPlaying, true);
  await React.act(async () => { await h.playback.startAudio("two", 10); });
  assert.equal(h.playback.playingId, "two");
  assert.deepEqual(h.releases, ["lease-one"]);
  assert.equal(h.audio.listeners.get("loadedmetadata")?.size, 1);
  assert.equal(h.audio.listeners.get("error")?.size, 1);
  await React.act(async () => { h.audio.dispatchEvent(new Event("ended")); });
  assert.deepEqual(h.releases, ["lease-one", "lease-two"]);
  assert.equal(h.playback.playingId, null);
  await h.unmount();
  assert.equal(h.audio.listenerCount(), 0);
});

for (const terminal of ["note-change", "unmount"] as const) test(`${terminal} releases a late response and cancels metadata listeners`, async (t) => {
  const h = await setup(t);
  const late = deferred<PathResult>();
  h.acquire(() => late.promise);
  let pending!: Promise<void>;
  await React.act(async () => { pending = h.playback.startAudio("one"); });
  if (terminal === "note-change") await h.changeNote();
  else { h.playback.audioRef.current = null; await h.unmount(); }
  await React.act(async () => { late.resolve({ success: true, path: "/tmp/late.wav", leaseId: "late" }); await pending; });
  assert.deepEqual(h.releases, ["late"]);
  assert.equal(h.audio.plays, 0);
  if (terminal === "unmount") assert.equal(h.audio.listenerCount(), 0);
  else {
    h.audio.autoMetadata = false;
    h.acquire(async () => ({ success: true, path: "/tmp/wait.wav", leaseId: "waiting" }));
    await React.act(async () => { pending = h.playback.startAudio("two"); });
    assert.equal(h.audio.listeners.get("loadedmetadata")?.size, 2);
    h.playback.audioRef.current = null;
    await h.unmount();
    await pending;
    assert.deepEqual(h.releases, ["late", "waiting"]);
    assert.equal(h.audio.listenerCount(), 0);
    assert.equal(h.audio.src, "");
    assert.ok(h.audio.pauses > 0);
  }
});

test("a newer request wins and a late response cannot release its lease", async (t) => {
  const h = await setup(t);
  const old = deferred<PathResult>();
  h.acquire(id => id === "one" ? old.promise : Promise.resolve({ success: true, path: "/tmp/two.wav", leaseId: "new" }));
  let pending!: Promise<void>;
  await React.act(async () => { pending = h.playback.startAudio("one"); await h.playback.startAudio("two"); });
  await React.act(async () => { old.resolve({ success: true, path: "/tmp/one.wav", leaseId: "old" }); await pending; });
  assert.equal(h.playback.playingId, "two");
  assert.deepEqual(h.releases, ["old"]);
  await React.act(async () => { h.audio.dispatchEvent(new Event("error")); });
  assert.deepEqual(h.releases, ["old", "new"]);
  assert.equal(h.playback.isPlaying, false);
});

test("switching during metadata loading releases the old lease even when the new request fails", async (t) => {
  const h = await setup(t);
  h.audio.autoMetadata = false;
  h.acquire(async id => id === "one"
    ? { success: true, path: "/tmp/one.wav", leaseId: "waiting" }
    : { success: false, error: "unavailable" });
  let pending!: Promise<void>;
  await React.act(async () => { pending = h.playback.startAudio("one"); });
  assert.equal(h.audio.listeners.get("loadedmetadata")?.size, 2);
  await React.act(async () => { await h.playback.startAudio("two"); await pending; });
  assert.deepEqual(h.releases, ["waiting"]);
  assert.deepEqual(h.errors, ["unavailable"]);
  assert.equal(h.audio.src, "");
  assert.equal(h.audio.plays, 0);
  assert.equal(h.audio.listeners.get("loadedmetadata")?.size, 1);
  assert.equal(h.audio.listeners.get("error")?.size, 1);
  await h.unmount();
  assert.equal(h.audio.listenerCount(), 0);
  assert.deepEqual(h.releases, ["waiting"]);
});

test("failed play releases its lease", async (t) => {
  const h = await setup(t);
  h.audio.playError = true;
  await React.act(async () => { await h.playback.startAudio("one"); });
  assert.deepEqual(h.releases, ["lease-one"]);
  assert.equal(h.errors.length, 1);
  assert.equal(h.playback.playingId, null);
});

test("preview never acquires persistent audio", async (t) => {
  const preview = await setup(t, true);
  await React.act(async () => { await preview.playback.startAudio("one", 25); });
  assert.equal(preview.playback.playbackTime, 25);
  assert.equal(preview.playback.playingId, "one");
  assert.deepEqual(preview.requests, []);
  assert.deepEqual(preview.releases, []);
});
