import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedUser } from "@/lib/server-user";
import { deleteHistoryEntries, getHistoryEntry, patchHistoryEntry } from "@/lib/server-history-store";

export const runtime = "nodejs";
export const preferredRegion = "sfo1";

/** Next 15 的动态段是异步的，params 必须 await。 */
type RouteContext = { params: Promise<{ id: string }> };

function fail(status: number, message: string) {
  return NextResponse.json({ success: false, message }, { status });
}

/** GET /api/history/[id] — 读取单条记录。 */
export async function GET(req: NextRequest, context: RouteContext) {
  const auth = await requireVerifiedUser(req);
  if (!auth.ok) return fail(auth.status, auth.message);

  const { id } = await context.params;
  // 只在这个用户自己的记录里查 —— id 猜中了也读不到别人的。
  const entry = await getHistoryEntry(auth.user.id, id);
  if (!entry) return fail(404, "记录不存在。");

  return NextResponse.json({ success: true, data: entry });
}

/** PATCH /api/history/[id] — 目前只支持收藏开关。 */
export async function PATCH(req: NextRequest, context: RouteContext) {
  const auth = await requireVerifiedUser(req);
  if (!auth.ok) return fail(auth.status, auth.message);

  const { id } = await context.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(400, "请求体不是合法的 JSON。");
  }

  const starred = (body as { starred?: unknown } | null)?.starred;
  if (typeof starred !== "boolean") return fail(400, "starred 必须是布尔值。");

  const updated = await patchHistoryEntry(auth.user.id, id, { starred });
  if (!updated) return fail(404, "记录不存在。");

  return NextResponse.json({ success: true, data: updated });
}

/** DELETE /api/history/[id] — 删除单条记录。 */
export async function DELETE(req: NextRequest, context: RouteContext) {
  const auth = await requireVerifiedUser(req);
  if (!auth.ok) return fail(auth.status, auth.message);

  const { id } = await context.params;
  const removed = await deleteHistoryEntries(auth.user.id, [id]);
  if (!removed) return fail(404, "记录不存在。");

  return NextResponse.json({ success: true, removed });
}
