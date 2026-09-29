// 作品公開分享的行為斷言（行為 oracle，不是源碼字串探針）。
//
// 測的是使用者會撞到的事：①沒分享過的作品查無此頁 ②撤銷後同一條連結當場 404
// ③shareId 不可由 artifact/entry id 推得、也不可枚舉 ④分享連結帶對的歸因參數、
// 「做同款」注入的欄位正確（隱藏提示詞時半個字都不露）。
//
// 存儲走 share-store 的記憶體降級（NODE_ENV !== production 時自動允許，見
// blob-backend 的 blobMemoryFallbackAllowed）——這條測的是語義，不是物件儲存。

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

/** 專屬 owner，避免與同一進程內其他測試共用記憶體索引。 */
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

test("未分享的作品＝查無此頁（/p 頁 404）", async () => {
  assert.equal(await getPublicShare(generateShareId()), null, "沒建過記錄的 id 必須讀不到");
  assert.equal(await getPublicShare("not-a-share-id"), null, "畸形 id 也不得命中");
  assert.equal(await getPublicShare(""), null);
});

test("撤銷後同一條連結當場 404", async () => {
  const { record, reused } = await createShare(shareInput("entry-revoke"));
  assert.equal(reused, false);

  const opened = await getPublicShare(record.shareId);
  assert.ok(opened, "剛分享的作品必須讀得到");
  assert.equal(opened.view.imageUrl, "https://example.invalid/entry-revoke.png");
  assert.equal(opened.view.prompt, "雾中的松林");

  assert.equal(await revokeShare(OWNER, record.shareId), true);
  assert.equal(await getPublicShare(record.shareId), null, "撤銷＝刪記錄，同一條連結立即失效");
  // 撤銷別人的／不存在的：不該當成成功。
  assert.equal(await revokeShare(OWNER + 1, record.shareId), false);
});

test("shareId 不可枚舉，也不由 entry id 推得", () => {
  const entryId = "entry-1729-secret";
  const seen = new Set<string>();
  for (let i = 0; i < 200; i += 1) {
    const id = generateShareId();
    assert.equal(id.length, SHARE_ID_LENGTH);
    assert.ok(isShareId(id), `產生的 id 必須通過形狀檢查：${id}`);
    assert.ok(!id.includes(entryId), "id 不得夾帶來源識別");
    seen.add(id);
  }
  assert.equal(seen.size, 200, "200 次產生必須全不重複（可枚舉＝整櫃作品被掃走）");
  assert.ok(!isShareId(entryId), "entry id 本身不是合法 shareId");
  assert.ok(!isShareId("A".repeat(SHARE_ID_LENGTH - 1)));
});

test("同一件作品重複點分享＝同一條連結（冪等），且與 entry id 無關", async () => {
  const first = await createShare(shareInput("entry-idempotent"));
  const second = await createShare(shareInput("entry-idempotent"));

  assert.equal(first.reused, false);
  assert.equal(second.reused, true, "第二次必須重用，否則使用者貼出去的舊連結會被悄悄換掉");
  assert.equal(second.record.shareId, first.record.shareId);
  assert.notEqual(first.record.shareId, "entry-idempotent");

  // 同 owner 的另一件作品必須是另一條連結（不然兩件作品共用一條公開頁）。
  const other = await createShare(shareInput("entry-other"));
  assert.notEqual(other.record.shareId, first.record.shareId);
});

test("做同款注入：帶上提示詞與原參數；提示詞不可用時半個字都不露", () => {
  const full = buildRemixSeed({
    prompt: " 雾中的松林 ",
    modelId: "gpt-image-2",
    aspectRatio: "16:9",
    imageSize: "1024x1024",
  });
  assert.ok(full.startsWith(REMIX_SEED_PREFIX));
  assert.ok(full.includes("雾中的松林"), "提示詞要進注入字串");
  assert.ok(full.includes("模型 gpt-image-2"));
  assert.ok(full.includes("比例 16:9"));
  assert.ok(full.includes("尺寸 1024x1024"));

  // 隱藏提示詞：只有參數引導語，且不得從被隱藏的原文拿任何字。
  const hidden = buildRemixSeed({ prompt: "", modelId: "gpt-image-2", aspectRatio: "16:9", imageSize: "" });
  assert.ok(hidden.startsWith(REMIX_RECIPE_ONLY_PREFIX));
  assert.ok(!hidden.includes("松林"));
  assert.ok(hidden.includes("模型 gpt-image-2"));

  // 三者皆缺＝整個括號不出現（不編造空欄位）。
  assert.equal(buildRecipeText({}), "");
  assert.equal(buildRecipeText({ prompt: "只有提示詞" }), "");
});

test("分享連結帶歸因參數；canonical 路徑不帶參數", () => {
  const id = "abcdefghijklmnopqrstuv";
  assert.deepEqual(shareUtmParams(id), { utm_source: "share", utm_medium: "p", ref: id });

  assert.equal(
    buildShareUrl("https://eimu.dev/", id),
    `https://eimu.dev/p/${id}?utm_source=share&utm_medium=p&ref=${id}`,
    "尾斜線要收乾淨，且歸因三件套必須到齊",
  );
  assert.equal(buildSharePath(id), `/p/${id}`, "canonical 不帶 utm（帶了等於自造重複頁）");

  const handoff = buildRemixHandoffUrl(id, "照这个想法再做一版：雾中的松林");
  assert.ok(handoff.startsWith("/?agent=1&q="), "復用圖庫卡既有的 ?agent=1&q= 交接通道");
  assert.ok(handoff.includes("utm_source=share"));
  assert.ok(handoff.includes("utm_medium=p"));
  assert.ok(handoff.includes(`ref=${id}`));
});

test("隱藏提示詞的分享：對外視圖 prompt 恆為 null", () => {
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