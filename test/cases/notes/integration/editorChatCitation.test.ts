// Issue #185 (review round 2): the editor's embedded-chat citations route
// through openChatNote, which fetched the row but only wrote the id — an
// out-of-cache citation kept the editor in the skeleton forever. openChatNote
// now hands the fetched row to openNoteRow (held or fetched, generation
// guarded). This mounts the real NoteEditor with mocked leaves and drives the
// ChatPanel's onOpenNote seam exactly like a citation click does.
const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const test: typeof import("node:test") = require("node:test");

const path = require("node:path");

const React = require("react") as typeof import("react");

const { createRoot } = require("react-dom/client");

const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
}: typeof import("../../../lib/rendererTestHarness.ts") = require("../../../lib/rendererTestHarness.ts");

import type { NoteItem } from "../../../../src/contracts/notes";

const tick = () => new Promise((resolve) => setImmediate(resolve));

function note(id: number, title: string): NoteItem {
  return {
    id,
    title,
    content: `body ${id}`,
    note_type: "personal",
    folder_id: null,
    folder_ids: [],
    source_file: null,
    audio_duration_seconds: null,
    created_at: "2026-10-02",
    updated_at: "2026-10-02",
    enhanced_content: null,
    enhancement_prompt: null,
    enhanced_at_content_hash: null,
    transcript: null,
    calendar_event_id: null,
    participants: null,
    diarization_enabled: null,
    expected_speaker_count: null,
  };
}

