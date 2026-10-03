import assert from "node:assert/strict";
import test from "node:test";
import { formatSessionResumeCommand, shellQuote } from "./clipboard.ts";

test("shellQuote formats arguments correctly", () => {
  assert.equal(shellQuote("normal"), "normal");
  assert.equal(shellQuote("/path/to/project"), "/path/to/project");
  assert.equal(shellQuote("path with spaces"), "'path with spaces'");
  assert.equal(shellQuote("tom's project"), "'tom'\\''s project'");
});

test("formatSessionResumeCommand formats full CLI resume command", () => {
  assert.equal(
    formatSessionResumeCommand({ id: "abc-123", cwd: "/home/user/pi" }),
    "cd /home/user/pi && pi --session abc-123",
  );
  assert.equal(
    formatSessionResumeCommand({ id: "abc-123", cwd: "/path with spaces" }),
    "cd '/path with spaces' && pi --session abc-123",
  );
  assert.equal(
    formatSessionResumeCommand({ id: "abc-123", cwd: "" }),
    "pi --session abc-123",
  );
});
