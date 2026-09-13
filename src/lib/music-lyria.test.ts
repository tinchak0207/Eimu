/**
 * music-lyria.ts 測試（MOE Wave1 片B，2026-09-08）。
 *
 * node:test + fetch mock（不真連）；覆蓋：
 *   1. prompt 組裝快照（buildLyriaStylePrompt 確定性拼接）
 *   2. 缺 GEMINI_API_KEY fail-fast（人話報錯、不發請求）
 *   3. 非 2xx 錯誤帶原文 body 拋出（誠實鐵律）
 *   4. 響應解析：steps/model_output audio+text 提取、inline_data 兼容、無音頻塊報錯
 *   5. 請求形狀：x-goog-api-key header、model 映射、lyrics 分離 text part、
 *      圖片 parts（data URL 剝前綴）、>10 張圖拒絕
 */

import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  LYRIA_INTERACTIONS_URL,
  LYRIA_MODELS,
  LYRIA_TIMEOUT_MS,
  buildLyriaStylePrompt,
  extractLyriaOutput,
  generateLyriaTrack,
  requireGeminiApiKey,
} from "./music-lyria.ts";

// ── fetch mock 腳手架 ────────────────────────────────────────────────────────

type MockResponse = { status: number; body: string; headers?: Record<string, string> };

let mockCalls: Array<{ url: string; init: RequestInit }> = [];
let mockResponder: (url: string, init: RequestInit) => MockResponse = () => ({ status: 500, body: "no responder" });

const originalFetch = globalThis.fetch;
const originalEnvKey = process.env.GEMINI_API_KEY;

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
  process.env.GEMINI_API_KEY = "test-key-123";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalEnvKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = originalEnvKey;
});

// ── 1. prompt 組裝快照 ───────────────────────────────────────────────────────

