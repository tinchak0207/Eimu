// REQ-B2b 挂用 copy-on-use：**实际呼叫**的行为测试（非源码字串扫描）。
//
// 覆盖：
//   ① 挂用后目标项目能用副本生成（副本 scope/lineage/内容本体）② 来源删除后副本仍可用
//   ③ 来源更新不影响副本（时间点冻结）④ 同 (projectId, sourceAssetId) 幂等一份（含并发重放）
//   ⑤ 对抗性：键碰撞 / 递归挂用可回溯 / 环路必拒 / 撞键不得冒充幂等 / 超上限诚实拒绝
//   ⑥ lineage 零跨 project（含反向对照，证明扫描不是恒真）
//   ⑦ 读取端作用域闸（a 类 fail-closed / b 类 legacy 零回归）
// 走记忆体降级路径（测试环境无 BLOB_READ_WRITE_TOKEN）。
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
  assert.ok(normalized, `card ${id} 应可清洗`);
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
  assert.ok(normalized, `pack ${id} 应可清洗`);
  return normalized;
}

async function findCard(id: string): Promise<CharacterCard | undefined> {
  return (await listCharacterCards(USER)).find((c) => c.id === id);
}

/** 生成注入路径的真实断言：锁定卡注入后的 payload。 */
function injectedPrompt(locked: CharacterCard[], base = "base"): string {
  const payload = applyCharacterCardsToPayload({ prompt: base }, locked);
  return String(payload.prompt);
}

// ─────────────────────────────────────────── ① 挂用 → 目标项目有副本且能用

test("B2b 挂用：在目标项目建本地副本（scope=目标、lineage 指来源），目标项目能用它生成", async () => {
  reset();
  await saveCharacterCard(USER, card("card-src", { scope: { owner: "project", projectId: "proj-a" } }));
  const res = await mountAssetWithCopy({
    userId: USER,
    projectId: "proj-b",
    assetKind: "card",
    assetId: "card-src",
    now: AT,
  });
  assert.equal(res.created, true, "首次挂用必须是新建");
  assert.equal(res.copied, true, "copy-on-use 必须真的建了副本");
  assert.equal(res.localCopyIds.length, 1);
  assert.equal(res.localCopyId, res.localCopyIds[0]);
  assert.notEqual(res.localCopyId, "card-src", "副本是独立实体，不得与来源同 id");

  const copy = await findCard(res.localCopyId);
  assert.ok(copy, "副本卡必须真的落在卡片库里");
  // 内容本体：逐栏照抄
  assert.equal(copy.prompt, "prompt-card-src", "副本必须复制内容本体而非只记引用");
  assert.equal(copy.kind, "character");
  // 副本自足：scope 指向目标项目（不是来源项目）
  assert.equal(copy.scope?.owner, "project");
  assert.equal(copy.scope?.projectId, "proj-b");
  // lineage 边：derivation → 来源卡
  assert.deepEqual(
    (copy.lineage ?? []).map((l) => [l.kind, l.assetId]),
    [["derivation", "card-src"]],
  );

  // 目标项目：副本可见可用；来源此刻仍可见（同帐号、他自己的项目卡）但两者互不影响
  assert.equal(
    resolveAssetVisibility({ id: copy.id, kind: "card", scope: copy.scope, ownerUserId: USER }, {
      viewerUserId: USER,
      projectId: "proj-b",
      shares: [],
    }),
    "in-project",
    "副本必须在目标项目可见（否则挂用等于没生效）",
  );
  // 生成注入：读的就是这批锁定卡
  assert.ok(injectedPrompt([copy]).includes("prompt-card-src"), "副本必须能真的注入生成 prompt");

  // 挂用记录带同一个副本 id（同键重挂 → 同一份副本）
  const mounts = await listAssetMounts(USER);
  assert.equal(mounts.length, 1);
  assert.equal(mounts[0].localCopyId, res.localCopyId);
  assert.equal(mounts[0].id, assetMountId("proj-b", "card", "card-src"));
});

