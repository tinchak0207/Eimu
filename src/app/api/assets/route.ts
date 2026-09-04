// 資產包 API：list / upsert / delete。
// 認證：requireVerifiedUser（上游 /api/user/self 驗證，不信任 x-user-id）。
import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedUser } from "@/lib/server-user";
import {
  AssetPackLimitError,
  deleteAssetPacks,
  listAssetPacks,
  normalizeAssetPack,
  saveAssetPack,
} from "@/lib/asset-pack-store";
import type { AssetPack } from "@/lib/asset-pack-store";

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
    let packs = await listAssetPacks(caller.user.id);
    if (q) {
      packs = packs.filter(
        (p) =>
          p.title.toLowerCase().includes(q) ||
          p.tags.some((tag) => tag.toLowerCase().includes(q)) ||
          (p.digest ?? "").toLowerCase().includes(q),
      );
    }
    return NextResponse.json({ success: true, packs }, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[asset-packs] list failed:", error);
    return fail(500, "读取资产包失败，请稍后再试", "internal_error");
  }
}

export async function PUT(req: NextRequest) {
  const caller = await requireVerifiedUser(req);
  if (!caller.ok) return fail(caller.status, caller.message, "unauthorized");

  let body: Partial<AssetPack> | null = null;
  try {
    body = (await req.json()) as Partial<AssetPack>;
  } catch {
    return fail(400, "请求体必须是合法 JSON", "invalid_json");
  }
  const normalized = normalizeAssetPack(body);
  if (!normalized) {
    return fail(400, "资产包数据无效（需要 id / title，items 每项需要合法 kind / title）", "invalid_payload");
  }

  try {
    await saveAssetPack(caller.user.id, normalized);
    return NextResponse.json({ success: true, pack: normalized }, { status: 200 });
  } catch (error) {
    if (error instanceof AssetPackLimitError) {
      return fail(400, "资产包数量已达上限 100 个，请先删除部分资产包", "asset_limit");
    }
    console.error("[asset-packs] save failed:", error);
    return fail(500, "保存资产包失败，请稍后再试", "internal_error");
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
    await deleteAssetPacks(caller.user.id, ids);
    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    console.error("[asset-packs] delete failed:", error);
    return fail(500, "删除资产包失败，请稍后再试", "internal_error");
  }
}
