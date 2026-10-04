// `GET /v1/models` 的能力契约真行为断言（对称差 D23／P1-7）。
//
// 验的是**回应层**：新栏位（`x_capabilities.maxBatchCount`／`maxReferenceImages`）
// 真的出现在 payload 里，且值＝执行端常数（真的挡人的那颗）。
// 认证走 BIZ_API_KEY_HASHES 兜底层；定价覆写读不到时既有程式码吞错并沿用现值，不挡列表。
import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

import { hashBizApiKey } from "@/lib/biz-api-keys";
import { __resetBizKeyStoreForTests } from "@/lib/biz-api-key-store";
import { MAX_REQUEST_BATCH_COUNT, MAX_REQUEST_REFERENCE_IMAGES } from "@/lib/generation-core/request-limits";
import { GET } from "./route";

const VALID_KEY = `sk-biz-${"a1b2c3d4e5f60718".repeat(2)}`;
const USER_ID = 4242;
const AUTH = { authorization: `Bearer ${VALID_KEY}` };

type ModelEntry = {
  id: string;
  x_endpoint?: string;
  x_capabilities?: {
    mediaType?: string;
    referenceImages?: boolean;
    maxBatchCount?: number;
    maxReferenceImages?: number;
  };
};

function request(headers: Record<string, string>): NextRequest {
  return new NextRequest("http://localhost/v1/models", { headers: new Headers(headers) });
}

async function listModels(): Promise<ModelEntry[]> {
  const response = await GET(request(AUTH));
  assert.equal(response.status, 200, "带合法 B 端密钥必须 200");
  const body = (await response.json()) as { object: string; data: ModelEntry[] };
  assert.equal(body.object, "list");
  assert.ok(body.data.length > 0, "列表不得为空");
  return body.data;
}

test.beforeEach(() => {
  delete process.env.GENERATION_DATABASE_URL;
  delete process.env.DATABASE_URL;
  delete process.env.GENERATION_CONTROL_PLANE_ENABLED;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  process.env.BIZ_API_KEY_HASHES = `${hashBizApiKey(VALID_KEY)}:${USER_ID}`;
  __resetBizKeyStoreForTests();
});

test.after(() => {
  delete process.env.BIZ_API_KEY_HASHES;
  __resetBizKeyStoreForTests();
});

test("x_capabilities 逐模型揭露批次数与参考上限，值＝执行端常数", async () => {
  const data = await listModels();
  const image = data.find((entry) => entry.id === "gpt-image-2");
  assert.ok(image, "gpt-image-2 必须在列表里");

  assert.equal(image.x_capabilities?.mediaType, "image");
  assert.equal(image.x_capabilities?.maxBatchCount, MAX_REQUEST_BATCH_COUNT, "批次数必须外露且等于实际 n 上限");
  assert.equal(image.x_capabilities?.referenceImages, true);
  assert.equal(image.x_capabilities?.maxReferenceImages, MAX_REQUEST_REFERENCE_IMAGES, "参考上限必须外露且等于实际张数上限");
});

test("视频模型同样有批次数；不收参考图的模型省略参考上限（不输出空能力宣称）", async () => {
  const data = await listModels();

  const video = data.find((entry) => entry.id === "seedance-2.0");
  assert.ok(video, "seedance-2.0 必须在列表里");
  assert.equal(video.x_endpoint, "/v1/videos/generations");
  assert.equal(video.x_capabilities?.maxBatchCount, MAX_REQUEST_BATCH_COUNT);

  const noRefs = data.find((entry) => entry.id === "adobe-firefly");
  assert.ok(noRefs, "adobe-firefly 必须在列表里");
  assert.equal(noRefs.x_capabilities?.referenceImages, false);
  assert.equal("maxReferenceImages" in (noRefs.x_capabilities ?? {}), false, "不收参考图的模型不得宣告参考上限");
  assert.equal(noRefs.x_capabilities?.maxBatchCount, MAX_REQUEST_BATCH_COUNT, "批次数与参考图无关，每个模型都要有");
});

test("无认证：401 authentication_error（能力契约不得对匿名调用者外露）", async () => {
  const response = await GET(request({}));
  const body = (await response.json()) as { error: Record<string, unknown> };
  assert.equal(response.status, 401);
  assert.equal(body.error.type, "authentication_error");
});