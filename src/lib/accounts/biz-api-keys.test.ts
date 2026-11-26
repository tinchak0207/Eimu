import test from "node:test";
import assert from "node:assert/strict";

import {
  BIZ_KEY_DEFAULT_RPM,
  BIZ_KEY_MAX_RPM,
  BIZ_KEY_PREFIX,
  consumeRateLimit,
  generateBizApiKey,
  hashBizApiKey,
  hashesEqual,
  isModelAllowedForKey,
  looksLikeBizApiKey,
  normalizeBizKeyDraft,
  previewBizApiKey,
  readBearerToken,
  toPublicBizApiKey,
  type BizApiKey,
} from "./biz-api-keys.ts";

const MODELS = ["gpt-image-2", "gemini-3.1-flash-image", "seedream-2.0", "adobe-firefly"];

// ─────────────────────────────────────────── 生成与哈希

test("generateBizApiKey 产出带前缀的 32 位十六进制密钥，且每次都不同", () => {
  const a = generateBizApiKey();
  const b = generateBizApiKey();

  assert.ok(a.key.startsWith(BIZ_KEY_PREFIX));
  assert.equal(a.key.length, BIZ_KEY_PREFIX.length + 32);
  assert.match(a.key.slice(BIZ_KEY_PREFIX.length), /^[0-9a-f]{32}$/);
  assert.notEqual(a.key, b.key, "两次签发不能撞");
  assert.notEqual(a.keyHash, b.keyHash);
});

test("存储里只有哈希，拿不到明文", () => {
  const generated = generateBizApiKey();
  assert.equal(generated.keyHash, hashBizApiKey(generated.key));
  assert.equal(generated.keyHash.length, 64, "sha256 十六进制是 64 位");
  assert.ok(!generated.keyHash.includes(generated.key.slice(BIZ_KEY_PREFIX.length)));
});

test("hashBizApiKey 忽略首尾空白 —— 聚合平台常在配置里带上换行", () => {
  const key = generateBizApiKey().key;
  assert.equal(hashBizApiKey(` ${key}\n`), hashBizApiKey(key));
});

test("previewBizApiKey 只暴露前 6 位，无法反推", () => {
  const preview = previewBizApiKey(`${BIZ_KEY_PREFIX}0123456789abcdef0123456789abcdef`);
  assert.equal(preview, `${BIZ_KEY_PREFIX}012345…`);
  assert.ok(!preview.includes("6789abcdef"));
});

test("looksLikeBizApiKey 挡掉非本站密钥，省一次查表", () => {
  assert.equal(looksLikeBizApiKey(generateBizApiKey().key), true);
  assert.equal(looksLikeBizApiKey("sk-proj-abc"), false);
  assert.equal(looksLikeBizApiKey(`${BIZ_KEY_PREFIX}短了`), false);
  assert.equal(looksLikeBizApiKey(`${BIZ_KEY_PREFIX}0123456789ABCDEF0123456789abcdef`), false, "大写不是我们签发的");
  assert.equal(looksLikeBizApiKey(""), false);
});

test("hashesEqual 对不同长度与不同内容都返回 false，且不抛错", () => {
  const a = hashBizApiKey("a");
  const b = hashBizApiKey("b");
  assert.equal(hashesEqual(a, a), true);
  assert.equal(hashesEqual(a, b), false);
  assert.doesNotThrow(() => hashesEqual(a, "short"));
  assert.equal(hashesEqual(a, "short"), false);
});

// ─────────────────────────────────────────── Authorization 解析

test("readBearerToken 容忍大小写与多余空格", () => {
  assert.equal(readBearerToken("Bearer sk-biz-abc"), "sk-biz-abc");
  assert.equal(readBearerToken("bearer sk-biz-abc"), "sk-biz-abc");
  assert.equal(readBearerToken("BEARER   sk-biz-abc  "), "sk-biz-abc");
  assert.equal(readBearerToken("  Bearer sk-biz-abc"), "sk-biz-abc");
});

test("readBearerToken 对缺失或非 Bearer 的头返回 null", () => {
  assert.equal(readBearerToken(null), null);
  assert.equal(readBearerToken(""), null);
  assert.equal(readBearerToken("sk-biz-abc"), null, "没有 Bearer 前缀不算");
  assert.equal(readBearerToken("Basic dXNlcjpwYXNz"), null);
  assert.equal(readBearerToken("Bearer"), null);
  assert.equal(readBearerToken("Bearer   "), null);
});

// ─────────────────────────────────────────── 草稿校验

test("normalizeBizKeyDraft 接受合法表单并补上默认值", () => {
  const result = normalizeBizKeyDraft({ label: "客户A", userId: 12 }, MODELS);
  assert.ok(result.ok);
  assert.deepEqual(result.draft, {
    label: "客户A",
    userId: 12,
    rpm: BIZ_KEY_DEFAULT_RPM,
    allowedModels: [],
    enabled: true,
  });
});

