// 雲端素材庫 API：list / upsert / delete。
// 認證：requireVerifiedUser（上游 /api/user/self 驗證，不信任 x-user-id）。
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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
  // dataURL 超限先給明確錯誤訊息（normalizeAsset 也會拒絕，但訊息含糊）。
  if (
    typeof body?.imageUrl === "string" &&
    body.imageUrl.startsWith("data:") &&
    body.imageUrl.length > MAX_IMAGE_DATA_URL_BYTES
  ) {
    return fail(400, "图片素材超过 2MB 上限，请压缩后再存", "image_too_large");
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
