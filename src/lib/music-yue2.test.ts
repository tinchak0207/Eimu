/**
 * music-yue2.ts 测试（片 B：music_gen 第三通路，2026-09-18）。
 *
 * node:test + fetch mock（不真连）；覆盖：
 *   1. 冻结常量（env 名／模型 id／超时）与 enabled/disabled 判断
 *   2. HMAC 签名向量（独立来源：Python stdlib hmac，非本档产物）＋实送位元组一致性
 *   3. request body 形状（冻结合约栏位逐字、cot 合法性、abc 只在 full/melody、seed 整数）
 *   4. 非 2xx／ok≠true／缺 audio_b64／JSON 非法 → 带原文抛出（诚实铁律）
 *   5. 成功响应解析（含 artifacts 只留元信息、上游缺栏的如实回退）
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

// ── fetch mock 脚手架（同 music-lyria.test.ts 口径） ─────────────────────────

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

/** 冻结合约的成功响应（可逐栏覆写）。 */
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

// ── 1. 冻结契约常量与 enabled/disabled ───────────────────────────────────────

test("冻结常量：env 名／模型 id／超时逐字（部署片按此配 env）", () => {
  assert.equal(YUE2_MODAL_ENDPOINT_ENV, "YUE2_MODAL_ENDPOINT");
  assert.equal(YUE2_HMAC_SECRET_ENV, "YUE2_HMAC_SECRET");
  assert.equal(YUE2_MODEL_ID, "m-a-p/YuE2-3B");
  assert.equal(YUE2_TIMEOUT_MS, 600_000);
});

test("enabled：端点非空即启用，尾斜线与空白剥除", () => {
  assert.equal(yue2ModalUrl(), "https://yue2-modal.example");
  assert.equal(isYue2ModalEnabled(), true);
  process.env[YUE2_MODAL_ENDPOINT_ENV] = "  https://yue2-modal.example///  ";
  assert.equal(yue2ModalUrl(), "https://yue2-modal.example");
});

test("disabled：端点空／纯空白 → 停用，且生成前就报错不发请求", async () => {
  installFetchMock(() => ({ status: 200, body: successBody() }));
  for (const empty of ["", "   "]) {
    process.env[YUE2_MODAL_ENDPOINT_ENV] = empty;
    assert.equal(yue2ModalUrl(), null);
    assert.equal(isYue2ModalEnabled(), false);
    await assert.rejects(() => generateYue2Track({ ...BASE_OPTS }), /YUE2_MODAL_ENDPOINT 未配置/);
  }
  assert.equal(mockCalls.length, 0);
});

test("enabled 只看端点：缺密钥时 enabled 仍 true，但生成 fail-fast 且不发请求", async () => {
  installFetchMock(() => ({ status: 200, body: successBody() }));
  delete process.env[YUE2_HMAC_SECRET_ENV];
  assert.equal(isYue2ModalEnabled(), true);
  await assert.rejects(() => generateYue2Track({ ...BASE_OPTS }), /缺少 YUE2_HMAC_SECRET/);
  assert.equal(mockCalls.length, 0);
});

// ── 2. HMAC 签名向量 ─────────────────────────────────────────────────────────

test("HMAC 签名向量：hex hmac_sha256（独立来源 Python stdlib hmac）", () => {
  // hmac.new(b"key", b"The quick brown fox jumps over the lazy dog", sha256).hexdigest()
  assert.equal(
    signYue2Body("key", "The quick brown fox jumps over the lazy dog"),
    "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8",
  );
  // hmac.new(b"test-secret", <下面这串 body 位元组>, sha256).hexdigest()
  const body = '{"id":"yue2-test","style":"city pop, 105 BPM","lyrics":"","cot":"full"}';
  assert.equal(
    signYue2Body("test-secret", body),
    "c9781994b17bd2929289a388794a520238c602c13507b870f07fb8ec7a8f1e99",
  );
});

test("签名＝实送位元组：header 与 body 逐位元组对齐（header 名照冻结合约）", async () => {
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
  // 重新序列化会改变位元组（签名即失效）→ 签的必须就是送出的那串。
  assert.equal(signYue2Body(SECRET, JSON.stringify(JSON.parse(raw))), headers["X-Yue2-Signature"]);
});

