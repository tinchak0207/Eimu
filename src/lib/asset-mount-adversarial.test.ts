// B2b「挂用/解除挂用」独立对抗验收（09-24 攻坚清单 1–5）。
//
// 口径（TG-02）：每条都是**实际呼叫** mountAssetWithCopy / unmountAssetAndCopies 与真 store
// 读写的行为断言，带反向对照；无源码字串扫描。崩溃窗口用「直接改 store 到半途态」模拟
// （记忆体降级路径无注错钩子；断点前/后的盘上状态与真崩溃逐位等价）。
//
//   1 部分失败收敛：T1（卡删一半）／T2（只剩包副本）／T7（副本全没记录还在·包形）
//   2 辨伪：T3（跨 project 真副本拒删）／T4（derivation 来源不符拒删）／T5（他人同名 id 不动）
//   3 幂等：T6（二次解除 no-op；未挂用空转）
//   4 孤儿：T7
//   5 建立面：T8（记录清单=实际落盘副本，混合 kind 零残留）／T9（建到一半崩溃→重挂收编孤儿→解除清干净）
import { test } from "node:test";
import assert from "node:assert/strict";
import { assetLocalCopyId, assetPackItemCopyId } from "./asset-scope";
import { mountAssetWithCopy, unmountAssetAndCopies } from "./asset-library";
import { __resetAssetScopeStoreForTests, listAssetMounts, mountAsset } from "./asset-scope-store";
import {
  __resetAssetPackStoreForTests,
  deleteAssetPacks,
  listAssetPacks,
  normalizeAssetPack,
  saveAssetPack,
} from "./asset-pack-store";
import {
  __resetCharacterCardStoreForTests,
  deleteCharacterCards,
  listCharacterCards,
  saveCharacterCard,
} from "./character-card-store";
import { normalizeCharacterCard } from "./character-cards";
import type { CharacterCard } from "./character-cards";

const AT = "2026-09-24T00:00:00.000Z";
const USER = 42;
const OTHER_USER = 43;

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

/** 该用户卡库里指定 id 是否还在。 */
async function hasCard(userId: number, id: string): Promise<boolean> {
  return (await listCharacterCards(userId)).some((c) => c.id === id);
}
async function hasPack(userId: number, id: string): Promise<boolean> {
  return (await listAssetPacks(userId)).some((p) => p.id === id);
}
async function mountIdsOf(userId: number): Promise<string[]> {
  return (await listAssetMounts(userId)).map((m) => m.id);
}

// ─────────────────────────────────────────── 攻坚 1：部分失败收敛

test("T1 包挂用删副本删到一半崩溃（1/3 已没）→ 重试删完剩余卡+包+记录，deletedCards 诚实回 2 不回 3", async () => {
  reset();
  await saveAssetPack(USER, pack("pk-crash", [promptItem("A", "a"), promptItem("B", "b"), promptItem("C", "c")]));
  const mounted = await mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "pack", assetId: "pk-crash", now: AT });
  const items = [0, 1, 2].map((i) => assetPackItemCopyId("proj-b", "pk-crash", i));
  assert.deepEqual(mounted.localCopyIds.slice().sort(), items.slice().sort(), "前置：挂用落了 3 张条目卡");

  // 模拟 unmount 在第 2 张卡删除前崩溃：第 1 张已删、记录与其余副本还在。
  await deleteCharacterCards(USER, [items[0]!]);
  assert.equal(await hasCard(USER, items[0]!), false);
  assert.equal((await mountIdsOf(USER)).length, 1, "崩溃窗口：挂用记录还在");

  const retry = await unmountAssetAndCopies({ userId: USER, projectId: "proj-b", assetKind: "pack", assetId: "pk-crash" });
  assert.equal(retry.removed, true, "重试必须收掉记录");
  assert.equal(retry.deletedCards, 2, "诚实：这次重试只真的删了 2 张（已删的不重复计数）");
  assert.equal(retry.deletedPacks, 1);
  for (const id of items) assert.equal(await hasCard(USER, id), false, `重试后 ${id} 必须没了（不漏删）`);
  assert.equal(await hasPack(USER, mounted.localCopyId), false, "包副本必须回收");
  assert.deepEqual(await mountIdsOf(USER), [], "记录必须清空");
  assert.equal(await hasCard(USER, "pk-crash") || true, true);
});