test("B2b 挂用：来源删除后副本仍可用（副本自足）；lineage 态是『已删除』不是『来源不明』", async () => {
  reset();
  await saveCharacterCard(USER, card("card-src", { scope: { owner: "project", projectId: "proj-a" } }));
  const res = await mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-src", now: AT });
  const copyId = res.localCopyId;

  assert.equal(await deleteCharacterCards(USER, ["card-src"]), 1, "来源卡必须真的被删掉（不是假删）");
  const copy = await findCard(copyId);
  assert.ok(copy, "来源删除后副本必须还在");
  // 使用语义：仍然可见可用
  assert.equal(
    resolveAssetVisibility({ id: copy.id, kind: "card", scope: copy.scope, ownerUserId: USER }, {
      viewerUserId: USER,
      projectId: "proj-b",
      shares: [],
    }),
    "in-project",
  );
  // 生成语义：注入内容逐位不变（不需要解链前置动作）
  assert.ok(injectedPrompt([copy]).includes("prompt-card-src"));

  // 血统完整性：边还在（指向已删来源），链条解析为 deleted（而非 unknown-origin）
  assert.deepEqual((copy.lineage ?? []).map((l) => l.assetId), ["card-src"]);
  const pool: LineagePool = {
    find: (_jobId, assetId) => {
      // 池里只剩副本自己 → 来源查无＝已删除
      return assetId === copyId
        ? { lineage: copy.lineage, selfHandles: { assetId: copyId }, label: copy.name, thumbnailUrl: null, timeMs: null }
        : null;
    },
  };
  const { tree, rootHasLineage } = buildLineageTree(
    { lineage: copy.lineage, selfHandles: { assetId: copyId }, label: copy.name, thumbnailUrl: null, timeMs: null },
    pool,
  );
  assert.equal(rootHasLineage, true, "副本有血统登记");
  assert.equal(tree.children[0].status, "deleted", "来源查无但边在＝已删除态（与来源不明分开）");
  assert.equal(tree.children[0].link?.assetId, "card-src");
});

test("B2b 时间点冻结：来源日后更新不影响已挂用副本", async () => {
  reset();
  await saveCharacterCard(USER, card("card-src", { scope: { owner: "project", projectId: "proj-a" } }));
  const res = await mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-src", now: AT });
  const before = await findCard(res.localCopyId);

  // 来源改内容（同一 id upsert）
  await saveCharacterCard(USER, card("card-src", { prompt: "来源改过了", scope: { owner: "project", projectId: "proj-a" } }));
  const sourceAfter = await findCard("card-src");
  assert.equal(sourceAfter?.prompt, "来源改过了", "来源的更新必须真的落盘（否则这条测试是空的）");

  const after = await findCard(res.localCopyId);
  assert.equal(after?.prompt, "prompt-card-src", "副本内容必须冻结在挂用那一刻");
  assert.equal(after?.updatedAt, before?.updatedAt, "来源更新不得动副本的 updatedAt");
});

// ─────────────────────────────────────────── ④ 幂等（含并发/重放）

test("B2b 幂等：同 (projectId, sourceAssetId) 重复挂用只建一份副本，且重放零副作用", async () => {
  reset();
  await saveCharacterCard(USER, card("card-src", { scope: { owner: "project", projectId: "proj-a" } }));
  const first = await mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-src", now: AT });
  // 重放前先改来源：若重放会重写副本，这里会抓到
  await saveCharacterCard(USER, card("card-src", { prompt: "第二次挂用前的来源", scope: { owner: "project", projectId: "proj-a" } }));
  const replay = await mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-src", now: AT2 });

  assert.equal(replay.created, false, "同键重挂必须是幂等重放");
  assert.equal(replay.copied, false, "幂等重放不得再建副本");
  assert.equal(replay.localCopyId, first.localCopyId, "重放必须回同一份副本");

  const copies = (await listCharacterCards(USER)).filter((c) => c.id === first.localCopyId);
  assert.equal(copies.length, 1, "副本只能有一份");
  assert.equal(copies[0].prompt, "prompt-card-src", "重放不得覆写副本内容（冻结）");
  assert.equal((await listAssetMounts(USER)).length, 1, "挂用记录只能有一笔");
});

