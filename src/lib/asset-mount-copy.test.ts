// REQ-B2b 掛用 copy-on-use：**實際呼叫**的行為測試（非源碼字串掃描）。
//
// 覆蓋：
//   ① 掛用後目標項目能用副本生成（副本 scope/lineage/內容本體）② 來源刪除後副本仍可用
//   ③ 來源更新不影響副本（時間點凍結）④ 同 (projectId, sourceAssetId) 冪等一份（含併發重放）
//   ⑤ 對抗性：鍵碰撞 / 遞歸掛用可回溯 / 環路必拒 / 撞鍵不得冒充冪等 / 超上限誠實拒絕
//   ⑥ lineage 零跨 project（含反向對照，證明掃描不是恆真）
//   ⑦ 讀取端作用域閘（a 類 fail-closed / b 類 legacy 零回歸）
// 走記憶體降級路徑（測試環境無 BLOB_READ_WRITE_TOKEN）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyCopyLockChange,
  assetLocalCopyId,
  assetMountId,
  assetPackItemCopyId,
  assetPackLocalCopyId,
  assetShareId,
  filterLockedCardsForProjectUse,
  isUsableAssetId,
  normalizeAssetMount,
  planAssetMountCopy,
  resolveAssetVisibility,
  resolveAssetScopeVisibility,
} from "./asset-scope";
import type { AssetShareRecord } from "./asset-scope";
import {
  AssetCopyLimitError,
  AssetMountCopyConflictError,
  AssetMountCopyRejectedError,
  AssetSourceMissingError,
  filterCardIdsForProject,
  mountAssetWithCopy,
  mountCopyIds,
} from "./asset-library";
import { __resetAssetScopeStoreForTests, listAssetMounts } from "./asset-scope-store";
import { __resetAssetPackStoreForTests, deleteAssetPacks, normalizeAssetPack, saveAssetPack } from "./asset-pack-store";
import {
  __resetCharacterCardStoreForTests,
  deleteCharacterCards,
  listCharacterCards,
  MAX_CARDS_PER_USER,
  saveCharacterCard,
} from "./character-card-store";
import { applyCharacterCardsToPayload, normalizeCharacterCard } from "./character-cards";
import type { CharacterCard } from "./character-cards";
import { buildLineageTree } from "./lineage";
import type { LineagePool } from "./lineage";

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

function pack(id: string, items: unknown[], extra: Record<string, unknown> = {}) {
  const normalized = normalizeAssetPack({
    id,
    title: `包-${id}`,
    items,
    tags: [],
    createdAt: AT,
    updatedAt: AT,
    ...extra,
  });
  assert.ok(normalized, `pack ${id} 應可清洗`);
  return normalized;
}

async function findCard(id: string): Promise<CharacterCard | undefined> {
  return (await listCharacterCards(USER)).find((c) => c.id === id);
}

/** 生成注入路徑的真實斷言：鎖定卡注入後的 payload。 */
function injectedPrompt(locked: CharacterCard[], base = "base"): string {
  const payload = applyCharacterCardsToPayload({ prompt: base }, locked);
  return String(payload.prompt);
}

// ─────────────────────────────────────────── ① 掛用 → 目標項目有副本且能用

test("B2b 掛用：在目標項目建本地副本（scope=目標、lineage 指來源），目標項目能用它生成", async () => {
  reset();
  await saveCharacterCard(USER, card("card-src", { scope: { owner: "project", projectId: "proj-a" } }));
  const res = await mountAssetWithCopy({
    userId: USER,
    projectId: "proj-b",
    assetKind: "card",
    assetId: "card-src",
    now: AT,
  });
  assert.equal(res.created, true, "首次掛用必須是新建");
  assert.equal(res.copied, true, "copy-on-use 必須真的建了副本");
  assert.equal(res.localCopyIds.length, 1);
  assert.equal(res.localCopyId, res.localCopyIds[0]);
  assert.notEqual(res.localCopyId, "card-src", "副本是獨立實體，不得與來源同 id");

  const copy = await findCard(res.localCopyId);
  assert.ok(copy, "副本卡必須真的落在卡片庫裡");
  // 內容本體：逐欄照抄
  assert.equal(copy.prompt, "prompt-card-src", "副本必須複製內容本體而非只記引用");
  assert.equal(copy.kind, "character");
  // 副本自足：scope 指向目標項目（不是來源項目）
  assert.equal(copy.scope?.owner, "project");
  assert.equal(copy.scope?.projectId, "proj-b");
  // lineage 邊：derivation → 來源卡
  assert.deepEqual(
    (copy.lineage ?? []).map((l) => [l.kind, l.assetId]),
    [["derivation", "card-src"]],
  );

  // 目標項目：副本可見可用；來源此刻仍可見（同帳號、他自己的項目卡）但兩者互不影響
  assert.equal(
    resolveAssetVisibility({ id: copy.id, kind: "card", scope: copy.scope, ownerUserId: USER }, {
      viewerUserId: USER,
      projectId: "proj-b",
      shares: [],
    }),
    "in-project",
    "副本必須在目標項目可見（否則掛用等於沒生效）",
  );
  // 生成注入：讀的就是這批鎖定卡
  assert.ok(injectedPrompt([copy]).includes("prompt-card-src"), "副本必須能真的注入生成 prompt");

  // 掛用記錄帶同一個副本 id（同鍵重掛 → 同一份副本）
  const mounts = await listAssetMounts(USER);
  assert.equal(mounts.length, 1);
  assert.equal(mounts[0].localCopyId, res.localCopyId);
  assert.equal(mounts[0].id, assetMountId("proj-b", "card", "card-src"));
});

