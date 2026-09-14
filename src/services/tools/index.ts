import { ToolRegistry } from "./ToolRegistry";
import { createSearchNotesTool } from "./searchNotesTool";
import { getNoteTool } from "./getNoteTool";
import { createNoteTool } from "./createNoteTool";
import { updateNoteTool } from "./updateNoteTool";
import { listFoldersTool } from "./listFoldersTool";
import { clipboardTool } from "./clipboardTool";
import { calendarTool } from "./calendarTool";
import { calendarAvailabilityTool } from "./calendarAvailabilityTool";
import { createSnippetTool, createUpdateSnippetsTool, type SnippetActions } from "./snippetTool";
import { createUpdateDictionaryTool, type DictionaryActions } from "./dictionaryTool";
import type { ContainerScope } from "../../types/chat";

export { ToolRegistry } from "./ToolRegistry";
export type { ToolDefinition, ToolResult } from "./ToolRegistry";

interface ToolRegistrySettings {
  calendarConnected: boolean;
  /** Pins search_notes to a container (overview chat); the LLM cannot widen it. */
  searchScope?: ContainerScope;
  /** Live dictionary and snippet access; enables the vocabulary tools. */
  vocabulary?: DictionaryActions & SnippetActions;
}

export function createToolRegistry(settings: ToolRegistrySettings): ToolRegistry {
  const registry = new ToolRegistry();

  registry.register(createSearchNotesTool({ fixedScope: settings.searchScope }));
  registry.register(getNoteTool);
  registry.register(createNoteTool);
  registry.register(updateNoteTool);
  registry.register(listFoldersTool);
  registry.register(clipboardTool);

  if (settings.vocabulary) {
    const snippets = settings.vocabulary.getSnippets();
    if (snippets.length > 0) registry.register(createSnippetTool(snippets));
    registry.register(createUpdateDictionaryTool(settings.vocabulary));
    registry.register(createUpdateSnippetsTool(settings.vocabulary));
  }

  if (settings.calendarConnected) {
    registry.register(calendarTool);
    registry.register(calendarAvailabilityTool);
  }

  return registry;
}
