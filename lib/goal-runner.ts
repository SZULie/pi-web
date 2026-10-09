import { existsSync } from "fs";
import fs from "fs/promises";
import { homedir } from "os";
import path from "path";
import { setTimeout as sleep } from "timers/promises";

export type GoalStatus = "draft" | "running" | "paused" | "stopped" | "complete";
export type GoalMode = "finish" | "forever";

export interface GoalSubtask {
  id: string;
  text: string;
  status: "pending" | "active" | "done" | "blocked";
  createdAt: number;
  updatedAt: number;
}

export interface GoalEvent {
  id: string;
  type: string;
  message: string;
  createdAt: number;
}

export interface GoalRecord {
  sessionId: string;
  objective: string;
  subtasks?: GoalSubtask[];
  status: GoalStatus;
  phase: "clarifying" | "executing";
  mode?: GoalMode;
  createdAt: number;
  updatedAt: number;
  iteration: number;
  consecutiveFailures: number;
  nextRetryAt?: number;
  lastError?: string;
  lastOutcome?: string;
  events?: GoalEvent[];
}

export interface GoalStore {
  version: 1;
  sessions: Record<string, GoalRecord>;
}

export interface GoalRunnerLockStatus {
  path: string;
  exists: boolean;
  ageMs: number | null;
  stale: boolean;
  owner: Record<string, unknown> | null;
}

export interface GoalRunnerBackupStatus {
  path: string;
  exists: boolean;
  readable: boolean;
  ageMs: number | null;
  sizeBytes: number | null;
  sessionCount: number | null;
  containsCurrentSession?: boolean | null;
  currentSessionStatus?: GoalStatus | null;
  primaryExists: boolean;
  primaryReadable: boolean;
  restorable: boolean;
  error?: string;
  primaryError?: string;
}

export const GOAL_RUNNER_VERSION = "1.4.0";
export const GOAL_RUNNER_MAX_RETRY_MS = 20 * 60 * 1000;
export const GOAL_RUNNER_MAX_EVENTS = 40;
export const GOAL_RUNNER_LOCK_TIMEOUT_MS = 10_000;
export const GOAL_RUNNER_LOCK_STALE_MS = 60_000;
export const GOAL_RUNNER_WATCHDOG_INTERVAL_MS = 30_000;
const GOAL_RUNNER_STORE_QUEUE = Symbol.for("pi-web.goal-runner.store");
const GOAL_RUNNER_RAW_EVENT_TOTAL = Symbol("pi-web.goal-runner.raw-event-total");
type GoalRecordWithRawEventTotal = GoalRecord & { [GOAL_RUNNER_RAW_EVENT_TOTAL]?: number };

function serializeGoalRunnerStoreUpdate<T>(key: string, task: () => Promise<T>): Promise<T> {
  const store = globalThis as Record<symbol, Map<string, Promise<void>> | undefined>;
  const chains = (store[GOAL_RUNNER_STORE_QUEUE] ??= new Map());
  const run = (chains.get(key) ?? Promise.resolve()).then(task);
  const tail = run.then(() => undefined, () => undefined);
  chains.set(key, tail);
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return run;
}

function goalRunnerLockPath(file = getGoalRunnerStorePath()): string {
  return `${file}.lock`;
}

function goalRunnerBackupPath(file = getGoalRunnerStorePath()): string {
  return `${file}.bak`;
}

export async function getGoalRunnerLockStatus(file = getGoalRunnerStorePath()): Promise<GoalRunnerLockStatus> {
  const lockDir = goalRunnerLockPath(file);
  try {
    const stat = await fs.stat(lockDir);
    let owner: Record<string, unknown> | null = null;
    try {
      owner = JSON.parse(await fs.readFile(path.join(lockDir, "owner.json"), "utf8"));
    } catch {
      owner = null;
    }
    const ageMs = Math.max(0, Date.now() - stat.mtimeMs);
    return {
      path: lockDir,
      exists: true,
      ageMs,
      stale: ageMs > GOAL_RUNNER_LOCK_STALE_MS,
      owner,
    };
  } catch (err) {
    if ((err as { code?: string }).code !== "ENOENT") throw err;
    return { path: lockDir, exists: false, ageMs: null, stale: false, owner: null };
  }
}