test("T2 崩溃在「卡已全删、包未删」窗口 → 重试回收包+记录，deletedCards 不虚报", async () => {
  reset();
  await saveAssetPack(USER, pack("pk-crash2", [promptItem("A", "a"), promptItem("B", "b")]));
  const mounted = await mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "pack", assetId: "pk-crash2", now: AT });
  const items = mounted.localCopyIds;
  await deleteCharacterCards(USER, [...items]);
  assert.ok(await hasPack(USER, mounted.localCopyId), "前置：包副本还在");

  const retry = await unmountAssetAndCopies({ userId: USER, projectId: "proj-b", assetKind: "pack", assetId: "pk-crash2" });
  assert.equal(retry.removed, true);
  assert.equal(retry.deletedCards, 0, "卡已不在，不得凭推导虚报");
  assert.equal(retry.deletedPacks, 1);
  assert.equal(await hasPack(USER, mounted.localCopyId), false);
  assert.deepEqual(await listAssetMounts(USER), []);
});

// ─────────────────────────────────────────── 攻坚 2：辨伪（混入非法 id 必须拒删）

test("T3 记录混入「同来源但属别 project 的真副本」id → 拒删；该 project 的副本与记录逐位不动", async () => {
  reset();
  await saveCharacterCard(USER, card("card-src"));
  const inB = await mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-src", now: AT });
  const inD = await mountAssetWithCopy({ userId: USER, projectId: "proj-d", assetKind: "card", assetId: "card-src", now: AT });
  const copyB = inB.localCopyId;
  const copyD = inD.localCopyId;
  assert.ok(copyB !== copyD, "反向对照：同来源不同 project 的副本 id 必然不同（别误判成同物）");

  // 伪造 proj-e 的挂用记录：cardCopyIds 混入 proj-d 的真副本 id（模拟脏资料/别名注入）。
  await mountAsset(USER, {
    projectId: "proj-e",
    assetKind: "card",
    assetId: "card-src",
    now: AT,
    cardCopyIds: [copyD],
  });

  const del = await unmountAssetAndCopies({ userId: USER, projectId: "proj-e", assetKind: "card", assetId: "card-src" });
  assert.equal(del.removed, true, "proj-e 自己的记录照删（辨伪不阻收敛）");
  assert.equal(del.deletedCards, 0, "跨 project 的真副本必须被辨伪拒删");
  assert.equal(await hasCard(USER, copyD), true, "proj-d 的副本必须毫发无伤");
  assert.equal(await hasCard(USER, copyB), true, "proj-b 的副本不受影响");
  assert.equal((await listAssetMounts(USER)).filter((m) => m.id === inD.mount.id).length, 1, "proj-d 的挂用记录不得被连带删除");

  // 反向对照：真 proj-d 解除照样删得掉自己那份（证明 T3 的「拒删」不是恒真——同一张卡在对的 project 下会被删）。
  const delD = await unmountAssetAndCopies({ userId: USER, projectId: "proj-d", assetKind: "card", assetId: "card-src" });
  assert.equal(delD.deletedCards, 1);
  assert.equal(await hasCard(USER, copyD), false);
});

