import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

async function withHome(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-goal-runner-extension-"));
  const oldHome = process.env.HOME;
  process.env.HOME = dir;
  try {
    await fn(dir);
  } finally {
    process.env.HOME = oldHome;
    await rm(dir, { recursive: true, force: true });
  }
}

async function loadExtension() {
  const mod = await import(`../extensions/pi-goal-runner/index.ts?case=${Date.now()}-${Math.random()}`);
  const commands = new Map();
  const listeners = new Map();
  const tools = new Map();
  const sent = [];
  const pi = {
    registerCommand(name, spec) {
      commands.set(name, spec);
    },
    registerTool(spec) {
      tools.set(spec.name, spec);
    },
    on(event, handler) {
      const handlers = listeners.get(event) || [];
      handlers.push(handler);
      listeners.set(event, handlers);
    },
    sendUserMessage(message, options) {
      sent.push({ message, options });
    },
  };
  mod.default(pi);
  return { commands, listeners, tools, sent };
}

function context(sessionId = "s1") {
  const notifications = [];
  return {
    notifications,
    ctx: {
      sessionManager: { getSessionId: () => sessionId },
      ui: { notify: (message, level) => notifications.push({ message, level }) },
    },
  };
}

async function readGoalStore(home) {
  return JSON.parse(await readFile(path.join(home, ".pi", "agent", "goal-runner.json"), "utf8"));
}

test("Goal Runner extension registers the complete short and compatibility command set", async () => {
  await withHome(async () => {
    const { commands } = await loadExtension();
    const expected = [
      "goal",
      "goal-start",
      "goal-add",
      "goal-status",
      "goal-run",
      "goal-resume",
      "goal-pause",
      "goal-stop",
      "goal-done",
      "goal-complete",
      "goal-mode",
    ];
    assert.equal(expected.length, 11);
    assert.deepEqual([...commands.keys()].sort(), expected.sort());
    const docs = await readFile(path.join(process.cwd(), "docs", "goal-runner.md"), "utf8");
    const undocumented = expected.filter((cmd) => !docs.includes(`\`${cmd}\``) && !docs.includes(`/${cmd}`));
    assert.match(docs, /Goal commands/);
    assert.deepEqual(undocumented, []);
    assert.equal(typeof commands.get("goal").getArgumentCompletions, "function");
    assert.match(commands.get("goal-status").description, /retry timing, events, and backup coverage/);
    assert.equal(typeof commands.get("goal").getArgumentCompletions, "function");
    assert.deepEqual(commands.get("goal").getArgumentCompletions("r").map((item) => item.value), ["run", "resume", "restore-backup"]);
  });
});

test("/goal <objective> starts clarification instead of being ignored", async () => {
  await withHome(async (home) => {
    const { commands, sent } = await loadExtension();
    const { ctx, notifications } = context("s1");

    await commands.get("goal").handler("继续完善goal插件", ctx);

    const store = await readGoalStore(home);
    const goal = store.sessions.s1;
    assert.equal(goal.objective, "继续完善goal插件");
    assert.equal(goal.status, "draft");
    assert.equal(goal.phase, "clarifying");
    assert.equal(goal.mode, "finish");
    assert.equal(goal.iteration, 0);
    assert.deepEqual(goal.subtasks, []);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].options.deliverAs, "followUp");
    assert.match(sent[0].message, /Before execution/);
    assert.match(sent[0].message, /6-10 numbered questions/);
    assert.deepEqual(notifications.at(-1), { message: "Goal Runner: clarification started", level: "info" });
  });
});

test("/goal <objective> appends a subgoal when a goal already exists", async () => {
  await withHome(async (home) => {
    const { commands, sent } = await loadExtension();
    const { ctx } = context("s1");

    await commands.get("goal").handler("继续完善goal插件", ctx);
    await commands.get("goal").handler("增加状态面板", ctx);

    const store = await readGoalStore(home);
    const goal = store.sessions.s1;
    assert.equal(goal.objective, "继续完善goal插件");
    assert.equal(goal.subtasks.length, 1);
    assert.equal(goal.subtasks[0].text, "增加状态面板");
    assert.equal(goal.status, "draft");
    assert.equal(sent.length, 2);
  });
});

