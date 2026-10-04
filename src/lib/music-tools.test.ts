/**
 * music-tools.ts 通路接线测试（片 B：music_gen 第三通路，2026-09-18）。
 *
 * node:test + fetch mock（不真连上游、不真落盘）；覆盖本片白名单改动的**行为**：
 *   1. 通路优先序：YUE2_MODAL_ENDPOINT 非空 → yue2（即使 FLOWMUSIC2API_URL 也在场）
 *   2. YuE2 回执：channel=yue2_modal／model=m-a-p/YuE2-3B／score_abc additive 栏位／
 *      duration_source=upstream_reported（ffprobe 对假位元组必然失败）／档名副档名 .flac
 *   3. clip30 在 YuE2 通路如实报错（不静默生成整歌假装 30 秒），且不发任何上游请求
 *   4. reference_images 在 YuE2 通路忽略并如实标注（不静默）
 *   5. 既有通路零回归：未配 YUE2_MODAL_ENDPOINT 时走 flowmusic2api 且 score_abc=null
 *   6. 失败回落（片 G，2026-09-19）：yue2 抛错 → FlowMusic 已配置则完整回落重跑
 *      （回执 fallback_from/fallback_reason additive）；FlowMusic 未配置 → fail 带原文。
 *      mock 方式＝既有 fetch mock（generateYue2Track 的网路层在 fetch 上，mock 它抛错
 *      ＝等价 mock client 抛错）。
 *   7. 乐谱编辑（片 K，2026-09-19）：abc/cot_mode 参数全链透传（request body 含 abc、
 *      cot 跟随 cot_mode）；cot_mode=melody 无 abc → fail；abc 但 YuE2 未启用 → 如实
 *      报错；带 abc 时 yue2 抛错不回落（零 FlowMusic 请求，语义完整性优先）。
 */

import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { musicGenTool } from "./music-tools.ts";
import { YUE2_HMAC_SECRET_ENV, YUE2_MODAL_ENDPOINT_ENV } from "./music-yue2.ts";

type MockResponse = { status: number; body: string; headers?: Record<string, string> };

let mockCalls: Array<{ url: string; init: RequestInit }> = [];
let mockResponder: (url: string, init: RequestInit) => MockResponse = () => ({ status: 500, body: "no responder" });

const originalFetch = globalThis.fetch;
const ENV_KEYS = [YUE2_MODAL_ENDPOINT_ENV, YUE2_HMAC_SECRET_ENV, "FLOWMUSIC2API_URL", "FLOWMUSIC2API_KEY", "GEMINI_API_KEY", "GEMINI_STUDIO_API_KEY"] as const;
const originalEnv = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]));

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
  process.env[YUE2_MODAL_ENDPOINT_ENV] = "https://yue2-modal.example";
  process.env[YUE2_HMAC_SECRET_ENV] = "test-secret";
  process.env.FLOWMUSIC2API_URL = "http://127.0.0.1:8000"; // 同时在场 → 验优先序
  process.env.FLOWMUSIC2API_KEY = "test-key";
  delete process.env.GEMINI_API_KEY; // Lyria 回落入链与否由各用例显式决定
  delete process.env.GEMINI_STUDIO_API_KEY;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** 三路 mock：YuE2 /generate、gateway 素材入库、FlowMusic2API（含音频下载）。 */
function defaultResponder(url: string): MockResponse {
  if (url.endsWith("/generate")) {
    return {
      status: 200,
      body: JSON.stringify({
        ok: true,
        audio_b64: "ZmxhYw==",
        audio_bytes: 5,
        audio_sha256: "a".repeat(64),
        mime_type: "audio/flac",
        sample_rate: 48000,
        channels: 2,
        duration_s: 123.45,
        score_abc: "X:1\nT:demo\nK:C\nC D E F|",
        truncated: null,
        artifacts: [],
        model: "m-a-p/YuE2-3B",
      }),
    };
  }
  if (url.includes("/internal/media/upload")) {
    return { status: 200, body: JSON.stringify({ ok: true, url: "https://store.example/image-data/files/uploads/music-gen.flac" }) };
  }
  if (url.includes("/v1/chat/completions")) {
    return {
      status: 200,
      body: JSON.stringify({
        clips: [{ audio_url: "https://cdn.example/a.m4a", audio: { format: "m4a" }, duration: 150 }],
      }),
    };
  }
  if (url.includes("cdn.example")) {
    return { status: 200, body: "FAKEAUDIO", headers: { "content-type": "audio/mp4" } };
  }
  return { status: 404, body: `unexpected url ${url}` };
}

/** yue2 服务不可达 mock（网路层抛错：fetch reject = 笔电关机/隧道断线的现场形状）。 */
function yue2DownResponder(url: string): MockResponse {
  if (url.endsWith("/generate")) {
    throw new Error("fetch failed: tunnel is down");
  }
  return defaultResponder(url);
}

const CONTEXT = { sessionId: "sess-music-1" };
/** 带歌词的委托（2026-10-02 起：无歌词/无 abc 的委托在有其他通路时让位，YuE2 是「歌词→整歌」）。 */
const LYRICS = "[Verse]\nla la la\n[Chorus]\nna na na";