// ── 3. request body 形状（冻结合约） ─────────────────────────────────────────

test("request body：栏位名逐字（id/style/lyrics/cot），选填栏缺省不出现", () => {
  const body = buildYue2RequestBody({ ...BASE_OPTS });
  assert.deepEqual(Object.keys(body).sort(), ["cot", "id", "lyrics", "style"]);
  assert.match(body.id, /^yue2-[0-9a-f-]{36}$/);
  assert.equal(body.style, "city pop, 105 BPM");
  assert.equal(body.lyrics, "");
  assert.equal(body.cot, "full");
});

test("cot 合法性：三模式全收，其余人话报错", () => {
  for (const cot of ["full", "melody", "off"] as const) {
    assert.equal(buildYue2RequestBody({ ...BASE_OPTS, cot }).cot, cot);
  }
  assert.throws(
    () => buildYue2RequestBody({ ...BASE_OPTS, cot: "fast" as unknown as "full" }),
    /cot 只接受 "full"\/"melody"\/"off"/,
  );
});

test("abc 只在 full/melody：cot=off 带 abc 直接报错（不静默丢栏位）", () => {
  const abc = "X:1\nT:tune\nK:C\nC D E|";
  assert.equal(buildYue2RequestBody({ ...BASE_OPTS, cot: "full", abc }).abc, abc);
  assert.equal(buildYue2RequestBody({ ...BASE_OPTS, cot: "melody", abc }).abc, abc);
  assert.throws(
    () => buildYue2RequestBody({ ...BASE_OPTS, cot: "off", abc }),
    /cot="off" 时上游不接受 abc/,
  );
});

test("seed 只收整数；style 空白报错；lyrics 非字串视为空歌词", () => {
  assert.equal(buildYue2RequestBody({ ...BASE_OPTS, seed: 7 }).seed, 7);
  assert.throws(() => buildYue2RequestBody({ ...BASE_OPTS, seed: 1.5 }), /seed 只接受整数/);
  assert.throws(() => buildYue2RequestBody({ ...BASE_OPTS, style: "   " }), /style 不能为空/);
  const noLyrics = buildYue2RequestBody({ ...BASE_OPTS, lyrics: undefined as unknown as string });
  assert.equal(noLyrics.lyrics, "");
});

// ── 4. 错误必带原文（诚实铁律） ──────────────────────────────────────────────

