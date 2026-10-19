// REQ-B2 团队资产空间：作用域层具名测试。
//
// 覆盖验收四条：①作用域隔离（项目 A 不可见项目 B 资产）②显式分享后可用
// ③跨项目复用幂等不双扣 ④双白名单回归（构造漏补必红）。
// 纯函式层，不碰网络/Blob。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { toNodeMetadata } from "./canvas/layout";
import { compactMetadataForAgent } from "../hooks/canvas/canvas-chat-types";
import type { CanvasNodeMetadata } from "./canvas/types";
import {
  applyAssetMount,
  applyAssetShareGrant,
  applyAssetShareRevoke,
  assetLocalCopyId,
  assetMountId,
  assetMountIdempotencyRef,
  assetPackItemCopyId,
  assetPackLocalCopyId,
  assetShareId,
  buildProjectAssetLibrary,
  candidatesFromCards,
  candidatesFromPacks,
  canUseAsset,
  decideAssetShareGrant,
  filterUsableAssets,
  findActiveAssetShare,
  isAssetLocalCopyId,
  isAssetShareActive,
  isUsableAssetId,
  matchesAssetQuery,
  mountedAssetKey,
  mountedAssetKeys,
  normalizeAssetMount,
  normalizeAssetScope,
  normalizeAssetShare,
  resolveAssetVisibility,
  resolveMountableAsset,
  toAssetKind,
} from "./asset-scope";
import type {
  AssetLibraryCandidate,
  AssetMountRecord,
  AssetShareRecord,
  AssetUseContext,
  ScopedAssetLike,
} from "./asset-scope";

const AT = "2026-09-22T00:00:00.000Z";

function packCandidate(id: string, scope?: { owner: "personal" | "project"; projectId?: string }, overrides: Partial<AssetLibraryCandidate> = {}): AssetLibraryCandidate {
  return {
    assetKind: "pack",
    assetId: id,
    title: `包-${id}`,
    tags: ["昆鹏风格"],
    kindLabel: "资产包",
    ...(scope ? { scope } : {}),
    ownerUserId: 42,
    updatedAt: AT,
    ...overrides,
  };
}

function ctx(projectId: string | null, shares: AssetShareRecord[] = [], viewerUserId = 42): AssetUseContext {
  return { viewerUserId, projectId, shares };
}

function share(assetId: string, from: string, to: string, revokedAt?: string): AssetShareRecord {
  const record = normalizeAssetShare({
    assetKind: "pack",
    assetId,
    fromProjectId: from,
    toProjectId: to,
    createdAt: AT,
    ...(revokedAt ? { revokedAt } : {}),
  });
  assert.ok(record);
  return record;
}

// ─────────────────────────────────────────── ① 作用域隔离

test("作用域隔离：项目 A 的资产库看不到归属项目 B 的资产（无显式分享）", () => {
  const candidates = [
    packCandidate("pack-personal"), // 个人资产：本帐号所有项目可用
    packCandidate("pack-in-a", { owner: "project", projectId: "proj-a" }),
    packCandidate("pack-in-b", { owner: "project", projectId: "proj-b" }),
  ];
  const itemsA = buildProjectAssetLibrary({ candidates, ctx: ctx("proj-a"), mounts: [] });
  assert.deepEqual(itemsA.map((i) => i.assetId).sort(), ["pack-in-a", "pack-personal"]);
  assert.equal(itemsA.find((i) => i.assetId === "pack-in-a")?.visibility, "in-project");
  assert.equal(itemsA.find((i) => i.assetId === "pack-personal")?.visibility, "owner");

  // 反向：B 也看不到 A 的项目资产（隔离对称）。
  const itemsB = buildProjectAssetLibrary({ candidates, ctx: ctx("proj-b"), mounts: [] });
  assert.deepEqual(itemsB.map((i) => i.assetId).sort(), ["pack-in-b", "pack-personal"]);
});

