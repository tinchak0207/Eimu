// REQ-B2b 对抗性验收缺陷的**具名回归**（把验收官的 repro 逐条变成真实行为断言）。
//
//   口径（TG-02 / AGENTS.md 09-23）：本档每一条都是**实际呼叫**的行为断言，
//   没有任何源码字串扫描；断言都带反向对照（证明断言不是恒真）。
//
//   D1 解除挂用漏解锁包内条目副本 →「已解除但仍被注入」且永久无法自愈（三个 UI 可达触发路径）
//   D2 环路守卫有界 → 6 跳真环漏检（现为完整遍历 + 超界 fail-closed）
//   D4 挂用幂等可被事后血统编辑永久打死（既有记录查询排在环路守卫之前）
//   D5 内部副本被当成资产库条目列出 → 可再挂用造成卡片膨胀 + 额度诚实
//   口径修正：不变量是**运行时自足**（lineage 边可指向别的 project 的来源）
//
// 走记忆体降级路径（测试环境无 BLOB_READ_WRITE_TOKEN）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyCopyLockChange,
  assetLocalCopyId,
  assetPackItemCopyId,
  assetPackLocalCopyId,
  filterLockedCardsForProjectUse,
  isAssetLocalCopyId,
} from "./asset-scope";
import {
  AssetMountCopyRejectedError,
  collectAncestorAssetIds,
  filterCardIdsForProject,
  listProjectAssetLibrary,
  mountAssetWithCopy,
  mountCopyIds,
  resolveMountable,
  unmountAssetAndCopies,
} from "./asset-library";
import { __resetAssetScopeStoreForTests, listAssetMounts, mountAsset } from "./asset-scope-store";
import { __resetAssetPackStoreForTests, deleteAssetPacks, listAssetPacks, normalizeAssetPack, saveAssetPack } from "./asset-pack-store";
import {
  __resetCharacterCardStoreForTests,
  deleteCharacterCards,
  listCharacterCards,
  saveCharacterCard,
} from "./character-card-store";
import { applyCharacterCardsToPayload, normalizeCharacterCard } from "./character-cards";
import type { CharacterCard } from "./character-cards";

const AT = "2026-09-23T00:00:00.000Z";
const AT2 = "2026-09-23T01:00:00.000Z";
const USER = 42;

function reset(): void {
  __resetCharacterCardStoreForTests();
  __resetAssetPackStoreForTests();
  __resetAssetScopeStoreForTests();
}

function card(id: string, extra: Partial<CharacterCard> = {}): CharacterCard {
  const normalized = normalizeCharacterCard({
    id,
    name: `卡-${id}`,
    kind: "character",
    prompt: `prompt-${id}`,
    createdAt: AT,
    updatedAt: AT,
    ...extra,
  });
  assert.ok(normalized, `card ${id} 应可清洗`);
  return normalized;
}

function pack(id: string, items: unknown[]) {
  const normalized = normalizeAssetPack({
    id,
    title: `包-${id}`,
    items,
    tags: [],
    createdAt: AT,
    updatedAt: AT,
  });
  assert.ok(normalized, `pack ${id} 应可清洗`);
  return normalized;
}

const promptItem = (title: string, content: string) => ({ kind: "prompt", title, content });

// ─────────────────────────────────────────── 生成注入的真实断言（锁定集 → payload）

/**
 * 「这批锁定卡会被注入什么」——与前端同一条路径：cardIds 经 applyCopyLockChange 变更后，
 * 由卡库解析实体、再过读取端作用域闸（filterLockedCardsForProjectUse）、最后进注入。
 */
async function injectedAfterUnmount(cardIds: readonly string[], unlocked: readonly string[], projectId: string): Promise<string> {
  const next = applyCopyLockChange(cardIds, { locked: [], unlocked });
  const cards = await listCharacterCards(USER);
  const byId = new Map(cards.map((c) => [c.id, c] as const));
  const locked = next.flatMap((id) => (byId.get(id) ? [byId.get(id)!] : []));
  const usable = filterLockedCardsForProjectUse(locked, { projectId, shares: [] });
  return String(applyCharacterCardsToPayload({ prompt: "base" }, usable).prompt);
}

// ─────────────────────────────────────────── D1 三个 UI 可达触发路径

