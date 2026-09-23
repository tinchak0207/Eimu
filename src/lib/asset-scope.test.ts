// REQ-B2 團隊資產空間：作用域層具名測試。
//
// 覆蓋驗收四條：①作用域隔離（項目 A 不可見項目 B 資產）②顯式分享後可用
// ③跨項目復用幂等不雙扣 ④雙白名單回歸（構造漏補必紅）。
// 純函式層，不碰網絡/Blob。
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

// ─────────────────────────────────────────── ① 作用域隔離

test("作用域隔离：項目 A 的資產庫看不到歸屬項目 B 的資產（無顯式分享）", () => {
  const candidates = [
    packCandidate("pack-personal"), // 個人資產：本帳號所有項目可用
    packCandidate("pack-in-a", { owner: "project", projectId: "proj-a" }),
    packCandidate("pack-in-b", { owner: "project", projectId: "proj-b" }),
  ];
  const itemsA = buildProjectAssetLibrary({ candidates, ctx: ctx("proj-a"), mounts: [] });
  assert.deepEqual(itemsA.map((i) => i.assetId).sort(), ["pack-in-a", "pack-personal"]);
  assert.equal(itemsA.find((i) => i.assetId === "pack-in-a")?.visibility, "in-project");
  assert.equal(itemsA.find((i) => i.assetId === "pack-personal")?.visibility, "owner");

  // 反向：B 也看不到 A 的項目資產（隔離對稱）。
  const itemsB = buildProjectAssetLibrary({ candidates, ctx: ctx("proj-b"), mounts: [] });
  assert.deepEqual(itemsB.map((i) => i.assetId).sort(), ["pack-in-b", "pack-personal"]);
});

test("作用域隔离：跨帳號一律不可見（禁默認全網可見）", () => {
  const asset: ScopedAssetLike = { id: "pack-x", kind: "pack", ownerUserId: 7 };
  assert.equal(resolveAssetVisibility(asset, ctx("proj-a", [], 42)), null);
  assert.equal(canUseAsset(asset, ctx("proj-a", [], 42)), false);
  // 連「個人資產」也不例外：ownerUserId 不匹配就出局（fail-closed）。
  assert.equal(resolveAssetVisibility({ ...asset, scope: { owner: "personal" } }, ctx("proj-a", [], 42)), null);
});

test("作用域隔离：無項目上下文（projectId=null）時項目資產不可見，個人資產仍可見", () => {
  const candidates = [
    packCandidate("pack-personal"),
    packCandidate("pack-in-a", { owner: "project", projectId: "proj-a" }),
  ];
  const items = buildProjectAssetLibrary({ candidates, ctx: ctx(null), mounts: [] });
  assert.deepEqual(items.map((i) => i.assetId), ["pack-personal"]);
});

test("作用域隔离：掛用前置裁決對不可見資產回 null（不可見即不可用）", () => {
  const candidates = [packCandidate("pack-in-b", { owner: "project", projectId: "proj-b" })];
  assert.equal(resolveMountableAsset(candidates, ctx("proj-a"), { assetKind: "pack", assetId: "pack-in-b" }), null);
  // 不存在的資產同樣 null（不是「默認放行」）。
  assert.equal(resolveMountableAsset(candidates, ctx("proj-a"), { assetKind: "card", assetId: "card-x" }), null);
});

// ─────────────────────────────────────────── ② 顯式分享

test("顯式分享後可用：B→A 授權生效，撤銷後立即失效", () => {
  const candidates = [packCandidate("pack-in-b", { owner: "project", projectId: "proj-b" })];
  const grant = share("pack-in-b", "proj-b", "proj-a");

  const shared = buildProjectAssetLibrary({ candidates, ctx: ctx("proj-a", [grant]), mounts: [] });
  assert.equal(shared.length, 1);
  assert.equal(shared[0].visibility, "shared-in");
  assert.ok(resolveMountableAsset(candidates, ctx("proj-a", [grant]), { assetKind: "pack", assetId: "pack-in-b" }));

  // 撤銷後：回到不可見（記錄留痕，但不再授權）。
  const revoked = applyAssetShareRevoke([grant], grant.id, "2026-09-22T01:00:00.000Z");
  assert.equal(revoked.revoked, true);
  assert.equal(isAssetShareActive(revoked.shares[0]), false);
  assert.equal(buildProjectAssetLibrary({ candidates, ctx: ctx("proj-a", revoked.shares), mounts: [] }).length, 0);
});

