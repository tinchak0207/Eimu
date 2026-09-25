// REQ-B2 作用域層 store 測試：記憶體降級路徑（測試環境無 BLOB_READ_WRITE_TOKEN）、
// 冪等語義（分享授權 / 項目掛用同鍵重放不新增第二筆）、用戶隔離、世代修剪模式對齊。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  __resetAssetScopeStoreForTests,
  grantAssetShare,
  listAssetMounts,
  listAssetShares,
  mountAsset,
  revokeAssetShare,
  unmountAsset,
} from "./asset-scope-store";
import { applyAssetMount, applyAssetUnmount, assetMountIdempotencyRef, assetShareId, isAssetShareActive } from "./asset-scope";
import { __resetAssetPackStoreForTests, listAssetPacks, normalizeAssetPack, saveAssetPack } from "./asset-pack-store";
import {
  __resetCharacterCardStoreForTests,
  listCharacterCards,
  saveCharacterCard,
} from "./character-card-store";
import { normalizeCharacterCard } from "./character-cards";

const AT = "2026-09-22T00:00:00.000Z";

test("分享 store：grant 幂等（同鍵重放 created:false，不新增第二筆）", async () => {
  __resetAssetScopeStoreForTests();
  const first = await grantAssetShare(1, { assetKind: "pack", assetId: "pack-b", fromProjectId: "proj-b", toProjectId: "proj-a", now: AT });
  assert.equal(first.created, true);
  assert.equal(first.share.id, assetShareId("pack", "pack-b", "proj-b", "proj-a"));

  const replay = await grantAssetShare(1, { assetKind: "pack", assetId: "pack-b", fromProjectId: "proj-b", toProjectId: "proj-a", now: "2026-09-22T09:00:00.000Z" });
  assert.equal(replay.created, false);
  const shares = await listAssetShares(1);
  assert.equal(shares.length, 1);
  assert.equal(shares[0].createdAt, AT); // 重放零副作用（沿用首件時間）
  assert.equal(isAssetShareActive(shares[0]), true);

  // 不同目標項目 = 另一件授權。
  const other = await grantAssetShare(1, { assetKind: "pack", assetId: "pack-b", fromProjectId: "proj-b", toProjectId: "proj-c", now: AT });
  assert.equal(other.created, true);
  assert.equal((await listAssetShares(1)).length, 2);

  // 用戶隔離。
  assert.deepEqual(await listAssetShares(2), []);
});

test("分享 store：撤銷後不再生效，再授權復活同一件（id 不變）", async () => {
  __resetAssetScopeStoreForTests();
  const { share } = await grantAssetShare(5, { assetKind: "card", assetId: "card-1", fromProjectId: "proj-b", toProjectId: "proj-a", now: AT });
  assert.equal(await revokeAssetShare(5, share.id), true);
  assert.equal(await revokeAssetShare(5, share.id), false); // 已撤銷 = 0（冪等）
  assert.equal(await revokeAssetShare(5, "share:pack:nope:a->b"), false);
  const afterRevoke = await listAssetShares(5);
  assert.equal(afterRevoke.length, 1);
  assert.equal(isAssetShareActive(afterRevoke[0]), false);

  const revived = await grantAssetShare(5, { assetKind: "card", assetId: "card-1", fromProjectId: "proj-b", toProjectId: "proj-a", now: "2026-09-22T05:00:00.000Z" });
  assert.equal(revived.created, false);
  assert.equal(revived.share.id, share.id);
  const finalShares = await listAssetShares(5);
  assert.equal(finalShares.length, 1);
  assert.equal(isAssetShareActive(finalShares[0]), true);
});

test("掛用 store：mount 幂等不雙扣（同鍵重掛 created:false）、unmount 生效", async () => {
  __resetAssetScopeStoreForTests();
  const first = await mountAsset(9, { projectId: "proj-a", assetKind: "pack", assetId: "pack-b", now: AT });
  assert.equal(first.created, true);
  assert.equal(first.mount.idempotencyRef, assetMountIdempotencyRef("proj-a", "pack", "pack-b"));

  const replay = await mountAsset(9, { projectId: "proj-a", assetKind: "pack", assetId: "pack-b", now: "2026-09-22T09:00:00.000Z" });
  assert.equal(replay.created, false);
  assert.equal(replay.mount.mountedAt, AT);
  assert.equal((await listAssetMounts(9)).length, 1);

  // 跨項目復用同一資產：另一項目 = 另一把冪等鍵（各自一件，互不覆蓋）。
  const inC = await mountAsset(9, { projectId: "proj-c", assetKind: "pack", assetId: "pack-b", now: AT });
  assert.equal(inC.created, true);
  assert.notEqual(inC.mount.idempotencyRef, first.mount.idempotencyRef);
  assert.equal((await listAssetMounts(9)).length, 2);

  assert.equal(await unmountAsset(9, { projectId: "proj-a", assetKind: "pack", assetId: "pack-b" }), true);
  assert.equal(await unmountAsset(9, { projectId: "proj-a", assetKind: "pack", assetId: "pack-b" }), false);
  assert.deepEqual((await listAssetMounts(9)).map((m) => m.projectId), ["proj-c"]);
  // 用戶隔離。
  assert.deepEqual(await listAssetMounts(10), []);
});

