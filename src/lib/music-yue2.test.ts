/**
 * music-yue2.ts 測試（片 B：music_gen 第三通路，2026-09-18）。
 *
 * node:test + fetch mock（不真連）；覆蓋：
 *   1. 凍結常量（env 名／模型 id／超時）與 enabled/disabled 判斷
 *   2. HMAC 簽名向量（獨立來源：Python stdlib hmac，非本檔產物）＋實送位元組一致性
 *   3. request body 形狀（凍結合約欄位逐字、cot 合法性、abc 只在 full/melody、seed 整數）
 *   4. 非 2xx／ok≠true／缺 audio_b64／JSON 非法 → 帶原文拋出（誠實鐵律）
 *   5. 成功響應解析（含 artifacts 只留元信息、上游缺欄的如實回退）
 */

import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  YUE2_HMAC_SECRET_ENV,
  YUE2_MODAL_ENDPOINT_ENV,
  YUE2_MODEL_ID,
  YUE2_TIMEOUT_MS,
  buildYue2RequestBody,
  generateYue2Track,
  isYue2ModalEnabled,
  signYue2Body,
  yue2ModalUrl,
} from "./music-yue2.ts";

// ── fetch mock 腳手架（同 music-lyria.test.ts 口徑） ─────────────────────────

type MockResponse = { status: number; body: string; headers?: Record<string, string> };

let mockCalls: Array<{ url: string; init: RequestInit }> = [];
let mockResponder: (url: string, init: RequestInit) => MockResponse = () => ({ status: 500, body: "no responder" });

const originalFetch = globalThis.fetch;
const originalEndpoint = process.env[YUE2_MODAL_ENDPOINT_ENV];
const originalSecret = process.env[YUE2_HMAC_SECRET_ENV];

const ENDPOINT = "https://yue2-modal.example/generate";
const SECRET = "test-secret";

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

function restoreEnv(key: string, original: string | undefined): void {
  if (original === undefined) delete process.env[key];
  else process.env[key] = original;
}

beforeEach(() => {
  process.env[YUE2_MODAL_ENDPOINT_ENV] = "https://yue2-modal.example";
  process.env[YUE2_HMAC_SECRET_ENV] = SECRET;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEnv(YUE2_MODAL_ENDPOINT_ENV, originalEndpoint);
  restoreEnv(YUE2_HMAC_SECRET_ENV, originalSecret);
});

/** 凍結合約的成功響應（可逐欄覆寫）。 */
function successBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ok: true,
    audio_b64: "ZmxhYw==",
    audio_bytes: 5,
    audio_sha256: "a".repeat(64),
    mime_type: "audio/flac",
    sample_rate: 48000,
    channels: 2,
    duration_s: 123.45,
    score_abc: "X:1\nT:demo\nK:C\nC D E F|",
    truncated: { lyrics_chars: 900 },
    artifacts: [{ name: "score.abc", bytes: 42, sha256: "b".repeat(64), b64: "QUJD" }],
    timing: { model_load_ms: 1200, generate_ms: 45_000, rtf: 0.41 },
    model: YUE2_MODEL_ID,
    vae: "m-a-p/YuE2-Vae",
    gpu: "A100",
    ...overrides,
  });
}

const BASE_OPTS = { style: "city pop, 105 BPM", lyrics: "", cot: "full" } as const;

// ── 1. 凍結契約常量與 enabled/disabled ───────────────────────────────────────

test("凍結常量：env 名／模型 id／超時逐字（部署片按此配 env）", () => {
  assert.equal(YUE2_MODAL_ENDPOINT_ENV, "YUE2_MODAL_ENDPOINT");
  assert.equal(YUE2_HMAC_SECRET_ENV, "YUE2_HMAC_SECRET");
  assert.equal(YUE2_MODEL_ID, "m-a-p/YuE2-3B");
  assert.equal(YUE2_TIMEOUT_MS, 600_000);
});

