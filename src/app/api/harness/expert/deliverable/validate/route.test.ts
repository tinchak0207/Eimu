// POST /api/harness/expert/deliverable/validate 的真行为测试。
//
// 验的是「route 真的跑契约校验」而不是「route 存在」：
//   · 未带密钥 → 401（正负对照：带密钥才进下一关）。
//   · 正向控制：栏位齐 + 签名正确的 video-director 交付物 → 200 ok:true errors:[]。
//   · 缺契约必填栏位 → ok:false 且 errors 指名该栏；空字串值同样算缺（非空判据）。
//   · 签名被篡改 → ok:false 且 errors 指到签名；qc_signature 回重算出的正确值。
//   · 未知 expert_id → 400；payload 非物件 → 400（body 白名单）。
//   · 棘轮：只跑 validateExpertDeliverable 会过的输入（payload 非空但缺 requiredFields）
//     在 route 层必须红——防「必填栏位检查被拿掉」。

process.env.NODE_ENV = "test"; // 无物件储存后端时允许记忆体降级（blob-backend 既有契约）

import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

import { hashBizApiKey } from "@/lib/biz-api-keys";
import { __resetBizKeyStoreForTests } from "@/lib/biz-api-key-store";
import {
  computeQcSignature,
  validateExpertDeliverable,
  type ExpertDeliverable,
  type ExpertId,
  type ExpertTaskContract,
} from "@/lib/expert-contract";
import { POST } from "./route";

const VALID_KEY = `sk-biz-${"a1b2c3d4e5f60718".repeat(2)}`;
const VALID_USER_ID = 9201;

function reset() {
  delete process.env.GENERATION_DATABASE_URL;
  delete process.env.DATABASE_URL;
  process.env.BIZ_API_KEY_HASHES = `${hashBizApiKey(VALID_KEY)}:${VALID_USER_ID}`;
  __resetBizKeyStoreForTests();
}

function req(init: { headers?: Record<string, string>; body?: unknown; raw?: string } = {}): NextRequest {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return new NextRequest("http://localhost/api/harness/expert/deliverable/validate", {
    method: "POST",
    headers,
    body: init.raw ?? JSON.stringify(init.body ?? {}),
  });
}

async function bodyOf(response: Response) {
  return (await response.json()) as {
    ok?: boolean;
    errors?: string[];
    qc_signature?: string;
    error?: { message: string; type: string; code: string };
  };
}

const AUTH = { authorization: `Bearer ${VALID_KEY}` };

interface RouteInput {
  expert_id: ExpertId;
  kind: string;
  payload: Record<string, unknown>;
  evidence?: ExpertDeliverable["evidence"];
  contract?: ExpertTaskContract;
}

/** 对路由输入用真源函式现算签名（不是硬编码魔法值），并补上 qc_signature。 */
function withSignature(input: RouteInput) {
  const qc_signature = computeQcSignature({
    expertId: input.expert_id,
    kind: input.kind,
    payload: input.payload,
    evidence: input.evidence ?? {},
    contract:
      input.contract ?? { expertId: input.expert_id, intent: "起一个镜头", materials: [], acceptance: ["可核验"] },
  });
  return { ...input, qc_signature };
}

/** video-director 的合格 payload（契约 requiredFields＝shots / duration_sec / model_hint / qc）。 */
const VIDEO_PAYLOAD: Record<string, unknown> = {
  shots: ["开场海面", "镜头缓推"],
  duration_sec: 12,
  model_hint: "video-model-x",
  qc: "逐镜检查通过，无空壳栏位",
};
const VIDEO_EVIDENCE: ExpertDeliverable["evidence"] = { url: "https://cdn.example/final.mp4" };

function videoInput(payload: Record<string, unknown> = VIDEO_PAYLOAD) {
  return withSignature({
    expert_id: "video-director",
    kind: "video_shots",
    payload,
    evidence: VIDEO_EVIDENCE,
  });
}

test.beforeEach(reset);
test.after(() => {
  delete process.env.BIZ_API_KEY_HASHES;
  __resetBizKeyStoreForTests();
});

test("未带密钥：401，错误体是 authentication_error / missing_api_key", async () => {
  const response = await POST(req({ body: videoInput() }));
  assert.equal(response.status, 401);
  const payload = await bodyOf(response);
  assert.equal(payload.error?.type, "authentication_error");
  assert.equal(payload.error?.code, "missing_api_key");
  assert.ok(payload.error?.message, "错误讯息不能为空");
});

test("正向控制：栏位齐 + 签名正确的 video-director 交付物 → 200 ok:true errors:[]", async () => {
  const body = videoInput();
  const response = await POST(req({ headers: AUTH, body }));
  assert.equal(response.status, 200);
  const payload = await bodyOf(response);
  assert.equal(payload.ok, true, `errors=${JSON.stringify(payload.errors)}`);
  assert.deepEqual(payload.errors, []);
  assert.equal(payload.qc_signature, body.qc_signature, "qc_signature 必须等于原签章（同输入同签章）");
});

