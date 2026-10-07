import { NextResponse } from "next/server";
import { isApiRequestAllowed, hasJsonContentType } from "@/lib/request-security";
import {
  getToolOverrides,
  setToolOverride,
  saveAllToolOverrides,
  type ToolOverride,
  type ToolOverridesMap,
} from "@/lib/tool-overrides";
import { applyToolOverridesToRunningSessions } from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const overrides = await getToolOverrides();
    return NextResponse.json({ overrides });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

export async function PUT(req: Request) {
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

  const { toolName, override, overrides } = body as {
    toolName?: string;
    override?: ToolOverride | null;
    overrides?: ToolOverridesMap;
  };

  try {
    let updated: ToolOverridesMap;
    if (typeof toolName === "string" && toolName.trim()) {
      updated = await setToolOverride(toolName.trim(), override !== undefined ? override : null);
    } else if (overrides && typeof overrides === "object") {
      updated = await saveAllToolOverrides(overrides);
    } else {
      return NextResponse.json(
        { error: "Provide either toolName + override or overrides map" },
        { status: 400 },
      );
    }

    try {
      await applyToolOverridesToRunningSessions();
    } catch (e) {
      console.error("[pi-web] Failed to propagate tool overrides to running sessions:", e);
    }

    return NextResponse.json({ success: true, overrides: updated });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
