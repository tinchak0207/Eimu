// REQ-B2b 對抗性驗收缺陷的**具名回歸**（把驗收官的 repro 逐條變成真實行為斷言）。
//
//   口徑（TG-02 / AGENTS.md 09-23）：本檔每一條都是**實際呼叫**的行為斷言，
//   沒有任何源碼字串掃描；斷言都帶反向對照（證明斷言不是恆真）。
//
//   D1 解除掛用漏解鎖包內條目副本 →「已解除但仍被注入」且永久無法自愈（三個 UI 可達觸發路徑）
//   D2 環路守衛有界 → 6 跳真環漏檢（現為完整遍歷 + 超界 fail-closed）
//   D4 掛用冪等可被事後血統編輯永久打死（既有記錄查詢排在環路守衛之前）
//   D5 內部副本被當成資產庫條目列出 → 可再掛用造成卡片膨脹 + 額度誠實
//   口徑修正：不變量是**運行時自足**（lineage 邊可指向別的 project 的來源）
//
// 走記憶體降級路徑（測試環境無 BLOB_READ_WRITE_TOKEN）。
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

// ─────────────────────────────────────────── 生成注入的真實斷言（鎖定集 → payload）

/**
 * 「這批鎖定卡會被注入什麼」——與前端同一條路徑：cardIds 經 applyCopyLockChange 變更後，
 * 由卡庫解析實體、再過讀取端作用域閘（filterLockedCardsForProjectUse）、最後進注入。
 */
async function injectedAfterUnmount(cardIds: readonly string[], unlocked: readonly string[], projectId: string): Promise<string> {
  const next = applyCopyLockChange(cardIds, { locked: [], unlocked });
  const cards = await listCharacterCards(USER);
  const byId = new Map(cards.map((c) => [c.id, c] as const));
  const locked = next.flatMap((id) => (byId.get(id) ? [byId.get(id)!] : []));
  const usable = filterLockedCardsForProjectUse(locked, { projectId, shares: [] });
  return String(applyCharacterCardsToPayload({ prompt: "base" }, usable).prompt);
}

// ─────────────────────────────────────────── D1 三個 UI 可達觸發路徑

test("D1(a) 掛→解→來源包追加條目→掛→解：解除必須涵蓋追加後新鎖的副本，注入歸零", async () => {
  reset();
  await saveAssetPack(USER, pack("pack-src", [promptItem("提示A", "內容A")]));

  const first = await mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "pack", assetId: "pack-src", now: AT });
  assert.deepEqual(first.localCopyIds, [assetPackItemCopyId("proj-b", "pack-src", 0)]);
  let cardIds = applyCopyLockChange([], { locked: first.localCopyIds, unlocked: [] });
  assert.ok((await injectedAfterUnmount(cardIds, [], "proj-b")).includes("內容A"));

  // 解除第一次掛用（含副本回收）
  const firstUnmount = await unmountAssetAndCopies({ userId: USER, projectId: "proj-b", assetKind: "pack", assetId: "pack-src" });
  assert.equal(firstUnmount.removed, true);
  assert.deepEqual(firstUnmount.localCopyIds, [firstUnmount.localCopyId, assetPackItemCopyId("proj-b", "pack-src", 0)]);
  assert.equal(await injectedAfterUnmount(cardIds, firstUnmount.localCopyIds, "proj-b"), "base", "解除後注入歸零");

  // 來源包追加條目（本地包副本已被回收，重掛要重新推導）
  await saveAssetPack(USER, pack("pack-src", [promptItem("提示A", "內容A"), promptItem("提示B", "內容B")]));
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
    "解除回應必須涵蓋**全部實際鎖過的副本**（含追加後才建的那張）",
  );
  assert.equal(await injectedAfterUnmount(cardIds, secondUnmount.localCopyIds, "proj-b"), "base", "解除後不得再注入任何該次掛用的副本");
  assert.deepEqual(await listAssetMounts(USER), [], "掛用記錄必須真的移除");
});