test("B2b 掛用：來源刪除後副本仍可用（副本自足）；lineage 態是『已刪除』不是『來源不明』", async () => {
  reset();
  await saveCharacterCard(USER, card("card-src", { scope: { owner: "project", projectId: "proj-a" } }));
  const res = await mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-src", now: AT });
  const copyId = res.localCopyId;

  assert.equal(await deleteCharacterCards(USER, ["card-src"]), 1, "來源卡必須真的被刪掉（不是假刪）");
  const copy = await findCard(copyId);
  assert.ok(copy, "來源刪除後副本必須還在");
  // 使用語義：仍然可見可用
  assert.equal(
    resolveAssetVisibility({ id: copy.id, kind: "card", scope: copy.scope, ownerUserId: USER }, {
      viewerUserId: USER,
      projectId: "proj-b",
      shares: [],
    }),
    "in-project",
  );
  // 生成語義：注入內容逐位不變（不需要解鏈前置動作）
  assert.ok(injectedPrompt([copy]).includes("prompt-card-src"));

  // 血統完整性：邊還在（指向已刪來源），鏈條解析為 deleted（而非 unknown-origin）
  assert.deepEqual((copy.lineage ?? []).map((l) => l.assetId), ["card-src"]);
  const pool: LineagePool = {
    find: (_jobId, assetId) => {
      // 池裡只剩副本自己 → 來源查無＝已刪除
      return assetId === copyId
        ? { lineage: copy.lineage, selfHandles: { assetId: copyId }, label: copy.name, thumbnailUrl: null, timeMs: null }
        : null;
    },
  };
  const { tree, rootHasLineage } = buildLineageTree(
    { lineage: copy.lineage, selfHandles: { assetId: copyId }, label: copy.name, thumbnailUrl: null, timeMs: null },
    pool,
  );
  assert.equal(rootHasLineage, true, "副本有血統登記");
  assert.equal(tree.children[0].status, "deleted", "來源查無但邊在＝已刪除態（與來源不明分開）");
  assert.equal(tree.children[0].link?.assetId, "card-src");
});

test("B2b 時間點凍結：來源日後更新不影響已掛用副本", async () => {
  reset();
  await saveCharacterCard(USER, card("card-src", { scope: { owner: "project", projectId: "proj-a" } }));
  const res = await mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-src", now: AT });
  const before = await findCard(res.localCopyId);

  // 來源改內容（同一 id upsert）
  await saveCharacterCard(USER, card("card-src", { prompt: "來源改過了", scope: { owner: "project", projectId: "proj-a" } }));
  const sourceAfter = await findCard("card-src");
  assert.equal(sourceAfter?.prompt, "來源改過了", "來源的更新必須真的落盤（否則這條測試是空的）");

  const after = await findCard(res.localCopyId);
  assert.equal(after?.prompt, "prompt-card-src", "副本內容必須凍結在掛用那一刻");
  assert.equal(after?.updatedAt, before?.updatedAt, "來源更新不得動副本的 updatedAt");
});

// ─────────────────────────────────────────── ④ 冪等（含併發/重放）

test("B2b 冪等：同 (projectId, sourceAssetId) 重複掛用只建一份副本，且重放零副作用", async () => {
  reset();
  await saveCharacterCard(USER, card("card-src", { scope: { owner: "project", projectId: "proj-a" } }));
  const first = await mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-src", now: AT });
  // 重放前先改來源：若重放會重寫副本，這裡會抓到
  await saveCharacterCard(USER, card("card-src", { prompt: "第二次掛用前的來源", scope: { owner: "project", projectId: "proj-a" } }));
  const replay = await mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-src", now: AT2 });

  assert.equal(replay.created, false, "同鍵重掛必須是冪等重放");
  assert.equal(replay.copied, false, "冪等重放不得再建副本");
  assert.equal(replay.localCopyId, first.localCopyId, "重放必須回同一份副本");

  const copies = (await listCharacterCards(USER)).filter((c) => c.id === first.localCopyId);
  assert.equal(copies.length, 1, "副本只能有一份");
  assert.equal(copies[0].prompt, "prompt-card-src", "重放不得覆寫副本內容（凍結）");
  assert.equal((await listAssetMounts(USER)).length, 1, "掛用記錄只能有一筆");
});