test("D1(a) 挂→解→来源包追加条目→挂→解：解除必须涵盖追加后新锁的副本，注入归零", async () => {
  reset();
  await saveAssetPack(USER, pack("pack-src", [promptItem("提示A", "内容A")]));

  const first = await mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "pack", assetId: "pack-src", now: AT });
  assert.deepEqual(first.localCopyIds, [assetPackItemCopyId("proj-b", "pack-src", 0)]);
  let cardIds = applyCopyLockChange([], { locked: first.localCopyIds, unlocked: [] });
  assert.ok((await injectedAfterUnmount(cardIds, [], "proj-b")).includes("内容A"));

  // 解除第一次挂用（含副本回收）
  const firstUnmount = await unmountAssetAndCopies({ userId: USER, projectId: "proj-b", assetKind: "pack", assetId: "pack-src" });
  assert.equal(firstUnmount.removed, true);
  assert.deepEqual(firstUnmount.localCopyIds, [firstUnmount.localCopyId, assetPackItemCopyId("proj-b", "pack-src", 0)]);
  assert.equal(await injectedAfterUnmount(cardIds, firstUnmount.localCopyIds, "proj-b"), "base", "解除后注入归零");

  // 来源包追加条目（本地包副本已被回收，重挂要重新推导）
  await saveAssetPack(USER, pack("pack-src", [promptItem("提示A", "内容A"), promptItem("提示B", "内容B")]));
  const second = await mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "pack", assetId: "pack-src", now: AT2 });
  assert.deepEqual(second.localCopyIds, [
    assetPackItemCopyId("proj-b", "pack-src", 0),
    assetPackItemCopyId("proj-b", "pack-src", 1),
  ]);
  cardIds = applyCopyLockChange(cardIds, { locked: second.localCopyIds, unlocked: [] });
  const mounted = await listProjectAssetLibrary({ userId: USER, projectId: "proj-b" });
  assert.equal(mounted.mounts.length, 1);

  const secondUnmount = await unmountAssetAndCopies({ userId: USER, projectId: "proj-b", assetKind: "pack", assetId: "pack-src" });
  assert.deepEqual(
    secondUnmount.localCopyIds,
    [secondUnmount.localCopyId, assetPackItemCopyId("proj-b", "pack-src", 0), assetPackItemCopyId("proj-b", "pack-src", 1)],
    "解除回应必须涵盖**全部实际锁过的副本**（含追加后才建的那张）",
  );
  assert.equal(await injectedAfterUnmount(cardIds, secondUnmount.localCopyIds, "proj-b"), "base", "解除后不得再注入任何该次挂用的副本");
  assert.deepEqual(await listAssetMounts(USER), [], "挂用记录必须真的移除");
});

test("D1(b) 挂→来源包追加条目→挂（补建新副本）→解：记录里的清单必须跟上补建的副本", async () => {
  reset();
  await saveAssetPack(USER, pack("pack-src", [promptItem("提示A", "内容A")]));
  const first = await mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "pack", assetId: "pack-src", now: AT });
  let cardIds = applyCopyLockChange([], { locked: first.localCopyIds, unlocked: [] });

  // 来源追加条目后**重挂**（幂等键不变）：既有副本保留、缺的那张补建 → 也必须进记录清单。
  await saveAssetPack(USER, pack("pack-src", [promptItem("提示A", "内容A"), promptItem("提示B", "内容B")]));
  const replay = await mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "pack", assetId: "pack-src", now: AT2 });
  assert.equal(replay.created, false, "同键必须是幂等重放");
  assert.equal(replay.copied, true, "缺的那张要补建（逐项收敛）");
  assert.deepEqual(replay.localCopyIds, [
    assetPackItemCopyId("proj-b", "pack-src", 0),
    assetPackItemCopyId("proj-b", "pack-src", 1),
  ]);
  const record = (await listAssetMounts(USER))[0];
  assert.deepEqual(
    record.cardCopyIds,
    [assetPackItemCopyId("proj-b", "pack-src", 0), assetPackItemCopyId("proj-b", "pack-src", 1)],
    "挂用记录的 cardCopyIds 必须是联集（否则解除只解得到第一次那张）",
  );
  cardIds = applyCopyLockChange(cardIds, { locked: replay.localCopyIds, unlocked: [] });

  const del = await unmountAssetAndCopies({ userId: USER, projectId: "proj-b", assetKind: "pack", assetId: "pack-src" });
  assert.deepEqual(del.localCopyIds, [
    del.localCopyId,
    assetPackItemCopyId("proj-b", "pack-src", 0),
    assetPackItemCopyId("proj-b", "pack-src", 1),
  ]);
  assert.equal(await injectedAfterUnmount(cardIds, del.localCopyIds, "proj-b"), "base");
});

