import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const goalPanelSource = await readFile(new URL("./GoalRunnerPanel.tsx", import.meta.url), "utf8");
const appShellSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const agentPanelSource = await readFile(new URL("./AgentSessionPanel.tsx", import.meta.url), "utf8");

test("GoalRunnerPanel is an independent top-level panel with complete Goal Runner controls", () => {
  assert.match(goalPanelSource, /export function GoalRunnerPanel/);
  assert.match(goalPanelSource, /onGoalStatusChange\?:\s*\(status:\s*GoalRunnerStatusData\s*\|\s*null\)\s*=>\s*void/);
  assert.match(goalPanelSource, /fetch\(goalStatusUrl\(rootSession\.id/);
  assert.match(goalPanelSource, /triggerGoalAction\("pause"\)/);
  assert.match(goalPanelSource, /triggerGoalAction\("resume"\)/);
  assert.match(goalPanelSource, /triggerGoalAction\("run-now"\)/);
  assert.match(goalPanelSource, /triggerGoalAction\("stop"\)/);
  assert.match(goalPanelSource, /triggerGoalAction\("complete"\)/);
  assert.match(goalPanelSource, /setGoalEventFilter/);
  assert.match(goalPanelSource, /Add subgoal/);
});

test("AppShell includes dedicated Goal top-panel button with running indicator next to tools", () => {
  assert.match(appShellSource, /import \{ GoalRunnerPanel \} from "\.\/GoalRunnerPanel"/);
  assert.match(appShellSource, /toggleTopPanel\("goal", mobile\)/);
  assert.match(appShellSource, /translate\("goalRunner\.title"\)/);
  assert.match(appShellSource, /translate\("goalRunner\.label"\)/);
  assert.match(appShellSource, /isGoalRunning && \(/);
  assert.match(appShellSource, /background:\s*"#16a34a"/);
  assert.match(appShellSource, /activeTopPanel === "goal" && selectedSession/);
  assert.match(appShellSource, /<GoalRunnerPanel/);
});

test("AgentSessionPanel no longer contains Goal Runner card while preserving Magic Context", () => {
  assert.doesNotMatch(agentPanelSource, /\{ \/\* Goal Runner card \*\/ \}/);
  assert.doesNotMatch(agentPanelSource, /triggerGoalAction/);
  assert.doesNotMatch(agentPanelSource, /goalStatusUrl/);
  assert.match(agentPanelSource, /t\("agentSwitcher\.systemAgents"\)/);
  assert.match(agentPanelSource, /t\("agentSwitcher\.historian"\)/);
});