test("B2b 冪等：同鍵併發掛用也只建一份副本、一筆記錄", async () => {
  reset();
  await saveCharacterCard(USER, card("card-src", { scope: { owner: "project", projectId: "proj-a" } }));
  const [a, b] = await Promise.all([
    mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-src", now: AT }),
    mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-src", now: AT }),
  ]);
  assert.equal(a.localCopyId, b.localCopyId, "併發必須收斂到同一個副本 id");
  assert.equal((await listCharacterCards(USER)).filter((c) => c.id === a.localCopyId).length, 1, "併發只准一份副本");
  assert.equal((await listAssetMounts(USER)).length, 1, "併發只准一筆掛用記錄");
});

test("B2b 多項目：同一來源掛進不同項目＝兩份獨立副本（改一份不動另一份）", async () => {
  reset();
  await saveCharacterCard(USER, card("card-src"));
  const inB = await mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-src", now: AT });
  const inC = await mountAssetWithCopy({ userId: USER, projectId: "proj-c", assetKind: "card", assetId: "card-src", now: AT });
  assert.notEqual(inB.localCopyId, inC.localCopyId, "不同項目必須是不同副本");
  assert.equal((await findCard(inB.localCopyId))?.scope?.projectId, "proj-b");
  assert.equal((await findCard(inC.localCopyId))?.scope?.projectId, "proj-c");

  // 改 B 的副本 → C 的副本逐位不變
  await saveCharacterCard(USER, { ...(await findCard(inB.localCopyId))!, prompt: "只有 B 改了" });
  assert.equal((await findCard(inC.localCopyId))?.prompt, "prompt-card-src", "副本之間必須互相獨立");
});

test("B2b 唯一分歧點：mode=reference 只落記錄不建副本（方向可切換）", async () => {
  reset();
  await saveCharacterCard(USER, card("card-src"));
  const res = await mountAssetWithCopy({
    userId: USER,
    projectId: "proj-b",
    assetKind: "card",
    assetId: "card-src",
    now: AT,
    mode: "reference",
  });
  assert.equal(res.copied, false);
  assert.equal((await listCharacterCards(USER)).length, 1, "引用制不得建副本");
  assert.equal((await listAssetMounts(USER)).length, 1, "掛用記錄仍要落（同一筆記錄鍵）");
});

// ─────────────────────────────────────────── 包掛用（逐 item 成卡）

test("B2b 包掛用：逐 item 複製成卡 + 本地包副本帶 lineage；無卡投影的條目誠實回報", async () => {
  reset();
  await saveAssetPack(
    USER,
    pack("pack-src", [
      { kind: "prompt", title: "提示A", content: "內容A" },
      { kind: "image", title: "參考圖", imageUrl: "https://example.com/a.png" },
      { kind: "lora", title: "Lora條目", loraVersionId: "lora-v1" },
    ]),
  );
  const res = await mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "pack", assetId: "pack-src", now: AT });

  assert.equal(res.localCopyIds.length, 2, "prompt + image 兩條有卡投影 → 兩張副本卡");
  assert.equal(res.skippedItems, 1, "lora 條目沒有卡投影 → 誠實回報 1 條未複製");
  assert.equal(res.localCopyId, assetPackLocalCopyId("proj-b", "pack-src"));

  const promptCopy = await findCard(assetPackItemCopyId("proj-b", "pack-src", 0));
  assert.ok(promptCopy, "prompt 條目必須複製成卡");
  assert.equal(promptCopy.prompt, "內容A");
  assert.equal(promptCopy.scope?.projectId, "proj-b");
  // 條目卡的 lineage 指向來源包（可回溯到包）
  assert.deepEqual((promptCopy.lineage ?? []).map((l) => [l.kind, l.assetId]), [["derivation", "pack-src"]]);
  const imageCopy = await findCard(assetPackItemCopyId("proj-b", "pack-src", 1));
  assert.ok(imageCopy, "image 條目必須複製成卡");
  assert.equal(imageCopy.references[0]?.url, "https://example.com/a.png");

  // 包副本：本地包記錄 + lineage → 來源包
  const packCopy = (await (await import("./asset-pack-store")).listAssetPacks(USER)).find((p) => p.id === res.localCopyId);
  assert.ok(packCopy, "目標項目必須有本地包副本");
  assert.equal(packCopy.scope?.projectId, "proj-b");
  assert.deepEqual((packCopy.lineage ?? []).map((l) => [l.kind, l.assetId]), [["derivation", "pack-src"]]);
  assert.equal(packCopy.items.length, 3, "包副本保留全部條目（沒有卡投影的條目也不丟）");

  // 目標項目能用副本卡生成
  assert.ok(injectedPrompt([promptCopy]).includes("內容A"));

  // 來源包刪除 → 副本仍自足
  await deleteAssetPacks(USER, ["pack-src"]);
  const afterDelete = await findCard(assetPackItemCopyId("proj-b", "pack-src", 0));
  assert.ok(afterDelete, "刪來源包不得影響副本卡");
  assert.equal(
    resolveAssetVisibility({ id: afterDelete.id, kind: "card", scope: afterDelete.scope, ownerUserId: USER }, {
      viewerUserId: USER,
      projectId: "proj-b",
      shares: [],
    }),
    "in-project",
  );
});