test("歸屬不因清洗丟失：包/卡經 normalize + store 讀回仍帶 scope（刷新不掉歸屬）", async () => {
  __resetAssetPackStoreForTests();
  __resetCharacterCardStoreForTests();

  // 資產包：清洗收口保留項目歸屬、personal 不寫欄位（不冒充「已設定」）。
  const pack = normalizeAssetPack({
    id: "pack-scoped",
    title: "项目资产包",
    items: [],
    tags: [],
    scope: { owner: "project", projectId: "proj-a" },
    createdAt: AT,
    updatedAt: AT,
  });
  assert.equal(pack?.scope?.projectId, "proj-a");
  await saveAssetPack(42, pack!);
  assert.equal((await listAssetPacks(42))[0].scope?.projectId, "proj-a");
  const personalPack = normalizeAssetPack({ id: "pack-personal", title: "个人包", items: [], tags: [], scope: { owner: "personal" } });
  assert.ok(personalPack);
  assert.equal("scope" in personalPack, false);

  // 資產卡：同一張卡同時帶 D1 血統欄位族與 B2 歸屬（兩刀欄位共存，不互相沖掉）。
  const card = normalizeCharacterCard({
    id: "card-scoped",
    name: "角色卡",
    scope: { owner: "project", projectId: "proj-a" },
    lineage: [{ kind: "reference", jobId: "job-1", at: AT }],
    createdAt: AT,
    updatedAt: AT,
  });
  assert.equal(card?.scope?.projectId, "proj-a");
  assert.equal(card?.lineage?.length, 1);
  await saveCharacterCard(42, card!);
  const readBack = (await listCharacterCards(42))[0];
  assert.equal(readBack.scope?.projectId, "proj-a");
  assert.equal(readBack.lineage?.[0].jobId, "job-1");
  // 舊資料（無 scope）讀回後仍是 personal 語義：不憑空多出歸屬。
  const legacy = normalizeCharacterCard({ id: "card-legacy", name: "旧卡" });
  assert.ok(legacy);
  assert.equal("scope" in legacy, false);
});

test("store 使用不可變 blob 世代（與 asset-pack-store 同模式）", () => {
  const source = readFileSync("src/lib/asset-scope-store.ts", "utf8");
  assert.match(source, /list\(\{ prefix: indexPrefix/);
  assert.doesNotMatch(source, /allowOverwrite:\s*true/);
  assert.match(source, /INDEX_GENERATIONS_KEPT = 2/);
});

test("B2-1 解除掛用：主鍵由三元組重推導——外部字串（舊版裸拼接鍵）刪不掉任何一筆", () => {
  // 口徑（TG-02）：本節是**實際呼叫**的斷言，不是源碼字串掃描。
  const mounts = applyAssetMount([], { projectId: "proj-a", assetKind: "pack", assetId: "pack-x", now: AT }).mounts;
  const stale = applyAssetUnmount(mounts, "mount:proj-a:pack:pack-x");
  assert.equal(stale.removed, false, "舊版格式的字串不是任何一筆的主鍵");
  assert.equal(stale.mounts.length, 1);
  assert.equal(applyAssetUnmount(mounts, mounts[0].id).removed, true, "真鍵仍刪得掉");
});

test("B2-1 store：含分隔符 / 超長的資產 id 不得掛用成功（拒絕而非截斷別名）", async () => {
  __resetAssetScopeStoreForTests();
  // 含保留分隔符的 id：過去會與別的 (kind, id) 組合撞鍵並回 success；現在直接拒收。
  await assert.rejects(() => mountAsset(31, { projectId: "p", assetKind: "pack", assetId: "x:card:y" }));
  // 超長 id：過去被截斷成 200 字（兩個不同 id 落成同一筆）；現在拒收。
  await assert.rejects(() => mountAsset(31, { projectId: "p", assetKind: "pack", assetId: "a".repeat(201) }));
  assert.deepEqual(await listAssetMounts(31), []);
  // 邊界內仍正常（不誤傷）。
  const ok = await mountAsset(31, { projectId: "p", assetKind: "pack", assetId: "a".repeat(200), now: AT });
  assert.equal(ok.created, true);
  assert.equal((await listAssetMounts(31)).length, 1);
  // 非法 id 的 unmount 回 false（不噴錯、不誤刪）。
  assert.equal(await unmountAsset(31, { projectId: "p", assetKind: "pack", assetId: "x:card:y" }), false);
  assert.equal((await listAssetMounts(31)).length, 1);
});
