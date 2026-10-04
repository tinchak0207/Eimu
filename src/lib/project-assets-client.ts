// REQ-B2 團隊資產空間 API 的前端封裝（/api/project-assets 與 /api/project-assets/shares）。
//
// 認證頭復用 canvas/client 的 authHeaders，行為模式對齊 character-card-client：
// 不 throw 認證錯，回 { ok:false, reason }——資產庫面板未登入時安靜降級。
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
  /** 授權進來本項目的有效分享（讀取閘判「分享進來」用；與寫入端同一裁決函式）。 */
  sharesIn: AssetShareRecord[];
}

/** 項目資產庫列表（服務端已過可見性；q/kind/mounted 交給服務端過濾）。 */
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
 * 只讀本項目的授權進來的分享（讀取端作用域閘用）。
 * 走同一支 GET（服務端已算好 sharesIn），不另開端點——兩支查詢結果不可能漂移。
 */
export async function listProjectSharesIn(projectId: string): Promise<CanvasClientResult<AssetShareRecord[]>> {
  const res = await listProjectAssets({ projectId });
  if (!res.ok || !res.data) return { ok: false, reason: res.reason, message: res.message };
  return { ok: true, data: res.data.sharesIn };
}

/** 掛用結果：localCopyIds 是**可鎖進 cardIds 的副本 id**（畫面標「已掛用」與生成注入必須是同一批）。 */
export interface ProjectAssetMountResult {
  created: boolean;
  copied: boolean;
  localCopyId: string;
  localCopyIds: string[];
  skippedItems: number;
}

/** 掛用一個資產到項目（copy-on-use：建本地副本；同鍵冪等，重放零副作用）。 */
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

/** 解除掛用（回該記錄的副本 id：前端據它把副本從 cardIds 解鎖）。 */
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

/** 顯式分享：把 fromProjectId 名下的資產授權給 toProjectId（冪等）。 */
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

/** 撤銷分享。 */
export function revokeProjectAssetShare(shareId: string): Promise<CanvasClientResult<{ revoked: boolean }>> {
  return request<{ revoked: boolean }>(
    "/api/project-assets/shares",
    { method: "DELETE", body: JSON.stringify({ id: shareId }) },
    (json) => ({ revoked: (json as { revoked?: unknown })?.revoked === true }),
  );
}

/**
 * 設定資產歸屬：projectId 有值 → 歸屬該項目；null → 收回個人。
 * 走**既有**寫入端點（包：PUT /api/assets 整包覆蓋；卡：POST /api/character-cards upsert by id），
 * 不另開端點、不改資產格式（歸屬只是記錄上的一個可選欄位）。
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
  // 這支改的是卡的 scope（卡庫內容變了），但不經 character-card-client，故不會自動發號；
  // 成功才發（失敗分支已由上面的 listed 檢查與這裡的 !ok 提早返回）。
  if (saved.ok) invalidateEntityCardIndex();
  return saved;
}
