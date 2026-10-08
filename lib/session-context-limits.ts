import { homedir } from "os";
import path from "path";
import fs from "fs/promises";
import { existsSync } from "fs";
export { parseTokenAmount } from "./token-format";

export interface SessionContextLimitConfig {
  contextLimit: number | null; // token count; null or <= 0 means default
  thresholdPercent?: number | null; // e.g. 65; null means default
  updatedAt?: number;
}

export type SessionContextLimitsMap = Record<string, SessionContextLimitConfig>;

export function getSessionContextLimitsPath(): string {
  return path.join(homedir(), ".pi-web", "session-context-limits.json");
}

let writeLock: Promise<unknown> = Promise.resolve();

export async function getAllSessionContextLimits(): Promise<SessionContextLimitsMap> {
  const filePath = getSessionContextLimitsPath();
  try {
    if (!existsSync(filePath)) {
      return {};
    }
    const data = await fs.readFile(filePath, "utf8");
    const json = JSON.parse(data) as SessionContextLimitsMap;
    if (typeof json === "object" && json !== null && !Array.isArray(json)) {
      return json;
    }
    return {};
  } catch (error) {
    console.error("[pi-web] Failed to read session context limits:", error);
    return {};
  }
}

export async function getSessionContextLimit(sessionId: string): Promise<SessionContextLimitConfig | null> {
  const all = await getAllSessionContextLimits();
  return all[sessionId] ?? null;
}

export async function setSessionContextLimit(
  sessionId: string,
  config: { contextLimit?: number | null; thresholdPercent?: number | null } | null,
): Promise<SessionContextLimitsMap> {
  const nextLock = writeLock.then(async () => {
    const current = await getAllSessionContextLimits();
    const next = { ...current };

    if (!config || (config.contextLimit === null && !config.thresholdPercent)) {
      delete next[sessionId];
    } else {
      next[sessionId] = {
        contextLimit:
          typeof config.contextLimit === "number" && config.contextLimit > 0
            ? Math.round(config.contextLimit)
            : null,
        thresholdPercent:
          typeof config.thresholdPercent === "number" && config.thresholdPercent > 0
            ? config.thresholdPercent
            : null,
        updatedAt: Date.now(),
      };
    }

    const filePath = getSessionContextLimitsPath();
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    const tempFile = path.join(
      dir,
      `.session-context-limits.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
    );
    await fs.writeFile(tempFile, JSON.stringify(next, null, 2) + "\n", "utf8");
    await fs.rename(tempFile, filePath);
    return next;
  });

  writeLock = nextLock.then(
    () => undefined,
    () => undefined,
  );
  return nextLock;
}



export function syncSessionContextLimitToMagicContext(sessionId: string, limit: number | null): void {
  try {
    const dbPath = path.join(homedir(), ".local", "share", "cortexkit", "magic-context", "context.db");
    if (!existsSync(dbPath)) return;
    // dynamically import or use node:sqlite only in Node runtime
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      const val = typeof limit === "number" && limit > 0 ? limit : 0;
      db.prepare(
        "INSERT INTO session_meta (session_id, detected_context_limit) VALUES (?, ?) " +
          "ON CONFLICT(session_id) DO UPDATE SET detected_context_limit = excluded.detected_context_limit",
      ).run(sessionId, val);
    } finally {
      db.close();
    }
  } catch (err) {
    console.error("[pi-web] Failed to sync session limit to magic-context db:", err);
  }
}

export function applySessionContextLimitToSession(session: any, limit: number | null): void {
  if (!session) return;
  if (!session._originalGetContextUsage && typeof session.getContextUsage === "function") {
    session._originalGetContextUsage = session.getContextUsage.bind(session);
  }
  if (!session._originalLimitsModel && typeof session._limitsModel === "function") {
    session._originalLimitsModel = session._limitsModel.bind(session);
  }

  if (typeof limit === "number" && limit > 0) {
    session.getContextUsage = () => {
      const base = session._originalGetContextUsage?.();
      if (!base) return base;
      const contextWindow = limit;
      const percent = base.tokens !== null ? (base.tokens / contextWindow) * 100 : null;
      return { tokens: base.tokens, contextWindow, percent };
    };
    if (session._originalLimitsModel) {
      session._limitsModel = () => {
        const base = session._originalLimitsModel();
        return base ? { ...base, contextWindow: limit } : base;
      };
    }
  } else {
    if (session._originalGetContextUsage) {
      session.getContextUsage = session._originalGetContextUsage;
    }
    if (session._originalLimitsModel) {
      session._limitsModel = session._originalLimitsModel;
    }
  }
}
