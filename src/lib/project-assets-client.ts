// REQ-B2 团队资产空间 API 的前端封装（/api/project-assets 与 /api/project-assets/shares）。
//
// 认证头复用 canvas/client 的 authHeaders，行为模式对齐 character-card-client：
// 不 throw 认证错，回 { ok:false, reason }——资产库面板未登入时安静降级。
import { authHeaders, type CanvasClientResult } from "@/lib/canvas/client";
import { invalidateEntityCardIndex } from "@/components/entities/entity-chip";
import type { AssetKind, AssetLibraryItem, AssetShareRecord } from "@/lib/asset-scope";
import type { AssetPack } from "@/lib/asset-pack-store";
import type { CharacterCard } from "@/lib/character-cards";

async function request<T>(
  path: string,
  init: RequestInit,
  pick: (json: unknown) => T | undefined,
): Promise<CanvasClientResult<T>> {
  const headers = authHeaders();
  if (!headers) return { ok: false, reason: "not_authenticated" };
  if (init.body) headers["Content-Type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(path, { ...init, headers, cache: "no-store" });
  } catch {
    return { ok: false, reason: "network", message: "网络连接失败" };
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return { ok: false, reason: res.ok ? "parse" : "server", message: "服务器回应格式错误" };
  }
  if (!res.ok) {
    const message =
      json && typeof json === "object" && typeof (json as { error?: unknown }).error === "string"
        ? (json as { error: string }).error
        : "请求失败";
    return { ok: false, reason: res.status === 401 || res.status === 403 ? "not_authenticated" : "server", message };
  }
  const data = pick(json);
  if (data === undefined) return { ok: false, reason: "parse", message: "服务器未返回预期数据" };
  return { ok: true, data };
}

export interface ProjectAssetListResult {
  items: AssetLibraryItem[];
  mountedCount: number;
  sharesOut: number;
  /** 授权进来本项目的有效分享（读取闸判「分享进来」用；与写入端同一裁决函式）。 */
  sharesIn: AssetShareRecord[];
}

/** 项目资产库列表（服务端已过可见性；q/kind/mounted 交给服务端过滤）。 */
export function listProjectAssets(input: {
  projectId: string;
  q?: string;
  kind?: AssetKind | "all";
  mountedOnly?: boolean;
}): Promise<CanvasClientResult<ProjectAssetListResult>> {
  const params = new URLSearchParams({ projectId: input.projectId });
  if (input.q?.trim()) params.set("q", input.q.trim());
  if (input.kind && input.kind !== "all") params.set("kind", input.kind);
  if (input.mountedOnly) params.set("mounted", "1");
  return request<ProjectAssetListResult>(
    `/api/project-assets?${params.toString()}`,
    { method: "GET" },
    (json) => {
      const items = (json as { items?: unknown })?.items;
      if (!Array.isArray(items)) return undefined;
      const mountedCount = (json as { mountedCount?: unknown })?.mountedCount;
      const sharesOut = (json as { sharesOut?: unknown })?.sharesOut;
      const sharesIn = (json as { sharesIn?: unknown })?.sharesIn;
      return {
        items: items as AssetLibraryItem[],
        mountedCount: typeof mountedCount === "number" ? mountedCount : 0,
        sharesOut: typeof sharesOut === "number" ? sharesOut : 0,
        sharesIn: Array.isArray(sharesIn) ? (sharesIn as AssetShareRecord[]) : [],
      };
    },
  );
}

/**
 * 只读本项目的授权进来的分享（读取端作用域闸用）。
 * 走同一支 GET（服务端已算好 sharesIn），不另开端点——两支查询结果不可能漂移。
 */
export async function listProjectSharesIn(projectId: string): Promise<CanvasClientResult<AssetShareRecord[]>> {
  const res = await listProjectAssets({ projectId });
  if (!res.ok || !res.data) return { ok: false, reason: res.reason, message: res.message };
  return { ok: true, data: res.data.sharesIn };
}

/** 挂用结果：localCopyIds 是**可锁进 cardIds 的副本 id**（画面标「已挂用」与生成注入必须是同一批）。 */
export interface ProjectAssetMountResult {
  created: boolean;
  copied: boolean;
  localCopyId: string;
  localCopyIds: string[];
  skippedItems: number;
}

