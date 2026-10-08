import { homedir } from "os";
import path from "path";
import fs from "fs/promises";
import { existsSync } from "fs";
import type { SessionEntry } from "./types";
import { sliceActiveBranch } from "./session-reader";

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

export function getInterruptedSessionsFilePath(): string {
  return path.join(homedir(), ".pi-web", "interrupted-sessions.json");
}

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

  // Case 3: Leaf is an assistant message that was aborted or did not stop normally
  if (msg.role === "assistant") {
    const isAborted = msg.stopReason === "aborted";
    const isIncomplete = !msg.stopReason || msg.stopReason !== "stop";
    if (isAborted || isIncomplete || wasInterruptedByRestart) {
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