test("B2b 包掛用冪等：重掛不重建副本、不重複建卡", async () => {
  reset();
  await saveAssetPack(USER, pack("pack-src", [{ kind: "prompt", title: "提示A", content: "內容A" }]));
  const first = await mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "pack", assetId: "pack-src", now: AT });
  const replay = await mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "pack", assetId: "pack-src", now: AT2 });
  assert.equal(replay.created, false);
  assert.equal(replay.copied, false);
  assert.deepEqual(replay.localCopyIds, first.localCopyIds);
  assert.equal((await listCharacterCards(USER)).length, 1, "重掛不得建第二張條目卡");
  const packs = await (await import("./asset-pack-store")).listAssetPacks(USER);
  assert.equal(packs.filter((p) => p.scope?.projectId === "proj-b").length, 1, "重掛不得建第二個包副本");
});

// ─────────────────────────────────────────── ⑤ 對抗性：鍵碰撞

test("B2b 對抗·鍵單射：長度前綴讓易撞三元組兩兩不等，且副本鍵與 mount/share 鍵不同形", () => {
  const pairs: [string, string, string][][] = [
    [
      ["a", "card", "x:card:y"],
      ["a", "card", "x"],
    ],
    [
      ["a:b", "card", "c"],
      ["a", "card", "b:c"],
    ],
    [
      ["proj", "card", "x"],
      ["proj", "pack", "x"],
    ],
    [
      ["proj", "pack", "x"],
      ["projx", "pack", ""],
    ],
  ];
  for (const [left, right] of pairs) {
    const a = assetLocalCopyId(left[0], left[1] as "card" | "pack", left[2]);
    const b = assetLocalCopyId(right[0], right[1] as "card" | "pack", right[2]);
    assert.notEqual(a, b, `易撞三元組必須不相等：${JSON.stringify(left)} vs ${JSON.stringify(right)}`);
  }
  // 包條目副本與「資產卡副本」不同族（namespace 分隔）
  assert.notEqual(
    assetPackItemCopyId("proj", "pack-x", 0),
    assetLocalCopyId("proj", "card", "pack-x"),
    "包條目副本與卡副本必須不撞",
  );
  assert.notEqual(assetPackItemCopyId("proj", "pack-x", 1), assetPackItemCopyId("proj", "pack-x", 0));

  // 副本鍵 vs mount/share 鍵：不同形、不相等
  const copyId = assetLocalCopyId("proj", "pack", "pack-x");
  assert.notEqual(copyId, assetMountId("proj", "pack", "pack-x"));
  assert.notEqual(copyId, assetShareId("pack", "pack-x", "proj", "other"));

  // 副本 id 必須可用作資產 id（卡片 id 上限 100、無保留分隔符）
  assert.equal(isUsableAssetId(copyId), true, "副本 id 必須能當資產卡 id");
  assert.ok(copyId.length <= 100, "副本 id 必須在卡片 id 上限內");
  assert.ok(!copyId.includes(":"), "副本 id 不得含保留分隔符");
});