test("enabled：端點非空即啟用，尾斜線與空白剝除", () => {
  assert.equal(yue2ModalUrl(), "https://yue2-modal.example");
  assert.equal(isYue2ModalEnabled(), true);
  process.env[YUE2_MODAL_ENDPOINT_ENV] = "  https://yue2-modal.example///  ";
  assert.equal(yue2ModalUrl(), "https://yue2-modal.example");
});

test("disabled：端點空／純空白 → 停用，且生成前就報錯不發請求", async () => {
  installFetchMock(() => ({ status: 200, body: successBody() }));
  for (const empty of ["", "   "]) {
    process.env[YUE2_MODAL_ENDPOINT_ENV] = empty;
    assert.equal(yue2ModalUrl(), null);
    assert.equal(isYue2ModalEnabled(), false);
    await assert.rejects(() => generateYue2Track({ ...BASE_OPTS }), /YUE2_MODAL_ENDPOINT 未配置/);
  }
  assert.equal(mockCalls.length, 0);
});

test("enabled 只看端點：缺密鑰時 enabled 仍 true，但生成 fail-fast 且不發請求", async () => {
  installFetchMock(() => ({ status: 200, body: successBody() }));
  delete process.env[YUE2_HMAC_SECRET_ENV];
  assert.equal(isYue2ModalEnabled(), true);
  await assert.rejects(() => generateYue2Track({ ...BASE_OPTS }), /缺少 YUE2_HMAC_SECRET/);
  assert.equal(mockCalls.length, 0);
});

// ── 2. HMAC 簽名向量 ─────────────────────────────────────────────────────────

test("HMAC 簽名向量：hex hmac_sha256（獨立來源 Python stdlib hmac）", () => {
  // hmac.new(b"key", b"The quick brown fox jumps over the lazy dog", sha256).hexdigest()
  assert.equal(
    signYue2Body("key", "The quick brown fox jumps over the lazy dog"),
    "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8",
  );
  // hmac.new(b"test-secret", <下面這串 body 位元組>, sha256).hexdigest()
  const body = '{"id":"yue2-test","style":"city pop, 105 BPM","lyrics":"","cot":"full"}';
  assert.equal(
    signYue2Body("test-secret", body),
    "c9781994b17bd2929289a388794a520238c602c13507b870f07fb8ec7a8f1e99",
  );
});

test("簽名＝實送位元組：header 與 body 逐位元組對齊（header 名照凍結合約）", async () => {
  installFetchMock(() => ({ status: 200, body: successBody() }));
  await generateYue2Track({ ...BASE_OPTS, lyrics: "[Verse]\n霓虹灯下" });
  assert.equal(mockCalls.length, 1);
  const { url, init } = mockCalls[0];
  assert.equal(url, ENDPOINT);
  assert.equal(init.method, "POST");
  const headers = init.headers as Record<string, string>;
  const raw = String(init.body);
  assert.match(headers["X-Yue2-Signature"], /^[0-9a-f]{64}$/);
  assert.equal(headers["X-Yue2-Signature"], signYue2Body(SECRET, raw));
  assert.equal(headers["Content-Type"], "application/json");
  // 重新序列化會改變位元組（簽名即失效）→ 簽的必須就是送出的那串。
  assert.equal(signYue2Body(SECRET, JSON.stringify(JSON.parse(raw))), headers["X-Yue2-Signature"]);
});

// ── 3. request body 形狀（凍結合約） ─────────────────────────────────────────

test("request body：欄位名逐字（id/style/lyrics/cot），選填欄缺省不出現", () => {
  const body = buildYue2RequestBody({ ...BASE_OPTS });
  assert.deepEqual(Object.keys(body).sort(), ["cot", "id", "lyrics", "style"]);
  assert.match(body.id, /^yue2-[0-9a-f-]{36}$/);
  assert.equal(body.style, "city pop, 105 BPM");
  assert.equal(body.lyrics, "");
  assert.equal(body.cot, "full");
});