test("normalizeBizKeyDraft 拒绝空名称与非法用户 id", () => {
  for (const bad of [
    {},
    { label: "   ", userId: 12 },
    { label: "A" },
    { label: "A", userId: 0 },
    { label: "A", userId: -3 },
    { label: "A", userId: 1.5 },
    { label: "A", userId: "abc" },
  ]) {
    assert.equal(normalizeBizKeyDraft(bad, MODELS).ok, false, `${JSON.stringify(bad)} 应被拒绝`);
  }
  // userId 0 是本地测试身份，不能当计费主体
  const zero = normalizeBizKeyDraft({ label: "A", userId: 0 }, MODELS);
  assert.equal(zero.ok, false);
});

test("normalizeBizKeyDraft 把 rpm 限制在合法区间", () => {
  assert.equal(normalizeBizKeyDraft({ label: "A", userId: 1, rpm: 0 }, MODELS).ok, false);
  assert.equal(normalizeBizKeyDraft({ label: "A", userId: 1, rpm: BIZ_KEY_MAX_RPM + 1 }, MODELS).ok, false);
  const ok = normalizeBizKeyDraft({ label: "A", userId: 1, rpm: "120" }, MODELS);
  assert.ok(ok.ok);
  assert.equal(ok.draft.rpm, 120, "字符串数字应被接受");
});

test("normalizeBizKeyDraft 丢掉不认识的模型并去重", () => {
  const result = normalizeBizKeyDraft(
    { label: "A", userId: 1, allowedModels: ["gpt-image-2", "gpt-image-2", "不存在的模型", 42] },
    MODELS,
  );
  assert.ok(result.ok);
  assert.deepEqual(result.draft.allowedModels, ["gpt-image-2"]);
});

test("normalizeBizKeyDraft 截断过长的客户名称", () => {
  const result = normalizeBizKeyDraft({ label: "名".repeat(200), userId: 1 }, MODELS);
  assert.ok(result.ok);
  assert.ok(result.draft.label.length <= 60);
});

test("toPublicBizApiKey 不把 keyHash 带出去", () => {
  const key: BizApiKey = {
    id: "k1",
    label: "客户A",
    keyHash: "deadbeef",
    keyPreview: "sk-biz-012345…",
    userId: 12,
    enabled: true,
    rpm: 60,
    allowedModels: [],
    createdAt: 1,
    totalRequests: 0,
    totalImages: 0,
  };
  const publicView = toPublicBizApiKey(key);
  assert.equal("keyHash" in publicView, false);
  assert.equal(publicView.keyPreview, "sk-biz-012345…");
});

// ─────────────────────────────────────────── 模型白名单

test("isModelAllowedForKey：空白名单表示不限", () => {
  assert.equal(isModelAllowedForKey({ allowedModels: [] }, "gpt-image-2"), true);
  assert.equal(isModelAllowedForKey({ allowedModels: ["gpt-image-2"] }, "gpt-image-2"), true);
  assert.equal(isModelAllowedForKey({ allowedModels: ["gpt-image-2"] }, "adobe-firefly"), false);
});

// ─────────────────────────────────────────── 限流

test("consumeRateLimit 在额度内放行并累计用量", () => {
  const now = 1_700_000_000_000;
  let decision = consumeRateLimit(undefined, now, 3);
  assert.equal(decision.allowed, true);
  assert.equal(decision.used, 1);

  decision = consumeRateLimit(decision.window, now + 100, 3);
  assert.equal(decision.used, 2);

  decision = consumeRateLimit(decision.window, now + 200, 3);
  assert.equal(decision.allowed, true);
  assert.equal(decision.used, 3);
});

test("consumeRateLimit 超额时拒绝并给出可用的 Retry-After", () => {
  const now = 1_700_000_000_000;
  const first = consumeRateLimit(undefined, now, 2).window;
  const window = consumeRateLimit(first, now + 1_000, 2).window;

  const rejected = consumeRateLimit(window, now + 2_000, 2);
  assert.equal(rejected.allowed, false);
  assert.equal(rejected.used, 2);
  // 最早那次在 now，滑出窗口要到 now+60000，此刻距离 58 秒
  assert.equal(rejected.retryAfterSeconds, 58);
  assert.ok(rejected.retryAfterSeconds >= 1, "Retry-After 不能是 0，否则客户端立刻重试又被拒");
});

test("consumeRateLimit 的窗口会滑动：一分钟后名额恢复", () => {
  const now = 1_700_000_000_000;
  const window = consumeRateLimit(undefined, now, 1).window;
  assert.equal(consumeRateLimit(window, now + 1_000, 1).allowed, false);

  const later = consumeRateLimit(window, now + 60_001, 1);
  assert.equal(later.allowed, true);
  assert.equal(later.used, 1, "过期的时间戳应被清掉，不能一直累积");
});

test("consumeRateLimit 不让窗口无限增长", () => {
  const now = 1_700_000_000_000;
  // 灌入一批早已过期的时间戳
  const stale = { hits: Array.from({ length: 500 }, (_, i) => now - 120_000 + i) };
  const decision = consumeRateLimit(stale, now, 10);
  assert.equal(decision.allowed, true);
  assert.equal(decision.window.hits.length, 1, "过期项必须被丢掉");
});

test("consumeRateLimit 不修改传入的窗口对象", () => {
  const now = 1_700_000_000_000;
  const original = { hits: [now - 1_000] };
  const snapshot = [...original.hits];
  consumeRateLimit(original, now, 5);
  assert.deepEqual(original.hits, snapshot);
});
