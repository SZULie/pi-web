import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const {
  getToolOverrides,
  setToolOverride,
  saveAllToolOverrides,
  applyToolOverridesToSession,
} = await jiti.import("./tool-overrides.ts");

test("tool overrides can be retrieved, set, and cleared", async () => {
  const initial = await getToolOverrides();
  assert.ok(typeof initial === "object" && initial !== null);

  const testTool = `test-tool-${Date.now()}`;
  const override = {
    description: "Custom test description",
    required: ["arg1", "arg2"],
    promptGuidelines: ["Always provide arg2."],
    properties: {
      arg2: { description: "Argument 2 description", defaultValue: 42 },
    },
  };

  const afterSet = await setToolOverride(testTool, override);
  assert.deepEqual(afterSet[testTool], override);

  const afterDelete = await setToolOverride(testTool, null);
  assert.equal(afterDelete[testTool], undefined);
});

test("applyToolOverridesToSession mutates session schema and wraps execute", async () => {
  let executedWith = null;
  const mockTool = {
    name: "mockBash",
    description: "Original description",
    parameters: {
      type: "object",
      required: ["command"],
      properties: {
        command: { type: "string", description: "Command to run" },
        timeout: { type: "number", description: "Timeout optional" },
      },
    },
    execute: async (_id, params) => {
      executedWith = params;
      return { content: [{ type: "text", text: "ok" }] };
    },
  };

  const mockSession = {
    _toolDefinitions: new Map([
      [
        "mockBash",
        {
          definition: {
            ...mockTool,
            promptGuidelines: ["Old guideline"],
          },
          sourceInfo: {},
        },
      ],
    ]),
    _toolRegistry: new Map([["mockBash", { ...mockTool }]]),
    _toolPromptGuidelines: new Map([["mockBash", ["Old guideline"]]]),
    getActiveToolNames: () => ["mockBash"],
    _applyToolLoadout: () => {},
  };

  // 1. Apply overrides
  applyToolOverridesToSession(mockSession, {
    mockBash: {
      description: "Overridden description",
      required: ["command", "timeout"],
      promptGuidelines: ["New guideline: timeout required"],
      properties: {
        timeout: { description: "Timeout REQUIRED in seconds" },
      },
    },
  });

  const regTool = mockSession._toolRegistry.get("mockBash");
  assert.equal(regTool.description, "Overridden description");
  assert.deepEqual(regTool.parameters.required, ["command", "timeout"]);
  assert.equal(regTool.parameters.properties.timeout.description, "Timeout REQUIRED in seconds");
  assert.deepEqual(mockSession._toolPromptGuidelines.get("mockBash"), ["New guideline: timeout required"]);

  // Calling without timeout should fail
  await assert.rejects(
    async () => {
      await regTool.execute("call-1", { command: "ls" });
    },
    { message: /Missing required parameter 'timeout'/ },
  );

  // Calling with timeout succeeds
  const res = await regTool.execute("call-2", { command: "ls", timeout: 30 });
  assert.deepEqual(res, { content: [{ type: "text", text: "ok" }] });
  assert.deepEqual(executedWith, { command: "ls", timeout: 30 });

  // 2. Reverting override restores original state
  applyToolOverridesToSession(mockSession, {});
  const restoredTool = mockSession._toolRegistry.get("mockBash");
  assert.equal(restoredTool.description, "Original description");
  assert.deepEqual(restoredTool.parameters.required, ["command"]);
  assert.deepEqual(mockSession._toolPromptGuidelines.get("mockBash"), ["Old guideline"]);

  // Calling without timeout should now succeed again
  await restoredTool.execute("call-3", { command: "pwd" });
  assert.deepEqual(executedWith, { command: "pwd" });
});
