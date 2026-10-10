import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

async function withHome(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-web-goal-runner-"));
  const oldHome = process.env.HOME;
  process.env.HOME = dir;
  try {
    await fn(dir);
  } finally {
    process.env.HOME = oldHome;
    await rm(dir, { recursive: true, force: true });
  }
}

test("reads missing goal store as an empty v1 store", async () => {
  await withHome(async () => {
    const mod = await import(`./goal-runner.ts?case=missing-${Date.now()}`);
    const store = await mod.readGoalRunnerStore();
    assert.deepEqual(store, { version: 1, sessions: {} });
  });
});

test("normalizes goals and exposes current plus active status", async () => {
  await withHome(async (home) => {
    const mod = await import(`./goal-runner.ts?case=status-${Date.now()}`);
    const file = mod.getGoalRunnerStorePath();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({
      version: 1,
      sessions: {
        s1: {
          sessionId: "s1",
          objective: "Improve goal runner",
          status: "running",
          phase: "executing",
          createdAt: 1,
          updatedAt: 3,
          iteration: 2,
          consecutiveFailures: 0,
          events: [
            ...Array.from({ length: 43 }, (_, index) => ({ id: `e${index}`, type: "test", message: `event ${index}`, createdAt: index })),
            { id: "restore-old", type: "restore", message: "Pi-web startup restored Goal continuation", createdAt: 100 },
            { id: "restore-new", type: "restore", message: "Pi-web startup restored Goal continuation", createdAt: 200 },
          ],
        },
        s2: {
          sessionId: "s2",
          objective: "Done",
          status: "complete",
          phase: "executing",
          createdAt: 1,
          updatedAt: 2,
          iteration: 1,
          consecutiveFailures: 0,
        },
      },
    }));
    const status = await mod.getGoalRunnerStatus("s1");
    assert.equal(status.current.mode, "finish");
    assert.deepEqual(status.current.subtasks, []);
    assert.equal(status.current.diagnostics.health, "stale");
    assert.match(status.current.diagnostics.healthReason, /not updated recently/);
    assert.equal(status.current.events.length, 8);
    assert.equal(status.current.events[0].id, "restore-new");
    assert.equal(status.current.events.filter((event) => event.type === "restore").length, 1);
    assert.equal(status.current.eventSummary.total, 40);
    assert.equal(status.current.eventSummary.rawTotal, 45);
    assert.equal(status.current.eventSummary.returnedTotal, 8);
    assert.equal(status.current.eventSummary.compacted, true);
    assert.equal(status.current.eventSummary.filtered, false);
    assert.deepEqual(status.current.eventSummary.filterTypes, []);
    assert.equal(status.current.eventSummary.maxEvents, 40);
    assert.equal(status.current.eventSummary.oldestAt, 4);
    assert.equal(status.current.eventSummary.byType.restore, 1);
    assert.equal(status.current.eventSummary.byType.test, 39);
    assert.deepEqual(status.current.eventSummary.topTypes.slice(0, 2).map(({ type, count }) => ({ type, count })), [{ type: "test", count: 39 }, { type: "restore", count: 1 }]);
    assert.equal(status.current.eventSummary.topTypes[0].latestMessage, "event 42");
    assert.equal(status.current.eventSummary.topTypes[1].latestAt, 200);
    assert.equal(status.current.eventSummary.latestType, "restore");
    const restoreOnly = await mod.getGoalRunnerStatus("s1", { eventTypes: ["restore"] });
    assert.equal(restoreOnly.current.events.length, 1);
    assert.equal(restoreOnly.current.events[0].type, "restore");
    assert.equal(restoreOnly.current.eventSummary.total, 40);
    assert.equal(restoreOnly.current.eventSummary.rawTotal, 45);
    assert.equal(restoreOnly.current.eventSummary.returnedTotal, 1);
    assert.equal(restoreOnly.current.eventSummary.compacted, true);
    assert.equal(restoreOnly.current.eventSummary.filtered, true);
    assert.deepEqual(restoreOnly.current.eventSummary.filterTypes, ["restore"]);
    assert.equal(typeof status.current.diagnostics.updatedAgeMs, "number");
    assert.equal(status.active.length, 1);
    assert.equal(status.active[0].diagnostics.health, "stale");
    assert.equal(status.total, 2);
    assert.ok(status.storePath.startsWith(home));

    const liveStatus = await mod.getGoalRunnerStatus("s1", {
      runningSessionIds: ["s1"],
      completionNotificationSuppressedSessionIds: ["s1"],
    });
    assert.equal(liveStatus.current.runtime.liveRunning, true);
    assert.equal(liveStatus.current.runtime.completionNotificationSuppressed, true);
    assert.equal(liveStatus.current.diagnostics.health, "running");
    assert.equal(liveStatus.current.diagnostics.retryOverdueMs, null);
    assert.equal(liveStatus.active[0].runtime.liveRunning, true);
    assert.equal(liveStatus.active[0].diagnostics.health, "running");

    const completedLiveStatus = await mod.getGoalRunnerStatus("s2", {
      runningSessionIds: ["s2"],
      completionNotificationSuppressedSessionIds: ["s2"],
    });
    assert.equal(completedLiveStatus.current.status, "complete");
    assert.equal(completedLiveStatus.current.runtime.liveRunning, false);
    assert.equal(completedLiveStatus.current.runtime.completionNotificationSuppressed, false);
    assert.equal(completedLiveStatus.current.diagnostics.health, "idle");
  });
});

