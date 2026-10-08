import {
  readString,
  type ToolArguments,
  type ToolDefinition,
  type ToolResult,
} from "./ToolRegistry";
import { resolveFolderId } from "./utils";

export const createNoteTool: ToolDefinition = {
  name: "create_note",
  description:
    "Always call list_folders first. Reuse an existing folder whenever one is a reasonable match for the note's topic. Only pass a new folder name when nothing existing fits. Creates a note with title, content and an optional folder (created if missing).",
  parameters: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "The title of the note",
      },
      content: {
        type: "string",
        description: "The content of the note",
      },
      folder: {
        type: "string",
        description:
          "Folder name for the note. Created automatically if it does not exist.",
      },
    },
    required: ["title", "content"],
    additionalProperties: false,
  },
  readOnly: false,

  async execute(args: ToolArguments): Promise<ToolResult> {
    const title = readString(args, "title") ?? "";
    const content = readString(args, "content") ?? "";
    const folderName = readString(args, "folder");

    try {
      let folderId: number | null = null;
      let folderCreated = false;

      if (folderName) {
        const resolved = await resolveFolderId(folderName, { createIfMissing: true });

        if (resolved.error !== undefined) {
          return { success: false, data: null, displayText: resolved.error };
        }

        folderId = resolved.folderId;
        folderCreated = resolved.created;
      }

      const result = await window.electronAPI.saveNote(
        title,
        content,
        "personal",
        null,
        null,
        folderId
      );

      if (!result.success || !result.note) {
        return { success: false, data: null, displayText: "Failed to create note" };
      }

      const suffix = folderCreated ? ` in new folder "${folderName}"` : "";

      return {
        success: true,
        data: { id: result.note.id, title: result.note.title, folder_id: folderId },
        displayText: `Created note: "${title}"${suffix}`,
      };
    } catch (error) {
      return {
        success: false,
        data: null,
        displayText: `Failed to create note: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
