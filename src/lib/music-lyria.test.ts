/**
 * music-lyria.ts 测试（MOE Wave1 片B，2026-09-08；2026-10-02 generateContent 契约换血）。
 *
 * node:test + fetch mock（不真连）；覆盖：
 *   1. prompt 组装快照（buildLyriaStylePrompt 确定性拼接）
 *   2. key 选择：有 GEMINI_STUDIO_API_KEY → lyria-3.5 generateContent；
 *      无 → Vertex lyria-002 降级（degraded:true）
 *   3. 非 2xx 错误带原文 body 抛出（诚实铁律）
 *   4. 响应解析：candidates/inlineData 提取、legacy inline_data 兼容、无音频块报错
 *   5. 请求形状：POST models/<model>:generateContent、x-goog-api-key header、
 *      contents[0].parts（lyrics 分离 text part）、图片 inlineData（data URL 剥前缀）、>10 张图拒绝
 *   6. Vertex lyria-002 双 RIFF 头剥除
 */

import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  LYRIA_API_BASE_URL,
  LYRIA_MODELS,
  LYRIA_TIMEOUT_MS,
  LYRIA_VERTEX_MODEL,
  LYRIA_VERTEX_TIMEOUT_MS,
  buildLyriaStylePrompt,
  extractLyriaOutput,
  generateLyriaTrack,
  hasGeminiStudioApiKey,
  requireGeminiStudioApiKey,
} from "./music-lyria.ts";

// ── fetch mock 脚手架 ────────────────────────────────────────────────────────

type MockResponse = { status: number; body: string; headers?: Record<string, string> };

let mockCalls: Array<{ url: string; init: RequestInit }> = [];
let mockResponder: (url: string, init: RequestInit) => MockResponse = () => ({ status: 500, body: "no responder" });

const originalFetch = globalThis.fetch;
const originalStudioKey = process.env.GEMINI_STUDIO_API_KEY;
const originalVertexKey = process.env.GEMINI_API_KEY;

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
  process.env.GEMINI_STUDIO_API_KEY = "test-studio-key-123";
  delete process.env.GEMINI_API_KEY;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalStudioKey === undefined) delete process.env.GEMINI_STUDIO_API_KEY;
  else process.env.GEMINI_STUDIO_API_KEY = originalStudioKey;
  if (originalVertexKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = originalVertexKey;
});

// ── 1. prompt 组装快照 ───────────────────────────────────────────────────────

test("buildLyriaStylePrompt: 全栏位快照（style,genre,bpm,key,mood + Structure 行）", () => {
  const prompt = buildLyriaStylePrompt({
    style: "warm acoustic ballad, fingerpicked guitar",
    genre: "cinematic pop",
    bpm: 92.4,
    musicalKey: "D minor",
    mood: "melancholic but hopeful",
    structure: "[0:00-0:10] Intro, [0:10-0:40] Verse, [0:40-1:10] Chorus",
  });
  assert.equal(
    prompt,
    "warm acoustic ballad, fingerpicked guitar, cinematic pop, 92 BPM, key of D minor, mood: melancholic but hopeful\n" +
      "Structure: [0:00-0:10] Intro, [0:10-0:40] Verse, [0:40-1:10] Chorus",
  );
});

test("buildLyriaStylePrompt: instrumental 追加官方器乐声明", () => {
  const prompt = buildLyriaStylePrompt({ style: "lo-fi hip hop", instrumental: true });
  assert.equal(prompt, "lo-fi hip hop Instrumental only, no vocals.");
});

test("buildLyriaStylePrompt: 空契约回空串、零/负 BPM 忽略", () => {
  assert.equal(buildLyriaStylePrompt({}), "");
  assert.equal(buildLyriaStylePrompt({ style: "ambient", bpm: 0 }), "ambient");
  assert.equal(buildLyriaStylePrompt({ style: "ambient", bpm: -5 }), "ambient");
});

// ── 2. key 选择 / fail-fast ──────────────────────────────────────────────────

test("requireGeminiStudioApiKey: 缺 key 人话报错（fail-fast）", () => {
  delete process.env.GEMINI_STUDIO_API_KEY;
  assert.throws(() => requireGeminiStudioApiKey(), /GEMINI_STUDIO_API_KEY 未配置/);
});

test("requireGeminiStudioApiKey: 空白字串 key 视为缺失", () => {
  process.env.GEMINI_STUDIO_API_KEY = "   ";
  assert.throws(() => requireGeminiStudioApiKey(), /GEMINI_STUDIO_API_KEY 未配置/);
});

test("hasGeminiStudioApiKey: 有/无 key 判准", () => {
  assert.equal(hasGeminiStudioApiKey(), true);
  delete process.env.GEMINI_STUDIO_API_KEY;
  assert.equal(hasGeminiStudioApiKey(), false);
});

test("generateLyriaTrack: 两把 key 皆缺 → 抛且不发请求", async () => {
  delete process.env.GEMINI_STUDIO_API_KEY;
  delete process.env.GEMINI_API_KEY;
  await assert.rejects(() => generateLyriaTrack({ prompt: "ambient piano" }), /GEMINI_API_KEY 未配置/);
  assert.equal(mockCalls.length, 0);
});

