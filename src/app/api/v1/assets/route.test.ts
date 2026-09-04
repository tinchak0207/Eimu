import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

import { hashBizApiKey } from "../../../../lib/biz-api-keys";
import { __resetBizKeyStoreForTests } from "../../../../lib/biz-api-key-store";
import { __resetAssetPackStoreForTests } from "../../../../lib/asset-pack-store";
import { GET, PUT, DELETE } from "./route";

const root = process.cwd();
const ROUTE_PATH = "src/app/api/v1/assets/route.ts";

function read(relPath: string) {
  return readFileSync(join(root, relPath), "utf8");
}

/** 去掉注释后再断言，避免注释里引用的反例把测试带跑。 */
function code(relPath: string) {
  return read(relPath)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

// ─────────────────────────────────────────── 认证与存储隔离

// env 兜底层（BIZ_API_KEY_HASHES）+ 内存 asset store（无 BLOB_READ_WRITE_TOKEN）
// 让鉴权与 CRUD 全链路在单进程内可测，不需要 mock 任何函数：
// authenticateBizApiKey 走 envBizKeys() 的哈希匹配，asset-pack-store 落到 memoryStore。
const VALID_KEY = `sk-biz-${"a1b2c3d4e5f60718".repeat(2)}`; // 32 hex chars，形状合法
const VALID_USER_ID = 1001;
const VALID_HASH = hashBizApiKey(VALID_KEY);
const AUTH = { authorization: `Bearer ${VALID_KEY}` };

function reset() {
  delete process.env.GENERATION_DATABASE_URL;
  delete process.env.DATABASE_URL;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  process.env.BIZ_API_KEY_HASHES = `${VALID_HASH}:${VALID_USER_ID}`;
  __resetBizKeyStoreForTests();
  __resetAssetPackStoreForTests();
}

function req(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
): NextRequest {
  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return new NextRequest(`http://localhost${url}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

async function bodyOf(response: Response) {
  return (await response.json()) as { success?: boolean; error?: { message: string; type: string; code: string }; packs?: unknown[] };
}

test.beforeEach(() => {
  reset();
});

test.after(() => {
  delete process.env.BIZ_API_KEY_HASHES;
  __resetBizKeyStoreForTests();
  __resetAssetPackStoreForTests();
});

// ─────────────────────────────────────────── 认证

test("未带 key 一律 401，错误体可被 classifyError 解析", async () => {
  for (const [method, handler] of [
    ["GET", GET],
    ["PUT", PUT],
    ["DELETE", DELETE],
  ] as const) {
    const response = await handler(req("/v1/assets", { method }));
    assert.equal(response.status, 401, `${method} 未带 key 应 401`);
    const payload = await bodyOf(response);
    assert.ok(payload.error, `${method} 错误体必须有 error 字段`);
    assert.equal(payload.error.type, "authentication_error");
    assert.equal(payload.error.code, "missing_api_key");
    assert.ok(payload.error.message, "错误讯息不能为空");
  }
});

test("非法 key 一律 401，形状合法但未签发也 401", async () => {
  // 形状就直接不对：省掉哈希查表那一跳
  const malformed = await GET(req("/v1/assets", { headers: { authorization: "Bearer sk-biz-short" } }));
  assert.equal(malformed.status, 401);
  assert.equal((await bodyOf(malformed)).error?.code, "invalid_api_key");

  // 形状合法、但没在哈希表里的 key：走完整查表后判无效
  const unknownKey = `sk-biz-${"ff".repeat(16)}`;
  assert.notEqual(unknownKey, VALID_KEY);
  const unknown = await GET(req("/v1/assets", { headers: { authorization: `Bearer ${unknownKey}` } }));
  assert.equal(unknown.status, 401);
  assert.equal((await bodyOf(unknown)).error?.code, "invalid_api_key");
});

// ─────────────────────────────────────────── 输入校验

test("PUT 非法 payload 回 400 invalid_payload，不落库", async () => {
  // 没 id / title → normalizeAssetPack 直接拒绝
  const invalid = await PUT(req("/v1/assets", { method: "PUT", headers: AUTH, body: { title: "缺 id" } }));
  assert.equal(invalid.status, 400);
  const payload = await bodyOf(invalid);
  assert.equal(payload.error?.type, "invalid_request_error");
  assert.equal(payload.error?.code, "invalid_payload");

  const listed = await GET(req("/v1/assets", { headers: AUTH }));
  assert.equal((await bodyOf(listed)).packs?.length, 0, "非法 payload 不得写入资产包");
});

test("非 JSON 请求体回 400 invalid_json", async () => {
  const response = await PUT(new NextRequest("http://localhost/v1/assets", {
    method: "PUT",
    headers: new Headers({ ...AUTH, "content-type": "text/plain" }),
    body: "not json",
  }));
  assert.equal(response.status, 400);
  assert.equal((await bodyOf(response)).error?.code, "invalid_json");
});

test("DELETE 缺 ids 回 400 invalid_payload", async () => {
  const response = await DELETE(req("/v1/assets", { method: "DELETE", headers: AUTH, body: { ids: [] } }));
  assert.equal(response.status, 400);
  assert.equal((await bodyOf(response)).error?.code, "invalid_payload");
});

// ─────────────────────────────────────────── CRUD 闭环

test("PUT 合法 → GET 命中（q 搜 title/tags/digest，id 精确取包）", async () => {
  const pack = {
    id: "pack-001",
    title: "赛博主角资产包",
    digest: "赛博朋克风格的剧情主角，含参考图与 lora。",
    tags: ["主角", "赛博朋克"],
    items: [
      { kind: "prompt", title: "主提示词", content: "cyberpunk protagonist, cinematic" },
      { kind: "reference", title: "参考图", imageUrl: "https://example.com/ref.png" },
    ],
  };
  const saved = await PUT(req("/v1/assets", { method: "PUT", headers: AUTH, body: pack }));
  assert.equal(saved.status, 200);
  const savedBody = await bodyOf(saved);
  assert.equal(savedBody.success, true);

  // 无参 → 全量
  const all = await GET(req("/v1/assets", { headers: AUTH }));
  assert.equal(all.status, 200);
  assert.equal((await bodyOf(all)).packs?.length, 1);

  // q 命中 tags（小写不敏感）
  const byTag = await GET(req(`/v1/assets?q=${encodeURIComponent("赛博")}`, { headers: AUTH }));
  assert.equal((await bodyOf(byTag)).packs?.length, 1);
  // q 命中 digest
  const byDigest = await GET(req(`/v1/assets?q=${encodeURIComponent("剧情主角")}`, { headers: AUTH }));
  assert.equal((await bodyOf(byDigest)).packs?.length, 1);
  // q 不命中 → 空
  const byMiss = await GET(req(`/v1/assets?q=${encodeURIComponent("不存在")}`, { headers: AUTH }));
  assert.equal((await bodyOf(byMiss)).packs?.length, 0);

  // id 精确取包（asset_get 工具路径），不存在的 id 回空
  const byId = await GET(req(`/v1/assets?id=${encodeURIComponent("pack-001")}`, { headers: AUTH }));
  assert.equal((await bodyOf(byId)).packs?.length, 1);
  const byMissingId = await GET(req(`/v1/assets?id=${encodeURIComponent("pack-999")}`, { headers: AUTH }));
  assert.equal((await bodyOf(byMissingId)).packs?.length, 0);

  // 资产包按用户隔离：换一个 userId 的 key 读不到
  const otherKey = `sk-biz-${"cd".repeat(16)}`;
  process.env.BIZ_API_KEY_HASHES = `${hashBizApiKey(otherKey)}:${VALID_USER_ID + 1}`;
  __resetBizKeyStoreForTests();
  const other = await GET(req("/v1/assets", { headers: { authorization: `Bearer ${otherKey}` } }));
  assert.equal((await bodyOf(other)).packs?.length, 0, "不同用户的资产包必须互相隔离");
});

test("GET 响应带 Cache-Control no-store", async () => {
  const response = await GET(req("/v1/assets", { headers: AUTH }));
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("DELETE 移除后 GET 不再命中", async () => {
  await PUT(req("/v1/assets", {
    method: "PUT",
    headers: AUTH,
    body: { id: "pack-002", title: "待删包", tags: [], items: [] },
  }));
  const response = await DELETE(req("/v1/assets", { method: "DELETE", headers: AUTH, body: { ids: ["pack-002"] } }));
  assert.equal(response.status, 200);
  assert.equal((await bodyOf(response)).success, true);

  const all = await GET(req("/v1/assets", { headers: AUTH }));
  assert.equal((await bodyOf(all)).packs?.length, 0);
});

// ─────────────────────────────────────────── 零计费与错误体契约（源码层）

test("asset 路由是零计费端点：不碰 reserve/refund/quota", () => {
  const source = code(ROUTE_PATH);
  assert.doesNotMatch(source, /reserveImageQuota|refundImageQuota|QUOTA_PER_COIN|imageGenerationCoins|recordBizApiKeyUsage/);
  assert.doesNotMatch(source, /billingAmount|image-billing/);
});

test("错误体与 /v1/images/generations 同一形状，classifyError 可直接解析", () => {
  const assets = code(ROUTE_PATH);
  const generations = code("src/app/api/v1/images/generations/route.ts");
  assert.match(assets, /error:\s*\{\s*message,\s*type,\s*code,\s*param:\s*null/);
  // 与生图端点保持同一份形状，而不是另起一套
  const shape = /error:\s*\{\s*message,\s*type,\s*code[^}]*\}/.exec(assets)?.[0];
  const genShape = /error:\s*\{\s*message,\s*type,\s*code[^}]*\}/.exec(generations)?.[0];
  assert.equal(shape, genShape);
});

test("认证只认 Authorization 头，不依赖 x-user-id / 请求体身份", () => {
  const source = code(ROUTE_PATH);
  assert.match(source, /authenticateBizApiKey/);
  assert.match(source, /readBearerToken\(req\.headers\.get\("authorization"\)\)/);
  assert.doesNotMatch(source, /x-user-id|getStoredUserFromHeaders|body\.userId/);
  // 数据主体只来自密钥记录
  assert.match(source, /auth\.key\.userId/);
});