test("作用域隔离：跨帐号一律不可见（禁默认全网可见）", () => {
  const asset: ScopedAssetLike = { id: "pack-x", kind: "pack", ownerUserId: 7 };
  assert.equal(resolveAssetVisibility(asset, ctx("proj-a", [], 42)), null);
  assert.equal(canUseAsset(asset, ctx("proj-a", [], 42)), false);
  // 连「个人资产」也不例外：ownerUserId 不匹配就出局（fail-closed）。
  assert.equal(resolveAssetVisibility({ ...asset, scope: { owner: "personal" } }, ctx("proj-a", [], 42)), null);
});

test("作用域隔离：无项目上下文（projectId=null）时项目资产不可见，个人资产仍可见", () => {
  const candidates = [
    packCandidate("pack-personal"),
    packCandidate("pack-in-a", { owner: "project", projectId: "proj-a" }),
  ];
  const items = buildProjectAssetLibrary({ candidates, ctx: ctx(null), mounts: [] });
  assert.deepEqual(items.map((i) => i.assetId), ["pack-personal"]);
});

test("作用域隔离：挂用前置裁决对不可见资产回 null（不可见即不可用）", () => {
  const candidates = [packCandidate("pack-in-b", { owner: "project", projectId: "proj-b" })];
  assert.equal(resolveMountableAsset(candidates, ctx("proj-a"), { assetKind: "pack", assetId: "pack-in-b" }), null);
  // 不存在的资产同样 null（不是「默认放行」）。
  assert.equal(resolveMountableAsset(candidates, ctx("proj-a"), { assetKind: "card", assetId: "card-x" }), null);
});

// ─────────────────────────────────────────── ② 显式分享

test("显式分享后可用：B→A 授权生效，撤销后立即失效", () => {
  const candidates = [packCandidate("pack-in-b", { owner: "project", projectId: "proj-b" })];
  const grant = share("pack-in-b", "proj-b", "proj-a");

  const shared = buildProjectAssetLibrary({ candidates, ctx: ctx("proj-a", [grant]), mounts: [] });
  assert.equal(shared.length, 1);
  assert.equal(shared[0].visibility, "shared-in");
  assert.ok(resolveMountableAsset(candidates, ctx("proj-a", [grant]), { assetKind: "pack", assetId: "pack-in-b" }));

  // 撤销后：回到不可见（记录留痕，但不再授权）。
  const revoked = applyAssetShareRevoke([grant], grant.id, "2026-09-22T01:00:00.000Z");
  assert.equal(revoked.revoked, true);
  assert.equal(isAssetShareActive(revoked.shares[0]), false);
  assert.equal(buildProjectAssetLibrary({ candidates, ctx: ctx("proj-a", revoked.shares), mounts: [] }).length, 0);
});

test("显式分享：授权只对指定目标项目生效（不是全网开放）", () => {
  const asset: ScopedAssetLike = { id: "pack-in-b", kind: "pack", scope: { owner: "project", projectId: "proj-b" }, ownerUserId: 42 };
  const grant = share("pack-in-b", "proj-b", "proj-a");
  assert.equal(resolveAssetVisibility(asset, ctx("proj-a", [grant])), "shared-in");
  assert.equal(resolveAssetVisibility(asset, ctx("proj-c", [grant])), null);
  assert.equal(findActiveAssetShare([grant], "pack", "pack-in-b", "proj-b", "proj-c"), null);
});

