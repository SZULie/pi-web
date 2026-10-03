import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import {
  getAgentDir,
  invalidateSessionListCache,
  invalidateSessionManagerCache,
  invalidateSessionPathCache,
  listAllSessions,
} from "@/lib/session-reader";
import { abortSubagent, destroyRpcSessionsForCwd, getRpcSession } from "@/lib/rpc-manager";
import { forgetSessionUiState } from "@/lib/session-ui-state";
import { workspaceKeyOf } from "@/lib/workspace-memory";
import { isApiRequestAllowed } from "@/lib/request-security";
import { samePath } from "@/lib/paths";

export const dynamic = "force-dynamic";

// DELETE /api/sessions/workspace
// Deletes only the pi-web / pi session metadata and files for a workspace.
// Does NOT touch any user project files or directories.
export async function DELETE(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  try {
    const body = (await req.json()) as { root?: unknown; projectKey?: unknown };
    const root = typeof body?.root === "string" ? body.root.trim() : "";
    const projectKey = typeof body?.projectKey === "string" ? body.projectKey.trim() : "";

    if (!root && !projectKey) {
      return NextResponse.json({ error: "root or projectKey is required" }, { status: 400 });
    }

    // 1. Terminate any running agent sessions for this workspace
    if (root) {
      await destroyRpcSessionsForCwd(root).catch(() => undefined);
    }

    // 2. Find all sessions belonging to this workspace
    const allSessions = await listAllSessions({ force: true });
    const targetSessions = allSessions.filter((s) => {
      if (root && (s.cwd === root || s.projectRoot === root || samePath(s.cwd, root) || (s.projectRoot && samePath(s.projectRoot, root)))) {
        return true;
      }
      if (projectKey && workspaceKeyOf(s) === projectKey) {
        return true;
      }
      return false;
    });

    // 3. Delete session files and shutdown runtimes
    for (const session of targetSessions) {
      try {
        await abortSubagent(session.id);
      } catch {
        // ignore
      }
      try {
        await getRpcSession(session.id)?.shutdown();
      } catch {
        // ignore
      }
      try {
        if (session.path && fs.existsSync(session.path)) {
          fs.unlinkSync(session.path);
        }
      } catch {
        // ignore
      }
      invalidateSessionPathCache(session.id);
      if (session.path) {
        invalidateSessionManagerCache(session.path);
      }

    }

    await forgetSessionUiState(targetSessions.map((session) => session.id)).catch(() => undefined);

    // 4. Safely clean up empty session folders in ~/.pi/agent/sessions/ ONLY
    const baseSessionsDir = path.resolve(path.join(getAgentDir(), "sessions"));
    const affectedDirs = new Set(targetSessions.map((s) => path.dirname(path.resolve(s.path))));
    for (const dir of affectedDirs) {
      try {
        if (dir.startsWith(baseSessionsDir) && dir !== baseSessionsDir && fs.existsSync(dir)) {
          const files = fs.readdirSync(dir);
          if (files.length === 0 || files.every((f) => !f.endsWith(".jsonl"))) {
            fs.rmSync(dir, { recursive: true, force: true });
          }
        }
      } catch {
        // ignore
      }
    }

    invalidateSessionListCache();
    return NextResponse.json({ success: true, count: targetSessions.length });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