test("cot 合法性：三模式全收，其餘人話報錯", () => {
  for (const cot of ["full", "melody", "off"] as const) {
    assert.equal(buildYue2RequestBody({ ...BASE_OPTS, cot }).cot, cot);
  }
  assert.throws(
    () => buildYue2RequestBody({ ...BASE_OPTS, cot: "fast" as unknown as "full" }),
    /cot 只接受 "full"\/"melody"\/"off"/,
  );
});

test("abc 只在 full/melody：cot=off 帶 abc 直接報錯（不靜默丟欄位）", () => {
  const abc = "X:1\nT:tune\nK:C\nC D E|";
  assert.equal(buildYue2RequestBody({ ...BASE_OPTS, cot: "full", abc }).abc, abc);
  assert.equal(buildYue2RequestBody({ ...BASE_OPTS, cot: "melody", abc }).abc, abc);
  assert.throws(
    () => buildYue2RequestBody({ ...BASE_OPTS, cot: "off", abc }),
    /cot="off" 时上游不接受 abc/,
  );
});

test("seed 只收整數；style 空白報錯；lyrics 非字串視為空歌詞", () => {
  assert.equal(buildYue2RequestBody({ ...BASE_OPTS, seed: 7 }).seed, 7);
  assert.throws(() => buildYue2RequestBody({ ...BASE_OPTS, seed: 1.5 }), /seed 只接受整数/);
  assert.throws(() => buildYue2RequestBody({ ...BASE_OPTS, style: "   " }), /style 不能为空/);
  const noLyrics = buildYue2RequestBody({ ...BASE_OPTS, lyrics: undefined as unknown as string });
  assert.equal(noLyrics.lyrics, "");
});

// ── 4. 錯誤必帶原文（誠實鐵律） ──────────────────────────────────────────────

test("非 2xx：帶 HTTP 狀態＋上游 error/detail＋原文 body", async () => {
  installFetchMock(() => ({
    status: 500,
    body: '{"ok":false,"error":"cuda_oom","detail":"model load failed on A100"}',
  }));
  await assert.rejects(
    () => generateYue2Track({ ...BASE_OPTS }),
    (e: Error) =>
      /HTTP 500/.test(e.message) &&
      /cuda_oom/.test(e.message) &&
      /model load failed on A100/.test(e.message) &&
      /原文 body/.test(e.message),
  );
});

test("HTTP 200 但 ok:false：仍帶原文拋出（不看狀態碼就當成功）", async () => {
  installFetchMock(() => ({ status: 200, body: '{"ok":false,"error":"bad_signature"}' }));
  await assert.rejects(
    () => generateYue2Track({ ...BASE_OPTS }),
    (e: Error) => /ok 不为 true/.test(e.message) && /bad_signature/.test(e.message) && /原文/.test(e.message),
  );
});

test("缺 audio_b64：報錯並帶原文（不偽造音頻）", async () => {
  installFetchMock(() => ({ status: 200, body: successBody({ audio_b64: "" }) }));
  await assert.rejects(
    () => generateYue2Track({ ...BASE_OPTS }),
    (e: Error) => /缺少 audio_b64/.test(e.message) && /score_abc|X:1/.test(e.message),
  );
});

test("響應非 JSON：報錯並帶原文前 2000 字符", async () => {
  installFetchMock(() => ({ status: 200, body: "<html>502 bad gateway</html>" }));
  await assert.rejects(
    () => generateYue2Track({ ...BASE_OPTS }),
    (e: Error) => /不是合法 JSON/.test(e.message) && /502 bad gateway/.test(e.message),
  );
});

test("網絡層失敗：帶端點與底層原因（不吞錯）", async () => {
  installFetchMock(() => {
    throw new Error("connect ECONNREFUSED");
  });
  await assert.rejects(
    () => generateYue2Track({ ...BASE_OPTS }),
    (e: Error) => /网络层/.test(e.message) && /ECONNREFUSED/.test(e.message) && e.message.includes(ENDPOINT),
  );
});

