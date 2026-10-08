import { NextResponse } from "next/server";
import { getGoalRunnerStatus } from "@/lib/goal-runner";
import { getCompletionNotificationSuppressedRpcSessionIds, getGoalRunnerWatchdogStatus, getRunningRpcSessionIds, triggerAutoResumeInterruptedSessions } from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    triggerAutoResumeInterruptedSessions();
    const url = new URL(req.url);
    const sessionId = url.searchParams.get("sessionId") || undefined;
    const eventTypes = url.searchParams.get("eventTypes")?.split(",").map((type) => type.trim()).filter(Boolean);
    const status = await getGoalRunnerStatus(sessionId, {
      runningSessionIds: getRunningRpcSessionIds(),
      completionNotificationSuppressedSessionIds: getCompletionNotificationSuppressedRpcSessionIds(),
      eventTypes,
    });
    return NextResponse.json({ ...status, watchdog: getGoalRunnerWatchdogStatus() });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
