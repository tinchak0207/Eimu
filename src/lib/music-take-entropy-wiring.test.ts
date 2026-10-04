/**
 * music-take-entropy 接线测试（多版本偏好闸接进 music_gen 交付口，2026-10-03）。
 *
 * node:test + fetch mock（不真连上游、不真落盘）。覆盖本次 additive 改动的**行为**：
 *   1. 一次 FlowMusic 多 clips 回包（2 个 clip，metadata 几乎相同、时长接近）→ 回执带
 *      preference_question、其 asked===false、options 尾端两条退路、optionTakeUrls 键数
 *      === take 选项数。
 *   2. 2 个 metadata 明显相异的 clip → asked===true、options.length <= 4。
 *   3. 单 clip（audios.length===1）→ 回执不含 preference_question 键（既有形状零变化）。
 *   4. clips[].sound_prompt 真的被解析并逐候选带出（audios[0]/[1].sound_prompt 逐字等值）。
 *
 * 真源：src/lib/music-take-entropy.ts（熵决策层）、src/lib/music-flowmusic.ts（sound_prompt
 * 解析）、src/lib/music-tools.ts（audios[] additive 键 + preference_question 组装）。
 */

import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { musicGenTool } from "./music-tools.ts";
import { YUE2_MODAL_ENDPOINT_ENV, YUE2_HMAC_SECRET_ENV } from "./music-yue2.ts";

type MockResponse = { status: number; body: string; headers?: Record<string, string> };

let mockCalls: Array<{ url: string; init: RequestInit }> = [];
let mockResponder: (url: string) => MockResponse = () => ({ status: 500, body: "no responder" });

const originalFetch = globalThis.fetch;
const ENV_KEYS = [YUE2_MODAL_ENDPOINT_ENV, YUE2_HMAC_SECRET_ENV, "FLOWMUSIC2API_URL", "FLOWMUSIC2API_KEY", "GEMINI_API_KEY", "GEMINI_STUDIO_API_KEY"] as const;
const originalEnv = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]));

function installFetchMock(responder: (url: string) => MockResponse): void {
  mockCalls = [];
  mockResponder = responder;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : (url as Request).url;
    mockCalls.push({ url: urlStr, init: init ?? {} });
    const r = mockResponder(urlStr);
    return new Response(r.body, { status: r.status, headers: r.headers });
  }) as typeof fetch;
}