test("B2b 幂等：同键并发挂用也只建一份副本、一笔记录", async () => {
  reset();
  await saveCharacterCard(USER, card("card-src", { scope: { owner: "project", projectId: "proj-a" } }));
  const [a, b] = await Promise.all([
    mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-src", now: AT }),
    mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-src", now: AT }),
  ]);
  assert.equal(a.localCopyId, b.localCopyId, "并发必须收敛到同一个副本 id");
  assert.equal((await listCharacterCards(USER)).filter((c) => c.id === a.localCopyId).length, 1, "并发只准一份副本");
  assert.equal((await listAssetMounts(USER)).length, 1, "并发只准一笔挂用记录");
});

test("B2b 多项目：同一来源挂进不同项目＝两份独立副本（改一份不动另一份）", async () => {
  reset();
  await saveCharacterCard(USER, card("card-src"));
  const inB = await mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-src", now: AT });
  const inC = await mountAssetWithCopy({ userId: USER, projectId: "proj-c", assetKind: "card", assetId: "card-src", now: AT });
  assert.notEqual(inB.localCopyId, inC.localCopyId, "不同项目必须是不同副本");
  assert.equal((await findCard(inB.localCopyId))?.scope?.projectId, "proj-b");
  assert.equal((await findCard(inC.localCopyId))?.scope?.projectId, "proj-c");

  // 改 B 的副本 → C 的副本逐位不变
  await saveCharacterCard(USER, { ...(await findCard(inB.localCopyId))!, prompt: "只有 B 改了" });
  assert.equal((await findCard(inC.localCopyId))?.prompt, "prompt-card-src", "副本之间必须互相独立");
});

test("B2b 唯一分歧点：mode=reference 只落记录不建副本（方向可切换）", async () => {
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
  assert.equal((await listAssetMounts(USER)).length, 1, "挂用记录仍要落（同一笔记录键）");
});

// ─────────────────────────────────────────── 包挂用（逐 item 成卡）

test("B2b 包挂用：逐 item 复制成卡 + 本地包副本带 lineage；无卡投影的条目诚实回报", async () => {
  reset();
  await saveAssetPack(
    USER,
    pack("pack-src", [
      { kind: "prompt", title: "提示A", content: "内容A" },
      { kind: "image", title: "参考图", imageUrl: "https://example.com/a.png" },
      { kind: "lora", title: "Lora条目", loraVersionId: "lora-v1" },
    ]),
  );
  const res = await mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "pack", assetId: "pack-src", now: AT });

  assert.equal(res.localCopyIds.length, 2, "prompt + image 两条有卡投影 → 两张副本卡");
  assert.equal(res.skippedItems, 1, "lora 条目没有卡投影 → 诚实回报 1 条未复制");
  assert.equal(res.localCopyId, assetPackLocalCopyId("proj-b", "pack-src"));

  const promptCopy = await findCard(assetPackItemCopyId("proj-b", "pack-src", 0));
  assert.ok(promptCopy, "prompt 条目必须复制成卡");
  assert.equal(promptCopy.prompt, "内容A");
  assert.equal(promptCopy.scope?.projectId, "proj-b");
  // 条目卡的 lineage 指向来源包（可回溯到包）
  assert.deepEqual((promptCopy.lineage ?? []).map((l) => [l.kind, l.assetId]), [["derivation", "pack-src"]]);
  const imageCopy = await findCard(assetPackItemCopyId("proj-b", "pack-src", 1));
  assert.ok(imageCopy, "image 条目必须复制成卡");
  assert.equal(imageCopy.references[0]?.url, "https://example.com/a.png");

  // 包副本：本地包记录 + lineage → 来源包
  const packCopy = (await (await import("./asset-pack-store")).listAssetPacks(USER)).find((p) => p.id === res.localCopyId);
  assert.ok(packCopy, "目标项目必须有本地包副本");
  assert.equal(packCopy.scope?.projectId, "proj-b");
  assert.deepEqual((packCopy.lineage ?? []).map((l) => [l.kind, l.assetId]), [["derivation", "pack-src"]]);
  assert.equal(packCopy.items.length, 3, "包副本保留全部条目（没有卡投影的条目也不丢）");

  // 目标项目能用副本卡生成
  assert.ok(injectedPrompt([promptCopy]).includes("内容A"));

  // 来源包删除 → 副本仍自足
  await deleteAssetPacks(USER, ["pack-src"]);
  const afterDelete = await findCard(assetPackItemCopyId("proj-b", "pack-src", 0));
  assert.ok(afterDelete, "删来源包不得影响副本卡");
  assert.equal(
    resolveAssetVisibility({ id: afterDelete.id, kind: "card", scope: afterDelete.scope, ownerUserId: USER }, {
      viewerUserId: USER,
      projectId: "proj-b",
      shares: [],
    }),
    "in-project",
  );
});

