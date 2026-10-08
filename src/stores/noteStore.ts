import { create } from "zustand";
import {
  invalidateKeyedLoadGenerations,
  removeNoteFromLists,
  teardownNoteContainers,
} from "./noteListOps";
import { z } from "zod";
import { findDefaultFolder } from "../components/notes/shared";
import type { FolderItem, FolderStyle } from "../contracts/containers";
import type { PendingNoteUpdates } from "../lib/noteEditorPendingSave";
import type { NoteItem } from "../contracts/notes";
import logger from "../utils/logger";

export interface ActiveContext {
  folderId: number | null;
}

interface EditorSave {
  updates: PendingNoteUpdates;
  saving: boolean;
  error: string | null;
}

interface NoteState {
  editorSaves: Record<number, EditorSave>;
  notes: NoteItem[];
  folders: FolderItem[];
  folderCounts: Record<number, number>;
  rootNoteCount: number;
  notesByContainer: Record<string, NoteItem[]>;
  expandedContainers: Set<string>;
  activeContext: ActiveContext | null;
  activeNoteId: number | null;
  // The opened Note's full row, held independently of the container caches
  // (which only carry the newest 50 per container): search and chat can open
  // older rows, and the editor needs the row, not just the id (#185).
  selectedNote: NoteItem | null;
  isTreeLoading: boolean;
  // Bumped on every confirmed Note event (added/updated/deleted), whether or
  // not the row was cached. Consumers that read the authoritative list from
  // main (Home's recent list) react to this instead of the cache
  // identity, which does not change when a note is deleted from an unloaded
  // container.
  noteEventsRevision: number;
}

const EXPANDED_STORAGE_KEY = "notesTree.expanded";

const expandedKeysSchema = z.array(z.string());

function readExpandedContainers(): Set<string> {
  try {
    const raw = localStorage.getItem(EXPANDED_STORAGE_KEY);
    const parsed = expandedKeysSchema.safeParse(raw ? JSON.parse(raw) : []);

    return new Set(parsed.success ? parsed.data : []);
  } catch {
    return new Set();
  }
}

function persistExpandedContainers(expanded: Set<string>): void {
  try {
    localStorage.setItem(EXPANDED_STORAGE_KEY, JSON.stringify([...expanded]));
  } catch {
    // localStorage unavailable — expansion just won't persist
  }
}

const useNoteStore = create<NoteState>()(() => ({
  editorSaves: {},
  notes: [],
  folders: [],
  folderCounts: {},
  rootNoteCount: 0,
  notesByContainer: {},
  expandedContainers: readExpandedContainers(),
  activeContext: null,
  activeNoteId: null,
  selectedNote: null,
  isTreeLoading: true,
  noteEventsRevision: 0,
}));

const PENDING_NOTE_FIELDS = [
  "title",
  "content",
  "enhanced_content",
] as const satisfies readonly (keyof PendingNoteUpdates)[];

// Fire-and-forget refreshes: a failed background load is logged, not dropped.
export function runInBackground(load: Promise<unknown>, label: string): void {
  load.catch((error) =>
    logger.error(label, { error: error instanceof Error ? error.message : String(error) }, "notes")
  );
}

// Keep unsaved fields outside the mounted editor. Navigation cannot discard
// the only copy of a failed write, and each Note has one in-flight writer.
export function retainNoteEditorUpdates(noteId: number, updates: PendingNoteUpdates): void {
  useNoteStore.setState((state) => ({
    editorSaves: {
      ...state.editorSaves,
      [noteId]: {
        updates: { ...state.editorSaves[noteId]?.updates, ...updates },
        saving: state.editorSaves[noteId]?.saving ?? false,
        error: state.editorSaves[noteId]?.error ?? null,
      },
    },
  }));
}

export function useNoteEditorSave(noteId: number | null): EditorSave | undefined {
  return useNoteStore((state) => (noteId == null ? undefined : state.editorSaves[noteId]));
}

