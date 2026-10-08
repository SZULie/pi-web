import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const {
  getAllSessionContextLimits,
  getSessionContextLimit,
  setSessionContextLimit,
  parseTokenAmount,
  applySessionContextLimitToSession,
} = await jiti.import("./session-context-limits.ts");

test("parseTokenAmount parses numbers and formatted string tokens", () => {
  assert.equal(parseTokenAmount(100000), 100000);
  assert.equal(parseTokenAmount("200000"), 200000);
  assert.equal(parseTokenAmount("64k"), 64000);
  assert.equal(parseTokenAmount("128k"), 128000);
  assert.equal(parseTokenAmount("270k"), 270000);
  assert.equal(parseTokenAmount("272K"), 272000);
  assert.equal(parseTokenAmount("1m"), 1000000);
  assert.equal(parseTokenAmount("1.5M"), 1500000);
  assert.equal(parseTokenAmount("0"), null);
  assert.equal(parseTokenAmount("-100"), null);
  assert.equal(parseTokenAmount("invalid"), null);
  assert.equal(parseTokenAmount(""), null);
});

test("session context limits can be set, retrieved, and cleared", async () => {
  const testId = `test-sess-${Date.now()}`;
  assert.equal(await getSessionContextLimit(testId), null);

  const updated = await setSessionContextLimit(testId, { contextLimit: 200000, thresholdPercent: 65 });
  assert.equal(updated[testId]?.contextLimit, 200000);

  const retrieved = await getSessionContextLimit(testId);
  assert.equal(retrieved?.contextLimit, 200000);
  assert.equal(retrieved?.thresholdPercent, 65);

  // Clear
  const cleared = await setSessionContextLimit(testId, null);
  assert.equal(cleared[testId], undefined);
  assert.equal(await getSessionContextLimit(testId), null);
});

test("applySessionContextLimitToSession overrides getContextUsage and _limitsModel", () => {
  const mockSession = {
    getContextUsage: () => ({ tokens: 50000, contextWindow: 1000000, percent: 5 }),
    _limitsModel: () => ({ provider: "test", id: "m", contextWindow: 1000000 }),
  };

  applySessionContextLimitToSession(mockSession, 200000);

  const usage = mockSession.getContextUsage();
  assert.equal(usage.tokens, 50000);
  assert.equal(usage.contextWindow, 200000);
  assert.equal(usage.percent, 25);

  const limits = mockSession._limitsModel();
  assert.equal(limits.contextWindow, 200000);

  // Reset
  applySessionContextLimitToSession(mockSession, null);
  const resetUsage = mockSession.getContextUsage();
  assert.equal(resetUsage.contextWindow, 1000000);
  assert.equal(resetUsage.percent, 5);
  assert.equal(mockSession._limitsModel().contextWindow, 1000000);
});