export async function clearStaleGoalRunnerLock(file = getGoalRunnerStorePath()): Promise<{
  cleared: boolean;
  reason: string;
  before: GoalRunnerLockStatus;
  after: GoalRunnerLockStatus;
}> {
  const before = await getGoalRunnerLockStatus(file);
  if (!before.exists) return { cleared: false, reason: "lock is already free", before, after: before };
  if (!before.stale) return { cleared: false, reason: "lock is held and not stale", before, after: before };
  await fs.rm(before.path, { recursive: true, force: true });
  const after = await getGoalRunnerLockStatus(file);
  return { cleared: !after.exists, reason: after.exists ? "failed to remove stale lock" : "stale lock cleared", before, after };
}

async function inspectGoalRunnerStoreFile(file: string): Promise<{
  exists: boolean;
  readable: boolean;
  ageMs: number | null;
  sizeBytes: number | null;
  sessionCount: number | null;
  error?: string;
}> {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) {
      return { exists: true, readable: false, ageMs: null, sizeBytes: null, sessionCount: null, error: "not a file" };
    }
    try {
      const store = await readGoalRunnerStoreFile(file);
      if (!store) {
        return {
          exists: true,
          readable: false,
          ageMs: Math.max(0, Date.now() - stat.mtimeMs),
          sizeBytes: stat.size,
          sessionCount: null,
          error: "invalid store shape",
        };
      }
      return {
        exists: true,
        readable: true,
        ageMs: Math.max(0, Date.now() - stat.mtimeMs),
        sizeBytes: stat.size,
        sessionCount: Object.keys(store.sessions).length,
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
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") {
      return { exists: false, readable: false, ageMs: null, sizeBytes: null, sessionCount: null };
    }
    return {
      exists: false,
      readable: false,
      ageMs: null,
      sizeBytes: null,
      sessionCount: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function getGoalRunnerBackupStatus(file = getGoalRunnerStorePath(), currentSessionId?: string): Promise<GoalRunnerBackupStatus> {
  const backup = goalRunnerBackupPath(file);
  const [primaryStatus, backupStatus] = await Promise.all([
    inspectGoalRunnerStoreFile(file),
    inspectGoalRunnerStoreFile(backup),
  ]);
  let containsCurrentSession: boolean | null | undefined;
  let currentSessionStatus: GoalStatus | null | undefined;
  if (currentSessionId && backupStatus.readable) {
    try {
      const parsed = JSON.parse(await fs.readFile(backup, "utf8"));
      const store = normalizeGoalStore(parsed);
      const goal = store?.sessions[currentSessionId];
      containsCurrentSession = Boolean(goal);
      currentSessionStatus = goal?.status ?? null;
    } catch {
      containsCurrentSession = null;
      currentSessionStatus = null;
    }
  }
  return {
    path: backup,
    exists: backupStatus.exists,
    readable: backupStatus.readable,
    ageMs: backupStatus.ageMs,
    sizeBytes: backupStatus.sizeBytes,
    sessionCount: backupStatus.sessionCount,
    containsCurrentSession,
    currentSessionStatus,
    primaryExists: primaryStatus.exists,
    primaryReadable: primaryStatus.readable,
    restorable: !primaryStatus.readable && backupStatus.readable,
    error: backupStatus.error,
    primaryError: primaryStatus.error,
  };
}

export async function restoreGoalRunnerStoreFromBackup(file = getGoalRunnerStorePath()): Promise<{
  restored: boolean;
  reason: string;
  before: GoalRunnerBackupStatus;
  after: GoalRunnerBackupStatus;
}> {
  const before = await getGoalRunnerBackupStatus(file);
  if (before.primaryReadable) {
    return { restored: false, reason: "primary store is readable; refusing to overwrite it", before, after: before };
  }
  if (!before.readable) {
    return { restored: false, reason: "backup store is not readable", before, after: before };
  }
  const recovered = await readGoalRunnerStoreFile(before.path, true);
  if (!recovered) {
    return { restored: false, reason: "backup store has invalid shape", before, after: before };
  }
  await writeGoalRunnerStore(recovered, file);
  const after = await getGoalRunnerBackupStatus(file);
  return { restored: after.primaryReadable, reason: after.primaryReadable ? "primary store restored from backup" : "restore attempted but primary is still unreadable", before, after };
}

async function acquireGoalRunnerFileLock(file = getGoalRunnerStorePath()): Promise<() => Promise<void>> {
  const lockDir = goalRunnerLockPath(file);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < GOAL_RUNNER_LOCK_TIMEOUT_MS) {
    try {
      await fs.mkdir(lockDir);
      try {
        await fs.writeFile(
          path.join(lockDir, "owner.json"),
          JSON.stringify({ pid: process.pid, createdAt: Date.now() }) + "\n",
          "utf8",
        );
      } catch {
        // The directory itself is the lock; owner metadata is best-effort.
      }
      return async () => {
        await fs.rm(lockDir, { recursive: true, force: true });
      };
    } catch (err) {
      lastError = err;
      if ((err as { code?: string }).code !== "EEXIST") throw err;
      try {
        const stat = await fs.stat(lockDir);
        if (Date.now() - stat.mtimeMs > GOAL_RUNNER_LOCK_STALE_MS) {
          await fs.rm(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch (statError) {
        if ((statError as { code?: string }).code !== "ENOENT") lastError = statError;
      }
      await sleep(50);
    }
  }
  throw new Error(`Timed out acquiring Goal Runner store lock at ${lockDir}: ${String(lastError)}`);
}

function makeGoalEvent(type: string, message: string): GoalEvent {
  const now = Date.now();
  return {
    id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    message,
    createdAt: now,
  };
}

function compactGoalEvents(events: GoalEvent[]): GoalEvent[] {
  const compacted: GoalEvent[] = [];
  for (const event of events) {
    const last = compacted.at(-1);
    if (last && last.type === event.type && last.message === event.message) {
      compacted[compacted.length - 1] = event;
    } else {
      compacted.push(event);
    }
  }
  return compacted.slice(-GOAL_RUNNER_MAX_EVENTS);
}

export function appendGoalEvent(goal: GoalRecord, type: string, message: string): GoalRecord {
  const events = compactGoalEvents(Array.isArray(goal.events) ? goal.events : []);
  const last = events.at(-1);
  if (last && last.type === type && last.message === message) {
    return {
      ...goal,
      events: [...events.slice(0, -1), { ...last, createdAt: Date.now() }].slice(-GOAL_RUNNER_MAX_EVENTS),
    };
  }
  return {
    ...goal,
    events: compactGoalEvents([...events, makeGoalEvent(type, message)]),
  };
}

export interface GoalRecordDiagnostics {
  health: "idle" | "running" | "healthy" | "waiting" | "retrying" | "overdue" | "stale" | "failed";
  healthReason: string;
  retryDelayMs: number | null;
  retryOverdueMs: number | null;
  updatedAgeMs: number;
}

export interface GoalRuntimeStatus {
  liveRunning: boolean;
  completionNotificationSuppressed: boolean;
}

export interface GoalEventSummary {
  total: number;
  rawTotal: number;
  returnedTotal: number;
  compacted: boolean;
  filtered: boolean;
  filterTypes: string[];
  maxEvents: number;
  oldestAt: number | null;
  byType: Record<string, number>;
  topTypes: Array<{ type: string; count: number; latestAt: number; latestMessage: string }>;
  latestAt: number | null;
  latestType: string | null;
  latestMessage: string | null;
}

export type GoalRecordWithDiagnostics = GoalRecord & {
  subtasks: GoalSubtask[];
  events: GoalEvent[];
  mode: GoalMode;
  eventSummary: GoalEventSummary;
  diagnostics: GoalRecordDiagnostics;
  runtime: GoalRuntimeStatus;
};

export function getGoalRunnerStorePath(): string {
  return path.join(homedir(), ".pi", "agent", "goal-runner.json");
}

function normalizeGoalStore(parsed: GoalStore): GoalStore | null {
  if (!parsed || parsed.version !== 1 || typeof parsed.sessions !== "object" || Array.isArray(parsed.sessions)) {
    return null;
  }
  for (const [id, goal] of Object.entries(parsed.sessions)) {
    goal.sessionId = typeof goal.sessionId === "string" && goal.sessionId ? goal.sessionId : id;
    goal.subtasks = Array.isArray(goal.subtasks) ? goal.subtasks : [];
    const rawEvents = Array.isArray(goal.events) ? goal.events : [];
    (goal as GoalRecordWithRawEventTotal)[GOAL_RUNNER_RAW_EVENT_TOTAL] = rawEvents.length;
    goal.events = compactGoalEvents(rawEvents);
    goal.mode = goal.mode || "finish";
    if (goal.status === "complete" || goal.status === "stopped" || goal.status === "paused") {
      delete goal.nextRetryAt;
    }
  }
  return parsed;
}

async function readGoalRunnerStoreFile(file: string, recoveredFromBackup = false): Promise<GoalStore | null> {
  const parsed = JSON.parse(await fs.readFile(file, "utf8")) as GoalStore;
  const store = normalizeGoalStore(parsed);
  if (!store) return null;
  if (recoveredFromBackup) {
    for (const [id, goal] of Object.entries(store.sessions)) {
      store.sessions[id] = appendGoalEvent(goal, "recover", "Recovered Goal state from backup after primary store was unreadable");
    }
  }
  return store;
}

export async function readGoalRunnerStore(): Promise<GoalStore> {
  const file = getGoalRunnerStorePath();
  if (!existsSync(file)) return { version: 1, sessions: {} };
  try {
    const store = await readGoalRunnerStoreFile(file);
    if (store) return store;
  } catch {
    // Fall back to the last known-good backup below.
  }
  try {
    const store = await readGoalRunnerStoreFile(goalRunnerBackupPath(file), true);
    if (store) return store;
  } catch {
    // No readable backup.
  }
  return { version: 1, sessions: {} };
}

export async function writeGoalRunnerStore(store: GoalStore, file = getGoalRunnerStorePath()): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = path.join(
    path.dirname(file),
    `.goal-runner.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  await fs.writeFile(temp, JSON.stringify(store, null, 2) + "\n", "utf8");
  await fs.rename(temp, file);
  await fs.copyFile(file, goalRunnerBackupPath(file));
}

export async function updateGoalRunnerStore<T>(mutate: (store: GoalStore) => Promise<T> | T): Promise<T> {
  const file = getGoalRunnerStorePath();
  return serializeGoalRunnerStoreUpdate(file, async () => {
    const release = await acquireGoalRunnerFileLock(file);
    try {
      const store = await readGoalRunnerStore();
      const result = await mutate(store);
      await writeGoalRunnerStore(store);
      return result;
    } finally {
      await release();
    }
  });
}

export function goalContinuationPromptFromRecord(goal: GoalRecord): string {
  const openSubtasks = (goal.subtasks || []).filter((task) => task.status !== "done");
  const subtaskText = openSubtasks.length
    ? `\n\nSubgoals:\n${openSubtasks.map((task, index) => `${index + 1}. [${task.status}] ${task.text}`).join("\n")}`
    : "";
  return `Continue the active long-running Goal. Do not stop unless the user explicitly uses /g-stop, /goal-stop, /g-pause, or /goal-pause.\n\n${goal.objective}${subtaskText}\n\nMode: ${goal.mode || "finish"}\nIteration: ${(goal.iteration || 0) + 1}\n\nRules:\n1. Inspect the previous result and current state, then choose the next useful step.\n2. If something failed, diagnose, change strategy, and verify.\n3. If information is missing but not safety-critical, make a reasonable assumption and continue.\n4. Ask the user only when blocked by safety, credentials, irreversible operations, or unclear acceptance criteria.\n5. Use explicit timeouts for blocking shell/network commands.\n6. Do not summarize and stop just because the task is long.`;
}

export function applyGoalRunnerAction(goal: GoalRecord, action: string, mode?: string, text?: string, subtaskId?: string): GoalRecord | null {
  const now = Date.now();
  if (action === "pause") {
    return appendGoalEvent({ ...goal, status: "paused", nextRetryAt: undefined, updatedAt: now }, "pause", "Goal paused from Pi-web");
  }
  if (action === "stop") {
    return appendGoalEvent({ ...goal, status: "stopped", nextRetryAt: undefined, updatedAt: now }, "stop", "Goal stopped from Pi-web");
  }
  if (action === "complete") {
    return appendGoalEvent({ ...goal, status: "complete", nextRetryAt: undefined, updatedAt: now }, "complete", "Goal marked complete from Pi-web");
  }
  if (action === "resume" || action === "run-now") {
    return appendGoalEvent({
      ...goal,
      status: "running",
      phase: "executing",
      updatedAt: now,
      nextRetryAt: undefined,
      lastError: undefined,
    }, action === "run-now" ? "run" : "resume", action === "run-now" ? "Goal run requested from Pi-web" : "Goal resumed from Pi-web");
  }
  if (action === "mode") {
    const nextMode = mode === "forever" ? "forever" : mode === "finish" ? "finish" : null;
    if (!nextMode) return null;
    return appendGoalEvent({ ...goal, mode: nextMode, updatedAt: now }, "mode", `Mode set to ${nextMode} from Pi-web`);
  }
  if (action === "add") {
    const trimmed = typeof text === "string" ? text.trim() : "";
    if (!trimmed) return null;
    const subtasks = Array.isArray(goal.subtasks) ? goal.subtasks : [];
    return appendGoalEvent({
      ...goal,
      subtasks: [
        ...subtasks,
        {
          id: `subtask-${now}-${Math.random().toString(36).slice(2, 8)}`,
          text: trimmed,
          status: "pending",
          createdAt: now,
          updatedAt: now,
        },
      ],
      updatedAt: now,
    }, "add", trimmed.slice(0, 160));
  }
  if (action === "subtask") {
    const nextStatus: GoalSubtask["status"] | null =
      mode === "done" || mode === "blocked" || mode === "pending" || mode === "active" ? mode : null;
    if (!subtaskId || !nextStatus) return null;
    const subtasks = Array.isArray(goal.subtasks) ? goal.subtasks : [];
    let changed = false;
    const updatedSubtasks = subtasks.map((task) => {
      if (task.id !== subtaskId) return task;
      changed = true;
      return { ...task, status: nextStatus, updatedAt: now };
    });
    if (!changed) return null;
    return appendGoalEvent({ ...goal, subtasks: updatedSubtasks, updatedAt: now }, "subtask", `Subtask ${subtaskId} -> ${nextStatus}`);
  }
  return null;
}

export function getGoalDiagnostics(goal: GoalRecord, now = Date.now(), isLiveRunning = false): GoalRecordDiagnostics {
  const retryDelayMs = goal.nextRetryAt && goal.nextRetryAt > now ? goal.nextRetryAt - now : null;
  const retryOverdueMs = goal.nextRetryAt && goal.nextRetryAt <= now ? Math.max(0, now - goal.nextRetryAt) : null;
  const updatedAgeMs = Math.max(0, now - (goal.updatedAt || 0));

  if (goal.status === "complete" || goal.status === "stopped" || goal.status === "paused") {
    return {
      health: "idle",
      healthReason: goal.status,
      retryDelayMs: null,
      retryOverdueMs: null,
      updatedAgeMs,
    };
  }

  if (isLiveRunning) {
    return {
      health: "running",
      healthReason: "session is actively running",
      retryDelayMs: null,
      retryOverdueMs: null,
      updatedAgeMs,
    };
  }

  if (goal.status === "draft") {
    return {
      health: "waiting",
      healthReason: "waiting for clarification",
      retryDelayMs,
      retryOverdueMs,
      updatedAgeMs,
    };
  }

  if (goal.consecutiveFailures > 0) {
    return {
      health: retryDelayMs !== null ? "retrying" : retryOverdueMs !== null ? "overdue" : "failed",
      healthReason: retryDelayMs !== null ? "retry scheduled after failure" : retryOverdueMs !== null ? "failure retry is overdue" : "failure needs retry",
      retryDelayMs,
      retryOverdueMs,
      updatedAgeMs,
    };
  }

  if (retryDelayMs !== null) {
    return {
      health: "waiting",
      healthReason: "next continuation scheduled",
      retryDelayMs,
      retryOverdueMs,
      updatedAgeMs,
    };
  }

  if (retryOverdueMs !== null) {
    return {
      health: "overdue",
      healthReason: "scheduled continuation is overdue",
      retryDelayMs,
      retryOverdueMs,
      updatedAgeMs,
    };
  }

  if (updatedAgeMs > 30 * 60 * 1000) {
    return {
      health: "stale",
      healthReason: "running goal has not updated recently",
      retryDelayMs,
      retryOverdueMs,
      updatedAgeMs,
    };
  }

  return {
    health: "healthy",
    healthReason: "running",
    retryDelayMs,
    retryOverdueMs,
    updatedAgeMs,
  };
}

function summarizeGoalEvents(events: GoalEvent[], rawTotal = events.length, filterTypes: string[] = [], returnedTotal = events.length): GoalEventSummary {
  const summary: GoalEventSummary = {
    total: events.length,
    rawTotal,
    returnedTotal,
    compacted: rawTotal > events.length,
    filtered: filterTypes.length > 0,
    filterTypes,
    maxEvents: GOAL_RUNNER_MAX_EVENTS,
    oldestAt: events.length > 0 ? Math.min(...events.map((event) => event.createdAt)) : null,
    byType: {},
    topTypes: [],
    latestAt: null,
    latestType: null,
    latestMessage: null,
  };
  for (const event of events) {
    summary.byType[event.type] = (summary.byType[event.type] || 0) + 1;
    if (summary.latestAt === null || event.createdAt > summary.latestAt) {
      summary.latestAt = event.createdAt;
      summary.latestType = event.type;
      summary.latestMessage = event.message;
    }
  }
  const latestByType: Record<string, { latestAt: number; latestMessage: string }> = {};
  for (const event of events) {
    const previous = latestByType[event.type];
    if (!previous || event.createdAt > previous.latestAt) {
      latestByType[event.type] = { latestAt: event.createdAt, latestMessage: event.message };
    }
  }
  summary.topTypes = Object.entries(summary.byType)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([type, count]) => ({ type, count, latestAt: latestByType[type].latestAt, latestMessage: latestByType[type].latestMessage }));
  return summary;
}

function normalizeGoalForStatus(
  goal: GoalRecord,
  now: number,
  runtimeStatusBySessionId = new Map<string, GoalRuntimeStatus>(),
  eventTypeFilter?: Set<string>,
): GoalRecordWithDiagnostics {
  const runtime = runtimeStatusBySessionId.get(goal.sessionId) || { liveRunning: false, completionNotificationSuppressed: false };
  const effectiveRuntime = {
    liveRunning: goal.status === "running" && runtime.liveRunning,
    completionNotificationSuppressed: goal.status === "running" && runtime.completionNotificationSuppressed,
  };
  const rawEvents = Array.isArray(goal.events) ? compactGoalEvents(goal.events) : [];
  const visibleEvents = eventTypeFilter && eventTypeFilter.size > 0
    ? rawEvents.filter((event) => eventTypeFilter.has(event.type))
    : rawEvents;
  const events = visibleEvents.length > 0
    ? visibleEvents.slice(-8).reverse()
    : rawEvents.length === 0 ? [{
      id: `legacy-${goal.sessionId}-${goal.updatedAt || goal.createdAt || 0}`,
      type: "state",
      message: "Goal state loaded from legacy record",
      createdAt: goal.updatedAt || goal.createdAt || now,
    }] : [];
  return {
    ...goal,
    subtasks: goal.subtasks || [],
    events,
    mode: goal.mode || "finish",
    eventSummary: summarizeGoalEvents(rawEvents, (goal as GoalRecordWithRawEventTotal)[GOAL_RUNNER_RAW_EVENT_TOTAL] ?? rawEvents.length, eventTypeFilter ? [...eventTypeFilter].sort() : [], events.length),
    diagnostics: getGoalDiagnostics(goal, now, effectiveRuntime.liveRunning),
    runtime: effectiveRuntime,
  };
}

export async function getGoalRunnerStatus(sessionId?: string, options: { runningSessionIds?: Iterable<string>; completionNotificationSuppressedSessionIds?: Iterable<string>; eventTypes?: Iterable<string> } = {}) {
  const store = await readGoalRunnerStore();
  const now = Date.now();
  const liveRunningSessionIds = new Set(options.runningSessionIds || []);
  const suppressedSessionIds = new Set(options.completionNotificationSuppressedSessionIds || []);
  const runtimeStatusBySessionId = new Map<string, GoalRuntimeStatus>();
  for (const id of new Set([...liveRunningSessionIds, ...suppressedSessionIds])) {
    runtimeStatusBySessionId.set(id, {
      liveRunning: liveRunningSessionIds.has(id),
      completionNotificationSuppressed: suppressedSessionIds.has(id),
    });
  }
  const eventTypeFilter = new Set(Array.from(options.eventTypes || []).map((type) => String(type).trim()).filter(Boolean));
  const sessions = Object.values(store.sessions).sort((a, b) => b.updatedAt - a.updatedAt);
  const current = sessionId ? store.sessions[sessionId] : undefined;
  return {
    available: true,
    storePath: getGoalRunnerStorePath(),
    config: {
      version: GOAL_RUNNER_VERSION,
      storePath: getGoalRunnerStorePath(),
      maxRetryMs: GOAL_RUNNER_MAX_RETRY_MS,
      defaultMode: "finish",
      lockTimeoutMs: GOAL_RUNNER_LOCK_TIMEOUT_MS,
      lockStaleMs: GOAL_RUNNER_LOCK_STALE_MS,
      lockPath: goalRunnerLockPath(),
      backupPath: goalRunnerBackupPath(),
      watchdogIntervalMs: GOAL_RUNNER_WATCHDOG_INTERVAL_MS,
      maxEvents: GOAL_RUNNER_MAX_EVENTS,
    },
    lock: await getGoalRunnerLockStatus(),
    backup: await getGoalRunnerBackupStatus(getGoalRunnerStorePath(), sessionId),
    current: current ? normalizeGoalForStatus(current, now, runtimeStatusBySessionId, eventTypeFilter) : null,
    active: sessions
      .filter((goal) => goal.status === "running" || goal.status === "draft" || goal.status === "paused")
      .slice(0, 10)
      .map((goal) => normalizeGoalForStatus(goal, now, runtimeStatusBySessionId, eventTypeFilter)),
    total: sessions.length,
  };
}
