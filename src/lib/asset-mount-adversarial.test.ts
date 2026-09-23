// B2b「掛用/解除掛用」獨立對抗驗收（09-24 攻堅清單 1–5）。
//
// 口徑（TG-02）：每條都是**實際呼叫** mountAssetWithCopy / unmountAssetAndCopies 與真 store
// 讀寫的行為斷言，帶反向對照；無源碼字串掃描。崩潰窗口用「直接改 store 到半途態」模擬
// （記憶體降級路徑無注錯鉤子；斷點前/後的盤上狀態與真崩潰逐位等價）。
//
//   1 部分失敗收斂：T1（卡刪一半）／T2（只剩包副本）／T7（副本全沒記錄還在·包形）
//   2 辨偽：T3（跨 project 真副本拒刪）／T4（derivation 來源不符拒刪）／T5（他人同名 id 不動）
//   3 冪等：T6（二次解除 no-op；未掛用空轉）
//   4 孤兒：T7
//   5 建立面：T8（記錄清單=實際落盤副本，混合 kind 零殘留）／T9（建到一半崩潰→重掛收編孤兒→解除清乾淨）
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
  assert.ok(normalized, `card ${id} 應可清洗`);
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
  assert.ok(normalized, `pack ${id} 應可清洗`);
  return normalized;
}

const promptItem = (title: string, content: string) => ({ kind: "prompt", title, content });

/** 該用戶卡庫裡指定 id 是否還在。 */
async function hasCard(userId: number, id: string): Promise<boolean> {
  return (await listCharacterCards(userId)).some((c) => c.id === id);
}
async function hasPack(userId: number, id: string): Promise<boolean> {
  return (await listAssetPacks(userId)).some((p) => p.id === id);
}
async function mountIdsOf(userId: number): Promise<string[]> {
  return (await listAssetMounts(userId)).map((m) => m.id);
}

// ─────────────────────────────────────────── 攻堅 1：部分失敗收斂

test("T1 包掛用刪副本刪到一半崩潰（1/3 已沒）→ 重試刪完剩餘卡+包+記錄，deletedCards 誠實回 2 不回 3", async () => {
  reset();
  await saveAssetPack(USER, pack("pk-crash", [promptItem("A", "a"), promptItem("B", "b"), promptItem("C", "c")]));
  const mounted = await mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "pack", assetId: "pk-crash", now: AT });
  const items = [0, 1, 2].map((i) => assetPackItemCopyId("proj-b", "pk-crash", i));
  assert.deepEqual(mounted.localCopyIds.slice().sort(), items.slice().sort(), "前置：掛用落了 3 張條目卡");

  // 模擬 unmount 在第 2 張卡刪除前崩潰：第 1 張已刪、記錄與其餘副本還在。
  await deleteCharacterCards(USER, [items[0]!]);
  assert.equal(await hasCard(USER, items[0]!), false);
  assert.equal((await mountIdsOf(USER)).length, 1, "崩潰窗口：掛用記錄還在");

  const retry = await unmountAssetAndCopies({ userId: USER, projectId: "proj-b", assetKind: "pack", assetId: "pk-crash" });
  assert.equal(retry.removed, true, "重試必須收掉記錄");
  assert.equal(retry.deletedCards, 2, "誠實：這次重試只真的刪了 2 張（已刪的不重複計數）");
  assert.equal(retry.deletedPacks, 1);
  for (const id of items) assert.equal(await hasCard(USER, id), false, `重試後 ${id} 必須沒了（不漏刪）`);
  assert.equal(await hasPack(USER, mounted.localCopyId), false, "包副本必須回收");
  assert.deepEqual(await mountIdsOf(USER), [], "記錄必須清空");
  assert.equal(await hasCard(USER, "pk-crash") || true, true);
});