// ── 1. 通路优先序与 YuE2 回执 ────────────────────────────────────────────────

test("优先序：YUE2_MODAL_ENDPOINT 非空即走 yue2（flowmusic env 同时在场也不抢）", async () => {
  installFetchMock(defaultResponder);
  const result = await musicGenTool.execute({ prompt: "city pop, 105 BPM", duration_hint: "full", lyrics: LYRICS }, CONTEXT);
  const out = JSON.parse(result.output) as Record<string, unknown>;
  assert.equal(out.ok, true);
  assert.equal(out.channel, "yue2_modal");
  assert.equal(out.model, "m-a-p/YuE2-3B");
  assert.equal(out.score_abc, "X:1\nT:demo\nK:C\nC D E F|");
  assert.equal(out.duration_source, "upstream_reported");
  assert.equal(out.duration_seconds, 123.45);
  assert.equal(out.mime_type, "audio/flac");
  assert.equal(out.url, "https://store.example/image-data/files/uploads/music-gen.flac");
  assert.equal(out.upstream_url, undefined);
  assert.deepEqual(out.prompt_director && (out.prompt_director as { channel: string }).channel, "yue2");
  const urls = mockCalls.map((call) => call.url);
  assert.equal(urls.some((url) => url.includes("/v1/chat/completions")), false);
  assert.deepEqual(urls.filter((url) => !url.includes("/internal/media/upload")), [
    "https://yue2-modal.example/generate",
  ]);
});

test("YuE2 落盘副档名 .flac（MIME 表 additive：audio/flac→flac，否则档名标签说谎）", async () => {
  installFetchMock(defaultResponder);
  await musicGenTool.execute({ prompt: "city pop, 105 BPM", lyrics: LYRICS }, CONTEXT);
  const upload = mockCalls.find((call) => call.url.includes("/internal/media/upload"));
  assert.ok(upload);
  const body = JSON.parse(String(upload.init.body)) as { filename: string };
  assert.match(body.filename, /^music-gen-\d+\.flac$/);
});

test("YuE2 无 sessionId：跳过上传并如实带 audio_base64（不伪造 URL）", async () => {
  installFetchMock(defaultResponder);
  const result = await musicGenTool.execute({ prompt: "city pop, 105 BPM", lyrics: LYRICS }, {});
  const out = JSON.parse(result.output) as Record<string, unknown>;
  assert.equal(out.channel, "yue2_modal");
  assert.equal(out.upload, "skipped_no_session");
  assert.equal(out.audio_base64, "ZmxhYw==");
  assert.equal(out.url, undefined);
});

// ── 2. clip30 如实报错 ───────────────────────────────────────────────────────

test("YuE2 通路 clip30：如实报错（unsupported_duration_hint），零上游请求", async () => {
  installFetchMock(defaultResponder);
  // YuE2 为唯一通路时 clip30 才由 YuE2 前置拒绝（有其他通路在场时 clip30 让位给它们）。
  delete process.env.FLOWMUSIC2API_URL;
  const result = await musicGenTool.execute({ prompt: "city pop, 105 BPM", duration_hint: "clip30" }, CONTEXT);
  const out = JSON.parse(result.output) as { ok: boolean; error: { code: string; hint: string } };
  assert.equal(out.ok, false);
  assert.equal(out.error.code, "unsupported_duration_hint");
  assert.match(out.error.hint, /无 30 秒短档模式/);
  assert.match(out.error.hint, /duration_hint="full"/);
  assert.equal(mockCalls.length, 0);
});

// ── 3. reference_images 忽略并如实标注 ───────────────────────────────────────

test("YuE2 通路 reference_images：不进上游 body、回执如实标注已忽略", async () => {
  installFetchMock(defaultResponder);
  const result = await musicGenTool.execute(
    { prompt: "city pop, 105 BPM", lyrics: LYRICS, reference_images: "data:image/png;base64,AAAA,data:image/png;base64,BBBB" },
    CONTEXT,
  );
  const out = JSON.parse(result.output) as Record<string, unknown>;
  assert.equal(out.reference_image_count, 0);
  assert.match(String(out.reference_images_note), /YuE2 通路不支持参考图/);
  const generate = mockCalls.find((call) => call.url.endsWith("/generate"));
  assert.ok(generate);
  const sent = JSON.parse(String(generate.init.body)) as Record<string, unknown>;
  assert.equal(Object.prototype.hasOwnProperty.call(sent, "images"), false);
  assert.deepEqual(Object.keys(sent).sort(), ["cot", "id", "lyrics", "style"]);
});

// ── 4. 既有通路零回归 ────────────────────────────────────────────────────────

