import { NextResponse } from "next/server";
import { openSessionManager, resolveSessionPath } from "@/lib/session-reader";
import { getRpcSession, startRpcSession } from "@/lib/rpc-manager";
import {
  clearInterruptedSession,
  getInterruptedSessions,
  inspectSessionInterruption,
} from "@/lib/session-interruption";
import type { SessionEntry } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const existing = getRpcSession(id);
    if (existing?.isAlive() && existing.isRunning()) {
      return NextResponse.json({ success: true, alreadyRunning: true });
    }

    const filePath = existing?.sessionFile || (await resolveSessionPath(id));
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const sm = existing?.inner.sessionManager ?? openSessionManager(filePath);
    const entries = sm.getEntries() as unknown as SessionEntry[];
    const leafId = sm.getLeafId();
    const interruptedMap = await getInterruptedSessions();
    const inspection = inspectSessionInterruption(entries, leafId, id, interruptedMap);

    if (!inspection.canResume) {
      return NextResponse.json({
        success: false,
        message: "No interrupted or unfulfilled turn found for this session.",
      });
    }

    // Start wrapper if not running
    let sessionWrapper = existing;
    if (!sessionWrapper?.isAlive()) {
      const started = await startRpcSession(id, filePath, undefined);
      sessionWrapper = started.session;
    }

    // Determine continuation message:
    // If the last entry was a user message, prompting empty string causes pi to answer it.
    // If it was an interrupted assistant or toolResult, prompt "继续" to continue the turn.
    const message = inspection.turnType === "unanswered_user" ? "" : "继续";

    await clearInterruptedSession(id);

    // Send the continuation prompt
    void sessionWrapper.send({
      type: "prompt",
      message,
    }).catch((err) => {
      console.error("[pi-web] Failed to send resume prompt:", err);
    });

    return NextResponse.json({
      success: true,
      resumed: true,
      turnType: inspection.turnType,
      message,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