test("显式分享裁决：非项目资产 / 来源不符 / 同项目 / 目标缺失都被拒", () => {
  const personal: ScopedAssetLike = { id: "pack-p", kind: "pack", ownerUserId: 42 };
  assert.deepEqual(
    decideAssetShareGrant({ viewerUserId: 42, asset: personal, fromProjectId: "proj-a", toProjectId: "proj-b" }),
    { ok: false, reason: "not_a_project_asset" },
  );
  const projectAsset: ScopedAssetLike = { id: "pack-a", kind: "pack", scope: { owner: "project", projectId: "proj-a" }, ownerUserId: 42 };
  assert.deepEqual(
    decideAssetShareGrant({ viewerUserId: 42, asset: projectAsset, fromProjectId: "proj-b", toProjectId: "proj-c" }),
    { ok: false, reason: "project_mismatch" },
  );
  assert.deepEqual(
    decideAssetShareGrant({ viewerUserId: 42, asset: projectAsset, fromProjectId: "proj-a", toProjectId: "proj-a" }),
    { ok: false, reason: "same_project" },
  );
  assert.deepEqual(
    decideAssetShareGrant({ viewerUserId: 42, asset: projectAsset, fromProjectId: "proj-a", toProjectId: "  " }),
    { ok: false, reason: "missing_target_project" },
  );
  // 别人的资产：越权（不是「参数问题」）。
  assert.deepEqual(
    decideAssetShareGrant({ viewerUserId: 42, asset: { ...projectAsset, ownerUserId: 7 }, fromProjectId: "proj-a", toProjectId: "proj-b" }),
    { ok: false, reason: "cross_user" },
  );
  assert.deepEqual(
    decideAssetShareGrant({ viewerUserId: 42, asset: projectAsset, fromProjectId: "proj-a", toProjectId: "proj-b" }),
    { ok: true },
  );
});

// ─────────────────────────────────────────── ③ 跨项目复用幂等不双扣

test("跨项目复用幂等不双扣：同键重挂只落一件、幂等键逐位不变", () => {
  const mounts: AssetMountRecord[] = [];
  const first = applyAssetMount(mounts, { projectId: "proj-a", assetKind: "pack", assetId: "pack-in-b", now: AT });
  assert.equal(first.created, true);
  const second = applyAssetMount(first.mounts, { projectId: "proj-a", assetKind: "pack", assetId: "pack-in-b", now: "2026-09-22T09:00:00.000Z" });
  assert.equal(second.created, false);
  assert.equal(second.mounts.length, 1);
  // 幂等键与挂用时间都沿用首件（重挂零副作用）。
  assert.equal(second.mount.idempotencyRef, first.mount.idempotencyRef);
  assert.equal(second.mount.mountedAt, AT);
  assert.equal(assetMountIdempotencyRef("proj-a", "pack", "pack-in-b"), "asset-mount:6:proj-a:pack:9:pack-in-b");
  assert.equal(assetMountId("proj-a", "pack", "pack-in-b"), "mount:6:proj-a:pack:9:pack-in-b");

  // 模拟计费侧语义：以幂等键为键的记帐集合，重挂不新增第二笔。
  const ledger = new Set<string>();
  for (const action of [first, second]) if (action.created) ledger.add(action.mount.idempotencyRef);
  assert.equal(ledger.size, 1);

  // 不同资产 / 不同项目 = 不同键（不是把不同挂用去重掉）。
  const other = applyAssetMount(second.mounts, { projectId: "proj-a", assetKind: "card", assetId: "pack-in-b", now: AT });
  assert.equal(other.created, true);
  assert.notEqual(other.mount.idempotencyRef, first.mount.idempotencyRef);
});

test("跨项目复用：挂用记录带 mounted 标记且项目间互不串台", () => {
  const mounted = applyAssetMount([], { projectId: "proj-a", assetKind: "pack", assetId: "pack-personal", now: AT }).mounts;
  const itemsA = buildProjectAssetLibrary({ candidates: [packCandidate("pack-personal")], ctx: ctx("proj-a"), mounts: mounted });
  assert.equal(itemsA[0].mounted, true);
  const itemsB = buildProjectAssetLibrary({ candidates: [packCandidate("pack-personal")], ctx: ctx("proj-b"), mounts: mounted });
  assert.equal(itemsB[0].mounted, false);
  assert.deepEqual([...mountedAssetKeys(mounted, "proj-b")], []);
});