test("未配 YUE2_MODAL_ENDPOINT：回落 flowmusic2api，score_abc=null（栏位仍在场）", async () => {
  installFetchMock(defaultResponder);
  delete process.env[YUE2_MODAL_ENDPOINT_ENV];
  const result = await musicGenTool.execute({ prompt: "city pop, 105 BPM" }, CONTEXT);
  const out = JSON.parse(result.output) as Record<string, unknown>;
  assert.equal(out.channel, "flowmusic2api");
  assert.equal(out.model, "lyria");
  assert.equal(out.score_abc, null);
  assert.equal(out.upstream_url, "https://cdn.example/a.m4a");
  // ffprobe 对假位元组必然失败 → 回退上游 Duration 提示（150）并标 model_hint（既有行为不变）
  assert.equal(out.duration_source, "model_hint");
  assert.equal(out.duration_seconds, 150);
});

// ── 5. 失败回落（片 G，2026-09-19）───────────────────────────────────────────

test("回落：yue2 网路层抛错 → FlowMusic 已配置 → 完整重跑成功，回执 additive 带 fallback_from/fallback_reason", async () => {
  installFetchMock(yue2DownResponder);
  const result = await musicGenTool.execute({ prompt: "city pop, 105 BPM", lyrics: LYRICS }, CONTEXT);
  const out = JSON.parse(result.output) as Record<string, unknown>;
  assert.equal(out.ok, true);
  // 通路如实回报实际生成通路（回落成功＝走 flowmusic）
  assert.equal(out.channel, "flowmusic2api");
  assert.equal(out.model, "lyria");
  assert.equal(out.score_abc, null);
  assert.equal(out.upstream_url, "https://cdn.example/a.m4a");
  assert.equal(out.duration_source, "model_hint");
  assert.equal(out.duration_seconds, 150);
  assert.equal(out.mime_type, "audio/mp4");
  // 回落事实 additive 栏位（只在真的发生回落时在场）
  assert.equal(out.fallback_from, "yue2_modal");
  assert.match(String(out.fallback_reason), /tunnel is down/);
  // 回落后 director 以 flowmusic 通道重新跑（prompt_director.channel 如实回报实际版面）
  assert.deepEqual(out.prompt_director && (out.prompt_director as { channel: string }).channel, "flowmusic");
  // FlowMusic 收到的 prompt 是 flowmusic 版面（yue2 版面不会直接送过去）
  const generate = mockCalls.find((call) => call.url.includes("/v1/chat/completions"));
  assert.ok(generate);
  const sent = JSON.parse(String(generate.init.body)) as { messages: Array<{ content: string }> };
  assert.match(sent.messages[0].content, /city pop/);
  // yue2 真的尝试过（先试 yue2 才回落，顺序：/generate → chat/completions → cdn）
  const urls = mockCalls.map((call) => call.url);
  const yue2Index = urls.findIndex((url) => url.endsWith("/generate"));
  const flowIndex = urls.findIndex((url) => url.includes("/v1/chat/completions"));
  assert.ok(yue2Index !== -1 && flowIndex !== -1 && yue2Index < flowIndex);
});

test("回落：yue2 抛错 → FlowMusic 未配置 → fail 带 YuE2 原错误原文（不静默、不回落 Lyria）", async () => {
  installFetchMock(yue2DownResponder);
  delete process.env.FLOWMUSIC2API_URL;
  const result = await musicGenTool.execute({ prompt: "city pop, 105 BPM" }, CONTEXT);
  const out = JSON.parse(result.output) as { ok: boolean; error: { code: string; hint: string } };
  assert.equal(out.ok, false);
  assert.equal(out.error.code, "music_tool_error");
  assert.match(out.error.hint, /fetch failed: tunnel is down/);
  // 只试过 yue2，零个其他通路请求
  const urls = mockCalls.map((call) => call.url);
  assert.equal(urls.filter((url) => url.includes("/v1/chat/completions")).length, 0);
  assert.equal(urls.filter((url) => url.includes("generativelanguage")).length, 0);
});

test("全链回落：yue2 400（带歌词）→ FlowMusic 鉴权 502 → GEMINI_STUDIO_API_KEY 在场 → Lyria 直连出曲", async () => {
  process.env.GEMINI_STUDIO_API_KEY = "test-studio-key";
  installFetchMock((url) => {
    if (url.endsWith("/generate")) {
      return { status: 400, body: JSON.stringify({ ok: false, error: "bad_request", detail: "lyrics must be a non-empty string" }) };
    }
    if (url.includes("/v1/chat/completions")) {
      return { status: 502, body: JSON.stringify({ error: { code: 502, message: "no active FlowMusic account with usable Bearer token" } }) };
    }
    if (url.includes("generativelanguage")) {
      return { status: 200, body: JSON.stringify({ steps: [{ model_output: { parts: [{ type: "audio", mime_type: "audio/mpeg", data: "AAECAw==" }] } }] }) };
    }
    return defaultResponder(url);
  });
  const result = await musicGenTool.execute({ prompt: "cinematic chinese orchestral, 90 BPM", lyrics: LYRICS }, CONTEXT);
  const out = JSON.parse(result.output) as Record<string, unknown>;
  assert.equal(out.ok, true);
  assert.equal(out.channel, "lyria_gemini");
  assert.equal(out.fallback_from, "yue2_modal");
  assert.match(String(out.fallback_reason), /lyrics must be a non-empty string/);
  assert.match(String(out.fallback_reason), /no active FlowMusic account/);
  assert.deepEqual(out.prompt_director && (out.prompt_director as { channel: string }).channel, "lyria");
  const urls = mockCalls.map((call) => call.url).filter((url) => !url.includes("/internal/media/upload"));
  const order = urls.map((url) => (url.endsWith("/generate") ? "yue2" : url.includes("/v1/chat/completions") ? "flowmusic" : url.includes("generativelanguage") ? "lyria" : "other"));
  assert.deepEqual(order.filter((x) => x !== "other"), ["yue2", "flowmusic", "lyria"]);
});