test("B2b 包挂用幂等：重挂不重建副本、不重复建卡", async () => {
  reset();
  await saveAssetPack(USER, pack("pack-src", [{ kind: "prompt", title: "提示A", content: "内容A" }]));
  const first = await mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "pack", assetId: "pack-src", now: AT });
  const replay = await mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "pack", assetId: "pack-src", now: AT2 });
  assert.equal(replay.created, false);
  assert.equal(replay.copied, false);
  assert.deepEqual(replay.localCopyIds, first.localCopyIds);
  assert.equal((await listCharacterCards(USER)).length, 1, "重挂不得建第二张条目卡");
  const packs = await (await import("./asset-pack-store")).listAssetPacks(USER);
  assert.equal(packs.filter((p) => p.scope?.projectId === "proj-b").length, 1, "重挂不得建第二个包副本");
});

// ─────────────────────────────────────────── ⑤ 对抗性：键碰撞

test("B2b 对抗·键单射：长度前缀让易撞三元组两两不等，且副本键与 mount/share 键不同形", () => {
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
    assert.notEqual(a, b, `易撞三元组必须不相等：${JSON.stringify(left)} vs ${JSON.stringify(right)}`);
  }
  // 包条目副本与「资产卡副本」不同族（namespace 分隔）
  assert.notEqual(
    assetPackItemCopyId("proj", "pack-x", 0),
    assetLocalCopyId("proj", "card", "pack-x"),
    "包条目副本与卡副本必须不撞",
  );
  assert.notEqual(assetPackItemCopyId("proj", "pack-x", 1), assetPackItemCopyId("proj", "pack-x", 0));

  // 副本键 vs mount/share 键：不同形、不相等
  const copyId = assetLocalCopyId("proj", "pack", "pack-x");
  assert.notEqual(copyId, assetMountId("proj", "pack", "pack-x"));
  assert.notEqual(copyId, assetShareId("pack", "pack-x", "proj", "other"));

  // 副本 id 必须可用作资产 id（卡片 id 上限 100、无保留分隔符）
  assert.equal(isUsableAssetId(copyId), true, "副本 id 必须能当资产卡 id");
  assert.ok(copyId.length <= 100, "副本 id 必须在卡片 id 上限内");
  assert.ok(!copyId.includes(":"), "副本 id 不得含保留分隔符");
});