test("分享幂等：同键重放不新增第二笔；撤销后再授权复活同一件", () => {
  const first = applyAssetShareGrant([], { assetKind: "pack", assetId: "pack-in-b", fromProjectId: "proj-b", toProjectId: "proj-a", now: AT });
  assert.equal(first.created, true);
  const replay = applyAssetShareGrant(first.shares, { assetKind: "pack", assetId: "pack-in-b", fromProjectId: "proj-b", toProjectId: "proj-a", now: "2026-09-22T09:00:00.000Z" });
  assert.equal(replay.created, false);
  assert.equal(replay.shares.length, 1);
  assert.equal(replay.share.createdAt, AT);

  const revoked = applyAssetShareRevoke(replay.shares, first.share.id, "2026-09-22T02:00:00.000Z");
  const revived = applyAssetShareGrant(revoked.shares, { assetKind: "pack", assetId: "pack-in-b", fromProjectId: "proj-b", toProjectId: "proj-a", now: "2026-09-22T03:00:00.000Z" });
  assert.equal(revived.created, false);
  assert.equal(revived.shares.length, 1);
  assert.equal(isAssetShareActive(revived.share), true);
  assert.equal(assetShareId("pack", "pack-in-b", "proj-b", "proj-a"), first.share.id);
});

// ─────────────────────────────────────────── ⑤ B2-1 键单射（碰撞必不相等）

test("B2-1 键单射：pack/card 段互换的两组 id 必不相等（裸 `:` 拼接的撞键已死）", () => {
  // 缺陷原文（对抗性验收实锤）：`assetMountId("p","pack","x:card:y")` 曾等于
  // `assetMountId("p:pack:x","card","y")` → 授权跨资产别名 + 静默成功。
  const a = assetMountId("p", "pack", "x:card:y");
  const b = assetMountId("p:pack:x", "card", "y");
  assert.notEqual(a, b, "挂用键撞键：段互换的两组三元组必须产出不同键");
  assert.notEqual(assetMountIdempotencyRef("p", "pack", "x:card:y"), assetMountIdempotencyRef("p:pack:x", "card", "y"));

  // 分享键同型病灶：assetId 吞掉 `:from->to` 段。
  const s1 = assetShareId("pack", "A:B", "C", "D");
  const s2 = assetShareId("pack", "A", "B:C", "D");
  assert.notEqual(s1, s2, "分享键撞键：assetId 含分隔符时曾与别的 (from) 组合相等");
  assert.notEqual(
    assetShareId("pack", "x", "p", "q"),
    assetShareId("pack", "x", "p:q", ""),
    "空段不得被折叠成同键",
  );

  // 单射性抽样：一组形状相近的三元组两两不相等（键集合大小 = 三元组数）。
  const triples: Array<[string, "pack" | "card", string]> = [
    ["p", "pack", "x:card:y"],
    ["p:pack", "card", "y"],
    ["p", "card", "x:card:y"],
    ["p:pack:x", "pack", "y"],
    ["", "pack", "p:pack:x:card:y"],
  ];
  const ids = new Set(triples.map(([pid, kind, aid]) => assetMountId(pid, kind, aid)));
  assert.equal(ids.size, triples.length, "不同三元组不得共用同一个确定性键");
});

test("B2-1 id 边界：含保留分隔符的资产 id 在验证边界被拒（不靠键端兜底）", () => {
  assert.equal(isUsableAssetId("pack-ok"), true);
  assert.equal(isUsableAssetId("x:card:y"), false, "含 `:` 的 id 一律拒收");
  assert.equal(isUsableAssetId(""), false);
  assert.equal(isUsableAssetId("  "), false);
  assert.equal(isUsableAssetId("a".repeat(201)), false, "超长 id 拒收");
  assert.equal(isUsableAssetId("a".repeat(200)), true);
  assert.equal(isUsableAssetId("a\nb"), false, "控制字元拒收（可伪造键段边界）");
  assert.equal(isUsableAssetId(42), false);

  // 超长 id **拒绝而非截断**：截断会让两个不同 id 落成同一键（另一种别名）。
  const long1 = "a".repeat(200) + "X";
  const long2 = "a".repeat(200) + "Y";
  assert.equal(normalizeAssetMount({ projectId: "p", assetKind: "pack", assetId: long1 }), null);
  assert.equal(normalizeAssetMount({ projectId: "p", assetKind: "pack", assetId: long2 }), null);
  assert.equal(normalizeAssetShare({ assetKind: "pack", assetId: "x:card:y", fromProjectId: "a", toProjectId: "b" }), null);
  assert.equal(normalizeAssetMount({ projectId: "p", assetKind: "pack", assetId: "x:card:y" }), null);
});

