/**
 * music-tools.ts 通路接線測試（片 B：music_gen 第三通路，2026-09-18）。
 *
 * node:test + fetch mock（不真連上游、不真落盤）；覆蓋本片白名單改動的**行為**：
 *   1. 通路優先序：YUE2_MODAL_ENDPOINT 非空 → yue2（即使 FLOWMUSIC2API_URL 也在場）
 *   2. YuE2 回執：channel=yue2_modal／model=m-a-p/YuE2-3B／score_abc additive 欄位／
 *      duration_source=upstream_reported（ffprobe 對假位元組必然失敗）／檔名副檔名 .flac
 *   3. clip30 在 YuE2 通路如實報錯（不靜默生成整歌假裝 30 秒），且不發任何上游請求
 *   4. reference_images 在 YuE2 通路忽略並如實標注（不靜默）
 *   5. 既有通路零回歸：未配 YUE2_MODAL_ENDPOINT 時走 flowmusic2api 且 score_abc=null
 *   6. 失敗回落（片 G，2026-09-19）：yue2 拋錯 → FlowMusic 已配置則完整回落重跑
 *      （回執 fallback_from/fallback_reason additive）；FlowMusic 未配置 → fail 帶原文。
 *      mock 方式＝既有 fetch mock（generateYue2Track 的網路層在 fetch 上，mock 它拋錯
 *      ＝等價 mock client 拋錯）。
 *   7. 樂譜編輯（片 K，2026-09-19）：abc/cot_mode 參數全鏈透傳（request body 含 abc、
 *      cot 跟隨 cot_mode）；cot_mode=melody 無 abc → fail；abc 但 YuE2 未啟用 → 如實
 *      報錯；帶 abc 時 yue2 拋錯不回落（零 FlowMusic 請求，語義完整性優先）。
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
const ENV_KEYS = [YUE2_MODAL_ENDPOINT_ENV, YUE2_HMAC_SECRET_ENV, "FLOWMUSIC2API_URL", "FLOWMUSIC2API_KEY"] as const;
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
  process.env.FLOWMUSIC2API_URL = "http://127.0.0.1:8000"; // 同時在場 → 驗優先序
  process.env.FLOWMUSIC2API_KEY = "test-key";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** 三路 mock：YuE2 /generate、gateway 素材入庫、FlowMusic2API（含音頻下載）。 */
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

/** yue2 服務不可達 mock（網路層拋錯：fetch reject = 筆電關機/隧道斷線的現場形狀）。 */
function yue2DownResponder(url: string): MockResponse {
  if (url.endsWith("/generate")) {
    throw new Error("fetch failed: tunnel is down");
  }
  return defaultResponder(url);
}

const CONTEXT = { sessionId: "sess-music-1" };

// ── 1. 通路優先序與 YuE2 回執 ────────────────────────────────────────────────

