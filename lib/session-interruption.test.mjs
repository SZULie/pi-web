import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const j = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { inspectSessionInterruption } = await j.import("./session-interruption.ts");

test("identifies unanswered user messages as resumable with empty prompt", () => {
  const entries = [
    {
      type: "message",
      id: "msg-1",
      parentId: null,
      message: { role: "user", content: [{ type: "text", text: "Please help me with this bug" }] },
    },
  ];

  const result = inspectSessionInterruption(entries, "msg-1", "session-1", {});
  assert.equal(result.canResume, true);
  assert.equal(result.turnType, "unanswered_user");
  assert.equal(result.suggestedPrompt, "");
  assert.equal(result.lastMessagePreview, "Please help me with this bug");
});

test("identifies aborted assistant message as resumable with continue prompt", () => {
  const entries = [
    {
      type: "message",
      id: "msg-1",
      parentId: null,
      message: { role: "user", content: [{ type: "text", text: "Write an essay" }] },
    },
    {
      type: "message",
      id: "msg-2",
      parentId: "msg-1",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Once upon a time in a faraway galaxy..." }],
        stopReason: "aborted",
      },
    },
  ];

  const result = inspectSessionInterruption(entries, "msg-2", "session-1", {});
  assert.equal(result.canResume, true);
  assert.equal(result.turnType, "aborted_assistant");
  assert.equal(result.suggestedPrompt, "继续");
});

test("identifies toolResult without following assistant response as resumable with continue prompt", () => {
  const entries = [
    {
      type: "message",
      id: "msg-1",
      parentId: null,
      message: { role: "user", content: [{ type: "text", text: "Run ls" }] },
    },
    {
      type: "message",
      id: "msg-2",
      parentId: "msg-1",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "tc-1", name: "bash", arguments: { command: "ls" } }],
        stopReason: "toolUse",
      },
    },
    {
      type: "message",
      id: "msg-3",
      parentId: "msg-2",
      message: {
        role: "toolResult",
        toolCallId: "tc-1",
        toolName: "bash",
        content: [{ type: "text", text: "file1.txt file2.txt" }],
      },
    },
  ];

  const result = inspectSessionInterruption(entries, "msg-3", "session-1", {});
  assert.equal(result.canResume, true);
  assert.equal(result.turnType, "unhandled_tool_result");
  assert.equal(result.suggestedPrompt, "继续");
});

test("marks completed assistant turns as not needing resume", () => {
  const entries = [
    {
      type: "message",
      id: "msg-1",
      parentId: null,
      message: { role: "user", content: [{ type: "text", text: "Hello" }] },
    },
    {
      type: "message",
      id: "msg-2",
      parentId: "msg-1",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello! How can I help you today?" }],
        stopReason: "stop",
      },
    },
  ];

  const result = inspectSessionInterruption(entries, "msg-2", "session-1", {});
  assert.equal(result.canResume, false);
});

test("marks session as wasInterruptedByRestart when present in interrupted map", () => {
  const entries = [
    {
      type: "message",
      id: "msg-1",
      parentId: null,
      message: { role: "user", content: [{ type: "text", text: "Hello" }] },
    },
  ];

  const map = {
    "session-restart-1": {
      sessionId: "session-restart-1",
      interruptedAt: Date.now(),
      reason: "service_restart",
    },
  };

  const result = inspectSessionInterruption(entries, "msg-1", "session-restart-1", map);
  assert.equal(result.canResume, true);
  assert.equal(result.wasInterruptedByRestart, true);
});