export function getNoteEditorUpdates(noteId: number): PendingNoteUpdates {
  return useNoteStore.getState().editorSaves[noteId]?.updates ?? {};
}

export async function flushNoteEditorWrites(noteId: number): Promise<void> {
  const entry = useNoteStore.getState().editorSaves[noteId];

  if (!entry || entry.saving) return;
  useNoteStore.setState((state) => ({
    editorSaves: { ...state.editorSaves, [noteId]: { ...entry, saving: true, error: null } },
  }));

  try {
    while (true) {
      const current = useNoteStore.getState().editorSaves[noteId];

      if (!current) return; // The Note was deleted.
      const snapshot = current.updates;
      const result = await window.electronAPI.updateNote(noteId, snapshot);

      if (!result?.success) throw new Error(result?.error || "Note was not saved");

      if (!result.note) throw new Error("Note was not saved");
      const latest = useNoteStore.getState().editorSaves[noteId];

      if (!latest) return;
      const remaining = { ...latest.updates };

      for (const field of PENDING_NOTE_FIELDS) {
        if (field in snapshot && remaining[field] === snapshot[field]) delete remaining[field];
      }

      updateNoteInStore(result.note);

      if (Object.keys(remaining).length === 0) {
        useNoteStore.setState((state) => {
          const editorSaves = { ...state.editorSaves };
          delete editorSaves[noteId];

          return { editorSaves };
        });

        return;
      }

      useNoteStore.setState((state) => ({
        editorSaves: {
          ...state.editorSaves,
          [noteId]: { updates: remaining, saving: true, error: null },
        },
      }));
    }
  } catch (error) {
    useNoteStore.setState((state) => {
      const latest = state.editorSaves[noteId];

      return latest
        ? {
            editorSaves: {
              ...state.editorSaves,
              [noteId]: {
                ...latest,
                saving: false,
                error: error instanceof Error ? error.message : String(error),
              },
            },
          }
        : {};
    });
  }
}

/** Signal that a confirmed Note event arrived, regardless of cache presence. */
function bumpNoteEventsRevision(): void {
  useNoteStore.setState((state) => ({ noteEventsRevision: state.noteEventsRevision + 1 }));
}

let hasBoundIpcListeners = false;

const DEFAULT_LIMIT = 50;

let currentLimit = DEFAULT_LIMIT;

let loadGeneration = 0;

let treeLoadGeneration = 0;

let foldersLoadGeneration = 0;

// Folder navigation requested before folders load; consumed once by initializeNotesTree.
let pendingFolderPreset: number | null = null;

export function folderContainerKey(folderId: number): string {
  return `f:${folderId}`;
}

export const ROOT_CONTAINER_KEY = "root";

export function contextContainerKey(context: ActiveContext): string {
  return context.folderId != null ? folderContainerKey(context.folderId) : ROOT_CONTAINER_KEY;
}

/** Every tree container listing the note: each of its folders, or Notes root. */
function noteContainerKeys(note: NoteItem): string[] {
  return note.folder_ids.length ? note.folder_ids.map(folderContainerKey) : [ROOT_CONTAINER_KEY];
}

const sameContainers = (a: NoteItem, b: NoteItem) =>
  noteContainerKeys(a).sort().join() === noteContainerKeys(b).sort().join();

function findNoteInState(state: NoteState, id: number): NoteItem | null {
  if (state.selectedNote?.id === id) return state.selectedNote;

  for (const items of Object.values(state.notesByContainer)) {
    const note = items.find((n) => n.id === id);

    if (note) return note;
  }

  return state.notes.find((n) => n.id === id) ?? null;
}

/** Apply a notesByContainer replacement, mirroring the active container into the flat `notes` list. */
function applyContainers(
  notesByContainer: Record<string, NoteItem[]>,
  extra: Partial<NoteState> = {}
): void {
  const state = useNoteStore.getState();
  const context = state.activeContext;
  const activeKey = context ? contextContainerKey(context) : null;
  const update: Partial<NoteState> = { notesByContainer, ...extra };

  if (activeKey && notesByContainer[activeKey] && notesByContainer[activeKey] !== state.notes) {
    update.notes = notesByContainer[activeKey];
  }

  useNoteStore.setState(update);
}

