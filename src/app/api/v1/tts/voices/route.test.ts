// `GET /v1/tts/voices`（P1-11／D33）与 `POST /v1/tts/generations` 的音色值域——真跑路由函式。
//
// 认证走 BIZ_API_KEY_HASHES 兜底层（与 `/v1/images/generations` 测试同一套手法），
// 不需要控制面 DB：本档验的都是「进 I/O 之前就该拒绝／该放行」的分支。
//
// 真执行器：`npx tsx --test src/app/api/v1/tts/voices/route.test.ts`

import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { hashBizApiKey } from "@/lib/biz-api-keys";
import { __resetBizKeyStoreForTests } from "@/lib/biz-api-key-store";
import { VOICE_ALIASES, VOICE_LIBRARY } from "@/lib/voice-library";
import { GET as listVoicesRoute } from "./route";
import { POST as submitTts } from "../generations/route";

const VALID_KEY = `sk-biz-${"c0ffee1234567890".repeat(2)}`;
const USER_ID = 5150;

function reset() {
  delete process.env.GENERATION_DATABASE_URL;
  delete process.env.DATABASE_URL;
  delete process.env.GENERATION_CONTROL_PLANE_ENABLED;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  process.env.BIZ_API_KEY_HASHES = `${hashBizApiKey(VALID_KEY)}:${USER_ID}`;
  __resetBizKeyStoreForTests();
}

function listRequest(auth = true): NextRequest {
  return new NextRequest("http://site.test/api/v1/tts/voices", {
    method: "GET",
    headers: auth ? { authorization: `Bearer ${VALID_KEY}` } : {},
  });
}

function submitRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://site.test/api/v1/tts/generations", {
    method: "POST",
    headers: { authorization: `Bearer ${VALID_KEY}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("未带凭证 → 401（与其他 /v1/* 同一道门）", async () => {
  reset();
  const res = await listVoicesRoute(listRequest(false));
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error.code.startsWith("missing"), true);
});

test("ListVoices 语义：无参数全量回，每条带 Id/Name/Gender/Description，且不吐 age", async () => {
  reset();
  const res = await listVoicesRoute(listRequest());
  assert.equal(res.status, 200);
  const payload = await res.json();
  assert.equal(payload.object, "list");
  assert.equal(payload.data.length, VOICE_LIBRARY.length, "全量回（无分页、无隐藏）");
  assert.equal(payload.default_voice, "zh-CN-XiaoxiaoNeural");

  const xiaoxiao = payload.data.find((v: { id: string }) => v.id === "zh-CN-XiaoxiaoNeural");
  assert.ok(xiaoxiao, "实查清单里的音色必须在回应中");
  assert.equal(xiaoxiao.name.length > 0, true);
  assert.equal(xiaoxiao.gender, "female", "Gender 是清单原值");
  assert.equal(xiaoxiao.description.includes("Warm"), true, "Description 由清单原值组成");
  assert.equal(xiaoxiao.route, "edge");
  assert.ok(xiaoxiao.source.includes("edge_tts"), "每条带实查来源，可复核");

  // 诚实栏位：age 一概不出现（没有真源），notes 明说。
  assert.equal(payload.data.some((v: Record<string, unknown>) => "age" in v), false);
  assert.match(payload.notes.join(" "), /age/);
  // 别名也必须可查（否则呼叫端不知道哪些 OpenAI 风格名能用）。
  const aliases = payload.data.filter((v: { id: string }) => v.id in VOICE_ALIASES).map((v: { id: string }) => v.id);
  assert.equal(aliases.length, Object.keys(VOICE_ALIASES).length);
});

test("提交端：未知 voice → 400 voice_unknown，且不建单（在任何 I/O 之前挡）", async () => {
  reset();
  const res = await submitTts(submitRequest({ input: "你好", voice: "不存在的音色" }));
  assert.equal(res.status, 400);
  const payload = await res.json();
  assert.equal(payload.error.code, "voice_unknown");
  assert.match(payload.error.message, /\/v1\/tts\/voices/, "错误讯息要指向可用音色清单");
});

test("提交端：合法 voice（清单内／别名／SF 形式）不被值域挡下；未带 voice 亦不被挡（零回归）", async () => {
  reset();
  // 无控制面 DB ⇒ 通过值域后会停在提交层（502 submit_failed）。
  // 这正是要的证据：**通过值域的请求不会拿到 400 voice_unknown**。
  for (const body of [
    { input: "你好", voice: "zh-CN-YunxiNeural" },
    { input: "你好", voice: "alloy" },
    { input: "你好", voice: "FunAudioLLM/CosyVoice2-0.5B:alex" },
    { input: "你好" }, // 未带 ⇒ 既有 "default" 行为逐位不变
  ]) {
    const res = await submitTts(submitRequest(body));
    const code = (await res.json())?.error?.code;
    assert.notEqual(code, "voice_unknown", `${JSON.stringify(body)} 不得被判未知音色`);
  }
});

test("提交端：致命的是值域不是 shape——空 input 仍走既有的 missing_input", async () => {
  reset();
  const res = await submitTts(submitRequest({ input: "  ", voice: "zh-CN-YunxiNeural" }));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, "missing_input", "既有顺序不被本刀打乱");
});