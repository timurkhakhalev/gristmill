import { useCallback, useEffect, useMemo, useState } from "react";
import { useNotesByContainer } from "../../stores/noteStore";
import { useHomeChat } from "../../hooks/useHomeChat";
import { useUpcomingEvents } from "../../hooks/useUpcomingEvents";
import { useTranslation } from "react-i18next";
import ChatPanel, { type ChatPanelMode } from "../chat/ChatPanel";
import NoteBottomBar from "../notes/NoteBottomBar";
import ComingUp from "./ComingUp";
import RecentNotes from "./RecentNotes";
import type { NoteItem } from "../../contracts/notes";
import type { CalendarEvent } from "../../contracts/calendar";

const RECENT_NOTES_LIMIT = 50;
const EMPTY_NOTES: NoteItem[] = [];
const SUGGESTION_KEYS = ["catchUp", "keyDecisions", "inFlight"] as const;

interface HomeViewProps {
  onOpenNote: (note: NoteItem) => void;
  onConnectCalendar: () => void;
  onOpenEvent: (event: CalendarEvent) => void;
}

/** Start screen: upcoming calendar meetings, recent notes across every space,
 * and a chat pinned to the bottom that searches all notes. */
export default function HomeView({ onOpenNote, onConnectCalendar, onOpenEvent }: HomeViewProps) {
  const { t } = useTranslation();
  const upcoming = useUpcomingEvents();
  const notesByContainer = useNotesByContainer();
  const [notes, setNotes] = useState<NoteItem[] | null>(null);

  // The store only holds loaded containers, so the cross-space list is fetched
  // here and refreshed whenever any container's notes change.
  useEffect(() => {
    let stale = false;
    window.electronAPI
      .getNotes(null, RECENT_NOTES_LIMIT)
      .then((rows) => {
        if (!stale) setNotes(rows ?? []);
      })
      .catch(() => {
        if (!stale) setNotes([]);
      });
    return () => {
      stale = true;
    };
  }, [notesByContainer]);

  const chat = useHomeChat(notes ?? EMPTY_NOTES);
  const [chatMode, setChatMode] = useState<ChatPanelMode>("hidden");
  const suggestions = useMemo(
    () => SUGGESTION_KEYS.map((key) => t(`embeddedChat.suggestions.${key}`)),
    [t]
  );
  const askFromBar = useCallback(
    (text: string) => {
      setChatMode("floating");
      void chat.sendMessage(text);
    },
    [chat]
  );
  // Chat citations can point past the recent list, so fall back to a lookup.
  const openNoteById = async (id: number) => {
    const note =
      notes?.find((item) => item.id === id) ?? (await window.electronAPI.getNote(id));
    if (note) onOpenNote(note);
  };

  return (
    <div className="flex min-h-full flex-col">
      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-10 px-6 pt-8 pb-6">
        <ComingUp
          events={upcoming.events}
          isLoading={upcoming.isLoading}
          isConnected={upcoming.isConnected}
          onConnectCalendar={onConnectCalendar}
          onOpenEvent={onOpenEvent}
        />
        {notes && <RecentNotes notes={notes} onOpenNote={onOpenNote} />}
      </div>
      <div className="pointer-events-none sticky bottom-0 bg-linear-to-t from-background from-60% to-transparent pt-6">
        <NoteBottomBar
          isRecording={false}
          onAskSubmit={askFromBar}
          onInputFocus={() => {
            if (chat.messages.length > 0) setChatMode("floating");
          }}
          hideInput={chatMode !== "hidden"}
        />
        <div className="pointer-events-auto">
          <ChatPanel
            mode={chatMode === "hidden" ? "hidden" : "floating"}
            onModeChange={setChatMode}
            floatingMaxHeight="calc(100vh - 8rem)"
            messages={chat.messages}
            agentState={chat.agentState}
            onTextSubmit={chat.sendMessage}
            onCancel={chat.cancelStream}
            conversations={chat.conversations}
            activeConversationId={chat.activeConversationId}
            onSwitchConversation={chat.switchConversation}
            onNewChat={chat.startNewChat}
            suggestions={suggestions}
            emptyStateText={t("embeddedChat.homeEmptyState")}
            onOpenNote={openNoteById}
          />
        </div>
      </div>
    </div>
  );
}
