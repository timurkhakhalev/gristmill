import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Check,
  ChevronRight,
  ExternalLink,
  FileText,
  Folder,
  FolderOpen,
  Loader2,
  Lock,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
} from "../icons";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { ConfirmDialog } from "../ui/dialog";
import { useDialogs } from "../../hooks/useDialogs";
import { useToast } from "../ui/useToast";
import { useNoteDragAndDrop, type NoteMoveTarget } from "../../hooks/useNoteDragAndDrop";
import { localMutationErrorKey } from "../../lib/localMutationError";
import { useSettingsStore } from "../../stores/settingsStore";
import { cn } from "../lib/utils";
import { treeHorizontalIntent } from "./treeDirection";
import { defaultFolderDisplayName } from "./shared";
import { stopRecording as storeStopRecording, useMeetingRecordingStore } from "../../stores/meetingRecordingStore";
import type { FolderItem, SpaceItem } from "../../contracts/containers";
import type { NoteItem } from "../../contracts/notes";
import {
  folderContainerKey,
  spaceContainerKey,
  useSpaces,
  useFolders,
  useFolderCounts,
  useSpaceRootCounts,
  useNotesByContainer,
  useExpandedContainers,
  useIsTreeLoading,
  useActiveContext,
  useActiveNoteId,
  setActiveContext,
  setActiveNoteId,
  setContainerExpanded,
  toggleContainerExpanded,
  createFolder,
  renameFolder,
  deleteFolder,
  moveFolderToSpace,
  getNoteFromStore,
} from "../../stores/noteStore";

type TFn = (key: string, options?: Record<string, unknown>) => string;
type RowA11y = {
  tabIndex: number;
  rowRef: (el: HTMLDivElement | null) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  onFocus: () => void;
};
type TreeRow = {
  type: "space" | "folder" | "note";
  key: string;
  space?: SpaceItem;
  folder?: FolderItem;
  note?: NoteItem;
  parentKey?: string;
  level?: 1 | 2;
};
interface SpacesTreeProps {
  onDeleteNote: (id: number) => void;
  onMoveNote: (noteId: number, target: NoteMoveTarget) => Promise<void>;
  onCreateFolderAndMove: (noteId: number, folderName: string) => void;
  onNewNote: (spaceId: number, folderId: number | null) => void;
  onShowStructureIntro?: () => void;
}

const rowClass =
  "group relative flex items-center gap-2 rounded-md cursor-pointer select-none h-7 pe-2 transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring/30";
const menuClass = "text-xs gap-2 rounded-md px-2 py-1";
const buttonClass =
  "h-5 w-5 shrink-0 rounded-sm [&_svg]:size-3! opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 transition-opacity text-muted-foreground/70 hover:text-foreground/60 hover:bg-foreground/5";
const submenuClass = "min-w-36 rounded-xl border border-border p-1";
const managerName = () => "Finder";

function TreeToggle({
  open,
  onToggle,
  icon,
}: {
  open: boolean;
  onToggle: () => void;
  icon: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={open ? "Collapse" : "Expand"}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className="relative h-4 w-4 shrink-0 flex items-center justify-center rounded-sm text-foreground/50 hover:text-foreground/80"
    >
      <span className="absolute inset-0 flex items-center justify-center transition-opacity group-hover:opacity-0">
        {icon}
      </span>
      <ChevronRight size={12} className={cn("transition-transform", open && "rotate-90")} />
    </button>
  );
}

