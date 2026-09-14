import { create } from "zustand";
import {
  invalidateKeyedLoadGenerations,
  removeNoteFromLists,
  teardownNoteContainers,
} from "./noteListOps";
import { findDefaultFolder } from "../components/notes/shared";
import type { FolderItem, NoteItem, SpaceItem } from "../types/electron";

export interface ActiveContext {
  spaceId: number;
  folderId: number | null;
}

interface NoteState {
  notes: NoteItem[];
  spaces: SpaceItem[];
  folders: FolderItem[];
  folderCounts: Record<number, number>;
  // Notes sitting at a space root (folder_id NULL), keyed by space id — the
  // tree's space rows show true totals without loading containers.
  spaceRootCounts: Record<number, number>;
  notesByContainer: Record<string, NoteItem[]>;
  expandedContainers: Set<string>;
  activeContext: ActiveContext | null;
  activeNoteId: number | null;
  isTreeLoading: boolean;
}

const EXPANDED_STORAGE_KEY = "notesTree.expanded";

function readExpandedContainers(): Set<string> {
  try {
    const raw = localStorage.getItem(EXPANDED_STORAGE_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
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
  notes: [],
  spaces: [],
  folders: [],
  folderCounts: {},
  spaceRootCounts: {},
  notesByContainer: {},
  expandedContainers: readExpandedContainers(),
  activeContext: null,
  activeNoteId: null,
  isTreeLoading: true,
}));

let hasBoundIpcListeners = false;
const DEFAULT_LIMIT = 50;
let currentLimit = DEFAULT_LIMIT;
let loadGeneration = 0;
let treeLoadGeneration = 0;
let spacesLoadGeneration = 0;
let foldersLoadGeneration = 0;
// Folder navigation requested before folders load; consumed once by initializeNotesTree.
let pendingFolderPreset: number | null = null;

export function folderContainerKey(folderId: number): string {
  return `f:${folderId}`;
}

export function spaceContainerKey(spaceId: number): string {
  return `s:${spaceId}`;
}

export function contextContainerKey(context: ActiveContext): string {
  return context.folderId != null
    ? folderContainerKey(context.folderId)
    : spaceContainerKey(context.spaceId);
}

function noteContainerKey(note: NoteItem): string {
  return note.folder_id != null
    ? folderContainerKey(note.folder_id)
    : spaceContainerKey(note.space_id);
}

function findNoteInState(state: NoteState, id: number): NoteItem | null {
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
        loadFolders();
      }
    });
    if (typeof dispose === "function") {
      disposers.push(dispose);
    }
  }

  if (window.electronAPI.onNoteUpdated) {
    const dispose = window.electronAPI.onNoteUpdated((note) => {
      if (note) {
        const previous = findNoteInState(useNoteStore.getState(), note.id);
        updateNoteInStore(note);
        if (previous && noteContainerKey(previous) !== noteContainerKey(note)) {
          loadFolders();
        }
      }
    });
    if (typeof dispose === "function") {
      disposers.push(dispose);
    }
  }

  if (window.electronAPI.onNoteDeleted) {
    const dispose = window.electronAPI.onNoteDeleted(({ id }) => {
      removeNote(id);
      loadFolders();
    });
    if (typeof dispose === "function") {
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
        // The active folder vanished under us — degrade to its space root.
        fallbackContext = { spaceId: state.activeContext.spaceId, folderId: null };
        extra.activeContext = fallbackContext;
        extra.notes = teardown.notesByContainer[contextContainerKey(fallbackContext)] ?? [];
      }
      useNoteStore.setState({ notesByContainer: teardown.notesByContainer, ...extra });
      if (fallbackContext) void ensureContainerLoaded(contextContainerKey(fallbackContext));
      void loadFolders();
    });
    if (typeof dispose === "function") {
      disposers.push(dispose);
    }
  }

  hasBoundIpcListeners = true;

  window.addEventListener("beforeunload", () => {
    disposers.forEach((dispose) => dispose());
  });
}

