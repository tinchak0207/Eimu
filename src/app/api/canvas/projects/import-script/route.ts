// POST /api/canvas/projects/import-script —— 扔进剧本（＋参考图），直接得到可开工的项目。
// body：{ script: string; title?: string; references?: {url,name?,role?}[] }
// 回：{ ok, projectId, policy, shotCount, sampleNodeId, fidelity, sampleDraft }
//   policy=finished：定稿剧本，按原文切镜、台词原样，禁止改写；policy=seed：一两句种子，允许扩写。
//   sampleDraft：给对话输入框的预填句——「先只试第 1 镜的风格」，不替用户发送、不花钱。

import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { buildScriptImportProject, type ScriptImportReference } from "@/lib/canvas/script-import";
import { saveCanvasProject } from "@/lib/canvas/project-store";
import { requireVerifiedUser } from "@/lib/accounts/server-user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_SCRIPT_CHARS = 60_000;

function fail(status: number, error: string, code: string) {
  return NextResponse.json({ success: false, error, code }, { status });
}

export async function POST(req: NextRequest) {
  const caller = await requireVerifiedUser(req);
  if (!caller.ok) return fail(caller.status, caller.message, "unauthorized");
  let body: Record<string, unknown> | null = null;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return fail(400, "请求体必须是合法 JSON", "invalid_json");
  }
  const script = typeof body?.script === "string" ? body.script.trim() : "";
  if (!script) return fail(400, "剧本不能为空", "invalid_payload");
  if (script.length > MAX_SCRIPT_CHARS) return fail(413, `剧本最长 ${MAX_SCRIPT_CHARS} 字，请分集导入`, "script_too_long");
  const references: ScriptImportReference[] = Array.isArray(body?.references)
    ? (body!.references as unknown[]).flatMap((item) => {
        const r = item as { url?: unknown; name?: unknown; role?: unknown };
        if (typeof r?.url !== "string") return [];
        const role: ScriptImportReference["role"] = r.role === "character" || r.role === "composition" || r.role === "style" ? r.role : undefined;
        return [{ url: r.url, ...(typeof r.name === "string" ? { name: r.name } : {}), ...(role ? { role } : {}) }];
      })
    : [];

  const result = buildScriptImportProject({
    script,
    title: typeof body?.title === "string" ? body.title.slice(0, 80) : undefined,
    references,
    newProjectId: `canvas-${randomUUID()}`,
  });
  await saveCanvasProject(caller.user.id, result.project);
  const sampleDraft = result.sampleNodeId
    ? `先只试第 1 镜的风格${references.length ? "（带上我给的参考图）" : ""}，${result.policy === "finished" ? "剧本和台词一字不改，" : ""}我看完再决定做不做整集。`
    : "";
  return NextResponse.json(
    {
      ok: true,
      projectId: result.project.id,
      policy: result.policy,
      shotCount: result.shotCount,
      sampleNodeId: result.sampleNodeId,
      fidelity: result.fidelity,
      sampleDraft,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