test("D1(c) 不改来源：挂包→删掉本地包副本→解——DELETE 必须回全部实际锁过的副本（验收官原 repro）", async () => {
  reset();
  await saveAssetPack(USER, pack("pack-src", [promptItem("提示A", "内容A"), promptItem("提示B", "内容B")]));
  const mounted = await mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "pack", assetId: "pack-src", now: AT });
  const cardIds = applyCopyLockChange([], { locked: mounted.localCopyIds, unlocked: [] });
  assert.equal((await injectedAfterUnmount(cardIds, [], "proj-b")).includes("内容B"), true);

  // 使用者把本地包副本删掉（UI 可达：资产包列表可删自己的包）
  await deleteAssetPacks(USER, [mounted.localCopyId]);
  assert.equal((await listAssetPacks(USER)).filter((p) => p.id === mounted.localCopyId).length, 0, "前置：本地包副本真的没了");

  const del = await unmountAssetAndCopies({ userId: USER, projectId: "proj-b", assetKind: "pack", assetId: "pack-src" });
  assert.deepEqual(
    del.localCopyIds,
    [mounted.localCopyId, assetPackItemCopyId("proj-b", "pack-src", 0), assetPackItemCopyId("proj-b", "pack-src", 1)],
    "旧版只回 [packCopy] → 两张条目副本永远留在 cardIds（永久无法自愈）；现在必须回全部",
  );
  assert.equal(await injectedAfterUnmount(cardIds, del.localCopyIds, "proj-b"), "base", "解除后生成不再注入任何该次挂用的副本");
  // 副本回收：卡库不得再留该次挂用的副本（额度即刻释放）
  const remaining = await listCharacterCards(USER);
  for (const id of [assetPackItemCopyId("proj-b", "pack-src", 0), assetPackItemCopyId("proj-b", "pack-src", 1)]) {
    assert.equal(remaining.some((c) => c.id === id), false, `解除后副本卡 ${id} 必须回收（不留静默占额度）`);
  }
});