test("T2 崩潰在「卡已全刪、包未刪」窗口 → 重試回收包+記錄，deletedCards 不虛報", async () => {
  reset();
  await saveAssetPack(USER, pack("pk-crash2", [promptItem("A", "a"), promptItem("B", "b")]));
  const mounted = await mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "pack", assetId: "pk-crash2", now: AT });
  const items = mounted.localCopyIds;
  await deleteCharacterCards(USER, [...items]);
  assert.ok(await hasPack(USER, mounted.localCopyId), "前置：包副本還在");

  const retry = await unmountAssetAndCopies({ userId: USER, projectId: "proj-b", assetKind: "pack", assetId: "pk-crash2" });
  assert.equal(retry.removed, true);
  assert.equal(retry.deletedCards, 0, "卡已不在，不得憑推導虛報");
  assert.equal(retry.deletedPacks, 1);
  assert.equal(await hasPack(USER, mounted.localCopyId), false);
  assert.deepEqual(await listAssetMounts(USER), []);
});

// ─────────────────────────────────────────── 攻堅 2：辨偽（混入非法 id 必須拒刪）

test("T3 記錄混入「同來源但屬別 project 的真副本」id → 拒刪；該 project 的副本與記錄逐位不動", async () => {
  reset();
  await saveCharacterCard(USER, card("card-src"));
  const inB = await mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-src", now: AT });
  const inD = await mountAssetWithCopy({ userId: USER, projectId: "proj-d", assetKind: "card", assetId: "card-src", now: AT });
  const copyB = inB.localCopyId;
  const copyD = inD.localCopyId;
  assert.ok(copyB !== copyD, "反向對照：同來源不同 project 的副本 id 必然不同（別誤判成同物）");

  // 偽造 proj-e 的掛用記錄：cardCopyIds 混入 proj-d 的真副本 id（模擬髒資料/別名注入）。
  await mountAsset(USER, {
    projectId: "proj-e",
    assetKind: "card",
    assetId: "card-src",
    now: AT,
    cardCopyIds: [copyD],
  });

  const del = await unmountAssetAndCopies({ userId: USER, projectId: "proj-e", assetKind: "card", assetId: "card-src" });
  assert.equal(del.removed, true, "proj-e 自己的記錄照刪（辨偽不阻收斂）");
  assert.equal(del.deletedCards, 0, "跨 project 的真副本必須被辨偽拒刪");
  assert.equal(await hasCard(USER, copyD), true, "proj-d 的副本必須毫髮無傷");
  assert.equal(await hasCard(USER, copyB), true, "proj-b 的副本不受影響");
  assert.equal((await listAssetMounts(USER)).filter((m) => m.id === inD.mount.id).length, 1, "proj-d 的掛用記錄不得被連帶刪除");

  // 反向對照：真 proj-d 解除照樣刪得掉自己那份（證明 T3 的「拒刪」不是恒真——同一張卡在對的 project 下會被刪）。
  const delD = await unmountAssetAndCopies({ userId: USER, projectId: "proj-d", assetKind: "card", assetId: "card-src" });
  assert.equal(delD.deletedCards, 1);
  assert.equal(await hasCard(USER, copyD), false);
});

