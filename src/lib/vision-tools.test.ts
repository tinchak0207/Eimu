/**
 * vision-tools.ts 测试（beast-army R2，2026-09-10；R2c 中控迁移同步）。
 *
 * node:test + fetch mock（不真连）；覆盖：
 *   1. 缺 NEWAPI_API_KEY fail-fast（人话报错、不发请求）
 *   2. 上游非 2xx 错误带原文 body（诚实铁律）
 *   3. 成功路径解析：verdict/dimensions/venom 提取、请求形状（Bearer header、
 *      image_url data URL、chat payload）、围栏 JSON 容忍
 *   4. 非图路径人话报错（.m4a 拒绝、缺参数、二选一冲突、未知 aspect、文件不存在）
 */

import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  VISION_NEWAPI_CHAT_URL,
  VISION_MODEL_DEFAULT,
  buildVisionPrompt,
  callNewapiVision,
  extractChatText,
  parseVisionReview,
  readImageSource,
  visionAnalyzeTool,
} from "./vision-tools.ts";

// ── fetch mock 脚手架（同构 music-lyria.test.ts） ────────────────────────────

type MockResponse = { status: number; body: string; headers?: Record<string, string> };

let mockCalls: Array<{ url: string; init: RequestInit }> = [];
let mockResponder: (url: string, init: RequestInit) => MockResponse = () => ({ status: 500, body: "no responder" });

const originalFetch = globalThis.fetch;
const originalEnvKey = process.env.NEWAPI_API_KEY;
const originalEnvModel = process.env.NEWAPI_VISION_MODEL;

function installFetchMock(responder: (url: string, init: RequestInit) => MockResponse): void {
  mockCalls = [];
  mockResponder = responder;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : (url as Request).url;
    mockCalls.push({ url: urlStr, init: init ?? {} });
    const r = mockResponder(urlStr, init ?? {});
    return new Response(r.body, { status: r.status, headers: r.headers });
  }) as typeof fetch;
}

beforeEach(() => {
  process.env.NEWAPI_API_KEY = "test-newapi-key-123";
  delete process.env.NEWAPI_VISION_MODEL;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalEnvKey === undefined) delete process.env.NEWAPI_API_KEY;
  else process.env.NEWAPI_API_KEY = originalEnvKey;
  if (originalEnvModel === undefined) delete process.env.NEWAPI_VISION_MODEL;
  else process.env.NEWAPI_VISION_MODEL = originalEnvModel;
});

// 1x1 红色 PNG（合法 PNG bytes）。
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function chatOkBody(reviewJson: string): string {
  return JSON.stringify({
    choices: [{ message: { role: "assistant", content: reviewJson } }],
  });
}

const GOOD_REVIEW = JSON.stringify({
  verdict: 3,
  dimensions: [
    { name: "构图", score: 4, comment: "主体挤在右下角，左上大面积死白没有任何承接。" },
    { name: "光线", score: 3, comment: "光源来路不明，面部阴影和背景矛盾。" },
    { name: "色彩", score: 2, comment: "饱和度拉满像滤镜事故，脏紫色一片。" },
    { name: "质感", score: 4, comment: "皮肤涂抹感明显，布料纹理全糊。" },
    { name: "叙事张力", score: 3, comment: "看不出在讲什么，第一眼没有钩子。" },
    { name: "镜头语言", score: 4, comment: "平视机位毫无态度，景深全开等于没有景深。" },
  ],
  venom: "这不是海报，这是美图秀秀的忏悔录。",
});

// ── prompt 组装（确定性拼接） ─────────────────────────────────────────────────

test("buildVisionPrompt：三个 aspect 模板确定性拼接＋hint 附加", () => {
  const aesthetic = buildVisionPrompt("aesthetic");
  assert.match(aesthetic, /毒蛇艺术总监/);
  assert.match(aesthetic, /构图/);
  assert.match(aesthetic, /"verdict"/);

  const consistency = buildVisionPrompt("consistency");
  assert.match(consistency, /连续性总监/);
  assert.match(consistency, /角色外形一致性/);

  const emotion = buildVisionPrompt("emotion");
  assert.match(emotion, /情绪导演/);

  const hinted = buildVisionPrompt("aesthetic", "分镜 3：女主雨夜回头");
  assert.match(hinted, /补充审核语境（调用方提供，优先参考）：分镜 3：女主雨夜回头/);
});

// ── 缺 key fail-fast ─────────────────────────────────────────────────────────

