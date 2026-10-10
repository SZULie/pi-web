import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import path from "path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type GoalStatus = "draft" | "running" | "paused" | "stopped" | "complete";
type GoalMode = "finish" | "forever";

type GoalSubtask = {
  id: string;
  text: string;
  status: "pending" | "active" | "done" | "blocked";
  createdAt: number;
  updatedAt: number;
};

type GoalEvent = {
  id: string;
  type: string;
  message: string;
  createdAt: number;
};

const RAW_EVENT_COUNT: unique symbol = Symbol("goalRawEventCount");

type GoalRecord = {
  sessionId: string;
  objective: string;
  subtasks: GoalSubtask[];
  status: GoalStatus;
  phase: "clarifying" | "executing";
  mode: GoalMode;
  createdAt: number;
  updatedAt: number;
  iteration: number;
  consecutiveFailures: number;
  nextRetryAt?: number;
  lastError?: string;
  lastOutcome?: string;
  events?: GoalEvent[];
  [RAW_EVENT_COUNT]?: number;
};

type Store = {
  version: 1;
  sessions: Record<string, GoalRecord>;
};

const VERSION = "1.4.0";
const EVENT_TYPE_COMPLETIONS = ["restore", "settled", "run", "retry", "error", "subtask", "start", "add", "pause", "resume", "complete", "stop", "mode", "recover"];
const MAX_RETRY_MS = 20 * 60 * 1000;
const BASE_RETRY_MS = 1000;
const MAX_EVENTS = 40;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_STALE_MS = 60_000;
const timers = new Map<string, NodeJS.Timeout>();
const suppressNextClarificationInput = new Map<string, string>();
const CONTROL_COMMANDS = new Set([
  "start", "s", "status", "st", "run", "r", "resume", "continue", "pause", "p", "stop", "x", "complete", "done", "add", "a", "mode", "help", "h", "list", "ls", "l", "subtasks", "tasks", "task", "subtask", "events", "event", "log", "logs", "config", "cfg", "doctor", "diag", "diagnose", "lock", "locks", "unlock", "unlock-stale-lock", "backup", "restore-backup",
]);

function storePath(): string {
  return path.join(homedir(), ".pi", "agent", "goal-runner.json");
}

function backupPath(file = storePath()): string {
  return `${file}.bak`;
}

function normalizeGoal(goal: GoalRecord): GoalRecord {
  const rawEventCount = Array.isArray(goal.events) ? goal.events.length : 0;
  const normalized: GoalRecord = {
    ...goal,
    subtasks: Array.isArray(goal.subtasks) ? goal.subtasks : [],
    events: Array.isArray(goal.events) ? compactEvents(goal.events) : [],
    mode: goal.mode || "finish",
  };
  if (normalized.status === "complete" || normalized.status === "stopped" || normalized.status === "paused") {
    delete normalized.nextRetryAt;
  }
  Object.defineProperty(normalized, RAW_EVENT_COUNT, { value: rawEventCount, enumerable: false });
  return normalized;
}

function makeEvent(type: string, message: string): GoalEvent {
  const now = Date.now();
  return {
    id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    type,
    message,
    createdAt: now,
  };
}

function compactEvents(events: GoalEvent[]): GoalEvent[] {
  const compacted: GoalEvent[] = [];
  for (const event of events) {
    const last = compacted.at(-1);
    if (last && last.type === event.type && last.message === event.message) {
      compacted[compacted.length - 1] = event;
    } else {
      compacted.push(event);
    }
  }
  return compacted.slice(-MAX_EVENTS);
}

function appendEvent(goal: GoalRecord, type: string, message: string): GoalRecord {
  const events = compactEvents(Array.isArray(goal.events) ? goal.events : []);
  const last = events.at(-1);
  if (last && last.type === type && last.message === message) {
    return {
      ...goal,
      events: [...events.slice(0, -1), { ...last, createdAt: Date.now() }].slice(-MAX_EVENTS),
    };
  }
  return {
    ...goal,
    events: compactEvents([...events, makeEvent(type, message)]),
  };
}

function parseStoreFile(file: string, recoveredFromBackup = false): Store | null {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Store;
  if (!parsed || parsed.version !== 1 || typeof parsed.sessions !== "object") {
    return null;
  }
  for (const [id, goal] of Object.entries(parsed.sessions)) {
    parsed.sessions[id] = normalizeGoal({ ...goal, sessionId: goal.sessionId || id });
    if (recoveredFromBackup) {
      parsed.sessions[id] = appendEvent(parsed.sessions[id], "recover", "Recovered Goal state from backup after primary store was unreadable");
    }
  }
  return parsed;
}

function readStore(): Store {
  const file = storePath();
  if (!existsSync(file)) return { version: 1, sessions: {} };
  try {
    const store = parseStoreFile(file);
    if (store) return store;
  } catch {
    // Fall back to the last known-good backup below.
  }
  try {
    const store = parseStoreFile(backupPath(file), true);
    if (store) return store;
  } catch {
    // No readable backup.
  }
  return { version: 1, sessions: {} };
}

function writeStore(store: Store): void {
  const file = storePath();
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", "utf8");
  renameSync(tmp, file);
  writeFileSync(backupPath(file), JSON.stringify(store, null, 2) + "\n", "utf8");
}

function waitSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withStoreLock<T>(fn: () => T): T {
  const file = storePath();
  const lockDir = `${file}.lock`;
  mkdirSync(path.dirname(file), { recursive: true });
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < LOCK_TIMEOUT_MS) {
    try {
      mkdirSync(lockDir);
      try {
        writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid, createdAt: Date.now() }) + "\n", "utf8");
      } catch {
        // The directory itself is the lock; owner metadata is best-effort.
      }
      try {
        return fn();
      } finally {
        rmSync(lockDir, { recursive: true, force: true });
      }
    } catch (err) {
      lastError = err;
      if ((err as { code?: string }).code !== "EEXIST") throw err;
      try {
        const stat = statSync(lockDir);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch (statError) {
        if ((statError as { code?: string }).code !== "ENOENT") lastError = statError;
      }
      waitSync(50);
    }
  }
  throw new Error(`Timed out acquiring Goal Runner store lock at ${lockDir}: ${String(lastError)}`);
}

function getSessionId(ctx: any): string | undefined {
  return ctx?.sessionManager?.getSessionId?.();
}

function updateGoal(sessionId: string, updater: (goal: GoalRecord | undefined) => GoalRecord | undefined): GoalRecord | undefined {
  return withStoreLock(() => {
    const store = readStore();
    const next = updater(store.sessions[sessionId] ? normalizeGoal(store.sessions[sessionId]) : undefined);
    if (next) {
      next.updatedAt = Date.now();
      store.sessions[sessionId] = normalizeGoal(next);
    } else {
      delete store.sessions[sessionId];
    }
    writeStore(store);
    return next;
  });
}

function activeGoal(sessionId: string): GoalRecord | undefined {
  const goal = readStore().sessions[sessionId];
  if (!goal) return undefined;
  if (goal.status === "running" || goal.status === "draft") return normalizeGoal(goal);
  return undefined;
}

function retryDelay(failures: number): number {
  if (failures > 12) return MAX_RETRY_MS;
  const exp = Math.max(0, failures - 1);
  return Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** exp);
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

function makeSubtask(text: string): GoalSubtask {
  const now = Date.now();
  return {
    id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    text,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };
}

function goalText(goal: GoalRecord): string {
  const active = goal.subtasks.filter((task) => task.status !== "done");
  if (!active.length) return goal.objective;
  return `${goal.objective}\n\nSubgoals:\n${active.map((task, index) => `${index + 1}. [${task.status}] ${task.text}`).join("\n")}`;
}

function clarificationPrompt(objective: string): string {
  return `You are starting a long-running Goal. Objective:\n\n${objective}\n\nBefore execution, ask only the questions that are truly needed for this specific objective. Keep it concise: ideally 6-10 numbered questions, not a huge generic checklist. Cover acceptance criteria, scope, priority, permissions for risky actions, available hosts/accounts/secrets, validation method, and anything uniquely ambiguous in this objective.\n\nDo not execute yet. End by asking the user to answer so execution can begin.`;
}

function continuePrompt(goal: GoalRecord): string {
  const modeText = goal.mode === "forever"
    ? "Mode: forever (keep improving even after likely completion; do not call goal_complete unless requested)"
    : "Mode: finish (work toward completion; when all requirements and subgoals are completely accomplished and verified, call the goal_complete tool to mark the goal finished and conclude autonomous continuation)";

  const finishRule = goal.mode === "finish"
    ? "6. In finish mode: if all requirements and subgoals are completely finished and verified, you must call the goal_complete tool before giving your final summary to stop automated loops. Do not summarize without calling goal_complete if the goal is truly done. In forever mode: continue improving without calling goal_complete."
    : "6. In forever mode: continuously improve, refactor, and harden even after core completion. Do not call goal_complete.";

  return `Continue the active long-running Goal. Do not stop unless the user explicitly uses /goal-stop or /goal-pause.\n\n${goalText(goal)}\n\n${modeText}\nIteration: ${goal.iteration + 1}\n\nRules:\n1. Inspect the previous result and current state, then choose the next useful step.\n2. If something failed, diagnose, change strategy, and verify.\n3. If information is missing but not safety-critical, make a reasonable assumption and continue.\n4. Ask the user only when blocked by safety, credentials, irreversible operations, or unclear acceptance criteria.\n5. Use explicit timeouts for blocking shell/network commands.\n${finishRule}`;
}

function startAfterClarificationPrompt(goal: GoalRecord, answer: string): string {
  const finishNote = goal.mode === "finish"
    ? " In 'finish' mode, when all objectives are complete and verified, call the `goal_complete` tool to finish the goal and conclude the loop."
    : "";
  return `The user answered the Goal clarification questions. Begin execution now.\n\n${goalText(goal)}\n\nUser clarification answer:\n${answer}\n\nFirst make a short execution plan, then immediately perform the first concrete step.${finishNote} Goal Runner will continue automatically until the user pauses/stops/completes it or goal_complete is called.`;
}

function failurePrompt(goal: GoalRecord): string {
  const delay = goal.nextRetryAt && goal.nextRetryAt > Date.now() ? formatMs(goal.nextRetryAt - Date.now()) : "now";
  return `Recover and continue the active Goal. The previous turn failed or was interrupted; Goal Runner is retrying with backoff.\n\n${goalText(goal)}\n\nRecent error: ${goal.lastError || "unknown"}\nConsecutive failures: ${goal.consecutiveFailures}\nRetry time: ${delay}\n\nUse a safer strategy, diagnose first, and continue. Do not give up unless the user manually stops the Goal.`;
}

function clearTimer(sessionId: string): void {
  const timer = timers.get(sessionId);
  if (timer) clearTimeout(timer);
  timers.delete(sessionId);
}

function notify(ctx: any, message: string, level: "info" | "error" = "info"): void {
  ctx?.ui?.notify?.(message, level);
}