/** 挂用一个资产到项目（copy-on-use：建本地副本；同键幂等，重放零副作用）。 */
export function mountProjectAsset(input: {
  projectId: string;
  assetKind: AssetKind;
  assetId: string;
}): Promise<CanvasClientResult<ProjectAssetMountResult>> {
  return request<ProjectAssetMountResult>(
    "/api/project-assets",
    { method: "POST", body: JSON.stringify(input) },
    (json) => {
      const localCopyId = (json as { localCopyId?: unknown })?.localCopyId;
      if (typeof localCopyId !== "string" || !localCopyId) return undefined;
      const localCopyIds = (json as { localCopyIds?: unknown })?.localCopyIds;
      const skippedItems = (json as { skippedItems?: unknown })?.skippedItems;
      return {
        created: (json as { created?: unknown })?.created === true,
        copied: (json as { copied?: unknown })?.copied === true,
        localCopyId,
        localCopyIds: Array.isArray(localCopyIds)
          ? localCopyIds.filter((id): id is string => typeof id === "string")
          : [localCopyId],
        skippedItems: typeof skippedItems === "number" ? skippedItems : 0,
      };
    },
  );
}

/** 解除挂用（回该记录的副本 id：前端据它把副本从 cardIds 解锁）。 */
export function unmountProjectAsset(input: {
  projectId: string;
  assetKind: AssetKind;
  assetId: string;
}): Promise<CanvasClientResult<{ removed: boolean; localCopyId: string | null; localCopyIds: string[] }>> {
  return request<{ removed: boolean; localCopyId: string | null; localCopyIds: string[] }>(
    "/api/project-assets",
    { method: "DELETE", body: JSON.stringify(input) },
    (json) => {
      const localCopyId = (json as { localCopyId?: unknown })?.localCopyId;
      const localCopyIds = (json as { localCopyIds?: unknown })?.localCopyIds;
      return {
        removed: (json as { removed?: unknown })?.removed === true,
        localCopyId: typeof localCopyId === "string" && localCopyId ? localCopyId : null,
        localCopyIds: Array.isArray(localCopyIds)
          ? localCopyIds.filter((id): id is string => typeof id === "string")
          : [],
      };
    },
  );
}

/** 显式分享：把 fromProjectId 名下的资产授权给 toProjectId（幂等）。 */
export function shareProjectAsset(input: {
  assetKind: AssetKind;
  assetId: string;
  fromProjectId: string;
  toProjectId: string;
}): Promise<CanvasClientResult<{ created: boolean }>> {
  return request<{ created: boolean }>(
    "/api/project-assets/shares",
    { method: "POST", body: JSON.stringify(input) },
    (json) => ({ created: (json as { created?: unknown })?.created === true }),
  );
}

/** 撤销分享。 */
export function revokeProjectAssetShare(shareId: string): Promise<CanvasClientResult<{ revoked: boolean }>> {
  return request<{ revoked: boolean }>(
    "/api/project-assets/shares",
    { method: "DELETE", body: JSON.stringify({ id: shareId }) },
    (json) => ({ revoked: (json as { revoked?: unknown })?.revoked === true }),
  );
}

/**
 * 设定资产归属：projectId 有值 → 归属该项目；null → 收回个人。
 * 走**既有**写入端点（包：PUT /api/assets 整包覆盖；卡：POST /api/character-cards upsert by id），
 * 不另开端点、不改资产格式（归属只是记录上的一个可选栏位）。
 */
