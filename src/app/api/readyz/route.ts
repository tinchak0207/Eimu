import { NextResponse } from "next/server";
import { generationDatabaseConfigured, getGenerationSql } from "@/lib/generation-core/database";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  if (!generationDatabaseConfigured()) {
    return NextResponse.json({ ok: false, db: "unconfigured" }, { status: 503 });
  }
  try {
    await getGenerationSql()`SELECT 1 AS ok`;
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false, db: "unavailable" }, { status: 503 });
  }
}