function scheduleContinuation(pi: ExtensionAPI, sessionId: string, delayMs: number, promptFactory: () => string): void {
  clearTimer(sessionId);
  const timer = setTimeout(() => {
    timers.delete(sessionId);
    const goal = activeGoal(sessionId);
    if (!goal || goal.status !== "running") return;
    pi.sendUserMessage(promptFactory(), { deliverAs: "followUp" });
  }, Math.max(0, delayMs));
  timers.set(sessionId, timer);
}

function scheduleRunningGoal(pi: ExtensionAPI, sessionId: string, goal: GoalRecord, reason: "settled" | "startup" = "settled"): void {
  if (goal.status !== "running") return;
  const now = Date.now();
  const storedDelay = goal.nextRetryAt && goal.nextRetryAt > now ? goal.nextRetryAt - now : 0;
  // On session_start we wait a little longer. If Pi-web is also restoring a
  // genuinely interrupted in-flight turn, before_agent_start will clear this
  // timer before it fires, preventing duplicate continuations.
  const startupGuard = reason === "startup" ? 5_000 : 0;
  const delay = Math.max(storedDelay, startupGuard);
  const snapshot = { ...goal };
  const promptFactory = () => snapshot.consecutiveFailures > 0 ? failurePrompt(snapshot) : continuePrompt(snapshot);
  scheduleContinuation(pi, sessionId, delay, promptFactory);
}

function startGoal(pi: ExtensionAPI, ctx: any, sessionId: string, objective: string): void {
  const trimmed = objective.trim();
  if (!trimmed) {
    notify(ctx, "Usage: /goal <objective> or /goal-start <objective>", "error");
    return;
  }
  const existing = readStore().sessions[sessionId];
  if (existing && existing.status !== "stopped" && existing.status !== "complete") {
    addGoal(pi, ctx, sessionId, trimmed);
    return;
  }
  const now = Date.now();
  updateGoal(sessionId, () => appendEvent({
    sessionId,
    objective: trimmed,
    subtasks: [],
    events: [],
    status: "draft",
    phase: "clarifying",
    mode: "finish",
    createdAt: now,
    updatedAt: now,
    iteration: 0,
    consecutiveFailures: 0,
  }, "start", "Goal started and awaiting clarification"));
  notify(ctx, "Goal Runner: clarification started", "info");
  const prompt = clarificationPrompt(trimmed);
  suppressNextClarificationInput.set(sessionId, prompt);
  pi.sendUserMessage(prompt, { deliverAs: "followUp" });
}

function addGoal(pi: ExtensionAPI, ctx: any, sessionId: string, text: string): void {
  const trimmed = text.trim();
  if (!trimmed) {
    notify(ctx, "Usage: /goal-add <subgoal> or /goal add <subgoal>", "error");
    return;
  }
  const goal = updateGoal(sessionId, (existing) => {
    if (!existing) {
      const now = Date.now();
      return appendEvent({
        sessionId,
        objective: trimmed,
        subtasks: [],
        events: [],
        status: "draft",
        phase: "clarifying",
        mode: "finish",
        createdAt: now,
        updatedAt: now,
        iteration: 0,
        consecutiveFailures: 0,
      }, "start", "Goal created from added subgoal and awaiting clarification");
    }
    return appendEvent({
      ...existing,
      subtasks: [...(existing.subtasks || []), makeSubtask(trimmed)],
      status: existing.status === "paused" ? "paused" : existing.status,
    }, "add", trimmed.slice(0, 160));
  });
  notify(ctx, goal?.subtasks?.length ? "Goal Runner: subgoal added" : "Goal Runner: goal created", "info");
  if (goal?.status === "running") {
    pi.sendUserMessage(`A new subgoal was appended to the active Goal:\n\n${trimmed}\n\nIncorporate it into the current plan and continue.`, { deliverAs: "followUp" });
  } else if (goal?.status === "draft") {
    const prompt = clarificationPrompt(goal.objective);
    suppressNextClarificationInput.set(sessionId, prompt);
    pi.sendUserMessage(prompt, { deliverAs: "followUp" });
  }
}

function runGoal(pi: ExtensionAPI, ctx: any, sessionId: string): void {
  const goal = updateGoal(sessionId, (existing) => {
    if (!existing) return undefined;
    return appendEvent({
      ...existing,
      status: "running",
      phase: "executing",
      nextRetryAt: undefined,
      lastError: undefined,
    }, "run", "Goal run requested now");
  });
  if (!goal) {
    notify(ctx, "Goal Runner: no goal in this session", "error");
    return;
  }
  notify(ctx, "Goal Runner: running now", "info");
  pi.sendUserMessage(continuePrompt(goal), { deliverAs: "followUp" });
}

function resumeGoal(pi: ExtensionAPI, ctx: any, sessionId: string): void {
  const goal = updateGoal(sessionId, (existing) => {
    if (!existing) return undefined;
    return appendEvent({
      ...existing,
      status: "running",
      phase: "executing",
      nextRetryAt: undefined,
      lastError: undefined,
    }, "resume", "Goal resumed");
  });
  if (!goal) {
    notify(ctx, "Goal Runner: no goal in this session", "error");
    return;
  }
  notify(ctx, "Goal Runner: resumed", "info");
  pi.sendUserMessage(continuePrompt(goal), { deliverAs: "followUp" });
}

function pauseGoal(ctx: any, sessionId: string): void {
  clearTimer(sessionId);
  const goal = updateGoal(sessionId, (existing) => existing ? appendEvent({ ...existing, status: "paused", nextRetryAt: undefined }, "pause", "Goal paused") : undefined);
  notify(ctx, goal ? "Goal Runner: paused" : "Goal Runner: no goal", goal ? "info" : "error");
}

