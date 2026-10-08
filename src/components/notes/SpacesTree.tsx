import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AudioLines,
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileText,
  Folder,
  FolderOpen,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  Smile,
  Trash2,
} from "../icons";
import { Button } from "../ui/button";
import { Popover, PopoverAnchor, PopoverContent } from "../ui/popover";
import { EmojiIconGrid } from "./EmojiIconPicker";
import { folderColorHex } from "./folderColors";
import { InlineRename } from "./InlineRename";
import { Dropdown, Label, Separator } from "@heroui/react";
import { MENU_ITEM_CLASS } from "../ui/surfaceStyles";
import { ConfirmDialog, Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { useDialogs } from "../../hooks/useDialogs";
import { useToast } from "../ui/useToast";
import { useNoteDragAndDrop, type NoteMoveTarget } from "../../hooks/useNoteDragAndDrop";
import { localMutationErrorKey } from "../../lib/localMutationError";
import { useSettingsStore } from "../../stores/settingsStore";
import { cn } from "../lib/utils";
import { treeHorizontalIntent } from "./treeDirection";
import { defaultFolderDisplayName } from "./shared";
import { useUiLocale } from "../../hooks/useUiLocale";
import { useDateTimePreferences } from "../../hooks/useDateTimePreferences";
import { formatNoteDate } from "../../utils/dateFormatting";
import {
  stopRecording as storeStopRecording,
  useMeetingRecordingStore,
} from "../../stores/meetingRecordingStore";
import type { FolderItem, FolderStyle, SpaceItem } from "../../contracts/containers";
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
  updateFolderStyle,
  reorderFolders,
  deleteFolder,
  moveFolderToSpace,
  getNoteFromStore,
  runInBackground,
} from "../../stores/noteStore";

// Custom properties are outside React.CSSProperties; the row reads them in CSS.
function tintStyle(
  tint: string
): React.CSSProperties & { "--tint": string; "--tint-strong": string } {
  return { "--tint": `${tint}26`, "--tint-strong": `${tint}40` };
}

type TFn = (key: string, options?: Record<string, string | number>) => string;

type RowA11y = {
  tabIndex: number;
  rowRef: (el: HTMLDivElement | null) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  onFocus: () => void;
};

type TreeRow = {
  type: "folder" | "note";
  key: string;
  folder?: FolderItem;
  note?: NoteItem;
  parentKey?: string;
  level?: 1 | 2;
};

interface SpacesTreeProps {
  onDeleteNote: (id: number) => void;
  onMoveNote: (noteId: number, target: NoteMoveTarget) => Promise<void>;
  onCreateFolderAndMove: (noteId: number, folderName: string) => void;
  onNewNote: (spaceId: number, folderId: number | null) => Promise<NoteItem | null>;
  onShowStructureIntro?: () => void;
  /** Fired when a row opens a note or container, so a non-notes view can yield. */
  onNavigate?: () => void;
}

const rowClass =
  "group relative flex items-center gap-2 rounded-md cursor-pointer select-none h-7 pe-2 transition-colors outline-none focus-visible:ring-1 focus-visible:ring-focus";

const buttonClass =
  "h-5 w-5 shrink-0 rounded-sm [&_svg]:size-3! opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 aria-expanded:opacity-100 data-[focus-visible]:opacity-100 transition-opacity text-muted hover:text-muted hover:bg-default";

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
      className="relative h-4 w-4 shrink-0 flex items-center justify-center rounded-sm text-muted hover:text-foreground/80"
    >
      <span className="absolute inset-0 flex items-center justify-center transition-opacity group-hover:opacity-0">
        {icon}
      </span>
      <ChevronRight size={12} className={cn("transition-transform", open && "rotate-90")} />
    </button>
  );
}