test("缺 NEWAPI_API_KEY fail-fast：人话报错且不发请求", async () => {
  delete process.env.NEWAPI_API_KEY;
  installFetchMock(() => ({ status: 200, body: chatOkBody(GOOD_REVIEW) }));

  await assert.rejects(
    () => callNewapiVision({ base64: PNG_BASE64, mime: "image/png", prompt: "审" }),
    (e: Error) => {
      assert.match(e.message, /NEWAPI_API_KEY 未设置/);
      return true;
    },
  );
  assert.equal(mockCalls.length, 0, "缺 key 时不应发出任何请求");
});

// ── 缺 key fail-fast（工具层） ────────────────────────────────────────────────

test("工具层缺 key fail-fast：invalid 参数优先，但参数对时 key 错误先于读图", async () => {
  delete process.env.NEWAPI_API_KEY;
  installFetchMock(() => ({ status: 200, body: chatOkBody(GOOD_REVIEW) }));

  const result = await visionAnalyzeTool.execute({ image_path: "/tmp/never-exists-r2.png" });
  const parsed = JSON.parse(result.output) as { ok: boolean; error: { code: string; hint: string } };
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, "newapi_key_missing");
  assert.match(parsed.error.hint, /NEWAPI_API_KEY 未设置/);
  assert.equal(mockCalls.length, 0);
});

// ── 上游非 2xx 带原文 ────────────────────────────────────────────────────────

test("中控非 2xx：错误带 HTTP 状态与原文 body", async () => {
  installFetchMock(() => ({ status: 503, body: '{"error":{"code":"model_not_found","message":"分组 default 下模型 gemini-3-flash 无可用渠道"}}' }));

  await assert.rejects(
    () => callNewapiVision({ base64: PNG_BASE64, mime: "image/png", prompt: "审" }),
    (e: Error) => {
      assert.match(e.message, /HTTP 503/);
      assert.match(e.message, /无可用渠道/);
      return true;
    },
  );
});

test("中控 200 但无文本候选：带原文报错", async () => {
  installFetchMock(() => ({ status: 200, body: '{"choices":[{"message":{"role":"assistant","content":""}}]}' }));

  await assert.rejects(
    () => callNewapiVision({ base64: PNG_BASE64, mime: "image/png", prompt: "审" }),
    (e: Error) => {
      assert.match(e.message, /没有文本候选/);
      return true;
    },
  );
});

// ── 成功路径：解析＋请求形状 ──────────────────────────────────────────────────

test("成功路径：verdict/dimensions/venom 解析＋请求形状（Bearer/image_url data URL/chat payload）", async () => {
  installFetchMock(() => ({ status: 200, body: chatOkBody(GOOD_REVIEW) }));

  const { review, channel } = await callNewapiVision({ base64: PNG_BASE64, mime: "image/png", prompt: "审" });
  assert.equal(channel, "newapi");
  assert.equal(review.verdict, 3);
  assert.equal(review.dimensions.length, 6);
  assert.equal(review.venom, "这不是海报，这是美图秀秀的忏悔录。");

  assert.equal(mockCalls.length, 1);
  const { url, init } = mockCalls[0];
  assert.equal(url, VISION_NEWAPI_CHAT_URL);
  assert.equal((init.headers as Record<string, string>)["Authorization"], "Bearer test-newapi-key-123");
  const payload = JSON.parse(init.body as string) as {
    model: string;
    messages: Array<{ content: Array<Record<string, unknown>> }>;
    max_tokens: number;
  };
  assert.equal(payload.model, VISION_MODEL_DEFAULT);
  const content = payload.messages[0].content;
  const img = content.find((p) => p.type === "image_url") as { image_url: { url: string } };
  assert.equal(img.image_url.url, `data:image/png;base64,${PNG_BASE64}`);
  const txt = content.find((p) => p.type === "text") as { text: string };
  assert.equal(txt.text, "审");
  assert.equal(payload.max_tokens, 4096);
});

test("env NEWAPI_VISION_MODEL 覆盖默认模型（中控注册新模型零代码切换）", async () => {
  process.env.NEWAPI_VISION_MODEL = "gemini-3-pro-future";
  installFetchMock(() => ({ status: 200, body: chatOkBody(GOOD_REVIEW) }));

  await callNewapiVision({ base64: PNG_BASE64, mime: "image/png", prompt: "审" });
  const payload = JSON.parse(mockCalls[0].init.body as string) as { model: string };
  assert.equal(payload.model, "gemini-3-pro-future");
});