function MoveMenu({
  note,
  spaces,
  folders,
  onMove,
  onCreateFolderAndMove,
  t,
}: {
  note: NoteItem;
  spaces: SpaceItem[];
  folders: FolderItem[];
  onMove: (target: NoteMoveTarget) => void;
  onCreateFolderAndMove: (id: number, name: string) => void;
  t: TFn;
}) {
  const [search, setSearch] = useState("");
  const [newFolder, setNewFolder] = useState("");
  const options = useMemo(
    () =>
      spaces.flatMap((space) => [
        {
          key: spaceContainerKey(space.id),
          label: space.name,
          target: { spaceId: space.id, folderId: null },
          space,
        },
        ...folders
          .filter((folder) => folder.space_id === space.id)
          .map((folder) => ({
            key: folderContainerKey(folder.id),
            label: defaultFolderDisplayName(folder, t),
            target: { spaceId: space.id, folderId: folder.id },
            space,
          })),
      ]),
    [folders, spaces, t]
  );
  const filtered = search
    ? options.filter((option) => option.label.toLowerCase().includes(search.toLowerCase()))
    : options;
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className={menuClass}>
        <FolderOpen size={11} />
        {t("notes.context.moveToFolder")}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent sideOffset={4} className={submenuClass}>
        {options.length > 5 && (
          <>
            <input
              dir="auto"
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("notes.context.searchFolders")}
              className="input-inline w-full px-2 py-1 text-xs outline-none border-none"
            />
            <DropdownMenuSeparator />
          </>
        )}
        <div className="max-h-40 overflow-y-auto">
          {filtered.map((option) => (
            <DropdownMenuItem
              key={option.key}
              disabled={
                option.target.folderId === note.folder_id && option.target.spaceId === note.space_id
              }
              onClick={() => onMove(option.target)}
              className={menuClass}
            >
              <span className="truncate flex-1">{option.label}</span>
              {option.target.folderId === note.folder_id &&
                option.target.spaceId === note.space_id && <Check size={9} />}
            </DropdownMenuItem>
          ))}
        </div>
        <DropdownMenuSeparator />
        <div className="px-1">
          <input
            dir="auto"
            value={newFolder}
            onChange={(e) => setNewFolder(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && newFolder.trim()) {
                onCreateFolderAndMove(note.id, newFolder.trim());
                setNewFolder("");
              }
            }}
            placeholder={t("notes.context.newFolder")}
            className="input-inline w-full px-2 py-1 text-xs outline-none border-none"
          />
        </div>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