test("缺 duration_sec：ok:false 且 errors 指名该契约必填栏", async () => {
  const { duration_sec: _drop, ...rest } = VIDEO_PAYLOAD;
  const response = await POST(req({ headers: AUTH, body: videoInput(rest) }));
  assert.equal(response.status, 200);
  const payload = await bodyOf(response);
  assert.equal(payload.ok, false);
  // 签名是对「缺 duration_sec 的 payload」现算的 → 相符；故只剩必填栏位这一条错。
  assert.equal(payload.errors?.length, 1, `errors=${JSON.stringify(payload.errors)}`);
  assert.match(payload.errors![0], /duration_sec/, "errors 必须指名 duration_sec");
  assert.match(payload.errors![0], /契约必填栏位/);
});

test("duration_sec 是空字串：同样算缺（非空值判据，不是有栏位就算）", async () => {
  const response = await POST(
    req({ headers: AUTH, body: videoInput({ ...VIDEO_PAYLOAD, duration_sec: "" }) }),
  );
  assert.equal(response.status, 200);
  const payload = await bodyOf(response);
  assert.equal(payload.ok, false);
  assert.equal(payload.errors?.length, 1, `errors=${JSON.stringify(payload.errors)}`);
  assert.match(payload.errors![0], /duration_sec/, "空字串必须算缺并指名该栏");
  assert.match(payload.errors![0], /空字符串/, "错误讯息必须说明空字串算缺");
});

test("payload 栏位齐但 qc_signature 不匹配：ok:false 且 errors 指到签名，qc_signature 回正确期望值", async () => {
  const body = { ...videoInput(), qc_signature: "0".repeat(64) };
  const response = await POST(req({ headers: AUTH, body }));
  assert.equal(response.status, 200);
  const payload = await bodyOf(response);
  assert.equal(payload.ok, false);
  assert.equal(payload.errors?.length, 1, `errors=${JSON.stringify(payload.errors)}`);
  assert.match(payload.errors![0], /qcSignature/, "errors 必须指到 qcSignature");

  const correct = computeQcSignature({
    expertId: "video-director",
    kind: "video_shots",
    payload: VIDEO_PAYLOAD,
    evidence: VIDEO_EVIDENCE,
    contract: { expertId: "video-director", intent: "起一个镜头", materials: [], acceptance: ["可核验"] },
  });
  assert.equal(payload.qc_signature, correct, "qc_signature 必须是重算出的正确期望值");
  assert.notEqual(payload.qc_signature, "0".repeat(64));
});

test("回包带 qc_signature 且等于 computeQcSignature（呼叫方可自我修正）", async () => {
  const body = videoInput();
  const response = await POST(req({ headers: AUTH, body }));
  const payload = await bodyOf(response);
  const expected = computeQcSignature({
    expertId: "video-director",
    kind: "video_shots",
    payload: VIDEO_PAYLOAD,
    evidence: VIDEO_EVIDENCE,
    contract: { expertId: "video-director", intent: "起一个镜头", materials: [], acceptance: ["可核验"] },
  });
  assert.equal(payload.qc_signature, expected);
  assert.equal(payload.qc_signature, body.qc_signature);
});

test("棘轮：只过 validateExpertDeliverable、缺契约必填栏位的输入在 route 层必须红", async () => {
  // payload 非空（validate 层会过）但缺 shots/duration_sec/model_hint/qc。
  const payload = { note: "看起来有内容，但没有契约要求的任何栏位" };
  const body = videoInput(payload);

  // 正向对照：只跑 validateExpertDeliverable 时，这份输入是「过」的。
  const mapped: ExpertDeliverable = {
    expertId: "video-director",
    kind: "video_shots",
    payload,
    evidence: VIDEO_EVIDENCE,
    qcSignature: body.qc_signature,
    contract: { expertId: "video-director", intent: "起一个镜头", materials: [], acceptance: ["可核验"] },
  };
  assert.equal(
    validateExpertDeliverable(mapped).ok,
    true,
    "前提：validateExpertDeliverable 对这份输入会放行（否则棘轮测不到必填栏位检查）",
  );

  // route 必须因为「该域契约必填栏位」检查而红——把这条检查拿掉，本断言即失败。
  const response = await POST(req({ headers: AUTH, body }));
  assert.equal(response.status, 200);
  const result = await bodyOf(response);
  assert.equal(result.ok, false, "route 不得只靠 validateExpertDeliverable 放行——必填栏位检查被拿掉");
  assert.ok(
    result.errors!.some((message) => /契约必填栏位/.test(message)),
    `errors 必须含契约必填栏位这条：${JSON.stringify(result.errors)}`,
  );
  for (const field of ["shots", "duration_sec", "model_hint", "qc"]) {
    assert.ok(
      result.errors!.some((message) => message.includes(field)),
      `缺栏清单必须点名 ${field}：${JSON.stringify(result.errors)}`,
    );
  }
});