test("B2-1 禁静默成功：同键不同三元组回 conflict，不冒充幂等重放", () => {
  // 防御性闸的真实行为：手造一笔「id 属于三元组 T2、栏位属于 T1」的脏记录，
  // 再以 T2 挂用 —— 必须回 conflict，且不得新增第二笔。
  const t2 = { projectId: "proj-a", assetKind: "card" as const, assetId: "card-y" };
  const poisoned: AssetMountRecord = {
    id: assetMountId(t2.projectId, t2.assetKind, t2.assetId),
    projectId: "proj-a",
    assetKind: "pack",
    assetId: "pack-x",
    // REQ-B2b：副本 id 由三元组确定性推导（此笔刻意造脏：栏位属 T1、id 属 T2）。
    localCopyId: assetLocalCopyId("proj-a", "card", "card-y"),
    idempotencyRef: assetMountIdempotencyRef("proj-a", "pack", "pack-x"),
    mountedAt: AT,
  };
  const applied = applyAssetMount([poisoned], { ...t2, now: AT });
  assert.equal(applied.conflict, true, "同键不同三元组必须是冲突");
  assert.equal(applied.created, false, "冲突不得当成新建");
  assert.equal(applied.mounts.length, 1, "冲突不得落第二笔");

  // 正常幂等重放仍必须 conflict:false（不误伤既有幂等语义）。
  const first = applyAssetMount([], { projectId: "proj-a", assetKind: "pack", assetId: "pack-x", now: AT });
  const replay = applyAssetMount(first.mounts, { projectId: "proj-a", assetKind: "pack", assetId: "pack-x", now: AT });
  assert.equal(replay.conflict, false);
  assert.equal(replay.created, false);

  // 分享同款：同键不同三元组回 conflict。
  const shareKey = assetShareId("pack", "pack-x", "proj-a", "proj-b");
  const dirtyShare = { ...normalizeAssetShare({ assetKind: "card", assetId: "card-y", fromProjectId: "proj-a", toProjectId: "proj-b", createdAt: AT })! , id: shareKey };
  const granted = applyAssetShareGrant([dirtyShare], { assetKind: "pack", assetId: "pack-x", fromProjectId: "proj-a", toProjectId: "proj-b", now: AT });
  assert.equal(granted.conflict, true);
  assert.equal(granted.shares.length, 1);
});

test("B2-1 挂用标记键与 id 同一种单射编码（mountedAssetKeys 不另立格式）", () => {
  const mounts = applyAssetMount([], { projectId: "proj-a", assetKind: "pack", assetId: "pack-x", now: AT }).mounts;
  assert.deepEqual([...mountedAssetKeys(mounts, "proj-a")], [mountedAssetKey("pack", "pack-x")]);
  // 键里的 id 段不得是可被别的 (kind, id) 组合重现的裸拼接。
  assert.notEqual(mountedAssetKey("pack", "x:card:y"), mountedAssetKey("card", "y"));
});

// ─────────────────────────────────────────── ⑦ B2-2 使用路径（单一入口包装）