// ── 3. 错误带原文（诚实铁律） ─────────────────────────────────────────────────

test("generateLyriaTrack: 非 2xx 带原文 body 抛出（studio 路径）", async () => {
  installFetchMock(() => ({ status: 429, body: '{"error":{"code":429,"message":"quota exceeded"}}' }));
  await assert.rejects(
    () => generateLyriaTrack({ prompt: "synthwave" }),
    (e: Error) => {
      assert.match(e.message, /HTTP 429/);
      assert.match(e.message, /quota exceeded/); // 原文 body 在错误讯息里
      return true;
    },
  );
});

test("generateLyriaTrack: 非 JSON 2xx 响应带原文摘录抛出", async () => {
  installFetchMock(() => ({ status: 200, body: "<html>gateway error page</html>" }));
  await assert.rejects(
    () => generateLyriaTrack({ prompt: "synthwave" }),
    (e: Error) => {
      assert.match(e.message, /不是合法 JSON/);
      assert.match(e.message, /gateway error page/);
      return true;
    },
  );
});

test("generateLyriaTrack: 空prompt 拒绝且不发请求", async () => {
  installFetchMock(() => ({ status: 200, body: "{}" }));
  await assert.rejects(() => generateLyriaTrack({ prompt: "   " }), /prompt 不能为空/);
  assert.equal(mockCalls.length, 0);
});

test("generateLyriaTrack: >10 张参考图拒绝且不发请求", async () => {
  installFetchMock(() => ({ status: 200, body: "{}" }));
  const images = Array.from({ length: 11 }, (_, i) => `img${i}`);
  await assert.rejects(() => generateLyriaTrack({ prompt: "epic", imagesBase64: images }), /最多 10 张/);
  assert.equal(mockCalls.length, 0);
});

// ── 4. 响应解析 ──────────────────────────────────────────────────────────────

test("extractLyriaOutput: generateContent candidates/inlineData 提取 + lyrics echo", () => {
  const body = {
    candidates: [
      {
        content: {
          role: "model",
          parts: [
            { text: "[Verse]\nLine one\n[Chorus]\nLine two" },
            { inlineData: { mimeType: "audio/mpeg", data: "QUJDREVG" } },
          ],
        },
      },
    ],
  };
  const out = extractLyriaOutput(body);
  assert.equal(out.audioBase64, "QUJDREVG");
  assert.equal(out.mimeType, "audio/mpeg");
  assert.match(out.lyricsEcho ?? "", /\[Chorus\]/);
});

test("extractLyriaOutput: legacy steps/inline_data 形状兼容 + 缺 mime 默认 audio/mpeg", () => {
  const out = extractLyriaOutput({
    steps: [{ model_output: { inline_data: { data: "WUJDSFQ=" } } }],
  });
  assert.equal(out.audioBase64, "WUJDSFQ=");
  assert.equal(out.mimeType, "audio/mpeg");
  assert.equal(out.lyricsEcho, undefined);
});

test("extractLyriaOutput: 无音频块带原文摘录抛错", () => {
  assert.throws(
    () => extractLyriaOutput({ candidates: [{ content: { parts: [{ text: "no audio" }] } }] }),
    (e: Error) => {
      assert.match(e.message, /未找到音频块/);
      assert.match(e.message, /no audio/);
      return true;
    },
  );
});

// ── 5. 请求形状 ──────────────────────────────────────────────────────────────

test("generateLyriaTrack: 端点/header/model/lyrics 分离 parts 请求形状（studio）", async () => {
  installFetchMock(() => ({
    status: 200,
    body: JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/mpeg", data: "AAECAw==" } }] } }] }),
  }));
  const res = await generateLyriaTrack({ prompt: "city pop, 105 BPM", lyrics: "[Verse]\nこんにちは", model: LYRIA_MODELS.clip30 });

  assert.equal(mockCalls.length, 1);
  const call = mockCalls[0];
  assert.equal(call.url, `${LYRIA_API_BASE_URL}/models/lyria-3-clip-preview:generateContent`);
  assert.equal(call.init.method, "POST");

  const headers = call.init.headers as Record<string, string>;
  assert.equal(headers["x-goog-api-key"], "test-studio-key-123");
  assert.equal(headers["Content-Type"], "application/json");

  const payload = JSON.parse(String(call.init.body)) as {
    contents: Array<{ role: string; parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> }>;
  };
  assert.equal(payload.contents.length, 1);
  assert.equal(payload.contents[0].role, "user");
  const parts = payload.contents[0].parts;
  assert.equal(parts.length, 2); // style text + lyrics text，无图
  assert.equal(parts[0].text, "city pop, 105 BPM");
  assert.match(parts[1].text ?? "", /^Lyrics:\n/);
  assert.match(parts[1].text ?? "", /こんにちは/);
  assert.equal(res.backend, "gemini_studio");
  assert.equal(res.effectiveModel, "lyria-3-clip-preview");
});