test("recovers from backup when the primary goal store is unreadable", async () => {
  await withHome(async () => {
    const mod = await import(`./goal-runner.ts?case=backup-${Date.now()}`);
    await mod.writeGoalRunnerStore({
      version: 1,
      sessions: {
        s1: {
          sessionId: "s1",
          objective: "recover me",
          status: "running",
          phase: "executing",
          mode: "finish",
          createdAt: 1,
          updatedAt: 2,
          iteration: 3,
          consecutiveFailures: 0,
        },
      },
    });
    let backup = await mod.getGoalRunnerBackupStatus();
    assert.equal(backup.primaryReadable, true);
    assert.equal(backup.readable, true);
    assert.equal(backup.restorable, false);
    backup = await mod.getGoalRunnerBackupStatus(undefined, "s1");
    assert.equal(backup.containsCurrentSession, true);
    assert.equal(backup.currentSessionStatus, "running");
    backup = await mod.getGoalRunnerBackupStatus(undefined, "missing");
    assert.equal(backup.containsCurrentSession, false);
    assert.equal(backup.currentSessionStatus, null);
    await writeFile(mod.getGoalRunnerStorePath(), "{ broken json", "utf8");
    backup = await mod.getGoalRunnerBackupStatus();
    assert.equal(backup.primaryReadable, false);
    assert.equal(backup.readable, true);
    assert.equal(backup.restorable, true);
    const store = await mod.readGoalRunnerStore();
    assert.equal(store.sessions.s1.objective, "recover me");
    assert.equal(store.sessions.s1.events.at(-1).type, "recover");
    const restore = await mod.restoreGoalRunnerStoreFromBackup();
    assert.equal(restore.restored, true);
    assert.equal(restore.reason, "primary store restored from backup");
    assert.equal((await mod.getGoalRunnerBackupStatus()).primaryReadable, true);
  });
});

test("serializes concurrent goal store updates so none are lost", async () => {
  await withHome(async () => {
    const mod = await import(`./goal-runner.ts?case=concurrent-${Date.now()}`);
    await Promise.all(Array.from({ length: 8 }, async (_, index) => {
      await mod.updateGoalRunnerStore(async (store) => {
        await new Promise((resolve) => setTimeout(resolve, 8 - index));
        store.sessions[`s${index}`] = {
          sessionId: `s${index}`,
          objective: `goal ${index}`,
          status: "running",
          phase: "executing",
          createdAt: index,
          updatedAt: index,
          iteration: index,
          consecutiveFailures: 0,
        };
      });
    }));
    const store = await mod.readGoalRunnerStore();
    assert.equal(Object.keys(store.sessions).length, 8);
    for (let index = 0; index < 8; index += 1) {
      assert.equal(store.sessions[`s${index}`].objective, `goal ${index}`);
    }
  });
});

