import { NextResponse } from "next/server";
import { homedir } from "os";
import path from "path";
import { existsSync, readFileSync } from "fs";
import { DatabaseSync } from "node:sqlite";

export const dynamic = "force-dynamic";

function getCortexConfig(): Record<string, any> {
  const configPath = path.join(homedir(), ".config", "cortexkit", "magic-context.jsonc");
  try {
    if (existsSync(configPath)) {
      const raw = readFileSync(configPath, "utf8");
      // Strip jsonc comments if any
      const cleaned = raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      return JSON.parse(cleaned);
    }
  } catch {}
  return {};
}

export async function GET() {
  const dbPath = path.join(homedir(), ".local", "share", "cortexkit", "magic-context", "context.db");
  if (!existsSync(dbPath)) {
    return NextResponse.json({ available: false });
  }

  try {
    const config = getCortexConfig();
    const historianModel = config.historian?.pi?.model || config.historian?.model || "cpa/gpt-5.6-terra";
    const dreamerModel = config.dreamer?.pi?.model || config.dreamer?.model || "cpa/gpt-5.6-terra";

    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      // 1. Memories
      const memories = db.prepare(
        "SELECT id, category, content FROM memories ORDER BY id DESC LIMIT 50",
      ).all() as Array<{ id: number; category: string; content: string }>;

      // 2. Latest dream run
      let latestDreamRun: any = null;
      try {
        latestDreamRun = db.prepare(
          "SELECT * FROM dream_runs ORDER BY id DESC LIMIT 1",
        ).get();
      } catch {}

      // 3. Recent subagent invocations
      let recentInvocations: any[] = [];
      try {
        recentInvocations = db.prepare(
          "SELECT id, session_id, subagent, task, provider_id, model_id, started_at, ended_at, status, input_tokens, output_tokens, error " +
            "FROM subagent_invocations ORDER BY id DESC LIMIT 10",
        ).all() as any[];
      } catch {}

      return NextResponse.json({
        available: true,
        historian: {
          model: historianModel,
          recentInvocations: recentInvocations.filter((i) => i.subagent === "historian"),
        },
        dreamer: {
          model: dreamerModel,
          latestRun: latestDreamRun,
          recentInvocations: recentInvocations.filter((i) => i.subagent !== "historian"),
        },
        memories: {
          total: memories.length,
          items: memories,
        },
      });
    } finally {
      db.close();
    }
  } catch (error) {
    return NextResponse.json(
      { available: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