test("B2b 对抗·边界拒绝：含分隔符/超长/空的来源 id 进不了副本链（不猜不撞键）", async () => {
  reset();
  // 确定性键的边界：非法 id 一律清洗成 null
  assert.equal(normalizeAssetMount({ projectId: "p", assetKind: "card", assetId: "x:card:y" }), null);
  assert.equal(normalizeAssetMount({ projectId: "p", assetKind: "card", assetId: "a".repeat(201) }), null);
  assert.equal(normalizeAssetMount({ projectId: "", assetKind: "card", assetId: "ok" }), null);
  // 对照：合法三元组必须清洗得出来（否则上面的 null 断言是空的）
  const ok = normalizeAssetMount({ projectId: "p", assetKind: "card", assetId: "ok" });
  assert.ok(ok);
  assert.equal(ok.assetId, "ok");
  assert.equal(ok.localCopyId, assetLocalCopyId("p", "card", "ok"));

  // 进入挂用：含分隔符的来源在卡库里不存在（存档收口也拒）→ 诚实 404 语义，不建任何东西
  await assert.rejects(
    () => mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "x:card:y" }),
    AssetSourceMissingError,
  );
  await assert.rejects(
    () => mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "pack", assetId: "nope" }),
    AssetSourceMissingError,
  );
  assert.equal((await listCharacterCards(USER)).length, 0, "拒绝路径不得留下副本");
  assert.equal((await listAssetMounts(USER)).length, 0, "拒绝路径不得留下挂用记录");
});

test("B2b 对抗·撞键不冒充幂等：副本键被非副本资产占用 → 409 冲突，不静默成功", async () => {
  reset();
  await saveCharacterCard(USER, card("card-src", { scope: { owner: "project", projectId: "proj-a" } }));
  const copyId = assetLocalCopyId("proj-b", "card", "card-src");
  // 伪造占用者：同 id，但既不属于 proj-b 也没有指向来源的 derivation 边
  await saveCharacterCard(USER, card(copyId, { prompt: "我是别人的卡" }));

  await assert.rejects(
    () => mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-src", now: AT }),
    AssetMountCopyConflictError,
    "撞键必须是冲突，不得当成幂等重放",
  );
  const occupant = await findCard(copyId);
  assert.equal(occupant?.prompt, "我是别人的卡", "占用者不得被覆写");
  assert.equal((await listAssetMounts(USER)).length, 0, "冲突时不得留下挂用记录（不留半套状态）");
});

test("B2b 对抗·超上限：容量不足诚实拒绝，不静默截断", async () => {
  reset();
  for (let i = 0; i < MAX_CARDS_PER_USER; i += 1) {
    await saveCharacterCard(USER, card(`card-fill-${i}`));
  }
  await saveCharacterCard(USER, card("card-src"));
  assert.equal((await listCharacterCards(USER)).length, MAX_CARDS_PER_USER, "前置：卡库已满");
  await assert.rejects(
    () => mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-src", now: AT }),
    AssetCopyLimitError,
  );
  assert.equal((await listAssetMounts(USER)).length, 0, "超限时不得留下挂用记录");
});

// ─────────────────────────────────────────── ⑤ 对抗性：递归与环路

test("B2b 对抗·递归挂用可回溯：copy of copy 的血统链可逐级解析回到最上游", async () => {
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
  assert.equal(step2.copied, true, "副本必须可再被挂用（递归挂用被允许）");

  const copy2 = await findCard(step2.localCopyId);
  assert.ok(copy2);
  // 血统：只登记**直接来源**（副本1）；最上游由读取端沿链逐级解析（见下方树状断言）
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
  assert.equal(level1.status, "resolved", "第一级（副本1）必须解析得到");
  assert.equal(level1.link?.assetId, step1.localCopyId);
  assert.equal(level1.children.length, 1);
  const level2 = level1.children[0];
  assert.equal(level2.status, "resolved", "第二级（最上游来源）必须解析得到");
  assert.equal(level2.link?.assetId, "card-a");
});