test("全链失败：每一路原因都写进 hint（不只最后一路）", async () => {
  process.env.GEMINI_STUDIO_API_KEY = "test-studio-key";
  installFetchMock((url) => {
    if (url.endsWith("/generate")) throw new Error("fetch failed: tunnel is down");
    if (url.includes("/v1/chat/completions")) return { status: 502, body: "flowmusic auth dead" };
    if (url.includes("generativelanguage")) return { status: 500, body: "lyria upstream exploded" };
    return defaultResponder(url);
  });
  const result = await musicGenTool.execute({ prompt: "city pop, 105 BPM", lyrics: LYRICS }, CONTEXT);
  const out = JSON.parse(result.output) as { ok: boolean; error: { code: string; hint: string } };
  assert.equal(out.ok, false);
  assert.equal(out.error.code, "music_all_channels_failed");
  assert.match(out.error.hint, /yue2_modal：.*tunnel is down/);
  assert.match(out.error.hint, /flowmusic2api：/);
  assert.match(out.error.hint, /lyria_gemini：/);
});

test("回落回执 additive-only：既有键零删除（与非回落 flowmusic 回执的键集合对照，只多不少）", async () => {
  // 基准＝不走 yue2 的纯 flowmusic 回执键集合
  installFetchMock(defaultResponder);
  delete process.env[YUE2_MODAL_ENDPOINT_ENV];
  const baselineResult = await musicGenTool.execute({ prompt: "city pop, 105 BPM" }, CONTEXT);
  const baselineKeys = Object.keys(JSON.parse(baselineResult.output) as Record<string, unknown>).sort();

  // 回落版（env 恢复 beforeEach 设定的双通路在场）
  installFetchMock(yue2DownResponder);
  process.env[YUE2_MODAL_ENDPOINT_ENV] = "https://yue2-modal.example";
  const fallbackResult = await musicGenTool.execute({ prompt: "city pop, 105 BPM", lyrics: LYRICS }, CONTEXT);
  const fallbackOut = JSON.parse(fallbackResult.output) as Record<string, unknown>;
  const fallbackKeys = Object.keys(fallbackOut).sort();

  assert.deepEqual(fallbackKeys.filter((k) => !baselineKeys.includes(k)), ["fallback_from", "fallback_reason"]);
  assert.deepEqual(baselineKeys.filter((k) => !fallbackKeys.includes(k)), []);
});

test("回落时 yue2 的 clip30 前置拒绝不触发回落（参数性 fail ≠ 通路故障，flowmusic 的 clip30 语义照旧）", async () => {
  installFetchMock(yue2DownResponder);
  delete process.env.FLOWMUSIC2API_URL; // YuE2 为唯一通路，clip30 才轮到它的前置拒绝
  const result = await musicGenTool.execute({ prompt: "city pop, 105 BPM", duration_hint: "clip30" }, CONTEXT);
  const out = JSON.parse(result.output) as { ok: boolean; error: { code: string } };
  // yue2 启用 + clip30 → 我们在上游前自己拒的（unsupported_duration_hint），零上游请求零回落
  assert.equal(out.ok, false);
  assert.equal(out.error.code, "unsupported_duration_hint");
  assert.equal(mockCalls.length, 0);
});

// ── 6. 乐谱编辑：abc／cot_mode 全链透传（片 K，2026-09-19）────────────────────

const EDITED_ABC = "X:1\nT:edited\nK:G\nQ:4/4\nG4 A4 B4 c4|";

test("带谱重渲染：abc＋cot_mode=full 透传到 YuE2 request body（abc 逐字、cot 跟随），回执带 cot_mode/abc_sha256", async () => {
  installFetchMock(defaultResponder);
  const result = await musicGenTool.execute(
    { prompt: "jazz ballad, 70 BPM", abc: EDITED_ABC, cot_mode: "full" },
    CONTEXT,
  );
  const out = JSON.parse(result.output) as Record<string, unknown>;
  assert.equal(out.ok, true);
  assert.equal(out.channel, "yue2_modal");
  // 回执 additive：实际 cot 模式＋乐谱指纹（sha256 逐位元组验）
  assert.equal(out.cot_mode, "full");
  assert.equal(out.abc_sha256, createHash("sha256").update(EDITED_ABC, "utf8").digest("hex"));
  // 透传断言：request body 含 abc 逐字、cot=full
  const generate = mockCalls.find((call) => call.url.endsWith("/generate"));
  assert.ok(generate);
  const sent = JSON.parse(String(generate.init.body)) as Record<string, unknown>;
  assert.equal(sent.abc, EDITED_ABC);
  assert.equal(sent.cot, "full");
});