test("D1(b) 掛→來源包追加條目→掛（補建新副本）→解：記錄裡的清單必須跟上補建的副本", async () => {
  reset();
  await saveAssetPack(USER, pack("pack-src", [promptItem("提示A", "內容A")]));
  const first = await mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "pack", assetId: "pack-src", now: AT });
  let cardIds = applyCopyLockChange([], { locked: first.localCopyIds, unlocked: [] });

  // 來源追加條目後**重掛**（冪等鍵不變）：既有副本保留、缺的那張補建 → 也必須進記錄清單。
  await saveAssetPack(USER, pack("pack-src", [promptItem("提示A", "內容A"), promptItem("提示B", "內容B")]));
  const replay = await mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "pack", assetId: "pack-src", now: AT2 });
  assert.equal(replay.created, false, "同鍵必須是冪等重放");
  assert.equal(replay.copied, true, "缺的那張要補建（逐項收斂）");
  assert.deepEqual(replay.localCopyIds, [
    assetPackItemCopyId("proj-b", "pack-src", 0),
    assetPackItemCopyId("proj-b", "pack-src", 1),
  ]);
  const record = (await listAssetMounts(USER))[0];
  assert.deepEqual(
    record.cardCopyIds,
    [assetPackItemCopyId("proj-b", "pack-src", 0), assetPackItemCopyId("proj-b", "pack-src", 1)],
    "掛用記錄的 cardCopyIds 必須是聯集（否則解除只解得到第一次那張）",
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

test("D1(c) 不改來源：掛包→刪掉本地包副本→解——DELETE 必須回全部實際鎖過的副本（驗收官原 repro）", async () => {
  reset();
  await saveAssetPack(USER, pack("pack-src", [promptItem("提示A", "內容A"), promptItem("提示B", "內容B")]));
  const mounted = await mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "pack", assetId: "pack-src", now: AT });
  const cardIds = applyCopyLockChange([], { locked: mounted.localCopyIds, unlocked: [] });
  assert.equal((await injectedAfterUnmount(cardIds, [], "proj-b")).includes("內容B"), true);

  // 使用者把本地包副本刪掉（UI 可達：資產包列表可刪自己的包）
  await deleteAssetPacks(USER, [mounted.localCopyId]);
  assert.equal((await listAssetPacks(USER)).filter((p) => p.id === mounted.localCopyId).length, 0, "前置：本地包副本真的沒了");

  const del = await unmountAssetAndCopies({ userId: USER, projectId: "proj-b", assetKind: "pack", assetId: "pack-src" });
  assert.deepEqual(
    del.localCopyIds,
    [mounted.localCopyId, assetPackItemCopyId("proj-b", "pack-src", 0), assetPackItemCopyId("proj-b", "pack-src", 1)],
    "舊版只回 [packCopy] → 兩張條目副本永遠留在 cardIds（永久無法自愈）；現在必須回全部",
  );
  assert.equal(await injectedAfterUnmount(cardIds, del.localCopyIds, "proj-b"), "base", "解除後生成不再注入任何該次掛用的副本");
  // 副本回收：卡庫不得再留該次掛用的副本（額度即刻釋放）
  const remaining = await listCharacterCards(USER);
  for (const id of [assetPackItemCopyId("proj-b", "pack-src", 0), assetPackItemCopyId("proj-b", "pack-src", 1)]) {
    assert.equal(remaining.some((c) => c.id === id), false, `解除後副本卡 ${id} 必須回收（不留靜默佔額度）`);
  }
});

