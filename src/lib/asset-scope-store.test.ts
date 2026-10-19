// REQ-B2 作用域层 store 测试：记忆体降级路径（测试环境无 BLOB_READ_WRITE_TOKEN）、
// 幂等语义（分享授权 / 项目挂用同键重放不新增第二笔）、用户隔离、世代修剪模式对齐。
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

test("分享 store：grant 幂等（同键重放 created:false，不新增第二笔）", async () => {
  __resetAssetScopeStoreForTests();
  const first = await grantAssetShare(1, { assetKind: "pack", assetId: "pack-b", fromProjectId: "proj-b", toProjectId: "proj-a", now: AT });
  assert.equal(first.created, true);
  assert.equal(first.share.id, assetShareId("pack", "pack-b", "proj-b", "proj-a"));

  const replay = await grantAssetShare(1, { assetKind: "pack", assetId: "pack-b", fromProjectId: "proj-b", toProjectId: "proj-a", now: "2026-09-22T09:00:00.000Z" });
  assert.equal(replay.created, false);
  const shares = await listAssetShares(1);
  assert.equal(shares.length, 1);
  assert.equal(shares[0].createdAt, AT); // 重放零副作用（沿用首件时间）
  assert.equal(isAssetShareActive(shares[0]), true);

  // 不同目标项目 = 另一件授权。
  const other = await grantAssetShare(1, { assetKind: "pack", assetId: "pack-b", fromProjectId: "proj-b", toProjectId: "proj-c", now: AT });
  assert.equal(other.created, true);
  assert.equal((await listAssetShares(1)).length, 2);

  // 用户隔离。
  assert.deepEqual(await listAssetShares(2), []);
});

test("分享 store：撤销后不再生效，再授权复活同一件（id 不变）", async () => {
  __resetAssetScopeStoreForTests();
  const { share } = await grantAssetShare(5, { assetKind: "card", assetId: "card-1", fromProjectId: "proj-b", toProjectId: "proj-a", now: AT });
  assert.equal(await revokeAssetShare(5, share.id), true);
  assert.equal(await revokeAssetShare(5, share.id), false); // 已撤销 = 0（幂等）
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

test("挂用 store：mount 幂等不双扣（同键重挂 created:false）、unmount 生效", async () => {
  __resetAssetScopeStoreForTests();
  const first = await mountAsset(9, { projectId: "proj-a", assetKind: "pack", assetId: "pack-b", now: AT });
  assert.equal(first.created, true);
  assert.equal(first.mount.idempotencyRef, assetMountIdempotencyRef("proj-a", "pack", "pack-b"));

  const replay = await mountAsset(9, { projectId: "proj-a", assetKind: "pack", assetId: "pack-b", now: "2026-09-22T09:00:00.000Z" });
  assert.equal(replay.created, false);
  assert.equal(replay.mount.mountedAt, AT);
  assert.equal((await listAssetMounts(9)).length, 1);

  // 跨项目复用同一资产：另一项目 = 另一把幂等键（各自一件，互不覆盖）。
  const inC = await mountAsset(9, { projectId: "proj-c", assetKind: "pack", assetId: "pack-b", now: AT });
  assert.equal(inC.created, true);
  assert.notEqual(inC.mount.idempotencyRef, first.mount.idempotencyRef);
  assert.equal((await listAssetMounts(9)).length, 2);

  assert.equal(await unmountAsset(9, { projectId: "proj-a", assetKind: "pack", assetId: "pack-b" }), true);
  assert.equal(await unmountAsset(9, { projectId: "proj-a", assetKind: "pack", assetId: "pack-b" }), false);
  assert.deepEqual((await listAssetMounts(9)).map((m) => m.projectId), ["proj-c"]);
  // 用户隔离。
  assert.deepEqual(await listAssetMounts(10), []);
});

test("归属不因清洗丢失：包/卡经 normalize + store 读回仍带 scope（刷新不掉归属）", async () => {
  __resetAssetPackStoreForTests();
  __resetCharacterCardStoreForTests();

  // 资产包：清洗收口保留项目归属、personal 不写栏位（不冒充「已设定」）。
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

  // 资产卡：同一张卡同时带 D1 血统栏位族与 B2 归属（两刀栏位共存，不互相冲掉）。
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
  // 旧资料（无 scope）读回后仍是 personal 语义：不凭空多出归属。
  const legacy = normalizeCharacterCard({ id: "card-legacy", name: "旧卡" });
  assert.ok(legacy);
  assert.equal("scope" in legacy, false);
});

test("store 使用不可变 blob 世代（与 asset-pack-store 同模式）", () => {
  const source = readFileSync("src/lib/asset-scope-store.ts", "utf8");
  assert.match(source, /list\(\{ prefix: indexPrefix/);
  assert.doesNotMatch(source, /allowOverwrite:\s*true/);
  assert.match(source, /INDEX_GENERATIONS_KEPT = 2/);
});

test("B2-1 解除挂用：主键由三元组重推导——外部字串（旧版裸拼接键）删不掉任何一笔", () => {
  // 口径（TG-02）：本节是**实际呼叫**的断言，不是源码字串扫描。
  const mounts = applyAssetMount([], { projectId: "proj-a", assetKind: "pack", assetId: "pack-x", now: AT }).mounts;
  const stale = applyAssetUnmount(mounts, "mount:proj-a:pack:pack-x");
  assert.equal(stale.removed, false, "旧版格式的字串不是任何一笔的主键");
  assert.equal(stale.mounts.length, 1);
  assert.equal(applyAssetUnmount(mounts, mounts[0].id).removed, true, "真键仍删得掉");
});

test("B2-1 store：含分隔符 / 超长的资产 id 不得挂用成功（拒绝而非截断别名）", async () => {
  __resetAssetScopeStoreForTests();
  // 含保留分隔符的 id：过去会与别的 (kind, id) 组合撞键并回 success；现在直接拒收。
  await assert.rejects(() => mountAsset(31, { projectId: "p", assetKind: "pack", assetId: "x:card:y" }));
  // 超长 id：过去被截断成 200 字（两个不同 id 落成同一笔）；现在拒收。
  await assert.rejects(() => mountAsset(31, { projectId: "p", assetKind: "pack", assetId: "a".repeat(201) }));
  assert.deepEqual(await listAssetMounts(31), []);
  // 边界内仍正常（不误伤）。
  const ok = await mountAsset(31, { projectId: "p", assetKind: "pack", assetId: "a".repeat(200), now: AT });
  assert.equal(ok.created, true);
  assert.equal((await listAssetMounts(31)).length, 1);
  // 非法 id 的 unmount 回 false（不喷错、不误删）。
  assert.equal(await unmountAsset(31, { projectId: "p", assetKind: "pack", assetId: "x:card:y" }), false);
  assert.equal((await listAssetMounts(31)).length, 1);
});
