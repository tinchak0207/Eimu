/**
 * music-lyria.ts 測試（MOE Wave1 片B，2026-09-08；2026-10-02 generateContent 契約換血）。
 *
 * node:test + fetch mock（不真連）；覆蓋：
 *   1. prompt 組裝快照（buildLyriaStylePrompt 確定性拼接）
 *   2. key 選擇：有 GEMINI_STUDIO_API_KEY → lyria-3.5 generateContent；
 *      無 → Vertex lyria-002 降級（degraded:true）
 *   3. 非 2xx 錯誤帶原文 body 拋出（誠實鐵律）
 *   4. 響應解析：candidates/inlineData 提取、legacy inline_data 兼容、無音頻塊報錯
 *   5. 請求形狀：POST models/<model>:generateContent、x-goog-api-key header、
 *      contents[0].parts（lyrics 分離 text part）、圖片 inlineData（data URL 剝前綴）、>10 張圖拒絕
 *   6. Vertex lyria-002 雙 RIFF 頭剝除
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

// ── fetch mock 腳手架 ────────────────────────────────────────────────────────

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

// ── 2. key 選擇 / fail-fast ──────────────────────────────────────────────────

test("requireGeminiStudioApiKey: 缺 key 人話報錯（fail-fast）", () => {
  delete process.env.GEMINI_STUDIO_API_KEY;
  assert.throws(() => requireGeminiStudioApiKey(), /GEMINI_STUDIO_API_KEY 未配置/);
});

test("requireGeminiStudioApiKey: 空白字串 key 視為缺失", () => {
  process.env.GEMINI_STUDIO_API_KEY = "   ";
  assert.throws(() => requireGeminiStudioApiKey(), /GEMINI_STUDIO_API_KEY 未配置/);
});

test("hasGeminiStudioApiKey: 有/無 key 判準", () => {
  assert.equal(hasGeminiStudioApiKey(), true);
  delete process.env.GEMINI_STUDIO_API_KEY;
  assert.equal(hasGeminiStudioApiKey(), false);
});

test("generateLyriaTrack: 兩把 key 皆缺 → 拋且不發請求", async () => {
  delete process.env.GEMINI_STUDIO_API_KEY;
  delete process.env.GEMINI_API_KEY;
  await assert.rejects(() => generateLyriaTrack({ prompt: "ambient piano" }), /GEMINI_API_KEY 未配置/);
  assert.equal(mockCalls.length, 0);
});

// ── 3. 錯誤帶原文（誠實鐵律） ─────────────────────────────────────────────────

test("generateLyriaTrack: 非 2xx 帶原文 body 拋出（studio 路徑）", async () => {
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

test("extractLyriaOutput: legacy steps/inline_data 形狀兼容 + 缺 mime 默認 audio/mpeg", () => {
  const out = extractLyriaOutput({
    steps: [{ model_output: { inline_data: { data: "WUJDSFQ=" } } }],
  });
  assert.equal(out.audioBase64, "WUJDSFQ=");
  assert.equal(out.mimeType, "audio/mpeg");
  assert.equal(out.lyricsEcho, undefined);
});

test("extractLyriaOutput: 無音頻塊帶原文摘錄拋錯", () => {
  assert.throws(
    () => extractLyriaOutput({ candidates: [{ content: { parts: [{ text: "no audio" }] } }] }),
    (e: Error) => {
      assert.match(e.message, /未找到音頻塊/);
      assert.match(e.message, /no audio/);
      return true;
    },
  );
});

// ── 5. 請求形狀 ──────────────────────────────────────────────────────────────

test("generateLyriaTrack: 端點/header/model/lyrics 分離 parts 請求形狀（studio）", async () => {
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
  assert.equal(parts.length, 2); // style text + lyrics text，無圖
  assert.equal(parts[0].text, "city pop, 105 BPM");
  assert.match(parts[1].text ?? "", /^Lyrics:\n/);
  assert.match(parts[1].text ?? "", /こんにちは/);
  assert.equal(res.backend, "gemini_studio");
  assert.equal(res.effectiveModel, "lyria-3-clip-preview");
});

test("generateLyriaTrack: 默認模型 lyria-3.5；data URL 圖剝前綴取 mime（inlineData）", async () => {
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
    ["image/png", "image/jpeg"], // data URL 取真 mime；裸 base64 默認 jpeg
  );
  assert.equal(imageParts[0].inlineData?.data, "iVBORw0KGgo=");
});

test("generateLyriaTrack: 無歌詞時只有 style 單 text part", async () => {
  installFetchMock(() => ({
    status: 200,
    body: JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/mpeg", data: "AAECAw==" } }] } }] }),
  }));
  await generateLyriaTrack({ prompt: "ambient" });
  const payload = JSON.parse(String(mockCalls[0].init.body)) as { contents: Array<{ parts: Array<{ text?: string }> }> };
  assert.equal(payload.contents[0].parts.length, 1);
  assert.equal(payload.contents[0].parts[0].text, "ambient");
});

// ── 6. Vertex 降級 ───────────────────────────────────────────────────────────

/** 造一個「外層 44-byte RIFF 包住內層完整 WAV」的雙頭樣本。 */
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
  outer.writeUInt32LE(2 * innerFull.length, 4); // 實測到的錯誤：外層 size 被算成兩倍
  outer.write("WAVE", 8, "ascii");
  outer.write("fmt ", 12, "ascii");
  outer.writeUInt32LE(16, 16);
  outer.write("data", 36, "ascii");
  outer.writeUInt32LE(2 * innerFull.length, 40);
  return Buffer.concat([outer, innerFull]);
}

test("generateLyriaTrack: 無 studio key 但有 AQ. vertex key → Vertex lyria-002，degraded + 剝雙 RIFF 頭", async () => {
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
  // 剝掉外層 44-byte 頭後＝內層完整 WAV（RIFF 開頭、長度＝innerFull）
  const stripped = Buffer.from(res.audioBase64, "base64");
  assert.equal(stripped.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(stripped.length, 44 + innerAudio.length);
  assert.equal(stripped.subarray(44, 52).equals(innerAudio), true);
});

// ── 常量守衛（快照：防止無聲漂移） ─────────────────────────────────────────────

test("常量快照：端點/模型映射/超時", () => {
  assert.equal(LYRIA_API_BASE_URL, "https://generativelanguage.googleapis.com/v1beta");
  assert.deepEqual(LYRIA_MODELS, { full: "lyria-3.5", clip30: "lyria-3-clip-preview" });
  assert.equal(LYRIA_TIMEOUT_MS, 120_000);
  assert.equal(LYRIA_VERTEX_MODEL, "lyria-002");
  assert.equal(LYRIA_VERTEX_TIMEOUT_MS, 150_000);
});