test("D1 卡掛用：記錄落盤 cardCopyIds，解除回同一份；legacy 記錄（無清單）仍回退舊推導", async () => {
  reset();
  await saveCharacterCard(USER, card("card-src"));
  const res = await mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-src", now: AT });
  assert.deepEqual((await listAssetMounts(USER))[0].cardCopyIds, [res.localCopyId]);
  assert.deepEqual(await mountCopyIds({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-src" }), {
    localCopyId: res.localCopyId,
    localCopyIds: [res.localCopyId],
  });

  // legacy：手寫一筆沒有 cardCopyIds 的包掛用記錄（舊世代資料）→ 回退「按本地包副本條目推導」。
  reset();
  await saveAssetPack(USER, pack("pack-src", [promptItem("提示A", "內容A")]));
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
  assert.deepEqual(legacy.localCopyIds, [legacyLocalPack, assetPackItemCopyId("proj-c", "pack-src", 0)], "legacy 記錄回退舊推導（向後相容）");
});

// ─────────────────────────────────────────── D2 深環

test("D2 深環（6 跳）必須被偵測且零副作用；3 跳照舊拒絕（反向對照）", async () => {
  reset();
  // 6 跳真環：a → b → c → d → e → f → a（a 是自己的祖先）
  const chain = ["card-a", "card-b", "card-c", "card-d", "card-e", "card-f"];
  for (let i = 0; i < chain.length; i += 1) {
    const next = chain[(i + 1) % chain.length];
    await saveCharacterCard(USER, card(chain[i], { lineage: [{ kind: "derivation", assetId: next, at: AT }] }));
  }
  await assert.rejects(
    () => mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-a", now: AT }),
    AssetMountCopyRejectedError,
    "6 跳真環必須被拒（舊版 maxDepth=5 會漏檢 → 真的建出副本）",
  );
  assert.equal((await listAssetMounts(USER)).length, 0, "拒絕路徑不得留下掛用記錄");
  assert.equal(
    (await listCharacterCards(USER)).filter((c) => c.scope?.projectId === "proj-b").length,
    0,
    "拒絕路徑不得建副本",
  );

  // 反向對照：3 跳環（舊版就能抓）不得因此誤放行，也不得被新實作改成別的理由。
  reset();
  await saveCharacterCard(USER, card("card-x", { lineage: [{ kind: "derivation", assetId: "card-y", at: AT }] }));
  await saveCharacterCard(USER, card("card-y", { lineage: [{ kind: "derivation", assetId: "card-z", at: AT }] }));
  await saveCharacterCard(USER, card("card-z", { lineage: [{ kind: "derivation", assetId: "card-x", at: AT }] }));
  await assert.rejects(
    () => mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-x", now: AT }),
    (error: unknown) => error instanceof AssetMountCopyRejectedError && error.reason === "cyclic_lineage",
  );

  // 對照：非環的深鏈（6 跳但不成環）必須照常掛用——證明「拒絕」來自環而不是深度。
  reset();
  for (let i = 0; i < chain.length; i += 1) {
    const next = i + 1 < chain.length ? chain[i + 1] : undefined;
    await saveCharacterCard(USER, card(chain[i], next ? { lineage: [{ kind: "derivation", assetId: next, at: AT }] } : {}));
  }
  const deep = await mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-a", now: AT });
  assert.equal(deep.copied, true, "6 跳非環必須可掛用（完整遍歷不改語義，只補上漏檢）");

  // 超界 fail-closed：預算不夠走完 → 拒絕並回可辨識原因（絕不「查不完就當沒環」）+ 零副作用。
  reset();
  for (let i = 0; i < chain.length; i += 1) {
    const next = i + 1 < chain.length ? chain[i + 1] : undefined;
    await saveCharacterCard(USER, card(chain[i], next ? { lineage: [{ kind: "derivation", assetId: next, at: AT }] } : {}));
  }
  await assert.rejects(
    () => mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-a", now: AT, ancestorNodeBudget: 2 }),
    (error: unknown) => error instanceof AssetMountCopyRejectedError && error.reason === "unbounded_lineage",
    "血統圖超出可完整遍歷的界限 → 拒絕（fail-closed），不是預設無環",
  );
  assert.equal((await listAssetMounts(USER)).length, 0, "超界拒絕路徑不得留下掛用記錄");
  assert.equal(
    (await listCharacterCards(USER)).filter((c) => c.scope?.projectId === "proj-b").length,
    0,
    "超界拒絕路徑不得建副本",
  );
  // 遍歷本身的行為：預算內的節點收齊、超出時明確回報 truncated（不是靜默截斷成「無環」）。
  const traverse = collectAncestorAssetIds(
    [{ kind: "derivation", assetId: "n0", at: AT }],
    (id) => (id === "n0" ? [{ kind: "derivation", assetId: "n1", at: AT }] : []),
    { maxNodes: 1 },
  );
  assert.equal(traverse.truncated, true);
  assert.deepEqual(traverse.ids, ["n0"]);
});

// ─────────────────────────────────────────── D4 冪等重放優先於環路守衛

test("D4 既有掛用記錄查詢排在環路守衛之前：來源血統事後被編輯成含副本 id，重掛仍回既有結果", async () => {
  reset();
  await saveCharacterCard(USER, card("card-src"));
  const first = await mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-src", now: AT });
  assert.equal(first.copied, true);
  const copyId = first.localCopyId;

  // 事後血統編輯：把「本次副本 id」寫進來源的 lineage（UI 可達：血統抽屜/入庫編輯）
  await saveCharacterCard(USER, card("card-src", { lineage: [{ kind: "derivation", assetId: copyId, at: AT2 }] }));
  assert.equal((await listCharacterCards(USER)).find((c) => c.id === "card-src")?.lineage?.[0].assetId, copyId, "前置：血統編輯真的落盤");

  const replay = await mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-src", now: AT2 });
  assert.equal(replay.created, false, "既有記錄 → 冪等重放");
  assert.equal(replay.copied, false, "不得重建副本");
  assert.equal(replay.localCopyId, copyId, "必須回既有副本");
  assert.equal((await listAssetMounts(USER)).length, 1, "不得新增第二筆記錄");

  // 反向對照：**沒有**既有記錄時，同樣的血統編輯必須照樣被環路守衛拒絕（守衛沒被弱化）。
  reset();
  await saveCharacterCard(USER, card("card-new"));
  await saveCharacterCard(USER, card("card-new2", { lineage: [{ kind: "derivation", assetId: assetLocalCopyId("proj-b", "card", "card-new2"), at: AT }] }));
  await assert.rejects(
    () => mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-new2", now: AT }),
    (error: unknown) => error instanceof AssetMountCopyRejectedError && error.reason === "cyclic_lineage",
    "首次掛用的環路守衛一條不少",
  );
});

// ─────────────────────────────────────────── D5 內部副本 / 額度誠實

test("D5 內部副本不得曝露為可掛用條目：庫列表/掛用閘都不放行，且來源仍標『已掛用』", async () => {
  reset();
  await saveAssetPack(USER, pack("pack-src", [promptItem("提示A", "內容A")]));
  await saveCharacterCard(USER, card("card-src", { scope: { owner: "project", projectId: "proj-a" } }));
  const packMount = await mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "pack", assetId: "pack-src", now: AT });
  const cardMount = await mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-src", now: AT });

  const lib = await listProjectAssetLibrary({ userId: USER, projectId: "proj-b" });
  const ids = lib.items.map((i) => i.assetId);
  // 反向對照：庫裡確實有東西（否則下面的「不含副本」是空的）
  assert.ok(ids.includes("pack-src"), "來源包必須在列表裡");
  for (const copyId of [packMount.localCopyId, cardMount.localCopyId, ...packMount.localCopyIds]) {
    assert.equal(ids.includes(copyId), false, `內部副本 ${copyId} 不得列為可掛用條目`);
  }
  assert.equal(lib.items.find((i) => i.assetId === "pack-src")?.mounted, true, "來源仍標『已掛用』（狀態真相在掛用記錄）");

  // 掛用閘：副本直接不可掛（函式層與路由同源）
  assert.equal(await resolveMountable({ userId: USER, projectId: "proj-b", assetKind: "pack", assetId: packMount.localCopyId }), null);
  assert.equal(await resolveMountable({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: cardMount.localCopyId }), null);
  assert.ok(await resolveMountable({ userId: USER, projectId: "proj-b", assetKind: "pack", assetId: "pack-src" }), "來源照樣可掛用");

  // 直接呼叫（繞過閘）也只能得到「與來源無關的另一份副本」——判據證明它認得出副本家族
  assert.equal(isAssetLocalCopyId(packMount.localCopyIds[0]), true);
});