function ensureIpcListeners() {
  if (hasBoundIpcListeners || typeof window === "undefined") {
    return;
  }

  const disposers: Array<() => void> = [];

  if (window.electronAPI.onNoteAdded) {
    const dispose = window.electronAPI.onNoteAdded((note) => {
      if (note) {
        addNote(note);
        bumpNoteEventsRevision();
        runInBackground(loadFolders(), "Note folders refresh failed");
      }
    });

    if (dispose) {
      disposers.push(dispose);
    }
  }

  if (window.electronAPI.onNoteUpdated) {
    const dispose = window.electronAPI.onNoteUpdated((note) => {
      if (note) {
        const previous = findNoteInState(useNoteStore.getState(), note.id);
        updateNoteInStore(note);
        bumpNoteEventsRevision();

        if (previous && !sameContainers(previous, note)) {
          runInBackground(loadFolders(), "Note folders refresh failed");
        }
      }
    });

    if (dispose) {
      disposers.push(dispose);
    }
  }

  if (window.electronAPI.onNoteDeleted) {
    const dispose = window.electronAPI.onNoteDeleted(({ id }) => {
      removeNote(id);
      // Always signal: a note deleted from an unloaded container is not in
      // `lists`, so removeNote no-ops, but the authoritative list still changed.
      bumpNoteEventsRevision();
      runInBackground(loadFolders(), "Note folders refresh failed");
    });

    if (dispose) {
      disposers.push(dispose);
    }
  }

  // Folder hard-deletes drop the container and refresh local counts.
  if (window.electronAPI.onFolderDeleted) {
    const dispose = window.electronAPI.onFolderDeleted(({ id }) => {
      if (id == null) return;
      const state = useNoteStore.getState();
      const key = folderContainerKey(id);
      const teardown = teardownNoteContainers(state, [key]);
      persistExpandedContainers(teardown.expandedContainers);

      const extra: Partial<NoteState> = {
        expandedContainers: teardown.expandedContainers,
        activeNoteId: teardown.activeNoteId,
      };

      let fallbackContext: ActiveContext | null = null;

      if (state.activeContext?.folderId === id) {
        fallbackContext = { folderId: null };
        extra.activeContext = fallbackContext;
        extra.notes = teardown.notesByContainer[contextContainerKey(fallbackContext)] ?? [];
      }

      useNoteStore.setState({ notesByContainer: teardown.notesByContainer, ...extra });
      runInBackground(loadContainerNotes(ROOT_CONTAINER_KEY), "Note container load failed");

      runInBackground(loadFolders(), "Note folders refresh failed");
    });

    if (dispose) {
      disposers.push(dispose);
    }
  }

  hasBoundIpcListeners = true;

  window.addEventListener("beforeunload", () => {
    disposers.forEach((dispose) => dispose());
  });
}

export async function loadFolders(): Promise<FolderItem[]> {
  const gen = ++foldersLoadGeneration;

  const [items, counts] = await Promise.all([
    window.electronAPI.getFolders(),
    window.electronAPI.getFolderNoteCounts(),
  ]);

  if (gen !== foldersLoadGeneration) return items;
  const folderCounts: Record<number, number> = {};
  let rootNoteCount = 0;
  counts.forEach((c) => {
    if (c.folder_id != null) folderCounts[c.folder_id] = c.count;
    else rootNoteCount = c.count;
  });
  useNoteStore.setState({ folders: items, folderCounts, rootNoteCount });

  return items;
}

const containerLoadGenerations = new Map<string, number>();

const containerLoadsInFlight = new Map<string, Promise<NoteItem[]>>();

