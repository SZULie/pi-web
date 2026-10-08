import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

async function withIsolatedHome(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-web-goal-action-route-"));
  const oldHome = process.env.HOME;
  process.env.HOME = dir;
  t.after(async () => {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

function postGoalAction(POST, body) {
  return POST(new Request("http://localhost/api/goals/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
}

test("run-now skips a live-running Goal without mutating persisted state", async (t) => {
  const home = await withIsolatedHome(t);
  const sessionId = "live-goal-session";
  const storePath = path.join(home, ".pi", "agent", "goal-runner.json");
  await mkdir(path.dirname(storePath), { recursive: true });
  const originalGoal = {
    sessionId,
    objective: "Keep improving Goal Runner",
    status: "running",
    phase: "executing",
    mode: "finish",
    createdAt: 1,
    updatedAt: 2,
    iteration: 3,
    consecutiveFailures: 0,
    nextRetryAt: Date.now() + 120_000,
    subtasks: [],
    events: [{ id: "restore", type: "restore", message: "already running", createdAt: 2 }],
  };
  await writeFile(storePath, JSON.stringify({ version: 1, sessions: { [sessionId]: originalGoal } }, null, 2));

  const previousRegistry = globalThis.__piSessions;
  let sendCalls = 0;
  globalThis.__piSessions = new Map([[sessionId, {
    isRunning: () => true,
    isAlive: () => true,
    sessionFile: "/tmp/live-goal-session.jsonl",
    send: async () => { sendCalls += 1; },
  }]]);
  t.after(() => {
    globalThis.__piSessions = previousRegistry;
  });

  const jiti = createJiti(import.meta.url, {
    alias: { "@": process.cwd() },
    interopDefault: true,
    moduleCache: false,
  });
  const { POST } = await jiti.import("./route.ts");

  const response = await postGoalAction(POST, { sessionId, action: "run-now" });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.dispatched, false);
  assert.equal(body.skippedBecauseRunning, true);
  assert.equal(sendCalls, 0);

  const persisted = JSON.parse(await readFile(storePath, "utf8"));
  assert.deepEqual(persisted.sessions[sessionId].events, originalGoal.events);
  assert.equal(persisted.sessions[sessionId].nextRetryAt, originalGoal.nextRetryAt);
});

test("run-now dispatches one continuation for an idle live Goal session", async (t) => {
  const home = await withIsolatedHome(t);
  const sessionId = "idle-goal-session";
  const storePath = path.join(home, ".pi", "agent", "goal-runner.json");
  await mkdir(path.dirname(storePath), { recursive: true });
  await writeFile(storePath, JSON.stringify({
    version: 1,
    sessions: {
      [sessionId]: {
        sessionId,
        objective: "Keep improving Goal Runner",
        status: "running",
        phase: "executing",
        mode: "finish",
        createdAt: 1,
        updatedAt: 2,
        iteration: 3,
        consecutiveFailures: 0,
        nextRetryAt: Date.now() + 120_000,
        subtasks: [],
        events: [],
      },
    },
  }, null, 2));

  const previousRegistry = globalThis.__piSessions;
  const sent = [];
  globalThis.__piSessions = new Map([[sessionId, {
    isRunning: () => false,
    isAlive: () => true,
    sessionFile: "/tmp/idle-goal-session.jsonl",
    send: async (message) => { sent.push(message); },
  }]]);
  t.after(() => {
    globalThis.__piSessions = previousRegistry;
  });

  const jiti = createJiti(import.meta.url, {
    alias: { "@": process.cwd() },
    interopDefault: true,
    moduleCache: false,
  });
  const { POST } = await jiti.import("./route.ts");

  const response = await postGoalAction(POST, { sessionId, action: "run-now" });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.dispatched, true);
  assert.equal(body.skippedBecauseRunning, false);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "prompt");
  assert.match(sent[0].message, /Continue the active long-running Goal/);

  const persisted = JSON.parse(await readFile(storePath, "utf8"));
  assert.equal(persisted.sessions[sessionId].nextRetryAt, undefined);
  assert.equal(persisted.sessions[sessionId].events.at(-1).type, "run");
});