test("keeps Goal Runner API config aligned with documented operational settings", async () => {
  const mod = await import(`./goal-runner.ts?case=config-${Date.now()}`);
  assert.equal(mod.GOAL_RUNNER_VERSION, "1.4.0");
  assert.equal(mod.GOAL_RUNNER_MAX_RETRY_MS, 20 * 60 * 1000);
  assert.equal(mod.GOAL_RUNNER_MAX_EVENTS, 40);
  assert.equal(mod.GOAL_RUNNER_LOCK_TIMEOUT_MS, 10_000);
  assert.equal(mod.GOAL_RUNNER_LOCK_STALE_MS, 60_000);
  assert.equal(mod.GOAL_RUNNER_WATCHDOG_INTERVAL_MS, 30_000);
  await withHome(async () => {
    const status = await mod.getGoalRunnerStatus("s1");
    assert.equal(status.config.version, "1.4.0");
    assert.equal(status.config.storePath, status.storePath);
    assert.equal(status.config.maxRetryMs, 1_200_000);
    assert.equal(status.config.maxEvents, 40);
    assert.equal(status.config.defaultMode, "finish");
    assert.equal(status.config.lockTimeoutMs, 10_000);
    assert.equal(status.config.lockStaleMs, 60_000);
    assert.equal(status.config.watchdogIntervalMs, 30_000);
    assert.match(status.config.lockPath, /goal-runner\.json\.lock$/);
    assert.match(status.config.backupPath, /goal-runner\.json\.bak$/);
    assert.equal(status.lock.exists, false);
    assert.equal(status.lock.stale, false);
    const lockPath = status.lock.path;
    await mkdir(lockPath, { recursive: true });
    await writeFile(path.join(lockPath, "owner.json"), JSON.stringify({ pid: 123, createdAt: 456 }));
    const heldStatus = await mod.getGoalRunnerStatus("s1");
    assert.equal(heldStatus.lock.exists, true);
    assert.equal(heldStatus.lock.stale, false);
    assert.equal(heldStatus.lock.owner.pid, 123);
    const old = new Date(Date.now() - 120_000);
    await utimes(lockPath, old, old);
    const staleStatus = await mod.getGoalRunnerStatus("s1");
    assert.equal(staleStatus.lock.exists, true);
    assert.equal(staleStatus.lock.stale, true);
  });
  const docs = await readFile(new URL("../docs/goal-runner.md", import.meta.url), "utf8");
  assert.match(docs, /version `1\.4\.0`/);
  assert.match(docs, /max retry backoff `20m` \(`1200000` ms\)/);
  assert.match(docs, /default mode `finish`/);
  assert.match(docs, /store lock timeout `10s` \(`10000` ms\)/);
  assert.match(docs, /stale lock recovery `60s` \(`60000` ms\)/);
  assert.match(docs, /watchdog interval `30s` \(`30000` ms\)/);
  assert.match(docs, /event window `40`/);
  assert.match(docs, /config\.storePath/);
  assert.match(docs, /config\.maxEvents/);
  assert.match(docs, /backup path `~\/\.pi\/agent\/goal-runner\.json\.bak`/);
  assert.match(docs, /`current\.runtime`/);
  assert.match(docs, /Pi-web-only live runtime fields/);
  assert.match(docs, /eventTypes=restore,run/);
  assert.match(docs, /eventSummary.*topTypes/);
  assert.match(docs, /rawTotal/);
  assert.match(docs, /returnedTotal/);
  assert.match(docs, /number of `events` returned/);
  assert.match(docs, /compacted/);
  assert.match(docs, /filtered/);
  assert.match(docs, /filterTypes/);
  assert.match(docs, /maxEvents/);
  assert.match(docs, /oldestAt/);
  assert.match(docs, /watchdog\.startedAt/);
  assert.match(docs, /watchdog\.nextScanAt/);
  assert.match(docs, /watchdog\.nextScanOverdueMs/);
  assert.match(docs, /watchdog\.lastScanDurationMs/);
  assert.match(docs, /watchdog\.active/);
  assert.match(docs, /event filter chips/);
  assert.match(docs, /all 13\/8/);
  assert.match(docs, /hover titles explain empty filters/);
  assert.match(docs, /goal events \[type\.\.\.\]/);
  assert.match(docs, /event window\/returned count\/top event types/);
  assert.match(docs, /event summary top types/);
  assert.match(docs, /local SSH reachability preflight/);
  assert.match(docs, /status 70/);
  assert.match(docs, /deployment did not start/);
  assert.match(docs, /PI_WEB_DISABLE_AUTO_RESUME=1/);
  assert.match(docs, /Start with `\/goal doctor`/);
  assert.match(docs, /`\/goal-run` or the Pi-web \*\*Run now\*\* button/);
  assert.match(docs, /contains the current session/);
  assert.match(docs, /`\/goal restore-backup` only restores/);
  assert.match(docs, /watchdog `overdue`/);
  assert.match(docs, /lastScanDurationMs/);
  assert.match(docs, /watchdog\.nextScanOverdueMs/);
});

