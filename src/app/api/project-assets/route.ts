// REQ-B2 團隊資產空間 API（項目資產庫）：
//   GET    ?projectId=&q=&kind=&mounted=  → 該項目可見的資產列表（包 + 卡，帶掛用標記）+ sharesIn
//   POST   { projectId, assetKind, assetId } → 掛用（copy-on-use：建本地副本 + 回 localCopyId；同鍵冪等）
//   DELETE { projectId, assetKind, assetId } → 解除掛用（回該記錄的 localCopyId，前端據它解鎖）
// 認證：requireVerifiedUser（與 /api/assets、/api/character-cards 同款，不信任 x-user-id）。
// 紅線：不可見即不可用——掛用前必過 resolveMountable，不可見一律 403（不得靜默成功）。
import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedUser } from "@/lib/server-user";
import {
  AssetCopyLimitError,
  AssetMountCopyConflictError,
  AssetMountCopyRejectedError,
  AssetSourceMissingError,
  listProjectAssetLibrary,
  mountAssetWithCopy,
  resolveMountable,
  unmountAssetAndCopies,
} from "@/lib/asset-library";
import { AssetMountConflictError, AssetMountLimitError } from "@/lib/asset-scope-store";
import { isAssetLocalCopyId, toAssetKind } from "@/lib/asset-scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function fail(status: number, message: string, code: string): NextResponse {
  return NextResponse.json({ success: false, error: message, code }, { status });
}

export async function GET(req: NextRequest) {
  const caller = await requireVerifiedUser(req);
  if (!caller.ok) return fail(caller.status, caller.message, "unauthorized");

  const projectId = (req.nextUrl.searchParams.get("projectId") ?? "").trim();
  if (!projectId) return fail(400, "缺少 projectId", "invalid_payload");
  const rawKind = req.nextUrl.searchParams.get("kind");
  const kind = rawKind && rawKind !== "all" ? toAssetKind(rawKind) : "all";
  if (kind === null) return fail(400, "kind 只能是 pack / card / all", "invalid_payload");

  try {
    const { items, mounts, shares, sharesIn } = await listProjectAssetLibrary({
      userId: caller.user.id,
      projectId,
      query: {
        q: req.nextUrl.searchParams.get("q") ?? "",
        kind,
        mountedOnly: req.nextUrl.searchParams.get("mounted") === "1",
      },
    });
    return NextResponse.json(
      {
        success: true,
        items,
        mountedCount: mounts.filter((m) => m.projectId === projectId).length,
        // 顯式分享授權（本項目為來源的那些）：UI 顯示「已分享到 N 個項目」用。
        sharesOut: shares.filter((s) => s.fromProjectId === projectId && !s.revokedAt).length,
        // REQ-B2b：授權**進來**本項目的分享（前端讀取閘判「分享進來」用，與寫入端同一把尺）。
        sharesIn,
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("[project-assets] list failed:", error);
    return fail(500, "读取项目资产库失败，请稍后再试", "internal_error");
  }
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
  const projectId = typeof body?.projectId === "string" ? body.projectId.trim() : "";
  const assetKind = toAssetKind(body?.assetKind);
  const assetId = typeof body?.assetId === "string" ? body.assetId.trim() : "";
  if (!projectId || !assetKind || !assetId) {
    return fail(400, "缺少 projectId / assetKind / assetId", "invalid_payload");
  }

  try {
    // 不可見即不可用：不可見（別人項目的資產且未顯式分享）一律 403。
    // 內部副本（copy-…）先擋：它是掛用機制的產物，再掛用只會生出「副本的副本」（D5 卡片膨脹），
    // 故回可辨識的拒絕碼，而不是混進「不可見」那一句（誠實說原因）。
    if (isAssetLocalCopyId(assetId)) {
      return fail(400, "内部副本不可挂用：请挂用它的来源资产（副本由挂用自动生成）", "asset_copy_internal");
    }
    const mountable = await resolveMountable({ userId: caller.user.id, projectId, assetKind, assetId });
    if (!mountable) {
      return fail(403, "该资产在当前项目不可见（跨项目复用需先显式分享）", "asset_not_visible");
    }
    // copy-on-use：建本地副本（內容本體）+ lineage 指回來源 → 再落冪等掛用記錄。
    // 回應必帶 localCopyId/localCopyIds：前端要把副本鎖進 cardIds，否則畫面說「已掛用」但生成仍注入來源。
    const result = await mountAssetWithCopy({ userId: caller.user.id, projectId, assetKind, assetId });
    return NextResponse.json(
      {
        success: true,
        mount: result.mount,
        created: result.created,
        copied: result.copied,
        localCopyId: result.localCopyId,
        localCopyIds: result.localCopyIds,
        skippedItems: result.skippedItems,
        copyKind: assetKind,
      },
      { status: 200 },
    );
  } catch (error) {
    if (error instanceof AssetMountConflictError) {
      // 確定性鍵碰撞（別名）：這是衝突，不是「已掛用」——不得回 success:true 冒充冪等。
      return fail(409, "挂用键冲突：该确定性键已对应另一笔挂用，请勿复用同一资产 id", "asset_mount_conflict");
    }
    if (error instanceof AssetMountCopyConflictError) {
      // 副本鍵被非副本資產佔用：同樣是衝突，不得冒充冪等重放（否則等於拿別人的資產當你的副本）。
      return fail(409, error.message, "asset_copy_conflict");
    }
    if (error instanceof AssetMountCopyRejectedError) {
      return fail(400, error.message, `asset_copy_rejected:${error.reason}`);
    }
    if (error instanceof AssetSourceMissingError) {
      return fail(404, "资产不存在或已删除", "asset_not_found");
    }
    if (error instanceof AssetCopyLimitError) {
      return fail(400, error.message, "asset_copy_limit");
    }
    if (error instanceof AssetMountLimitError) {
      return fail(400, "项目资产挂用记录已达上限，请先解除部分挂用", "mount_limit");
    }
    console.error("[project-assets] mount failed:", error);
    return fail(500, "挂用资产失败，请稍后再试", "internal_error");
  }
}

export async function DELETE(req: NextRequest) {
  const caller = await requireVerifiedUser(req);
  if (!caller.ok) return fail(caller.status, caller.message, "unauthorized");

  let body: Record<string, unknown> | null = null;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return fail(400, "请求体必须是合法 JSON", "invalid_json");
  }
  const projectId = typeof body?.projectId === "string" ? body.projectId.trim() : "";
  const assetKind = toAssetKind(body?.assetKind);
  const assetId = typeof body?.assetId === "string" ? body.assetId.trim() : "";
  if (!projectId || !assetKind || !assetId) {
    return fail(400, "缺少 projectId / assetKind / assetId", "invalid_payload");
  }

  try {
    // 解除＝解掛記錄 + 回收這次掛用親手落地的副本（D1/D5）：
    // 回應必帶「該筆掛用實際鎖過的全部副本 id」（記錄優先，不靠當下推導），
    // 前端據它把副本從 cardIds 解鎖——否則「已解除」只是記錄沒了、生成還在注入副本。
    const result = await unmountAssetAndCopies({ userId: caller.user.id, projectId, assetKind, assetId });
    return NextResponse.json(
      {
        success: true,
        removed: result.removed,
        localCopyId: result.localCopyId,
        localCopyIds: result.localCopyIds,
        deletedCards: result.deletedCards,
        deletedPacks: result.deletedPacks,
      },
      { status: 200 },
    );
  } catch (error) {
    console.error("[project-assets] unmount failed:", error);
    return fail(500, "解除挂用失败，请稍后再试", "internal_error");
  }
}