/** Folder list with search and inline folder creation; shared by the move dialog and popovers. */
export function MoveFolderPicker({
  note,
  spaces,
  folders,
  onMove,
  onCreateFolderAndMove,
  onDone,
  t,
}: {
  note: NoteItem;
  spaces: SpaceItem[];
  folders: FolderItem[];
  onMove: (target: NoteMoveTarget) => void;
  onCreateFolderAndMove: (id: number, name: string) => void;
  onDone: () => void;
  t: TFn;
}) {
  const [search, setSearch] = useState("");
  const [newFolder, setNewFolder] = useState("");

  const options = useMemo(
    () =>
      // Same as the sidebar: only the private space exists, and its root reads "Notes".
      spaces
        .filter((space) => space.kind === "private")
        .flatMap((space) => [
          {
            key: spaceContainerKey(space.id),
            label: t("sidebar.notes"),
            target: { spaceId: space.id, folderId: null },
            isSpace: true,
          },
          ...folders
            .filter((folder) => folder.space_id === space.id)
            .map((folder) => ({
              key: folderContainerKey(folder.id),
              label: defaultFolderDisplayName(folder, t),
              target: { spaceId: space.id, folderId: folder.id },
              isSpace: false,
            })),
        ]),
    [folders, spaces, t]
  );

  const filtered = search
    ? options.filter((option) => option.label.toLowerCase().includes(search.toLowerCase()))
    : options;

  return (
    <div className="flex flex-col gap-3">
      {options.length > 5 && (
        <input
          dir="auto"
          autoFocus
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("notes.context.searchFolders")}
          className="h-8 rounded-lg px-2.5 text-sm"
        />
      )}
      <div className="-mx-1 max-h-64 overflow-y-auto">
        {filtered.map((option) => {
          const isCurrent =
            option.target.folderId === note.folder_id &&
            option.target.spaceId === note.space_id &&
            note.folder_ids.length <= 1;

          return (
            <button
              key={option.key}
              type="button"
              disabled={isCurrent}
              onClick={() => {
                onMove(option.target);
                onDone();
              }}
              className={cn(MENU_ITEM_CLASS, "w-full", !option.isSpace && "ps-7")}
            >
              {option.isSpace ? (
                <Folder size={14} className="shrink-0 text-muted" />
              ) : (
                <FolderOpen size={14} className="shrink-0 text-muted" />
              )}
              <span
                dir="auto"
                className={cn("flex-1 truncate text-start", option.isSpace && "font-medium")}
              >
                {option.label}
              </span>
              {isCurrent && <Check size={14} className="shrink-0 text-primary" />}
            </button>
          );
        })}
        {search && filtered.length === 0 && (
          <p className="py-2 text-center text-xs text-muted">{t("notes.context.noResults")}</p>
        )}
      </div>
      <div className="flex items-center gap-2 border-t border-border pt-3">
        <Plus size={14} className="shrink-0 text-muted" />
        <input
          dir="auto"
          value={newFolder}
          onChange={(e) => setNewFolder(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && newFolder.trim()) {
              onCreateFolderAndMove(note.id, newFolder.trim());
              onDone();
            }
          }}
          placeholder={t("notes.context.newFolder")}
          className="input-inline h-7 flex-1 border-none bg-transparent text-sm outline-none"
        />
      </div>
    </div>
  );
}