test("B2-2 使用路径：filterUsableAssets 只放行可见资产（跨项目未分享即不可用）", () => {
  const assets: ScopedAssetLike[] = [
    { id: "pack-personal", kind: "pack", ownerUserId: 42 },
    { id: "pack-in-a", kind: "pack", scope: { owner: "project", projectId: "proj-a" }, ownerUserId: 42 },
    { id: "pack-in-b", kind: "pack", scope: { owner: "project", projectId: "proj-b" }, ownerUserId: 42 },
    { id: "pack-other-user", kind: "pack", ownerUserId: 7 },
  ];
  assert.deepEqual(
    filterUsableAssets(assets, ctx("proj-a")).map((a) => a.id),
    ["pack-personal", "pack-in-a"],
  );
  // 无项目上下文：项目资产全不可用，个人资产照用。
  assert.deepEqual(filterUsableAssets(assets, ctx(null)).map((a) => a.id), ["pack-personal"]);
  // 显式分享后才可用（不是「同帐号自动放行」）。
  const grant = share("pack-in-b", "proj-b", "proj-a");
  assert.deepEqual(
    filterUsableAssets(assets, ctx("proj-a", [grant])).map((a) => a.id),
    ["pack-personal", "pack-in-a", "pack-in-b"],
  );
});

// ─────────────────────────────────────────── 检索 / 筛选
test("检索与筛选：标题/标签命中、种类过滤、仅看已挂用", () => {
  const cards = candidatesFromCards(
    [
      { id: "card-1", name: "红发少女", kind: "character", updatedAt: "2026-09-22T02:00:00.000Z" },
      { id: "card-2", name: "雨夜街景", kind: "scene", updatedAt: AT },
    ],
    42,
  );
  const packs = candidatesFromPacks([{ id: "pack-1", title: "赛博朋克配方", tags: ["配方"], updatedAt: AT }], 42);
  const candidates = [...packs, ...cards];
  assert.equal(cards[0].kindLabel, "角色");
  assert.equal(cards[1].tags[0], "场景");
  assert.equal(matchesAssetQuery(packs[0], "赛博"), true);
  assert.equal(matchesAssetQuery(packs[0], "配方"), true);
  assert.equal(matchesAssetQuery(packs[0], "不存在"), false);

  const byKind = buildProjectAssetLibrary({ candidates, ctx: ctx("proj-a"), mounts: [], query: { kind: "card" } });
  assert.deepEqual(byKind.map((i) => i.assetId).sort(), ["card-1", "card-2"]);
  const byQuery = buildProjectAssetLibrary({ candidates, ctx: ctx("proj-a"), mounts: [], query: { q: "红发" } });
  assert.deepEqual(byQuery.map((i) => i.assetId), ["card-1"]);

  const mounts = applyAssetMount([], { projectId: "proj-a", assetKind: "card", assetId: "card-2", now: AT }).mounts;
  const mountedOnly = buildProjectAssetLibrary({ candidates, ctx: ctx("proj-a"), mounts, query: { mountedOnly: true } });
  assert.deepEqual(mountedOnly.map((i) => i.assetId), ["card-2"]);
  // 排序：updatedAt 由新到旧
  assert.deepEqual(
    buildProjectAssetLibrary({ candidates, ctx: ctx("proj-a"), mounts: [] }).map((i) => i.assetId),
    ["card-1", "pack-1", "card-2"],
  );
});

// ─────────────────────────────────────────── 清洗收口