test("顯式分享：授權只對指定目標項目生效（不是全網開放）", () => {
  const asset: ScopedAssetLike = { id: "pack-in-b", kind: "pack", scope: { owner: "project", projectId: "proj-b" }, ownerUserId: 42 };
  const grant = share("pack-in-b", "proj-b", "proj-a");
  assert.equal(resolveAssetVisibility(asset, ctx("proj-a", [grant])), "shared-in");
  assert.equal(resolveAssetVisibility(asset, ctx("proj-c", [grant])), null);
  assert.equal(findActiveAssetShare([grant], "pack", "pack-in-b", "proj-b", "proj-c"), null);
});

test("顯式分享裁決：非項目資產 / 來源不符 / 同項目 / 目標缺失都被拒", () => {
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
  // 別人的資產：越權（不是「參數問題」）。
  assert.deepEqual(
    decideAssetShareGrant({ viewerUserId: 42, asset: { ...projectAsset, ownerUserId: 7 }, fromProjectId: "proj-a", toProjectId: "proj-b" }),
    { ok: false, reason: "cross_user" },
  );
  assert.deepEqual(
    decideAssetShareGrant({ viewerUserId: 42, asset: projectAsset, fromProjectId: "proj-a", toProjectId: "proj-b" }),
    { ok: true },
  );
});

// ─────────────────────────────────────────── ③ 跨項目復用幂等不雙扣

test("跨項目復用幂等不雙扣：同鍵重掛只落一件、冪等鍵逐位不變", () => {
  const mounts: AssetMountRecord[] = [];
  const first = applyAssetMount(mounts, { projectId: "proj-a", assetKind: "pack", assetId: "pack-in-b", now: AT });
  assert.equal(first.created, true);
  const second = applyAssetMount(first.mounts, { projectId: "proj-a", assetKind: "pack", assetId: "pack-in-b", now: "2026-09-22T09:00:00.000Z" });
  assert.equal(second.created, false);
  assert.equal(second.mounts.length, 1);
  // 冪等鍵與掛用時間都沿用首件（重掛零副作用）。
  assert.equal(second.mount.idempotencyRef, first.mount.idempotencyRef);
  assert.equal(second.mount.mountedAt, AT);
  assert.equal(assetMountIdempotencyRef("proj-a", "pack", "pack-in-b"), "asset-mount:6:proj-a:pack:9:pack-in-b");
  assert.equal(assetMountId("proj-a", "pack", "pack-in-b"), "mount:6:proj-a:pack:9:pack-in-b");

  // 模擬計費側語義：以冪等鍵為鍵的記帳集合，重掛不新增第二筆。
  const ledger = new Set<string>();
  for (const action of [first, second]) if (action.created) ledger.add(action.mount.idempotencyRef);
  assert.equal(ledger.size, 1);

  // 不同資產 / 不同項目 = 不同鍵（不是把不同掛用去重掉）。
  const other = applyAssetMount(second.mounts, { projectId: "proj-a", assetKind: "card", assetId: "pack-in-b", now: AT });
  assert.equal(other.created, true);
  assert.notEqual(other.mount.idempotencyRef, first.mount.idempotencyRef);
});

test("跨項目復用：掛用記錄帶 mounted 標記且項目間互不串台", () => {
  const mounted = applyAssetMount([], { projectId: "proj-a", assetKind: "pack", assetId: "pack-personal", now: AT }).mounts;
  const itemsA = buildProjectAssetLibrary({ candidates: [packCandidate("pack-personal")], ctx: ctx("proj-a"), mounts: mounted });
  assert.equal(itemsA[0].mounted, true);
  const itemsB = buildProjectAssetLibrary({ candidates: [packCandidate("pack-personal")], ctx: ctx("proj-b"), mounts: mounted });
  assert.equal(itemsB[0].mounted, false);
  assert.deepEqual([...mountedAssetKeys(mounted, "proj-b")], []);
});