// ── 5. 成功響應解析 ──────────────────────────────────────────────────────────

test("成功響應：白盒樂譜／時長／工件元信息入回執，audio_b64 位元組不進 artifacts", async () => {
  installFetchMock(() => ({ status: 200, body: successBody() }));
  const out = await generateYue2Track({ ...BASE_OPTS });
  assert.equal(out.audioBase64, "ZmxhYw==");
  assert.equal(out.mimeType, "audio/flac");
  assert.equal(out.scoreAbc, "X:1\nT:demo\nK:C\nC D E F|");
  assert.deepEqual(out.truncated, { lyrics_chars: 900 });
  assert.equal(out.durationSeconds, 123.45);
  assert.equal(out.upstreamUrl, null);
  assert.equal(out.audioSha256, "a".repeat(64));
  assert.equal(out.model, YUE2_MODEL_ID);
  assert.deepEqual(out.artifacts, [{ name: "score.abc", bytes: 42, sha256: "b".repeat(64) }]);
  assert.equal(Object.prototype.hasOwnProperty.call(out.artifacts[0], "b64"), false);
});

test("上游缺欄的如實回退：mime 回契約預設、score_abc 缺→null、duration_s 缺→0、truncated 缺→null", async () => {
  installFetchMock(() => ({
    status: 200,
    body: successBody({
      mime_type: undefined,
      score_abc: null,
      duration_s: undefined,
      truncated: undefined,
      artifacts: undefined,
    }),
  }));
  const out = await generateYue2Track({ ...BASE_OPTS });
  assert.equal(out.mimeType, "audio/flac");
  assert.equal(out.scoreAbc, null);
  assert.equal(out.durationSeconds, 0);
  assert.equal(out.truncated, null);
  assert.deepEqual(out.artifacts, []);
});

// ── 6. 扒譜 transcribeYue2Score（片 O：翻唱工作流前半段，2026-09-19）──────────

import {
  YUE2_TRANSCRIBE_ABC_MISSING_CODE,
  YUE2_TRANSCRIBE_FAILED_CODE,
  YUE2_TRANSCRIBE_TIMEOUT_MS,
  Yue2TranscribeError,
  buildYue2TranscribeBody,
  transcribeYue2Score,
} from "./music-yue2.ts";

const TRANSCRIBE_ENDPOINT = "https://yue2-modal.example/transcribe";

function transcribeSuccessBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ok: true,
    abc: "X:1\nK:G\nQ:4/4\nG4 A4 B4 c4|",
    warnings: ["audio trimmed to 60s"],
    source_duration_s: 54.841,
    abc_sha256: "c".repeat(64),
    abc_measures: 24,
    melody_only: true,
    timing: { model_load_ms: 4500, transcribe_ms: 16000, total_ms: 21000 },
    model: "m-a-p/SheetSage2",
    gpu: "RTX 5070",
    ...overrides,
  });
}

test("扒譜凍結常量：超時 120s（spec：超時 ≥120s）", () => {
  assert.equal(YUE2_TRANSCRIBE_TIMEOUT_MS, 120_000);
});

test("扒譜 body：audio_b64＋melody_only 兩鍵逐字（melodyOnly 缺省不送）", () => {
  assert.deepEqual(JSON.parse(buildYue2TranscribeBody({ audioBase64: "QUJD" })), { audio_b64: "QUJD" });
  assert.deepEqual(JSON.parse(buildYue2TranscribeBody({ audioBase64: " QUJD ", melodyOnly: true })), {
    audio_b64: "QUJD",
    melody_only: true,
  });
});