test("an editor chat citation for an out-of-cache note opens it in the editor", async (t) => {
  let root: ReturnType<typeof createRoot> | null = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });

  const rows = Array.from({ length: 51 }, (_, index) => note(index + 1, `Note ${index + 1}`));
  const cited = note(999, "Cited ancient");
  let getNoteCalls = 0;
  installBrowserGlobals(t, {
    window: {
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
      electronAPI: {
        getFolders: async () => [],
        getFolderNoteCounts: async () => [],
        getNotes: async () => rows,
        getRootNotes: async () => rows.filter((row) => row.folder_id == null),
        getNote: async (id: number) => {
          getNoteCalls += 1;

          return id === 999 ? cited : null;
        },
        onNoteAdded: () => () => {},
        onNoteUpdated: () => () => {},
        onNoteDeleted: () => () => {},
        onFolderDeleted: () => () => {},
      },
    },
  });
  const container = installHookDom(t);
  const empty = "export default function Empty() { return null; }";

  const mockModules: Record<string, string> = {
    "react-i18next": `
      const t = (key) => key;
      export const initReactI18next = { type: "3rdParty", init() {} };
      export function useTranslation() { return { t, i18n: { resolvedLanguage: "en" } }; }
    `,
    // The citation seam: capture the props the editor hands its chat panel.
    "../chat/ChatPanel": `
      import React from "react";
      export default function ChatPanel(props) {
        globalThis.__editorChatCitationProps = props;
        return null;
      }
    `,
    "./MeetingResultsPanel": `export default function Empty() { return null; }`,
    "./MeetingTranscriptChat": `
      export function MeetingTranscriptChat() { return null; }
      export function SelectionBar() { return null; }
    `,
    "../ui/RichTextEditor": `export function RichTextEditor() { return null; }`,
    "./NoteFindBar": `export default function Empty() { return null; }`,
    "./NoteParticipants": `export default function Empty() { return null; }`,
    "./NoteBottomBar": `export default function Empty() { return null; }`,
    "./NoteRecordControl": `export default function Empty() { return null; }`,
    "./MeetingMicButton": `export function MeetingMicButton() { return null; }`,
    "./MeetBindingControl": `export function MeetBindingControl() { return null; }`,
    "./NoteNotices": `
      export function CaptureDetails() { return null; }
      export function NoteNotice() { return null; }
    `,
    "@heroui/react": `
      import React from "react";
      const passthrough = ({children}) => React.createElement(React.Fragment, null, children);
      const Button = ({children, onPress}) => React.createElement("button", {onClick: onPress}, children);
      export { Button as HeroButton, Button as Button };
      export const Popover = Object.assign(passthrough, { Content: passthrough, Trigger: passthrough });
      export const Tooltip = Object.assign(({children}) => React.createElement(React.Fragment, null, children), { Content: () => null, Trigger: passthrough });
      export const Modal = Object.assign(({isOpen, children}) => isOpen ? React.createElement(React.Fragment, null, children) : null, { Backdrop: passthrough, Container: passthrough, Dialog: passthrough, CloseTrigger: passthrough });
      export const Dropdown = Object.assign(passthrough, { Popover: passthrough, Menu: passthrough, Item: passthrough, ItemIndicator: passthrough, Trigger: passthrough });
      export const Label = passthrough;
      export const Separator = () => null;
    `,
    "../ui/EmptyStateCard": `export default function Empty() { return null; }`,
    "../ui/ProviderIcon": `export const ProviderIcon = () => null;`,
    "../ui/popover": `
      import React from "react";
      const passthrough = ({children}) => React.createElement(React.Fragment, null, children);
      export function Popover({children}) { return React.createElement(React.Fragment, null, children); }
      export function PopoverContent({children}) { return React.createElement(React.Fragment, null, children); }
      export function PopoverTrigger({children}) { return React.createElement(React.Fragment, null, children); }
      export function PopoverAnchor({children}) { return React.createElement(React.Fragment, null, children); }
    `,
    "/utils/providerIcons": `export const getProviderIcon = () => null; export function isMonochromeProvider(){return false;} export default {};`,
    "../../hooks/useEmbeddedChat": `
      export function useEmbeddedChat() {
        return {
          messages: [], sendMessage: async () => {}, cancelStream: () => {},
          noteConversations: [], activeConversationId: null,
          switchConversation: async () => {}, startNewChat: () => {},
          agentState: "idle",
        };
      }
    `,
    "../../stores/meetingRecordingStore": `
      const state = { isRecording: false, recordingNoteId: null, recordingFolderId: null, micCaptureStatus: "inactive", completedDiarization: null };
      export function useMeetingRecordingStore(selector) { return selector(state); }
      useMeetingRecordingStore.getState = () => state;
      export function useIsMeetingMode() { return false; }
    `,
    "../../utils/openSettings": `export function openSettings() {}`,
    "../../helpers/builtinActions": `export const FOLLOW_UP_KEY = "follow-up";`,
  };

  const vite = await createRendererServer(t, {
    mockModules,
    noExternal: ["react-i18next"],
    resolveAlias: { "@": path.resolve(__dirname, "../../../src") },
  });

  const globals = globalThis as unknown as {
    __editorChatCitationProps?: { onOpenNote?: (id: number) => void };
  };

  delete globals.__editorChatCitationProps;
  const { default: NoteEditor } = await vite.ssrLoadModule("/components/notes/NoteEditor.tsx");

  const store = (await vite.ssrLoadModule(
    "/stores/noteStore.ts"
  )) as typeof import("../../../../src/stores/noteStore");

  await React.act(async () => {
    await store.initializeNotesTree();
  });

  root = createRoot(container as unknown as Element);
  await React.act(async () => {
    root!.render(
      React.createElement(NoteEditor, {
        note: rows[0],
        onTitleChange: () => {},
        onContentChange: () => {},
        isSaving: false,
        isRecording: false,
        isProcessing: false,
        onStartRecording: () => {},
        onStopRecording: () => {},
      })
    );
    await tick();
  });

  const chatProps = globals.__editorChatCitationProps as
    | { onOpenNote?: (id: number) => void }
    | undefined;

  const onOpenNote = chatProps?.onOpenNote as ((id: number) => unknown) | undefined;
  assert.equal(typeof onOpenNote, "function", "the editor wires the chat citation handler");

  // Click a citation for the out-of-cache note: openChatNote fetches the row
  // and hands it to openNoteRow.
  await React.act(async () => {
    await onOpenNote?.(999);
  });

  assert.equal(getNoteCalls, 1, "the cited row is fetched once");
  const active = store.getNoteFromStore(store.getActiveNoteIdValue() ?? -1);
  assert.ok(active, "the cited out-of-cache note is held as the active note");
  assert.equal(active.id, 999);
  assert.equal(active.title, "Cited ancient");
});
