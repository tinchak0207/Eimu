// `GET /openai/v1/models` 的**真行為斷言**。
//
// 中轉站（new-api/one-api）用它做模型發現與上架：形狀必須是標準 OpenAI list，內容必須
// 只含「當下真的能出圖」的圖片模型。這裡用獨立於本實現的字面量斷言（已知圖片模型在、
// 影片/服務型條目不在），不是從被測實現裡讀出來的期望值。
import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

import { SUPPORTED_IMAGE_MODEL_IDS } from "@/lib/image-model-ids";
import {
  AUTH_HEADER,
  clearCompatEnv,
  installUpstreamStub,
  resetCompatEnv,
  restoreFetch,
} from "@/lib/openai-compat/upstream-stub";
import { GET } from "./route";

/** 影片模型與服務型條目：清單裡出現 = 中轉站會把它們 POST 到生图端点再收 400。 */
const MUST_NOT_APPEAR = [
  "seedance-2.0",
  "seedance-2.5-720p",
  "minimax-h3",
  "pixai-upscale",
  "pixai-edit",
  "tts-1",
  "avatar-1",
  "gpt-4o",
];

/** 已知圖片模型（字面量，與目錄無關的獨立樣本）。 */
const MUST_APPEAR = ["gpt-image-2", "pixai-tsubaki2", "flux-2-pro"];

function request(headers: Record<string, string>): NextRequest {
  return new NextRequest("http://localhost/openai/v1/models", { headers: new Headers(headers) });
}

test.beforeEach(() => {
  resetCompatEnv();
  // /v1/models 与本站一样要先同步定价覆写：替身对未知路径回 404，
  // 读失败被既有代码吞掉并退回 last-known-good，不挡列表。
  installUpstreamStub({ taskSnapshots: [{ status: "succeeded" }] });
});

test.afterEach(() => {
  restoreFetch();
});

test.after(() => {
  clearCompatEnv();
});

test("标准 list 形状 + owned_by=eimu + 只列可出图的图片模型", async () => {
  const response = await GET(request({ authorization: AUTH_HEADER }));
  const body = (await response.json()) as {
    object: string;
    data: Array<Record<string, unknown>>;
  };

  assert.equal(response.status, 200);
  assert.equal(body.object, "list");
  assert.ok(Array.isArray(body.data) && body.data.length > 0, "列表不得为空");

  for (const entry of body.data) {
    assert.equal(typeof entry.id, "string");
    assert.equal(entry.object, "model");
    assert.equal(entry.owned_by, "eimu");
    assert.equal(typeof entry.created, "number");
  }

  const ids = body.data.map((entry) => entry.id as string);
  for (const id of MUST_APPEAR) assert.ok(ids.includes(id), `图片模型 ${id} 必须在列表里`);
  for (const id of MUST_NOT_APPEAR) assert.ok(!ids.includes(id), `非图片模型 ${id} 不得出现在 OpenAI 兼容列表里`);

  // 每条都在站内图片模型白名单内（清单不能比供给更大）
  for (const id of ids) {
    assert.ok(SUPPORTED_IMAGE_MODEL_IDS.includes(id), `${id} 不在站内图片模型目录里`);
  }

  // 限流头（聚合平台按它做退避）
  assert.equal(typeof response.headers.get("x-ratelimit-limit-requests"), "string");
  assert.equal(typeof response.headers.get("x-request-id"), "string");
});

test("无认证：401 authentication_error", async () => {
  const response = await GET(request({}));
  const body = (await response.json()) as { error: Record<string, unknown> };
  assert.equal(response.status, 401);
  assert.equal(body.error.type, "authentication_error");
});
