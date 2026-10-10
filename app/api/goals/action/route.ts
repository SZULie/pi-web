import { NextResponse } from "next/server";
import {
  applyGoalRunnerAction,
  clearStaleGoalRunnerLock,
  goalContinuationPromptFromRecord,
  readGoalRunnerStore,
  restoreGoalRunnerStoreFromBackup,
  updateGoalRunnerStore,
} from "@/lib/goal-runner";
import { getRpcSession, startRpcSession } from "@/lib/rpc-manager";
import { resolveSessionPath } from "@/lib/session-reader";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({})) as { sessionId?: string; action?: string; mode?: string; text?: string; subtaskId?: string };
    const sessionId = body.sessionId;
    const action = body.action;
    if (action === "unlock-stale-lock") {
      const result = await clearStaleGoalRunnerLock();
      return NextResponse.json({ success: true, ...result });
    }
    if (action === "restore-backup") {
      const result = await restoreGoalRunnerStoreFromBackup();
      return NextResponse.json({ success: true, ...result });
    }
    if (!sessionId) {
      return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
    }
    if (!action) {
      return NextResponse.json({ error: "action is required" }, { status: 400 });
    }

    const runningSession = action === "resume" || action === "run-now" ? getRpcSession(sessionId) : undefined;
    if (runningSession?.isRunning()) {
      const goal = (await readGoalRunnerStore()).sessions[sessionId];
      if (!goal) return NextResponse.json({ error: "Goal not found" }, { status: 404 });
      return NextResponse.json({ success: true, goal, dispatched: false, skippedBecauseRunning: true });
    }

    const updateResult = await updateGoalRunnerStore((store) => {
      let goal = store.sessions[sessionId];
      if (!goal && action === "start") {
        const trimmed = body.text?.trim();
        if (!trimmed) return { error: "text is required to start a goal", status: 400 as const };
        const now = Date.now();
        goal = {
          sessionId,
          objective: trimmed,
          subtasks: [],
          events: [],
          status: "stopped",
          phase: "clarifying",
          mode: "finish",
          createdAt: now,
          updatedAt: now,
          iteration: 0,
          consecutiveFailures: 0,
        };
      }
      if (!goal) return { error: "Goal not found", status: 404 as const };

      const updated = applyGoalRunnerAction(goal, action, body.mode, body.text, body.subtaskId);
      if (!updated) return { error: `Unsupported action: ${action}`, status: 400 as const };

      store.sessions[sessionId] = updated;
      return { goal: updated };
    });
    if ("error" in updateResult) {
      return NextResponse.json({ error: updateResult.error }, { status: updateResult.status });
    }
    const updated = updateResult.goal;

    let dispatched = false;
    let skippedBecauseRunning = false;
    if (action === "resume" || action === "run-now") {
      const existing = getRpcSession(sessionId);
      if (existing?.isRunning()) {
        skippedBecauseRunning = true;
      } else {
        const filePath = existing?.sessionFile || (await resolveSessionPath(sessionId));
        if (filePath) {
          const started = existing?.isAlive()
            ? { session: existing }
            : await startRpcSession(sessionId, filePath, undefined);
          dispatched = true;
          void started.session.send({
            type: "prompt",
            message: goalContinuationPromptFromRecord(updated),
          }).catch((err) => {
            console.error(`[pi-web] Failed to ${action === "run-now" ? "run" : "resume"} Goal Runner session ${sessionId}:`, err);
          });
        }
      }
    }

    return NextResponse.json({ success: true, goal: updated, dispatched, skippedBecauseRunning });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