test("B2b 對抗·邊界拒絕：含分隔符/超長/空的來源 id 進不了副本鏈（不猜不撞鍵）", async () => {
  reset();
  // 確定性鍵的邊界：非法 id 一律清洗成 null
  assert.equal(normalizeAssetMount({ projectId: "p", assetKind: "card", assetId: "x:card:y" }), null);
  assert.equal(normalizeAssetMount({ projectId: "p", assetKind: "card", assetId: "a".repeat(201) }), null);
  assert.equal(normalizeAssetMount({ projectId: "", assetKind: "card", assetId: "ok" }), null);
  // 對照：合法三元組必須清洗得出來（否則上面的 null 斷言是空的）
  const ok = normalizeAssetMount({ projectId: "p", assetKind: "card", assetId: "ok" });
  assert.ok(ok);
  assert.equal(ok.assetId, "ok");
  assert.equal(ok.localCopyId, assetLocalCopyId("p", "card", "ok"));

  // 進入掛用：含分隔符的來源在卡庫裡不存在（存檔收口也拒）→ 誠實 404 語義，不建任何東西
  await assert.rejects(
    () => mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "x:card:y" }),
    AssetSourceMissingError,
  );
  await assert.rejects(
    () => mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "pack", assetId: "nope" }),
    AssetSourceMissingError,
  );
  assert.equal((await listCharacterCards(USER)).length, 0, "拒絕路徑不得留下副本");
  assert.equal((await listAssetMounts(USER)).length, 0, "拒絕路徑不得留下掛用記錄");
});

test("B2b 對抗·撞鍵不冒充冪等：副本鍵被非副本資產佔用 → 409 衝突，不靜默成功", async () => {
  reset();
  await saveCharacterCard(USER, card("card-src", { scope: { owner: "project", projectId: "proj-a" } }));
  const copyId = assetLocalCopyId("proj-b", "card", "card-src");
  // 偽造佔用者：同 id，但既不屬於 proj-b 也沒有指向來源的 derivation 邊
  await saveCharacterCard(USER, card(copyId, { prompt: "我是別人的卡" }));

  await assert.rejects(
    () => mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-src", now: AT }),
    AssetMountCopyConflictError,
    "撞鍵必須是衝突，不得當成冪等重放",
  );
  const occupant = await findCard(copyId);
  assert.equal(occupant?.prompt, "我是別人的卡", "佔用者不得被覆寫");
  assert.equal((await listAssetMounts(USER)).length, 0, "衝突時不得留下掛用記錄（不留半套狀態）");
});

test("B2b 對抗·超上限：容量不足誠實拒絕，不靜默截斷", async () => {
  reset();
  for (let i = 0; i < MAX_CARDS_PER_USER; i += 1) {
    await saveCharacterCard(USER, card(`card-fill-${i}`));
  }
  await saveCharacterCard(USER, card("card-src"));
  assert.equal((await listCharacterCards(USER)).length, MAX_CARDS_PER_USER, "前置：卡庫已滿");
  await assert.rejects(
    () => mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-src", now: AT }),
    AssetCopyLimitError,
  );
  assert.equal((await listAssetMounts(USER)).length, 0, "超限時不得留下掛用記錄");
});

// ─────────────────────────────────────────── ⑤ 對抗性：遞歸與環路

test("B2b 對抗·遞歸掛用可回溯：copy of copy 的血統鏈可逐級解析回到最上游", async () => {
  reset();
  await saveCharacterCard(USER, card("card-a"));
  const step1 = await mountAssetWithCopy({ userId: USER, projectId: "proj-q", assetKind: "card", assetId: "card-a", now: AT });
  const step2 = await mountAssetWithCopy({
    userId: USER,
    projectId: "proj-r",
    assetKind: "card",
    assetId: step1.localCopyId,
    now: AT,
  });
  assert.equal(step2.copied, true, "副本必須可再被掛用（遞歸掛用被允許）");

  const copy2 = await findCard(step2.localCopyId);
  assert.ok(copy2);
  // 血統：只登記**直接來源**（副本1）；最上游由讀取端沿鏈逐級解析（見下方樹狀斷言）
  assert.deepEqual((copy2.lineage ?? []).map((l) => l.assetId), [step1.localCopyId]);

  const cards = await listCharacterCards(USER);
  const pool: LineagePool = {
    find: (_jobId, assetId) => {
      const found = assetId ? cards.find((c) => c.id === assetId) : undefined;
      if (!found) return null;
      return {
        lineage: found.lineage,
        selfHandles: { assetId: found.id },
        label: found.name,
        thumbnailUrl: null,
        timeMs: null,
      };
    },
  };
  const { tree } = buildLineageTree(
    {
      lineage: copy2.lineage,
      selfHandles: { assetId: copy2.id },
      label: copy2.name,
      thumbnailUrl: null,
      timeMs: null,
    },
    pool,
    { maxDepth: 5 },
  );
  assert.equal(tree.children.length, 1);
  const level1 = tree.children[0];
  assert.equal(level1.status, "resolved", "第一級（副本1）必須解析得到");
  assert.equal(level1.link?.assetId, step1.localCopyId);
  assert.equal(level1.children.length, 1);
  const level2 = level1.children[0];
  assert.equal(level2.status, "resolved", "第二級（最上游來源）必須解析得到");
  assert.equal(level2.link?.assetId, "card-a");
});