function NoteRow({
  note,
  level,
  spaces,
  folders,
  noteFilesEnabled,
  onOpen,
  onMove,
  onCreateFolderAndMove,
  onDelete,
  a11y,
  t,
  dragState,
  noteDragHandlers,
  selected,
}: {
  selected: boolean;
  note: NoteItem;
  level: 1 | 2;
  spaces: SpaceItem[];
  folders: FolderItem[];
  noteFilesEnabled: boolean;
  onOpen: () => void;
  onMove: (target: NoteMoveTarget) => void;
  onCreateFolderAndMove: (id: number, name: string) => void;
  onDelete: (id: number) => void;
  a11y: RowA11y;
  t: TFn;
  dragState: { draggingNoteId: number | null };
  noteDragHandlers: (note: {
    id: number;
    title: string;
    folderId: number | null;
    spaceId: number;
  }) => { draggable: true; onDragStart: (e: React.DragEvent) => void; onDragEnd: () => void };
}) {
  return (
    <div
      title={note.title || t("notes.list.untitled")}
      role="treeitem"
      aria-selected={selected}
      aria-level={level}
      tabIndex={a11y.tabIndex}
      ref={a11y.rowRef}
      onKeyDown={a11y.onKeyDown}
      onFocus={a11y.onFocus}
      onClick={onOpen}
      {...noteDragHandlers({
        id: note.id,
        title: note.title,
        folderId: note.folder_id,
        spaceId: note.space_id,
      })}
      className={cn(
        rowClass,
        selected && "bg-foreground/8",
        level === 1 ? "ps-[30px]" : "ps-[14px]",
        dragState.draggingNoteId === note.id && "opacity-40"
      )}
    >
      <FileText size={14} className="shrink-0 text-foreground/50" />
      <span dir="auto" className="text-ui truncate min-w-0 flex-1 text-foreground/85">
        {note.title || t("notes.list.untitled")}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("common.actions")}
            onClick={(e) => e.stopPropagation()}
            className={buttonClass}
          >
            <MoreHorizontal size={12} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={4} className="min-w-40">
          {noteFilesEnabled && (
            <DropdownMenuItem
              onClick={() => window.electronAPI?.showNoteFile?.(note.id)}
              className={menuClass}
            >
              <ExternalLink size={11} />
              {t("notes.context.showInFileManager", { manager: managerName() })}
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <MoveMenu
            note={note}
            spaces={spaces}
            folders={folders}
            onMove={onMove}
            onCreateFolderAndMove={onCreateFolderAndMove}
            t={t}
          />
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => onDelete(note.id)}
            className={cn(menuClass, "text-destructive focus:text-destructive")}
          >
            <Trash2 size={11} />
            {t("notes.context.delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function FolderRow({
  folder,
  level,
  count,
  noteFilesEnabled,
  spaces,
  expanded,
  onToggle,
  onOpen,
  onNewNote,
  onRename,
  onMove,
  onDelete,
  a11y,
  t,
  children,
  dropHandlers,
  highlighted,
  selected,
}: {
  dropHandlers: ReturnType<ReturnType<typeof useNoteDragAndDrop>["dropTargetHandlers"]>;
  highlighted: boolean;
  selected: boolean;
  folder: FolderItem;
  level: 1;
  count: number;
  noteFilesEnabled: boolean;
  spaces: SpaceItem[];
  expanded: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onNewNote: () => void;
  onRename: () => void;
  onMove: (space: SpaceItem) => void;
  onDelete: () => void;
  a11y: RowA11y;
  t: TFn;
  children: React.ReactNode;
}) {
  return (
    <>
      <div
        role="treeitem"
        aria-selected={selected}
        {...dropHandlers}
        aria-level={level}
        aria-expanded={expanded}
        tabIndex={a11y.tabIndex}
        ref={a11y.rowRef}
        onKeyDown={a11y.onKeyDown}
        onFocus={a11y.onFocus}
        onClick={onOpen}
        className={cn(
          rowClass,
          "ps-[14px]",
          selected && "bg-foreground/8",
          highlighted && "ring-1 ring-primary bg-primary/10"
        )}
      >
        <TreeToggle open={expanded} onToggle={onToggle} icon={<Folder size={14} />} />
        <span className="text-ui truncate flex-1 text-foreground/85">
          {defaultFolderDisplayName(folder, t)}
          {count > 0 && <span className="ms-1 text-2xs text-foreground/40">{count}</span>}
        </span>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("notes.list.newNote")}
          onClick={(e) => {
            e.stopPropagation();
            onNewNote();
          }}
          className={buttonClass}
        >
          <Plus size={12} />
        </Button>
        {(!folder.is_default || noteFilesEnabled) && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("common.actions")}
                onClick={(e) => e.stopPropagation()}
                className={buttonClass}
              >
                <MoreHorizontal size={12} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-32">
              {noteFilesEnabled && (
                <DropdownMenuItem
                  onClick={() => window.electronAPI?.showFolderInExplorer?.(folder.name)}
                  className={menuClass}
                >
                  <ExternalLink size={11} />
                  {t("notes.context.showInFileManager", { manager: managerName() })}
                </DropdownMenuItem>
              )}
              {!folder.is_default && (
                <>
                  <DropdownMenuItem onClick={onRename} className={menuClass}>
                    <Pencil size={11} />
                    {t("notes.context.rename")}
                  </DropdownMenuItem>
                  {spaces.length > 1 && (
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger className={menuClass}>
                        <FolderOpen size={11} />
                        {t("notes.spaces.moveToSpace")}
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent className={submenuClass}>
                        {spaces.map((space) => (
                          <DropdownMenuItem
                            key={space.id}
                            disabled={space.id === folder.space_id}
                            onClick={() => onMove(space)}
                            className={menuClass}
                          >
                            {space.name}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={onDelete}
                    className={cn(menuClass, "text-destructive focus:text-destructive")}
                  >
                    <Trash2 size={11} />
                    {t("notes.context.delete")}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      <div
        className={cn(
          "grid transition-[grid-template-rows]",
          expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        )}
      >
        <div className="min-h-0 overflow-hidden">{children}</div>
      </div>
    </>
  );
}

export default function SpacesTree({
  onDeleteNote,
  onMoveNote,
  onCreateFolderAndMove,
  onNewNote,
}: SpacesTreeProps) {
  const { t, i18n } = useTranslation();
  const { toast, dismiss } = useToast();
  const spaces = useSpaces().filter((space) => space.kind === "private");
  const folders = useFolders();
  const folderCounts = useFolderCounts();
  const rootCounts = useSpaceRootCounts();
  const notesByContainer = useNotesByContainer();
  const expanded = useExpandedContainers();
  const loading = useIsTreeLoading();
  const activeContext = useActiveContext();
  const activeNoteId = useActiveNoteId();
  const noteFilesEnabled = useSettingsStore((s) => s.noteFilesEnabled);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const [newFolderSpace, setNewFolderSpace] = useState<number | null>(null);
  const [newFolderName, setNewFolderName] = useState("");
  const [renamingFolder, setRenamingFolder] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const undoToast = useRef<string | null>(null);
  const { confirmDialog, showConfirmDialog, hideConfirmDialog } = useDialogs();
  const capturePhase = useMeetingRecordingStore((state) => state.capturePhase);
  const recordingNoteId = useMeetingRecordingStore((state) => state.recordingNoteId);
  const rows = useMemo<TreeRow[]>(() => {
    const result: TreeRow[] = [];
    for (const space of spaces) {
      const spaceKey = spaceContainerKey(space.id);
      result.push({ type: "space", key: spaceKey, space });
      if (!expanded.has(spaceKey)) continue;
      for (const folder of folders.filter((item) => item.space_id === space.id)) {
        const folderKey = folderContainerKey(folder.id);
        result.push({ type: "folder", key: folderKey, folder, parentKey: spaceKey, level: 1 });
        if (expanded.has(folderKey))
          for (const note of notesByContainer[folderKey] ?? [])
            result.push({
              type: "note",
              key: `n:${note.id}`,
              note,
              parentKey: folderKey,
              level: 2,
            });
      }
      for (const note of notesByContainer[spaceKey] ?? [])
        result.push({ type: "note", key: `n:${note.id}`, note, parentKey: spaceKey, level: 1 });
    }
    return result;
  }, [expanded, folders, notesByContainer, spaces]);
  const focusRow = (key?: string) => {
    if (!key) return;
    setFocusedKey(key);
    requestAnimationFrame(() => rowRefs.current.get(key)?.focus());
  };
  const a11y = (key: string): RowA11y => ({
    tabIndex: focusedKey === key || (!focusedKey && rows[0]?.key === key) ? 0 : -1,
    rowRef: (el) => {
      if (el) rowRefs.current.set(key, el);
      else rowRefs.current.delete(key);
    },
    onFocus: () => setFocusedKey(key),
    onKeyDown: (event) => {
      const index = rows.findIndex((row) => row.key === key);
      const row = rows[index];
      const intent = treeHorizontalIntent(event.key, i18n.dir());
      if (intent && row) {
        event.preventDefault();
        if (intent === "inward" && row.type !== "note") {
          if (!expanded.has(key)) setContainerExpanded(key, true);
          else focusRow(rows[index + 1]?.parentKey === key ? rows[index + 1].key : undefined);
        } else if (intent === "outward") {
          if (row.type !== "note" && expanded.has(key)) setContainerExpanded(key, false);
          else focusRow(row.parentKey);
        }
      }
      if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        focusRow(event.key === "Home" ? rows[0]?.key : rows.at(-1)?.key);
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        focusRow(rows[index + 1]?.key);
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        focusRow(rows[index - 1]?.key);
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        const row = rows[index];
        if (row?.type === "note" && row.note) setActiveNoteId(row.note.id);
        else if (row) toggleContainerExpanded(row.key);
      }
    },
  });
  const moveNote = async (id: number, target: NoteMoveTarget) => {
    const note = getNoteFromStore(id);
    try {
      await onMoveNote(id, target);
    } catch (error) {
      toast({
        title: t("notes.spaces.couldNotMoveNote"),
        description: t(localMutationErrorKey(error instanceof Error ? error.message : undefined)),
        variant: "destructive",
      });
      return;
    }
    if (note) {
      if (undoToast.current) dismiss(undoToast.current);
      const previous = { spaceId: note.space_id, folderId: note.folder_id };
      undoToast.current = toast({
        title: t("notes.spaces.moved", {
          title: note.title || t("notes.list.untitled"),
          target: target.folderId ? "folder" : "space",
        }),
        duration: 8000,
        action: (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              void onMoveNote(id, previous);
            }}
            className="h-6 px-2 text-xs"
          >
            {t("notes.spaces.undo")}
          </Button>
        ),
      });
    }
  };
  const { dragState, noteDragHandlers, dropTargetHandlers } = useNoteDragAndDrop({
    untitledLabel: t("notes.list.untitled"),
    onMoveToTarget: moveNote,
    onCrossSpaceDrop: (_note, _target, commit) => commit(),
    onHoverTarget: (key) => setContainerExpanded(key, true),
  });
  const createFolderIn = async (spaceId: number) => {
    const name = newFolderName.trim();
    setNewFolderSpace(null);
    setNewFolderName("");
    if (!name) return;
    const result = await createFolder(name, spaceId);
    if (!result.success && result.error)
      toast({
        title: t("notes.folders.couldNotCreate"),
        description: t(localMutationErrorKey(result.error)),
        variant: "destructive",
      });
  };
  const rename = async (folder: FolderItem) => {
    const name = renameValue.trim();
    setRenamingFolder(null);
    setRenameValue("");
    if (!name) return;
    const result = await renameFolder(folder.id, name);
    if (!result.success && result.error)
      toast({
        title: t("notes.folders.couldNotRename"),
        description: t(localMutationErrorKey(result.error)),
        variant: "destructive",
      });
  };
  const removeFolder = (folder: FolderItem) =>
    showConfirmDialog({
      title: t("notes.folders.deleteTitle"),
      description: t("notes.folders.deleteDescription", {
        name: folder.name,
        count: folderCounts[folder.id] ?? 0,
      }),
      confirmText: t("notes.folders.deleteConfirm"),
      variant: "destructive",
      onConfirm: async () => {
        const result = await deleteFolder(folder.id);
        if (!result.success && result.error)
          toast({
            title: t("notes.folders.couldNotDelete"),
            description: t(localMutationErrorKey(result.error)),
            variant: "destructive",
          });
      },
    });
  if (loading && spaces.length === 0)
    return (
      <div className="flex-1 flex items-start justify-center py-8">
        <Loader2 size={12} className="animate-spin text-foreground/45" />
      </div>
    );
  const renderNote = (note: NoteItem, level: 1 | 2) => (
    <NoteRow
      key={note.id}
      note={note}
      selected={activeNoteId === note.id}
      level={level}
      spaces={spaces}
      folders={folders}
      noteFilesEnabled={noteFilesEnabled}
      onOpen={() => {
        setActiveContext(note.space_id, note.folder_id);
        setActiveNoteId(note.id);
      }}
      onMove={(target) => {
        void moveNote(note.id, target);
      }}
      onCreateFolderAndMove={onCreateFolderAndMove}
      onDelete={() => {
        const activeCapture = recordingNoteId === note.id &&
          ["preparing", "recording", "saving"].includes(capturePhase);
        if (!activeCapture) {
          void onDeleteNote(note.id);
          return;
        }
        showConfirmDialog({
          title: t("meetingResults.deleteActiveNoteTitle"),
          description: t("meetingResults.deleteActiveNoteDescription"),
          confirmText: t("meetingResults.deleteAudioConfirm"),
          variant: "destructive",
          onConfirm: async () => {
            try {
              const result = await storeStopRecording(undefined, { suppressProcessing: true });
              if (!result.stopped) {
                toast({ title: t("meetingResults.stopBeforeDeleteError"), variant: "destructive" });
                return;
              }
              await onDeleteNote(note.id);
            } catch (error) {
              toast({
                title: t("meetingResults.stopBeforeDeleteError"),
                description: error instanceof Error ? error.message : String(error),
                variant: "destructive",
              });
            }
          },
        });
      }}
      a11y={a11y(`n:${note.id}`)}
      t={t}
      dragState={dragState}
      noteDragHandlers={noteDragHandlers}
    />
  );
  const renderFolder = (folder: FolderItem, space: SpaceItem) => {
    const key = folderContainerKey(folder.id);
    if (renamingFolder === folder.id)
      return (
        <div key={folder.id} className="ps-[14px] pe-2">
          <input
            dir="auto"
            autoFocus
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void rename(folder);
              if (e.key === "Escape") setRenamingFolder(null);
            }}
            onBlur={() => void rename(folder)}
            className="w-full h-6 px-2 text-xs bg-foreground/5 rounded"
          />
        </div>
      );
    return (
      <FolderRow
        key={folder.id}
        folder={folder}
        selected={activeNoteId == null && activeContext?.folderId === folder.id}
        highlighted={dragState.dragOverKey === key || dragState.dropSuccessKey === key}
        dropHandlers={dropTargetHandlers({
          spaceId: space.id,
          folderId: folder.id,
          folderName: folder.name,
          isDefaultFolder: !!folder.is_default,
        })}
        level={1}
        count={folderCounts[folder.id] ?? 0}
        noteFilesEnabled={noteFilesEnabled}
        spaces={spaces}
        expanded={expanded.has(key)}
        onToggle={() => toggleContainerExpanded(key)}
        onOpen={() => setActiveContext(space.id, folder.id)}
        onNewNote={() => onNewNote(space.id, folder.id)}
        onRename={() => {
          setRenamingFolder(folder.id);
          setRenameValue(folder.name);
        }}
        onMove={(target) => {
          void moveFolderToSpace(folder.id, target.id);
        }}
        onDelete={() => removeFolder(folder)}
        a11y={a11y(key)}
        t={t}
      >
        {(notesByContainer[key] ?? []).map((note) => renderNote(note, 2))}
      </FolderRow>
    );
  };
  return (
    <>
      <div
        role="tree"
        aria-label={t("notes.list.title")}
        className="scrollbar-hidden flex-1 overflow-y-auto px-1.5 pb-2 space-y-px"
      >
        {spaces.map((space) => {
          const key = spaceContainerKey(space.id);
          const open = expanded.has(key);
          const count =
            (rootCounts[space.id] ?? 0) +
            folders
              .filter((folder) => folder.space_id === space.id)
              .reduce((sum, folder) => sum + (folderCounts[folder.id] ?? 0), 0);
          return (
            <div key={space.id}>
              <div
                role="treeitem"
                aria-selected={
                  activeNoteId == null &&
                  activeContext?.spaceId === space.id &&
                  activeContext.folderId == null
                }
                {...dropTargetHandlers({ spaceId: space.id, folderId: null })}
                aria-level={1}
                aria-expanded={open}
                tabIndex={a11y(key).tabIndex}
                ref={a11y(key).rowRef}
                onKeyDown={a11y(key).onKeyDown}
                onFocus={a11y(key).onFocus}
                onClick={() => setActiveContext(space.id, null)}
                className={cn(
                  rowClass,
                  "ps-2",
                  dragState.dragOverKey === key && "ring-1 ring-primary bg-primary/10"
                )}
              >
                <TreeToggle
                  open={open}
                  onToggle={() => toggleContainerExpanded(key)}
                  icon={<Lock size={14} />}
                />
                <span className="text-ui truncate flex-1 text-foreground/85">
                  {space.name || t("notes.spaces.personal")}
                </span>
                {count > 0 && <span className="text-2xs text-foreground/40">{count}</span>}
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t("notes.context.newFolder")}
                  onClick={(e) => {
                    e.stopPropagation();
                    setNewFolderSpace(space.id);
                    setContainerExpanded(key, true);
                  }}
                  className={buttonClass}
                >
                  <Plus size={12} />
                </Button>
              </div>
              {newFolderSpace === space.id && (
                <div className="ps-[14px] pe-2">
                  <input
                    dir="auto"
                    autoFocus
                    value={newFolderName}
                    onChange={(e) => setNewFolderName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void createFolderIn(space.id);
                      if (e.key === "Escape") setNewFolderSpace(null);
                    }}
                    onBlur={() => void createFolderIn(space.id)}
                    className="w-full h-6 px-2 text-xs bg-foreground/5 rounded"
                  />
                </div>
              )}
              {open &&
                folders
                  .filter((folder) => folder.space_id === space.id)
                  .map((folder) => renderFolder(folder, space))}
              {open && (notesByContainer[key] ?? []).map((note) => renderNote(note, 1))}
            </div>
          );
        })}
      </div>
      <ConfirmDialog
        open={confirmDialog.open}
        onOpenChange={(open) => !open && hideConfirmDialog()}
        title={confirmDialog.title}
        description={confirmDialog.description}
        confirmText={confirmDialog.confirmText}
        cancelText={confirmDialog.cancelText}
        onConfirm={confirmDialog.onConfirm}
        variant={confirmDialog.variant}
      />
    </>
  );
}