test("優先序：YUE2_MODAL_ENDPOINT 非空即走 yue2（flowmusic env 同時在場也不搶）", async () => {
  installFetchMock(defaultResponder);
  const result = await musicGenTool.execute({ prompt: "city pop, 105 BPM", duration_hint: "full" }, CONTEXT);
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

test("YuE2 落盤副檔名 .flac（MIME 表 additive：audio/flac→flac，否則檔名標籤說謊）", async () => {
  installFetchMock(defaultResponder);
  await musicGenTool.execute({ prompt: "city pop, 105 BPM" }, CONTEXT);
  const upload = mockCalls.find((call) => call.url.includes("/internal/media/upload"));
  assert.ok(upload);
  const body = JSON.parse(String(upload.init.body)) as { filename: string };
  assert.match(body.filename, /^music-gen-\d+\.flac$/);
});

test("YuE2 無 sessionId：跳過上傳並如實帶 audio_base64（不偽造 URL）", async () => {
  installFetchMock(defaultResponder);
  const result = await musicGenTool.execute({ prompt: "city pop, 105 BPM" }, {});
  const out = JSON.parse(result.output) as Record<string, unknown>;
  assert.equal(out.channel, "yue2_modal");
  assert.equal(out.upload, "skipped_no_session");
  assert.equal(out.audio_base64, "ZmxhYw==");
  assert.equal(out.url, undefined);
});

// ── 2. clip30 如實報錯 ───────────────────────────────────────────────────────

test("YuE2 通路 clip30：如實報錯（unsupported_duration_hint），零上游請求", async () => {
  installFetchMock(defaultResponder);
  const result = await musicGenTool.execute({ prompt: "city pop, 105 BPM", duration_hint: "clip30" }, CONTEXT);
  const out = JSON.parse(result.output) as { ok: boolean; error: { code: string; hint: string } };
  assert.equal(out.ok, false);
  assert.equal(out.error.code, "unsupported_duration_hint");
  assert.match(out.error.hint, /无 30 秒短档模式/);
  assert.match(out.error.hint, /duration_hint="full"/);
  assert.equal(mockCalls.length, 0);
});

// ── 3. reference_images 忽略並如實標注 ───────────────────────────────────────

test("YuE2 通路 reference_images：不進上游 body、回執如實標注已忽略", async () => {
  installFetchMock(defaultResponder);
  const result = await musicGenTool.execute(
    { prompt: "city pop, 105 BPM", reference_images: "data:image/png;base64,AAAA,data:image/png;base64,BBBB" },
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

// ── 4. 既有通路零回歸 ────────────────────────────────────────────────────────

test("未配 YUE2_MODAL_ENDPOINT：回落 flowmusic2api，score_abc=null（欄位仍在場）", async () => {
  installFetchMock(defaultResponder);
  delete process.env[YUE2_MODAL_ENDPOINT_ENV];
  const result = await musicGenTool.execute({ prompt: "city pop, 105 BPM" }, CONTEXT);
  const out = JSON.parse(result.output) as Record<string, unknown>;
  assert.equal(out.channel, "flowmusic2api");
  assert.equal(out.model, "lyria");
  assert.equal(out.score_abc, null);
  assert.equal(out.upstream_url, "https://cdn.example/a.m4a");
  // ffprobe 對假位元組必然失敗 → 回退上游 Duration 提示（150）並標 model_hint（既有行為不變）
  assert.equal(out.duration_source, "model_hint");
  assert.equal(out.duration_seconds, 150);
});

// ── 5. 失敗回落（片 G，2026-09-19）───────────────────────────────────────────

test("回落：yue2 網路層拋錯 → FlowMusic 已配置 → 完整重跑成功，回執 additive 帶 fallback_from/fallback_reason", async () => {
  installFetchMock(yue2DownResponder);
  const result = await musicGenTool.execute({ prompt: "city pop, 105 BPM" }, CONTEXT);
  const out = JSON.parse(result.output) as Record<string, unknown>;
  assert.equal(out.ok, true);
  // 通路如實回報實際生成通路（回落成功＝走 flowmusic）
  assert.equal(out.channel, "flowmusic2api");
  assert.equal(out.model, "lyria");
  assert.equal(out.score_abc, null);
  assert.equal(out.upstream_url, "https://cdn.example/a.m4a");
  assert.equal(out.duration_source, "model_hint");
  assert.equal(out.duration_seconds, 150);
  assert.equal(out.mime_type, "audio/mp4");
  // 回落事實 additive 欄位（只在真的發生回落時在場）
  assert.equal(out.fallback_from, "yue2_modal");
  assert.match(String(out.fallback_reason), /tunnel is down/);
  // 回落後 director 以 flowmusic 通道重新跑（prompt_director.channel 如實回報實際版面）
  assert.deepEqual(out.prompt_director && (out.prompt_director as { channel: string }).channel, "flowmusic");
  // FlowMusic 收到的 prompt 是 flowmusic 版面（yue2 版面不會直接送過去）
  const generate = mockCalls.find((call) => call.url.includes("/v1/chat/completions"));
  assert.ok(generate);
  const sent = JSON.parse(String(generate.init.body)) as { messages: Array<{ content: string }> };
  assert.match(sent.messages[0].content, /city pop/);
  // yue2 真的嘗試過（先試 yue2 才回落，順序：/generate → chat/completions → cdn）
  const urls = mockCalls.map((call) => call.url);
  const yue2Index = urls.findIndex((url) => url.endsWith("/generate"));
  const flowIndex = urls.findIndex((url) => url.includes("/v1/chat/completions"));
  assert.ok(yue2Index !== -1 && flowIndex !== -1 && yue2Index < flowIndex);
});

test("回落：yue2 拋錯 → FlowMusic 未配置 → fail 帶 YuE2 原錯誤原文（不靜默、不回落 Lyria）", async () => {
  installFetchMock(yue2DownResponder);
  delete process.env.FLOWMUSIC2API_URL;
  const result = await musicGenTool.execute({ prompt: "city pop, 105 BPM" }, CONTEXT);
  const out = JSON.parse(result.output) as { ok: boolean; error: { code: string; hint: string } };
  assert.equal(out.ok, false);
  assert.equal(out.error.code, "music_tool_error");
  assert.match(out.error.hint, /fetch failed: tunnel is down/);
  // 只試過 yue2，零個其他通路請求
  const urls = mockCalls.map((call) => call.url);
  assert.equal(urls.filter((url) => url.includes("/v1/chat/completions")).length, 0);
  assert.equal(urls.filter((url) => url.includes("generativelanguage")).length, 0);
});

test("回落回執 additive-only：既有鍵零刪除（與非回落 flowmusic 回執的鍵集合對照，只多不少）", async () => {
  // 基準＝不走 yue2 的純 flowmusic 回執鍵集合
  installFetchMock(defaultResponder);
  delete process.env[YUE2_MODAL_ENDPOINT_ENV];
  const baselineResult = await musicGenTool.execute({ prompt: "city pop, 105 BPM" }, CONTEXT);
  const baselineKeys = Object.keys(JSON.parse(baselineResult.output) as Record<string, unknown>).sort();

  // 回落版（env 恢復 beforeEach 設定的雙通路在場）
  installFetchMock(yue2DownResponder);
  process.env[YUE2_MODAL_ENDPOINT_ENV] = "https://yue2-modal.example";
  const fallbackResult = await musicGenTool.execute({ prompt: "city pop, 105 BPM" }, CONTEXT);
  const fallbackOut = JSON.parse(fallbackResult.output) as Record<string, unknown>;
  const fallbackKeys = Object.keys(fallbackOut).sort();

  assert.deepEqual(fallbackKeys.filter((k) => !baselineKeys.includes(k)), ["fallback_from", "fallback_reason"]);
  assert.deepEqual(baselineKeys.filter((k) => !fallbackKeys.includes(k)), []);
});

test("回落時 yue2 的 clip30 前置拒絕不觸發回落（參數性 fail ≠ 通路故障，flowmusic 的 clip30 語義照舊）", async () => {
  installFetchMock(yue2DownResponder);
  const result = await musicGenTool.execute({ prompt: "city pop, 105 BPM", duration_hint: "clip30" }, CONTEXT);
  const out = JSON.parse(result.output) as { ok: boolean; error: { code: string } };
  // yue2 啟用 + clip30 → 我們在上游前自己拒的（unsupported_duration_hint），零上游請求零回落
  assert.equal(out.ok, false);
  assert.equal(out.error.code, "unsupported_duration_hint");
  assert.equal(mockCalls.length, 0);
});

// ── 6. 樂譜編輯：abc／cot_mode 全鏈透傳（片 K，2026-09-19）────────────────────

const EDITED_ABC = "X:1\nT:edited\nK:G\nQ:4/4\nG4 A4 B4 c4|";

test("帶譜重渲染：abc＋cot_mode=full 透傳到 YuE2 request body（abc 逐字、cot 跟隨），回執帶 cot_mode/abc_sha256", async () => {
  installFetchMock(defaultResponder);
  const result = await musicGenTool.execute(
    { prompt: "jazz ballad, 70 BPM", abc: EDITED_ABC, cot_mode: "full" },
    CONTEXT,
  );
  const out = JSON.parse(result.output) as Record<string, unknown>;
  assert.equal(out.ok, true);
  assert.equal(out.channel, "yue2_modal");
  // 回執 additive：實際 cot 模式＋樂譜指紋（sha256 逐位元組驗）
  assert.equal(out.cot_mode, "full");
  assert.equal(out.abc_sha256, createHash("sha256").update(EDITED_ABC, "utf8").digest("hex"));
  // 透傳斷言：request body 含 abc 逐字、cot=full
  const generate = mockCalls.find((call) => call.url.endsWith("/generate"));
  assert.ok(generate);
  const sent = JSON.parse(String(generate.init.body)) as Record<string, unknown>;
  assert.equal(sent.abc, EDITED_ABC);
  assert.equal(sent.cot, "full");
});

test("帶譜重渲染：cot_mode=melody 透傳（翻唱模式），abc 缺席＋melody → invalid_args fail", async () => {
  // ① melody＋abc：cot 透傳 melody
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

  // ② melody 無 abc：語義不成立（melody＝以 abc 為旋律骨幹），參數性 fail 零上游請求
  installFetchMock(defaultResponder);
  const failResult = await musicGenTool.execute({ prompt: "funk, 110 BPM", cot_mode: "melody" }, CONTEXT);
  const failOut = JSON.parse(failResult.output) as { ok: boolean; error: { code: string; hint: string } };
  assert.equal(failOut.ok, false);
  assert.equal(failOut.error.code, "invalid_args");
  assert.match(failOut.error.hint, /cot_mode="melody" 必须搭配 abc/);
  assert.equal(mockCalls.length, 0);
});

test("帶譜但 YuE2 未啟用：如實報錯（unsupported_channel_for_abc），不靜默忽略、零上游請求", async () => {
  installFetchMock(defaultResponder);
  delete process.env[YUE2_MODAL_ENDPOINT_ENV];
  const result = await musicGenTool.execute({ prompt: "city pop, 105 BPM", abc: EDITED_ABC }, CONTEXT);
  const out = JSON.parse(result.output) as { ok: boolean; error: { code: string; hint: string } };
  assert.equal(out.ok, false);
  assert.equal(out.error.code, "unsupported_channel_for_abc");
  assert.match(out.error.hint, /仅 YuE2 通路支持/);
  // FlowMusic 明明在場（beforeEach 雙 env）也不搶跑：通路選擇優先序不可被 abc 旁路
  assert.equal(mockCalls.length, 0);
});

test("帶 abc 時 yue2 拋錯不觸發回落：直接 fail 帶原文，零 FlowMusic 請求（語義完整性優先）", async () => {
  installFetchMock(yue2DownResponder);
  const result = await musicGenTool.execute({ prompt: "city pop, 105 BPM", abc: EDITED_ABC }, CONTEXT);
  const out = JSON.parse(result.output) as { ok: boolean; error: { code: string; hint: string } };
  assert.equal(out.ok, false);
  assert.equal(out.error.code, "music_tool_error");
  assert.match(out.error.hint, /fetch failed: tunnel is down/);
  // 只試過 yue2 的 /generate，零 FlowMusic／Lyria 請求（FlowMusic 不認 abc，回落會丟失樂譜語義）
  const urls = mockCalls.map((call) => call.url);
  assert.equal(urls.filter((url) => url.includes("/v1/chat/completions")).length, 0);
  assert.equal(urls.filter((url) => url.includes("generativelanguage")).length, 0);
});

test("樂譜編輯回執 additive-only：與不帶 abc 的 YuE2 回執鍵集合對照，只多不少（cot_mode/abc_sha256 additive）", async () => {
  // 基準＝不帶 abc 的 YuE2 常規生成回執鍵集合
  installFetchMock(defaultResponder);
  const baselineResult = await musicGenTool.execute({ prompt: "city pop, 105 BPM" }, CONTEXT);
  const baselineKeys = Object.keys(JSON.parse(baselineResult.output) as Record<string, unknown>).sort();

  // 帶譜版（同 mock、同 env）
  installFetchMock(defaultResponder);
  const editedResult = await musicGenTool.execute({ prompt: "city pop, 105 BPM", abc: EDITED_ABC }, CONTEXT);
  const editedOut = JSON.parse(editedResult.output) as Record<string, unknown>;
  const editedKeys = Object.keys(editedOut).sort();

  // 帶譜版多 cot_mode＋abc_sha256 兩鍵（cot_mode 基準版也在場——YuE2 通路常規生成即帶），零刪除
  assert.deepEqual(baselineKeys.filter((k) => !editedKeys.includes(k)), [], "帶譜版不得刪除任何既有回執鍵");
  assert.ok(editedKeys.includes("cot_mode"), "帶譜版應帶 cot_mode");
  assert.ok(editedKeys.includes("abc_sha256"), "帶譜版應帶 abc_sha256");
  assert.equal((baselineKeys as string[]).includes("abc_sha256"), false, "不帶 abc 的常規生成不帶 abc_sha256");
});

test("cot_mode=off 不對工具開放：invalid_args 如實報錯（工具語義永遠要樂譜回執）", async () => {
  installFetchMock(defaultResponder);
  const result = await musicGenTool.execute({ prompt: "city pop, 105 BPM", cot_mode: "off" }, CONTEXT);
  const out = JSON.parse(result.output) as { ok: boolean; error: { code: string; hint: string } };
  assert.equal(out.ok, false);
  assert.equal(out.error.code, "invalid_args");
  assert.match(out.error.hint, /"off" 不对工具开放/);
  assert.equal(mockCalls.length, 0);
});

// ── 7. 翻唱工作流：source_audio 扒譜＋重演繹（片 O，2026-09-19）────────────────

/** 扒譜成功 mock（服務端 /transcribe 200 契約形狀）。 */
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

test("翻唱兩段調用順序：先 /transcribe 後 /generate，扒譜 abc 逐字透傳、cot_mode 缺省 melody、回執帶 transcribed_abc_sha256/transcribe_warnings", async () => {
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
  // 回執 additive：扒譜指紋＋警告如實透傳
  assert.equal(out.transcribed_abc_sha256, createHash("sha256").update(TRANSCRIBED_ABC, "utf8").digest("hex"));
  assert.deepEqual(out.transcribe_warnings, ["audio trimmed to 60s"]);
  // 帶 source_audio 的委託不帶 abc_sha256（互斥語義：扒譜產物走 transcribed_*）
  assert.equal(out.abc_sha256, undefined);
  // 兩段調用順序：/transcribe 在 /generate 之前
  const urls = mockCalls.map((call) => call.url);
  const transcribeIndex = urls.findIndex((url) => url.endsWith("/transcribe"));
  const generateIndex = urls.findIndex((url) => url.endsWith("/generate"));
  assert.ok(transcribeIndex !== -1 && generateIndex !== -1 && transcribeIndex < generateIndex);
  // transcribe body：data: 前綴剝除、melody_only=true
  const transcribe = mockCalls[transcribeIndex];
  const transcribeSent = JSON.parse(String(transcribe.init.body)) as Record<string, unknown>;
  assert.equal(transcribeSent.audio_b64, "QUJDREVG");
  assert.equal(transcribeSent.melody_only, true);
  // generate body：abc＝扒譜產物逐字、cot=melody
  const generate = mockCalls[generateIndex];
  const sent = JSON.parse(String(generate.init.body)) as Record<string, unknown>;
  assert.equal(sent.abc, TRANSCRIBED_ABC);
  assert.equal(sent.cot, "melody");
});

test("翻唱顯式 cot_mode=full：保留原和聲重渲染（透傳 full，缺省規則不覆蓋顯式值）", async () => {
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

test("翻唱互斥：source_audio 與 abc 同傳 → invalid_args，零上游請求", async () => {
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

test("翻唱但 YuE2 未啟用：如實報錯（unsupported_channel_for_source_audio），零上游請求", async () => {
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
  // FlowMusic 明明在場（beforeEach 雙 env）也不搶跑
  assert.equal(mockCalls.length, 0);
});

test("翻唱扒譜 422 abc_missing：映射 yue2_transcribe_abc_missing（確定性失敗勿重試），零 /generate 請求", async () => {
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
  // 只試過 /transcribe，零 /generate（扒不出譜就不到生成段）
  const urls = mockCalls.map((call) => call.url);
  assert.equal(urls.filter((url) => url.endsWith("/generate")).length, 0);
});

test("翻唱 yue2 生成段拋錯不觸發回落：直接 fail 帶原文，零 FlowMusic 請求（語義完整性優先）", async () => {
  // /transcribe 成功、/generate 網路層拋錯
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

test("翻唱 clip30：照既有 clip30 拒絕規則走（unsupported_duration_hint，零上游請求）", async () => {
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

test("翻唱回執 additive-only：與不帶 source_audio 的 YuE2 回執鍵集合對照，只多不少", async () => {
  // 基準＝不帶 source_audio 的 YuE2 常規生成回執鍵集合
  installFetchMock(defaultResponder);
  const baselineResult = await musicGenTool.execute({ prompt: "city pop, 105 BPM" }, CONTEXT);
  const baselineKeys = Object.keys(JSON.parse(baselineResult.output) as Record<string, unknown>).sort();

  // 翻唱版（同 env）
  installFetchMock(transcribeResponder);
  const coverResult = await musicGenTool.execute({ prompt: "city pop, 105 BPM", source_audio: "QUJD" }, CONTEXT);
  const coverOut = JSON.parse(coverResult.output) as Record<string, unknown>;
  const coverKeys = Object.keys(coverOut).sort();

  assert.deepEqual(baselineKeys.filter((k) => !coverKeys.includes(k)), [], "翻唱版不得刪除任何既有回執鍵");
  assert.deepEqual(coverKeys.filter((k) => !baselineKeys.includes(k)), [
    "transcribe_warnings",
    "transcribed_abc_sha256",
  ]);
});
