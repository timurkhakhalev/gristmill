import { useState, useCallback, useRef, useEffect } from "react";
import { folderContainerKey, ROOT_CONTAINER_KEY, runInBackground } from "../stores/noteStore";

export interface NoteMoveTarget {
  folderId: number | null;
  /** Full folder set to restore (undo); a plain move leaves only folderId. */
  folderIds?: number[];
}

export interface DraggedNoteInfo {
  id: number;
  title: string;
  folderId: number | null;
}

interface DropTargetInfo extends NoteMoveTarget {}

interface DragState {
  draggingNoteId: number | null;
  dragOverKey: string | null;
  dropSuccessKey: string | null;
}

interface UseNoteDragAndDropOptions {
  untitledLabel: string;
  onMoveToTarget: (noteId: number, target: NoteMoveTarget) => void | Promise<void>;
  /** Fired after hovering a target for 500ms mid-drag (auto-expand collapsed containers). */
  onHoverTarget?: (key: string) => void;
}

const HOVER_EXPAND_DELAY_MS = 500;

function targetKey(target: NoteMoveTarget): string {
  return target.folderId != null ? folderContainerKey(target.folderId) : ROOT_CONTAINER_KEY;
}

export function useNoteDragAndDrop({
  untitledLabel,
  onMoveToTarget,
  onHoverTarget,
}: UseNoteDragAndDropOptions) {
  const [dragState, setDragState] = useState<DragState>({
    draggingNoteId: null,
    dragOverKey: null,
    dropSuccessKey: null,
  });

  const successTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const hoverTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const hoverKeyRef = useRef<string | null>(null);
  const enterCounterRef = useRef<Map<string, number>>(new Map());
  const draggedNoteRef = useRef<DraggedNoteInfo | null>(null);

  const clearHoverTimeout = useCallback(() => {
    if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
    hoverTimeoutRef.current = null;
    hoverKeyRef.current = null;
  }, []);

  useEffect(() => {
    return () => {
      if (successTimeoutRef.current) clearTimeout(successTimeoutRef.current);

      if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
    };
  }, []);

  const noteDragHandlers = useCallback(
    (note: DraggedNoteInfo) => ({
      draggable: true as const,
      onDragStart: (e: React.DragEvent) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("application/x-note-id", String(note.id));

        const ghost = document.createElement("div");
        const label = note.title || untitledLabel;
        ghost.textContent = label.length > 24 ? label.slice(0, 24) + "…" : label;
        ghost.style.cssText = `
          position: fixed; top: -200px; left: -200px;
          padding: 4px 12px;
          background: color-mix(in oklch, var(--color-popover) 95%, transparent);
          color: var(--color-popover-foreground);
          font-size: 11px;
          font-weight: 500;
          border-radius: 6px;
          border: 1px solid var(--color-border);
          white-space: nowrap;
          pointer-events: none;
        `;
        document.body.appendChild(ghost);
        e.dataTransfer.setDragImage(ghost, 0, 0);
        requestAnimationFrame(() => ghost.remove());

        draggedNoteRef.current = note;
        setDragState((prev) => ({ ...prev, draggingNoteId: note.id }));
        enterCounterRef.current.clear();
      },
      onDragEnd: () => {
        draggedNoteRef.current = null;
        clearHoverTimeout();
        setDragState((prev) => ({
          ...prev,
          draggingNoteId: null,
          dragOverKey: null,
        }));
        enterCounterRef.current.clear();
      },
    }),
    [clearHoverTimeout, untitledLabel]
  );

  const commitDrop = useCallback(
    (noteId: number, target: NoteMoveTarget, key: string) => {
      setDragState((prev) => ({ ...prev, dropSuccessKey: key }));

      if (successTimeoutRef.current) clearTimeout(successTimeoutRef.current);
      successTimeoutRef.current = setTimeout(() => {
        setDragState((prev) =>
          prev.dropSuccessKey === key ? { ...prev, dropSuccessKey: null } : prev
        );
      }, 800);
      runInBackground(Promise.resolve(onMoveToTarget(noteId, target)), "Note move failed");
    },
    [onMoveToTarget]
  );

  const dropTargetHandlers = useCallback(
    (targetInfo: DropTargetInfo) => {
      const target: NoteMoveTarget = { folderId: targetInfo.folderId };
      const key = targetKey(target);

      const canDrop = () => {
        const note = draggedNoteRef.current;

        if (!note) return false;

        const isSameContainer =
          target.folderId != null ? note.folderId === target.folderId : note.folderId == null;

        if (isSameContainer) return false;

        return true;
      };

      return {
        onDragOver: (e: React.DragEvent) => {
          if (!canDrop()) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        },
        onDragEnter: (e: React.DragEvent) => {
          e.preventDefault();

          if (!canDrop()) return;

          const count = (enterCounterRef.current.get(key) ?? 0) + 1;
          enterCounterRef.current.set(key, count);

          if (count === 1) {
            setDragState((prev) => ({ ...prev, dragOverKey: key }));

            if (onHoverTarget) {
              clearHoverTimeout();
              hoverKeyRef.current = key;
              hoverTimeoutRef.current = setTimeout(() => onHoverTarget(key), HOVER_EXPAND_DELAY_MS);
            }
          }
        },
        onDragLeave: () => {
          if (!canDrop()) return;
          const count = (enterCounterRef.current.get(key) ?? 0) - 1;
          enterCounterRef.current.set(key, Math.max(0, count));

          if (count <= 0) {
            enterCounterRef.current.set(key, 0);

            if (hoverKeyRef.current === key) clearHoverTimeout();
            setDragState((prev) =>
              prev.dragOverKey === key ? { ...prev, dragOverKey: null } : prev
            );
          }
        },
        onDrop: (e: React.DragEvent) => {
          e.preventDefault();

          if (!canDrop()) return;

          const note = draggedNoteRef.current;
          const noteId = parseInt(e.dataTransfer.getData("application/x-note-id"), 10);

          if (!note || isNaN(noteId) || noteId !== note.id) return;

          clearHoverTimeout();
          enterCounterRef.current.clear();
          draggedNoteRef.current = null;
          setDragState((prev) => ({
            ...prev,
            draggingNoteId: null,
            dragOverKey: null,
          }));

          commitDrop(noteId, target, key);
        },
      };
    },
    [onHoverTarget, commitDrop, clearHoverTimeout]
  );

  return { dragState, noteDragHandlers, dropTargetHandlers };
}