export async function assignAssetScope(input: {
  assetKind: AssetKind;
  assetId: string;
  projectId: string | null;
}): Promise<CanvasClientResult<true>> {
  const scope = input.projectId ? { owner: "project" as const, projectId: input.projectId } : { owner: "personal" as const };
  if (input.assetKind === "pack") {
    const listed = await request<AssetPack[]>("/api/assets", { method: "GET" }, (json) => {
      const packs = (json as { packs?: unknown })?.packs;
      return Array.isArray(packs) ? (packs as AssetPack[]) : undefined;
    });
    if (!listed.ok) return { ok: false, reason: listed.reason, message: listed.message };
    const pack = (listed.data ?? []).find((p) => p.id === input.assetId);
    if (!pack) return { ok: false, reason: "server", message: "资产包不存在" };
    return request<true>(
      "/api/assets",
      { method: "PUT", body: JSON.stringify({ ...pack, scope }) },
      (json) => ((json as { success?: unknown })?.success === true ? true : undefined),
    );
  }
  const listed = await request<CharacterCard[]>("/api/character-cards", { method: "GET" }, (json) => {
    const cards = (json as { cards?: unknown })?.cards;
    return Array.isArray(cards) ? (cards as CharacterCard[]) : undefined;
  });
  if (!listed.ok) return { ok: false, reason: listed.reason, message: listed.message };
  const card = (listed.data ?? []).find((c) => c.id === input.assetId);
  if (!card) return { ok: false, reason: "server", message: "资产卡不存在" };
  const saved = await request<true>(
    "/api/character-cards",
    { method: "POST", body: JSON.stringify({ ...card, scope }) },
    (json) => ((json as { success?: unknown })?.success === true ? true : undefined),
  );
  // 这支改的是卡的 scope（卡库内容变了），但不经 character-card-client，故不会自动发号；
  // 成功才发（失败分支已由上面的 listed 检查与这里的 !ok 提早返回）。
  if (saved.ok) invalidateEntityCardIndex();
  return saved;
}

/**
 * 设定资产的项目标签（projectIds 整包覆盖）。
 *
 * 与 assignAssetScope 逐行同款：走**既有**写入端点（包：PUT /api/assets 整包覆盖；
 * 卡：POST /api/character-cards upsert by id），不另开端点、不改资产格式
 * （项目标签只是记录上的一个可选栏位）。读改写：先取回该资产当前记录，
 * **只替换 projectIds 键**，其余栏位原样回写——绝不夹带第二处改动。
 */
export async function assignAssetProjectTags(input: {
  assetKind: AssetKind;
  assetId: string;
  projectIds: string[];
}): Promise<CanvasClientResult<{ projectIds: string[] }>> {
  if (input.assetKind === "pack") {
    const listed = await request<AssetPack[]>("/api/assets", { method: "GET" }, (json) => {
      const packs = (json as { packs?: unknown })?.packs;
      return Array.isArray(packs) ? (packs as AssetPack[]) : undefined;
    });
    if (!listed.ok) return { ok: false, reason: listed.reason, message: listed.message };
    const pack = (listed.data ?? []).find((p) => p.id === input.assetId);
    if (!pack) return { ok: false, reason: "server", message: "资产包不存在" };
    const saved = await request<true>(
      "/api/assets",
      { method: "PUT", body: JSON.stringify({ ...pack, projectIds: input.projectIds }) },
      (json) => ((json as { success?: unknown })?.success === true ? true : undefined),
    );
    if (!saved.ok) return { ok: false, reason: saved.reason, message: saved.message };
    return { ok: true, data: { projectIds: input.projectIds } };
  }
  const listed = await request<CharacterCard[]>("/api/character-cards", { method: "GET" }, (json) => {
    const cards = (json as { cards?: unknown })?.cards;
    return Array.isArray(cards) ? (cards as CharacterCard[]) : undefined;
  });
  if (!listed.ok) return { ok: false, reason: listed.reason, message: listed.message };
  const card = (listed.data ?? []).find((c) => c.id === input.assetId);
  if (!card) return { ok: false, reason: "server", message: "资产卡不存在" };
  const saved = await request<true>(
    "/api/character-cards",
    { method: "POST", body: JSON.stringify({ ...card, projectIds: input.projectIds }) },
    (json) => ((json as { success?: unknown })?.success === true ? true : undefined),
  );
  if (!saved.ok) return { ok: false, reason: saved.reason, message: saved.message };
  // 同 assignAssetScope：改的是卡的栏位（卡库内容变了），不经 character-card-client，成功才发号。
  invalidateEntityCardIndex();
  return { ok: true, data: { projectIds: input.projectIds } };
}
