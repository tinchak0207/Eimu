// REQ-B2-2 使用/注入路徑的作用域裁決測試（**實際呼叫**，非源碼字串掃描）。
//
// 覆蓋三條硬要求：
//   ① 跨 project 未分享的資產在**使用路徑**不可用（生成卡注入 / agent 包注入）
//   ② 跨 owner 未分享一律不可用（fail-closed，不因「同帳號」放行）
//   ③ 個人資產零回歸：既有單用戶個人資產流程逐位不變
// 走記憶體降級路徑（測試環境無 BLOB_READ_WRITE_TOKEN）。
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
  assert.ok(normalized, `pack ${id} 應可清洗`);
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
  assert.ok(normalized, `card ${id} 應可清洗`);
  return normalized;
}

// ─────────────────────────────────────────── ① agent 主動包注入路徑

test("B2-2 agent 包注入：跨 project 未分享的包不可用（無項目上下文＝不注入）", async () => {
  reset();
  await saveAssetPack(42, pack("pack-in-a", { owner: "project", projectId: "proj-a" }));

  assert.equal(
    await isAssetUsable({ userId: 42, projectId: null, assetKind: "pack", assetId: "pack-in-a" }),
    false,
    "無項目上下文時項目歸屬的包必須不可用（不可見即不可用）",
  );
  assert.equal(
    await isAssetUsable({ userId: 42, projectId: "proj-b", assetKind: "pack", assetId: "pack-in-a" }),
    false,
    "別的項目不得讀到本項目歸屬的包",
  );
  assert.equal(
    await isAssetUsable({ userId: 42, projectId: "proj-a", assetKind: "pack", assetId: "pack-in-a" }),
    true,
    "本項目上下文下可用（不是無條件拒絕）",
  );
});

test("B2-2 agent 包注入：顯式分享後才在目標項目可用（撤銷後立刻回到不可用）", async () => {
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
    "顯式分享後目標項目可用",
  );
  assert.equal(await revokeAssetShare(42, shared.share.id), true);
  assert.equal(
    await isAssetUsable({ userId: 42, projectId: "proj-b", assetKind: "pack", assetId: "pack-in-a" }),
    false,
    "撤銷後立刻回到不可用",
  );
});

test("B2-2 agent 包注入：跨 owner 未分享一律不可用（fail-closed）", async () => {
  reset();
  await saveAssetPack(42, pack("pack-in-a", { owner: "project", projectId: "proj-a" }));
  await saveAssetPack(42, pack("pack-personal"));
  // 別人的存儲桶裡沒有這個包 → 不可用（不是「同帳號自動放行」）。
  assert.equal(await isAssetUsable({ userId: 7, projectId: "proj-a", assetKind: "pack", assetId: "pack-in-a" }), false);
  assert.equal(await isAssetUsable({ userId: 7, projectId: null, assetKind: "pack", assetId: "pack-personal" }), false);
  // 個人包對本帳號在所有項目上下文都可用（零回歸）。
  assert.equal(await isAssetUsable({ userId: 42, projectId: "proj-a", assetKind: "pack", assetId: "pack-personal" }), true);
  assert.equal(await isAssetUsable({ userId: 42, projectId: null, assetKind: "pack", assetId: "pack-personal" }), true);
  assert.equal(await isAssetUsable({ userId: 42, projectId: "proj-z", assetKind: "pack", assetId: "pack-personal" }), true);
});

// ─────────────────────────────────────────── ② 生成卡注入路徑（cardIds 閘）

test("B2-2 生成卡注入：跨 project 未分享的卡不得鎖進本項目（其餘原樣）", async () => {
  reset();
  await saveCharacterCard(42, card("card-in-a", { owner: "project", projectId: "proj-a" }));
  await saveCharacterCard(42, card("card-personal"));

  // 本項目：全數保留（不誤傷）。
  assert.deepEqual(
    await filterCardIdsForProject({ userId: 42, projectId: "proj-a", cardIds: ["card-in-a", "card-personal"] }),
    ["card-in-a", "card-personal"],
  );
  // 別的項目：A 的卡被拒，個人卡與「查不到的 id」原樣保留（不猜、不靜默丟）。
  assert.deepEqual(
    await filterCardIdsForProject({ userId: 42, projectId: "proj-b", cardIds: ["card-in-a", "card-personal", "card-ghost"] }),
    ["card-personal", "card-ghost"],
  );
  // 顯式分享後才可在 proj-b 鎖定。
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

test("B2-2 生成卡注入：跨 owner 的卡不在本人卡池 → 只按「查不到」語義處理，不因此放行他人資產", async () => {
  reset();
  await saveCharacterCard(7, card("card-in-a", { owner: "project", projectId: "proj-a" }));
  // 42 的卡池裡沒有它 → 查不到（維持不猜語義），但 42 也拿不到卡實體（store 按 userId 隔離）。
  assert.deepEqual(
    await filterCardIdsForProject({ userId: 42, projectId: "proj-b", cardIds: ["card-in-a"] }),
    ["card-in-a"],
  );
  assert.equal(await isAssetUsable({ userId: 42, projectId: "proj-b", assetKind: "card", assetId: "card-in-a" }), false);
});

// ─────────────────────────────────────────── ③ 上下文取值與零回歸

test("B2-2 項目上下文取值：非字串/空 → null（fail-closed，不臆造項目）", () => {
  assert.equal(projectIdFromBody({ projectId: "proj-a" }), "proj-a");
  assert.equal(projectIdFromBody({ project_id: "proj-a" }), "proj-a");
  assert.equal(projectIdFromBody({ projectId: "  proj-a  " }), "proj-a");
  assert.equal(projectIdFromBody({ projectId: "   " }), null);
  assert.equal(projectIdFromBody({ projectId: 42 }), null);
  assert.equal(projectIdFromBody({}), null);
  assert.equal(projectIdFromBody(null), null);
  assert.equal(projectIdFromBody("proj-a"), null);
});

test("B2-2 零回歸：只有個人卡/包的用戶，行為與加作用域層之前逐位一致", async () => {
  reset();
  await saveCharacterCard(42, card("card-personal-1"));
  await saveCharacterCard(42, card("card-personal-2"));
  await saveAssetPack(42, pack("pack-personal"));
  const ids = ["card-personal-1", "card-personal-2", "card-missing"];
  for (const projectId of ["proj-a", "proj-b", "proj-new"]) {
    assert.deepEqual(await filterCardIdsForProject({ userId: 42, projectId, cardIds: ids }), ids);
  }
  assert.equal(await isAssetUsable({ userId: 42, projectId: null, assetKind: "pack", assetId: "pack-personal" }), true);
  // 空 cardIds 不觸發任何讀取，原樣回空（零成本短路）。
  assert.deepEqual(await filterCardIdsForProject({ userId: 42, projectId: "proj-a", cardIds: [] }), []);
});