test("B2b 對抗·環路必拒：血統成環或副本會成為自己祖先 → 拒絕且不留任何痕跡", async () => {
  reset();
  // (1) 來源的祖先鏈已含自己（既有資料成環）
  await saveCharacterCard(USER, card("card-self", { lineage: [{ kind: "derivation", assetId: "card-self", at: AT }] }));
  await assert.rejects(
    () => mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-self", now: AT }),
    AssetMountCopyRejectedError,
  );

  // (2) 來源聲稱派生自「本次要建的副本」→ 副本會成為自己的祖先
  const wouldBeCopyId = assetLocalCopyId("proj-b", "card", "card-x");
  await saveCharacterCard(USER, card("card-x", { lineage: [{ kind: "derivation", assetId: wouldBeCopyId, at: AT }] }));
  await assert.rejects(
    () => mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-x", now: AT }),
    AssetMountCopyRejectedError,
  );

  assert.equal((await listAssetMounts(USER)).length, 0, "拒絕路徑不得留下掛用記錄");
  const copies = (await listCharacterCards(USER)).filter((c) => c.scope?.projectId === "proj-b");
  assert.equal(copies.length, 0, "拒絕路徑不得建副本");
});

test("B2b 純函式：planAssetMountCopy 是唯一分歧點（copy-on-use / reference / 冪等 / 環路）", () => {
  const base = { projectId: "proj-b", assetKind: "card" as const, sourceAssetId: "card-src" };
  const copyId = assetLocalCopyId("proj-b", "card", "card-src");

  const fresh = planAssetMountCopy(base);
  assert.equal(fresh.ok, true);
  assert.equal(fresh.ok && fresh.plan.shouldCreateCopy, true);
  assert.equal(fresh.ok && fresh.plan.localCopyId, copyId);

  const existing = planAssetMountCopy({ ...base, existingCopyIds: [copyId] });
  assert.equal(existing.ok, true);
  assert.equal(existing.ok && existing.plan.shouldCreateCopy, false, "已有副本＝冪等重放，不重建");
  assert.equal(existing.ok && existing.plan.existingCopyId, copyId);

  const reference = planAssetMountCopy({ ...base, mode: "reference" });
  assert.equal(reference.ok, true);
  assert.equal(reference.ok && reference.plan.localCopyId, null, "引用制不落地副本");
  assert.equal(reference.ok && reference.plan.shouldCreateCopy, false);

  const cyclic = planAssetMountCopy({ ...base, ancestorAssetIds: [copyId] });
  assert.equal(cyclic.ok, false);
  assert.equal(cyclic.ok === false && cyclic.reason, "cyclic_lineage");

  // 副本再掛回「來源所屬項目」不是環（遞歸掛用被允許）
  const recursive = planAssetMountCopy({ projectId: "proj-a", assetKind: "card", sourceAssetId: copyId, ancestorAssetIds: ["card-src"] });
  assert.equal(recursive.ok, true, "把副本掛回來源項目不得被當成環");
});

// ─────────────────────────────────────────── ⑥ lineage 零跨 project

test("B2b 不變量·生成輸入零跨 project：鎖定集經閘後每張卡都屬本項目或個人（含反向對照）", async () => {
  reset();
  await saveCharacterCard(USER, card("card-in-a", { scope: { owner: "project", projectId: "proj-a" } }));
  await saveCharacterCard(USER, card("card-personal"));
  // 反向對照：未經閘的原始鎖定集確實含有跨 project 的卡（證明下面的掃描不是恆真）
  const raw = ["card-in-a", "card-personal"];
  const rawCross = raw.filter((id) => id === "card-in-a");
  assert.equal(rawCross.length, 1, "反向對照：原始集合確實跨 project（否則掃描是空的）");

  // 經寫入端閘（= 落在 CanvasProject.cardIds 的那份）
  const gated = await filterCardIdsForProject({ userId: USER, projectId: "proj-b", cardIds: raw });
  const cards = await listCharacterCards(USER);
  const byId = new Map(cards.map((c) => [c.id, c] as const));
  for (const id of gated) {
    const card = byId.get(id);
    if (!card) continue;
    const ownedBy = card.scope?.owner === "project" ? card.scope.projectId : null;
    assert.ok(
      ownedBy === null || ownedBy === "proj-b",
      `鎖定集不得含別的項目的卡：${id} 屬於 ${ownedBy}`,
    );
  }
  assert.deepEqual(gated, ["card-personal"], "跨項目卡被閘剔除、個人卡原樣保留");

  // 讀取端閘（生成注入讀的那份）對同一集合的結論必須一致
  const locked = gated.flatMap((id) => (byId.get(id) ? [byId.get(id)!] : []));
  assert.deepEqual(
    filterLockedCardsForProjectUse(locked, { projectId: "proj-b", shares: [] }).map((c) => c.id),
    locked.map((c) => c.id),
    "寫入端放行 = 讀取端放行（兩端同一把尺）",
  );
});