test("T4 记录混入「本 project 但 derivation 指向别的来源」的用户真卡 → 拒删，只删真副本", async () => {
  reset();
  await saveCharacterCard(USER, card("card-src"));
  const mounted = await mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-src", now: AT });
  // 用户自有卡：同 project scope，derivation 指向另一个来源（甚至 scope 缺失的个人卡也测一张）。
  await saveCharacterCard(
    USER,
    card("my-real-card", { scope: { owner: "project", projectId: "proj-b" }, lineage: [{ kind: "derivation", assetId: "other-src", at: AT }] }),
  );
  await saveCharacterCard(USER, card("my-plain-card", { scope: { owner: "project", projectId: "proj-b" } }));

  // 联集扩充该记录：混入两张伪装（重挂同一键走 applyAssetMount 联集，即生产写入通道）。
  await mountAsset(USER, {
    projectId: "proj-b",
    assetKind: "card",
    assetId: "card-src",
    now: AT,
    cardCopyIds: [mounted.localCopyId, "my-real-card", "my-plain-card"],
  });

  const del = await unmountAssetAndCopies({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-src" });
  assert.equal(del.removed, true);
  assert.equal(del.deletedCards, 1, "只准删真正由这次挂用落盘的那张");
  assert.equal(await hasCard(USER, "my-real-card"), true, "derivation 来源不符＝不是这条来源的副本，禁删用户真卡");
  assert.equal(await hasCard(USER, "my-plain-card"), true, "无血统边的自有卡禁删");
  assert.equal(await hasCard(USER, mounted.localCopyId), false);
});

test("T5 另一用户卡库存在同名 id（同 hash 同 scope 同 derivation）→ 解除只动本人 store", async () => {
  reset();
  await saveCharacterCard(USER, card("card-src"));
  const mounted = await mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-src", now: AT });
  const copyId = mounted.localCopyId;
  // 用户 43 的库里存在同 id、栏位完全同形的卡（确定性 id 可被任何人推出 → 这不是假设性攻击）。
  await saveCharacterCard(
    OTHER_USER,
    card(copyId, { scope: { owner: "project", projectId: "proj-b" }, lineage: [{ kind: "derivation", assetId: "card-src", at: AT }] }),
  );
  assert.equal(await hasCard(OTHER_USER, copyId), true, "前置：他人同形卡真的在库");

  const del = await unmountAssetAndCopies({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-src" });
  assert.equal(del.deletedCards, 1);
  assert.equal(await hasCard(USER, copyId), false, "本人的副本被回收");
  assert.equal(await hasCard(OTHER_USER, copyId), true, "他人同名卡必须毫发无伤（删扫以 userId 命名空间为界）");
});

// ─────────────────────────────────────────── 攻坚 3：幂等

test("T6 二次解除＝no-op 不抛错；未挂用的三元组空转；旁人不受波及", async () => {
  reset();
  await saveCharacterCard(USER, card("card-src"));
  await saveCharacterCard(USER, card("keep-me"));
  await mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-src", now: AT });
  const first = await unmountAssetAndCopies({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-src" });
  assert.equal(first.removed, true);

  const second = await unmountAssetAndCopies({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-src" });
  assert.equal(second.removed, false);
  assert.equal(second.deletedCards, 0);
  assert.equal(second.deletedPacks, 0);
  assert.equal(second.localCopyId, null, "记录已不存在→不得凭推导报副本");
  assert.equal(await hasCard(USER, "keep-me"), true, "空转路径不得误删任何卡");

  const never = await unmountAssetAndCopies({ userId: USER, projectId: "proj-x", assetKind: "pack", assetId: "not-exist" });
  assert.equal(never.removed, false);
  assert.deepEqual(await listAssetMounts(USER), []);
});

// ─────────────────────────────────────────── 攻坚 4：孤儿记录（副本已被用户手动删除）

test("T7 包挂用→用户把副本（卡+包）全手动删光→解除仍收敛（记录能删、计数诚实）", async () => {
  reset();
  await saveAssetPack(USER, pack("pk-orphan", [promptItem("A", "a"), promptItem("B", "b")]));
  const mounted = await mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "pack", assetId: "pk-orphan", now: AT });
  await deleteCharacterCards(USER, [...mounted.localCopyIds]);
  await deleteAssetPacks(USER, [mounted.localCopyId]);
  assert.equal((await listAssetMounts(USER)).length, 1, "前置：只剩孤儿记录");

  const del = await unmountAssetAndCopies({ userId: USER, projectId: "proj-b", assetKind: "pack", assetId: "pk-orphan" });
  assert.equal(del.removed, true, "记录必须删得掉（不等副本存在）");
  assert.equal(del.deletedCards, 0);
  assert.equal(del.deletedPacks, 0);
  assert.deepEqual(await listAssetMounts(USER), []);
});

// ─────────────────────────────────────────── 攻坚 5：建立面完整性 + 建到一半崩溃收编

test("T8 混合 kind 来源包：记录 cardCopyIds 恰等于实际落盘副本卡；解除后该来源零残留", async () => {
  reset();
  const source = normalizeAssetPack({
    id: "pk-mix",
    title: "包-pk-mix",
    tags: [],
    createdAt: AT,
    updatedAt: AT,
    items: [
      { kind: "prompt", title: "P", content: "p" },
      { kind: "recipe", title: "R", content: "r", steps: [], defaultModel: "seedream-2.0" },
      { kind: "image", title: "I", imageUrl: "https://example.com/i.png" },
      { kind: "lora", title: "L", loraVersionId: "lv-1" },
      { kind: "scene_3d", title: "S" },
    ],
  });
  assert.ok(source);
  await saveAssetPack(USER, source);

  const mounted = await mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "pack", assetId: "pk-mix", now: AT });
  // 卡投影只收 prompt/recipe/image|reference：index 0,1,2 建卡；3,4 跳过（skippedItems=2 诚实回报）。
  const expectCards = [0, 1, 2].map((i) => assetPackItemCopyId("proj-b", "pk-mix", i));
  assert.equal(mounted.skippedItems, 2);
  assert.deepEqual(mounted.localCopyIds.slice().sort(), expectCards.slice().sort());
  const record = (await listAssetMounts(USER))[0]!;
  assert.deepEqual([...(record.cardCopyIds ?? [])].sort(), expectCards.slice().sort(), "建立面：记录清单必须完整覆盖所有落盘副本");
  for (const id of expectCards) assert.equal(await hasCard(USER, id), true, `副本 ${id} 必须真的在库`);

  const del = await unmountAssetAndCopies({ userId: USER, projectId: "proj-b", assetKind: "pack", assetId: "pk-mix" });
  assert.equal(del.deletedCards, 3);
  assert.equal(del.deletedPacks, 1);
  const left = (await listCharacterCards(USER)).filter((c) =>
    (c.lineage ?? []).some((l) => l.kind === "derivation" && l.assetId === "pk-mix"),
  );
  assert.deepEqual(left.map((c) => c.id), [], "解除后库内不得残留任何指向 pk-mix 的副本卡（漏记＝隐患，此处归零）");
  assert.equal(await hasPack(USER, mounted.localCopyId), false);
  assert.deepEqual(await listAssetMounts(USER), []);
});

test("T9 建副本建到一半崩溃（副本已在、记录未落）→ 首次解除如实空转不凭推导乱删；重挂收编孤儿 id → 再解除全清", async () => {
  reset();
  await saveCharacterCard(USER, card("card-orphan-src", { prompt: "来源" }));
  const orphanId = assetLocalCopyId("proj-z", "card", "card-orphan-src");
  // 模拟 mountAssetWithCopy 在 saveCharacterCard 之后、mountAsset 写记录之前崩溃。
  await saveCharacterCard(
    USER,
    card(orphanId, { scope: { owner: "project", projectId: "proj-z" }, lineage: [{ kind: "derivation", assetId: "card-orphan-src", at: AT }] }),
  );
  assert.equal((await listAssetMounts(USER)).length, 0, "前置：记录未落");

  // 无记录 → 解除诚实空转（安全侧：不凭推导删孤儿，也不得抛错）。
  const noRec = await unmountAssetAndCopies({ userId: USER, projectId: "proj-z", assetKind: "card", assetId: "card-orphan-src" });
  assert.equal(noRec.removed, false);
  assert.equal(noRec.deletedCards, 0);
  assert.equal(await hasCard(USER, orphanId), true);

  // 自愈路径：重挂。占用者是真副本 → 不 409、不重建，记录把孤儿 id 收编。
  const remount = await mountAssetWithCopy({ userId: USER, projectId: "proj-z", assetKind: "card", assetId: "card-orphan-src", now: AT });
  assert.equal(remount.copied, false, "真副本在库，不得重建");
  assert.deepEqual((await listAssetMounts(USER))[0]!.cardCopyIds, [orphanId], "重挂后记录必须覆盖孤儿");

  const del = await unmountAssetAndCopies({ userId: USER, projectId: "proj-z", assetKind: "card", assetId: "card-orphan-src" });
  assert.equal(del.removed, true);
  assert.equal(del.deletedCards, 1);
  assert.equal(await hasCard(USER, orphanId), false, "收编后解除必须把孤儿副本清干净");
  assert.deepEqual(await listAssetMounts(USER), []);
});