/**
 * Synchronously remove account-scoped renderer state and invalidate every
 * async load that could otherwise repopulate it after the database purge.
 * IPC listeners stay bound; the next mounted notes view reloads clean state.
 */
export function resetForAccountChange(): void {
  currentLimit = DEFAULT_LIMIT;
  loadGeneration += 1;
  treeLoadGeneration += 1;
  foldersLoadGeneration += 1;
  pendingFolderPreset = null;

  invalidateKeyedLoadGenerations(containerLoadGenerations);
  containerLoadsInFlight.clear();

  try {
    localStorage.removeItem(EXPANDED_STORAGE_KEY);
  } catch {
    // In-memory state is still cleared below.
  }

  useNoteStore.setState({
    notes: [],
    folders: [],
    folderCounts: {},
    rootNoteCount: 0,
    notesByContainer: {},
    expandedContainers: new Set(),
    activeContext: null,
    activeNoteId: null,
    selectedNote: null,
    isTreeLoading: true,
  });
}

export async function loadContainerNotes(
  key: string,
  noteType: string | null = null,
  limit = DEFAULT_LIMIT
): Promise<NoteItem[]> {
  const gen = (containerLoadGenerations.get(key) ?? 0) + 1;
  containerLoadGenerations.set(key, gen);

  const load = (async (): Promise<NoteItem[]> => {
    const items =
      key === ROOT_CONTAINER_KEY
        ? ((await window.electronAPI.getRootNotes(limit)) ?? [])
        : ((await window.electronAPI.getNotes(noteType, limit, Number(key.slice(2)))) ?? []);

    // A newer load for this container may have resolved first.
    if (containerLoadGenerations.get(key) === gen) {
      applyContainers({ ...useNoteStore.getState().notesByContainer, [key]: items });
    }

    return items;
  })();

  containerLoadsInFlight.set(key, load);

  try {
    return await load;
  } finally {
    if (containerLoadsInFlight.get(key) === load) containerLoadsInFlight.delete(key);
  }
}

export async function ensureContainerLoaded(key: string): Promise<NoteItem[]> {
  const cached = useNoteStore.getState().notesByContainer[key];

  if (cached) return cached;

  return containerLoadsInFlight.get(key) ?? loadContainerNotes(key);
}

export function setContainerExpanded(key: string, expanded: boolean): void {
  const current = useNoteStore.getState().expandedContainers;

  if (current.has(key) !== expanded) {
    const next = new Set(current);

    if (expanded) next.add(key);
    else next.delete(key);
    useNoteStore.setState({ expandedContainers: next });
    persistExpandedContainers(next);
  }

  if (expanded) runInBackground(ensureContainerLoaded(key), "Note container load failed");
}

export function toggleContainerExpanded(key: string): void {
  setContainerExpanded(key, !useNoteStore.getState().expandedContainers.has(key));
}

/** Expand the Notes root and selected folder. */
export function revealContainer(folderId: number | null): void {
  setContainerExpanded(ROOT_CONTAINER_KEY, true);

  if (folderId != null) setContainerExpanded(folderContainerKey(folderId), true);
}

export function setActiveContext(folderId: number | null): void {
  const state = useNoteStore.getState();
  const key = folderId != null ? folderContainerKey(folderId) : ROOT_CONTAINER_KEY;
  useNoteStore.setState({
    activeContext: { folderId },
    notes: state.notesByContainer[key] ?? [],
  });
  runInBackground(ensureContainerLoaded(key), "Note container load failed");
}

/**
 * Loads folders and counts, resolves the initial active context
 * (honoring a pending folder preset or a prior activeContext, e.g. navigating
 * from search), loads the active container and auto-selects its first note
 * when none is pre-set.
 */