test("B2b 不變量·血統邊不承載使用：刪光所有祖先，宿主卡仍可用（跨項目來源不是依賴）", async () => {
  reset();
  await saveCharacterCard(USER, card("card-src", { scope: { owner: "project", projectId: "proj-a" } }));
  const res = await mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-src", now: AT });
  const copy = (await findCard(res.localCopyId))!;
  const before = injectedPrompt([copy]);

  // 把來源（另一項目的祖先）刪掉——血統邊指向它，但注入輸出不得變
  await deleteCharacterCards(USER, ["card-src"]);
  const after = (await findCard(res.localCopyId))!;
  assert.equal(injectedPrompt([after]), before, "祖先缺席不得改變注入結果（血統只給人看）");
  assert.deepEqual((after.lineage ?? []).map((l) => l.assetId), ["card-src"], "邊仍留痕（已刪除態）");
});

// ─────────────────────────────────────────── ⑦ 讀取端作用域閘（殘留 a/b）

test("B2b 讀取閘：跨項目未分享的卡 fail-closed（a 類）；個人 legacy 卡與分享進來照用（b 類）", () => {
  const cards = [
    { id: "card-personal" },
    { id: "card-in-p", scope: { owner: "project" as const, projectId: "proj-p" } },
    { id: "card-in-q", scope: { owner: "project" as const, projectId: "proj-q" } },
  ];
  const pCtx = { projectId: "proj-p", shares: [] as AssetShareRecord[] };
  assert.deepEqual(
    filterLockedCardsForProjectUse(cards, pCtx).map((c) => c.id),
    ["card-personal", "card-in-p"],
    "別的項目未分享的卡必須剔除（a 類 fail-closed）；個人卡與本項目卡保留（b 類零回歸）",
  );

  // 顯式分享進來 → 保留；撤銷 → 立刻剔除
  const share: AssetShareRecord = {
    id: assetShareId("card", "card-in-q", "proj-q", "proj-p"),
    assetKind: "card",
    assetId: "card-in-q",
    fromProjectId: "proj-q",
    toProjectId: "proj-p",
    createdAt: AT,
  };
  assert.deepEqual(
    filterLockedCardsForProjectUse(cards, { projectId: "proj-p", shares: [share] }).map((c) => c.id),
    ["card-personal", "card-in-p", "card-in-q"],
    "顯式分享進來的卡必須照用（與寫入端放行一致）",
  );
  assert.deepEqual(
    filterLockedCardsForProjectUse(cards, { projectId: "proj-p", shares: [{ ...share, revokedAt: AT2 }] }).map((c) => c.id),
    ["card-personal", "card-in-p"],
    "撤銷後立刻回到剔除",
  );

  // 無項目上下文：項目歸屬的卡一律剔除（只有個人卡可用）
  assert.deepEqual(
    filterLockedCardsForProjectUse(cards, { projectId: null, shares: [] }).map((c) => c.id),
    ["card-personal"],
  );

  // 讀取閘與伺服器端裁決函式逐條同構（同 input 同結論）
  for (const card of cards) {
    const expected =
      resolveAssetScopeVisibility({ id: card.id, kind: "card", scope: card.scope }, { viewerUserId: 0, ...pCtx }) !== null;
    const actual = filterLockedCardsForProjectUse([card], pCtx).length === 1;
    assert.equal(actual, expected, `${card.id} 讀取閘與裁決函式必須同結論`);
  }
});

// ─────────────────────────────────────────── 解除掛用回報（前端解鎖用）

test("B2b 解除掛用：mountCopyIds 回該記錄的副本 id（卡＝單一；包＝包副本＋逐 item 卡副本）", async () => {
  reset();
  await saveCharacterCard(USER, card("card-src", { scope: { owner: "project", projectId: "proj-a" } }));
  const cardMount = await mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-src", now: AT });
  assert.deepEqual(
    await mountCopyIds({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-src" }),
    { localCopyId: cardMount.localCopyId, localCopyIds: [cardMount.localCopyId] },
  );

  await saveAssetPack(USER, pack("pack-src", [
    { kind: "prompt", title: "提示A", content: "內容A" },
    { kind: "prompt", title: "提示B", content: "內容B" },
  ]));
  const packMount = await mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "pack", assetId: "pack-src", now: AT });
  const ids = await mountCopyIds({ userId: USER, projectId: "proj-b", assetKind: "pack", assetId: "pack-src" });
  assert.equal(ids.localCopyId, packMount.localCopyId);
  assert.deepEqual(ids.localCopyIds, [
    packMount.localCopyId,
    assetPackItemCopyId("proj-b", "pack-src", 0),
    assetPackItemCopyId("proj-b", "pack-src", 1),
  ]);

  // 沒掛用過 → 空（前端不會誤解鎖）
  assert.deepEqual(
    await mountCopyIds({ userId: USER, projectId: "proj-z", assetKind: "card", assetId: "card-src" }),
    { localCopyId: null, localCopyIds: [] },
  );
});