test("config command reports operational settings", async () => {
  await withHome(async () => {
    const { commands } = await loadExtension();
    const { ctx, notifications } = context("s1");

    await commands.get("goal").handler("help", ctx);
    assert.match(notifications.at(-1).message, /goal-status/);
    assert.match(notifications.at(-1).message, /goal-run/);
    assert.match(notifications.at(-1).message, /goal-stop/);
    await commands.get("goal").handler("config", ctx);
    assert.match(notifications.at(-1).message, /Goal Runner v1\.4\.0/);
    assert.match(notifications.at(-1).message, /max retry backoff: 20m/);
    assert.match(notifications.at(-1).message, /event window: 40/);
    assert.match(notifications.at(-1).message, /backup: .*goal-runner\.json\.bak/);
    assert.match(notifications.at(-1).message, /lock: .*goal-runner\.json\.lock, timeout 10s, stale 60s/);
    assert.match(notifications.at(-1).message, /goal-runner\.json/);
    await commands.get("goal").handler("lock", ctx);
    assert.match(notifications.at(-1).message, /Goal Runner lock: free/);
    assert.match(notifications.at(-1).message, /goal-runner\.json\.lock/);
    await commands.get("goal").handler("unlock", ctx);
    assert.match(notifications.at(-1).message, /already free/);
    await commands.get("goal").handler("backup", ctx);
    assert.match(notifications.at(-1).message, /Goal Runner backup:/);
    assert.match(notifications.at(-1).message, /current session: unknown/);
    await commands.get("goal").handler("doctor", ctx);
    assert.match(notifications.at(-1).message, /Goal Runner doctor v1\.4\.0/);
    assert.match(notifications.at(-1).message, /goal: none in this session/);
    assert.match(notifications.at(-1).message, /current unknown/);
    assert.match(notifications.at(-1).message, /event summary: window 0\/40; returned 0; top none/);
    assert.match(notifications.at(-1).message, /restorable: no/);
    await commands.get("goal").handler("restore-backup", ctx);
    assert.match(notifications.at(-1).message, /primary store is readable|backup is not readable/);
  });
});

test("subtask commands list and update subtasks by number", async () => {
  await withHome(async (home) => {
    const { commands } = await loadExtension();
    const { ctx, notifications } = context("s1");

    await commands.get("goal").handler("继续完善goal插件", ctx);
    await commands.get("goal-add").handler("增加状态面板", ctx);
    await commands.get("goal").handler("subtasks", ctx);
    assert.match(notifications.at(-1).message, /1\..*\[pending\] 增加状态面板/);

    await commands.get("goal").handler("subtask done 1", ctx);
    let goal = (await readGoalStore(home)).sessions.s1;
    assert.equal(goal.subtasks[0].status, "done");

    await commands.get("goal").handler("subtask open 1", ctx);
    goal = (await readGoalStore(home)).sessions.s1;
    assert.equal(goal.subtasks[0].status, "pending");

    await commands.get("goal").handler("subtask block 1", ctx);
    goal = (await readGoalStore(home)).sessions.s1;
    assert.equal(goal.subtasks[0].status, "blocked");

    await commands.get("goal-status").handler("", ctx);
    assert.match(notifications.at(-1).message, /subtasks 1\/1; retry now/);
    assert.match(notifications.at(-1).message, /events: window 5\/40; returned 5; top subtask 3 · add 1 · start 1/);
    assert.match(notifications.at(-1).message, /backup current yes \(draft\)/);

    await commands.get("goal").handler("doctor", ctx);
    assert.match(notifications.at(-1).message, /current yes \(draft\)/);
    assert.match(notifications.at(-1).message, /event summary: window 5\/40; returned 5; top subtask 3 · add 1 · start 1/);

    await commands.get("goal").handler("events", ctx);
    assert.match(notifications.at(-1).message, /Goal events \(window 5\/40; returned 5; filter all\):/);
    assert.match(notifications.at(-1).message, /subtask/);

    await commands.get("goal").handler("events subtask", ctx);
    assert.match(notifications.at(-1).message, /Goal events \(window 5\/40; returned 3; filter subtask\):/);
    assert.match(notifications.at(-1).message, /subtask/);
    assert.doesNotMatch(notifications.at(-1).message, /start:/);

    await commands.get("goal").handler("events restore,run", ctx);
    assert.match(notifications.at(-1).message, /Goal events \(window 5\/40; returned 0; filter restore, run\): none/);
  });
});

test("clarification answers transition a draft goal into running execution", async () => {
  await withHome(async (home) => {
    const { commands, listeners, sent } = await loadExtension();
    const { ctx } = context("s1");

    await commands.get("goal").handler("继续完善goal插件", ctx);
    const inputHandlers = listeners.get("input") || [];
    assert.equal(inputHandlers.length, 1);

    const result = await inputHandlers[0]({ text: "默认即可，优先 UI 和自动续跑。" }, ctx);

    const store = await readGoalStore(home);
    const goal = store.sessions.s1;
    assert.equal(goal.status, "running");
    assert.equal(goal.phase, "executing");
    assert.equal(sent.length, 1);
    assert.equal(result.action, "transform");
    assert.match(result.text, /Begin execution now/);
    assert.match(result.text, /默认即可/);
  });
});