export async function loadSpaces(): Promise<SpaceItem[]> {
  const gen = ++spacesLoadGeneration;
  const items = (await window.electronAPI.getSpaces?.()) ?? [];
  // A newer load may have resolved first.
  if (gen !== spacesLoadGeneration) return items;
  useNoteStore.setState({ spaces: items });
  return items;
}

export async function loadFolders(): Promise<FolderItem[]> {
  const gen = ++foldersLoadGeneration;
  const [items, counts] = await Promise.all([
    window.electronAPI.getFolders(),
    window.electronAPI.getFolderNoteCounts(),
  ]);
  if (gen !== foldersLoadGeneration) return items;
  const folderCounts: Record<number, number> = {};
  const spaceRootCounts: Record<number, number> = {};
  counts.forEach((c) => {
    if (c.folder_id != null) folderCounts[c.folder_id] = c.count;
    else if (c.space_id != null) spaceRootCounts[c.space_id] = c.count;
  });
  useNoteStore.setState({ folders: items, folderCounts, spaceRootCounts });
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
  spacesLoadGeneration += 1;
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
    spaces: [],
    folders: [],
    folderCounts: {},
    spaceRootCounts: {},
    notesByContainer: {},
    expandedContainers: new Set(),
    activeContext: null,
    activeNoteId: null,
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
    const [kind, idStr] = key.split(":");
    const id = Number(idStr);
    const items =
      kind === "f"
        ? ((await window.electronAPI.getNotes(noteType, limit, id)) ?? [])
        : ((await window.electronAPI.getNotes(noteType, limit, null, id)) ?? []);
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
  if (expanded) void ensureContainerLoaded(key);
}

export function toggleContainerExpanded(key: string): void {
  setContainerExpanded(key, !useNoteStore.getState().expandedContainers.has(key));
}

/** Expand the containers that make a space/folder (and its notes) visible in the tree. */
export function revealContainer(spaceId: number, folderId: number | null): void {
  setContainerExpanded(spaceContainerKey(spaceId), true);
  if (folderId != null) setContainerExpanded(folderContainerKey(folderId), true);
}

export function setActiveContext(spaceId: number, folderId: number | null): void {
  const state = useNoteStore.getState();
  const key = folderId != null ? folderContainerKey(folderId) : spaceContainerKey(spaceId);
  useNoteStore.setState({
    activeContext: { spaceId, folderId },
    notes: state.notesByContainer[key] ?? [],
  });
  void ensureContainerLoaded(key);
}

/**
 * Loads spaces, folders and counts, resolves the initial active context
 * (honoring a pending folder preset or a prior activeContext, e.g. navigating
 * from search), loads the active container and auto-selects its first note
 * when none is pre-set.
 */
