import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server.js";
import { createJiti } from "jiti";

const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-workspace-del-")));
const agentDir = path.join(tmpRoot, "agent");
const sessionsDir = path.join(agentDir, "sessions");
process.env.PI_CODING_AGENT_DIR = agentDir;

test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { DELETE } = await jiti.import("./route.ts");

test("deletes only pi-web session files and leaves workspace files untouched", async () => {
  // 1. Create a dummy workspace folder with user files
  const workspaceDir = path.join(tmpRoot, "my-project");
  fs.mkdirSync(workspaceDir, { recursive: true });
  const importantUserFile = path.join(workspaceDir, "important.txt");
  fs.writeFileSync(importantUserFile, "IMPORTANT USER CODE");

  // 2. Create dummy session files in agent/sessions
  const encodedDir = path.join(sessionsDir, "--test-workspace--");
  fs.mkdirSync(encodedDir, { recursive: true });
  const sessionFile = path.join(encodedDir, "session_1.jsonl");
  const header = {
    type: "session",
    id: "session-1",
    cwd: workspaceDir,
    timestamp: new Date().toISOString(),
  };
  fs.writeFileSync(sessionFile, JSON.stringify(header) + "\n");

  assert.ok(fs.existsSync(importantUserFile));
  assert.ok(fs.existsSync(sessionFile));

  // 3. Call DELETE /api/sessions/workspace
  const req = new NextRequest("http://localhost/api/sessions/workspace", {
    method: "DELETE",
    headers: { "Content-Type": "application/json", host: "localhost" },
    body: JSON.stringify({ root: workspaceDir }),
  });

  const res = await DELETE(req);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.success, true);
  assert.equal(data.count, 1);

  // 4. Verify: user file is STILL THERE, untouched!
  assert.ok(fs.existsSync(importantUserFile), "User project file must not be deleted");
  assert.equal(fs.readFileSync(importantUserFile, "utf8"), "IMPORTANT USER CODE");

  // 5. Verify: session file was removed
  assert.ok(!fs.existsSync(sessionFile), "Session file should be deleted");
});
