import { findActiveAssetShare } from "./normalize";
import { DEFAULT_ASSET_SCOPE } from "./types";
import type { AssetKind, AssetScope, AssetShareRecord, AssetUseContext, AssetVisibility, ScopedAssetLike } from "./types";

/**
 * **作用域段的唯一裁决**（不含 owner 验证，裁决顺序与本档既有版逐条同序）：
 * - personal（缺省）→ owner（跨项目恒可用）
 * - project-scoped 且属于当前项目 → in-project
 * - team-scoped 且属于当前团队 → in-team（P0-2；ctx.teamId 由 relay 权威值注入）
 * - project-scoped 但有 from→to 有效分享 → shared-in
 * - 其余（含「owner=project 但 projectId 空」与「owner=team 但 teamId 空」两种鬼状态）→ null
 *
 * 为何抽出这一层：伺服器端（resolveAssetVisibility）与**客户端读取闸**
 * （use-canvas-cards 的锁定卡清单；客户端的卡已由按登入用户隔离的
 * `/api/character-cards` 取得，故无 owner 可比）必须是同一把尺——
 * 两处各写一份 scope 分支＝写入端放行、读取端丢卡的「画面说挂用、生成不注入」病灶。
 *
 * **team 段为什么 fail-closed**：team 座标来自 relay（可为 null）与外部载荷——
 * 查不到成员身份（ctx.teamId 缺／空）时 team 资产一律不可见，不降格成「人人可见的 personal」，
 * 也不猜「大概是哪个团队」。与既有 project 鬼状态同一把尺。
 */
export function resolveAssetScopeVisibility(
  asset: { id: string; kind: AssetKind; scope?: AssetScope; projectIds?: string[] },
  ctx: AssetUseContext,
): AssetVisibility | null {
  const scope = asset.scope ?? DEFAULT_ASSET_SCOPE;
  if (scope.owner === "team") {
    const ownedByTeam = scope.teamId ?? "";
    if (!ownedByTeam) return null;
    const viewerTeam = typeof ctx.teamId === "string" ? ctx.teamId.trim() : "";
    if (!viewerTeam) return null;
    return viewerTeam === ownedByTeam ? "in-team" : null;
  }
  if (scope.owner !== "project") return "owner";
  const ownedBy = scope.projectId ?? "";
  if (!ownedBy) return null;
  if (ctx.projectId && ownedBy === ctx.projectId) return "in-project";
  // P1-A 新允许路径（纯加法）：项目标签（多归属）。**插在旧精确匹配之后、share 查表之前**。
  // `ctx.projectId` 为空时**不生效**——标签不得因此把 fail-closed 打开（无项目上下文仍只有 personal 可见）。
  if (ctx.projectId && asset.projectIds?.includes(ctx.projectId)) return "in-project";
  // 画布 id → 创作项目 id 打通（2026-10-09 前置改造）：面板打的标签是**创作项目 id（`prj_…`）**，
  // 而画布生成闸的 `ctx.projectId` 是**画布 id（`canvas-…`）**——两者命名空间不同，上面那条恒不命中。
  // 独立新增一条按 `creativeProjectId` 命中的路径；**保留**上面的画布 id 路径（旧数据/旧标签仍可能用画布 id）。
  // 只按标签数组命中：个人卡与跨项目未打标签的卡不在 `projectIds` 里，故不因此进注入。
  if (ctx.creativeProjectId && asset.projectIds?.includes(ctx.creativeProjectId)) return "in-project";
  return findActiveAssetShare(ctx.shares, asset.kind, asset.id, ownedBy, ctx.projectId) ? "shared-in" : null;
}

/**
 * 可见性判定（唯一入口）。
 * 回 null 的每一条都是**硬边界**，呼叫端不得再放行：
 * - 跨帐号：一律不可见（跨帐号是 RBAC 那一刀，不在本作用域层内）
 * - project-scoped 且非本项目、且没有 from→to 的有效分享 → 不可见
 */
export function resolveAssetVisibility(asset: ScopedAssetLike, ctx: AssetUseContext): AssetVisibility | null {
  if (asset.ownerUserId !== ctx.viewerUserId) return null;
  return resolveAssetScopeVisibility(asset, ctx);
}

/** 可否在当前项目使用该资产（挂用前置检查；不可见 = 不可用）。 */
export function canUseAsset(asset: ScopedAssetLike, ctx: AssetUseContext): boolean {
  return resolveAssetVisibility(asset, ctx) !== null;
}

/**
 * **读取端作用域闸（客户端）**：锁定卡清单里不可见的卡一律剔除（fail-closed）。
 *
 * 为何要这一层：`CanvasProject.cardIds` 是持久化栏位，写入端闸（
 * `/api/canvas/projects` 的 filterCardIdsForProject）管不住**旧资料**与
 * **客户端新增的锁定**（角色卡面板可锁任何一张自己名下的卡）；生成注入读的
 * `activeCharacterCards` 若不过闸，就会出现「卡不属于本项目却被注入」的真泄漏。
 *
 * 客户端没有 owner 可比（卡清单已由按登入用户隔离的 `/api/character-cards` 取得），
 * 故只过 scope 段——**与伺服器端同一把尺**（resolveAssetScopeVisibility），
 * 两端不可能漂移。个人卡（含全部 legacy 卡）缺 scope → 恒可见＝零回归（b 类）。
 */
export function filterLockedCardsForProjectUse<T extends { id: string; scope?: AssetScope; projectIds?: string[] }>(
  cards: readonly T[],
  ctx: { projectId: string | null; creativeProjectId?: string | null; shares: readonly AssetShareRecord[] },
): T[] {
  if (!cards.length) return [];
  const useCtx: AssetUseContext = {
    viewerUserId: 0,
    projectId: ctx.projectId,
    ...(ctx.creativeProjectId ? { creativeProjectId: ctx.creativeProjectId } : {}),
    shares: ctx.shares,
  };
  return cards.filter(
    (card) =>
      resolveAssetScopeVisibility(
        { id: card.id, kind: "card", scope: card.scope, projectIds: card.projectIds },
        useCtx,
      ) !== null,
  );
}

/**
 * 把一次「副本变更」（挂用＝锁定副本 / 解除＝解锁副本）套进项目锁定集（纯函式）。
 * 这是 copy-on-use 生效的最后一哩：`localCopyId` 不进这个集合＝画面标「已挂用」而生成不注入。
 * 规则：先移除 unlocked，再依序补进 locked（去重、保序：既有在前、新锁定在后）。
 */
export function applyCopyLockChange(
  prev: readonly string[],
  change: { locked: readonly string[]; unlocked: readonly string[] },
): string[] {
  const drop = new Set(change.unlocked.map((id) => id.trim()).filter(Boolean));
  const next = prev.filter((id) => !drop.has(id));
  for (const raw of change.locked) {
    const id = raw.trim();
    if (id && !next.includes(id)) next.push(id);
  }
  return next;
}

/**
 * **使用/注入路径的唯一包装**：把一批资产按作用域裁决过一遍，回可用子集。
 * 不可见即不可用——生成注入 / agent 注入 / 锁定卡注入都必须经过这里（或等价的
 * asset-library.isAssetUsable），禁在呼叫端另立规则。
 * 方向可切换：跨项目语义（copy-on-use ↔ 引用＋解链闸）只改 resolveAssetVisibility。
 */
export function filterUsableAssets<T extends ScopedAssetLike>(assets: readonly T[], ctx: AssetUseContext): T[] {
  return assets.filter((asset) => resolveAssetVisibility(asset, ctx) !== null);
}