export async function initializeNotesTree(): Promise<void> {
  const gen = ++treeLoadGeneration;
  ensureIpcListeners();
  useNoteStore.setState({ isTreeLoading: true });
  try {
    const [spaces, folders] = await Promise.all([loadSpaces(), loadFolders()]);
    if (gen !== treeLoadGeneration) return;

    const presetFolderId = pendingFolderPreset;
    pendingFolderPreset = null;
    const presetFolder =
      presetFolderId != null ? folders.find((f) => f.id === presetFolderId) : undefined;
    const preset = useNoteStore.getState().activeContext;
    const presetContext =
      preset &&
      spaces.some((s) => s.id === preset.spaceId) &&
      (preset.folderId == null || folders.some((f) => f.id === preset.folderId))
        ? preset
        : null;
    const privateSpace = spaces.find((s) => s.kind === "private") ?? spaces[0];
    let context: ActiveContext | null = null;
    if (presetFolder) {
      context = { spaceId: presetFolder.space_id, folderId: presetFolder.id };
    } else if (presetContext) {
      context = presetContext;
    } else if (privateSpace) {
      const privateFolders = folders.filter((f) => f.space_id === privateSpace.id);
      const initialFolder = findDefaultFolder(privateFolders) ?? privateFolders[0];
      context = { spaceId: privateSpace.id, folderId: initialFolder?.id ?? null };
    }
    if (!context) return;

    revealContainer(context.spaceId, context.folderId);
    useNoteStore.setState({ activeContext: context });
    // The store stays IPC-maintained across mounts, so an existing container
    // entry is current — reuse it (or revealContainer's in-flight load)
    // instead of fetching the same container twice on every init.
    const notes = await ensureContainerLoaded(contextContainerKey(context));
    if (gen !== treeLoadGeneration) return;
    // Containers restored as expanded from a previous session must load their
    // notes too, or they render expanded-but-empty until re-toggled.
    const validKeys = new Set<string>([
      ...spaces.map((s) => spaceContainerKey(s.id)),
      ...folders.map((f) => folderContainerKey(f.id)),
    ]);
    useNoteStore.getState().expandedContainers.forEach((key) => {
      if (validKeys.has(key)) void ensureContainerLoaded(key);
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
  const key = noteContainerKey(note);
  const items = state.notesByContainer[key];
  // Not-yet-loaded containers pick the note up on their lazy load.
  if (!items) return;
  const next = [note, ...items.filter((existing) => existing.id !== note.id)].slice(
    0,
    currentLimit
  );
  applyContainers({ ...state.notesByContainer, [key]: next });
}

export function updateNoteInStore(note: NoteItem): void {
  if (!note) return;
  const state = useNoteStore.getState();
  const targetKey = noteContainerKey(note);
  const notesByContainer = { ...state.notesByContainer };
  let changed = false;
  for (const [key, items] of Object.entries(state.notesByContainer)) {
    const idx = items.findIndex((existing) => existing.id === note.id);
    if (idx === -1) continue;
    changed = true;
    if (key === targetKey) {
      const next = items.slice();
      next[idx] = note;
      notesByContainer[key] = next;
    } else {
      // The note moved container (folder/space change) — relocate it.
      notesByContainer[key] = items.filter((existing) => existing.id !== note.id);
    }
  }
  const target = notesByContainer[targetKey];
  if (target && !target.some((existing) => existing.id === note.id)) {
    notesByContainer[targetKey] = [note, ...target].slice(0, currentLimit);
    changed = true;
  }
  if (changed) applyContainers(notesByContainer);
}

export function removeNote(id: number): void {
  if (id == null) return;
  const state = useNoteStore.getState();
  const result = removeNoteFromLists(state, id);
  if (!result.changed) return;
  // applyContainers only mirrors the active container into `notes`; pass the
  // filtered flat list explicitly so flat-only notes disappear too.
  const extra: Partial<NoteState> = { notes: result.notes };
  if (result.activeNoteId !== state.activeNoteId) {
    extra.activeNoteId = result.activeNoteId;
  }
  applyContainers(result.notesByContainer, extra);
}

export async function createFolder(
  name: string,
  spaceId: number
): Promise<{ success: boolean; folder?: FolderItem; error?: string }> {
  const result = await window.electronAPI.createFolder(name, spaceId);
  if (result.success && result.folder) {
    await loadFolders();
  }
  return result;
}

export async function renameFolder(
  id: number,
  name: string
): Promise<{ success: boolean; folder?: FolderItem; error?: string }> {
  const result = await window.electronAPI.renameFolder(id, name);
  if (result.success) {
    await loadFolders();
  }
  return result;
}

export async function deleteFolder(id: number): Promise<{ success: boolean; error?: string }> {
  const result = await window.electronAPI.deleteFolder(id);
  if (!result.success) return result;

  const state = useNoteStore.getState();
  const folder = state.folders.find((f) => f.id === id);
  const key = folderContainerKey(id);
  const teardown = teardownNoteContainers(state, [key]);
  persistExpandedContainers(teardown.expandedContainers);
  useNoteStore.setState({
    notesByContainer: teardown.notesByContainer,
    expandedContainers: teardown.expandedContainers,
    activeNoteId: teardown.activeNoteId,
  });

  await loadFolders();
  if (getActiveFolderIdValue() === id && folder) {
    const { folders } = useNoteStore.getState();
    const spaceFolders = folders.filter((f) => f.space_id === folder.space_id);
    const fallback = findDefaultFolder(spaceFolders) ?? spaceFolders[0];
    setActiveContext(folder.space_id, fallback?.id ?? null);
    if (getActiveNoteIdValue() == null) {
      const notes = await ensureContainerLoaded(
        fallback ? folderContainerKey(fallback.id) : spaceContainerKey(folder.space_id)
      );
      if (notes.length > 0) setActiveNoteId(notes[0].id);
    }
  }
  return result;
}

export async function moveFolderToSpace(
  folderId: number,
  spaceId: number
): Promise<{ success: boolean; folder?: FolderItem; error?: string }> {
  const result = await window.electronAPI.moveFolderToSpace(folderId, spaceId);
  if (!result.success) return result;

  await loadFolders();
  const key = folderContainerKey(folderId);
  if (useNoteStore.getState().notesByContainer[key]) {
    // Refresh the container so its notes carry the new space_id.
    await loadContainerNotes(key);
  }
  const { activeContext } = useNoteStore.getState();
  if (activeContext?.folderId === folderId && activeContext.spaceId !== spaceId) {
    useNoteStore.setState({ activeContext: { spaceId, folderId } });
  }
  return result;
}

export async function updateSpaceMeta(
  id: number,
  updates: { name?: string; emoji?: string | null }
): Promise<{ success: boolean; space?: SpaceItem; error?: string }> {
  const result = (await window.electronAPI.updateSpace?.(id, updates)) ?? { success: false };
  if (result.success && result.space) {
    const updated = result.space;
    const { spaces } = useNoteStore.getState();
    useNoteStore.setState({ spaces: spaces.map((s) => (s.id === id ? updated : s)) });
  }
  return result;
}

export function setActiveNoteId(id: number | null): void {
  if (useNoteStore.getState().activeNoteId === id) return;
  useNoteStore.setState({ activeNoteId: id });
}

/**
 * Jump navigation (CommandSearch/ControlPanel): activate and reveal a
 * space/folder. Works both with a mounted tree and as a preset that
 * initializeNotesTree resolves on mount.
 */
export function navigateToContainer(spaceId: number, folderId: number | null): void {
  // Container jumps land on the overview; flows that open a note afterwards
  // (e.g. CommandSearch note select) re-set activeNoteId themselves.
  setActiveNoteId(null);
  if (folderId != null) {
    setActiveFolderId(folderId);
    return;
  }
  setActiveContext(spaceId, null);
  revealContainer(spaceId, null);
}

export function setActiveFolderId(id: number | null): void {
  const folder = id != null ? useNoteStore.getState().folders.find((f) => f.id === id) : undefined;
  if (folder) {
    pendingFolderPreset = null;
    setActiveContext(folder.space_id, folder.id);
    revealContainer(folder.space_id, folder.id);
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
export function getFoldersValue(): FolderItem[] {
  return useNoteStore.getState().folders;
}

export function getSpacesValue(): SpaceItem[] {
  return useNoteStore.getState().spaces;
}

export function useNotes(): NoteItem[] {
  return useNoteStore((state) => state.notes);
}

export function useSpaces(): SpaceItem[] {
  return useNoteStore((state) => state.spaces);
}

export function useFolders(): FolderItem[] {
  return useNoteStore((state) => state.folders);
}

export function useFolderCounts(): Record<number, number> {
  return useNoteStore((state) => state.folderCounts);
}

export function useSpaceRootCounts(): Record<number, number> {
  return useNoteStore((state) => state.spaceRootCounts);
}

export function useNotesByContainer(): Record<string, NoteItem[]> {
  return useNoteStore((state) => state.notesByContainer);
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