test("带谱重渲染：cot_mode=melody 透传（翻唱模式），abc 缺席＋melody → invalid_args fail", async () => {
  // ① melody＋abc：cot 透传 melody
  installFetchMock(defaultResponder);
  const okResult = await musicGenTool.execute(
    { prompt: "funk cover, 110 BPM", abc: EDITED_ABC, cot_mode: "melody" },
    CONTEXT,
  );
  const okOut = JSON.parse(okResult.output) as Record<string, unknown>;
  assert.equal(okOut.ok, true);
  assert.equal(okOut.cot_mode, "melody");
  const generate = mockCalls.find((call) => call.url.endsWith("/generate"));
  assert.ok(generate);
  const sent = JSON.parse(String(generate.init.body)) as Record<string, unknown>;
  assert.equal(sent.cot, "melody");
  assert.equal(sent.abc, EDITED_ABC);

  // ② melody 无 abc：语义不成立（melody＝以 abc 为旋律骨干），参数性 fail 零上游请求
  installFetchMock(defaultResponder);
  const failResult = await musicGenTool.execute({ prompt: "funk, 110 BPM", cot_mode: "melody" }, CONTEXT);
  const failOut = JSON.parse(failResult.output) as { ok: boolean; error: { code: string; hint: string } };
  assert.equal(failOut.ok, false);
  assert.equal(failOut.error.code, "invalid_args");
  assert.match(failOut.error.hint, /cot_mode="melody" 必须搭配 abc/);
  assert.equal(mockCalls.length, 0);
});

test("带谱但 YuE2 未启用：如实报错（unsupported_channel_for_abc），不静默忽略、零上游请求", async () => {
  installFetchMock(defaultResponder);
  delete process.env[YUE2_MODAL_ENDPOINT_ENV];
  const result = await musicGenTool.execute({ prompt: "city pop, 105 BPM", abc: EDITED_ABC }, CONTEXT);
  const out = JSON.parse(result.output) as { ok: boolean; error: { code: string; hint: string } };
  assert.equal(out.ok, false);
  assert.equal(out.error.code, "unsupported_channel_for_abc");
  assert.match(out.error.hint, /仅 YuE2 通路支持/);
  // FlowMusic 明明在场（beforeEach 双 env）也不抢跑：通路选择优先序不可被 abc 旁路
  assert.equal(mockCalls.length, 0);
});

test("带 abc 时 yue2 抛错不触发回落：直接 fail 带原文，零 FlowMusic 请求（语义完整性优先）", async () => {
  installFetchMock(yue2DownResponder);
  const result = await musicGenTool.execute({ prompt: "city pop, 105 BPM", abc: EDITED_ABC }, CONTEXT);
  const out = JSON.parse(result.output) as { ok: boolean; error: { code: string; hint: string } };
  assert.equal(out.ok, false);
  assert.equal(out.error.code, "music_tool_error");
  assert.match(out.error.hint, /fetch failed: tunnel is down/);
  // 只试过 yue2 的 /generate，零 FlowMusic／Lyria 请求（FlowMusic 不认 abc，回落会丢失乐谱语义）
  const urls = mockCalls.map((call) => call.url);
  assert.equal(urls.filter((url) => url.includes("/v1/chat/completions")).length, 0);
  assert.equal(urls.filter((url) => url.includes("generativelanguage")).length, 0);
});

test("乐谱编辑回执 additive-only：与不带 abc 的 YuE2 回执键集合对照，只多不少（cot_mode/abc_sha256 additive）", async () => {
  // 基准＝不带 abc 的 YuE2 常规生成回执键集合
  installFetchMock(defaultResponder);
  const baselineResult = await musicGenTool.execute({ prompt: "city pop, 105 BPM", lyrics: LYRICS }, CONTEXT);
  const baselineKeys = Object.keys(JSON.parse(baselineResult.output) as Record<string, unknown>).sort();

  // 带谱版（同 mock、同 env）
  installFetchMock(defaultResponder);
  const editedResult = await musicGenTool.execute({ prompt: "city pop, 105 BPM", abc: EDITED_ABC }, CONTEXT);
  const editedOut = JSON.parse(editedResult.output) as Record<string, unknown>;
  const editedKeys = Object.keys(editedOut).sort();

  // 带谱版多 cot_mode＋abc_sha256 两键（cot_mode 基准版也在场——YuE2 通路常规生成即带），零删除
  assert.deepEqual(baselineKeys.filter((k) => !editedKeys.includes(k)), [], "带谱版不得删除任何既有回执键");
  assert.ok(editedKeys.includes("cot_mode"), "带谱版应带 cot_mode");
  assert.ok(editedKeys.includes("abc_sha256"), "带谱版应带 abc_sha256");
  assert.equal((baselineKeys as string[]).includes("abc_sha256"), false, "不带 abc 的常规生成不带 abc_sha256");
});

