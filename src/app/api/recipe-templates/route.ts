import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedUser } from "@/lib/server-user";
import {
  deleteUserRecipeTemplate,
  listUserRecipeTemplates,
  saveUserRecipeTemplate,
} from "@/lib/recipe-template-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function fail(status: number, message: string, code: string) {
  return NextResponse.json({ success: false, message, code }, { status });
}

const noStore = { "Cache-Control": "no-store" } as const;

/** GET /api/recipe-templates — 我的模板列表（登录用户）。 */
export async function GET(req: NextRequest) {
  const auth = await requireVerifiedUser(req);
  if (!auth.ok) return fail(auth.status, auth.message, "unauthorized");
  try {
    const items = await listUserRecipeTemplates(auth.user.id);
    return NextResponse.json({ success: true, data: { items } }, { headers: noStore });
  } catch (error) {
    console.error("[recipe-templates] list failed", error);
    return fail(503, "模板列表暂时不可用，请稍后再试。", "template_read_failed");
  }
}

/**
 * POST /api/recipe-templates — 模板捕获器写入端。
 * body: { name, config, templateId? }；config 必须是 workflow-recall 规范化配方
 * （前端用 parseWorkflowRecallConfig 校验后再提交，这里做防御性兜底）。
 */
export async function POST(req: NextRequest) {
  const auth = await requireVerifiedUser(req);
  if (!auth.ok) return fail(auth.status, auth.message, "unauthorized");

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return fail(400, "请求体格式不正确。", "invalid_request");
  }

  const templateId = typeof body.templateId === "string" && body.templateId.trim() ? body.templateId.trim() : undefined;
  if (body.templateId !== undefined && !templateId) {
    return fail(400, "templateId 不能为空。", "invalid_request");
  }

  try {
    const result = await saveUserRecipeTemplate({
      userId: auth.user.id,
      name: typeof body.name === "string" ? body.name : "",
      config: body.config,
      templateId,
    });
    if (!result.ok) {
      const status = result.code === "invalid_name" || result.code === "invalid_config" ? 400 : 409;
      return fail(status, result.message, result.code);
    }
    return NextResponse.json({ success: true, data: { item: result.template } }, { headers: noStore });
  } catch (error) {
    console.error("[recipe-templates] save failed", error);
    return fail(503, "模板保存暂时不可用，请稍后再试。", "template_write_failed");
  }
}

/** DELETE /api/recipe-templates?id=… — 删除我的模板（幂等：不存在也返回成功）。 */
export async function DELETE(req: NextRequest) {
  const auth = await requireVerifiedUser(req);
  if (!auth.ok) return fail(auth.status, auth.message, "unauthorized");

  const templateId = req.nextUrl.searchParams.get("id")?.trim();
  if (!templateId) return fail(400, "缺少模板 id。", "invalid_request");

  try {
    const removed = await deleteUserRecipeTemplate(auth.user.id, templateId);
    // 幂等删除：目标已不存在 = 删除成功（与 agent 会话 DELETE 幂等化同一决策）
    return NextResponse.json({ success: true, data: { removed, already_gone: !removed } }, { headers: noStore });
  } catch (error) {
    console.error("[recipe-templates] delete failed", error);
    return fail(503, "模板删除暂时不可用，请稍后再试。", "template_delete_failed");
  }
}