beforeEach(() => {
  delete process.env[YUE2_MODAL_ENDPOINT_ENV]; // 强制走 flowmusic2api
  process.env.FLOWMUSIC2API_URL = "http://127.0.0.1:8000";
  process.env.FLOWMUSIC2API_KEY = "test-key";
  delete process.env.GEMINI_API_KEY;
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

type Clip = { audio_url: string; audio: { format: string }; duration: number; title?: string; sound_prompt?: string };

/** 两 clips 的 FlowMusic 响应 mock（逐次上传序号；音频下载固定回假位元组）。 */
function flowMusicResponder(clips: Clip[]): (url: string) => MockResponse {
  let uploadSeq = 0;
  return (url: string): MockResponse => {
    if (url.includes("/internal/media/upload")) {
      uploadSeq += 1;
      return {
        status: 200,
        body: JSON.stringify({ ok: true, url: `https://store.example/image-data/files/uploads/music-${uploadSeq}.m4a` }),
      };
    }
    if (url.includes("/v1/chat/completions")) {
      return { status: 200, body: JSON.stringify({ clips }) };
    }
    if (url.includes("cdn.example")) {
      return { status: 200, body: "FAKEAUDIO", headers: { "content-type": "audio/mp4" } };
    }
    return { status: 404, body: `unexpected url ${url}` };
  };
}

const CONTEXT = { sessionId: "sess-entropy-1" };

type PreferenceQuestion = {
  asked: boolean;
  question: string;
  header: string;
  options: Array<{ label: string; description?: string }>;
  optionTakeUrls: Record<string, string>;
  fallbackLabels: { none: string; trustModel: string };
  entropy: { reason: string; normalizedEntropy: number; materialAxes: string[] };
  suggestedIndex: number;
};

/** 专案风格的窄化：断言在场并返回窄化后物件（缺键即 assertion 失败）。 */
function requirePreferenceQuestion(out: Record<string, unknown>): PreferenceQuestion {
  const pq = out.preference_question;
  assert.ok(pq && typeof pq === "object", `回执应带 preference_question，实际键：${Object.keys(out).join("、")}`);
  return pq as PreferenceQuestion;
}

// ── 1. 几乎一致的双 take：带卡但不问 ─────────────────────────────────────────

test("多 take 几乎一致（时长 179.53/174.62、标题相同）→ preference_question 在场、asked=false、尾端两条退路、optionTakeUrls 键数=take 选项数", async () => {
  installFetchMock(
    flowMusicResponder([
      { audio_url: "https://cdn.example/a.m4a", audio: { format: "m4a" }, duration: 179.53, title: "隐秘的折痕" },
      { audio_url: "https://cdn.example/b.m4a", audio: { format: "m4a" }, duration: 174.62, title: "隐秘的折痕" },
    ]),
  );
  const result = await musicGenTool.execute({ prompt: "city pop, 105 BPM" }, CONTEXT);
  const out = JSON.parse(result.output) as Record<string, unknown>;
  assert.equal(out.ok, true);
  assert.equal(out.channel, "flowmusic2api");

  const pq = requirePreferenceQuestion(out);
  assert.equal(pq.asked, false, `几乎一致的双 take 不该问，reason=${pq.entropy.reason}`);
  // 尾端两条退路逐字固定
  const tail = pq.options.slice(-2).map((o) => o.label);
  assert.deepEqual(tail, ["都不行，重写", "你替我定"]);
  assert.deepEqual(pq.options[pq.options.length - 1].label, pq.fallbackLabels.trustModel);
  // optionTakeUrls 只含 take 选项（不含退路）：键数 = options 去掉两条退路
  const takeOptionCount = pq.options.length - 2;
  assert.equal(Object.keys(pq.optionTakeUrls).length, takeOptionCount);
  // 每个 take 选项 label 都有 url 对照，且对照到真实 audios url
  const audios = out.audios as Array<{ url: string }>;
  for (const [label, url] of Object.entries(pq.optionTakeUrls)) {
    assert.ok(audios.some((a) => a.url === url), `label ${label} 的 url 应对应某个 audios 条目`);
  }
  // asked=false → suggestedIndex 是保守的 0
  assert.equal(pq.suggestedIndex, 0);
});

// ── 2. 明显相异的双 take：问 ─────────────────────────────────────────────────

test("多 take 明显相异（时长 90s/200s、标题不同、sound_prompt 无交集）→ asked=true、options.length<=4", async () => {
  installFetchMock(
    flowMusicResponder([
      { audio_url: "https://cdn.example/a.m4a", audio: { format: "m4a" }, duration: 90, title: "晨光", sound_prompt: "Alt-pop, Guzheng, 80 BPM" },
      { audio_url: "https://cdn.example/b.m4a", audio: { format: "m4a" }, duration: 200, title: "暗涌", sound_prompt: "Techno, Distorted bass, 140 BPM" },
    ]),
  );
  const result = await musicGenTool.execute({ prompt: "city pop, 105 BPM" }, CONTEXT);
  const out = JSON.parse(result.output) as Record<string, unknown>;
  assert.equal(out.ok, true);

  const pq = requirePreferenceQuestion(out);
  assert.equal(pq.asked, true, `明显相异应问，reason=${pq.entropy.reason}`);
  assert.ok(pq.options.length <= 4, `options 上限 4（含两条退路），实际 ${pq.options.length}`);
  assert.ok(pq.options.length >= 2, "至少要有 take 选项");
  // take 选项数上限 check（4 - 2 条退路）
  assert.ok(Object.keys(pq.optionTakeUrls).length <= 2);
  // 问题文案/分类标签在场且非空（简体）
  assert.ok(pq.question.length > 0 && pq.header.length > 0);
  assert.deepEqual(pq.options.slice(-2).map((o) => o.label), ["都不行，重写", "你替我定"]);
});

// ── 3. 单 clip：既有形状零变化 ───────────────────────────────────────────────

test("单 clip（audios.length===1）→ 回执不含 preference_question 键", async () => {
  installFetchMock(
    flowMusicResponder([
      { audio_url: "https://cdn.example/a.m4a", audio: { format: "m4a" }, duration: 150, title: "唯一" },
    ]),
  );
  const result = await musicGenTool.execute({ prompt: "city pop, 105 BPM" }, CONTEXT);
  const out = JSON.parse(result.output) as Record<string, unknown>;
  assert.equal(out.ok, true);
  assert.equal((out.audios as Array<unknown>).length, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(out, "preference_question"), false);
});

// ── 4. sound_prompt 真的被解析并逐候选带出 ───────────────────────────────────

test("clips[].sound_prompt 逐字解析：audios[0]/[1].sound_prompt 等于上游值（trim 后）", async () => {
  installFetchMock(
    flowMusicResponder([
      { audio_url: "https://cdn.example/a.m4a", audio: { format: "m4a" }, duration: 150, title: "Take A", sound_prompt: "Alt-pop, Guzheng" },
      { audio_url: "https://cdn.example/b.m4a", audio: { format: "m4a" }, duration: 148, sound_prompt: "Techno, Distorted bass" },
    ]),
  );
  const result = await musicGenTool.execute({ prompt: "city pop, 105 BPM" }, CONTEXT);
  const out = JSON.parse(result.output) as Record<string, unknown>;
  const audios = out.audios as Array<{ url: string; sound_prompt?: string; title?: string }>;
  assert.equal(audios.length, 2);
  assert.equal(audios[0].sound_prompt, "Alt-pop, Guzheng");
  assert.equal(audios[1].sound_prompt, "Techno, Distorted bass");
  // title 亦逐候选带出（有能力才带，缺省不带键）
  assert.equal(audios[0].title, "Take A");
  assert.equal(audios[1].title, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(audios[1], "title"), false);
});
