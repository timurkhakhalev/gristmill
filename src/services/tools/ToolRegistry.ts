import { jsonSchema } from "ai";
import type { Tool } from "ai";

// Tool arguments are model-produced JSON: the value reaches `execute` only
// after the provider decoded a tool call, so the honest type is JSON. Each
// tool narrows the fields it needs with the accessors below before use.
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue;
}

export type ToolArguments = JsonObject;

export function isJsonString(value: JsonValue | undefined): value is string {
  return typeof value === "string";
}

export function isJsonNumber(value: JsonValue | undefined): value is number {
  return typeof value === "number";
}

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readString(args: JsonObject, key: string): string | undefined {
  const value = args[key];

  return isJsonString(value) ? value : undefined;
}

export function readNumber(args: JsonObject, key: string): number | undefined {
  const value = args[key];

  return isJsonNumber(value) ? value : undefined;
}

export function readArray(args: JsonObject, key: string): JsonValue[] {
  const value = args[key];

  return Array.isArray(value) ? value : [];
}

export interface ToolResult {
  success: boolean;
  data: unknown;
  displayText: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonObject;
  readOnly: boolean;
  execute: (args: ToolArguments) => Promise<ToolResult>;
}

interface AiSdkToolMap {
  [key: string]: Tool;
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  getAll(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  toAISDKFormat(): AiSdkToolMap {
    const result: AiSdkToolMap = {};

    for (const def of this.getAll()) {
      result[def.name] = {
        description: def.description,
        inputSchema: jsonSchema<ToolArguments>(def.parameters),
        execute: async (args: ToolArguments) => {
          try {
            const toolResult = await def.execute(args);

            return toolResult.success ? toolResult.data : { error: toolResult.displayText };
          } catch (error) {
            return { error: error instanceof Error ? error.message : "Tool execution failed" };
          }
        },
      };
    }

    return result;
  }
}
