// POST /api/harness/expert/deliverable/validate 的真行為測試。
//
// 驗的是「route 真的跑契約校驗」而不是「route 存在」：
//   · 未帶密鑰 → 401（正負對照：帶密鑰才進下一關）。
//   · 正向控制：欄位齊 + 簽名正確的 video-director 交付物 → 200 ok:true errors:[]。
//   · 缺契約必填欄位 → ok:false 且 errors 指名該欄；空字串值同樣算缺（非空判據）。
//   · 簽名被篡改 → ok:false 且 errors 指到簽名；qc_signature 回重算出的正確值。
//   · 未知 expert_id → 400；payload 非物件 → 400（body 白名單）。
//   · 棘輪：只跑 validateExpertDeliverable 會過的輸入（payload 非空但缺 requiredFields）
//     在 route 層必須紅——防「必填欄位檢查被拿掉」。

process.env.NODE_ENV = "test"; // 無物件儲存後端時允許記憶體降級（blob-backend 既有契約）

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

/** 對路由輸入用真源函式現算簽名（不是硬編碼魔法值），並補上 qc_signature。 */
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

/** video-director 的合格 payload（契約 requiredFields＝shots / duration_sec / model_hint / qc）。 */
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

test("未帶密鑰：401，錯誤體是 authentication_error / missing_api_key", async () => {
  const response = await POST(req({ body: videoInput() }));
  assert.equal(response.status, 401);
  const payload = await bodyOf(response);
  assert.equal(payload.error?.type, "authentication_error");
  assert.equal(payload.error?.code, "missing_api_key");
  assert.ok(payload.error?.message, "错误讯息不能为空");
});

test("正向控制：欄位齊 + 簽名正確的 video-director 交付物 → 200 ok:true errors:[]", async () => {
  const body = videoInput();
  const response = await POST(req({ headers: AUTH, body }));
  assert.equal(response.status, 200);
  const payload = await bodyOf(response);
  assert.equal(payload.ok, true, `errors=${JSON.stringify(payload.errors)}`);
  assert.deepEqual(payload.errors, []);
  assert.equal(payload.qc_signature, body.qc_signature, "qc_signature 必須等於原簽章（同輸入同簽章）");
});

test("缺 duration_sec：ok:false 且 errors 指名該契約必填欄", async () => {
  const { duration_sec: _drop, ...rest } = VIDEO_PAYLOAD;
  const response = await POST(req({ headers: AUTH, body: videoInput(rest) }));
  assert.equal(response.status, 200);
  const payload = await bodyOf(response);
  assert.equal(payload.ok, false);
  // 簽名是對「缺 duration_sec 的 payload」現算的 → 相符；故只剩必填欄位這一條錯。
  assert.equal(payload.errors?.length, 1, `errors=${JSON.stringify(payload.errors)}`);
  assert.match(payload.errors![0], /duration_sec/, "errors 必須指名 duration_sec");
  assert.match(payload.errors![0], /契约必填栏位/);
});

test("duration_sec 是空字串：同樣算缺（非空值判據，不是有欄位就算）", async () => {
  const response = await POST(
    req({ headers: AUTH, body: videoInput({ ...VIDEO_PAYLOAD, duration_sec: "" }) }),
  );
  assert.equal(response.status, 200);
  const payload = await bodyOf(response);
  assert.equal(payload.ok, false);
  assert.equal(payload.errors?.length, 1, `errors=${JSON.stringify(payload.errors)}`);
  assert.match(payload.errors![0], /duration_sec/, "空字串必須算缺並指名該欄");
  assert.match(payload.errors![0], /空字符串/, "錯誤訊息必須說明空字串算缺");
});

test("payload 欄位齊但 qc_signature 不匹配：ok:false 且 errors 指到簽名，qc_signature 回正確期望值", async () => {
  const body = { ...videoInput(), qc_signature: "0".repeat(64) };
  const response = await POST(req({ headers: AUTH, body }));
  assert.equal(response.status, 200);
  const payload = await bodyOf(response);
  assert.equal(payload.ok, false);
  assert.equal(payload.errors?.length, 1, `errors=${JSON.stringify(payload.errors)}`);
  assert.match(payload.errors![0], /qcSignature/, "errors 必須指到 qcSignature");

  const correct = computeQcSignature({
    expertId: "video-director",
    kind: "video_shots",
    payload: VIDEO_PAYLOAD,
    evidence: VIDEO_EVIDENCE,
    contract: { expertId: "video-director", intent: "起一个镜头", materials: [], acceptance: ["可核验"] },
  });
  assert.equal(payload.qc_signature, correct, "qc_signature 必須是重算出的正確期望值");
  assert.notEqual(payload.qc_signature, "0".repeat(64));
});

