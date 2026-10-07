// Tool metadata crossing to the note cards and the persistence wire: the
// note-tool payload (id/title) or the search_notes hit list. Values stay
// `unknown` because each reader guards the field it consumes, matching the
// chat-persistence IPC contract.
export interface ToolCallMetadata {
  id?: unknown;
  title?: unknown;
}

export interface ToolCallInfo {
  id: string;
  name: string;
  arguments: string;
  status: "executing" | "completed" | "error";
  result?: string;
  // Single object for note tools; search_notes attaches its result array.
  metadata?: ToolCallMetadata | ToolCallMetadata[];
}

export interface Message {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  isStreaming: boolean;
  toolCalls?: ToolCallInfo[];
  persistenceError?: string;
  isSaving?: boolean;
}

export type AgentState =
  | "idle"
  | "listening"
  | "transcribing"
  | "thinking"
  | "streaming"
  | "tool-executing";

export { toolIcons } from "./toolIcons";
