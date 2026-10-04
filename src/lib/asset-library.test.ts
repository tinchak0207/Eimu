// REQ-B2-2 使用/注入路径的作用域裁决测试（**实际呼叫**，非源码字串扫描）。
//
// 覆盖三条硬要求：
//   ① 跨 project 未分享的资产在**使用路径**不可用（生成卡注入 / agent 包注入）
//   ② 跨 owner 未分享一律不可用（fail-closed，不因「同帐号」放行）
//   ③ 个人资产零回归：既有单用户个人资产流程逐位不变
// 走记忆体降级路径（测试环境无 BLOB_READ_WRITE_TOKEN）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { __resetAssetPackStoreForTests, normalizeAssetPack, saveAssetPack } from "./asset-pack-store";
import { __resetCharacterCardStoreForTests, saveCharacterCard } from "./character-card-store";
import { normalizeCharacterCard } from "./character-cards";
import { __resetAssetScopeStoreForTests, grantAssetShare, revokeAssetShare } from "./asset-scope-store";
import { filterCardIdsForProject, isAssetUsable, projectIdFromBody } from "./asset-library";

const AT = "2026-09-22T00:00:00.000Z";

function reset(): void {
  __resetAssetPackStoreForTests();
  __resetCharacterCardStoreForTests();
  __resetAssetScopeStoreForTests();
}

function pack(id: string, scope?: { owner: "personal" | "project"; projectId?: string }) {
  const normalized = normalizeAssetPack({
    id,
    title: `包-${id}`,
    items: [{ kind: "prompt", title: "提示词", content: "x" }],
    tags: [],
    ...(scope ? { scope } : {}),
    createdAt: AT,
    updatedAt: AT,
  });
  assert.ok(normalized, `pack ${id} 应可清洗`);
  return normalized;
}

function card(id: string, scope?: { owner: "personal" | "project"; projectId?: string }) {
  const normalized = normalizeCharacterCard({
    id,
    name: `卡-${id}`,
    kind: "character",
    ...(scope ? { scope } : {}),
    createdAt: AT,
    updatedAt: AT,
  });
  assert.ok(normalized, `card ${id} 应可清洗`);
  return normalized;
}

// ─────────────────────────────────────────── ① agent 主动包注入路径

test("B2-2 agent 包注入：跨 project 未分享的包不可用（无项目上下文＝不注入）", async () => {
  reset();
  await saveAssetPack(42, pack("pack-in-a", { owner: "project", projectId: "proj-a" }));

  assert.equal(
    await isAssetUsable({ userId: 42, projectId: null, assetKind: "pack", assetId: "pack-in-a" }),
    false,
    "无项目上下文时项目归属的包必须不可用（不可见即不可用）",
  );
  assert.equal(
    await isAssetUsable({ userId: 42, projectId: "proj-b", assetKind: "pack", assetId: "pack-in-a" }),
    false,
    "别的项目不得读到本项目归属的包",
  );
  assert.equal(
    await isAssetUsable({ userId: 42, projectId: "proj-a", assetKind: "pack", assetId: "pack-in-a" }),
    true,
    "本项目上下文下可用（不是无条件拒绝）",
  );
});

test("B2-2 agent 包注入：显式分享后才在目标项目可用（撤销后立刻回到不可用）", async () => {
  reset();
  await saveAssetPack(42, pack("pack-in-a", { owner: "project", projectId: "proj-a" }));
  const shared = await grantAssetShare(42, {
    assetKind: "pack",
    assetId: "pack-in-a",
    fromProjectId: "proj-a",
    toProjectId: "proj-b",
    now: AT,
  });
  assert.equal(shared.created, true);
  assert.equal(
    await isAssetUsable({ userId: 42, projectId: "proj-b", assetKind: "pack", assetId: "pack-in-a" }),
    true,
    "显式分享后目标项目可用",
  );
  assert.equal(await revokeAssetShare(42, shared.share.id), true);
  assert.equal(
    await isAssetUsable({ userId: 42, projectId: "proj-b", assetKind: "pack", assetId: "pack-in-a" }),
    false,
    "撤销后立刻回到不可用",
  );
});