test("generateLyriaTrack: 默认模型 lyria-3.5；data URL 图剥前缀取 mime（inlineData）", async () => {
  installFetchMock(() => ({
    status: 200,
    body: JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/mpeg", data: "AAECAw==" } }] } }] }),
  }));
  await generateLyriaTrack({
    prompt: "epic trailer",
    imagesBase64: ["data:image/png;base64,iVBORw0KGgo=", "cGxhaW4="],
  });

  assert.equal(mockCalls[0].url, `${LYRIA_API_BASE_URL}/models/lyria-3.5:generateContent`);
  const payload = JSON.parse(String(mockCalls[0].init.body)) as {
    contents: Array<{ parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> }>;
  };
  const imageParts = payload.contents[0].parts.filter((p) => p.inlineData);
  assert.equal(imageParts.length, 2);
  assert.deepEqual(
    imageParts.map((p) => p.inlineData?.mimeType),
    ["image/png", "image/jpeg"], // data URL 取真 mime；裸 base64 默认 jpeg
  );
  assert.equal(imageParts[0].inlineData?.data, "iVBORw0KGgo=");
});

test("generateLyriaTrack: 无歌词时只有 style 单 text part", async () => {
  installFetchMock(() => ({
    status: 200,
    body: JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/mpeg", data: "AAECAw==" } }] } }] }),
  }));
  await generateLyriaTrack({ prompt: "ambient" });
  const payload = JSON.parse(String(mockCalls[0].init.body)) as { contents: Array<{ parts: Array<{ text?: string }> }> };
  assert.equal(payload.contents[0].parts.length, 1);
  assert.equal(payload.contents[0].parts[0].text, "ambient");
});

// ── 6. Vertex 降级 ───────────────────────────────────────────────────────────

/** 造一个「外层 44-byte RIFF 包住内层完整 WAV」的双头样本。 */
function makeDoubleRiffWav(innerAudio: Buffer): Buffer {
  const inner = Buffer.alloc(44);
  inner.write("RIFF", 0, "ascii");
  inner.writeUInt32LE(36 + innerAudio.length, 4);
  inner.write("WAVE", 8, "ascii");
  inner.write("fmt ", 12, "ascii");
  inner.writeUInt32LE(16, 16);
  inner.write("data", 36, "ascii");
  inner.writeUInt32LE(innerAudio.length, 40);
  const innerFull = Buffer.concat([inner, innerAudio]);
  const outer = Buffer.alloc(44);
  outer.write("RIFF", 0, "ascii");
  outer.writeUInt32LE(2 * innerFull.length, 4); // 实测到的错误：外层 size 被算成两倍
  outer.write("WAVE", 8, "ascii");
  outer.write("fmt ", 12, "ascii");
  outer.writeUInt32LE(16, 16);
  outer.write("data", 36, "ascii");
  outer.writeUInt32LE(2 * innerFull.length, 40);
  return Buffer.concat([outer, innerFull]);
}

test("generateLyriaTrack: 无 studio key 但有 AQ. vertex key → Vertex lyria-002，degraded + 剥双 RIFF 头", async () => {
  delete process.env.GEMINI_STUDIO_API_KEY;
  process.env.GEMINI_API_KEY = "AQ.test-vertex-express-key";
  const innerAudio = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
  const doubleWav = makeDoubleRiffWav(innerAudio);
  installFetchMock(() => ({
    status: 200,
    body: JSON.stringify({ predictions: [{ bytesBase64Encoded: doubleWav.toString("base64"), mimeType: "audio/wav" }] }),
  }));

  const res = await generateLyriaTrack({ prompt: "lo-fi beat", lyrics: "[Verse]\nhello", model: LYRIA_MODELS.full });
  assert.equal(res.backend, "vertex_express");
  assert.equal(res.effectiveModel, LYRIA_VERTEX_MODEL);
  assert.equal(res.degraded, true);
  assert.ok((res.ignoredInputs ?? []).some((s) => s.startsWith("lyrics")));
  // 剥掉外层 44-byte 头后＝内层完整 WAV（RIFF 开头、长度＝innerFull）
  const stripped = Buffer.from(res.audioBase64, "base64");
  assert.equal(stripped.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(stripped.length, 44 + innerAudio.length);
  assert.equal(stripped.subarray(44, 52).equals(innerAudio), true);
});

// ── 常量守卫（快照：防止无声漂移） ─────────────────────────────────────────────

test("常量快照：端点/模型映射/超时", () => {
  assert.equal(LYRIA_API_BASE_URL, "https://generativelanguage.googleapis.com/v1beta");
  assert.deepEqual(LYRIA_MODELS, { full: "lyria-3.5", clip30: "lyria-3-clip-preview" });
  assert.equal(LYRIA_TIMEOUT_MS, 120_000);
  assert.equal(LYRIA_VERTEX_MODEL, "lyria-002");
  assert.equal(LYRIA_VERTEX_TIMEOUT_MS, 150_000);
});
