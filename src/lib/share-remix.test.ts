// 作品公开分享的行为断言（行为 oracle，不是源码字串探针）。
//
// 测的是使用者会撞到的事：①没分享过的作品查无此页 ②撤销后同一条连结当场 404
// ③shareId 不可由 artifact/entry id 推得、也不可枚举 ④分享连结带对的归因参数、
// 「做同款」注入的栏位正确（隐藏提示词时半个字都不露）。
//
// 存储走 share-store 的记忆体降级（NODE_ENV !== production 时自动允许，见
// blob-backend 的 blobMemoryFallbackAllowed）——这条测的是语义，不是物件储存。

import assert from "node:assert/strict";
import test from "node:test";

import { SHARE_ID_LENGTH, generateShareId, isShareId } from "./share-id";
import {
  REMIX_RECIPE_ONLY_PREFIX,
  REMIX_SEED_PREFIX,
  buildRecipeText,
  buildRemixHandoffUrl,
  buildRemixSeed,
  buildSharePath,
  buildShareUrl,
  publicShareView,
  shareUtmParams,
} from "./share-remix";
import { createShare, getPublicShare, revokeShare, type CreateShareInput } from "./share-store";

/** 专属 owner，避免与同一进程内其他测试共用记忆体索引。 */
const OWNER = 990001;

function shareInput(entryId: string, overrides: Partial<CreateShareInput> = {}): CreateShareInput {
  return {
    userId: OWNER,
    entryId,
    resultIndex: 0,
    hidePrompt: false,
    snapshot: {
      prompt: "雾中的松林",
      modelId: "gpt-image-2",
      aspectRatio: "16:9",
      imageSize: "1024x1024",
      imageUrl: `https://example.invalid/${entryId}.png`,
    },
    ...overrides,
  };
}

test("未分享的作品＝查无此页（/p 页 404）", async () => {
  assert.equal(await getPublicShare(generateShareId()), null, "没建过记录的 id 必须读不到");
  assert.equal(await getPublicShare("not-a-share-id"), null, "畸形 id 也不得命中");
  assert.equal(await getPublicShare(""), null);
});

test("撤销后同一条连结当场 404", async () => {
  const { record, reused } = await createShare(shareInput("entry-revoke"));
  assert.equal(reused, false);

  const opened = await getPublicShare(record.shareId);
  assert.ok(opened, "刚分享的作品必须读得到");
  assert.equal(opened.view.imageUrl, "https://example.invalid/entry-revoke.png");
  assert.equal(opened.view.prompt, "雾中的松林");

  assert.equal(await revokeShare(OWNER, record.shareId), true);
  assert.equal(await getPublicShare(record.shareId), null, "撤销＝删记录，同一条连结立即失效");
  // 撤销别人的／不存在的：不该当成成功。
  assert.equal(await revokeShare(OWNER + 1, record.shareId), false);
});

test("shareId 不可枚举，也不由 entry id 推得", () => {
  const entryId = "entry-1729-secret";
  const seen = new Set<string>();
  for (let i = 0; i < 200; i += 1) {
    const id = generateShareId();
    assert.equal(id.length, SHARE_ID_LENGTH);
    assert.ok(isShareId(id), `产生的 id 必须通过形状检查：${id}`);
    assert.ok(!id.includes(entryId), "id 不得夹带来源识别");
    seen.add(id);
  }
  assert.equal(seen.size, 200, "200 次产生必须全不重复（可枚举＝整柜作品被扫走）");
  assert.ok(!isShareId(entryId), "entry id 本身不是合法 shareId");
  assert.ok(!isShareId("A".repeat(SHARE_ID_LENGTH - 1)));
});

test("同一件作品重复点分享＝同一条连结（幂等），且与 entry id 无关", async () => {
  const first = await createShare(shareInput("entry-idempotent"));
  const second = await createShare(shareInput("entry-idempotent"));

  assert.equal(first.reused, false);
  assert.equal(second.reused, true, "第二次必须重用，否则使用者贴出去的旧连结会被悄悄换掉");
  assert.equal(second.record.shareId, first.record.shareId);
  assert.notEqual(first.record.shareId, "entry-idempotent");

  // 同 owner 的另一件作品必须是另一条连结（不然两件作品共用一条公开页）。
  const other = await createShare(shareInput("entry-other"));
  assert.notEqual(other.record.shareId, first.record.shareId);
});

test("做同款注入：带上提示词与原参数；提示词不可用时半个字都不露", () => {
  const full = buildRemixSeed({
    prompt: " 雾中的松林 ",
    modelId: "gpt-image-2",
    aspectRatio: "16:9",
    imageSize: "1024x1024",
  });
  assert.ok(full.startsWith(REMIX_SEED_PREFIX));
  assert.ok(full.includes("雾中的松林"), "提示词要进注入字串");
  assert.ok(full.includes("模型 gpt-image-2"));
  assert.ok(full.includes("比例 16:9"));
  assert.ok(full.includes("尺寸 1024x1024"));

  // 隐藏提示词：只有参数引导语，且不得从被隐藏的原文拿任何字。
  const hidden = buildRemixSeed({ prompt: "", modelId: "gpt-image-2", aspectRatio: "16:9", imageSize: "" });
  assert.ok(hidden.startsWith(REMIX_RECIPE_ONLY_PREFIX));
  assert.ok(!hidden.includes("松林"));
  assert.ok(hidden.includes("模型 gpt-image-2"));

  // 三者皆缺＝整个括号不出现（不编造空栏位）。
  assert.equal(buildRecipeText({}), "");
  assert.equal(buildRecipeText({ prompt: "只有提示词" }), "");
});

test("分享连结带归因参数；canonical 路径不带参数", () => {
  const id = "abcdefghijklmnopqrstuv";
  assert.deepEqual(shareUtmParams(id), { utm_source: "share", utm_medium: "p", ref: id });

  assert.equal(
    buildShareUrl("https://eimu.dev/", id),
    `https://eimu.dev/p/${id}?utm_source=share&utm_medium=p&ref=${id}`,
    "尾斜线要收干净，且归因三件套必须到齐",
  );
  assert.equal(buildSharePath(id), `/p/${id}`, "canonical 不带 utm（带了等于自造重复页）");

  const handoff = buildRemixHandoffUrl(id, "照这个想法再做一版：雾中的松林");
  assert.ok(handoff.startsWith("/?agent=1&q="), "复用图库卡既有的 ?agent=1&q= 交接通道");
  assert.ok(handoff.includes("utm_source=share"));
  assert.ok(handoff.includes("utm_medium=p"));
  assert.ok(handoff.includes(`ref=${id}`));
});

test("隐藏提示词的分享：对外视图 prompt 恒为 null", () => {
  const view = publicShareView({
    schemaVersion: 1,
    shareId: "abcdefghijklmnopqrstuv",
    ownerUserId: OWNER,
    entryId: "entry-hidden",
    resultIndex: 0,
    createdAt: 0,
    hidePrompt: true,
    snapshot: {
      prompt: "这是不该外露的秘密提示词",
      modelId: "gpt-image-2",
      aspectRatio: "1:1",
      imageSize: "1024x1024",
      imageUrl: "https://example.invalid/hidden.png",
    },
  });
  assert.equal(view.prompt, null);
  assert.equal(view.imageUrl, "https://example.invalid/hidden.png");
});