test("B2-2 agent 包注入：跨 owner 未分享一律不可用（fail-closed）", async () => {
  reset();
  await saveAssetPack(42, pack("pack-in-a", { owner: "project", projectId: "proj-a" }));
  await saveAssetPack(42, pack("pack-personal"));
  // 别人的存储桶里没有这个包 → 不可用（不是「同帐号自动放行」）。
  assert.equal(await isAssetUsable({ userId: 7, projectId: "proj-a", assetKind: "pack", assetId: "pack-in-a" }), false);
  assert.equal(await isAssetUsable({ userId: 7, projectId: null, assetKind: "pack", assetId: "pack-personal" }), false);
  // 个人包对本帐号在所有项目上下文都可用（零回归）。
  assert.equal(await isAssetUsable({ userId: 42, projectId: "proj-a", assetKind: "pack", assetId: "pack-personal" }), true);
  assert.equal(await isAssetUsable({ userId: 42, projectId: null, assetKind: "pack", assetId: "pack-personal" }), true);
  assert.equal(await isAssetUsable({ userId: 42, projectId: "proj-z", assetKind: "pack", assetId: "pack-personal" }), true);
});

// ─────────────────────────────────────────── ② 生成卡注入路径（cardIds 闸）

test("B2-2 生成卡注入：跨 project 未分享的卡不得锁进本项目（其余原样）", async () => {
  reset();
  await saveCharacterCard(42, card("card-in-a", { owner: "project", projectId: "proj-a" }));
  await saveCharacterCard(42, card("card-personal"));

  // 本项目：全数保留（不误伤）。
  assert.deepEqual(
    await filterCardIdsForProject({ userId: 42, projectId: "proj-a", cardIds: ["card-in-a", "card-personal"] }),
    ["card-in-a", "card-personal"],
  );
  // 别的项目：A 的卡被拒，个人卡与「查不到的 id」原样保留（不猜、不静默丢）。
  assert.deepEqual(
    await filterCardIdsForProject({ userId: 42, projectId: "proj-b", cardIds: ["card-in-a", "card-personal", "card-ghost"] }),
    ["card-personal", "card-ghost"],
  );
  // 显式分享后才可在 proj-b 锁定。
  await grantAssetShare(42, {
    assetKind: "card",
    assetId: "card-in-a",
    fromProjectId: "proj-a",
    toProjectId: "proj-b",
    now: AT,
  });
  assert.deepEqual(
    await filterCardIdsForProject({ userId: 42, projectId: "proj-b", cardIds: ["card-in-a", "card-personal"] }),
    ["card-in-a", "card-personal"],
  );
});

test("B2-2 生成卡注入：跨 owner 的卡不在本人卡池 → 只按「查不到」语义处理，不因此放行他人资产", async () => {
  reset();
  await saveCharacterCard(7, card("card-in-a", { owner: "project", projectId: "proj-a" }));
  // 42 的卡池里没有它 → 查不到（维持不猜语义），但 42 也拿不到卡实体（store 按 userId 隔离）。
  assert.deepEqual(
    await filterCardIdsForProject({ userId: 42, projectId: "proj-b", cardIds: ["card-in-a"] }),
    ["card-in-a"],
  );
  assert.equal(await isAssetUsable({ userId: 42, projectId: "proj-b", assetKind: "card", assetId: "card-in-a" }), false);
});

// ─────────────────────────────────────────── ③ 上下文取值与零回归

test("B2-2 项目上下文取值：非字串/空 → null（fail-closed，不臆造项目）", () => {
  assert.equal(projectIdFromBody({ projectId: "proj-a" }), "proj-a");
  assert.equal(projectIdFromBody({ project_id: "proj-a" }), "proj-a");
  assert.equal(projectIdFromBody({ projectId: "  proj-a  " }), "proj-a");
  assert.equal(projectIdFromBody({ projectId: "   " }), null);
  assert.equal(projectIdFromBody({ projectId: 42 }), null);
  assert.equal(projectIdFromBody({}), null);
  assert.equal(projectIdFromBody(null), null);
  assert.equal(projectIdFromBody("proj-a"), null);
});

test("B2-2 零回归：只有个人卡/包的用户，行为与加作用域层之前逐位一致", async () => {
  reset();
  await saveCharacterCard(42, card("card-personal-1"));
  await saveCharacterCard(42, card("card-personal-2"));
  await saveAssetPack(42, pack("pack-personal"));
  const ids = ["card-personal-1", "card-personal-2", "card-missing"];
  for (const projectId of ["proj-a", "proj-b", "proj-new"]) {
    assert.deepEqual(await filterCardIdsForProject({ userId: 42, projectId, cardIds: ids }), ids);
  }
  assert.equal(await isAssetUsable({ userId: 42, projectId: null, assetKind: "pack", assetId: "pack-personal" }), true);
  // 空 cardIds 不触发任何读取，原样回空（零成本短路）。
  assert.deepEqual(await filterCardIdsForProject({ userId: 42, projectId: "proj-a", cardIds: [] }), []);
});