// ─────────────────────────────────────────── 掛用副本 → cardIds（前端鎖定的行為斷言）

test("B2b 鎖定集：掛用副本進得了 cardIds、解除會移除、重複掛用不重複一筆", () => {
  const copy = assetLocalCopyId("proj-b", "card", "card-src");
  // 首次掛用：副本進集合
  assert.deepEqual(applyCopyLockChange(["card-personal"], { locked: [copy], unlocked: [] }), [
    "card-personal",
    copy,
  ]);
  // 重複掛用（同 copy 兩次）→ 只一份（冪等）
  assert.deepEqual(applyCopyLockChange([copy], { locked: [copy], unlocked: [] }), [copy]);
  // 包掛用：逐 item 副本一起鎖
  const packCopies = [assetPackItemCopyId("proj-b", "pack-src", 0), assetPackItemCopyId("proj-b", "pack-src", 1)];
  assert.deepEqual(applyCopyLockChange([], { locked: packCopies, unlocked: [] }), packCopies);
  // 解除掛用：副本出集合
  assert.deepEqual(applyCopyLockChange(["card-personal", copy], { locked: [], unlocked: [copy] }), ["card-personal"]);
  // 解除不在集合裡的 id：無副作用（不得把別人的鎖定誤刪）
  assert.deepEqual(applyCopyLockChange(["card-personal"], { locked: [], unlocked: ["card-other"] }), ["card-personal"]);
  // 空字串/空白 id 不得污染集合
  assert.deepEqual(applyCopyLockChange(["card-personal"], { locked: ["", "  "], unlocked: [] }), ["card-personal"]);
  // 鎖定與解鎖同時（換包場景）：先移除、再補進，兩者都生效
  assert.deepEqual(applyCopyLockChange([packCopies[0], "card-personal"], { locked: [copy], unlocked: [packCopies[0]] }), [
    "card-personal",
    copy,
  ]);
});

// ─────────────────────────────────────────── 殘留 a/b 類命中數（可重跑的查法）

test("B2b 殘留命中數查法：由 projects(cardIds) × cards(scope) × shares 推導 a/b 兩類", async () => {
  reset();
  // 造出「既有畫布」的樣子：兩個項目各自鎖定 cardIds；卡庫裡 personal（legacy）與跨項目卡並存
  await saveCharacterCard(USER, card("card-legacy-1"));
  await saveCharacterCard(USER, card("card-legacy-2"));
  await saveCharacterCard(USER, card("card-in-a", { scope: { owner: "project", projectId: "proj-a" } }));
  const projects = [
    { id: "proj-a", cardIds: ["card-legacy-1", "card-in-a", "card-ghost"] },
    { id: "proj-b", cardIds: ["card-legacy-2", "card-in-a"] },
  ];
  const cards = await listCharacterCards(USER);
  const shares = await (await import("./asset-scope-store")).listAssetShares(USER);
  const byId = new Map(cards.map((c) => [c.id, c] as const));

  let aClass = 0;
  let bClass = 0;
  let unknown = 0;
  for (const project of projects) {
    for (const id of project.cardIds) {
      const found = byId.get(id);
      if (!found) {
        unknown += 1;
        continue;
      }
      if (found.scope?.owner !== "project") {
        bClass += 1; // 同 owner（個人）跨 project 的舊鎖定卡
        continue;
      }
      if (found.scope.projectId === project.id) continue;
      const shared = shares.some(
        (s) =>
          s.assetKind === "card" &&
          s.assetId === id &&
          s.fromProjectId === found.scope?.projectId &&
          s.toProjectId === project.id &&
          !s.revokedAt,
      );
      if (!shared) aClass += 1; // 跨 owner 未分享＝真泄漏
    }
  }
  assert.equal(aClass, 1, "只有 proj-b 鎖定的 card-in-a 是 a 類（proj-a 自己鎖自己不算）");
  assert.equal(bClass, 2, "兩筆 personal legacy 鎖定＝b 類（proj-a 一筆、proj-b 一筆）");
  assert.equal(unknown, 1, "查不到的 id 單獨計（不猜）");
});