test("D1 卡挂用：记录落盘 cardCopyIds，解除回同一份；legacy 记录（无清单）仍回退旧推导", async () => {
  reset();
  await saveCharacterCard(USER, card("card-src"));
  const res = await mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-src", now: AT });
  assert.deepEqual((await listAssetMounts(USER))[0].cardCopyIds, [res.localCopyId]);
  assert.deepEqual(await mountCopyIds({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-src" }), {
    localCopyId: res.localCopyId,
    localCopyIds: [res.localCopyId],
  });

  // legacy：手写一笔没有 cardCopyIds 的包挂用记录（旧世代资料）→ 回退「按本地包副本条目推导」。
  reset();
  await saveAssetPack(USER, pack("pack-src", [promptItem("提示A", "内容A")]));
  const legacyLocalPack = assetPackLocalCopyId("proj-c", "pack-src");
  await saveAssetPack(USER, {
    ...(await listAssetPacks(USER)).find((p) => p.id === "pack-src")!,
    id: legacyLocalPack,
    scope: { owner: "project", projectId: "proj-c" },
  });
  await mountAsset(USER, {
    projectId: "proj-c",
    assetKind: "pack",
    assetId: "pack-src",
    now: AT,
  });
  const legacy = await mountCopyIds({ userId: USER, projectId: "proj-c", assetKind: "pack", assetId: "pack-src" });
  assert.equal(legacy.localCopyId, legacyLocalPack);
  assert.deepEqual(legacy.localCopyIds, [legacyLocalPack, assetPackItemCopyId("proj-c", "pack-src", 0)], "legacy 记录回退旧推导（向后相容）");
});

// ─────────────────────────────────────────── D2 深环

test("D2 深环（6 跳）必须被侦测且零副作用；3 跳照旧拒绝（反向对照）", async () => {
  reset();
  // 6 跳真环：a → b → c → d → e → f → a（a 是自己的祖先）
  const chain = ["card-a", "card-b", "card-c", "card-d", "card-e", "card-f"];
  for (let i = 0; i < chain.length; i += 1) {
    const next = chain[(i + 1) % chain.length];
    await saveCharacterCard(USER, card(chain[i], { lineage: [{ kind: "derivation", assetId: next, at: AT }] }));
  }
  await assert.rejects(
    () => mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-a", now: AT }),
    AssetMountCopyRejectedError,
    "6 跳真环必须被拒（旧版 maxDepth=5 会漏检 → 真的建出副本）",
  );
  assert.equal((await listAssetMounts(USER)).length, 0, "拒绝路径不得留下挂用记录");
  assert.equal(
    (await listCharacterCards(USER)).filter((c) => c.scope?.projectId === "proj-b").length,
    0,
    "拒绝路径不得建副本",
  );

  // 反向对照：3 跳环（旧版就能抓）不得因此误放行，也不得被新实作改成别的理由。
  reset();
  await saveCharacterCard(USER, card("card-x", { lineage: [{ kind: "derivation", assetId: "card-y", at: AT }] }));
  await saveCharacterCard(USER, card("card-y", { lineage: [{ kind: "derivation", assetId: "card-z", at: AT }] }));
  await saveCharacterCard(USER, card("card-z", { lineage: [{ kind: "derivation", assetId: "card-x", at: AT }] }));
  await assert.rejects(
    () => mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-x", now: AT }),
    (error: unknown) => error instanceof AssetMountCopyRejectedError && error.reason === "cyclic_lineage",
  );

  // 对照：非环的深链（6 跳但不成环）必须照常挂用——证明「拒绝」来自环而不是深度。
  reset();
  for (let i = 0; i < chain.length; i += 1) {
    const next = i + 1 < chain.length ? chain[i + 1] : undefined;
    await saveCharacterCard(USER, card(chain[i], next ? { lineage: [{ kind: "derivation", assetId: next, at: AT }] } : {}));
  }
  const deep = await mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-a", now: AT });
  assert.equal(deep.copied, true, "6 跳非环必须可挂用（完整遍历不改语义，只补上漏检）");

  // 超界 fail-closed：预算不够走完 → 拒绝并回可辨识原因（绝不「查不完就当没环」）+ 零副作用。
  reset();
  for (let i = 0; i < chain.length; i += 1) {
    const next = i + 1 < chain.length ? chain[i + 1] : undefined;
    await saveCharacterCard(USER, card(chain[i], next ? { lineage: [{ kind: "derivation", assetId: next, at: AT }] } : {}));
  }
  await assert.rejects(
    () => mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-a", now: AT, ancestorNodeBudget: 2 }),
    (error: unknown) => error instanceof AssetMountCopyRejectedError && error.reason === "unbounded_lineage",
    "血统图超出可完整遍历的界限 → 拒绝（fail-closed），不是预设无环",
  );
  assert.equal((await listAssetMounts(USER)).length, 0, "超界拒绝路径不得留下挂用记录");
  assert.equal(
    (await listCharacterCards(USER)).filter((c) => c.scope?.projectId === "proj-b").length,
    0,
    "超界拒绝路径不得建副本",
  );
  // 遍历本身的行为：预算内的节点收齐、超出时明确回报 truncated（不是静默截断成「无环」）。
  const traverse = collectAncestorAssetIds(
    [{ kind: "derivation", assetId: "n0", at: AT }],
    (id) => (id === "n0" ? [{ kind: "derivation", assetId: "n1", at: AT }] : []),
    { maxNodes: 1 },
  );
  assert.equal(traverse.truncated, true);
  assert.deepEqual(traverse.ids, ["n0"]);
});

// ─────────────────────────────────────────── D4 幂等重放优先于环路守卫

test("D4 既有挂用记录查询排在环路守卫之前：来源血统事后被编辑成含副本 id，重挂仍回既有结果", async () => {
  reset();
  await saveCharacterCard(USER, card("card-src"));
  const first = await mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-src", now: AT });
  assert.equal(first.copied, true);
  const copyId = first.localCopyId;

  // 事后血统编辑：把「本次副本 id」写进来源的 lineage（UI 可达：血统抽屉/入库编辑）
  await saveCharacterCard(USER, card("card-src", { lineage: [{ kind: "derivation", assetId: copyId, at: AT2 }] }));
  assert.equal((await listCharacterCards(USER)).find((c) => c.id === "card-src")?.lineage?.[0].assetId, copyId, "前置：血统编辑真的落盘");

  const replay = await mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-src", now: AT2 });
  assert.equal(replay.created, false, "既有记录 → 幂等重放");
  assert.equal(replay.copied, false, "不得重建副本");
  assert.equal(replay.localCopyId, copyId, "必须回既有副本");
  assert.equal((await listAssetMounts(USER)).length, 1, "不得新增第二笔记录");

  // 反向对照：**没有**既有记录时，同样的血统编辑必须照样被环路守卫拒绝（守卫没被弱化）。
  reset();
  await saveCharacterCard(USER, card("card-new"));
  await saveCharacterCard(USER, card("card-new2", { lineage: [{ kind: "derivation", assetId: assetLocalCopyId("proj-b", "card", "card-new2"), at: AT }] }));
  await assert.rejects(
    () => mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-new2", now: AT }),
    (error: unknown) => error instanceof AssetMountCopyRejectedError && error.reason === "cyclic_lineage",
    "首次挂用的环路守卫一条不少",
  );
});

// ─────────────────────────────────────────── D5 内部副本 / 额度诚实

test("D5 内部副本不得曝露为可挂用条目：库列表/挂用闸都不放行，且来源仍标『已挂用』", async () => {
  reset();
  await saveAssetPack(USER, pack("pack-src", [promptItem("提示A", "内容A")]));
  await saveCharacterCard(USER, card("card-src", { scope: { owner: "project", projectId: "proj-a" } }));
  const packMount = await mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "pack", assetId: "pack-src", now: AT });
  const cardMount = await mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-src", now: AT });

  const lib = await listProjectAssetLibrary({ userId: USER, projectId: "proj-b" });
  const ids = lib.items.map((i) => i.assetId);
  // 反向对照：库里确实有东西（否则下面的「不含副本」是空的）
  assert.ok(ids.includes("pack-src"), "来源包必须在列表里");
  for (const copyId of [packMount.localCopyId, cardMount.localCopyId, ...packMount.localCopyIds]) {
    assert.equal(ids.includes(copyId), false, `内部副本 ${copyId} 不得列为可挂用条目`);
  }
  assert.equal(lib.items.find((i) => i.assetId === "pack-src")?.mounted, true, "来源仍标『已挂用』（状态真相在挂用记录）");

  // 挂用闸：副本直接不可挂（函式层与路由同源）
  assert.equal(await resolveMountable({ userId: USER, projectId: "proj-b", assetKind: "pack", assetId: packMount.localCopyId }), null);
  assert.equal(await resolveMountable({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: cardMount.localCopyId }), null);
  assert.ok(await resolveMountable({ userId: USER, projectId: "proj-b", assetKind: "pack", assetId: "pack-src" }), "来源照样可挂用");

  // 直接呼叫（绕过闸）也只能得到「与来源无关的另一份副本」——判据证明它认得出副本家族
  assert.equal(isAssetLocalCopyId(packMount.localCopyIds[0]), true);
});

