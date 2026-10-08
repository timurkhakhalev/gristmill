import type { ContainerScope } from "../../types/chat";
import {
  readNumber,
  readString,
  type ToolArguments,
  type ToolDefinition,
  type ToolResult,
} from "./ToolRegistry";

const MAX_CONTENT_LENGTH = 500;

export function createSearchNotesTool({
  fixedScope,
}: {
  fixedScope?: ContainerScope;
}): ToolDefinition {
  return {
    name: "search_notes",
    description: fixedScope
      ? "Search notes in the Notes location the user is viewing. Returns matching notes with title, date and a content preview."
      : "Search all local notes. Returns matching notes with title, date and a content preview.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query" },
        limit: { type: "number", description: "Maximum results (default 5)" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    readOnly: true,

    async execute(args: ToolArguments): Promise<ToolResult> {
      const query = readString(args, "query") ?? "";
      const limit = readNumber(args, "limit") ?? 5;

      try {
        const notes = await window.electronAPI.searchNotes(
          query,
          limit,
          fixedScope?.folderId ?? null,
          fixedScope?.folderId === null
        );

        const results = notes.map((note) => ({
          id: note.id,
          title: note.title,
          date: note.created_at,
          type: note.note_type,
          content: (note.enhanced_content || note.content).slice(0, MAX_CONTENT_LENGTH),
        }));

        return {
          success: true,
          data: results,
          displayText: results.length
            ? `Found ${results.length} note${results.length === 1 ? "" : "s"} for "${query}"`
            : `No notes found for "${query}"`,
        };
      } catch (error) {
        return {
          success: false,
          data: null,
          displayText: `Failed to search notes: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  };
}
