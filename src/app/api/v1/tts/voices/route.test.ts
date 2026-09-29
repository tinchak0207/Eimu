// `GET /v1/tts/voices`（P1-11／D33）與 `POST /v1/tts/generations` 的音色值域——真跑路由函式。
//
// 認證走 BIZ_API_KEY_HASHES 兜底層（與 `/v1/images/generations` 測試同一套手法），
// 不需要控制面 DB：本檔驗的都是「進 I/O 之前就該拒絕／該放行」的分支。
//
// 真執行器：`npx tsx --test src/app/api/v1/tts/voices/route.test.ts`

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

test("未帶憑證 → 401（與其他 /v1/* 同一道門）", async () => {
  reset();
  const res = await listVoicesRoute(listRequest(false));
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error.code.startsWith("missing"), true);
});

test("ListVoices 語義：無參數全量回，每條帶 Id/Name/Gender/Description，且不吐 age", async () => {
  reset();
  const res = await listVoicesRoute(listRequest());
  assert.equal(res.status, 200);
  const payload = await res.json();
  assert.equal(payload.object, "list");
  assert.equal(payload.data.length, VOICE_LIBRARY.length, "全量回（無分頁、無隱藏）");
  assert.equal(payload.default_voice, "zh-CN-XiaoxiaoNeural");

  const xiaoxiao = payload.data.find((v: { id: string }) => v.id === "zh-CN-XiaoxiaoNeural");
  assert.ok(xiaoxiao, "實查清單裡的音色必須在回應中");
  assert.equal(xiaoxiao.name.length > 0, true);
  assert.equal(xiaoxiao.gender, "female", "Gender 是清單原值");
  assert.equal(xiaoxiao.description.includes("Warm"), true, "Description 由清單原值組成");
  assert.equal(xiaoxiao.route, "edge");
  assert.ok(xiaoxiao.source.includes("edge_tts"), "每條帶實查來源，可複核");

  // 誠實欄位：age 一概不出現（沒有真源），notes 明說。
  assert.equal(payload.data.some((v: Record<string, unknown>) => "age" in v), false);
  assert.match(payload.notes.join(" "), /age/);
  // 別名也必須可查（否則呼叫端不知道哪些 OpenAI 風格名能用）。
  const aliases = payload.data.filter((v: { id: string }) => v.id in VOICE_ALIASES).map((v: { id: string }) => v.id);
  assert.equal(aliases.length, Object.keys(VOICE_ALIASES).length);
});

test("提交端：未知 voice → 400 voice_unknown，且不建單（在任何 I/O 之前擋）", async () => {
  reset();
  const res = await submitTts(submitRequest({ input: "你好", voice: "不存在的音色" }));
  assert.equal(res.status, 400);
  const payload = await res.json();
  assert.equal(payload.error.code, "voice_unknown");
  assert.match(payload.error.message, /\/v1\/tts\/voices/, "錯誤訊息要指向可用音色清單");
});

test("提交端：合法 voice（清單內／別名／SF 形式）不被值域擋下；未帶 voice 亦不被擋（零回歸）", async () => {
  reset();
  // 無控制面 DB ⇒ 通過值域後會停在提交層（502 submit_failed）。
  // 這正是要的證據：**通過值域的請求不會拿到 400 voice_unknown**。
  for (const body of [
    { input: "你好", voice: "zh-CN-YunxiNeural" },
    { input: "你好", voice: "alloy" },
    { input: "你好", voice: "FunAudioLLM/CosyVoice2-0.5B:alex" },
    { input: "你好" }, // 未帶 ⇒ 既有 "default" 行為逐位不變
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
  assert.equal((await res.json()).error.code, "missing_input", "既有順序不被本刀打亂");
});