test("D5 额度诚实：解除会回收副本（卡片数回落），不再静默占额度；来源删除后不留僵尸", async () => {
  reset();
  await saveAssetPack(USER, pack("pack-src", [promptItem("提示A", "内容A"), promptItem("提示B", "内容B")]));
  const before = (await listCharacterCards(USER)).length;
  const mounted = await mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "pack", assetId: "pack-src", now: AT });
  assert.equal((await listCharacterCards(USER)).length, before + 2, "挂用落了 2 张副本卡（占额度，诚实可见）");

  const del = await unmountAssetAndCopies({ userId: USER, projectId: "proj-b", assetKind: "pack", assetId: "pack-src" });
  assert.equal(del.deletedCards, 2, "解除必须回报实际回收的副本卡数");
  assert.equal(del.deletedPacks, 1, "本地包副本也要回收");
  assert.equal((await listCharacterCards(USER)).length, before, "解除后卡片数回落到挂用前（额度即刻释放）");
  assert.equal((await listAssetPacks(USER)).some((p) => p.id === mounted.localCopyId), false);

  // 僵尸路径：挂用 → 删来源 → 解除；不得留下「卡片总数 > 0、挂用记录 = 0」的不可解释残留。
  await saveCharacterCard(USER, card("card-zombie"));
  const cardMount = await mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-zombie", now: AT });
  assert.equal(await deleteCharacterCards(USER, ["card-zombie"]), 1, "来源卡被真的删掉");
  const del2 = await unmountAssetAndCopies({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-zombie" });
  assert.equal(del2.localCopyId, cardMount.localCopyId);
  assert.equal((await listCharacterCards(USER)).some((c) => c.id === cardMount.localCopyId), false, "来源删除后解除不得留僵尸副本");
  assert.deepEqual(await listAssetMounts(USER), []);
});