test("buildLyriaStylePrompt: 全欄位快照（style,genre,bpm,key,mood + Structure 行）", () => {
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

test("buildLyriaStylePrompt: instrumental 追加官方器樂聲明", () => {
  const prompt = buildLyriaStylePrompt({ style: "lo-fi hip hop", instrumental: true });
  assert.equal(prompt, "lo-fi hip hop Instrumental only, no vocals.");
});

test("buildLyriaStylePrompt: 空契約回空串、零/負 BPM 忽略", () => {
  assert.equal(buildLyriaStylePrompt({}), "");
  assert.equal(buildLyriaStylePrompt({ style: "ambient", bpm: 0 }), "ambient");
  assert.equal(buildLyriaStylePrompt({ style: "ambient", bpm: -5 }), "ambient");
});

// ── 2. 缺 key fail-fast ──────────────────────────────────────────────────────

test("requireGeminiApiKey: 缺 key 人話報錯（fail-fast）", () => {
  delete process.env.GEMINI_API_KEY;
  assert.throws(() => requireGeminiApiKey(), /GEMINI_API_KEY 未配置/);
});

test("generateLyriaTrack: 缺 key 時不發請求直接拋", async () => {
  delete process.env.GEMINI_API_KEY;
  await assert.rejects(() => generateLyriaTrack({ prompt: "ambient piano" }), /GEMINI_API_KEY 未配置/);
  assert.equal(mockCalls.length, 0);
});

test("requireGeminiApiKey: 空白字串 key 視為缺失", () => {
  process.env.GEMINI_API_KEY = "   ";
  assert.throws(() => requireGeminiApiKey(), /GEMINI_API_KEY 未配置/);
});

// ── 3. 錯誤帶原文（誠實鐵律） ─────────────────────────────────────────────────

test("generateLyriaTrack: 非 2xx 帶原文 body 拋出", async () => {
  installFetchMock(() => ({ status: 429, body: '{"error":{"code":429,"message":"quota exceeded"}}' }));
  await assert.rejects(
    () => generateLyriaTrack({ prompt: "synthwave" }),
    (e: Error) => {
      assert.match(e.message, /HTTP 429/);
      assert.match(e.message, /quota exceeded/); // 原文 body 在錯誤訊息裡
      return true;
    },
  );
});

test("generateLyriaTrack: 非 JSON 2xx 響應帶原文摘錄拋出", async () => {
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

test("generateLyriaTrack: 空prompt 拒絕且不發請求", async () => {
  installFetchMock(() => ({ status: 200, body: "{}" }));
  await assert.rejects(() => generateLyriaTrack({ prompt: "   " }), /prompt 不能为空/);
  assert.equal(mockCalls.length, 0);
});

test("generateLyriaTrack: >10 張參考圖拒絕且不發請求", async () => {
  installFetchMock(() => ({ status: 200, body: "{}" }));
  const images = Array.from({ length: 11 }, (_, i) => `img${i}`);
  await assert.rejects(() => generateLyriaTrack({ prompt: "epic", imagesBase64: images }), /最多 10 张/);
  assert.equal(mockCalls.length, 0);
});

// ── 4. 響應解析 ──────────────────────────────────────────────────────────────

test("extractLyriaOutput: steps/model_output audio+text 提取", () => {
  const body = {
    steps: [
      { step_type: "planning", text: "planning..." },
      {
        step_type: "model_output",
        output: {
          parts: [
            { type: "text", text: "[Verse]\nLine one" },
            { type: "audio", mime_type: "audio/mpeg", data: "QUJDREVG" },
          ],
        },
      },
    ],
  };
  const out = extractLyriaOutput(body);
  assert.equal(out.audioBase64, "QUJDREVG");
  assert.equal(out.mimeType, "audio/mpeg");
  assert.match(out.lyricsEcho ?? "", /\[Verse\]/);
});

test("extractLyriaOutput: inline_data 形狀兼容 + 缺 mime 默認 audio/mpeg", () => {
  const out = extractLyriaOutput({
    steps: [{ model_output: { inline_data: { data: "WUJDSFQ=" } } }],
  });
  assert.equal(out.audioBase64, "WUJDSFQ=");
  assert.equal(out.mimeType, "audio/mpeg");
  assert.equal(out.lyricsEcho, undefined);
});

test("extractLyriaOutput: 無音頻塊帶原文摘錄拋錯", () => {
  assert.throws(
    () => extractLyriaOutput({ steps: [{ model_output: { parts: [{ type: "text", text: "no audio" }] } }] }),
    (e: Error) => {
      assert.match(e.message, /未找到音頻塊/);
      assert.match(e.message, /no audio/);
      return true;
    },
  );
});

// ── 5. 請求形狀 ──────────────────────────────────────────────────────────────

test("generateLyriaTrack: 端點/header/model/lyrics 分離 parts 請求形狀", async () => {
  installFetchMock(() => ({
    status: 200,
    body: JSON.stringify({ steps: [{ model_output: { parts: [{ type: "audio", data: "AAECAw==" }] } }] }),
  }));
  await generateLyriaTrack({ prompt: "city pop, 105 BPM", lyrics: "[Verse]\nこんにちは", model: LYRIA_MODELS.clip30 });

  assert.equal(mockCalls.length, 1);
  const call = mockCalls[0];
  assert.equal(call.url, LYRIA_INTERACTIONS_URL);

  const headers = call.init.headers as Record<string, string>;
  assert.equal(headers["x-goog-api-key"], "test-key-123");
  assert.equal(headers["Content-Type"], "application/json");

  const payload = JSON.parse(String(call.init.body)) as {
    model: string;
    input: Array<{ type: string; text?: string; mime_type?: string; data?: string }>;
  };
  assert.equal(payload.model, "lyria-3-clip-preview");
  assert.equal(payload.input.length, 2); // style text + lyrics text，無圖
  assert.equal(payload.input[0].type, "text");
  assert.equal(payload.input[0].text, "city pop, 105 BPM");
  assert.equal(payload.input[1].type, "text");
  assert.match(payload.input[1].text ?? "", /^Lyrics:\n/);
  assert.match(payload.input[1].text ?? "", /こんにちは/);
});

test("generateLyriaTrack: 默認模型 lyria-3.5；data URL 圖剝前綴取 mime", async () => {
  installFetchMock(() => ({
    status: 200,
    body: JSON.stringify({ steps: [{ model_output: { parts: [{ type: "audio", data: "AAECAw==" }] } }] }),
  }));
  await generateLyriaTrack({
    prompt: "epic trailer",
    imagesBase64: ["data:image/png;base64,iVBORw0KGgo=", "cGxhaW4="],
  });

  const payload = JSON.parse(String(mockCalls[0].init.body)) as {
    model: string;
    input: Array<{ type: string; mime_type?: string; data?: string }>;
  };
  assert.equal(payload.model, "lyria-3.5");
  const imageParts = payload.input.filter((p) => p.type === "image");
  assert.equal(imageParts.length, 2);
  assert.deepEqual(
    imageParts.map((p) => p.mime_type),
    ["image/png", "image/jpeg"], // data URL 取真 mime；裸 base64 默認 jpeg
  );
  assert.equal(imageParts[0].data, "iVBORw0KGgo=");
});

test("generateLyriaTrack: 無歌詞時 input 只有 style 單 text part", async () => {
  installFetchMock(() => ({
    status: 200,
    body: JSON.stringify({ steps: [{ model_output: { parts: [{ type: "audio", data: "AAECAw==" }] } }] }),
  }));
  await generateLyriaTrack({ prompt: "ambient" });
  const payload = JSON.parse(String(mockCalls[0].init.body)) as { input: Array<{ type: string }> };
  assert.equal(payload.input.length, 1);
  assert.equal(payload.input[0].type, "text");
});

// ── 常量守衛（快照：防止無聲漂移） ─────────────────────────────────────────────

test("常量快照：端點/模型映射/超時", () => {
  assert.equal(LYRIA_INTERACTIONS_URL, "https://generativelanguage.googleapis.com/v1beta/interactions");
  assert.deepEqual(LYRIA_MODELS, { full: "lyria-3.5", clip30: "lyria-3-clip-preview" });
  assert.equal(LYRIA_TIMEOUT_MS, 120_000);
});