export async function initializeNotesTree(): Promise<void> {
  const gen = ++treeLoadGeneration;
  ensureIpcListeners();
  useNoteStore.setState({ isTreeLoading: true });

  try {
    const folders = await loadFolders();

    if (gen !== treeLoadGeneration) return;

    const presetFolderId = pendingFolderPreset;
    pendingFolderPreset = null;

    const presetFolder =
      presetFolderId != null ? folders.find((f) => f.id === presetFolderId) : undefined;

    const preset = useNoteStore.getState().activeContext;

    const presetContext =
      preset && (preset.folderId == null || folders.some((f) => f.id === preset.folderId))
        ? preset
        : null;

    let context: ActiveContext;

    if (presetFolder) {
      context = { folderId: presetFolder.id };
    } else if (presetContext) {
      context = presetContext;
    } else {
      const initialFolder = findDefaultFolder(folders) ?? folders[0];
      context = { folderId: initialFolder?.id ?? null };
    }

    revealContainer(context.folderId);
    useNoteStore.setState({ activeContext: context });
    // The store stays IPC-maintained across mounts, so an existing container
    // entry is current — reuse it (or revealContainer's in-flight load)
    // instead of fetching the same container twice on every init.
    const notes = await ensureContainerLoaded(contextContainerKey(context));

    if (gen !== treeLoadGeneration) return;

    // Containers restored as expanded from a previous session must load their
    // notes too, or they render expanded-but-empty until re-toggled.
    const validKeys = new Set<string>([
      ROOT_CONTAINER_KEY,
      ...folders.map((f) => folderContainerKey(f.id)),
    ]);

    useNoteStore.getState().expandedContainers.forEach((key) => {
      if (validKeys.has(key))
        runInBackground(ensureContainerLoaded(key), "Note container load failed");
    });

    if (getActiveNoteIdValue() == null && notes.length > 0) {
      setActiveNoteId(notes[0].id);
    }
  } finally {
    if (gen === treeLoadGeneration) useNoteStore.setState({ isTreeLoading: false });
  }
}

export async function initializeNotes(
  noteType?: string | null,
  limit = DEFAULT_LIMIT,
  folderId?: number | null
): Promise<NoteItem[]> {
  currentLimit = limit;
  ensureIpcListeners();

  if (folderId != null) {
    return loadContainerNotes(folderContainerKey(folderId), noteType ?? null, limit);
  }

  const gen = ++loadGeneration;
  const items = (await window.electronAPI.getNotes(noteType, limit, folderId)) ?? [];

  if (gen !== loadGeneration) return items;
  useNoteStore.setState({ notes: items });

  return items;
}

export function addNote(note: NoteItem): void {
  if (!note) return;
  const state = useNoteStore.getState();
  const notesByContainer = { ...state.notesByContainer };
  let changed = false;

  for (const key of noteContainerKeys(note)) {
    const items = notesByContainer[key];

    // Not-yet-loaded containers pick the note up on their lazy load.
    if (!items) continue;
    notesByContainer[key] = [note, ...items.filter((existing) => existing.id !== note.id)].slice(
      0,
      currentLimit
    );
    changed = true;
  }

  if (changed) applyContainers(notesByContainer);
}

export function updateNoteInStore(note: NoteItem): void {
  if (!note) return;
  const state = useNoteStore.getState();
  const targetKeys = noteContainerKeys(note);
  const notesByContainer = { ...state.notesByContainer };
  let changed = false;

  for (const [key, items] of Object.entries(state.notesByContainer)) {
    const idx = items.findIndex((existing) => existing.id === note.id);

    if (idx === -1) continue;
    changed = true;

    if (targetKeys.includes(key)) {
      const next = items.slice();
      next[idx] = note;
      notesByContainer[key] = next;
    } else {
      // The note left this folder or the Notes root — drop it here.
      notesByContainer[key] = items.filter((existing) => existing.id !== note.id);
    }
  }

  for (const key of targetKeys) {
    const target = notesByContainer[key];

    if (target && !target.some((existing) => existing.id === note.id)) {
      notesByContainer[key] = [note, ...target].slice(0, currentLimit);
      changed = true;
    }
  }

  if (changed) applyContainers(notesByContainer);

  // The selected row is held independently of the container caches (#185).
  if (state.selectedNote?.id === note.id) {
    useNoteStore.setState({ selectedNote: note });
  }
}