test("扒譜成功：abc／warnings／source_duration_s 白名單解析＋同款 HMAC 簽名與實送位元組一致", async () => {
  installFetchMock(() => ({ status: 200, body: transcribeSuccessBody() }));
  const out = await transcribeYue2Score({ audioBase64: "QUJD", melodyOnly: true });
  assert.equal(out.abc, "X:1\nK:G\nQ:4/4\nG4 A4 B4 c4|");
  assert.deepEqual(out.warnings, ["audio trimmed to 60s"]);
  assert.equal(out.sourceDurationSeconds, 54.841);
  // 請求形狀：URL＝/transcribe、header 帶 X-Yue2-Signature、簽的是實送 raw body
  assert.equal(mockCalls.length, 1);
  assert.equal(mockCalls[0].url, TRANSCRIBE_ENDPOINT);
  const init = mockCalls[0].init;
  assert.equal(String(init.body), '{"audio_b64":"QUJD","melody_only":true}');
  const headers = init.headers as Record<string, string>;
  assert.equal(headers["X-Yue2-Signature"], signYue2Body(SECRET, String(init.body)));
});

test("扒譜 422 abc_missing：映射專屬錯誤碼（確定性失敗勿重試）＋帶原文", async () => {
  installFetchMock(() => ({
    status: 422,
    body: JSON.stringify({ ok: false, error: "abc_missing", detail: "no melody found in audio" }),
  }));
  await assert.rejects(
    () => transcribeYue2Score({ audioBase64: "QUJD" }),
    (e: unknown) =>
      e instanceof Yue2TranscribeError &&
      e.code === YUE2_TRANSCRIBE_ABC_MISSING_CODE &&
      e.status === 422 &&
      /HTTP 422/.test(e.message) && /abc_missing/.test(e.message),
  );
});

test("扒譜其餘失敗面：非 2xx／ok≠true／缺 abc／網路層 → yue2_transcribe_failed 帶原文", async () => {
  // ① 非 2xx（500）
  installFetchMock(() => ({ status: 500, body: JSON.stringify({ ok: false, error: "generation_error" }) }));
  await assert.rejects(
    () => transcribeYue2Score({ audioBase64: "QUJD" }),
    (e: unknown) => e instanceof Yue2TranscribeError && e.code === YUE2_TRANSCRIBE_FAILED_CODE && e.status === 500,
  );
  // ② ok≠true（HTTP 200）
  installFetchMock(() => ({ status: 200, body: JSON.stringify({ ok: false, error: "bad" }) }));
  await assert.rejects(
    () => transcribeYue2Score({ audioBase64: "QUJD" }),
    (e: unknown) => e instanceof Yue2TranscribeError && e.code === YUE2_TRANSCRIBE_FAILED_CODE && /ok 不为 true/.test(e.message),
  );
  // ③ 200 但缺 abc（服務端違反契約＝扒不出樂譜，歸 abc_missing 確定性失敗面）
  installFetchMock(() => ({ status: 200, body: transcribeSuccessBody({ abc: "" }) }));
  await assert.rejects(
    () => transcribeYue2Score({ audioBase64: "QUJD" }),
    (e: unknown) => e instanceof Yue2TranscribeError && e.code === YUE2_TRANSCRIBE_ABC_MISSING_CODE && /缺少 abc/.test(e.message),
  );
  // ④ 網路層（隧道斷線）
  installFetchMock(() => {
    throw new Error("fetch failed: tunnel is down");
  });
  await assert.rejects(
    () => transcribeYue2Score({ audioBase64: "QUJD" }),
    (e: unknown) =>
      e instanceof Yue2TranscribeError && e.code === YUE2_TRANSCRIBE_FAILED_CODE && /tunnel is down/.test(e.message),
  );
});

test("扒譜參數性防禦：audioBase64 空 → 出門前拋（零請求）；端點未配置 → 同款報錯", async () => {
  installFetchMock(() => ({ status: 200, body: transcribeSuccessBody() }));
  await assert.rejects(() => transcribeYue2Score({ audioBase64: "  " }), /audioBase64 不能为空/);
  process.env[YUE2_MODAL_ENDPOINT_ENV] = "";
  await assert.rejects(() => transcribeYue2Score({ audioBase64: "QUJD" }), /YUE2_MODAL_ENDPOINT 未配置/);
  assert.equal(mockCalls.length, 0);
});
