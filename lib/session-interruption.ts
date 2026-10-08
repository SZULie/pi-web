import { homedir } from "os";
import path from "path";
import fs from "fs/promises";
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from "fs";
import type { SessionEntry } from "./types";
import { sliceActiveBranch } from "./session-reader";

export interface ActiveRunRecord {
  sessionId: string;
  startedAt: number;
  sessionFile?: string;
}

export type ActiveRunsMap = Record<string, ActiveRunRecord>;

export interface InterruptedSessionRecord {
  sessionId: string;
  interruptedAt: number;
  reason?: string;
  sessionFile?: string;
}

export type InterruptedSessionsMap = Record<string, InterruptedSessionRecord>;

export interface InterruptionInspection {
  canResume: boolean;
  wasInterruptedByRestart: boolean;
  turnType?: "unanswered_user" | "aborted_assistant" | "unhandled_tool_result" | "incomplete_assistant";
  suggestedPrompt: string;
  lastMessagePreview?: string;
}

export function getActiveRunsFilePath(): string {
  return path.join(homedir(), ".pi-web", "active-runs.json");
}

export function getInterruptedSessionsFilePath(): string {
  return path.join(homedir(), ".pi-web", "interrupted-sessions.json");
}

// -------------------------------------------------------------
// Synchronous Write-Ahead Active Runs Store
// -------------------------------------------------------------

export function markSessionActiveSync(sessionId: string, sessionFile?: string): void {
  try {
    const filePath = getActiveRunsFilePath();
    const dir = path.dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    let map: ActiveRunsMap = {};
    if (existsSync(filePath)) {
      try {
        const content = readFileSync(filePath, "utf8");
        map = JSON.parse(content) as ActiveRunsMap;
        if (typeof map !== "object" || map === null || Array.isArray(map)) {
          map = {};
        }
      } catch {
        map = {};
      }
    }
    map[sessionId] = {
      sessionId,
      startedAt: Date.now(),
      sessionFile,
    };
    const tempFile = path.join(
      dir,
      `.active-runs.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
    );
    writeFileSync(tempFile, JSON.stringify(map, null, 2) + "\n", "utf8");
    renameSync(tempFile, filePath);
  } catch (error) {
    console.error("[pi-web] Failed to synchronously mark session active:", error);
  }
}

export function clearSessionActiveSync(sessionId: string): void {
  try {
    const filePath = getActiveRunsFilePath();
    if (!existsSync(filePath)) return;
    let map: ActiveRunsMap = {};
    try {
      const content = readFileSync(filePath, "utf8");
      map = JSON.parse(content) as ActiveRunsMap;
      if (typeof map !== "object" || map === null || Array.isArray(map)) return;
    } catch {
      return;
    }
    if (!map[sessionId]) return;
    delete map[sessionId];

    if (Object.keys(map).length === 0) {
      try {
        unlinkSync(filePath);
      } catch {}
      return;
    }

    const dir = path.dirname(filePath);
    const tempFile = path.join(
      dir,
      `.active-runs.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
    );
    writeFileSync(tempFile, JSON.stringify(map, null, 2) + "\n", "utf8");
    renameSync(tempFile, filePath);
  } catch (error) {
    console.error("[pi-web] Failed to synchronously clear session active:", error);
  }
}

export function getActiveRunsSync(): ActiveRunsMap {
  const filePath = getActiveRunsFilePath();
  try {
    if (!existsSync(filePath)) return {};
    const content = readFileSync(filePath, "utf8");
    const json = JSON.parse(content) as ActiveRunsMap;
    return typeof json === "object" && json !== null && !Array.isArray(json) ? json : {};
  } catch {
    return {};
  }
}

/**
 * Called on server startup:
 * Reconciles any active-runs left behind by a previous killed/restarted process,
 * moves them to interrupted-sessions.json, and clears active-runs.json.
 */