// ─────────────────────────────────────────── 口径修正：运行时自足

test("口径修正·运行时自足：副本的 lineage 边**可以**指向别的 project，但副本不被外部 project 状态决定", async () => {
  reset();
  // 来源属于 proj-a（**别的** project），副本落在 proj-b → derivation 边跨 project（事实，不是违规）
  await saveCharacterCard(USER, card("card-src", { scope: { owner: "project", projectId: "proj-a" }, prompt: "来源内容" }));
  const res = await mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-src", now: AT });
  const copy = (await listCharacterCards(USER)).find((c) => c.id === res.localCopyId);
  assert.ok(copy);
  assert.deepEqual(
    (copy.lineage ?? []).map((l) => [l.kind, l.assetId]),
    [["derivation", "card-src"]],
    "反向对照：边确实指向别的 project 的来源（所以「lineage 永不跨 project」这句话本身是错的口径）",
  );
  assert.equal(copy.scope?.projectId, "proj-b", "副本归属目标项目");

  // 删来源卡 + 删来源项目的所有资产（模拟「来源项目被清空/删除」）→ 副本逐位不变、仍可见可用
  const snapshot = { prompt: copy.prompt, scope: copy.scope, lineage: copy.lineage };
  await deleteCharacterCards(USER, ["card-src"]);
  await deleteAssetPacks(USER, (await listAssetPacks(USER)).map((p) => p.id));
  const after = (await listCharacterCards(USER)).find((c) => c.id === res.localCopyId);
  assert.ok(after, "副本必须还在（不依赖外部 project 的存在）");
  assert.deepEqual({ prompt: after.prompt, scope: after.scope, lineage: after.lineage }, snapshot, "外部状态改变不得动副本本体");
  assert.equal(
    filterLockedCardsForProjectUse([after], { projectId: "proj-b", shares: [] }).length,
    1,
    "副本在目标项目的读取闸仍放行（生成可用）",
  );
  assert.ok(String(applyCharacterCardsToPayload({ prompt: "base" }, [after]).prompt).includes("来源内容"));
  assert.deepEqual(await filterCardIdsForProject({ userId: USER, projectId: "proj-b", cardIds: [after.id] }), [after.id]);
});

test("回收顺序·重试收敛：副本已删而挂用记录还在（模拟半途而废）→ 解除必须仍收掉记录、不炸、不再删", async () => {
  reset();
  // 挂卡 → 直接删副本卡（＝新顺序下「副本已删、记录未删」的崩溃窗口态）
  await saveCharacterCard(USER, card("card-o", { prompt: "来源内容" }));
  const mounted = await mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-o", now: AT });
  await deleteCharacterCards(USER, [mounted.localCopyId]);
  assert.equal((await listAssetMounts(USER)).length, 1, "崩溃窗口：记录还在");

  // 重试收敛：解除不炸、记录必被收掉、deletedCards 诚实回 0（副本已不在，不凭空捏数）
  const retry = await unmountAssetAndCopies({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-o" });
  assert.equal(retry.removed, true, "记录必须被收掉（顺序契约：记录最后删，任何前置失败都可重试）");
  assert.equal(retry.deletedCards, 0, "副本已不存在，不得虚报删除数");
  assert.deepEqual(await listAssetMounts(USER), [], "无残留记录");

  // 幂等：再解除一次＝空转 no-op
  const again = await unmountAssetAndCopies({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-o" });
  assert.equal(again.removed, false);
  assert.equal(again.deletedCards, 0);
});