test("D5 額度誠實：解除會回收副本（卡片數回落），不再靜默佔額度；來源刪除後不留殭屍", async () => {
  reset();
  await saveAssetPack(USER, pack("pack-src", [promptItem("提示A", "內容A"), promptItem("提示B", "內容B")]));
  const before = (await listCharacterCards(USER)).length;
  const mounted = await mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "pack", assetId: "pack-src", now: AT });
  assert.equal((await listCharacterCards(USER)).length, before + 2, "掛用落了 2 張副本卡（佔額度，誠實可見）");

  const del = await unmountAssetAndCopies({ userId: USER, projectId: "proj-b", assetKind: "pack", assetId: "pack-src" });
  assert.equal(del.deletedCards, 2, "解除必須回報實際回收的副本卡數");
  assert.equal(del.deletedPacks, 1, "本地包副本也要回收");
  assert.equal((await listCharacterCards(USER)).length, before, "解除後卡片數回落到掛用前（額度即刻釋放）");
  assert.equal((await listAssetPacks(USER)).some((p) => p.id === mounted.localCopyId), false);

  // 殭屍路徑：掛用 → 刪來源 → 解除；不得留下「卡片總數 > 0、掛用記錄 = 0」的不可解釋殘留。
  await saveCharacterCard(USER, card("card-zombie"));
  const cardMount = await mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-zombie", now: AT });
  assert.equal(await deleteCharacterCards(USER, ["card-zombie"]), 1, "來源卡被真的刪掉");
  const del2 = await unmountAssetAndCopies({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-zombie" });
  assert.equal(del2.localCopyId, cardMount.localCopyId);
  assert.equal((await listCharacterCards(USER)).some((c) => c.id === cardMount.localCopyId), false, "來源刪除後解除不得留殭屍副本");
  assert.deepEqual(await listAssetMounts(USER), []);
});

