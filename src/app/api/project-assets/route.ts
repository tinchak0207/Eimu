// REQ-B2 团队资产空间 API（项目资产库）：
//   GET    ?projectId=&q=&kind=&mounted=  → 该项目可见的资产列表（包 + 卡，带挂用标记）+ sharesIn
//   POST   { projectId, assetKind, assetId } → 挂用（copy-on-use：建本地副本 + 回 localCopyId；同键幂等）
//   DELETE { projectId, assetKind, assetId } → 解除挂用（回该记录的 localCopyId，前端据它解锁）
// 认证：requireVerifiedUser（与 /api/assets、/api/character-cards 同款，不信任 x-user-id）。
// 红线：不可见即不可用——挂用前必过 resolveMountable，不可见一律 403（不得静默成功）。
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
import { readCanvasProject } from "@/lib/canvas/project-store";
import { listCanvasProjectsForCaller } from "@/lib/canvas/team-canvas-gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

function fail(status: number, message: string, code: string): NextResponse {
  return NextResponse.json({ success: false, error: message, code }, { status });
}

/**
 * 项目归属闸（2026-10-05 红队）：GET 要求 projectId 却忽略其值——传任意值都回同一批，
 * 是潜在 IDOR 温床。projectId 必须是呼叫者自有画布，或是其可见（团队成员）的团队画布。
 * 先查个人画布（便宜、不打 relay），未命中再查「个人＋团队」可见集（与 /api/canvas/projects
 * 同一把尺，不另立规则）；两者皆无 ⇒ 非自有／不存在，403。挂用写入路径仍照旧走
 * resolveMountable 的资产可见性闸（本处只补读路径的项目归属）。
 */
async function projectVisibleToCaller(userId: number, projectId: string): Promise<boolean> {
  if (await readCanvasProject(userId, projectId)) return true;
  const visible = await listCanvasProjectsForCaller(userId);
  return visible.some((project) => project.id === projectId);
}

export async function GET(req: NextRequest) {
  const caller = await requireVerifiedUser(req);
  if (!caller.ok) return fail(caller.status, caller.message, "unauthorized");

  const projectId = (req.nextUrl.searchParams.get("projectId") ?? "").trim();
  if (!projectId) return fail(400, "缺少 projectId", "invalid_payload");
  if (!(await projectVisibleToCaller(caller.user.id, projectId))) {
    return fail(403, "画布不存在或不属于你", "project_not_visible");
  }
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
        // 显式分享授权（本项目为来源的那些）：UI 显示「已分享到 N 个项目」用。
        sharesOut: shares.filter((s) => s.fromProjectId === projectId && !s.revokedAt).length,
        // REQ-B2b：授权**进来**本项目的分享（前端读取闸判「分享进来」用，与写入端同一把尺）。
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
    // 不可见即不可用：不可见（别人项目的资产且未显式分享）一律 403。
    // 内部副本（copy-…）先挡：它是挂用机制的产物，再挂用只会生出「副本的副本」（D5 卡片膨胀），
    // 故回可辨识的拒绝码，而不是混进「不可见」那一句（诚实说原因）。
    if (isAssetLocalCopyId(assetId)) {
      return fail(400, "内部副本不可挂用：请挂用它的来源资产（副本由挂用自动生成）", "asset_copy_internal");
    }
    const mountable = await resolveMountable({ userId: caller.user.id, projectId, assetKind, assetId });
    if (!mountable) {
      return fail(403, "该资产在当前项目不可见（跨项目复用需先显式分享）", "asset_not_visible");
    }
    // copy-on-use：建本地副本（内容本体）+ lineage 指回来源 → 再落幂等挂用记录。
    // 回应必带 localCopyId/localCopyIds：前端要把副本锁进 cardIds，否则画面说「已挂用」但生成仍注入来源。
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
      // 确定性键碰撞（别名）：这是冲突，不是「已挂用」——不得回 success:true 冒充幂等。
      return fail(409, "挂用键冲突：该确定性键已对应另一笔挂用，请勿复用同一资产 id", "asset_mount_conflict");
    }
    if (error instanceof AssetMountCopyConflictError) {
      // 副本键被非副本资产占用：同样是冲突，不得冒充幂等重放（否则等于拿别人的资产当你的副本）。
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
    // 解除＝解挂记录 + 回收这次挂用亲手落地的副本（D1/D5）：
    // 回应必带「该笔挂用实际锁过的全部副本 id」（记录优先，不靠当下推导），
    // 前端据它把副本从 cardIds 解锁——否则「已解除」只是记录没了、生成还在注入副本。
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