test("B2b 对抗·环路必拒：血统成环或副本会成为自己祖先 → 拒绝且不留任何痕迹", async () => {
  reset();
  // (1) 来源的祖先链已含自己（既有资料成环）
  await saveCharacterCard(USER, card("card-self", { lineage: [{ kind: "derivation", assetId: "card-self", at: AT }] }));
  await assert.rejects(
    () => mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-self", now: AT }),
    AssetMountCopyRejectedError,
  );

  // (2) 来源声称派生自「本次要建的副本」→ 副本会成为自己的祖先
  const wouldBeCopyId = assetLocalCopyId("proj-b", "card", "card-x");
  await saveCharacterCard(USER, card("card-x", { lineage: [{ kind: "derivation", assetId: wouldBeCopyId, at: AT }] }));
  await assert.rejects(
    () => mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-x", now: AT }),
    AssetMountCopyRejectedError,
  );

  assert.equal((await listAssetMounts(USER)).length, 0, "拒绝路径不得留下挂用记录");
  const copies = (await listCharacterCards(USER)).filter((c) => c.scope?.projectId === "proj-b");
  assert.equal(copies.length, 0, "拒绝路径不得建副本");
});

test("B2b 纯函式：planAssetMountCopy 是唯一分歧点（copy-on-use / reference / 幂等 / 环路）", () => {
  const base = { projectId: "proj-b", assetKind: "card" as const, sourceAssetId: "card-src" };
  const copyId = assetLocalCopyId("proj-b", "card", "card-src");

  const fresh = planAssetMountCopy(base);
  assert.equal(fresh.ok, true);
  assert.equal(fresh.ok && fresh.plan.shouldCreateCopy, true);
  assert.equal(fresh.ok && fresh.plan.localCopyId, copyId);

  const existing = planAssetMountCopy({ ...base, existingCopyIds: [copyId] });
  assert.equal(existing.ok, true);
  assert.equal(existing.ok && existing.plan.shouldCreateCopy, false, "已有副本＝幂等重放，不重建");
  assert.equal(existing.ok && existing.plan.existingCopyId, copyId);

  const reference = planAssetMountCopy({ ...base, mode: "reference" });
  assert.equal(reference.ok, true);
  assert.equal(reference.ok && reference.plan.localCopyId, null, "引用制不落地副本");
  assert.equal(reference.ok && reference.plan.shouldCreateCopy, false);

  const cyclic = planAssetMountCopy({ ...base, ancestorAssetIds: [copyId] });
  assert.equal(cyclic.ok, false);
  assert.equal(cyclic.ok === false && cyclic.reason, "cyclic_lineage");

  // 副本再挂回「来源所属项目」不是环（递归挂用被允许）
  const recursive = planAssetMountCopy({ projectId: "proj-a", assetKind: "card", sourceAssetId: copyId, ancestorAssetIds: ["card-src"] });
  assert.equal(recursive.ok, true, "把副本挂回来源项目不得被当成环");
});

// ─────────────────────────────────────────── ⑥ lineage 零跨 project

test("B2b 不变量·生成输入零跨 project：锁定集经闸后每张卡都属本项目或个人（含反向对照）", async () => {
  reset();
  await saveCharacterCard(USER, card("card-in-a", { scope: { owner: "project", projectId: "proj-a" } }));
  await saveCharacterCard(USER, card("card-personal"));
  // 反向对照：未经闸的原始锁定集确实含有跨 project 的卡（证明下面的扫描不是恒真）
  const raw = ["card-in-a", "card-personal"];
  const rawCross = raw.filter((id) => id === "card-in-a");
  assert.equal(rawCross.length, 1, "反向对照：原始集合确实跨 project（否则扫描是空的）");

  // 经写入端闸（= 落在 CanvasProject.cardIds 的那份）
  const gated = await filterCardIdsForProject({ userId: USER, projectId: "proj-b", cardIds: raw });
  const cards = await listCharacterCards(USER);
  const byId = new Map(cards.map((c) => [c.id, c] as const));
  for (const id of gated) {
    const card = byId.get(id);
    if (!card) continue;
    const ownedBy = card.scope?.owner === "project" ? card.scope.projectId : null;
    assert.ok(
      ownedBy === null || ownedBy === "proj-b",
      `锁定集不得含别的项目的卡：${id} 属于 ${ownedBy}`,
    );
  }
  assert.deepEqual(gated, ["card-personal"], "跨项目卡被闸剔除、个人卡原样保留");

  // 读取端闸（生成注入读的那份）对同一集合的结论必须一致
  const locked = gated.flatMap((id) => (byId.get(id) ? [byId.get(id)!] : []));
  assert.deepEqual(
    filterLockedCardsForProjectUse(locked, { projectId: "proj-b", shares: [] }).map((c) => c.id),
    locked.map((c) => c.id),
    "写入端放行 = 读取端放行（两端同一把尺）",
  );
});