test("cot_mode=off 不对工具开放：invalid_args 如实报错（工具语义永远要乐谱回执）", async () => {
  installFetchMock(defaultResponder);
  const result = await musicGenTool.execute({ prompt: "city pop, 105 BPM", cot_mode: "off" }, CONTEXT);
  const out = JSON.parse(result.output) as { ok: boolean; error: { code: string; hint: string } };
  assert.equal(out.ok, false);
  assert.equal(out.error.code, "invalid_args");
  assert.match(out.error.hint, /"off" 不对工具开放/);
  assert.equal(mockCalls.length, 0);
});

// ── 7. 翻唱工作流：source_audio 扒谱＋重演绎（片 O，2026-09-19）────────────────

/** 扒谱成功 mock（服务端 /transcribe 200 契约形状）。 */
function transcribeResponder(url: string): MockResponse {
  if (url.endsWith("/transcribe")) {
    return {
      status: 200,
      body: JSON.stringify({
        ok: true,
        abc: "X:1\nK:G\nQ:4/4\nG4 A4 B4 c4|",
        warnings: ["audio trimmed to 60s"],
        source_duration_s: 54.841,
        abc_sha256: "c".repeat(64),
        abc_measures: 24,
        melody_only: true,
        timing: {},
        model: "m-a-p/SheetSage2",
      }),
    };
  }
  return defaultResponder(url);
}

const TRANSCRIBED_ABC = "X:1\nK:G\nQ:4/4\nG4 A4 B4 c4|";

test("翻唱两段调用顺序：先 /transcribe 后 /generate，扒谱 abc 逐字透传、cot_mode 缺省 melody、回执带 transcribed_abc_sha256/transcribe_warnings", async () => {
  installFetchMock(transcribeResponder);
  const result = await musicGenTool.execute(
    { prompt: "unplugged acoustic folk, fingerstyle guitar", source_audio: "data:audio/flac;base64,QUJDREVG" },
    CONTEXT,
  );
  const out = JSON.parse(result.output) as Record<string, unknown>;
  assert.equal(out.ok, true);
  assert.equal(out.channel, "yue2_modal");
  // cot_mode 缺省＝melody（官方翻唱模式）
  assert.equal(out.cot_mode, "melody");
  // 回执 additive：扒谱指纹＋警告如实透传
  assert.equal(out.transcribed_abc_sha256, createHash("sha256").update(TRANSCRIBED_ABC, "utf8").digest("hex"));
  assert.deepEqual(out.transcribe_warnings, ["audio trimmed to 60s"]);
  // 带 source_audio 的委托不带 abc_sha256（互斥语义：扒谱产物走 transcribed_*）
  assert.equal(out.abc_sha256, undefined);
  // 两段调用顺序：/transcribe 在 /generate 之前
  const urls = mockCalls.map((call) => call.url);
  const transcribeIndex = urls.findIndex((url) => url.endsWith("/transcribe"));
  const generateIndex = urls.findIndex((url) => url.endsWith("/generate"));
  assert.ok(transcribeIndex !== -1 && generateIndex !== -1 && transcribeIndex < generateIndex);
  // transcribe body：data: 前缀剥除、melody_only=true
  const transcribe = mockCalls[transcribeIndex];
  const transcribeSent = JSON.parse(String(transcribe.init.body)) as Record<string, unknown>;
  assert.equal(transcribeSent.audio_b64, "QUJDREVG");
  assert.equal(transcribeSent.melody_only, true);
  // generate body：abc＝扒谱产物逐字、cot=melody
  const generate = mockCalls[generateIndex];
  const sent = JSON.parse(String(generate.init.body)) as Record<string, unknown>;
  assert.equal(sent.abc, TRANSCRIBED_ABC);
  assert.equal(sent.cot, "melody");
});

test("翻唱显式 cot_mode=full：保留原和声重渲染（透传 full，缺省规则不覆盖显式值）", async () => {
  installFetchMock(transcribeResponder);
  const result = await musicGenTool.execute(
    { prompt: "orchestral re-recording", source_audio: "QUJDREVG", cot_mode: "full" },
    CONTEXT,
  );
  const out = JSON.parse(result.output) as Record<string, unknown>;
  assert.equal(out.ok, true);
  assert.equal(out.cot_mode, "full");
  const generate = mockCalls.find((call) => call.url.endsWith("/generate"));
  assert.ok(generate);
  const sent = JSON.parse(String(generate.init.body)) as Record<string, unknown>;
  assert.equal(sent.cot, "full");
  assert.equal(sent.abc, TRANSCRIBED_ABC);
});

test("翻唱互斥：source_audio 与 abc 同传 → invalid_args，零上游请求", async () => {
  installFetchMock(transcribeResponder);
  const result = await musicGenTool.execute(
    { prompt: "city pop", source_audio: "QUJD", abc: EDITED_ABC },
    CONTEXT,
  );
  const out = JSON.parse(result.output) as { ok: boolean; error: { code: string; hint: string } };
  assert.equal(out.ok, false);
  assert.equal(out.error.code, "invalid_args");
  assert.match(out.error.hint, /互斥/);
  assert.equal(mockCalls.length, 0);
});

