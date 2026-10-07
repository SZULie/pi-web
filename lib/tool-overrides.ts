import { homedir } from "os";
import path from "path";
import fs from "fs/promises";
import { existsSync } from "fs";

export interface ToolPropertyOverride {
  description?: string;
  defaultValue?: string | number | boolean;
}

export interface ToolOverride {
  description?: string;
  promptGuidelines?: string[];
  required?: string[];
  properties?: Record<string, ToolPropertyOverride>;
}

export type ToolOverridesMap = Record<string, ToolOverride>;

export function getToolOverridesPath(): string {
  return path.join(homedir(), ".pi-web", "tool-overrides.json");
}

let writeLock: Promise<unknown> = Promise.resolve();

export async function getToolOverrides(): Promise<ToolOverridesMap> {
  const filePath = getToolOverridesPath();
  try {
    if (!existsSync(filePath)) {
      return {};
    }
    const data = await fs.readFile(filePath, "utf8");
    const json = JSON.parse(data) as ToolOverridesMap;
    if (typeof json === "object" && json !== null && !Array.isArray(json)) {
      return json;
    }
    return {};
  } catch (error) {
    console.error("[pi-web] Failed to read tool overrides:", error);
    return {};
  }
}

export async function saveAllToolOverrides(overrides: ToolOverridesMap): Promise<ToolOverridesMap> {
  const nextLock = writeLock.then(async () => {
    const filePath = getToolOverridesPath();
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    const tempFile = path.join(
      dir,
      `.tool-overrides.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
    );
    await fs.writeFile(tempFile, JSON.stringify(overrides, null, 2) + "\n", "utf8");
    await fs.rename(tempFile, filePath);
    return overrides;
  });
  writeLock = nextLock.then(
    () => undefined,
    () => undefined,
  );
  return nextLock;
}

export async function setToolOverride(toolName: string, override: ToolOverride | null): Promise<ToolOverridesMap> {
  const current = await getToolOverrides();
  const next = { ...current };
  if (override === null || Object.keys(override).length === 0) {
    delete next[toolName];
  } else {
    next[toolName] = override;
  }
  return saveAllToolOverrides(next);
}

export function applyToolOverridesToSession(session: any, overrides: ToolOverridesMap): void {
  if (!session || !overrides) return;

  // Snapshot original definition before any overrides if not present
  if (!session._originalToolDefinitions && session._toolDefinitions) {
    session._originalToolDefinitions = new Map();
    for (const [name, entry] of session._toolDefinitions.entries()) {
      session._originalToolDefinitions.set(name, {
        description: entry.definition.description,
        promptGuidelines: entry.definition.promptGuidelines ? [...entry.definition.promptGuidelines] : undefined,
        parameters: entry.definition.parameters ? JSON.parse(JSON.stringify(entry.definition.parameters)) : undefined,
      });
    }
  }

  // Restore tools to originals if override was removed
  if (session._originalToolDefinitions && session._toolDefinitions) {
    for (const [name, original] of session._originalToolDefinitions.entries()) {
      if (!overrides[name]) {
        const defEntry = session._toolDefinitions.get(name);
        if (defEntry?.definition) {
          defEntry.definition.description = original.description;
          defEntry.definition.promptGuidelines = original.promptGuidelines ? [...original.promptGuidelines] : undefined;
          if (original.parameters) {
            defEntry.definition.parameters = JSON.parse(JSON.stringify(original.parameters));
          }
        }
        const regTool = session._toolRegistry?.get(name);
        if (regTool) {
          regTool.description = original.description;
          if (original.parameters) {
            regTool.parameters = JSON.parse(JSON.stringify(original.parameters));
          }
          if (regTool._originalExecute) {
            regTool.execute = regTool._originalExecute;
            delete regTool._originalExecute;
          }
        }
        if (session._toolPromptGuidelines) {
          if (original.promptGuidelines) {
            session._toolPromptGuidelines.set(name, [...original.promptGuidelines]);
          } else {
            session._toolPromptGuidelines.delete(name);
          }
        }
      }
    }
  }

  // Apply configured overrides
  for (const [toolName, override] of Object.entries(overrides)) {
    if (!override) continue;

    // 1. Definition in _toolDefinitions
    const defEntry = session._toolDefinitions?.get(toolName);
    if (defEntry?.definition) {
      if (override.description !== undefined) {
        defEntry.definition.description = override.description;
      }
      if (override.promptGuidelines !== undefined) {
        defEntry.definition.promptGuidelines = [...override.promptGuidelines];
      }
      if (defEntry.definition.parameters && typeof defEntry.definition.parameters === "object") {
        const params = defEntry.definition.parameters as Record<string, any>;
        if (override.required !== undefined) {
          params.required = [...override.required];
        }
        if (override.properties && params.properties && typeof params.properties === "object") {
          for (const [propName, propOverride] of Object.entries(override.properties)) {
            const prop = params.properties[propName];
            if (prop && typeof prop === "object") {
              if (propOverride.description !== undefined) prop.description = propOverride.description;
              if (propOverride.defaultValue !== undefined) prop.default = propOverride.defaultValue;
            }
          }
        }
      }
    }

    // 2. Tool in _toolRegistry
    const regTool = session._toolRegistry?.get(toolName);
    if (regTool) {
      if (override.description !== undefined) {
        regTool.description = override.description;
      }
      if (regTool.parameters && typeof regTool.parameters === "object") {
        const params = regTool.parameters as Record<string, any>;
        if (override.required !== undefined) {
          params.required = [...override.required];
        }
        if (override.properties && params.properties && typeof params.properties === "object") {
          for (const [propName, propOverride] of Object.entries(override.properties)) {
            const prop = params.properties[propName];
            if (prop && typeof prop === "object") {
              if (propOverride.description !== undefined) prop.description = propOverride.description;
              if (propOverride.defaultValue !== undefined) prop.default = propOverride.defaultValue;
            }
          }
        }
      }

      // Enforce newly required parameters in execute()
      if (override.required && Array.isArray(override.required) && override.required.length > 0) {
        const requiredList = [...override.required];
        const originalExecute = regTool._originalExecute || regTool.execute;
        regTool._originalExecute = originalExecute;
        regTool.execute = async (toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) => {
          for (const reqField of requiredList) {
            if (params === undefined || params === null || params[reqField] === undefined || params[reqField] === "") {
              throw new Error(`Missing required parameter '${reqField}' for tool '${toolName}'. Please specify '${reqField}'.`);
            }
          }
          return originalExecute.call(regTool, toolCallId, params, signal, onUpdate, ctx);
        };
      }
    }

    // 3. Guidelines in _toolPromptGuidelines
    if (override.promptGuidelines !== undefined && session._toolPromptGuidelines) {
      session._toolPromptGuidelines.set(toolName, [...override.promptGuidelines]);
    }
  }

  // 4. Re-apply to agent.state.tools
  if (typeof session._applyToolLoadout === "function" && typeof session.getActiveToolNames === "function") {
    session._applyToolLoadout(session.getActiveToolNames());
  }
}