export function removeNote(id: number): void {
  useNoteStore.setState((state) => {
    const editorSaves = { ...state.editorSaves };
    delete editorSaves[id];

    return { editorSaves };
  });

  if (id == null) return;
  const state = useNoteStore.getState();
  const result = removeNoteFromLists(state, id);

  if (!result.changed && state.selectedNote?.id !== id) return;
  // applyContainers only mirrors the active container into `notes`; pass the
  // filtered flat list explicitly so flat-only notes disappear too.
  const extra: Partial<NoteState> = { notes: result.notes };

  if (result.activeNoteId !== state.activeNoteId) {
    extra.activeNoteId = result.activeNoteId;
    // The relocation is a selection write: drop any in-flight open fetch (#185).
    ++selectedNoteFetchGeneration;
  }

  // The selected row is held independently of the container caches (#185):
  // deleting it clears it (the relocation picks a neighbor's id).
  if (state.selectedNote?.id === id) {
    extra.selectedNote = null;
  }

  applyContainers(result.notesByContainer, extra);
}

export async function createFolder(
  name: string
): Promise<{ success: boolean; folder?: FolderItem | null; error?: string }> {
  const result = await window.electronAPI.createFolder(name);

  if (result.success && result.folder) {
    await loadFolders();
  }

  return result;
}

export async function renameFolder(
  id: number,
  name: string
): Promise<{ success: boolean; folder?: FolderItem | null; error?: string }> {
  const result = await window.electronAPI.renameFolder(id, name);

  if (result.success) {
    await loadFolders();
  }

  return result;
}

export async function updateFolderStyle(
  id: number,
  style: FolderStyle
): Promise<{ success: boolean; folder?: FolderItem | null; error?: string }> {
  const result = await window.electronAPI.updateFolderStyle(id, style);

  if (result.success) await loadFolders();

  return result;
}

export async function reorderFolders(folderIds: number[]): Promise<void> {
  const result = await window.electronAPI.reorderFolders(folderIds);

  if (result.success) await loadFolders();
}

export async function deleteFolder(id: number): Promise<{ success: boolean; error?: string }> {
  const result = await window.electronAPI.deleteFolder(id);

  if (!result.success) return result;

  const state = useNoteStore.getState();
  const key = folderContainerKey(id);
  const teardown = teardownNoteContainers(state, [key]);
  persistExpandedContainers(teardown.expandedContainers);
  useNoteStore.setState({
    notesByContainer: teardown.notesByContainer,
    expandedContainers: teardown.expandedContainers,
    activeNoteId: teardown.activeNoteId,
  });

  await loadFolders();

  await loadContainerNotes(ROOT_CONTAINER_KEY);

  if (getActiveFolderIdValue() === id) {
    setActiveContext(null);

    if (getActiveNoteIdValue() == null) {
      const notes = await ensureContainerLoaded(ROOT_CONTAINER_KEY);

      if (notes.length > 0) setActiveNoteId(notes[0].id);
    }
  }

  return result;
}

export function setActiveNoteId(id: number | null): void {
  if (useNoteStore.getState().activeNoteId === id) return;
  // Every selection write invalidates a still-in-flight openNoteRow fetch of
  // an older selection — sidebar/list clicks, pills and pending drains must
  // not be hijacked by a late fetch result (#185).
  ++selectedNoteFetchGeneration;
  useNoteStore.setState({ activeNoteId: id, selectedNote: null });
}

/**
 * Opens a Note from a full row (search, chat, Home) and holds it independently
 * of the container caches, which only carry the newest 50 per container (#185).
 * A row known only by id is fetched once, guarded against a stale answer after
 * a quick switch to another Note.
 */