export function reconcileActiveRunsOnStartupSync(): InterruptedSessionRecord[] {
  const activeMap = getActiveRunsSync();
  const activeKeys = Object.keys(activeMap);
  if (activeKeys.length === 0) return [];

  const interruptedPath = getInterruptedSessionsFilePath();
  const dir = path.dirname(interruptedPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  let interruptedMap: InterruptedSessionsMap = {};
  if (existsSync(interruptedPath)) {
    try {
      const content = readFileSync(interruptedPath, "utf8");
      interruptedMap = JSON.parse(content) as InterruptedSessionsMap;
      if (typeof interruptedMap !== "object" || interruptedMap === null || Array.isArray(interruptedMap)) {
        interruptedMap = {};
      }
    } catch {
      interruptedMap = {};
    }
  }

  const now = Date.now();
  const reconciled: InterruptedSessionRecord[] = [];
  for (const [sid, rec] of Object.entries(activeMap)) {
    const item: InterruptedSessionRecord = {
      sessionId: sid,
      interruptedAt: rec.startedAt || now,
      sessionFile: rec.sessionFile,
      reason: "service_restart",
    };
    interruptedMap[sid] = item;
    reconciled.push(item);
  }

  try {
    const tempFile = path.join(
      dir,
      `.interrupted-sessions.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
    );
    writeFileSync(tempFile, JSON.stringify(interruptedMap, null, 2) + "\n", "utf8");
    renameSync(tempFile, interruptedPath);
  } catch (error) {
    console.error("[pi-web] Failed to write reconciled interrupted-sessions:", error);
  }

  // Clear active runs file
  try {
    const activePath = getActiveRunsFilePath();
    if (existsSync(activePath)) unlinkSync(activePath);
  } catch {}

  return reconciled;
}

// -------------------------------------------------------------
// Interrupted Sessions Store
// -------------------------------------------------------------

let writeLock: Promise<unknown> = Promise.resolve();

export async function getInterruptedSessions(): Promise<InterruptedSessionsMap> {
  const filePath = getInterruptedSessionsFilePath();
  try {
    if (!existsSync(filePath)) return {};
    const content = await fs.readFile(filePath, "utf8");
    const json = JSON.parse(content) as InterruptedSessionsMap;
    return typeof json === "object" && json !== null && !Array.isArray(json) ? json : {};
  } catch {
    return {};
  }
}

export async function recordInterruptedSessions(
  records: Array<{ sessionId: string; sessionFile?: string; reason?: string }>,
): Promise<void> {
  if (!records.length) return;
  const nextLock = writeLock.then(async () => {
    const map = await getInterruptedSessions();
    const now = Date.now();
    for (const r of records) {
      map[r.sessionId] = {
        sessionId: r.sessionId,
        interruptedAt: now,
        sessionFile: r.sessionFile,
        reason: r.reason || "service_restart",
      };
    }
    const filePath = getInterruptedSessionsFilePath();
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    const tempFile = path.join(
      dir,
      `.interrupted-sessions.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
    );
    await fs.writeFile(tempFile, JSON.stringify(map, null, 2) + "\n", "utf8");
    await fs.rename(tempFile, filePath);
  });
  writeLock = nextLock.then(
    () => undefined,
    () => undefined,
  );
  await nextLock;
}

export async function clearInterruptedSession(sessionId: string): Promise<void> {
  const nextLock = writeLock.then(async () => {
    const map = await getInterruptedSessions();
    if (!map[sessionId]) return;
    delete map[sessionId];
    const filePath = getInterruptedSessionsFilePath();
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    const tempFile = path.join(
      dir,
      `.interrupted-sessions.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
    );
    await fs.writeFile(tempFile, JSON.stringify(map, null, 2) + "\n", "utf8");
    await fs.rename(tempFile, filePath);
  });
  writeLock = nextLock.then(
    () => undefined,
    () => undefined,
  );
  await nextLock;
}

export function inspectSessionInterruption(
  entries: SessionEntry[],
  leafId: string | null | undefined,
  sessionId: string,
  interruptedMap: InterruptedSessionsMap = {},
): InterruptionInspection {
  const wasInterruptedByRestart = Boolean(interruptedMap[sessionId]);

  if (!entries || entries.length === 0) {
    return { canResume: false, wasInterruptedByRestart, suggestedPrompt: "" };
  }

  // Slice active branch up to the leaf
  const branch = sliceActiveBranch(entries, leafId ?? null, entries.length);
  if (!branch.length) {
    return { canResume: false, wasInterruptedByRestart, suggestedPrompt: "" };
  }

  // Find the last message entry in the active branch
  const lastMessageEntry = [...branch].reverse().find((e) => e.type === "message");
  if (!lastMessageEntry || lastMessageEntry.type !== "message") {
    return { canResume: false, wasInterruptedByRestart, suggestedPrompt: "" };
  }

  const msg = lastMessageEntry.message;

  // Case 1: Leaf is a user message (submitted but not answered)
  if (msg.role === "user") {
    let preview = "";
    if (typeof msg.content === "string") {
      preview = msg.content;
    } else if (Array.isArray(msg.content)) {
      const textBlock = msg.content.find((b: { type: string }) => b.type === "text") as { text: string } | undefined;
      preview = textBlock?.text || "";
    }
    return {
      canResume: true,
      wasInterruptedByRestart,
      turnType: "unanswered_user",
      suggestedPrompt: "",
      lastMessagePreview: preview.slice(0, 100),
    };
  }

  // Case 2: Leaf is a toolResult with no assistant conclusion
  if (msg.role === "toolResult") {
    return {
      canResume: true,
      wasInterruptedByRestart,
      turnType: "unhandled_tool_result",
      suggestedPrompt: "继续",
      lastMessagePreview: `[Tool result: ${msg.toolName || ""}]`,
    };
  }

  // Case 3: Leaf is an assistant message that was calling tools, was aborted, or did not stop normally
  if (msg.role === "assistant") {
    const isToolUse = msg.stopReason === "toolUse";
    const isAborted = msg.stopReason === "aborted";
    const isIncomplete = !msg.stopReason || msg.stopReason !== "stop";
    if (isToolUse || isAborted || isIncomplete || wasInterruptedByRestart) {
      let preview = "";
      if (Array.isArray(msg.content)) {
        const textBlock = msg.content.find((b: { type: string }) => b.type === "text") as { text: string } | undefined;
        preview = textBlock?.text || "";
      }
      return {
        canResume: true,
        wasInterruptedByRestart,
        turnType: isAborted ? "aborted_assistant" : "incomplete_assistant",
        suggestedPrompt: "继续",
        lastMessagePreview: preview.slice(0, 100),
      };
    }
  }

  return { canResume: false, wasInterruptedByRestart: false, suggestedPrompt: "" };
}