test("B2b 不变量·血统边不承载使用：删光所有祖先，宿主卡仍可用（跨项目来源不是依赖）", async () => {
  reset();
  await saveCharacterCard(USER, card("card-src", { scope: { owner: "project", projectId: "proj-a" } }));
  const res = await mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-src", now: AT });
  const copy = (await findCard(res.localCopyId))!;
  const before = injectedPrompt([copy]);

  // 把来源（另一项目的祖先）删掉——血统边指向它，但注入输出不得变
  await deleteCharacterCards(USER, ["card-src"]);
  const after = (await findCard(res.localCopyId))!;
  assert.equal(injectedPrompt([after]), before, "祖先缺席不得改变注入结果（血统只给人看）");
  assert.deepEqual((after.lineage ?? []).map((l) => l.assetId), ["card-src"], "边仍留痕（已删除态）");
});

// ─────────────────────────────────────────── ⑦ 读取端作用域闸（残留 a/b）

test("B2b 读取闸：跨项目未分享的卡 fail-closed（a 类）；个人 legacy 卡与分享进来照用（b 类）", () => {
  const cards = [
    { id: "card-personal" },
    { id: "card-in-p", scope: { owner: "project" as const, projectId: "proj-p" } },
    { id: "card-in-q", scope: { owner: "project" as const, projectId: "proj-q" } },
  ];
  const pCtx = { projectId: "proj-p", shares: [] as AssetShareRecord[] };
  assert.deepEqual(
    filterLockedCardsForProjectUse(cards, pCtx).map((c) => c.id),
    ["card-personal", "card-in-p"],
    "别的项目未分享的卡必须剔除（a 类 fail-closed）；个人卡与本项目卡保留（b 类零回归）",
  );

  // 显式分享进来 → 保留；撤销 → 立刻剔除
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
    "显式分享进来的卡必须照用（与写入端放行一致）",
  );
  assert.deepEqual(
    filterLockedCardsForProjectUse(cards, { projectId: "proj-p", shares: [{ ...share, revokedAt: AT2 }] }).map((c) => c.id),
    ["card-personal", "card-in-p"],
    "撤销后立刻回到剔除",
  );

  // 无项目上下文：项目归属的卡一律剔除（只有个人卡可用）
  assert.deepEqual(
    filterLockedCardsForProjectUse(cards, { projectId: null, shares: [] }).map((c) => c.id),
    ["card-personal"],
  );

  // 读取闸与伺服器端裁决函式逐条同构（同 input 同结论）
  for (const card of cards) {
    const expected =
      resolveAssetScopeVisibility({ id: card.id, kind: "card", scope: card.scope }, { viewerUserId: 0, ...pCtx }) !== null;
    const actual = filterLockedCardsForProjectUse([card], pCtx).length === 1;
    assert.equal(actual, expected, `${card.id} 读取闸与裁决函式必须同结论`);
  }
});

// ─────────────────────────────────────────── 解除挂用回报（前端解锁用）

