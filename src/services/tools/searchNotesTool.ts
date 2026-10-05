import type { SpaceItem } from "../../contracts/containers";
import type { ContainerScope } from "../../types/chat";
import type { ToolDefinition, ToolResult } from "./ToolRegistry";
import { resolveSpace } from "./utils";

const MAX_CONTENT_LENGTH = 500;

interface SearchToolOptions {
  /** Pins every search to this container; the LLM's space arg is dropped. */
  fixedScope?: ContainerScope;
}

export function createSearchNotesTool(options: SearchToolOptions): ToolDefinition {
  const { fixedScope } = options;

  const spaceParameter = fixedScope
    ? {}
    : {
        space: {
          type: "string",
          description: "Space name to search within. Omit to search all accessible spaces.",
        },
      };

  return {
    name: "search_notes",
    description: fixedScope
      ? "Search the notes in the folder or space the user is currently viewing using local full-text search. Returns matching notes with title, date, space, and a preview of content."
      : "Search the user's notes using local full-text search. Searches every local note by default; pass space to search within a single space. Returns matching notes with title, date, space, and a preview of content.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query to find relevant notes",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return (default 5)",
        },
        ...spaceParameter,
      },
      required: ["query"],
      additionalProperties: false,
    },
    readOnly: true,

    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const query = args.query as string;
      const limit = typeof args.limit === "number" ? args.limit : 5;
      const spaceName = fixedScope ? undefined : (args.space as string | undefined);

      const spaces = (await window.electronAPI.getSpaces?.()) ?? [];
      let space: SpaceItem | undefined;

      if (fixedScope) {
        space = spaces.find((s) => s.id === fixedScope.spaceId);
      } else if (spaceName) {
        const resolved = resolveSpace(spaces, spaceName);

        if (resolved.error) {
          return { success: false, data: null, displayText: resolved.error };
        }

        space = resolved.space;
      }

      const spaceId = fixedScope?.spaceId ?? space?.id ?? null;
      const folderId = fixedScope?.folderId ?? null;

      try {
        return await executeLocalSearch(query, limit, space, spaces, spaceId, folderId);
      } catch (error) {
        return {
          success: false,
          data: null,
          displayText: `Failed to search notes: ${(error as Error).message}`,
        };
      }
    },
  };
}

function summaryText(count: number, query: string, space: SpaceItem | undefined): string {
  const scope = space ? ` in ${space.name}` : "";

  if (count === 0) return `No notes found for "${query}"${scope}`;

  return `Found ${count} note${count === 1 ? "" : "s"} for "${query}"${scope}`;
}

async function executeLocalSearch(
  query: string,
  limit: number,
  space: SpaceItem | undefined,
  spaces: SpaceItem[],
  spaceId: number | null,
  folderId: number | null
): Promise<ToolResult> {
  const notes = await window.electronAPI.searchNotes(query, limit, spaceId, folderId);

  const spaceNameById = new Map(spaces.map((s) => [s.id, s.name]));

  const results = notes.map((note) => ({
    id: note.id,
    title: note.title,
    date: note.created_at,
    type: note.note_type,
    space: spaceNameById.get(note.space_id) ?? null,
    content: (note.enhanced_content || note.content).slice(0, MAX_CONTENT_LENGTH),
  }));

  return {
    success: true,
    data: results,
    displayText: summaryText(results.length, query, space),
  };
}
