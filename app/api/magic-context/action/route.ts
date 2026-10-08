import { NextResponse } from "next/server";
import { getRpcSession, startRpcSession } from "@/lib/rpc-manager";
import { resolveSessionPath } from "@/lib/session-reader";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { action: "wrapup" | "dream"; sessionId?: string };
    const { action, sessionId } = body;

    if (!action || (action !== "wrapup" && action !== "dream")) {
      return NextResponse.json({ error: "Invalid action. Expected wrapup or dream." }, { status: 400 });
    }

    if (!sessionId) {
      return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
    }

    let wrapper = getRpcSession(sessionId);
    if (!wrapper?.isAlive()) {
      const filePath = await resolveSessionPath(sessionId);
      if (!filePath) {
        return NextResponse.json({ error: "Session not found" }, { status: 404 });
      }
      const started = await startRpcSession(sessionId, filePath, undefined);
      wrapper = started.session;
    }

    const command = action === "wrapup" ? "/ctx-wrapup" : "/ctx-dream";

    // Send the slash command prompt
    void wrapper.send({
      type: "prompt",
      message: command,
    }).catch((err) => {
      console.error(`[pi-web] Failed to execute ${command}:`, err);
    });

    return NextResponse.json({ success: true, action, command });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