// ─────────────────────────────────────────── 口徑修正：運行時自足

test("口徑修正·運行時自足：副本的 lineage 邊**可以**指向別的 project，但副本不被外部 project 狀態決定", async () => {
  reset();
  // 來源屬於 proj-a（**別的** project），副本落在 proj-b → derivation 邊跨 project（事實，不是違規）
  await saveCharacterCard(USER, card("card-src", { scope: { owner: "project", projectId: "proj-a" }, prompt: "來源內容" }));
  const res = await mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-src", now: AT });
  const copy = (await listCharacterCards(USER)).find((c) => c.id === res.localCopyId);
  assert.ok(copy);
  assert.deepEqual(
    (copy.lineage ?? []).map((l) => [l.kind, l.assetId]),
    [["derivation", "card-src"]],
    "反向對照：邊確實指向別的 project 的來源（所以「lineage 永不跨 project」這句話本身是錯的口徑）",
  );
  assert.equal(copy.scope?.projectId, "proj-b", "副本歸屬目標項目");

  // 刪來源卡 + 刪來源項目的所有資產（模擬「來源項目被清空/刪除」）→ 副本逐位不變、仍可見可用
  const snapshot = { prompt: copy.prompt, scope: copy.scope, lineage: copy.lineage };
  await deleteCharacterCards(USER, ["card-src"]);
  await deleteAssetPacks(USER, (await listAssetPacks(USER)).map((p) => p.id));
  const after = (await listCharacterCards(USER)).find((c) => c.id === res.localCopyId);
  assert.ok(after, "副本必須還在（不依賴外部 project 的存在）");
  assert.deepEqual({ prompt: after.prompt, scope: after.scope, lineage: after.lineage }, snapshot, "外部狀態改變不得動副本本體");
  assert.equal(
    filterLockedCardsForProjectUse([after], { projectId: "proj-b", shares: [] }).length,
    1,
    "副本在目標項目的讀取閘仍放行（生成可用）",
  );
  assert.ok(String(applyCharacterCardsToPayload({ prompt: "base" }, [after]).prompt).includes("來源內容"));
  assert.deepEqual(await filterCardIdsForProject({ userId: USER, projectId: "proj-b", cardIds: [after.id] }), [after.id]);
});

test("回收順序·重試收斂：副本已刪而掛用記錄還在（模擬半途而廢）→ 解除必須仍收掉記錄、不炸、不再刪", async () => {
  reset();
  // 掛卡 → 直接刪副本卡（＝新順序下「副本已刪、記錄未刪」的崩潰窗口態）
  await saveCharacterCard(USER, card("card-o", { prompt: "來源內容" }));
  const mounted = await mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-o", now: AT });
  await deleteCharacterCards(USER, [mounted.localCopyId]);
  assert.equal((await listAssetMounts(USER)).length, 1, "崩潰窗口：記錄還在");

  // 重試收斂：解除不炸、記錄必被收掉、deletedCards 誠實回 0（副本已不在，不憑空捏數）
  const retry = await unmountAssetAndCopies({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-o" });
  assert.equal(retry.removed, true, "記錄必須被收掉（順序契約：記錄最後刪，任何前置失敗都可重試）");
  assert.equal(retry.deletedCards, 0, "副本已不存在，不得虛報刪除數");
  assert.deepEqual(await listAssetMounts(USER), [], "無殘留記錄");

  // 冪等：再解除一次＝空轉 no-op
  const again = await unmountAssetAndCopies({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-o" });
  assert.equal(again.removed, false);
  assert.equal(again.deletedCards, 0);
});