test("翻唱但 YuE2 未启用：如实报错（unsupported_channel_for_source_audio），零上游请求", async () => {
  installFetchMock(transcribeResponder);
  delete process.env[YUE2_MODAL_ENDPOINT_ENV];
  const result = await musicGenTool.execute(
    { prompt: "city pop, 105 BPM", source_audio: "QUJD" },
    CONTEXT,
  );
  const out = JSON.parse(result.output) as { ok: boolean; error: { code: string; hint: string } };
  assert.equal(out.ok, false);
  assert.equal(out.error.code, "unsupported_channel_for_source_audio");
  assert.match(out.error.hint, /仅 YuE2 通路支持/);
  // FlowMusic 明明在场（beforeEach 双 env）也不抢跑
  assert.equal(mockCalls.length, 0);
});

test("翻唱扒谱 422 abc_missing：映射 yue2_transcribe_abc_missing（确定性失败勿重试），零 /generate 请求", async () => {
  installFetchMock((url: string) => {
    if (url.endsWith("/transcribe")) {
      return {
        status: 422,
        body: JSON.stringify({ ok: false, error: "abc_missing", detail: "no melody found in audio" }),
      };
    }
    return defaultResponder(url);
  });
  const result = await musicGenTool.execute(
    { prompt: "city pop, 105 BPM", source_audio: "QUJD" },
    CONTEXT,
  );
  const out = JSON.parse(result.output) as { ok: boolean; error: { code: string; hint: string } };
  assert.equal(out.ok, false);
  assert.equal(out.error.code, "yue2_transcribe_abc_missing");
  assert.match(out.error.hint, /勿重试同一份音频/);
  // 只试过 /transcribe，零 /generate（扒不出谱就不到生成段）
  const urls = mockCalls.map((call) => call.url);
  assert.equal(urls.filter((url) => url.endsWith("/generate")).length, 0);
});

test("翻唱 yue2 生成段抛错不触发回落：直接 fail 带原文，零 FlowMusic 请求（语义完整性优先）", async () => {
  // /transcribe 成功、/generate 网路层抛错
  installFetchMock((url: string) => {
    if (url.endsWith("/transcribe")) return transcribeResponder(url);
    if (url.endsWith("/generate")) throw new Error("fetch failed: tunnel is down");
    return defaultResponder(url);
  });
  const result = await musicGenTool.execute(
    { prompt: "city pop, 105 BPM", source_audio: "QUJD" },
    CONTEXT,
  );
  const out = JSON.parse(result.output) as { ok: boolean; error: { code: string; hint: string } };
  assert.equal(out.ok, false);
  assert.equal(out.error.code, "music_tool_error");
  assert.match(out.error.hint, /fetch failed: tunnel is down/);
  const urls = mockCalls.map((call) => call.url);
  assert.equal(urls.filter((url) => url.includes("/v1/chat/completions")).length, 0);
  assert.equal(urls.filter((url) => url.includes("generativelanguage")).length, 0);
});

test("翻唱 clip30：照既有 clip30 拒绝规则走（unsupported_duration_hint，零上游请求）", async () => {
  installFetchMock(transcribeResponder);
  const result = await musicGenTool.execute(
    { prompt: "city pop, 105 BPM", source_audio: "QUJD", duration_hint: "clip30" },
    CONTEXT,
  );
  const out = JSON.parse(result.output) as { ok: boolean; error: { code: string } };
  assert.equal(out.ok, false);
  assert.equal(out.error.code, "unsupported_duration_hint");
  assert.equal(mockCalls.length, 0);
});

test("翻唱回执 additive-only：与不带 source_audio 的 YuE2 回执键集合对照，只多不少", async () => {
  // 基准＝不带 source_audio 的 YuE2 常规生成回执键集合
  installFetchMock(defaultResponder);
  const baselineResult = await musicGenTool.execute({ prompt: "city pop, 105 BPM", lyrics: LYRICS }, CONTEXT);
  const baselineKeys = Object.keys(JSON.parse(baselineResult.output) as Record<string, unknown>).sort();

  // 翻唱版（同 env）
  installFetchMock(transcribeResponder);
  const coverResult = await musicGenTool.execute({ prompt: "city pop, 105 BPM", source_audio: "QUJD" }, CONTEXT);
  const coverOut = JSON.parse(coverResult.output) as Record<string, unknown>;
  const coverKeys = Object.keys(coverOut).sort();

  assert.deepEqual(baselineKeys.filter((k) => !coverKeys.includes(k)), [], "翻唱版不得删除任何既有回执键");
  assert.deepEqual(coverKeys.filter((k) => !baselineKeys.includes(k)), [
    "transcribe_warnings",
    "transcribed_abc_sha256",
  ]);
});

// ── 8. 多候选交付（2026-10-02）：audios[] additive ────────────────────────────
//
// 上游 FlowMusic2API 多数响应带 2 个 clips（实测长度 1–2）。主候选照旧走既有单数
// 栏位（url/upstream_url，向后兼容零改动），全部候选以 gateway 既已消费的 audios[]
// 形状 additive 带出；次候选下载/上传失败只进 candidate_errors，不拖垮主候选交付。