test("清洗收口：作用域非法值收敛为 personal；鬼状态（project 无 projectId）回 null 不降格（D3）", () => {
  assert.deepEqual(normalizeAssetScope(undefined), { owner: "personal" });
  assert.deepEqual(normalizeAssetScope("project"), { owner: "personal" });
  // D3：鬼状态不是 personal（降格＝把归属不明的项目资产变成人人可用的个人资产）。
  assert.equal(normalizeAssetScope({ owner: "project" }), null);
  assert.equal(normalizeAssetScope({ owner: "project", projectId: "  " }), null);
  assert.deepEqual(normalizeAssetScope({ owner: "project", projectId: " proj-a " }), { owner: "project", projectId: "proj-a" });
  assert.equal(toAssetKind("pack"), "pack");
  assert.equal(toAssetKind("card"), "card");
  assert.equal(toAssetKind("asset-pack"), null);
  assert.equal(normalizeAssetShare({ assetKind: "pack", assetId: "", fromProjectId: "a", toProjectId: "b" }), null);
  assert.equal(normalizeAssetMount({ projectId: "", assetKind: "pack", assetId: "x" }), null);
  // id 由三元组重新推导，外部传入的 id 被忽略（确定性键不许被呼叫端改写）。
  const forged = normalizeAssetShare({ assetKind: "pack", assetId: "x", fromProjectId: "a", toProjectId: "b", id: "attacker-chosen" });
  assert.equal(forged?.id, assetShareId("pack", "x", "a", "b"));
});

// ─────────────────────────────────────────── D3 鬼状态不可见（具名回归）

test("D3 鬼状态不可见：{owner:project, projectId:''} 在任何上下文都不可见/不可用（不降格成 personal）", () => {
  // 鬼状态的持久化形状：owner=project 而无 projectId（normalizeAssetScope 回 null 时呼叫端写回的形状）。
  const ghost = { owner: "project" as const };
  const ctxA: AssetUseContext = { viewerUserId: 42, projectId: "proj-a", shares: [] };
  const ctxNone: AssetUseContext = { viewerUserId: 42, projectId: null, shares: [] };
  const card = { id: "card-ghost", kind: "card" as const, scope: ghost, ownerUserId: 42 };

  // 反向对照：同一张卡若是 personal，两边都可见 —— 证明下面的 null 不是恒真。
  assert.equal(resolveAssetVisibility({ ...card, scope: undefined }, ctxA), "owner");
  assert.equal(resolveAssetVisibility({ ...card, scope: undefined }, ctxNone), "owner");

  // 鬼状态：有项目上下文、无项目上下文、甚至「分享给当前项目」都不可见。
  assert.equal(resolveAssetVisibility(card, ctxA), null, "鬼状态不得在有项目上下文可见");
  assert.equal(resolveAssetVisibility(card, ctxNone), null, "鬼状态不得在无项目上下文可见");
  const ghostShare: AssetShareRecord = {
    id: assetShareId("card", "card-ghost", "", "proj-a"),
    assetKind: "card",
    assetId: "card-ghost",
    fromProjectId: "",
    toProjectId: "proj-a",
    createdAt: AT,
  };
  assert.equal(
    resolveAssetVisibility(card, { ...ctxA, shares: [ghostShare] }),
    null,
    "分享授权救不回鬼状态（来源项目根本不存在）",
  );
  assert.equal(canUseAsset(card, ctxA), false);
  // 挂用前的裁决、库列表都不得放行。
  const ghostCandidate = packCandidate("pack-ghost", { owner: "project" });
  assert.equal(resolveMountableAsset([ghostCandidate], ctxA, { assetKind: "pack", assetId: "pack-ghost" }), null);
  assert.deepEqual(buildProjectAssetLibrary({ candidates: [ghostCandidate], ctx: ctxA, mounts: [] }), []);
});

// ─────────────────────────────────────────── D5 内部副本不是可挂用条目（具名回归）