test("clearStaleGoalRunnerLock only removes stale locks", async () => {
  const mod = await import(`./goal-runner.ts?case=clear-lock-${Date.now()}`);
  await withHome(async (home) => {
    const file = path.join(home, ".pi", "agent", "goal-runner.json");
    const lockPath = `${file}.lock`;
    await mkdir(lockPath, { recursive: true });

    let result = await mod.clearStaleGoalRunnerLock(file);
    assert.equal(result.cleared, false);
    assert.equal(result.reason, "lock is held and not stale");
    assert.equal((await mod.getGoalRunnerLockStatus(file)).exists, true);

    const old = new Date(Date.now() - mod.GOAL_RUNNER_LOCK_STALE_MS - 5_000);
    await utimes(lockPath, old, old);
    result = await mod.clearStaleGoalRunnerLock(file);
    assert.equal(result.cleared, true);
    assert.equal(result.reason, "stale lock cleared");
    assert.equal((await mod.getGoalRunnerLockStatus(file)).exists, false);
  });
});

test("adds a synthetic legacy event for old Goal records without events", async () => {
  await withHome(async () => {
    const mod = await import(`./goal-runner.ts?case=legacy-events-${Date.now()}`);
    const file = mod.getGoalRunnerStorePath();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({
      version: 1,
      sessions: {
        s1: {
          sessionId: "s1",
          objective: "legacy",
          status: "running",
          phase: "executing",
          createdAt: 1,
          updatedAt: 2,
          iteration: 1,
          consecutiveFailures: 0,
        },
      },
    }));
    const status = await mod.getGoalRunnerStatus("s1");
    assert.equal(status.current.events.length, 1);
    assert.equal(status.current.events[0].type, "state");
    assert.match(status.current.events[0].message, /legacy record/);
  });
});

test("computes Goal diagnostics for waiting, retrying, and idle states", async () => {
  const mod = await import(`./goal-runner.ts?case=diagnostics-${Date.now()}`);
  const now = 10_000;
  const base = {
    sessionId: "s1",
    objective: "Improve goal runner",
    status: "running",
    phase: "executing",
    mode: "finish",
    createdAt: 1,
    updatedAt: now - 1_000,
    iteration: 1,
    consecutiveFailures: 0,
    subtasks: [],
  };

  assert.equal(mod.getGoalDiagnostics(base, now).health, "healthy");
  assert.equal(mod.getGoalDiagnostics({ ...base, nextRetryAt: now + 5_000 }, now).health, "waiting");
  const overdue = mod.getGoalDiagnostics({ ...base, nextRetryAt: now - 5_000 }, now);
  assert.equal(overdue.health, "overdue");
  assert.equal(overdue.retryOverdueMs, 5_000);
  assert.equal(mod.getGoalDiagnostics({ ...base, consecutiveFailures: 1, nextRetryAt: now + 5_000 }, now).health, "retrying");
  assert.equal(mod.getGoalDiagnostics({ ...base, consecutiveFailures: 1, nextRetryAt: now - 5_000 }, now).health, "overdue");
  assert.equal(mod.getGoalDiagnostics({ ...base, consecutiveFailures: 1 }, now).health, "failed");
  assert.equal(mod.getGoalDiagnostics({ ...base, status: "paused" }, now).health, "idle");
  assert.equal(mod.getGoalDiagnostics({ ...base, status: "paused", nextRetryAt: now - 5_000 }, now).health, "idle");
  assert.equal(mod.getGoalDiagnostics({ ...base, status: "paused", nextRetryAt: now - 5_000 }, now).retryOverdueMs, null);
  assert.equal(mod.getGoalDiagnostics({ ...base, status: "complete", nextRetryAt: now - 5_000 }, now).health, "idle");
  assert.equal(mod.getGoalDiagnostics({ ...base, status: "complete", nextRetryAt: now - 5_000 }, now).retryOverdueMs, null);
  assert.equal(mod.getGoalDiagnostics({ ...base, status: "stopped", nextRetryAt: now - 5_000 }, now).health, "idle");
  assert.equal(mod.getGoalDiagnostics({ ...base, status: "stopped", nextRetryAt: now - 5_000 }, now).retryOverdueMs, null);
  assert.equal(mod.getGoalDiagnostics({ ...base, status: "draft", phase: "clarifying" }, now).health, "waiting");
  assert.equal(mod.getGoalDiagnostics({ ...base, updatedAt: now - 31 * 60 * 1000 }, now).health, "stale");
});

