// REQ-B2 团队资产空间：作用域层（纯逻辑，无 IO）。
//
// 定位：把**现成**资产包（asset-pack-store）＋资产卡（character-cards）挂到
// project-scoped library —— 本档只加「归属 / 可见性 / 复用」三件事，
// **不另造资产格式**：scope 只是既有记录上的一个可选栏位（见 asset-pack-store
// 与 character-cards 的清洗收口），资产实体仍是原本那两套表示。
//
// 三铁律：
//   1. **不可见即不可用**：任何跨项目使用都先过 resolveAssetVisibility，
//      回 null = 不列进列表、挂用直接拒绝（禁默认全网可见）。
//   2. **跨项目复用需显式分享**：唯一入口是 AssetShareRecord（grant / revoke 显式动作），
//      没有「同帐号自动可见」「同组织自动可见」这类隐含规则。
//   3. **幂等链复用既有件**：mount / share 的 id 与 idempotencyRef 都是**确定性键**
//      （`{action}:{scope}:{target}` 同形，对齐 generation-core 既有 key 惯例，
//      例：master-ingest `film_export:{sessionId}:{fingerprint}`）——
//      重复挂用 / 重复分享只命中同一件，不产生第二笔（计费幂等不双扣的地基）。
//      **键段一律长度前缀单射化**（`{len}:{value}`）：裸 `:` 拼接会让
//      `pack:"x:card:y"` 与 `projectId:"x", card:"y"` 产出同一个键（实测撞键），
//      撞键 = 授权跨资产别名 + 静默成功谎言，故键段必须单射；同时在资产 id 的
//      验证边界（isUsableAssetId）拒绝含保留分隔符的 id。
//   4. **碰撞不得静默成功**：同键但三元组不同 = 真碰撞（别名），一律回
//      conflict（API 层 409），不得当成幂等重放回 `success:true`。
//
// metadata 纪律（裁决，同 D1 lineage 先例）：scope 只给人看（项目资产库面板），
// **不进 canvas 节点 metadata、不进 toNodeMetadata、不进 compactMetadataForAgent**；
// 反之，资产库列表本身也不经双白名单（它不落地成 canvas 节点）。
//
// 已知边界（本刀刻意不吞，写明不装懂）：
//   1. 挂用（AssetMountRecord）＝「收入项目资产库」的成员关系；生成时的卡片注入走
//      既有 `CanvasProject.cardIds` 锁定机制。**两条都查作用域**：注入端走
//      `resolveAssetVisibility`（storyboard-contract 的 scope 选项），锁定端走
//      `/api/canvas/projects` 的 cardIds 闸（都是同一裁决函式的包装）。
//   2. 跨项目挂用语义＝**copy-on-use**（暴君 2026-09-23 裁定）：挂用＝在目标项目建
//      本地副本 + lineage 指向来源（副本**运行时自足**：来源/来源项目日后删除不影响副本；
//      lineage 边**可以**指向别的 project 的来源实体——它只是审计痕迹，不是运行依赖）。
//      本档的 mount 记录仍是「来源→目标」的连接记录，副本身份＝ `localCopyId`
//      （确定性推导），副本本体由 asset-library.mountAssetWithCopy 落地。
//   3. 内部副本（copy-on-use 落地的本地副本）**不是可挂用条目**：不列进资产库候选、
//      挂用闸直接拒（见 isAssetLocalCopyId）——否则「副本的副本」会让卡片无限膨胀（D5）。
//
// **方向可切换**：作用域裁决走单一入口 `resolveAssetVisibility`（包装＝
// `filterUsableAssets` / asset-library 的 `isAssetUsable` / `resolveMountableAsset`）；
// copy-on-use ↔ 引用制的唯一分歧点是 `planAssetMountCopy`。若日后改回「引用＋解链闸」，
// 只需改这两个函式（＋门禁呼叫端），不必动各使用路径。

export { decideAssetShareGrant, findActiveAssetShare, filterByProjectTag, isUsableAssetId, isAssetShareActive, applyAssetShareGrant, applyAssetShareRevoke, assetShareId, normalizeAssetScope, normalizeAssetShare, normalizeProjectIds, projectTagIdsOverLimit, sameAssetScope, teamIdOfScope, toAssetKind } from "./asset-scope/normalize";
export { applyAssetMount, applyAssetUnmount, assetLocalCopyId, assetMountId, assetMountIdempotencyRef, assetPackItemCopyId, assetPackItemSourceKey, assetPackLocalCopyId, isAssetLocalCopyId, mountedAssetKey, mountedAssetKeys, normalizeAssetMount, planAssetMountCopy } from "./asset-scope/paths";
export { applyCopyLockChange, canUseAsset, filterLockedCardsForProjectUse, filterUsableAssets, resolveAssetScopeVisibility, resolveAssetVisibility } from "./asset-scope/permissions";
export { buildProjectAssetLibrary, candidatesFromCards, candidatesFromPacks, matchesAssetQuery, resolveMountableAsset } from "./asset-scope/library";
export { ASSET_KEY_DELIMITER, DEFAULT_ASSET_SCOPE, GHOST_ASSET_SCOPE, GHOST_TEAM_ASSET_SCOPE, MAX_ASSET_ID_LENGTH, MAX_ASSET_PROJECT_TAGS } from "./asset-scope/types";
export type { AssetKind, AssetLibraryCandidate, AssetLibraryItem, AssetLibraryQuery, AssetMountCopyMode, AssetMountCopyPlan, AssetMountCopyRejectReason, AssetMountRecord, AssetOwnership, AssetScope, AssetShareRecord, AssetSource, AssetUseContext, AssetVisibility, ScopedAssetLike, ShareGrantRejectReason } from "./asset-scope/types";