function stopGoal(ctx: any, sessionId: string): void {
  clearTimer(sessionId);
  const goal = updateGoal(sessionId, (existing) => existing ? appendEvent({ ...existing, status: "stopped", nextRetryAt: undefined }, "stop", "Goal stopped") : undefined);
  notify(ctx, goal ? "Goal Runner: stopped" : "Goal Runner: no goal", goal ? "info" : "error");
}

function completeGoal(ctx: any, sessionId: string): void {
  clearTimer(sessionId);
  const goal = updateGoal(sessionId, (existing) => existing ? appendEvent({ ...existing, status: "complete", nextRetryAt: undefined }, "complete", "Goal marked complete") : undefined);
  notify(ctx, goal ? "Goal Runner: complete" : "Goal Runner: no goal", goal ? "info" : "error");
}

function setModeGoal(ctx: any, sessionId: string, modeArg: string): void {
  const mode = modeArg.trim().toLowerCase();
  if (mode !== "finish" && mode !== "forever") {
    notify(ctx, "Usage: /goal-mode finish|forever", "error");
    return;
  }
  const goal = updateGoal(sessionId, (existing) => existing ? appendEvent({ ...existing, mode: mode as GoalMode }, "mode", `Mode set to ${mode}`) : undefined);
  notify(ctx, goal ? `Goal Runner: mode ${mode}` : "Goal Runner: no goal", goal ? "info" : "error");
}

function statusGoal(ctx: any, sessionId: string): void {
  const goal = readStore().sessions[sessionId];
  if (!goal) {
    notify(ctx, "Goal Runner: no goal. Use /goal <objective>.", "info");
    return;
  }
  const now = Date.now();
  const retryText = goal.nextRetryAt
    ? goal.nextRetryAt > now
      ? `retry in ${formatMs(goal.nextRetryAt - now)}`
      : `retry overdue by ${formatMs(now - goal.nextRetryAt)}`
    : "retry now";
  const subtaskText = goal.subtasks?.length ? `subtasks ${goal.subtasks.filter((t) => t.status !== "done").length}/${goal.subtasks.length}` : "subtasks none";
  const eventSummary = eventSummaryText(goal);
  const backup = inspectStoreFileSync(backupPath());
  const current = backup.readable ? storeSessionInfoSync(backupPath(), sessionId) : { contains: null, status: null };
  const backupText = current.contains === true ? `backup current yes (${current.status || "unknown"})` : current.contains === false ? "backup current no" : "backup current unknown";
  notify(ctx, [
    `Goal Runner v${VERSION}: ${goal.status}/${goal.phase}, mode ${goal.mode}, iteration ${goal.iteration}, failures ${goal.consecutiveFailures}`,
    `${subtaskText}; ${retryText}`,
    `events: ${eventSummary}`, 
    backupText,
  ].join("\n"), "info");
}

function helpGoal(ctx: any): void {
  notify(ctx, [
    "Goal Runner commands:",
    "/goal <objective> or /goal-start <objective> — start a Goal, or append when one already exists",
    "/goal-add <subgoal> — append a subgoal",
    "/goal-status — show status, retry timing, events, and backup coverage",
    "/goal-run or /goal-resume — run now / resume immediately",
    "/goal-pause, /goal-stop, /goal-done — control lifecycle",
    "/goal-mode finish|forever — switch run mode",
    "/goal <subcommand> — subtasks, subtask done|open|block <n|id>, events [type...], doctor, config, lock, unlock, backup, restore-backup, list, help",
  ].join("\n"), "info");
}

function parseEventTypes(input: string): Set<string> {
  return new Set((input || "").split(/[\s,]+/).map((part) => part.trim().toLowerCase()).filter(Boolean));
}

function listEvents(ctx: any, sessionId: string, filterText = ""): void {
  const goal = readStore().sessions[sessionId];
  if (!goal) {
    notify(ctx, "No Goal in this session", "info");
    return;
  }
  const filters = parseEventTypes(filterText);
  const allEvents = Array.isArray(goal.events) ? goal.events : [];
  const rawTotal = goal[RAW_EVENT_COUNT] ?? allEvents.length;
  const compacted = rawTotal > allEvents.length;
  const matchedEvents = allEvents
    .filter((event) => filters.size === 0 || filters.has(String(event.type || "").toLowerCase()));
  const events = matchedEvents
    .slice(-8)
    .reverse();
  const filterLabel = filters.size ? [...filters].join(", ") : "all";
  const summary = `window ${allEvents.length}/${MAX_EVENTS}${rawTotal !== allEvents.length ? ` raw ${rawTotal}` : ""}${compacted ? " compacted" : ""}; returned ${events.length}${matchedEvents.length !== events.length ? ` shown of ${matchedEvents.length}` : ""}; filter ${filterLabel}`;
  if (events.length === 0) {
    notify(ctx, filters.size ? `Goal events (${summary}): none` : `Goal events (${summary}): none yet`, "info");
    return;
  }
  notify(ctx, `Goal events (${summary}):\n${events.map((event) => `- ${event.type}: ${event.message}`).join("\n")}`, "info");
}

function lockStatusText(): string {
  const lockDir = `${storePath()}.lock`;
  if (!existsSync(lockDir)) return `Goal Runner lock: free\npath: ${lockDir}`;
  let owner = "owner: unavailable";
  try {
    const parsed = JSON.parse(readFileSync(path.join(lockDir, "owner.json"), "utf8"));
    owner = `owner pid: ${parsed.pid ?? "unknown"}, createdAt: ${parsed.createdAt ?? "unknown"}`;
  } catch {
    // Best-effort owner metadata.
  }
  const ageMs = Math.max(0, Date.now() - statSync(lockDir).mtimeMs);
  const stale = ageMs > LOCK_STALE_MS;
  return `Goal Runner lock: ${stale ? "stale" : "held"}\npath: ${lockDir}\nage: ${formatMs(ageMs)}\n${owner}`;
}