test("工具成功路径：execute 返回 verdict＋逐维点评＋最毒总结＋channel=newapi（本地路径）", async () => {
  const os = await import("node:os");
  const fsp = await import("node:fs/promises");
  const path = await import("node:path");
  const tmp = path.join(os.tmpdir(), `vision-test-${Date.now()}.png`);
  await fsp.writeFile(tmp, Buffer.from(PNG_BASE64, "base64"));
  try {
    installFetchMock(() => ({ status: 200, body: chatOkBody(GOOD_REVIEW) }));
    const result = await visionAnalyzeTool.execute({ image_path: tmp, aspect: "aesthetic" });
    const parsed = JSON.parse(result.output) as Record<string, unknown>;
    assert.equal(parsed.ok, true);
    assert.equal(parsed.aspect, "aesthetic");
    assert.equal(parsed.verdict, 3);
    assert.equal(Array.isArray(parsed.dimensions) && (parsed.dimensions as unknown[]).length, 6);
    assert.equal(parsed.venom, "这不是海报，这是美图秀秀的忏悔录。");
    assert.equal(parsed.model, VISION_MODEL_DEFAULT);
    assert.equal(parsed.channel, "newapi");
    assert.equal(parsed.image_source, "path");
    assert.equal(typeof parsed.elapsed_ms, "number");
  } finally {
    await fsp.rm(tmp, { force: true });
  }
});

test("围栏 JSON 容忍：```json 围栏与前后杂讯可解析", () => {
  const fenced = "评审结论如下：\n```json\n" + GOOD_REVIEW + "\n```\n以上。";
  const review = parseVisionReview(fenced);
  assert.equal(review.verdict, 3);
  assert.equal(review.venom, "这不是海报，这是美图秀秀的忏悔录。");
});

test("extractChatText：choices[0].message.content 提取", () => {
  const text = extractChatText({ choices: [{ message: { role: "assistant", content: "ab" } }] });
  assert.equal(text, "ab");
  assert.equal(extractChatText({ choices: [] }), "");
  assert.equal(extractChatText({}), "");
});

// ── 非图路径人话报错 ─────────────────────────────────────────────────────────

test("非图路径（.m4a）：读取前人话报错，不发上游请求", async () => {
  const os = await import("node:os");
  const fsp = await import("node:fs/promises");
  const path = await import("node:path");
  const tmp = path.join(os.tmpdir(), `vision-test-${Date.now()}.m4a`);
  await fsp.writeFile(tmp, Buffer.from("fake audio bytes"));
  installFetchMock(() => ({ status: 200, body: chatOkBody(GOOD_REVIEW) }));
  try {
    const result = await visionAnalyzeTool.execute({ image_path: tmp });
    const parsed = JSON.parse(result.output) as { ok: boolean; error: { code: string; hint: string } };
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.code, "invalid_image");
    assert.match(parsed.error.hint, /不是图片文件|音频/);
    assert.equal(mockCalls.length, 0, "非图类不应发上游请求");
  } finally {
    await fsp.rm(tmp, { force: true });
  }
});

test("参数卫生：缺来源／二选一冲突／未知 aspect／文件不存在", async () => {
  installFetchMock(() => ({ status: 500, body: "should not be called" }));

  const missing = await visionAnalyzeTool.execute({});
  assert.equal((JSON.parse(missing.output) as { error: { code: string } }).error.code, "invalid_args");
  assert.match((JSON.parse(missing.output) as { error: { hint: string } }).error.hint, /二选一/);

  const conflict = await visionAnalyzeTool.execute({ image_url: "https://x/y.png", image_path: "/tmp/y.png" });
  assert.equal((JSON.parse(conflict.output) as { error: { code: string } }).error.code, "invalid_args");

  const badAspect = await visionAnalyzeTool.execute({ image_path: "/tmp/y.png", aspect: "color" });
  assert.equal((JSON.parse(badAspect.output) as { error: { code: string } }).error.code, "invalid_args");

  const notFound = await visionAnalyzeTool.execute({ image_path: "/tmp/definitely-not-exists-9x8y.png" });
  const nf = JSON.parse(notFound.output) as { ok: boolean; error: { code: string; hint: string } };
  assert.equal(nf.ok, false);
  assert.equal(nf.error.code, "image_not_found");
  assert.match(nf.error.hint, /不存在/);
  assert.equal(mockCalls.length, 0, "全部参数错误不应发上游请求");
});

test("readImageSource：URL 非图 content-type 报错；data URL 解码", async () => {
  installFetchMock(() => ({
    status: 200,
    body: "fake-audio",
    headers: { "content-type": "audio/mp4" },
  }));

  await assert.rejects(
    () => readImageSource("https://example.com/song.m4a", undefined),
    (e: Error) => {
      assert.match(e.message, /不是图片/);
      assert.match(e.message, /audio\/mp4/);
      return true;
    },
  );

  const dataUrl = await readImageSource(`data:image/png;base64,${PNG_BASE64}`, undefined);
  assert.equal(dataUrl.mime, "image/png");
  assert.equal(dataUrl.source, "data_url");
  assert.equal(Buffer.from(dataUrl.bytes).toString("base64"), PNG_BASE64);
});