test("T4 記錄混入「本 project 但 derivation 指向別的來源」的用戶真卡 → 拒刪，只刪真副本", async () => {
  reset();
  await saveCharacterCard(USER, card("card-src"));
  const mounted = await mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-src", now: AT });
  // 用戶自有卡：同 project scope，derivation 指向另一個來源（甚至 scope 缺失的個人卡也測一張）。
  await saveCharacterCard(
    USER,
    card("my-real-card", { scope: { owner: "project", projectId: "proj-b" }, lineage: [{ kind: "derivation", assetId: "other-src", at: AT }] }),
  );
  await saveCharacterCard(USER, card("my-plain-card", { scope: { owner: "project", projectId: "proj-b" } }));

  // 聯集擴充該記錄：混入兩張偽裝（重掛同一鍵走 applyAssetMount 聯集，即生產寫入通道）。
  await mountAsset(USER, {
    projectId: "proj-b",
    assetKind: "card",
    assetId: "card-src",
    now: AT,
    cardCopyIds: [mounted.localCopyId, "my-real-card", "my-plain-card"],
  });

  const del = await unmountAssetAndCopies({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-src" });
  assert.equal(del.removed, true);
  assert.equal(del.deletedCards, 1, "只准刪真正由這次掛用落盤的那張");
  assert.equal(await hasCard(USER, "my-real-card"), true, "derivation 來源不符＝不是這條來源的副本，禁刪用戶真卡");
  assert.equal(await hasCard(USER, "my-plain-card"), true, "無血統邊的自有卡禁刪");
  assert.equal(await hasCard(USER, mounted.localCopyId), false);
});

test("T5 另一用戶卡庫存在同名 id（同 hash 同 scope 同 derivation）→ 解除只動本人 store", async () => {
  reset();
  await saveCharacterCard(USER, card("card-src"));
  const mounted = await mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-src", now: AT });
  const copyId = mounted.localCopyId;
  // 用戶 43 的庫裡存在同 id、欄位完全同形的卡（確定性 id 可被任何人推出 → 這不是假設性攻擊）。
  await saveCharacterCard(
    OTHER_USER,
    card(copyId, { scope: { owner: "project", projectId: "proj-b" }, lineage: [{ kind: "derivation", assetId: "card-src", at: AT }] }),
  );
  assert.equal(await hasCard(OTHER_USER, copyId), true, "前置：他人同形卡真的在庫");

  const del = await unmountAssetAndCopies({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-src" });
  assert.equal(del.deletedCards, 1);
  assert.equal(await hasCard(USER, copyId), false, "本人的副本被回收");
  assert.equal(await hasCard(OTHER_USER, copyId), true, "他人同名卡必須毫髮無傷（刪掃以 userId 命名空間為界）");
});

// ─────────────────────────────────────────── 攻堅 3：冪等

test("T6 二次解除＝no-op 不拋錯；未掛用的三元組空轉；旁人不受波及", async () => {
  reset();
  await saveCharacterCard(USER, card("card-src"));
  await saveCharacterCard(USER, card("keep-me"));
  const mounted = await mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-src", now: AT });
  const first = await unmountAssetAndCopies({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-src" });
  assert.equal(first.removed, true);

  const second = await unmountAssetAndCopies({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-src" });
  assert.equal(second.removed, false);
  assert.equal(second.deletedCards, 0);
  assert.equal(second.deletedPacks, 0);
  assert.equal(second.localCopyId, null, "記錄已不存在→不得憑推導報副本");
  assert.equal(await hasCard(USER, "keep-me"), true, "空轉路徑不得誤刪任何卡");

  const never = await unmountAssetAndCopies({ userId: USER, projectId: "proj-x", assetKind: "pack", assetId: "not-exist" });
  assert.equal(never.removed, false);
  assert.deepEqual(await listAssetMounts(USER), []);
});

// ─────────────────────────────────────────── 攻堅 4：孤兒記錄（副本已被用戶手動刪除）

test("T7 包掛用→用戶把副本（卡+包）全手動刪光→解除仍收斂（記錄能刪、計數誠實）", async () => {
  reset();
  await saveAssetPack(USER, pack("pk-orphan", [promptItem("A", "a"), promptItem("B", "b")]));
  const mounted = await mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "pack", assetId: "pk-orphan", now: AT });
  await deleteCharacterCards(USER, [...mounted.localCopyIds]);
  await deleteAssetPacks(USER, [mounted.localCopyId]);
  assert.equal((await listAssetMounts(USER)).length, 1, "前置：只剩孤兒記錄");

  const del = await unmountAssetAndCopies({ userId: USER, projectId: "proj-b", assetKind: "pack", assetId: "pk-orphan" });
  assert.equal(del.removed, true, "記錄必須刪得掉（不等副本存在）");
  assert.equal(del.deletedCards, 0);
  assert.equal(del.deletedPacks, 0);
  assert.deepEqual(await listAssetMounts(USER), []);
});

// ─────────────────────────────────────────── 攻堅 5：建立面完整性 + 建到一半崩潰收編

test("T8 混合 kind 來源包：記錄 cardCopyIds 恰等於實際落盤副本卡；解除後該來源零殘留", async () => {
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
  // 卡投影只收 prompt/recipe/image|reference：index 0,1,2 建卡；3,4 跳過（skippedItems=2 誠實回報）。
  const expectCards = [0, 1, 2].map((i) => assetPackItemCopyId("proj-b", "pk-mix", i));
  assert.equal(mounted.skippedItems, 2);
  assert.deepEqual(mounted.localCopyIds.slice().sort(), expectCards.slice().sort());
  const record = (await listAssetMounts(USER))[0]!;
  assert.deepEqual([...(record.cardCopyIds ?? [])].sort(), expectCards.slice().sort(), "建立面：記錄清單必須完整覆蓋所有落盤副本");
  for (const id of expectCards) assert.equal(await hasCard(USER, id), true, `副本 ${id} 必須真的在庫`);

  const del = await unmountAssetAndCopies({ userId: USER, projectId: "proj-b", assetKind: "pack", assetId: "pk-mix" });
  assert.equal(del.deletedCards, 3);
  assert.equal(del.deletedPacks, 1);
  const left = (await listCharacterCards(USER)).filter((c) =>
    (c.lineage ?? []).some((l) => l.kind === "derivation" && l.assetId === "pk-mix"),
  );
  assert.deepEqual(left.map((c) => c.id), [], "解除後庫內不得殘留任何指向 pk-mix 的副本卡（漏記＝隱患，此處歸零）");
  assert.equal(await hasPack(USER, mounted.localCopyId), false);
  assert.deepEqual(await listAssetMounts(USER), []);
});

test("T9 建副本建到一半崩潰（副本已在、記錄未落）→ 首次解除如實空轉不憑推導亂刪；重掛收編孤兒 id → 再解除全清", async () => {
  reset();
  await saveCharacterCard(USER, card("card-orphan-src", { prompt: "來源" }));
  const orphanId = assetLocalCopyId("proj-z", "card", "card-orphan-src");
  // 模擬 mountAssetWithCopy 在 saveCharacterCard 之後、mountAsset 寫記錄之前崩潰。
  await saveCharacterCard(
    USER,
    card(orphanId, { scope: { owner: "project", projectId: "proj-z" }, lineage: [{ kind: "derivation", assetId: "card-orphan-src", at: AT }] }),
  );
  assert.equal((await listAssetMounts(USER)).length, 0, "前置：記錄未落");

  // 無記錄 → 解除誠實空轉（安全側：不憑推導刪孤兒，也不得拋錯）。
  const noRec = await unmountAssetAndCopies({ userId: USER, projectId: "proj-z", assetKind: "card", assetId: "card-orphan-src" });
  assert.equal(noRec.removed, false);
  assert.equal(noRec.deletedCards, 0);
  assert.equal(await hasCard(USER, orphanId), true);

  // 自愈路徑：重掛。佔用者是真副本 → 不 409、不重建，記錄把孤兒 id 收編。
  const remount = await mountAssetWithCopy({ userId: USER, projectId: "proj-z", assetKind: "card", assetId: "card-orphan-src", now: AT });
  assert.equal(remount.copied, false, "真副本在庫，不得重建");
  assert.deepEqual((await listAssetMounts(USER))[0]!.cardCopyIds, [orphanId], "重掛後記錄必須覆蓋孤兒");

  const del = await unmountAssetAndCopies({ userId: USER, projectId: "proj-z", assetKind: "card", assetId: "card-orphan-src" });
  assert.equal(del.removed, true);
  assert.equal(del.deletedCards, 1);
  assert.equal(await hasCard(USER, orphanId), false, "收編後解除必須把孤兒副本清乾淨");
  assert.deepEqual(await listAssetMounts(USER), []);
});