test("分享幂等：同鍵重放不新增第二筆；撤銷後再授權復活同一件", () => {
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

// ─────────────────────────────────────────── ⑤ B2-1 鍵單射（碰撞必不相等）

test("B2-1 鍵單射：pack/card 段互換的兩組 id 必不相等（裸 `:` 拼接的撞鍵已死）", () => {
  // 缺陷原文（對抗性驗收實錘）：`assetMountId("p","pack","x:card:y")` 曾等於
  // `assetMountId("p:pack:x","card","y")` → 授權跨資產別名 + 靜默成功。
  const a = assetMountId("p", "pack", "x:card:y");
  const b = assetMountId("p:pack:x", "card", "y");
  assert.notEqual(a, b, "掛用鍵撞鍵：段互換的兩組三元組必須產出不同鍵");
  assert.notEqual(assetMountIdempotencyRef("p", "pack", "x:card:y"), assetMountIdempotencyRef("p:pack:x", "card", "y"));

  // 分享鍵同型病灶：assetId 吞掉 `:from->to` 段。
  const s1 = assetShareId("pack", "A:B", "C", "D");
  const s2 = assetShareId("pack", "A", "B:C", "D");
  assert.notEqual(s1, s2, "分享鍵撞鍵：assetId 含分隔符時曾與別的 (from) 組合相等");
  assert.notEqual(
    assetShareId("pack", "x", "p", "q"),
    assetShareId("pack", "x", "p:q", ""),
    "空段不得被折疊成同鍵",
  );

  // 單射性抽樣：一組形狀相近的三元組兩兩不相等（鍵集合大小 = 三元組數）。
  const triples: Array<[string, "pack" | "card", string]> = [
    ["p", "pack", "x:card:y"],
    ["p:pack", "card", "y"],
    ["p", "card", "x:card:y"],
    ["p:pack:x", "pack", "y"],
    ["", "pack", "p:pack:x:card:y"],
  ];
  const ids = new Set(triples.map(([pid, kind, aid]) => assetMountId(pid, kind, aid)));
  assert.equal(ids.size, triples.length, "不同三元組不得共用同一個確定性鍵");
});

test("B2-1 id 邊界：含保留分隔符的資產 id 在驗證邊界被拒（不靠鍵端兜底）", () => {
  assert.equal(isUsableAssetId("pack-ok"), true);
  assert.equal(isUsableAssetId("x:card:y"), false, "含 `:` 的 id 一律拒收");
  assert.equal(isUsableAssetId(""), false);
  assert.equal(isUsableAssetId("  "), false);
  assert.equal(isUsableAssetId("a".repeat(201)), false, "超長 id 拒收");
  assert.equal(isUsableAssetId("a".repeat(200)), true);
  assert.equal(isUsableAssetId("a\nb"), false, "控制字元拒收（可偽造鍵段邊界）");
  assert.equal(isUsableAssetId(42), false);

  // 超長 id **拒絕而非截斷**：截斷會讓兩個不同 id 落成同一鍵（另一種別名）。
  const long1 = "a".repeat(200) + "X";
  const long2 = "a".repeat(200) + "Y";
  assert.equal(normalizeAssetMount({ projectId: "p", assetKind: "pack", assetId: long1 }), null);
  assert.equal(normalizeAssetMount({ projectId: "p", assetKind: "pack", assetId: long2 }), null);
  assert.equal(normalizeAssetShare({ assetKind: "pack", assetId: "x:card:y", fromProjectId: "a", toProjectId: "b" }), null);
  assert.equal(normalizeAssetMount({ projectId: "p", assetKind: "pack", assetId: "x:card:y" }), null);
});

test("B2-1 禁靜默成功：同鍵不同三元組回 conflict，不冒充冪等重放", () => {
  // 防禦性閘的真實行為：手造一筆「id 屬於三元組 T2、欄位屬於 T1」的髒記錄，
  // 再以 T2 掛用 —— 必須回 conflict，且不得新增第二筆。
  const t2 = { projectId: "proj-a", assetKind: "card" as const, assetId: "card-y" };
  const poisoned: AssetMountRecord = {
    id: assetMountId(t2.projectId, t2.assetKind, t2.assetId),
    projectId: "proj-a",
    assetKind: "pack",
    assetId: "pack-x",
    // REQ-B2b：副本 id 由三元組確定性推導（此筆刻意造髒：欄位屬 T1、id 屬 T2）。
    localCopyId: assetLocalCopyId("proj-a", "card", "card-y"),
    idempotencyRef: assetMountIdempotencyRef("proj-a", "pack", "pack-x"),
    mountedAt: AT,
  };
  const applied = applyAssetMount([poisoned], { ...t2, now: AT });
  assert.equal(applied.conflict, true, "同鍵不同三元組必須是衝突");
  assert.equal(applied.created, false, "衝突不得當成新建");
  assert.equal(applied.mounts.length, 1, "衝突不得落第二筆");

  // 正常冪等重放仍必須 conflict:false（不誤傷既有冪等語義）。
  const first = applyAssetMount([], { projectId: "proj-a", assetKind: "pack", assetId: "pack-x", now: AT });
  const replay = applyAssetMount(first.mounts, { projectId: "proj-a", assetKind: "pack", assetId: "pack-x", now: AT });
  assert.equal(replay.conflict, false);
  assert.equal(replay.created, false);

  // 分享同款：同鍵不同三元組回 conflict。
  const shareKey = assetShareId("pack", "pack-x", "proj-a", "proj-b");
  const dirtyShare = { ...normalizeAssetShare({ assetKind: "card", assetId: "card-y", fromProjectId: "proj-a", toProjectId: "proj-b", createdAt: AT })! , id: shareKey };
  const granted = applyAssetShareGrant([dirtyShare], { assetKind: "pack", assetId: "pack-x", fromProjectId: "proj-a", toProjectId: "proj-b", now: AT });
  assert.equal(granted.conflict, true);
  assert.equal(granted.shares.length, 1);
});

test("B2-1 掛用標記鍵與 id 同一種單射編碼（mountedAssetKeys 不另立格式）", () => {
  const mounts = applyAssetMount([], { projectId: "proj-a", assetKind: "pack", assetId: "pack-x", now: AT }).mounts;
  assert.deepEqual([...mountedAssetKeys(mounts, "proj-a")], [mountedAssetKey("pack", "pack-x")]);
  // 鍵裡的 id 段不得是可被別的 (kind, id) 組合重現的裸拼接。
  assert.notEqual(mountedAssetKey("pack", "x:card:y"), mountedAssetKey("card", "y"));
});

// ─────────────────────────────────────────── ⑦ B2-2 使用路徑（單一入口包裝）

test("B2-2 使用路徑：filterUsableAssets 只放行可見資產（跨項目未分享即不可用）", () => {
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
  // 無項目上下文：項目資產全不可用，個人資產照用。
  assert.deepEqual(filterUsableAssets(assets, ctx(null)).map((a) => a.id), ["pack-personal"]);
  // 顯式分享後才可用（不是「同帳號自動放行」）。
  const grant = share("pack-in-b", "proj-b", "proj-a");
  assert.deepEqual(
    filterUsableAssets(assets, ctx("proj-a", [grant])).map((a) => a.id),
    ["pack-personal", "pack-in-a", "pack-in-b"],
  );
});

// ─────────────────────────────────────────── 檢索 / 篩選
test("檢索與篩選：標題/標籤命中、種類過濾、僅看已掛用", () => {
  const cards = candidatesFromCards(
    [
      { id: "card-1", name: "紅髮少女", kind: "character", updatedAt: "2026-09-22T02:00:00.000Z" },
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
  const byQuery = buildProjectAssetLibrary({ candidates, ctx: ctx("proj-a"), mounts: [], query: { q: "紅髮" } });
  assert.deepEqual(byQuery.map((i) => i.assetId), ["card-1"]);

  const mounts = applyAssetMount([], { projectId: "proj-a", assetKind: "card", assetId: "card-2", now: AT }).mounts;
  const mountedOnly = buildProjectAssetLibrary({ candidates, ctx: ctx("proj-a"), mounts, query: { mountedOnly: true } });
  assert.deepEqual(mountedOnly.map((i) => i.assetId), ["card-2"]);
  // 排序：updatedAt 由新到舊
  assert.deepEqual(
    buildProjectAssetLibrary({ candidates, ctx: ctx("proj-a"), mounts: [] }).map((i) => i.assetId),
    ["card-1", "pack-1", "card-2"],
  );
});

// ─────────────────────────────────────────── 清洗收口

test("清洗收口：作用域非法值收斂為 personal；鬼狀態（project 無 projectId）回 null 不降格（D3）", () => {
  assert.deepEqual(normalizeAssetScope(undefined), { owner: "personal" });
  assert.deepEqual(normalizeAssetScope("project"), { owner: "personal" });
  // D3：鬼狀態不是 personal（降格＝把歸屬不明的項目資產變成人人可用的個人資產）。
  assert.equal(normalizeAssetScope({ owner: "project" }), null);
  assert.equal(normalizeAssetScope({ owner: "project", projectId: "  " }), null);
  assert.deepEqual(normalizeAssetScope({ owner: "project", projectId: " proj-a " }), { owner: "project", projectId: "proj-a" });
  assert.equal(toAssetKind("pack"), "pack");
  assert.equal(toAssetKind("card"), "card");
  assert.equal(toAssetKind("asset-pack"), null);
  assert.equal(normalizeAssetShare({ assetKind: "pack", assetId: "", fromProjectId: "a", toProjectId: "b" }), null);
  assert.equal(normalizeAssetMount({ projectId: "", assetKind: "pack", assetId: "x" }), null);
  // id 由三元組重新推導，外部傳入的 id 被忽略（確定性鍵不許被呼叫端改寫）。
  const forged = normalizeAssetShare({ assetKind: "pack", assetId: "x", fromProjectId: "a", toProjectId: "b", id: "attacker-chosen" });
  assert.equal(forged?.id, assetShareId("pack", "x", "a", "b"));
});

// ─────────────────────────────────────────── D3 鬼狀態不可見（具名回歸）

test("D3 鬼狀態不可見：{owner:project, projectId:''} 在任何上下文都不可見/不可用（不降格成 personal）", () => {
  // 鬼狀態的持久化形狀：owner=project 而無 projectId（normalizeAssetScope 回 null 時呼叫端寫回的形狀）。
  const ghost = { owner: "project" as const };
  const ctxA: AssetUseContext = { viewerUserId: 42, projectId: "proj-a", shares: [] };
  const ctxNone: AssetUseContext = { viewerUserId: 42, projectId: null, shares: [] };
  const card = { id: "card-ghost", kind: "card" as const, scope: ghost, ownerUserId: 42 };

  // 反向對照：同一張卡若是 personal，兩邊都可見 —— 證明下面的 null 不是恆真。
  assert.equal(resolveAssetVisibility({ ...card, scope: undefined }, ctxA), "owner");
  assert.equal(resolveAssetVisibility({ ...card, scope: undefined }, ctxNone), "owner");

  // 鬼狀態：有項目上下文、無項目上下文、甚至「分享給當前項目」都不可見。
  assert.equal(resolveAssetVisibility(card, ctxA), null, "鬼狀態不得在有項目上下文可見");
  assert.equal(resolveAssetVisibility(card, ctxNone), null, "鬼狀態不得在無項目上下文可見");
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
    "分享授權救不回鬼狀態（來源項目根本不存在）",
  );
  assert.equal(canUseAsset(card, ctxA), false);
  // 掛用前的裁決、庫列表都不得放行。
  const ghostCandidate = packCandidate("pack-ghost", { owner: "project" });
  assert.equal(resolveMountableAsset([ghostCandidate], ctxA, { assetKind: "pack", assetId: "pack-ghost" }), null);
  assert.deepEqual(buildProjectAssetLibrary({ candidates: [ghostCandidate], ctx: ctxA, mounts: [] }), []);
});

// ─────────────────────────────────────────── D5 內部副本不是可掛用條目（具名回歸）

test("D5 內部副本不可再掛用：copy-… 不列進資產庫、掛用閘直接拒（判據為家族前綴+固定長度哈希）", () => {
  const copy = assetLocalCopyId("proj-a", "card", "card-src");
  assert.equal(isAssetLocalCopyId(copy), true, "卡副本 id 必須被認出");
  assert.equal(isAssetLocalCopyId(assetPackLocalCopyId("proj-a", "pack-src")), true, "包副本 id 必須被認出");
  assert.equal(isAssetLocalCopyId(assetPackItemCopyId("proj-a", "pack-src", 3)), true, "包內條目副本 id 必須被認出");
  // 反向對照：使用者自有的相似 id 不得被誤判（否則會靜默屏蔽使用者資產）。
  assert.equal(isAssetLocalCopyId("copy-card-src"), false);
  assert.equal(isAssetLocalCopyId("copy-card-0123456789abcdef0123456789abcde"), false, "長度不符不誤判");
  assert.equal(isAssetLocalCopyId("copy-card-0123456789ABCDEF0123456789ABCDEF"), false, "大寫不符不誤判");
  assert.equal(isAssetLocalCopyId("card-src"), false);
  assert.equal(isAssetLocalCopyId(undefined), false);

  const ctxA: AssetUseContext = { viewerUserId: 42, projectId: "proj-a", shares: [] };
  // 副本在目標項目裡是 in-project 可見（否則生成注不進去）——但**不可掛用**。
  const copyCandidate = packCandidate(copy, { owner: "project", projectId: "proj-a" });
  const sourceCandidate = packCandidate("pack-src", { owner: "project", projectId: "proj-a" });
  assert.equal(
    resolveAssetVisibility({ id: copy, kind: "pack", scope: { owner: "project", projectId: "proj-a" }, ownerUserId: 42 }, ctxA),
    "in-project",
    "副本本身在項目內仍可見（可見性 ≠ 可掛用）",
  );
  assert.deepEqual(
    buildProjectAssetLibrary({ candidates: [copyCandidate, sourceCandidate], ctx: ctxA, mounts: [] }).map((i) => i.assetId),
    ["pack-src"],
    "資產庫只列來源，不列內部副本（否則會被再掛用成副本的副本）",
  );
  assert.equal(resolveMountableAsset([copyCandidate], ctxA, { assetKind: "pack", assetId: copy }), null);
  assert.ok(resolveMountableAsset([sourceCandidate], ctxA, { assetKind: "pack", assetId: "pack-src" }), "來源照樣可掛用");
});

// ─────────────────────────────────────────── ④ 雙白名單回歸

test("雙白名單回歸：資產歸屬只給人看，未進 canvas 節點 metadata（構造漏補必紅）", () => {
  // **口徑（TG-02）**：本節只做**真實行為斷言**——把 leaky metadata 餵進兩個白名單函式，
  // 斷言兩端的**實際輸出**都不含 scope。源碼字串掃描（`doesNotMatch(/scope/)` 整檔）
  // 已移除：那是變更探針（無關語句含 scope 即假紅），不計入「已驗證」。
  // 判據：斷言輸出的**完整鍵集合**——任一端被「順手」補上欄位即紅（不靠源碼文字）。
  const leaky = {
    content: "x",
    prompt: "y",
    scope: { owner: "project", projectId: "proj-a" },
  } as unknown as CanvasNodeMetadata;
  const read = toNodeMetadata(leaky) as Record<string, unknown>;
  assert.equal("scope" in read, false, "toNodeMetadata 不得收資產歸屬（裁決排除）");
  // 鍵集合逐位斷言：漏補端或超收端都紅（不只查 scope 一個字）。
  assert.deepEqual(Object.keys(read).sort(), ["content", "prompt"]);
  const compacted = compactMetadataForAgent(leaky) as Record<string, unknown> | undefined;
  assert.ok(compacted);
  assert.equal("scope" in compacted, false, "compactMetadataForAgent 不得傳資產歸屬（裁決排除）");
  assert.deepEqual(Object.keys(compacted).sort(), ["content", "prompt"]);
});

test("雙白名單回歸：資產包/卡的作用域也不進 agent 主動包注入口", () => {
  // 資產歸屬是「人看的歸屬標記」，不是 agent 注入內容：
  // buildAssetPackInjection 的欄位清單不得出現 scope（漏一排 = agent 讀到不該讀的歸屬）。
  const source = readFileSync("src/lib/agent-assets.ts", "utf8");
  const injectionBlock = source.slice(source.indexOf("buildAssetPackInjection"));
  assert.ok(injectionBlock.length > 0);
  assert.doesNotMatch(injectionBlock, /scope/);
});
