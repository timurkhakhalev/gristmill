import { useEffect, useMemo, useState } from "react";
import { Plus } from "../../icons";
import { useTranslation } from "react-i18next";
import {
  useNotes,
  useNotesByContainer,
  useFolders,
  useFolderCounts,
  useSpaceRootCounts,
} from "../../../stores/noteStore";
import { useContainerChat } from "../../../hooks/useContainerChat";
import { ContainerIcon } from "./ContainerIcon";
import { OverviewAskSection } from "./OverviewAskSection";
import { OverviewNoteList } from "./OverviewNoteList";
import { defaultFolderDisplayName } from "../shared";
import type { SpaceItem, FolderItem } from "../../../contracts/containers";
import type { NoteItem } from "../../../contracts/notes";

const SPACE_NOTES_LIMIT = 50;

interface ContainerOverviewProps {
  space: SpaceItem;
  folder: FolderItem | null;
  onOpenNote: (noteId: number) => void;
  onNewNote: () => void;
  onAddExisting?: () => void;
}

export function ContainerOverview({
  space,
  folder,
  onOpenNote,
  onNewNote,
  onAddExisting,
}: ContainerOverviewProps) {
  const { t } = useTranslation();
  const folders = useFolders();
  const containerNotes = useNotes();
  const notesByContainer = useNotesByContainer();
  const folderCounts = useFolderCounts();
  const spaceRootCounts = useSpaceRootCounts();
  const [spaceNotes, setSpaceNotes] = useState<NoteItem[] | null>(null);

  // Folder overviews mirror the store's active container; space overviews list
  // the whole space (foldered + root), which the store doesn't hold — fetched
  // here and refreshed whenever any container's notes change.
  useEffect(() => {
    if (folder) return;
    let stale = false;
    window.electronAPI
      .getSpaceNotes(space.id, SPACE_NOTES_LIMIT)
      .then((rows) => {
        if (!stale) setSpaceNotes(rows ?? []);
      })
      .catch(() => {
        if (!stale) setSpaceNotes([]);
      });
    return () => {
      stale = true;
    };
  }, [folder, space.id, notesByContainer]);

  const notes = folder ? containerNotes : (spaceNotes ?? []);

  const chat = useContainerChat({ space, folder, notes });

  const spaceFolders = useMemo(
    () => folders.filter((f) => f.space_id === space.id),
    [folders, space.id]
  );
  // DB-backed counts, as in SpacesTree: the visible list is capped at the
  // container page size, so notes.length undercounts large containers.
  const noteCount = folder
    ? (folderCounts[folder.id] ?? notes.length)
    : spaceFolders.reduce((sum, f) => sum + (folderCounts[f.id] ?? 0), 0) +
      (spaceRootCounts[space.id] ?? 0);

  const metaParts: string[] = [];
  if (!folder && spaceFolders.length > 0) {
    metaParts.push(t("notes.overview.meta.folders", { count: spaceFolders.length }));
  }
  metaParts.push(t("notes.spaces.noteCount", { count: noteCount }));

  return (
    <div className="flex-1 overflow-y-auto min-h-0">
      <div className="max-w-2xl mx-auto px-6 py-8 flex flex-col gap-5">
        <div className="flex flex-col items-center text-center gap-2 pt-4">
          <div className="h-12 w-12 rounded-xl bg-default dark:bg-white/5 border border-border flex items-center justify-center mb-1">
            <ContainerIcon space={space} folder={folder} size={20} />
          </div>
          <h1 className="text-xl font-semibold text-foreground tracking-tight">
            {folder ? defaultFolderDisplayName(folder, t) : space.name}
          </h1>
          <p className="text-ui text-muted">
            {t("notes.overview.subtitle.private")}
          </p>
          <p className="text-xs text-muted">
            {metaParts.join(" · ")}
          </p>
          <div className="mt-1 flex items-center gap-2">
            {/* The empty state keeps its own focal create CTA in the list. */}
            {notes.length > 0 && (
              <button
                onClick={onNewNote}
                className="inline-flex items-center gap-1.5 px-3 h-7 rounded-md border border-border text-xs font-medium text-muted hover:text-foreground/85 hover:border-border/70 hover:bg-default dark:hover:bg-white/3 transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-focus"
              >
                <Plus size={12} />
                {t("notes.list.newNote")}
              </button>
            )}
          </div>
        </div>

        <OverviewAskSection
          messages={chat.messages}
          agentState={chat.agentState}
          onTextSubmit={chat.sendMessage}
          onCancel={chat.cancelStream}
          conversations={chat.conversations}
          activeConversationId={chat.activeConversationId}
          onSwitchConversation={chat.switchConversation}
          onNewChat={chat.startNewChat}
          onOpenNote={onOpenNote}
        />

        <div className="border-t border-border">
          <OverviewNoteList
            notes={notes}
            space={space}
            onOpenNote={onOpenNote}
            onNewNote={onNewNote}
            onAddExisting={onAddExisting}
          />
        </div>
      </div>

    </div>
  );
}