test("applies goal actions and builds restart continuation prompts", async () => {
  const mod = await import(`./goal-runner.ts?case=actions-${Date.now()}`);
  const goal = {
    sessionId: "s1",
    objective: "继续完善goal插件",
    status: "running",
    phase: "executing",
    mode: "finish",
    createdAt: 1,
    updatedAt: 2,
    iteration: 4,
    consecutiveFailures: 0,
    subtasks: [{ id: "t1", text: "Add UI", status: "pending", createdAt: 1, updatedAt: 1 }],
  };

  const started = mod.applyGoalRunnerAction(goal, "start", undefined, "全新目标描述");
  assert.equal(started.status, "draft");
  assert.equal(started.objective, "全新目标描述");
  assert.equal(started.events.at(-1).type, "start");

  const paused = mod.applyGoalRunnerAction(goal, "pause");
  assert.equal(paused.status, "paused");
  assert.equal(paused.events.at(-1).type, "pause");
  const pausedAgain = mod.applyGoalRunnerAction(paused, "pause");
  assert.equal(pausedAgain.events.length, paused.events.length);
  assert.equal(pausedAgain.events.at(-1).type, "pause");
  assert.equal(mod.applyGoalRunnerAction(goal, "resume").status, "running");
  const runNow = mod.applyGoalRunnerAction({ ...goal, nextRetryAt: Date.now() + 100_000 }, "run-now");
  assert.equal(runNow.status, "running");
  assert.equal(runNow.nextRetryAt, undefined);
  assert.equal(runNow.events.at(-1).type, "run");
  assert.equal(mod.applyGoalRunnerAction(goal, "mode", "forever").mode, "forever");
  assert.equal(mod.applyGoalRunnerAction(goal, "mode", "invalid"), null);
  const withSubtask = mod.applyGoalRunnerAction(goal, "add", undefined, "Add action API");
  assert.equal(withSubtask.subtasks.length, 2);
  assert.equal(withSubtask.subtasks[1].text, "Add action API");
  assert.equal(withSubtask.subtasks[1].status, "pending");
  assert.equal(withSubtask.events.at(-1).type, "add");
  assert.equal(mod.applyGoalRunnerAction(goal, "add", undefined, "   "), null);
  const doneSubtask = mod.applyGoalRunnerAction(goal, "subtask", "done", undefined, "t1");
  assert.equal(doneSubtask.subtasks[0].status, "done");
  assert.equal(doneSubtask.events.at(-1).type, "subtask");
  const reopenedSubtask = mod.applyGoalRunnerAction(doneSubtask, "subtask", "pending", undefined, "t1");
  assert.equal(reopenedSubtask.subtasks[0].status, "pending");
  assert.equal(mod.applyGoalRunnerAction(goal, "subtask", "done", undefined, "missing"), null);
  const prompt = mod.goalContinuationPromptFromRecord(goal);
  assert.match(prompt, /继续完善goal插件/);
  assert.match(prompt, /Add UI/);
  assert.match(prompt, /Iteration: 5/);
});
