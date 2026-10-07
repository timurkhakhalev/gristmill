import {
  readNumber,
  type ToolArguments,
  type ToolDefinition,
  type ToolResult,
} from "./ToolRegistry";

export const getNoteTool: ToolDefinition = {
  name: "get_note",
  description:
    "Get the full content of a specific note by ID. Use search_notes first to find the note ID.",
  parameters: {
    type: "object",
    properties: {
      id: {
        type: "number",
        description: "The note ID to retrieve",
      },
    },
    required: ["id"],
    additionalProperties: false,
  },
  readOnly: true,

  async execute(args: ToolArguments): Promise<ToolResult> {
    const id = readNumber(args, "id") ?? 0;

    try {
      const note = await window.electronAPI.getNote(id);

      if (!note) {
        return {
          success: false,
          data: null,
          displayText: `Note with ID ${id} not found`,
        };
      }

      const output = await window.electronAPI.getNoteOutput({ noteId: id, scope: "note" });

      if (output.scope !== "note" || output.noteId !== id)
        throw new Error("Unexpected Note output identity");

      return {
        success: true,
        data: {
          id: note.id,
          title: note.title,
          content: output.summary || output.manual.text,
          type: note.note_type,
          folder_id: note.folder_id,
          created_at: note.created_at,
          updated_at: note.updated_at,
        },
        displayText: `Retrieved note: "${note.title}"`,
      };
    } catch (error) {
      return {
        success: false,
        data: null,
        displayText: `Failed to get note: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