test("多候选：两 clip → audios.length=2、两个不同平台 URL，url/upstream_url 仍等于第一候选", async () => {
  delete process.env[YUE2_MODAL_ENDPOINT_ENV]; // 强制走 flowmusic2api
  let uploadSeq = 0;
  installFetchMock((url: string) => {
    if (url.includes("/internal/media/upload")) {
      uploadSeq += 1;
      return {
        status: 200,
        body: JSON.stringify({ ok: true, url: `https://store.example/image-data/files/uploads/music-${uploadSeq}.m4a` }),
      };
    }
    if (url.includes("/v1/chat/completions")) {
      return {
        status: 200,
        body: JSON.stringify({
          clips: [
            { audio_url: "https://cdn.example/a.m4a", audio: { format: "m4a" }, duration: 150, title: "Take A" },
            { audio_url: "https://cdn.example/b.m4a", audio: { format: "m4a" }, duration: 148 },
          ],
        }),
      };
    }
    if (url.includes("cdn.example")) return { status: 200, body: "FAKEAUDIO", headers: { "content-type": "audio/mp4" } };
    return { status: 404, body: `unexpected url ${url}` };
  });
  const result = await musicGenTool.execute({ prompt: "city pop, 105 BPM" }, CONTEXT);
  const out = JSON.parse(result.output) as Record<string, unknown>;
  assert.equal(out.ok, true);
  assert.equal(out.channel, "flowmusic2api");
  // 既有单数栏位零改动：url＝主候选平台 URL、upstream_url＝主候选上游 URL
  assert.equal(out.url, "https://store.example/image-data/files/uploads/music-1.m4a");
  assert.equal(out.upstream_url, "https://cdn.example/a.m4a");
  // 新 additive 栏位：两笔、两个不同平台 URL、index 0/1
  const audios = out.audios as Array<{ url: string; upstream_url?: string; duration_seconds?: number; candidate_index: number }>;
  assert.equal(audios.length, 2);
  assert.equal(audios[0].candidate_index, 0);
  assert.equal(audios[0].url, out.url);
  assert.equal(audios[0].upstream_url, "https://cdn.example/a.m4a");
  assert.equal(audios[1].candidate_index, 1);
  assert.equal(audios[1].url, "https://store.example/image-data/files/uploads/music-2.m4a");
  assert.equal(audios[1].upstream_url, "https://cdn.example/b.m4a");
  assert.notEqual(audios[0].url, audios[1].url);
  assert.equal(out.candidate_errors, undefined);
  // 两个候选都真的下载（两次 cdn 请求）
  assert.equal(mockCalls.filter((call) => call.url.includes("cdn.example")).length, 2);
});

test("多候选：单 clip → audios.length=1，既有栏位零改动", async () => {
  delete process.env[YUE2_MODAL_ENDPOINT_ENV];
  installFetchMock(defaultResponder);
  const result = await musicGenTool.execute({ prompt: "city pop, 105 BPM" }, CONTEXT);
  const out = JSON.parse(result.output) as Record<string, unknown>;
  assert.equal(out.ok, true);
  assert.equal(out.url, "https://store.example/image-data/files/uploads/music-gen.flac");
  assert.equal(out.upstream_url, "https://cdn.example/a.m4a");
  const audios = out.audios as Array<{ url: string; candidate_index: number }>;
  assert.equal(audios.length, 1);
  assert.equal(audios[0].candidate_index, 0);
  assert.equal(audios[0].url, out.url);
  assert.equal(mockCalls.filter((call) => call.url.includes("cdn.example")).length, 1);
});

test("多候选：次候选下载失败 → 主候选照旧交付、candidate_errors 如实回报（非致命）", async () => {
  delete process.env[YUE2_MODAL_ENDPOINT_ENV];
  installFetchMock((url: string) => {
    if (url.includes("/v1/chat/completions")) {
      return {
        status: 200,
        body: JSON.stringify({
          clips: [
            { audio_url: "https://cdn.example/a.m4a", audio: { format: "m4a" }, duration: 150 },
            { audio_url: "https://cdn.example/broken.m4a", audio: { format: "m4a" }, duration: 148 },
          ],
        }),
      };
    }
    if (url.includes("cdn.example/a.m4a")) return { status: 200, body: "FAKEAUDIO", headers: { "content-type": "audio/mp4" } };
    if (url.includes("cdn.example/broken.m4a")) return { status: 404, body: "gone" };
    return defaultResponder(url);
  });
  const result = await musicGenTool.execute({ prompt: "city pop, 105 BPM" }, CONTEXT);
  const out = JSON.parse(result.output) as Record<string, unknown>;
  assert.equal(out.ok, true); // 非致命：主候选照旧交付
  assert.equal(out.url, "https://store.example/image-data/files/uploads/music-gen.flac");
  assert.equal(out.upstream_url, "https://cdn.example/a.m4a");
  const audios = out.audios as Array<unknown>;
  assert.equal(audios.length, 1);
  const errors = out.candidate_errors as Array<{ candidate_index: number; upstream_url: string; error: string }>;
  assert.equal(errors.length, 1);
  assert.equal(errors[0].candidate_index, 1);
  assert.equal(errors[0].upstream_url, "https://cdn.example/broken.m4a");
  assert.match(errors[0].error, /HTTP 404/);
});