function lockGoal(ctx: any): void {
  notify(ctx, lockStatusText(), "info");
}

function unlockGoal(ctx: any): void {
  const lockDir = `${storePath()}.lock`;
  if (!existsSync(lockDir)) {
    notify(ctx, `Goal Runner lock: already free\npath: ${lockDir}`, "info");
    return;
  }
  const ageMs = Math.max(0, Date.now() - statSync(lockDir).mtimeMs);
  if (ageMs <= LOCK_STALE_MS) {
    notify(ctx, `Goal Runner lock is held and not stale; not removing\npath: ${lockDir}\nage: ${formatMs(ageMs)}`, "info");
    return;
  }
  rmSync(lockDir, { recursive: true, force: true });
  notify(ctx, `Goal Runner: stale lock cleared\npath: ${lockDir}\nage: ${formatMs(ageMs)}`, "info");
}

function inspectStoreFileSync(file: string): { exists: boolean; readable: boolean; ageMs: number | null; sizeBytes: number | null; sessionCount: number | null; error?: string } {
  if (!existsSync(file)) return { exists: false, readable: false, ageMs: null, sizeBytes: null, sessionCount: null };
  const stat = statSync(file);
  try {
    const parsed = parseStoreFile(file, false);
    return {
      exists: true,
      readable: Boolean(parsed),
      ageMs: Math.max(0, Date.now() - stat.mtimeMs),
      sizeBytes: stat.size,
      sessionCount: parsed ? Object.keys(parsed.sessions).length : null,
      error: parsed ? undefined : "invalid store shape",
    };
  } catch (err) {
    return {
      exists: true,
      readable: false,
      ageMs: Math.max(0, Date.now() - stat.mtimeMs),
      sizeBytes: stat.size,
      sessionCount: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function storeSessionInfoSync(file: string, sessionId: string): { contains: boolean | null; status: string | null } {
  try {
    const store = parseStoreFile(file, false);
    if (!store) return { contains: null, status: null };
    const goal = store.sessions[sessionId];
    return { contains: Boolean(goal), status: goal?.status || null };
  } catch {
    return { contains: null, status: null };
  }
}

function backupStatusText(sessionId: string): string {
  const primary = inspectStoreFileSync(storePath());
  const backup = inspectStoreFileSync(backupPath());
  const restorable = !primary.readable && backup.readable;
  const current = backup.readable ? storeSessionInfoSync(backupPath(), sessionId) : { contains: null, status: null };
  const currentLine = current.contains === null ? "current session: unknown" : current.contains ? `current session: yes (${current.status || "unknown"})` : "current session: no";
  return `Goal Runner backup: ${backup.readable ? "readable" : backup.exists ? "unreadable" : "missing"}\npath: ${backupPath()}\nage: ${backup.ageMs == null ? "n/a" : formatMs(backup.ageMs)}\nsize: ${backup.sizeBytes ?? "n/a"}\nsessions: ${backup.sessionCount ?? "n/a"}\n${currentLine}\nprimary: ${primary.readable ? "readable" : primary.exists ? "unreadable" : "missing"}${primary.error ? ` (${primary.error})` : ""}\nrestorable: ${restorable ? "yes" : "no"}`;
}

function backupGoal(ctx: any, sessionId: string): void {
  notify(ctx, backupStatusText(sessionId), "info");
}

function restoreBackupGoal(ctx: any): void {
  withStoreLock(() => {
    const primary = inspectStoreFileSync(storePath());
    const backup = inspectStoreFileSync(backupPath());
    if (primary.readable) {
      notify(ctx, "Goal Runner backup restore refused: primary store is readable", "info");
      return;
    }
    if (!backup.readable) {
      notify(ctx, `Goal Runner backup restore refused: backup is not readable\n${backup.error || "missing backup"}`, "error");
      return;
    }
    const recovered = parseStoreFile(backupPath(), true);
    if (!recovered) {
      notify(ctx, "Goal Runner backup restore refused: invalid backup shape", "error");
      return;
    }
    writeStore(recovered);
    notify(ctx, "Goal Runner: primary store restored from backup", "info");
  });
}

function configGoal(ctx: any): void {
  notify(ctx, `Goal Runner v${VERSION}\nstore: ${storePath()}\nbackup: ${backupPath()}\nlock: ${storePath()}.lock, timeout ${Math.round(LOCK_TIMEOUT_MS / 1000)}s, stale ${Math.round(LOCK_STALE_MS / 1000)}s\nmax retry backoff: ${Math.round(MAX_RETRY_MS / 60000)}m\nevent window: ${MAX_EVENTS}\ndefault mode: finish\nremote deploy: scripts/deploy-remote-100-64-0-2.sh`, "info");
}

function eventSummaryText(goal?: GoalRecord): string {
  const events = Array.isArray(goal?.events) ? goal.events : [];
  const rawTotal = goal?.[RAW_EVENT_COUNT] ?? events.length;
  const compacted = rawTotal > events.length;
  return `window ${events.length}/${MAX_EVENTS}; returned ${events.length}${rawTotal !== events.length ? `; raw ${rawTotal}` : ""}${compacted ? "; compacted" : ""}; top ${eventTopTypes(events)}`;
}

function eventTopTypes(events: GoalEvent[]): string {
  const counts = new Map<string, number>();
  for (const event of events) counts.set(event.type, (counts.get(event.type) || 0) + 1);
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([type, count]) => `${type} ${count}`)
    .join(" · ");
  return top || "none";
}

function doctorGoal(ctx: any, sessionId: string): void {
  const store = readStore();
  const goal = store.sessions[sessionId];
  const primary = inspectStoreFileSync(storePath());
  const backup = inspectStoreFileSync(backupPath());
  const restorable = !primary.readable && backup.readable;
  const current = backup.readable ? storeSessionInfoSync(backupPath(), sessionId) : { contains: null, status: null };
  const currentBackupLine = current.contains === null ? "current unknown" : current.contains ? `current yes (${current.status || "unknown"})` : "current no";
  const lockFirstLine = lockStatusText().split("\n")[0];
  const goalLine = goal
    ? `goal: ${goal.status}/${goal.phase}, mode ${goal.mode}, iter ${goal.iteration}, failures ${goal.consecutiveFailures}`
    : "goal: none in this session";
  const retryLine = goal?.nextRetryAt
    ? `retry: ${goal.nextRetryAt > Date.now() ? `in ${formatMs(goal.nextRetryAt - Date.now())}` : `overdue by ${formatMs(Date.now() - goal.nextRetryAt)}`}`
    : "retry: none scheduled";
  const allEvents = goal?.events || [];
  const eventSummary = eventSummaryText(goal);
  const events = allEvents.length
    ? allEvents.slice(-5).reverse().map((event) => `- ${event.type}: ${event.message}`).join("\n")
    : "- none";
  notify(ctx, [
    `Goal Runner doctor v${VERSION}`,
    `store: ${storePath()}`,
    `backup: ${backup.readable ? "readable" : backup.exists ? "unreadable" : "missing"} (${backupPath()}), ${currentBackupLine}, restorable: ${restorable ? "yes" : "no"}`,
    lockFirstLine,
    goalLine,
    retryLine,
    `event summary: ${eventSummary}`, 
    "recent events:",
    events,
  ].join("\n"), "info");
}

function subtaskLines(goal: GoalRecord): string[] {
  return (goal.subtasks || []).map((task, index) => `${index + 1}. ${task.id} [${task.status}] ${task.text}`);
}

function listGoals(ctx: any): void {
  const goals = Object.values(readStore().sessions).filter((goal) => goal.status === "running" || goal.status === "paused" || goal.status === "draft");
  if (goals.length === 0) {
    notify(ctx, "Goal Runner: no active goals", "info");
    return;
  }
  const text = goals
    .slice(0, 8)
    .map((goal) => `${goal.status}/${goal.phase} · ${goal.objective.slice(0, 60)} · iter ${goal.iteration}${goal.subtasks?.length ? ` · subtasks ${goal.subtasks.filter((task) => task.status !== "done").length}/${goal.subtasks.length} open` : ""}`)
    .join("\n");
  notify(ctx, `Goal Runner active goals:\n${text}${goals.length > 8 ? `\n… and ${goals.length - 8} more` : ""}`, "info");
}

function listSubtasks(ctx: any, sessionId: string): void {
  const goal = readStore().sessions[sessionId];
  if (!goal) {
    notify(ctx, "Goal Runner: no goal", "error");
    return;
  }
  const lines = subtaskLines(goal);
  notify(ctx, lines.length ? `Goal Runner subtasks:\n${lines.join("\n")}` : "Goal Runner: no subtasks", "info");
}

function setSubtaskStatus(ctx: any, sessionId: string, target: string, status: GoalSubtask["status"]): void {
  const trimmed = target.trim();
  if (!trimmed) {
    notify(ctx, "Usage: /goal subtask done <number|id>", "error");
    return;
  }
  const goal = updateGoal(sessionId, (existing) => {
    if (!existing) return undefined;
    const tasks = existing.subtasks || [];
    const numeric = /^\d+$/.test(trimmed) ? Number(trimmed) - 1 : -1;
    let changed = false;
    const subtasks = tasks.map((task, index) => {
      const matches = index === numeric || task.id === trimmed || task.id.startsWith(trimmed);
      if (!matches) return task;
      changed = true;
      return { ...task, status, updatedAt: Date.now() };
    });
    if (!changed) return existing;
    return appendEvent({ ...existing, subtasks }, "subtask", `Subtask ${trimmed} -> ${status}`);
  });
  if (!goal) {
    notify(ctx, "Goal Runner: no goal", "error");
    return;
  }
  notify(ctx, `Goal Runner: subtask ${trimmed} -> ${status}`, "info");
}

function sessionOrNotify(ctx: any): string | undefined {
  const sessionId = getSessionId(ctx);
  if (!sessionId) notify(ctx, "Goal Runner: no session id", "error");
  return sessionId;
}

function parseGoalCommand(args: string): { action: string; text: string } {
  const trimmed = (args || "").trim();
  if (!trimmed) return { action: "status", text: "" };
  const [firstRaw, ...rest] = trimmed.split(/\s+/);
  const first = firstRaw.toLowerCase();
  const text = rest.join(" ").trim();

  if (first === "start" || first === "s") return { action: "start", text };
  if (first === "status" || first === "st") return { action: "status", text };
  if (first === "run") return { action: "run", text };
  if (first === "r" || first === "resume" || first === "continue") return { action: "resume", text };
  if (first === "pause" || first === "p") return { action: "pause", text };
  if (first === "stop" || first === "x") return { action: "stop", text };
  if (first === "complete" || first === "done") return { action: "complete", text };
  if (first === "add" || first === "a") return { action: "add", text };
  if (first === "mode") return { action: "mode", text };
  if (first === "list" || first === "ls" || first === "l") return { action: "list", text };
  if (first === "subtask" || first === "subtasks" || first === "task" || first === "tasks") {
    if (text) {
      const [subAction, ...subRest] = text.split(/\s+/);
      const subActionLower = subAction.toLowerCase();
      if (subActionLower === "done" || subActionLower === "open" || subActionLower === "block") {
        return { action: `subtask-${subActionLower}`, text: subRest.join(" ").trim() };
      }
    }
    return { action: "subtasks", text };
  }
  if (first === "events" || first === "event" || first === "log" || first === "logs") return { action: "events", text };
  if (first === "config" || first === "cfg") return { action: "config", text };
  if (first === "doctor" || first === "diag" || first === "diagnose") return { action: "doctor", text };
  if (first === "lock" || first === "locks") return { action: "lock", text };
  if (first === "unlock" || first === "unlock-stale-lock") return { action: "unlock", text };
  if (first === "backup" || first === "backups") return { action: "backup", text };
  if (first === "restore-backup") return { action: "restore-backup", text };
  if (first === "help" || first === "h") return { action: "help", text };

  if (!CONTROL_COMMANDS.has(first)) return { action: "start", text: trimmed };
  return { action: "status", text: "" };
}

function eventTypeCompletions(prefix: string) {
  const parts = (prefix || "").split(/[\s,]+/);
  const current = (parts.at(-1) || "").toLowerCase();
  return EVENT_TYPE_COMPLETIONS
    .filter((type) => type.startsWith(current))
    .map((type) => ({ value: type, label: `events: ${type}` }));
}

function commandCompletions(prefix: string) {
  const items = [
    { value: "status", label: "status — show current Goal status" },
    { value: "start ", label: "start <objective> — start a Goal" },
    { value: "add ", label: "add <subgoal> — append a subgoal" },
    { value: "run", label: "run — run immediately" },
    { value: "resume", label: "resume — resume paused Goal" },
    { value: "pause", label: "pause — pause Goal" },
    { value: "stop", label: "stop — stop Goal" },
    { value: "done", label: "done — mark Goal complete" },
    { value: "mode finish", label: "mode finish — finish-oriented mode" },
    { value: "mode forever", label: "mode forever — continuous mode" },
    { value: "subtasks", label: "subtasks — list subtasks" },
    { value: "events", label: "events [type...] — recent events" },
    { value: "doctor", label: "doctor — diagnostic summary" },
    { value: "config", label: "config — configuration" },
    { value: "lock", label: "lock — lock status" },
    { value: "unlock", label: "unlock — clear stale lock only" },
    { value: "backup", label: "backup — backup status" },
    { value: "restore-backup", label: "restore-backup — restore backup" },
    { value: "list", label: "list — list active Goals" },
    { value: "help", label: "help — show help" },
  ];
  const p = prefix.toLowerCase();
  return items.filter((item) => item.value.toLowerCase().startsWith(p));
}

export default function (pi: ExtensionAPI) {
  function register(name: string, description: string, action: (args: string, ctx: any, sessionId: string) => void, completions?: (prefix: string) => any[]) {
    pi.registerCommand(name, {
      description,
      getArgumentCompletions: completions || (name === "goal" ? commandCompletions : undefined),
      handler: async (args: string, ctx: any) => {
        const sessionId = sessionOrNotify(ctx);
        if (!sessionId) return;
        action(args, ctx, sessionId);
      },
    });
  }

  const mainHandler = (args: string, ctx: any, sessionId: string) => {
    const parsed = parseGoalCommand(args);
    if (parsed.action === "start") return startGoal(pi, ctx, sessionId, parsed.text);
    if (parsed.action === "add") return addGoal(pi, ctx, sessionId, parsed.text);
    if (parsed.action === "run") return runGoal(pi, ctx, sessionId);
    if (parsed.action === "resume") return resumeGoal(pi, ctx, sessionId);
    if (parsed.action === "pause") return pauseGoal(ctx, sessionId);
    if (parsed.action === "stop") return stopGoal(ctx, sessionId);
    if (parsed.action === "complete") return completeGoal(ctx, sessionId);
    if (parsed.action === "mode") return setModeGoal(ctx, sessionId, parsed.text);
    if (parsed.action === "list") return listGoals(ctx);
    if (parsed.action === "subtasks") return listSubtasks(ctx, sessionId);
    if (parsed.action === "subtask-done") return setSubtaskStatus(ctx, sessionId, parsed.text, "done");
    if (parsed.action === "subtask-open") return setSubtaskStatus(ctx, sessionId, parsed.text, "pending");
    if (parsed.action === "subtask-block") return setSubtaskStatus(ctx, sessionId, parsed.text, "blocked");
    if (parsed.action === "events") return listEvents(ctx, sessionId, parsed.text);
    if (parsed.action === "config") return configGoal(ctx);
    if (parsed.action === "doctor") return doctorGoal(ctx, sessionId);
    if (parsed.action === "lock") return lockGoal(ctx);
    if (parsed.action === "unlock") return unlockGoal(ctx);
    if (parsed.action === "backup") return backupGoal(ctx, sessionId);
    if (parsed.action === "restore-backup") return restoreBackupGoal(ctx);
    if (parsed.action === "help") return helpGoal(ctx);
    return statusGoal(ctx, sessionId);
  };

  register("goal", "Goal Runner control", mainHandler);
  register("goal-start", "Start a persistent goal", (args, ctx, sessionId) => startGoal(pi, ctx, sessionId, args));
  register("goal-add", "Append a subgoal", (args, ctx, sessionId) => addGoal(pi, ctx, sessionId, args));
  register("goal-status", "Show Goal status, retry timing, events, and backup coverage", (_args, ctx, sessionId) => statusGoal(ctx, sessionId));
  register("goal-run", "Run Goal now", (_args, ctx, sessionId) => runGoal(pi, ctx, sessionId));
  register("goal-resume", "Resume Goal", (_args, ctx, sessionId) => resumeGoal(pi, ctx, sessionId));
  register("goal-pause", "Pause Goal", (_args, ctx, sessionId) => pauseGoal(ctx, sessionId));
  register("goal-stop", "Stop Goal", (_args, ctx, sessionId) => stopGoal(ctx, sessionId));
  register("goal-done", "Mark Goal complete", (_args, ctx, sessionId) => completeGoal(ctx, sessionId));
  register("goal-complete", "Mark Goal complete", (_args, ctx, sessionId) => completeGoal(ctx, sessionId));
  register("goal-mode", "Set Goal mode: finish|forever", (args, ctx, sessionId) => setModeGoal(ctx, sessionId, args));

  // Register goal_complete tool so the AI can mark a finished Goal complete in finish mode.
  pi.registerTool?.({
    name: "goal_complete",
    label: "Goal Complete",
    description: "Mark the current Goal complete and stop autonomous continuation loops. Use this in finish mode when the objective and all subgoals are fully accomplished and verified.",
    parameters: Type.Object({
      summary: Type.String({ description: "Concise summary of what was completed and verified" }),
    }),
    execute: async (_toolCallId: string, params: { summary: string }, _signal: any, _onUpdate: any, ctx: any): Promise<any> => {
      const sessionId = getSessionId(ctx);
      if (!sessionId) {
        return {
          content: [{ type: "text", text: "No active session ID found." }],
          details: { ok: false, error: "no_session_id" },
          isError: true,
        };
      }
      const goal = readStore().sessions[sessionId];
      if (!goal || goal.status !== "running") {
        return {
          content: [{ type: "text", text: `No running goal found for session ${sessionId}.` }],
          details: { ok: false, error: "no_running_goal" },
        };
      }
      clearTimer(sessionId);
      updateGoal(sessionId, (g) => g ? appendEvent({
        ...g,
        status: "complete",
        phase: "executing",
        nextRetryAt: undefined,
        lastError: undefined,
        consecutiveFailures: 0,
      }, "complete", `Goal marked complete by AI: ${params.summary}`) : undefined);
      notify(ctx, "Goal Runner: goal marked complete by AI", "info");
      return {
        content: [{ type: "text", text: `Goal marked complete successfully. Autonomous continuation concluded.\nSummary: ${params.summary}` }],
        details: { ok: true, summary: params.summary },
      };
    },
  });

  pi.on("session_start", async (_event: any, ctx: any) => {
    const sessionId = getSessionId(ctx);
    if (!sessionId) return;
    const goal = readStore().sessions[sessionId];
    if (!goal || goal.status !== "running") return;
    scheduleRunningGoal(pi, sessionId, normalizeGoal(goal), "startup");
    notify(ctx, "Goal Runner: restored running goal after session start", "info");
  });

  pi.on("input", async (event: any, ctx: any) => {
    const sessionId = getSessionId(ctx);
    if (!sessionId) return;
    const text = String(event?.text || "").trim();
    if (!text || text.startsWith("/goal") || text.startsWith("/g")) return;
    const goal = readStore().sessions[sessionId];
    if (!goal || goal.status !== "draft" || goal.phase !== "clarifying") return;

    const suppressed = suppressNextClarificationInput.get(sessionId);
    if (suppressed && (text === suppressed || text.startsWith("You are starting a long-running Goal."))) {
      suppressNextClarificationInput.delete(sessionId);
      return;
    }
    const updated = updateGoal(sessionId, (existing) => existing ? appendEvent({
      ...existing,
      status: "running",
      phase: "executing",
      consecutiveFailures: 0,
      nextRetryAt: undefined,
      lastError: undefined,
    }, "clarified", "Clarification answered; execution started") : undefined);
    if (!updated) return;
    return { action: "transform", text: startAfterClarificationPrompt(updated, text), images: event.images };
  });

  pi.on("before_agent_start", async (_event, ctx: any) => {
    const sessionId = getSessionId(ctx);
    if (!sessionId) return;
    clearTimer(sessionId);
  });

  pi.on("agent_settled", async (event: any, ctx: any) => {
    const sessionId = getSessionId(ctx);
    if (!sessionId) return;
    const current = readStore().sessions[sessionId];
    if (!current || current.status !== "running") return;

    const failed = event?.outcome === "error" || event?.outcome === "aborted";
    const updated = updateGoal(sessionId, (goal) => {
      if (!goal || goal.status !== "running") return goal;
      const failures = failed ? goal.consecutiveFailures + 1 : 0;
      const delay = failed ? retryDelay(failures) : 750;
      return appendEvent({
        ...goal,
        iteration: goal.iteration + 1,
        consecutiveFailures: failures,
        lastOutcome: event?.outcome || "completed",
        lastError: failed ? `agent settled with outcome ${event?.outcome || "unknown"}` : undefined,
        nextRetryAt: Date.now() + delay,
      }, failed ? "retry" : "settled", failed ? `Settled as ${event?.outcome || "unknown"}; retry in ${formatMs(delay)}` : "Settled successfully; next continuation scheduled");
    });
    if (!updated || updated.status !== "running") return;

    scheduleRunningGoal(pi, sessionId, updated, "settled");
  });

  pi.on("session_shutdown", async (_event: any, ctx: any) => {
    const sessionId = getSessionId(ctx);
    if (sessionId) clearTimer(sessionId);
  });
}