export async function openNoteRow(note: NoteItem): Promise<void> {
  // Any newer open invalidates a still-in-flight fetch of an older one (#185).
  const generation = ++selectedNoteFetchGeneration;
  // A cached row needs no fetch; hold it directly (no extra load).
  const cached = findNoteInState(useNoteStore.getState(), note.id);

  if (cached) {
    useNoteStore.setState({ selectedNote: cached, activeNoteId: cached.id });

    return;
  }

  // A caller-supplied full row (search result, chat citation) is held as-is.
  if (note.title !== undefined && note.content !== undefined) {
    useNoteStore.setState({ selectedNote: note, activeNoteId: note.id });

    return;
  }

  const fetched = await window.electronAPI.getNote(note.id);

  if (generation !== selectedNoteFetchGeneration) return;

  if (fetched) {
    useNoteStore.setState({ selectedNote: fetched, activeNoteId: fetched.id });
  } else {
    setActiveNoteId(note.id);
  }
}

let selectedNoteFetchGeneration = 0;

/**
 * Jump navigation (CommandSearch/ControlPanel): activate and reveal a
 * folder or Notes root. Works both with a mounted tree and as a preset that
 * initializeNotesTree resolves on mount.
 */
export function navigateToContainer(folderId: number | null): void {
  // Container jumps land on the overview; flows that open a note afterwards
  // (e.g. CommandSearch note select) re-set activeNoteId themselves.
  setActiveNoteId(null);

  if (folderId != null) {
    setActiveFolderId(folderId);

    return;
  }

  setActiveContext(null);
  revealContainer(null);
}

export function setActiveFolderId(id: number | null): void {
  const folder = id != null ? useNoteStore.getState().folders.find((f) => f.id === id) : undefined;

  if (folder) {
    pendingFolderPreset = null;
    setActiveContext(folder.id);
    revealContainer(folder.id);

    return;
  }

  // Folder unknown (tree not initialized yet) or id cleared.
  pendingFolderPreset = id;
}

export function getActiveNoteIdValue(): number | null {
  return useNoteStore.getState().activeNoteId;
}

export function getNoteFromStore(id: number): NoteItem | null {
  return findNoteInState(useNoteStore.getState(), id);
}

export function getActiveFolderIdValue(): number | null {
  return useNoteStore.getState().activeContext?.folderId ?? null;
}

/** Live (non-hook) reads for deferred callbacks like undo toasts. */
export function getNotesByContainerValue(): Record<string, NoteItem[]> {
  return useNoteStore.getState().notesByContainer;
}

export function getNoteEventsRevisionValue(): number {
  return useNoteStore.getState().noteEventsRevision;
}

export function getFoldersValue(): FolderItem[] {
  return useNoteStore.getState().folders;
}

export function useNotes(): NoteItem[] {
  return useNoteStore((state) => state.notes);
}

export function useFolders(): FolderItem[] {
  return useNoteStore((state) => state.folders);
}

export function useFolderCounts(): Record<number, number> {
  return useNoteStore((state) => state.folderCounts);
}

export function useRootNoteCount(): number {
  return useNoteStore((state) => state.rootNoteCount);
}

export function useNotesByContainer(): Record<string, NoteItem[]> {
  return useNoteStore((state) => state.notesByContainer);
}

export function useNoteEventsRevision(): number {
  return useNoteStore((state) => state.noteEventsRevision);
}

export function useExpandedContainers(): Set<string> {
  return useNoteStore((state) => state.expandedContainers);
}

export function useActiveContext(): ActiveContext | null {
  return useNoteStore((state) => state.activeContext);
}

export function useIsTreeLoading(): boolean {
  return useNoteStore((state) => state.isTreeLoading);
}

export function useActiveNoteId(): number | null {
  return useNoteStore((state) => state.activeNoteId);
}

export function useActiveFolderId(): number | null {
  return useNoteStore((state) => state.activeContext?.folderId ?? null);
}

export function useActiveNote(): NoteItem | null {
  return useNoteStore((state) =>
    state.activeNoteId != null ? findNoteInState(state, state.activeNoteId) : null
  );
}
