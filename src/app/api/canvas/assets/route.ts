// 云端素材库 API：list / upsert / delete。
// 认证：requireVerifiedUser（上游 /api/user/self 验证，不信任 x-user-id）。
import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedUser } from "@/lib/server-user";
import {
  CanvasAssetLimitError,
  MAX_IMAGE_DATA_URL_BYTES,
  deleteCanvasAssets,
  listCanvasAssets,
  normalizeAsset,
  saveCanvasAsset,
} from "@/lib/canvas/asset-store";
import type { CanvasAsset } from "@/lib/canvas/asset-store";
import { MAX_ASSET_PROJECT_TAGS, projectTagIdsOverLimit } from "@/lib/asset-scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

function fail(status: number, message: string, code: string): NextResponse {
  return NextResponse.json({ success: false, error: message, code }, { status });
}

export async function GET(req: NextRequest) {
  const caller = await requireVerifiedUser(req);
  if (!caller.ok) return fail(caller.status, caller.message, "unauthorized");
  try {
    const q = (req.nextUrl.searchParams.get("q") ?? "").trim().toLowerCase();
    const kind = (req.nextUrl.searchParams.get("kind") ?? "").trim();
    let assets = await listCanvasAssets(caller.user.id);
    if (kind === "text" || kind === "image") {
      assets = assets.filter((a) => a.kind === kind);
    }
    if (q) {
      assets = assets.filter(
        (a) => a.title.toLowerCase().includes(q) || a.tags.some((tag) => tag.toLowerCase().includes(q)),
      );
    }
    return NextResponse.json({ success: true, assets }, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[canvas-assets] list failed:", error);
    return fail(500, "读取素材失败，请稍后再试", "internal_error");
  }
}

export async function PUT(req: NextRequest) {
  const caller = await requireVerifiedUser(req);
  if (!caller.ok) return fail(caller.status, caller.message, "unauthorized");

  let body: Partial<CanvasAsset> | null = null;
  try {
    body = (await req.json()) as Partial<CanvasAsset>;
  } catch {
    return fail(400, "请求体必须是合法 JSON", "invalid_json");
  }
  // dataURL 超限先给明确错误讯息（normalizeAsset 也会拒绝，但讯息含糊）。
  if (
    typeof body?.imageUrl === "string" &&
    body.imageUrl.startsWith("data:") &&
    body.imageUrl.length > MAX_IMAGE_DATA_URL_BYTES
  ) {
    return fail(400, "图片素材超过 2MB 上限，请压缩后再存", "image_too_large");
  }
  // 修复 3：项目标签超上限一律 fail-loud 拒收（不再让 normalizeProjectIds 静默截断丢标签）。
  // 放在「缺键不动」合并之前：只对本次请求**显式送来**的 projectIds 判长度（未给＝不动，不拒）。
  if (projectTagIdsOverLimit(body?.projectIds)) {
    return fail(400, `项目标签最多 ${MAX_ASSET_PROJECT_TAGS} 个`, "too_many_project_tags");
  }
  // P1-A 项目标签语义（纯加法）：**未给 projectIds ＝ 不动**（整包 PUT 不得静默清空既有标签）；
  // 显式给值（含空阵列＝明确清除）才以该值为准。范式＝character-cards PATCH 的局部更新合并；
  // 清洗仍由 normalizeAsset 收口，本路由不重复实作白名单。读取端原样回传。
  if (body && typeof body === "object" && body.projectIds === undefined) {
    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (id) {
      const existing = (await listCanvasAssets(caller.user.id)).find((a) => a.id === id);
      if (existing?.projectIds?.length) body = { ...body, projectIds: existing.projectIds };
    }
  }
  const normalized = normalizeAsset(body);
  if (!normalized) {
    return fail(400, "素材数据无效（需要 id / kind / title，image 素材需要合法 imageUrl）", "invalid_payload");
  }

  try {
    await saveCanvasAsset(caller.user.id, normalized);
    return NextResponse.json({ success: true, asset: normalized }, { status: 200 });
  } catch (error) {
    if (error instanceof CanvasAssetLimitError) {
      return fail(400, "素材数量已达上限 500 条，请先删除部分素材", "asset_limit");
    }
    console.error("[canvas-assets] save failed:", error);
    return fail(500, "保存素材失败，请稍后再试", "internal_error");
  }
}

export async function DELETE(req: NextRequest) {
  const caller = await requireVerifiedUser(req);
  if (!caller.ok) return fail(caller.status, caller.message, "unauthorized");

  let ids: string[] = [];
  try {
    const body = (await req.json()) as { ids?: unknown };
    ids = Array.isArray(body?.ids) ? body.ids.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return fail(400, "请求体必须是合法 JSON", "invalid_json");
  }
  if (!ids.length) return fail(400, "缺少 ids", "invalid_payload");

  try {
    await deleteCanvasAssets(caller.user.id, ids);
    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    console.error("[canvas-assets] delete failed:", error);
    return fail(500, "删除素材失败，请稍后再试", "internal_error");
  }
}