test("D5 内部副本不可再挂用：copy-… 不列进资产库、挂用闸直接拒（判据为家族前缀+固定长度哈希）", () => {
  const copy = assetLocalCopyId("proj-a", "card", "card-src");
  assert.equal(isAssetLocalCopyId(copy), true, "卡副本 id 必须被认出");
  assert.equal(isAssetLocalCopyId(assetPackLocalCopyId("proj-a", "pack-src")), true, "包副本 id 必须被认出");
  assert.equal(isAssetLocalCopyId(assetPackItemCopyId("proj-a", "pack-src", 3)), true, "包内条目副本 id 必须被认出");
  // 反向对照：使用者自有的相似 id 不得被误判（否则会静默屏蔽使用者资产）。
  assert.equal(isAssetLocalCopyId("copy-card-src"), false);
  assert.equal(isAssetLocalCopyId("copy-card-0123456789abcdef0123456789abcde"), false, "长度不符不误判");
  assert.equal(isAssetLocalCopyId("copy-card-0123456789ABCDEF0123456789ABCDEF"), false, "大写不符不误判");
  assert.equal(isAssetLocalCopyId("card-src"), false);
  assert.equal(isAssetLocalCopyId(undefined), false);

  const ctxA: AssetUseContext = { viewerUserId: 42, projectId: "proj-a", shares: [] };
  // 副本在目标项目里是 in-project 可见（否则生成注不进去）——但**不可挂用**。
  const copyCandidate = packCandidate(copy, { owner: "project", projectId: "proj-a" });
  const sourceCandidate = packCandidate("pack-src", { owner: "project", projectId: "proj-a" });
  assert.equal(
    resolveAssetVisibility({ id: copy, kind: "pack", scope: { owner: "project", projectId: "proj-a" }, ownerUserId: 42 }, ctxA),
    "in-project",
    "副本本身在项目内仍可见（可见性 ≠ 可挂用）",
  );
  assert.deepEqual(
    buildProjectAssetLibrary({ candidates: [copyCandidate, sourceCandidate], ctx: ctxA, mounts: [] }).map((i) => i.assetId),
    ["pack-src"],
    "资产库只列来源，不列内部副本（否则会被再挂用成副本的副本）",
  );
  assert.equal(resolveMountableAsset([copyCandidate], ctxA, { assetKind: "pack", assetId: copy }), null);
  assert.ok(resolveMountableAsset([sourceCandidate], ctxA, { assetKind: "pack", assetId: "pack-src" }), "来源照样可挂用");
});

// ─────────────────────────────────────────── ④ 双白名单回归

test("双白名单回归：资产归属只给人看，未进 canvas 节点 metadata（构造漏补必红）", () => {
  // **口径（TG-02）**：本节只做**真实行为断言**——把 leaky metadata 喂进两个白名单函式，
  // 断言两端的**实际输出**都不含 scope。源码字串扫描（`doesNotMatch(/scope/)` 整档）
  // 已移除：那是变更探针（无关语句含 scope 即假红），不计入「已验证」。
  // 判据：断言输出的**完整键集合**——任一端被「顺手」补上栏位即红（不靠源码文字）。
  const leaky = {
    content: "x",
    prompt: "y",
    scope: { owner: "project", projectId: "proj-a" },
  } as unknown as CanvasNodeMetadata;
  const read = toNodeMetadata(leaky) as Record<string, unknown>;
  assert.equal("scope" in read, false, "toNodeMetadata 不得收资产归属（裁决排除）");
  // 键集合逐位断言：漏补端或超收端都红（不只查 scope 一个字）。
  assert.deepEqual(Object.keys(read).sort(), ["content", "prompt"]);
  const compacted = compactMetadataForAgent(leaky) as Record<string, unknown> | undefined;
  assert.ok(compacted);
  assert.equal("scope" in compacted, false, "compactMetadataForAgent 不得传资产归属（裁决排除）");
  assert.deepEqual(Object.keys(compacted).sort(), ["content", "prompt"]);
});

test("双白名单回归：资产包/卡的作用域也不进 agent 主动包注入口", () => {
  // 资产归属是「人看的归属标记」，不是 agent 注入内容：
  // buildAssetPackInjection 的栏位清单不得出现 scope（漏一排 = agent 读到不该读的归属）。
  const source = readFileSync("src/lib/agent-assets.ts", "utf8");
  const injectionBlock = source.slice(source.indexOf("buildAssetPackInjection"));
  assert.ok(injectionBlock.length > 0);
  assert.doesNotMatch(injectionBlock, /scope/);
});