test("run and resume commands record distinct events", async () => {
  await withHome(async (home) => {
    const { commands, listeners, sent } = await loadExtension();
    const { ctx } = context("s1");

    await commands.get("goal").handler("继续完善goal插件", ctx);
    const [inputHandler] = listeners.get("input") || [];
    await inputHandler({ text: "默认即可。" }, ctx);

    await commands.get("goal-run").handler("", ctx);
    let goal = (await readGoalStore(home)).sessions.s1;
    assert.equal(goal.events.at(-1).type, "run");
    assert.match(goal.events.at(-1).message, /run requested now/);

    await commands.get("goal-resume").handler("", ctx);
    goal = (await readGoalStore(home)).sessions.s1;
    assert.equal(goal.events.at(-1).type, "resume");
    assert.match(goal.events.at(-1).message, /resumed/);
    assert.equal(sent.length, 3);
  });
});

test("settled runs advance iteration and retry with bounded exponential backoff", async () => {
  await withHome(async (home) => {
    const { commands, listeners } = await loadExtension();
    const { ctx } = context("s1");

    await commands.get("goal-resume").handler("", ctx);
    // No goal yet; create and transition it into running.
    await commands.get("goal").handler("继续完善goal插件", ctx);
    const [inputHandler] = listeners.get("input") || [];
    await inputHandler({ text: "默认即可。" }, ctx);

    const [settledHandler] = listeners.get("agent_settled") || [];
    assert.equal(typeof settledHandler, "function");

    await settledHandler({ outcome: "completed" }, ctx);
    let goal = (await readGoalStore(home)).sessions.s1;
    assert.equal(goal.iteration, 1);
    assert.equal(goal.consecutiveFailures, 0);
    assert.equal(goal.lastOutcome, "completed");
    assert.ok(goal.nextRetryAt >= Date.now());
    assert.ok(goal.nextRetryAt <= Date.now() + 2_500);

    await settledHandler({ outcome: "error" }, ctx);
    goal = (await readGoalStore(home)).sessions.s1;
    assert.equal(goal.iteration, 2);
    assert.equal(goal.consecutiveFailures, 1);
    assert.equal(goal.lastOutcome, "error");
    assert.match(goal.lastError, /agent settled with outcome error/);
    assert.ok(goal.nextRetryAt >= Date.now() + 900);
    assert.ok(goal.nextRetryAt <= Date.now() + 2_500);
  });
});

test("registers goal_complete tool and marks running goal complete when called", async () => {
  await withHome(async (home) => {
    const { commands, listeners, tools } = await loadExtension();
    const { ctx, notifications } = context("s1");

    assert.ok(tools.has("goal_complete"));
    const tool = tools.get("goal_complete");
    assert.equal(tool.name, "goal_complete");
    assert.match(tool.description, /Mark the current Goal complete/);

    // Setup running goal
    await commands.get("goal").handler("测试AI调用完成", ctx);
    const [inputHandler] = listeners.get("input") || [];
    await inputHandler({ text: "确认开始执行" }, ctx);

    let store = await readGoalStore(home);
    assert.equal(store.sessions.s1.status, "running");

    // Execute tool
    const res = await tool.execute("call-1", { summary: "所有目标已全部达成并验证通过" }, null, null, ctx);
    assert.match(res.content[0].text, /Goal marked complete successfully/);

    store = await readGoalStore(home);
    assert.equal(store.sessions.s1.status, "complete");
    assert.equal(store.sessions.s1.events.at(-1).type, "complete");
    assert.match(store.sessions.s1.events.at(-1).message, /Goal marked complete by AI: 所有目标已全部达成并验证通过/);
    assert.deepEqual(notifications.at(-1), { message: "Goal Runner: goal marked complete by AI", level: "info" });
  });
});

test("/goal <objective> preserves attached prompt images in the subsequent sent message", async () => {
  await withHome(async () => {
    const { commands, sent } = await loadExtension();
    const { ctx } = context("s1");

    const sampleImage = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
    globalThis.__piWebPendingPromptImages = new Map([["s1", [sampleImage]]]);

    await commands.get("goal").handler("修复图标显示问题", ctx);

    assert.equal(sent.length, 1);
    assert.ok(Array.isArray(sent[0].message));
    assert.equal(sent[0].message.length, 2);
    assert.equal(sent[0].message[0].type, "text");
    assert.match(sent[0].message[0].text, /修复图标显示问题/);
    assert.deepEqual(sent[0].message[1], sampleImage);
    assert.equal(globalThis.__piWebPendingPromptImages.has("s1"), false);
  });
});