test("回包帶 qc_signature 且等於 computeQcSignature（呼叫方可自我修正）", async () => {
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

test("棘輪：只過 validateExpertDeliverable、缺契約必填欄位的輸入在 route 層必須紅", async () => {
  // payload 非空（validate 層會過）但缺 shots/duration_sec/model_hint/qc。
  const payload = { note: "看起来有内容，但没有契约要求的任何栏位" };
  const body = videoInput(payload);

  // 正向對照：只跑 validateExpertDeliverable 時，這份輸入是「過」的。
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

  // route 必須因為「該域契約必填欄位」檢查而紅——把這條檢查拿掉，本斷言即失敗。
  const response = await POST(req({ headers: AUTH, body }));
  assert.equal(response.status, 200);
  const result = await bodyOf(response);
  assert.equal(result.ok, false, "route 不得只靠 validateExpertDeliverable 放行——必填欄位檢查被拿掉");
  assert.ok(
    result.errors!.some((message) => /契约必填栏位/.test(message)),
    `errors 必須含契约必填栏位这条：${JSON.stringify(result.errors)}`,
  );
  for (const field of ["shots", "duration_sec", "model_hint", "qc"]) {
    assert.ok(
      result.errors!.some((message) => message.includes(field)),
      `缺栏清单必须点名 ${field}：${JSON.stringify(result.errors)}`,
    );
  }
});

test("未知 expert_id：400 invalid_expert_id（不跑校驗）", async () => {
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

test("壞 JSON：400 invalid_json（不拋 500）", async () => {
  const response = await POST(req({ headers: AUTH, raw: '{"expert_id":' }));
  assert.equal(response.status, 400);
  assert.equal((await bodyOf(response)).error?.code, "invalid_json");
});

// ── evidence 键名相容层棘輪（2026-10-03 对外契约缺陷：inputSchema 宣告 snake_case，
//    底层 ExpertDeliverable.evidence 是 camelCase；不映射＝外部 agent 照工具说明书必失败）。

/**
 * 組 route body：payload 欄位齊、簽名正確（簽名只吃 expertId/kind/payload，與 evidence 無關），
 * evidence 由呼叫端以任意鍵形提供（正是要測的相容層輸入）。
 */
function bodyWithEvidence(evidence: Record<string, unknown>) {
  return {
    ...withSignature({ expert_id: "video-director", kind: "video_shots", payload: VIDEO_PAYLOAD }),
    evidence,
  };
}

test("evidence 只給 snake_case duration_sec → 映射為 durationSec，ok:true（本次缺陷回歸棘輪）", async () => {
  // 這就是生產實測會 red 的那筆輸入（evidence:{duration_sec:12}）。
  const response = await POST(req({ headers: AUTH, body: bodyWithEvidence({ duration_sec: 12 }) }));
  assert.equal(response.status, 200);
  const payload = await bodyOf(response);
  assert.equal(payload.ok, true, `errors=${JSON.stringify(payload.errors)}`);
  assert.deepEqual(payload.errors, []);
});

test("evidence 只給 camelCase durationSec → 原樣通過，ok:true", async () => {
  const response = await POST(req({ headers: AUTH, body: bodyWithEvidence({ durationSec: 12 }) }));
  assert.equal(response.status, 200);
  const payload = await bodyOf(response);
  assert.equal(payload.ok, true, `errors=${JSON.stringify(payload.errors)}`);
  assert.deepEqual(payload.errors, []);
});

test("evidence 兩種拼法同時給：以 camelCase 為準（snake 值不生效）", async () => {
  // (a) camel 合法（12）、snake 亦合法（1）→ ok:true 且無 duration/evidence 相關錯誤。
  const okPayload = await bodyOf(
    await POST(req({ headers: AUTH, body: bodyWithEvidence({ duration_sec: 1, durationSec: 12 }) })),
  );
  assert.equal(okPayload.ok, true, `errors=${JSON.stringify(okPayload.errors)}`);
  assert.ok(
    !okPayload.errors!.some((m) => /duration|evidence/i.test(m)),
    `不應出現 duration/evidence 相關錯誤：${JSON.stringify(okPayload.errors)}`,
  );

  // (b) 優先序的**可觀察鐵證**：camel 給 0（無效指針）、snake 給 12（有效指針）。
  //     camel 生效 → evidence 錯誤、ok:false；snake 生效 → ok:true。故 ok:false 證明 camel 為準。
  const payload = await bodyOf(
    await POST(req({ headers: AUTH, body: bodyWithEvidence({ duration_sec: 12, durationSec: 0 }) })),
  );
  assert.equal(payload.ok, false, "camelCase 的 0 必須生效，不得被 snake 的 12 覆蓋");
  assert.ok(
    payload.errors!.some((m) => /evidence/.test(m)),
    `errors 必須點名 evidence：${JSON.stringify(payload.errors)}`,
  );
});

test("evidence 空物件仍被拒：ok:false 且 errors 點名 evidence（映射不得放行空物件）", async () => {
  const response = await POST(req({ headers: AUTH, body: bodyWithEvidence({}) }));
  assert.equal(response.status, 200);
  const payload = await bodyOf(response);
  assert.equal(payload.ok, false);
  assert.equal(payload.errors?.length, 1, `errors=${JSON.stringify(payload.errors)}`);
  assert.ok(
    payload.errors!.some((m) => /evidence/.test(m)),
    `errors 必須點名 evidence：${JSON.stringify(payload.errors)}`,
  );
});
