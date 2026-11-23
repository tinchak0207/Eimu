// GET /api/agent/memory/mine/export —— 把当前用户的私有记忆整包下载为 JSON（数据可携带）。

import { NextRequest, NextResponse } from "next/server";
import { listMemoryDocs } from "@/lib/agent-memory-store";
import { noStore, resolveSkillOwner } from "@/app/api/skills/mine/owner";
import { toMineView } from "../view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const owner = await resolveSkillOwner(req);
  if (!owner.ok) return owner.response;
  try {
    const docs = await listMemoryDocs({ scope: "private", ownerKey: owner.ownerKey });
    const payload = { exportedAt: new Date().toISOString(), memories: docs.map(toMineView) };
    return new NextResponse(JSON.stringify(payload, null, 2), {
      headers: {
        ...noStore,
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": 'attachment; filename="eimu-memories.json"',
      },
    });
  } catch {
    return NextResponse.json({ error: "internal_error" }, { status: 500, headers: noStore });
  }
}