test("非 2xx：带 HTTP 状态＋上游 error/detail＋原文 body", async () => {
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

test("HTTP 200 但 ok:false：仍带原文抛出（不看状态码就当成功）", async () => {
  installFetchMock(() => ({ status: 200, body: '{"ok":false,"error":"bad_signature"}' }));
  await assert.rejects(
    () => generateYue2Track({ ...BASE_OPTS }),
    (e: Error) => /ok 不为 true/.test(e.message) && /bad_signature/.test(e.message) && /原文/.test(e.message),
  );
});

test("缺 audio_b64：报错并带原文（不伪造音频）", async () => {
  installFetchMock(() => ({ status: 200, body: successBody({ audio_b64: "" }) }));
  await assert.rejects(
    () => generateYue2Track({ ...BASE_OPTS }),
    (e: Error) => /缺少 audio_b64/.test(e.message) && /score_abc|X:1/.test(e.message),
  );
});

test("响应非 JSON：报错并带原文前 2000 字符", async () => {
  installFetchMock(() => ({ status: 200, body: "<html>502 bad gateway</html>" }));
  await assert.rejects(
    () => generateYue2Track({ ...BASE_OPTS }),
    (e: Error) => /不是合法 JSON/.test(e.message) && /502 bad gateway/.test(e.message),
  );
});

test("网络层失败：带端点与底层原因（不吞错）", async () => {
  installFetchMock(() => {
    throw new Error("connect ECONNREFUSED");
  });
  await assert.rejects(
    () => generateYue2Track({ ...BASE_OPTS }),
    (e: Error) => /网络层/.test(e.message) && /ECONNREFUSED/.test(e.message) && e.message.includes(ENDPOINT),
  );
});

// ── 5. 成功响应解析 ──────────────────────────────────────────────────────────

test("成功响应：白盒乐谱／时长／工件元信息入回执，audio_b64 位元组不进 artifacts", async () => {
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

test("上游缺栏的如实回退：mime 回契约预设、score_abc 缺→null、duration_s 缺→0、truncated 缺→null", async () => {
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

// ── 6. 扒谱 transcribeYue2Score（片 O：翻唱工作流前半段，2026-09-19）──────────

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

test("扒谱冻结常量：超时 120s（spec：超时 ≥120s）", () => {
  assert.equal(YUE2_TRANSCRIBE_TIMEOUT_MS, 120_000);
});

test("扒谱 body：audio_b64＋melody_only 两键逐字（melodyOnly 缺省不送）", () => {
  assert.deepEqual(JSON.parse(buildYue2TranscribeBody({ audioBase64: "QUJD" })), { audio_b64: "QUJD" });
  assert.deepEqual(JSON.parse(buildYue2TranscribeBody({ audioBase64: " QUJD ", melodyOnly: true })), {
    audio_b64: "QUJD",
    melody_only: true,
  });
});

test("扒谱成功：abc／warnings／source_duration_s 白名单解析＋同款 HMAC 签名与实送位元组一致", async () => {
  installFetchMock(() => ({ status: 200, body: transcribeSuccessBody() }));
  const out = await transcribeYue2Score({ audioBase64: "QUJD", melodyOnly: true });
  assert.equal(out.abc, "X:1\nK:G\nQ:4/4\nG4 A4 B4 c4|");
  assert.deepEqual(out.warnings, ["audio trimmed to 60s"]);
  assert.equal(out.sourceDurationSeconds, 54.841);
  // 请求形状：URL＝/transcribe、header 带 X-Yue2-Signature、签的是实送 raw body
  assert.equal(mockCalls.length, 1);
  assert.equal(mockCalls[0].url, TRANSCRIBE_ENDPOINT);
  const init = mockCalls[0].init;
  assert.equal(String(init.body), '{"audio_b64":"QUJD","melody_only":true}');
  const headers = init.headers as Record<string, string>;
  assert.equal(headers["X-Yue2-Signature"], signYue2Body(SECRET, String(init.body)));
});

test("扒谱 422 abc_missing：映射专属错误码（确定性失败勿重试）＋带原文", async () => {
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

test("扒谱其余失败面：非 2xx／ok≠true／缺 abc／网路层 → yue2_transcribe_failed 带原文", async () => {
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
  // ③ 200 但缺 abc（服务端违反契约＝扒不出乐谱，归 abc_missing 确定性失败面）
  installFetchMock(() => ({ status: 200, body: transcribeSuccessBody({ abc: "" }) }));
  await assert.rejects(
    () => transcribeYue2Score({ audioBase64: "QUJD" }),
    (e: unknown) => e instanceof Yue2TranscribeError && e.code === YUE2_TRANSCRIBE_ABC_MISSING_CODE && /缺少 abc/.test(e.message),
  );
  // ④ 网路层（隧道断线）
  installFetchMock(() => {
    throw new Error("fetch failed: tunnel is down");
  });
  await assert.rejects(
    () => transcribeYue2Score({ audioBase64: "QUJD" }),
    (e: unknown) =>
      e instanceof Yue2TranscribeError && e.code === YUE2_TRANSCRIBE_FAILED_CODE && /tunnel is down/.test(e.message),
  );
});

test("扒谱参数性防御：audioBase64 空 → 出门前抛（零请求）；端点未配置 → 同款报错", async () => {
  installFetchMock(() => ({ status: 200, body: transcribeSuccessBody() }));
  await assert.rejects(() => transcribeYue2Score({ audioBase64: "  " }), /audioBase64 不能为空/);
  process.env[YUE2_MODAL_ENDPOINT_ENV] = "";
  await assert.rejects(() => transcribeYue2Score({ audioBase64: "QUJD" }), /YUE2_MODAL_ENDPOINT 未配置/);
  assert.equal(mockCalls.length, 0);
});
