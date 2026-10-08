import { NextResponse } from "next/server";
import { isApiRequestAllowed, hasJsonContentType } from "@/lib/request-security";
import { getRpcSession, updateRpcSessionContextLimit } from "@/lib/rpc-manager";
import {
  getSessionContextLimit,
  setSessionContextLimit,
  parseTokenAmount,
} from "@/lib/session-context-limits";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const config = await getSessionContextLimit(id);
    const rpc = getRpcSession(id);
    const model = rpc?.inner?.model;
    const modelContextWindow = (model as any)?.contextWindow ?? null;
    const effectiveLimit = config?.contextLimit ?? modelContextWindow ?? null;

    return NextResponse.json({
      sessionId: id,
      customLimit: config?.contextLimit ?? null,
      thresholdPercent: config?.thresholdPercent ?? null,
      modelContextWindow,
      effectiveLimit,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "Expected JSON object" }, { status: 400 });
  }

  const { contextLimit: rawLimit, thresholdPercent: rawPercent } = body as {
    contextLimit?: number | string | null;
    thresholdPercent?: number | null;
  };

  const parsedLimit = rawLimit !== undefined && rawLimit !== null ? parseTokenAmount(rawLimit) : null;
  const parsedPercent =
    typeof rawPercent === "number" && rawPercent > 0 && rawPercent <= 100
      ? Math.round(rawPercent)
      : null;

  try {
    if (parsedLimit === null && parsedPercent === null) {
      await setSessionContextLimit(id, null);
      await updateRpcSessionContextLimit(id, null);
      return NextResponse.json({
        success: true,
        sessionId: id,
        customLimit: null,
        thresholdPercent: null,
      });
    }

    await setSessionContextLimit(id, {
      contextLimit: parsedLimit,
      thresholdPercent: parsedPercent,
    });
    await updateRpcSessionContextLimit(id, parsedLimit);

    return NextResponse.json({
      success: true,
      sessionId: id,
      customLimit: parsedLimit,
      thresholdPercent: parsedPercent,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