test("未知 expert_id：400 invalid_expert_id（不跑校验）", async () => {
  const response = await POST(req({ headers: AUTH, body: { expert_id: "not-an-expert", kind: "x", payload: {} } }));
  assert.equal(response.status, 400);
  const payload = await bodyOf(response);
  assert.equal(payload.error?.type, "invalid_request_error");
  assert.equal(payload.error?.code, "invalid_expert_id");
});

test("payload 非物件：400 invalid_payload", async () => {
  const response = await POST(req({ headers: AUTH, body: { expert_id: "music", kind: "music_track", payload: "not-an-object" } }));
  assert.equal(response.status, 400);
  assert.equal((await bodyOf(response)).error?.code, "invalid_payload");
});

test("坏 JSON：400 invalid_json（不抛 500）", async () => {
  const response = await POST(req({ headers: AUTH, raw: '{"expert_id":' }));
  assert.equal(response.status, 400);
  assert.equal((await bodyOf(response)).error?.code, "invalid_json");
});

// ── evidence 键名相容层棘轮（2026-10-03 对外契约缺陷：inputSchema 宣告 snake_case，
//    底层 ExpertDeliverable.evidence 是 camelCase；不映射＝外部 agent 照工具说明书必失败）。

/**
 * 组 route body：payload 栏位齐、签名正确（签名只吃 expertId/kind/payload，与 evidence 无关），
 * evidence 由呼叫端以任意键形提供（正是要测的相容层输入）。
 */
function bodyWithEvidence(evidence: Record<string, unknown>) {
  return {
    ...withSignature({ expert_id: "video-director", kind: "video_shots", payload: VIDEO_PAYLOAD }),
    evidence,
  };
}

test("evidence 只给 snake_case duration_sec → 映射为 durationSec，ok:true（本次缺陷回归棘轮）", async () => {
  // 这就是生产实测会 red 的那笔输入（evidence:{duration_sec:12}）。
  const response = await POST(req({ headers: AUTH, body: bodyWithEvidence({ duration_sec: 12 }) }));
  assert.equal(response.status, 200);
  const payload = await bodyOf(response);
  assert.equal(payload.ok, true, `errors=${JSON.stringify(payload.errors)}`);
  assert.deepEqual(payload.errors, []);
});

test("evidence 只给 camelCase durationSec → 原样通过，ok:true", async () => {
  const response = await POST(req({ headers: AUTH, body: bodyWithEvidence({ durationSec: 12 }) }));
  assert.equal(response.status, 200);
  const payload = await bodyOf(response);
  assert.equal(payload.ok, true, `errors=${JSON.stringify(payload.errors)}`);
  assert.deepEqual(payload.errors, []);
});

test("evidence 两种拼法同时给：以 camelCase 为准（snake 值不生效）", async () => {
  // (a) camel 合法（12）、snake 亦合法（1）→ ok:true 且无 duration/evidence 相关错误。
  const okPayload = await bodyOf(
    await POST(req({ headers: AUTH, body: bodyWithEvidence({ duration_sec: 1, durationSec: 12 }) })),
  );
  assert.equal(okPayload.ok, true, `errors=${JSON.stringify(okPayload.errors)}`);
  assert.ok(
    !okPayload.errors!.some((m) => /duration|evidence/i.test(m)),
    `不应出现 duration/evidence 相关错误：${JSON.stringify(okPayload.errors)}`,
  );

  // (b) 优先序的**可观察铁证**：camel 给 0（无效指针）、snake 给 12（有效指针）。
  //     camel 生效 → evidence 错误、ok:false；snake 生效 → ok:true。故 ok:false 证明 camel 为准。
  const payload = await bodyOf(
    await POST(req({ headers: AUTH, body: bodyWithEvidence({ duration_sec: 12, durationSec: 0 }) })),
  );
  assert.equal(payload.ok, false, "camelCase 的 0 必须生效，不得被 snake 的 12 覆盖");
  assert.ok(
    payload.errors!.some((m) => /evidence/.test(m)),
    `errors 必须点名 evidence：${JSON.stringify(payload.errors)}`,
  );
});

test("evidence 空物件仍被拒：ok:false 且 errors 点名 evidence（映射不得放行空物件）", async () => {
  const response = await POST(req({ headers: AUTH, body: bodyWithEvidence({}) }));
  assert.equal(response.status, 200);
  const payload = await bodyOf(response);
  assert.equal(payload.ok, false);
  assert.equal(payload.errors?.length, 1, `errors=${JSON.stringify(payload.errors)}`);
  assert.ok(
    payload.errors!.some((m) => /evidence/.test(m)),
    `errors 必须点名 evidence：${JSON.stringify(payload.errors)}`,
  );
});