test("B2b 解除挂用：mountCopyIds 回该记录的副本 id（卡＝单一；包＝包副本＋逐 item 卡副本）", async () => {
  reset();
  await saveCharacterCard(USER, card("card-src", { scope: { owner: "project", projectId: "proj-a" } }));
  const cardMount = await mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-src", now: AT });
  assert.deepEqual(
    await mountCopyIds({ userId: USER, projectId: "proj-b", assetKind: "card", assetId: "card-src" }),
    { localCopyId: cardMount.localCopyId, localCopyIds: [cardMount.localCopyId] },
  );

  await saveAssetPack(USER, pack("pack-src", [
    { kind: "prompt", title: "提示A", content: "内容A" },
    { kind: "prompt", title: "提示B", content: "内容B" },
  ]));
  const packMount = await mountAssetWithCopy({ userId: USER, projectId: "proj-b", assetKind: "pack", assetId: "pack-src", now: AT });
  const ids = await mountCopyIds({ userId: USER, projectId: "proj-b", assetKind: "pack", assetId: "pack-src" });
  assert.equal(ids.localCopyId, packMount.localCopyId);
  assert.deepEqual(ids.localCopyIds, [
    packMount.localCopyId,
    assetPackItemCopyId("proj-b", "pack-src", 0),
    assetPackItemCopyId("proj-b", "pack-src", 1),
  ]);

  // 没挂用过 → 空（前端不会误解锁）
  assert.deepEqual(
    await mountCopyIds({ userId: USER, projectId: "proj-z", assetKind: "card", assetId: "card-src" }),
    { localCopyId: null, localCopyIds: [] },
  );
});

// ─────────────────────────────────────────── 挂用副本 → cardIds（前端锁定的行为断言）

test("B2b 锁定集：挂用副本进得了 cardIds、解除会移除、重复挂用不重复一笔", () => {
  const copy = assetLocalCopyId("proj-b", "card", "card-src");
  // 首次挂用：副本进集合
  assert.deepEqual(applyCopyLockChange(["card-personal"], { locked: [copy], unlocked: [] }), [
    "card-personal",
    copy,
  ]);
  // 重复挂用（同 copy 两次）→ 只一份（幂等）
  assert.deepEqual(applyCopyLockChange([copy], { locked: [copy], unlocked: [] }), [copy]);
  // 包挂用：逐 item 副本一起锁
  const packCopies = [assetPackItemCopyId("proj-b", "pack-src", 0), assetPackItemCopyId("proj-b", "pack-src", 1)];
  assert.deepEqual(applyCopyLockChange([], { locked: packCopies, unlocked: [] }), packCopies);
  // 解除挂用：副本出集合
  assert.deepEqual(applyCopyLockChange(["card-personal", copy], { locked: [], unlocked: [copy] }), ["card-personal"]);
  // 解除不在集合里的 id：无副作用（不得把别人的锁定误删）
  assert.deepEqual(applyCopyLockChange(["card-personal"], { locked: [], unlocked: ["card-other"] }), ["card-personal"]);
  // 空字串/空白 id 不得污染集合
  assert.deepEqual(applyCopyLockChange(["card-personal"], { locked: ["", "  "], unlocked: [] }), ["card-personal"]);
  // 锁定与解锁同时（换包场景）：先移除、再补进，两者都生效
  assert.deepEqual(applyCopyLockChange([packCopies[0], "card-personal"], { locked: [copy], unlocked: [packCopies[0]] }), [
    "card-personal",
    copy,
  ]);
});

// ─────────────────────────────────────────── 残留 a/b 类命中数（可重跑的查法）

test("B2b 残留命中数查法：由 projects(cardIds) × cards(scope) × shares 推导 a/b 两类", async () => {
  reset();
  // 造出「既有画布」的样子：两个项目各自锁定 cardIds；卡库里 personal（legacy）与跨项目卡并存
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
        bClass += 1; // 同 owner（个人）跨 project 的旧锁定卡
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
  assert.equal(aClass, 1, "只有 proj-b 锁定的 card-in-a 是 a 类（proj-a 自己锁自己不算）");
  assert.equal(bClass, 2, "两笔 personal legacy 锁定＝b 类（proj-a 一笔、proj-b 一笔）");
  assert.equal(unknown, 1, "查不到的 id 单独计（不猜）");
});
