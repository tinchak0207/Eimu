import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

// 运行时（不是源码字串检查）测 admin model-pricing 路由：
// - 鉴权不 mock requireAdminSession，而是 patch next/headers 的 cookies()——admin-session
//   在呼叫時才讀 require("next/headers").cookies()，所以 patch exports 物件即穿透（同
//   方式在本倉庫其他 runtime 測試的靜態 import 下驗證過）。接著 mint 一顆真 session token。
// - 定價模組走記憶體模式：刪 BLOB_READ_WRITE_TOKEN 讓 read/write 落在 module 記憶體，
//   版本為 null / "memory"，可重現、不碰外部儲存。
// 測試結束用 applyModelPricingOverrides({}) 復原 catalog 的 effective 狀態。

import {
  applyModelPricingOverrides,
  type ModelPricingOverrides,
} from "../../../../lib/generation-model-catalog";
import { ADMIN_SESSION_COOKIE, createAdminSessionToken } from "../../../../lib/admin-auth";
import { GET, PATCH } from "./route";

const requireFn = createRequire(import.meta.url);
const nextHeaders = requireFn("next/headers") as { cookies: unknown };

process.env.ADMIN_SESSION_SECRET = "model-pricing-test-secret";
process.env.ADMIN_USERNAME = "tinchak0207";
delete process.env.BLOB_READ_WRITE_TOKEN;
delete process.env.NODE_ENV;

let sessionToken: string | null = null;

function installCookieMock() {
  const store = new Map<string, string>();
  if (sessionToken) store.set(ADMIN_SESSION_COOKIE, sessionToken);
  // Next 的 cookie store .get() 回傳 { name, value } | undefined，必須照抄這個形狀，
  // 否則 getAdminSession 的 `?.value` 拿到 undefined，永遠當成未登入。
  nextHeaders.cookies = async () => ({
    get: (name: string) => {
      const value = store.get(name);
      return value !== undefined ? { name, value } : undefined;
    },
  });
}

function mintToken(): string {
  return createAdminSessionToken("tinchak0207", process.env.ADMIN_SESSION_SECRET as string);
}

function patchRequest(overrides: unknown, expectedVersion: string | null): Request {
  return new Request("http://localhost/api/admin/model-pricing", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ overrides, expectedVersion }),
  });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

const GPT_IMAGE_2 = "gpt-image-2";

installCookieMock();

after(() => {
  applyModelPricingOverrides({});
});

test("未登录访问返回 401", async () => {
  sessionToken = null;
  installCookieMock();

  const response = await GET();
  assert.equal(response.status, 401);
  const body = await json(response);
  assert.equal(body.success, false);
});

test("GET 返回完整 payload：含基准价、有效价、价格标签与传播说明", async () => {
  sessionToken = mintToken();
  installCookieMock();

  const response = await GET();
  assert.equal(response.status, 200);
  const body = await json(response);

  assert.ok(Array.isArray(body.models) && (body.models as unknown[]).length > 0);
  assert.equal(typeof body.overrides, "object");
  assert.equal(body.overridesVersion, null);
  assert.equal(body.storage, "memory");
  assert.ok(typeof body.propagationNote === "string" && body.propagationNote.length > 0);

  const models = body.models as Array<{
    id: string;
    kind: "image" | "video";
    base: { imageCredits?: Record<string, number>; fixedCoins?: number };
    effective: Record<string, unknown>;
    priceLabels: Array<{ resolution: string; coins: number }>;
    modified: boolean;
  }>;
  const imageModel = models.find((model) => model.kind === "image");
  assert.ok(imageModel, "payload 应包含图片模型");
  // 尚无覆写时 effective === base。
  assert.deepEqual(imageModel.effective, imageModel.base);
  assert.equal(imageModel.modified, false);
  // 每个解析度都有 > 0 的有效币价。
  assert.ok(imageModel.priceLabels.length >= 1);
  assert.ok(imageModel.priceLabels.every((label) => label.coins > 0));
});

test("PATCH expectedVersion 不符返回 409 并附最新完整 payload", async () => {
  sessionToken = mintToken();
  installCookieMock();

  const response = await PATCH(
    patchRequest({ [GPT_IMAGE_2]: { imageCredits: { "1k": 30 } } }, "stale-version"),
  );
  assert.equal(response.status, 409);
  const body = await json(response);
  assert.equal(body.success, false);
  assert.ok((body.message as string).includes("更新"));
  // 409 回应本身就是最新完整 payload，UI 可直接用它覆蓋本地。
  assert.ok(Array.isArray(body.models));
  assert.ok(typeof body.overridesVersion === "string" || body.overridesVersion === null);
});

test("PATCH 非法 fixedCoins(0) 返回 400 并列出违规模型", async () => {
  sessionToken = mintToken();
  installCookieMock();

  const response = await PATCH(patchRequest({ [GPT_IMAGE_2]: { fixedCoins: 0 } }, null));
  assert.equal(response.status, 400);
  const body = await json(response);
  assert.equal(body.success, false);
  assert.ok((body.message as string).includes(GPT_IMAGE_2));
});

test("PATCH 合法覆写写入且回应反映新价，随后 GET 持久可见", async () => {
  sessionToken = mintToken();
  installCookieMock();

  const patchResponse = await PATCH(
    patchRequest({ [GPT_IMAGE_2]: { imageCredits: { "1k": 40 } } }, null),
  );
  assert.equal(patchResponse.status, 200);
  const patchBody = await json(patchResponse);

  const models = patchBody.models as Array<{
    id: string;
    modified: boolean;
    override: { imageCredits?: Record<string, number> } | null;
    effective: { imageCredits?: Record<string, number> };
    priceLabels: Array<{ resolution: string; coins: number }>;
  }>;
  const patched = models.find((model) => model.id === GPT_IMAGE_2);
  assert.ok(patched);
  assert.equal(patched.modified, true);
  assert.equal(patched.override?.imageCredits?.["1k"], 40);
  // 40 credits / 10 = 4 币/张。
  assert.equal(patched.effective.imageCredits?.["1k"], 40);
  assert.equal(patched.priceLabels.find((label) => label.resolution === "1k")?.coins, 4);

  const storedOverrides = patchBody.overrides as ModelPricingOverrides;
  assert.equal(storedOverrides[GPT_IMAGE_2]?.imageCredits?.["1k"], 40);

  // 后续 GET 应继续反映覆写后的有效价。
  const getResponse = await GET();
  assert.equal(getResponse.status, 200);
  const getBody = await json(getResponse);
  const getModels = getBody.models as Array<{ id: string; effective: { imageCredits?: Record<string, number> } }>;
  const seen = getModels.find((model) => model.id === GPT_IMAGE_2);
  assert.equal(seen?.effective.imageCredits?.["1k"], 40);
});