function MoveDialog({
  open,
  onOpenChange,
  t,
  ...picker
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  note: NoteItem;
  spaces: SpaceItem[];
  folders: FolderItem[];
  onMove: (target: NoteMoveTarget) => void;
  onCreateFolderAndMove: (id: number, name: string) => void;
  t: TFn;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xs" className="gap-3">
        <DialogHeader>
          <DialogTitle>{t("notes.context.moveToFolder")}</DialogTitle>
        </DialogHeader>
        <MoveFolderPicker {...picker} t={t} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

/** Page point a right-click opened the menu at; the menu then anchors there instead of at the "…". */
export type ContextPoint = { x: number; y: number };

/** Row "…" menu, also opened by a right-click; swallows clicks so pressing it never activates the row. */
export function RowMenu({
  label,
  onAction,
  children,
  contextPoint = null,
  onContextPointChange,
}: {
  label: string;
  onAction: (key: string) => void;
  children: React.ReactNode;
  contextPoint?: ContextPoint | null;
  onContextPointChange?: (point: ContextPoint | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (contextPoint) setOpen(true);
  }, [contextPoint]);

  return (
    <span
      className="contents"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {contextPoint && (
        <span
          ref={anchorRef}
          aria-hidden="true"
          className="pointer-events-none fixed size-0"
          style={{ left: contextPoint.x, top: contextPoint.y }}
        />
      )}
      <Dropdown
        isOpen={open}
        onOpenChange={(next) => {
          setOpen(next);

          if (!next) onContextPointChange?.(null);
        }}
      >
        <Dropdown.Trigger
          aria-label={label}
          className={cn(buttonClass, "flex items-center justify-center")}
        >
          <MoreHorizontal size={12} />
        </Dropdown.Trigger>
        <Dropdown.Popover
          placement={contextPoint ? "bottom start" : "bottom end"}
          triggerRef={contextPoint ? anchorRef : undefined}
          className="min-w-44"
        >
          <Dropdown.Menu aria-label={label} onAction={(key) => onAction(String(key))}>
            {children}
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
    </span>
  );
}

/** Right-click menu at the pointer for areas that have no "…" button of their own. */
function PointMenu({
  point,
  onClose,
  label,
  onAction,
  children,
}: {
  point: ContextPoint | null;
  onClose: () => void;
  label: string;
  onAction: (key: string) => void;
  children: React.ReactNode;
}) {
  return (
    <span
      className="pointer-events-none fixed size-0"
      style={{ left: point?.x ?? 0, top: point?.y ?? 0 }}
      onClick={(e) => e.stopPropagation()}
    >
      <Dropdown isOpen={point != null} onOpenChange={(open) => !open && onClose()}>
        <Dropdown.Trigger aria-label={label} className="pointer-events-none size-0 opacity-0" />
        <Dropdown.Popover placement="bottom start" className="min-w-44">
          <Dropdown.Menu aria-label={label} onAction={(key) => onAction(String(key))}>
            {children}
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
    </span>
  );
}

/** Emoji icon of a note or folder, or the default glyph. */
function RowGlyph({ icon, fallback }: { icon?: string | null; fallback: React.ReactNode }) {
  if (!icon) return <>{fallback}</>;

  return (
    <span
      aria-hidden="true"
      className="flex size-3.5 shrink-0 items-center justify-center text-[13px] leading-none"
    >
      {icon}
    </span>
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
  onRename,
  onSetIcon,
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
  onRename: (title: string) => void;
  onSetIcon: (icon: string | null) => void;
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
  const locale = useUiLocale();
  const { dateFormat, timeFormat } = useDateTimePreferences();
  const isMeeting = note.note_type === "meeting";

  const tooltip = [
    note.title || t("notes.list.untitled"),
    `${isMeeting ? t("notes.context.meetingNote") : t("notes.context.plainNote")} · ${formatNoteDate(note.created_at, locale, dateFormat, timeFormat)}`,
  ].join("\n");

  const [moveOpen, setMoveOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [iconOpen, setIconOpen] = useState(false);
  const [contextPoint, setContextPoint] = useState<ContextPoint | null>(null);

  return (
    <Popover open={iconOpen} onOpenChange={setIconOpen}>
      <PopoverAnchor>
        <div
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setContextPoint({ x: e.clientX, y: e.clientY });
          }}
          title={tooltip}
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
            selected && "bg-default",
            level === 1 ? "ps-2" : "ps-[22px]",
            dragState.draggingNoteId === note.id && "opacity-40"
          )}
        >
          <RowGlyph
            icon={note.icon}
            fallback={
              isMeeting ? (
                <AudioLines size={14} className="shrink-0 text-muted" />
              ) : (
                <FileText size={14} className="shrink-0 text-muted" />
              )
            }
          />
          {renaming ? (
            <InlineRename
              initialValue={note.title}
              onCancel={() => setRenaming(false)}
              onCommit={(value) => {
                setRenaming(false);
                const title = value.trim();

                if (title && title !== note.title) onRename(title);
              }}
            />
          ) : (
            <span dir="auto" className="text-ui truncate min-w-0 flex-1 text-foreground/85">
              {note.title || t("notes.list.untitled")}
            </span>
          )}
          <RowMenu
            label={t("common.actions")}
            contextPoint={contextPoint}
            onContextPointChange={setContextPoint}
            onAction={(key) => {
              if (key === "rename") setRenaming(true);
              else if (key === "icon") setIconOpen(true);
              else if (key === "show")
                runInBackground(
                  Promise.resolve(window.electronAPI?.showNoteFile?.(note.id)),
                  "Show note file failed"
                );
              else if (key === "move") setMoveOpen(true);
              else if (key === "delete") onDelete(note.id);
            }}
          >
            {noteFilesEnabled && (
              <Dropdown.Item
                id="show"
                textValue={t("notes.context.showInFileManager", { manager: managerName() })}
              >
                <ExternalLink size={14} className="shrink-0 text-muted" />
                <Label>{t("notes.context.showInFileManager", { manager: managerName() })}</Label>
              </Dropdown.Item>
            )}
            <Dropdown.Item id="rename" textValue={t("notes.context.rename")}>
              <Pencil size={14} className="shrink-0 text-muted" />
              <Label>{t("notes.context.rename")}</Label>
            </Dropdown.Item>
            <Dropdown.Item id="icon" textValue={t("notes.context.changeIcon")}>
              <Smile size={14} className="shrink-0 text-muted" />
              <Label>{t("notes.context.changeIcon")}</Label>
            </Dropdown.Item>
            <Dropdown.Item id="move" textValue={t("notes.context.moveToFolder")}>
              <FolderOpen size={14} className="shrink-0 text-muted" />
              <Label>{t("notes.context.moveToFolder")}…</Label>
            </Dropdown.Item>
            <Separator className="my-1" />
            <Dropdown.Item id="delete" variant="danger" textValue={t("notes.context.delete")}>
              <Trash2 size={14} className="shrink-0" />
              <Label>{t("notes.context.delete")}</Label>
            </Dropdown.Item>
          </RowMenu>
          <MoveDialog
            open={moveOpen}
            onOpenChange={setMoveOpen}
            note={note}
            spaces={spaces}
            folders={folders}
            onMove={onMove}
            onCreateFolderAndMove={onCreateFolderAndMove}
            t={t}
          />
        </div>
      </PopoverAnchor>
      <PopoverContent align="start" className="p-2">
        <EmojiIconGrid
          value={note.icon}
          onSelect={(icon) => {
            setIconOpen(false);
            onSetIcon(icon);
          }}
        />
      </PopoverContent>
    </Popover>
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
  onSetStyle,
  reorder,
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
  onSetStyle: (style: FolderStyle) => void;
  reorder: {
    hint: "before" | "after" | null;
    draggable: true;
    onDragStart: (e: React.DragEvent) => void;
    onDragEnd: () => void;
    onDragOver: (e: React.DragEvent) => boolean;
    onDrop: (e: React.DragEvent) => boolean;
  };
  onMove: (space: SpaceItem) => void;
  onDelete: () => void;
  a11y: RowA11y;
  t: TFn;
  children: React.ReactNode;
}) {
  const [iconOpen, setIconOpen] = useState(false);
  const [contextPoint, setContextPoint] = useState<ContextPoint | null>(null);
  // Pastel row background from the folder colour; a hex plus 2-digit alpha.
  const tint = folder.color ? folderColorHex(folder.color) : undefined;

  return (
    <>
      <Popover open={iconOpen} onOpenChange={setIconOpen}>
        <PopoverAnchor>
          <div
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setContextPoint({ x: e.clientX, y: e.clientY });
            }}
            role="treeitem"
            aria-selected={selected}
            {...dropHandlers}
            draggable={reorder.draggable}
            onDragStart={reorder.onDragStart}
            onDragEnd={reorder.onDragEnd}
            onDragOver={(e) => {
              if (!reorder.onDragOver(e)) dropHandlers.onDragOver(e);
            }}
            onDrop={(e) => {
              if (!reorder.onDrop(e)) dropHandlers.onDrop(e);
            }}
            aria-level={level}
            aria-expanded={expanded}
            tabIndex={a11y.tabIndex}
            ref={a11y.rowRef}
            onKeyDown={a11y.onKeyDown}
            onFocus={a11y.onFocus}
            onClick={onOpen}
            style={tint ? tintStyle(tint) : undefined}
            className={cn(
              rowClass,
              "ps-2",
              tint
                ? selected
                  ? "bg-(--tint-strong)"
                  : "bg-(--tint) hover:bg-(--tint-strong)"
                : selected && "bg-default",
              highlighted && "ring-1 ring-primary bg-primary/10",
              reorder.hint === "before" && "shadow-[inset_0_2px_0_var(--color-primary)]",
              reorder.hint === "after" && "shadow-[inset_0_-2px_0_var(--color-primary)]"
            )}
          >
            <TreeToggle
              open={expanded}
              onToggle={onToggle}
              icon={<RowGlyph icon={folder.icon} fallback={<Folder size={14} />} />}
            />
            <span className="text-ui truncate flex-1 text-foreground/85">
              {defaultFolderDisplayName(folder, t)}
              {count > 0 && <span className="ms-1 text-2xs text-muted">{count}</span>}
            </span>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("notes.context.newNoteInFolder")}
              title={t("notes.context.newNoteInFolder")}
              onClick={(e) => {
                e.stopPropagation();
                onNewNote();
              }}
              className={buttonClass}
            >
              <Plus size={12} />
            </Button>
            <RowMenu
              label={t("common.actions")}
              contextPoint={contextPoint}
              onContextPointChange={setContextPoint}
              onAction={(key) => {
                if (key === "icon") setIconOpen(true);
                else if (key === "show")
                  runInBackground(
                    Promise.resolve(window.electronAPI?.showFolderInExplorer?.(folder.name)),
                    "Show folder failed"
                  );
                else if (key === "rename") onRename();
                else if (key === "delete") onDelete();
                else if (key.startsWith("space:")) {
                  const space = spaces.find((item) => `space:${item.id}` === key);

                  if (space) onMove(space);
                }
              }}
            >
              {noteFilesEnabled && (
                <Dropdown.Item
                  id="show"
                  textValue={t("notes.context.showInFileManager", { manager: managerName() })}
                >
                  <ExternalLink size={14} className="shrink-0 text-muted" />
                  <Label>{t("notes.context.showInFileManager", { manager: managerName() })}</Label>
                </Dropdown.Item>
              )}
              <Dropdown.Item id="icon" textValue={t("notes.context.changeIcon")}>
                <Smile size={14} className="shrink-0 text-muted" />
                <Label>{t("notes.context.changeIcon")}</Label>
              </Dropdown.Item>
              <Dropdown.Item id="rename" textValue={t("notes.context.rename")}>
                <Pencil size={14} className="shrink-0 text-muted" />
                <Label>{t("notes.context.rename")}</Label>
              </Dropdown.Item>
              {spaces.length > 1 && (
                <Dropdown.SubmenuTrigger>
                  <Dropdown.Item id="move-space" textValue={t("notes.spaces.moveToSpace")}>
                    <FolderOpen size={14} className="shrink-0 text-muted" />
                    <Label>{t("notes.spaces.moveToSpace")}</Label>
                    <Dropdown.SubmenuIndicator />
                  </Dropdown.Item>
                  <Dropdown.Popover className="min-w-40">
                    <Dropdown.Menu
                      aria-label={t("notes.spaces.moveToSpace")}
                      disabledKeys={[`space:${folder.space_id}`]}
                      onAction={(key) => {
                        const space = spaces.find((item) => `space:${item.id}` === key);

                        if (space) onMove(space);
                      }}
                    >
                      {spaces.map((space) => (
                        <Dropdown.Item
                          key={space.id}
                          id={`space:${space.id}`}
                          textValue={space.name}
                        >
                          <Label dir="auto">{space.name}</Label>
                        </Dropdown.Item>
                      ))}
                    </Dropdown.Menu>
                  </Dropdown.Popover>
                </Dropdown.SubmenuTrigger>
              )}
              <Separator className="my-1" />
              <Dropdown.Item id="delete" variant="danger" textValue={t("notes.context.delete")}>
                <Trash2 size={14} className="shrink-0" />
                <Label>{t("notes.context.delete")}</Label>
              </Dropdown.Item>
            </RowMenu>
          </div>
        </PopoverAnchor>
        <PopoverContent align="start" className="p-2">
          <EmojiIconGrid
            value={folder.icon}
            color={folder.color}
            onSelect={(icon) => {
              setIconOpen(false);
              onSetStyle({ icon });
            }}
            onColorSelect={(color) => onSetStyle({ color })}
          />
        </PopoverContent>
      </Popover>
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
  onNewNote: onNewNoteProp,
  onNavigate,
}: SpacesTreeProps) {
  const { t, i18n } = useTranslation();
  const { toast, dismiss } = useToast();

  const onNewNote = (spaceId: number, folderId: number | null) =>
    runInBackground(
      onNewNoteProp(spaceId, folderId).then((note) => {
        if (note) onNavigate?.();
      }),
      "Create note failed"
    );

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
  const folderDragId = useRef<number | null>(null);

  const [folderHint, setFolderHint] = useState<{ id: number; pos: "before" | "after" } | null>(
    null
  );

  const [treeMenu, setTreeMenu] = useState<{ point: ContextPoint; spaceId: number } | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const undoToast = useRef<string | null>(null);
  const { confirmDialog, showConfirmDialog, hideConfirmDialog } = useDialogs();
  const capturePhase = useMeetingRecordingStore((state) => state.capturePhase);
  const recordingNoteId = useMeetingRecordingStore((state) => state.recordingNoteId);

  const rows = useMemo<TreeRow[]>(() => {
    const result: TreeRow[] = [];

    for (const space of spaces) {
      const spaceKey = spaceContainerKey(space.id);

      for (const folder of folders.filter((item) => item.space_id === space.id)) {
        const folderKey = folderContainerKey(folder.id);
        result.push({ type: "folder", key: folderKey, folder, level: 1 });

        // Placement-aware key: the same note in two expanded folders must stay
        // two independent rows for refs and keyboard navigation.
        if (expanded.has(folderKey))
          for (const note of notesByContainer[folderKey] ?? [])
            result.push({
              type: "note",
              key: `${folderKey}:n:${note.id}`,
              note,
              parentKey: folderKey,
              level: 2,
            });
      }

      for (const note of notesByContainer[spaceKey] ?? [])
        result.push({ type: "note", key: `${spaceKey}:n:${note.id}`, note, level: 1 });
    }

    return result;
  }, [expanded, folders, notesByContainer, spaces]);

  // The space itself has no row, so its root notes must load without an expand click.
  const spaceIds = spaces.map((space) => space.id).join(",");
  useEffect(() => {
    for (const id of spaceIds.split(",").filter(Boolean))
      setContainerExpanded(spaceContainerKey(Number(id)), true);
  }, [spaceIds]);

  const focusRow = (key?: string) => {
    if (!key) return;
    setFocusedKey(key);
    requestAnimationFrame(() => rowRefs.current.get(key)?.focus());
  };

  // Keyboard focus survives its placement disappearing (folder collapsed,
  // placement removed): follow the same note, preferring a placement in the
  // same space — hopping spaces from one placement of a note is wrong tree
  // semantics. No placement at all clears focus instead of picking rows[0].
  useEffect(() => {
    if (!focusedKey) return;

    if (rows.some((row) => row.key === focusedKey)) return;

    const spaceOf = (key: string): number | null => {
      const container = key.match(/^(.+):n:/)?.[1];

      if (!container) return null;

      if (container.startsWith("space:")) return Number(container.slice("space:".length));

      return (
        folders.find((folder) => folderContainerKey(folder.id) === container)?.space_id ?? null
      );
    };

    const match = focusedKey.match(/^(.+):n:(\d+)$/);
    const noteId = match ? Number(match[2]) : null;
    const placements = noteId == null ? [] : rows.filter((row) => row.note?.id === noteId);
    const lostSpace = spaceOf(focusedKey);
    setFocusedKey(
      (placements.find((row) => spaceOf(row.key) === lostSpace) ?? placements[0])?.key ?? null
    );
  }, [focusedKey, rows, folders]);

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

        if (row?.type === "note" && row.note) {
          setActiveNoteId(row.note.id);
          onNavigate?.();
        } else if (row) toggleContainerExpanded(row.key);
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

      const previous = {
        spaceId: note.space_id,
        folderId: note.folder_id,
        folderIds: note.folder_ids,
      };

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
              runInBackground(onMoveNote(id, previous), "Undo note move failed");
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

  const rename = async (folder: FolderItem, value: string) => {
    const name = value.trim();
    setRenamingFolder(null);

    if (!name || name === folder.name) return;
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
      onConfirm: () =>
        runInBackground(
          deleteFolder(folder.id).then((result) => {
            if (!result.success && result.error)
              toast({
                title: t("notes.folders.couldNotDelete"),
                description: t(localMutationErrorKey(result.error)),
                variant: "destructive",
              });
          }),
          "Delete folder failed"
        ),
    });

  if (loading && spaces.length === 0)
    return (
      <div className="flex-1 flex items-start justify-center py-8">
        <Loader2 size={12} className="animate-spin text-muted" />
      </div>
    );

  const renderNote = (note: NoteItem, level: 1 | 2, containerKey: string) => (
    <NoteRow
      key={`${containerKey}:n:${note.id}`}
      note={note}
      selected={activeNoteId === note.id}
      level={level}
      spaces={spaces}
      folders={folders}
      noteFilesEnabled={noteFilesEnabled}
      onOpen={() => {
        setActiveContext(note.space_id, note.folder_id);
        setActiveNoteId(note.id);
        onNavigate?.();
      }}
      onMove={(target) => {
        runInBackground(moveNote(note.id, target), "Note move failed");
      }}
      onCreateFolderAndMove={onCreateFolderAndMove}
      onRename={(title) => void window.electronAPI.updateNote(note.id, { title })}
      onSetIcon={(icon) => void window.electronAPI.updateNote(note.id, { icon })}
      onDelete={() => {
        const activeCapture =
          recordingNoteId === note.id &&
          ["preparing", "recording", "saving"].includes(capturePhase);

        if (!activeCapture) {
          onDeleteNote(note.id);

          return;
        }

        showConfirmDialog({
          title: t("meetingResults.deleteActiveNoteTitle"),
          description: t("meetingResults.deleteActiveNoteDescription"),
          confirmText: t("meetingResults.deleteAudioConfirm"),
          variant: "destructive",
          onConfirm: () =>
            runInBackground(
              (async () => {
                try {
                  const result = await storeStopRecording(undefined, {
                    suppressProcessing: true,
                  });

                  if (!result.stopped) {
                    toast({
                      title: t("meetingResults.stopBeforeDeleteError"),
                      variant: "destructive",
                    });

                    return;
                  }

                  onDeleteNote(note.id);
                } catch (error) {
                  toast({
                    title: t("meetingResults.stopBeforeDeleteError"),
                    description: error instanceof Error ? error.message : String(error),
                    variant: "destructive",
                  });
                }
              })(),
              "Stop recording before delete failed"
            ),
        });
      }}
      a11y={a11y(`${containerKey}:n:${note.id}`)}
      t={t}
      dragState={dragState}
      noteDragHandlers={noteDragHandlers}
    />
  );

  const FOLDER_DRAG_TYPE = "application/x-gristmill-folder-id";
  const folderKeys = folders.map((folder) => folderContainerKey(folder.id));
  const anyFolderExpanded = folderKeys.some((key) => expanded.has(key));

  const setAllFoldersExpanded = (open: boolean) => {
    for (const key of folderKeys) setContainerExpanded(key, open);
  };

  const dropPosition = (e: React.DragEvent): "before" | "after" => {
    const rect = e.currentTarget.getBoundingClientRect();

    return e.clientY < rect.top + rect.height / 2 ? "before" : "after";
  };

  const reorderHandlers = (folder: FolderItem) => {
    const sameSpaceDrag = () => {
      const dragged = folders.find((item) => item.id === folderDragId.current);

      return dragged && dragged.id !== folder.id && dragged.space_id === folder.space_id
        ? dragged
        : null;
    };

    return {
      hint: folderHint?.id === folder.id ? folderHint.pos : null,
      draggable: true as const,
      onDragStart: (e: React.DragEvent) => {
        // Notes dragged out of a folder's children bubble through here too; only the row itself starts a folder drag.
        if (e.target !== e.currentTarget) return;
        folderDragId.current = folder.id;
        e.dataTransfer.setData(FOLDER_DRAG_TYPE, String(folder.id));
        e.dataTransfer.effectAllowed = "move";
      },
      onDragEnd: () => {
        folderDragId.current = null;
        setFolderHint(null);
      },
      onDragOver: (e: React.DragEvent) => {
        if (!sameSpaceDrag()) return false;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const pos = dropPosition(e);
        setFolderHint((hint) =>
          hint?.id === folder.id && hint.pos === pos ? hint : { id: folder.id, pos }
        );

        return true;
      },
      onDrop: (e: React.DragEvent) => {
        const dragged = sameSpaceDrag();

        if (!dragged) return false;
        e.preventDefault();
        const pos = dropPosition(e);

        const ids = folders
          .filter((item) => item.space_id === folder.space_id && item.id !== dragged.id)
          .map((item) => item.id);

        ids.splice(ids.indexOf(folder.id) + (pos === "after" ? 1 : 0), 0, dragged.id);
        folderDragId.current = null;
        setFolderHint(null);
        runInBackground(reorderFolders(folder.space_id, ids), "Reorder folders failed");

        return true;
      },
    };
  };

  const renderFolder = (folder: FolderItem, space: SpaceItem) => {
    const key = folderContainerKey(folder.id);

    if (renamingFolder === folder.id)
      return (
        <div key={folder.id} className="flex px-2">
          <InlineRename
            initialValue={folder.name}
            onCancel={() => setRenamingFolder(null)}
            onCommit={(value) => void rename(folder, value)}
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
        })}
        level={1}
        count={folderCounts[folder.id] ?? 0}
        noteFilesEnabled={noteFilesEnabled}
        spaces={spaces}
        expanded={expanded.has(key)}
        onToggle={() => toggleContainerExpanded(key)}
        onOpen={() => {
          // Folders have no page of their own: a click targets new notes here and toggles the row.
          setActiveContext(space.id, folder.id);
          toggleContainerExpanded(key);
        }}
        onNewNote={() => onNewNote(space.id, folder.id)}
        onRename={() => setRenamingFolder(folder.id)}
        onSetStyle={(style) => void updateFolderStyle(folder.id, style)}
        reorder={reorderHandlers(folder)}
        onMove={(target) => {
          runInBackground(moveFolderToSpace(folder.id, target.id), "Move folder failed");
        }}
        onDelete={() => removeFolder(folder)}
        a11y={a11y(key)}
        t={t}
      >
        {(notesByContainer[key] ?? []).map((note) => renderNote(note, 2, key))}
      </FolderRow>
    );
  };

  return (
    <>
      <div
        role="tree"
        aria-label={t("notes.list.title")}
        onContextMenu={(e) => {
          // Rows handle their own right-click; this catches the header and the empty space.
          e.preventDefault();

          if (spaces[0])
            setTreeMenu({ point: { x: e.clientX, y: e.clientY }, spaceId: spaces[0].id });
        }}
        className="scrollbar-hidden flex-1 overflow-y-auto px-1.5 pb-2 space-y-px"
      >
        {spaces.map((space) => {
          const key = spaceContainerKey(space.id);

          const count =
            (rootCounts[space.id] ?? 0) +
            folders
              .filter((folder) => folder.space_id === space.id)
              .reduce((sum, folder) => sum + (folderCounts[folder.id] ?? 0), 0);

          return (
            <div key={space.id} role="group" aria-label={t("sidebar.notes")}>
              <div
                {...dropTargetHandlers({ spaceId: space.id, folderId: null })}
                className={cn(
                  "group flex h-7 items-center gap-2 rounded-md ps-2 pe-2",
                  dragState.dragOverKey === key && "ring-1 ring-primary bg-primary/10"
                )}
              >
                <span className="flex-1 truncate text-xs font-medium text-muted">
                  {t("sidebar.notes")}
                </span>
                {count > 0 && <span className="text-2xs text-muted">{count}</span>}
                {folderKeys.length > 0 && (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={
                      anyFolderExpanded
                        ? t("notes.context.collapseAll")
                        : t("notes.context.expandAll")
                    }
                    title={
                      anyFolderExpanded
                        ? t("notes.context.collapseAll")
                        : t("notes.context.expandAll")
                    }
                    onClick={() => setAllFoldersExpanded(!anyFolderExpanded)}
                    className={buttonClass}
                  >
                    {anyFolderExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t("notes.context.addFolder")}
                  title={t("notes.context.addFolder")}
                  onClick={() => setNewFolderSpace(space.id)}
                  className={buttonClass}
                >
                  <Plus size={12} />
                </Button>
              </div>
              {newFolderSpace === space.id && (
                <div className="px-2">
                  <input
                    dir="auto"
                    autoFocus
                    value={newFolderName}
                    onChange={(e) => setNewFolderName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter")
                        runInBackground(createFolderIn(space.id), "Create folder failed");

                      if (e.key === "Escape") setNewFolderSpace(null);
                    }}
                    onBlur={() => void createFolderIn(space.id)}
                    className="w-full h-6 px-2 text-xs bg-default rounded"
                  />
                </div>
              )}
              {folders
                .filter((folder) => folder.space_id === space.id)
                .map((folder) => renderFolder(folder, space))}
              {(notesByContainer[key] ?? []).map((note) => renderNote(note, 1, key))}
            </div>
          );
        })}
      </div>
      <PointMenu
        point={treeMenu?.point ?? null}
        onClose={() => setTreeMenu(null)}
        label={t("common.actions")}
        onAction={(key) => {
          const spaceId = treeMenu?.spaceId;

          if (spaceId == null) return;

          if (key === "note") onNewNote(spaceId, null);
          else if (key === "folder") setNewFolderSpace(spaceId);
          else if (key === "toggle") setAllFoldersExpanded(!anyFolderExpanded);
        }}
      >
        <Dropdown.Item id="note" textValue={t("notes.list.newNote")}>
          <FileText size={14} className="shrink-0 text-muted" />
          <Label>{t("notes.list.newNote")}</Label>
        </Dropdown.Item>
        <Dropdown.Item id="folder" textValue={t("notes.context.addFolder")}>
          <Plus size={14} className="shrink-0 text-muted" />
          <Label>{t("notes.context.addFolder")}</Label>
        </Dropdown.Item>
        {folderKeys.length > 0 && (
          <Dropdown.Item
            id="toggle"
            textValue={
              anyFolderExpanded ? t("notes.context.collapseAll") : t("notes.context.expandAll")
            }
          >
            {anyFolderExpanded ? (
              <ChevronDown size={14} className="shrink-0 text-muted" />
            ) : (
              <ChevronRight size={14} className="shrink-0 text-muted" />
            )}
            <Label>
              {anyFolderExpanded ? t("notes.context.collapseAll") : t("notes.context.expandAll")}
            </Label>
          </Dropdown.Item>
        )}
      </PointMenu>
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
