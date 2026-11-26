import { isAssetLocalCopyId, mountedAssetKey, mountedAssetKeys } from "./paths";
import { resolveAssetVisibility } from "./permissions";
import type { AssetKind, AssetLibraryCandidate, AssetLibraryItem, AssetLibraryQuery, AssetMountRecord, AssetScope, AssetSource, AssetUseContext, AssetVisibility } from "./types";

/**
 * 取包内「代表来源」：第一个带 `source` 的 item 的 source。历史存成的资产包每个 item
 * 都写同一条 `{type:"history", id:<entry.id>}`，取首个即代表包的来源。找不到回 null。
 */
function firstAssetSource(items: readonly { source?: AssetSource }[] | undefined): AssetSource | null {
  for (const item of items ?? []) {
    if (item.source && typeof item.source.id === "string" && item.source.id) return item.source;
  }
  return null;
}

/** 资产包 → 候选项（结构型别，不 import 存储层，避免循环）。 */
export function candidatesFromPacks(
  packs: readonly { id: string; title: string; digest?: string; tags?: string[]; scope?: AssetScope; projectIds?: string[]; updatedAt: string; items?: readonly { source?: AssetSource }[] }[],
  ownerUserId: number,
): AssetLibraryCandidate[] {
  return packs.map((p) => {
    const source = firstAssetSource(p.items);
    return {
      assetKind: "pack" as const,
      assetId: p.id,
      title: p.title,
      tags: Array.isArray(p.tags) ? [...p.tags] : [],
      kindLabel: "资产包",
      ...(p.scope ? { scope: p.scope } : {}),
      ...(p.projectIds?.length ? { projectIds: [...p.projectIds] } : {}),
      ...(source ? { source } : {}),
      ownerUserId,
      updatedAt: p.updatedAt,
    };
  });
}

const CARD_KIND_LABELS: Record<string, string> = { character: "角色", scene: "场景", style: "风格" };

/** 资产卡 → 候选项（标签＝卡名称 + 种类，卡的检索面与包同构）。 */
export function candidatesFromCards(
  cards: readonly { id: string; name: string; kind: string; prompt?: string; scope?: AssetScope; projectIds?: string[]; updatedAt: string }[],
  ownerUserId: number,
): AssetLibraryCandidate[] {
  return cards.map((c) => ({
    assetKind: "card" as const,
    assetId: c.id,
    title: c.name,
    tags: [CARD_KIND_LABELS[c.kind] ?? c.kind],
    kindLabel: CARD_KIND_LABELS[c.kind] ?? "卡",
    ...(c.scope ? { scope: c.scope } : {}),
    ...(c.projectIds?.length ? { projectIds: [...c.projectIds] } : {}),
    ownerUserId,
    updatedAt: c.updatedAt,
  }));
}

/** 检索：标题/标签模糊命中（大小写不敏感；空 query 全收）。 */
export function matchesAssetQuery(item: AssetLibraryCandidate, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (item.title.toLowerCase().includes(q)) return true;
  if (item.tags.some((tag) => tag.toLowerCase().includes(q))) return true;
  return false;
}


/**
 * 项目资产库列表（唯一组装口）：
 * 先过可见性（不可见即不列）→ 再过检索/筛选 → updatedAt 由新到旧。
 * mounted 标记只看当前项目（别的项目的挂用不算）。
 *
 * **内部副本不列**（D5）：copy-on-use 落地的副本是挂用机制的一部分，不是使用者资产；
 * 列出来只会被再挂用一次，在**同一个项目**里生出「副本的副本」→ 卡片额度无限膨胀。
 * 挂用关系的真相在挂用记录（来源键），来源那笔照样标「已挂用」，使用者不会因此看不到状态。
 */
export function buildProjectAssetLibrary(input: {
  candidates: readonly AssetLibraryCandidate[];
  ctx: AssetUseContext;
  mounts: readonly AssetMountRecord[];
  query?: AssetLibraryQuery;
}): AssetLibraryItem[] {
  const { candidates, ctx, mounts } = input;
  const kind = input.query?.kind ?? "all";
  const q = input.query?.q ?? "";
  const mountedOnly = input.query?.mountedOnly === true;
  const keys = mountedAssetKeys(mounts, ctx.projectId ?? "");
  const items: AssetLibraryItem[] = [];
  for (const candidate of candidates) {
    if (isAssetLocalCopyId(candidate.assetId)) continue; // 内部副本不是可挂用条目
    const visibility = resolveAssetVisibility(
      {
        id: candidate.assetId,
        kind: candidate.assetKind,
        scope: candidate.scope,
        projectIds: candidate.projectIds,
        ownerUserId: candidate.ownerUserId,
      },
      ctx,
    );
    if (!visibility) continue; // 不可见即不可用：不列进列表
    if (kind !== "all" && candidate.assetKind !== kind) continue;
    if (!matchesAssetQuery(candidate, q)) continue;
    const mounted = keys.has(mountedAssetKey(candidate.assetKind, candidate.assetId));
    if (mountedOnly && !mounted) continue;
    // P1-A：projectIds 永远存在（没有标签＝[]），前端可直接照它筛选。
    items.push({ ...candidate, projectIds: candidate.projectIds ? [...candidate.projectIds] : [], visibility, mounted });
  }
  return items.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

/**
 * 挂用前置裁决：把候选项按可见性过一遍再决定能不能挂。
 * 回 null = 不可见/不可用（API 层必须回 403，不得静默成功）；
 * **内部副本（copy-…）一律回 null**（D5：副本不可再挂用，见 buildProjectAssetLibrary 的说明）。
 */
export function resolveMountableAsset(
  candidates: readonly AssetLibraryCandidate[],
  ctx: AssetUseContext,
  target: { assetKind: AssetKind; assetId: string },
): { candidate: AssetLibraryCandidate; visibility: AssetVisibility } | null {
  if (isAssetLocalCopyId(target.assetId)) return null;
  const candidate = candidates.find((c) => c.assetKind === target.assetKind && c.assetId === target.assetId);
  if (!candidate) return null;
  const visibility = resolveAssetVisibility(
    {
      id: candidate.assetId,
      kind: candidate.assetKind,
      scope: candidate.scope,
      projectIds: candidate.projectIds,
      ownerUserId: candidate.ownerUserId,
    },
    ctx,
  );
  return visibility ? { candidate, visibility } : null;
}
