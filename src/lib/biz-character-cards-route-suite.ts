// 角色卡 B 端路由的**共用断言套件**。
//
// 为什么要共用：`/api/v1/character-cards` 与 `/api/biz/character-cards` 是同一份实现的两个
// 挂载点（实现只在 src/lib/biz-character-cards-route.ts）。两边各抄一份断言 = 两份会各自
// 漂移的「尺」；共用同一份断言才能证明「两条 route 真的代理到同一行为」。
//
// 断言全是**真行为**（不是源码字串守门件）：POST 一张卡 → GET 读回同一张（逐栏相等），
// 走真 store（无 BLOB_READ_WRITE_TOKEN 时落 character-card-store 的 memoryStore，真 store
// 非 mock）＋ 真 normalizeCharacterCard；upsert 幂等；负控制（不同 name → 两张）；
// 用户隔离；401 闸；kind 收敛；reference_urls 非法 400。
import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

import { hashBizApiKey } from "./biz-api-keys";

// ───────────────────────── 测试用 blob 后端（真物化路径，不碰外网）
//
// 生产 shared 的 data:image 参考图必须物化到对象存储；无后端时 store 正确判 400。
// 这里把 VPS image-data-api 指到一个假 origin，并把 global fetch 换成进程内实现：
// `ensureBlobBackendWritable()` 回 true，put/get/list/del 全部走真 store 代码，
// 只是落点是我们自己的 Map（不 mock 被测函式）。
//
// 注意：IMAGE_DATA_BASE_URL/API_KEY 是 vps-blob-adapter 的**模组载入期快照**，
// 所以必须在任何 blob 依赖被 import 之前设定——本档因此把 biz-api-key-store /
// character-card-store 改成动态 import（下方 top-level await）。
const FAKE_BLOB_ORIGIN = "http://blob.test";
process.env.IMAGE_DATA_BASE_URL = FAKE_BLOB_ORIGIN;
process.env.IMAGE_DATA_API_KEY = "test-image-data-key";

interface FakeBlob {
  bytes: Uint8Array;
  contentType: string;
  uploadedAt: Date;
}
const fakeBlobs = new Map<string, FakeBlob>();
const realFetch = globalThis.fetch;

function fakeBlobUrl(pathname: string): string {
  return `${FAKE_BLOB_ORIGIN}/files/${pathname}`;
}

/** 进程内 image-data-api：PUT/GET/DELETE/list 与 VPS adapter 的路径契约一致。 */
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const parsed = new URL(url);
  if (parsed.origin !== FAKE_BLOB_ORIGIN) return realFetch(input as RequestInfo, init);
  const method = (init?.method ?? "GET").toUpperCase();

  if (parsed.pathname.startsWith("/files/")) {
    const pathname = decodeURIComponent(parsed.pathname.slice("/files/".length));
    const blob = fakeBlobs.get(pathname);
    if (!blob) return new Response("not found", { status: 404 });
    return new Response(blob.bytes as unknown as BodyInit, {
      status: 200,
      headers: {
        "content-type": blob.contentType,
        "x-blob-size": String(blob.bytes.length),
        "x-blob-uploaded-at": blob.uploadedAt.toISOString(),
      },
    });
  }

  if (parsed.pathname === "/api/blob/list") {
    const prefix = parsed.searchParams.get("prefix") ?? "";
    const blobs = [...fakeBlobs.entries()]
      .filter(([pathname]) => pathname.startsWith(prefix))
      .map(([pathname, blob]) => ({
        url: fakeBlobUrl(pathname),
        pathname,
        size: blob.bytes.length,
        uploadedAt: blob.uploadedAt.toISOString(),
      }));
    return Response.json({ blobs, hasMore: false });
  }

  if (parsed.pathname === "/api/blob/get") {
    const pathname = parsed.searchParams.get("path") ?? "";
    const blob = fakeBlobs.get(pathname);
    if (!blob) {
      return new Response(null, {
        status: 404,
        headers: { "x-blob-size": "0", "x-blob-uploaded-at": new Date(0).toISOString() },
      });
    }
    return new Response(blob.bytes as unknown as BodyInit, {
      status: 200,
      headers: {
        "content-type": blob.contentType,
        "x-blob-size": String(blob.bytes.length),
        "x-blob-uploaded-at": blob.uploadedAt.toISOString(),
      },
    });
  }

  if (parsed.pathname.startsWith("/api/blob/")) {
    const pathname = parsed.pathname
      .slice("/api/blob/".length)
      .split("/")
      .map((segment) => decodeURIComponent(segment))
      .join("/");
    if (method === "PUT") {
      const raw = init?.body;
      const bytes =
        typeof raw === "string"
          ? new TextEncoder().encode(raw)
          : raw instanceof Uint8Array
            ? raw
            : new Uint8Array(await new Response(raw as BodyInit).arrayBuffer());
      const contentType = new Headers(init?.headers).get("x-content-type") ?? "application/octet-stream";
      const uploadedAt = new Date();
      fakeBlobs.set(pathname, { bytes, contentType, uploadedAt });
      return Response.json({
        url: fakeBlobUrl(pathname),
        pathname,
        size: bytes.length,
        uploadedAt: uploadedAt.toISOString(),
      });
    }
    if (method === "DELETE") {
      fakeBlobs.delete(pathname);
      return Response.json({ deleted: 1 });
    }
  }

  return new Response("not found", { status: 404 });
}) as typeof fetch;

// tsx 以 CJS 执行测试（无 top-level await）：用 require 保证 blob 依赖在 env 设定后才载入。
declare const require: (id: string) => unknown;
const { __resetBizKeyStoreForTests } = require("./biz-api-key-store") as typeof import("./biz-api-key-store");
const { __resetCharacterCardStoreForTests } = require("./character-card-store") as typeof import("./character-card-store");

/** 一个挂载点（route 档）真正导出的 HTTP handler。 */
export interface CharacterCardRouteHandlers {
  GET: (req: NextRequest) => Promise<Response>;
  POST: (req: NextRequest) => Promise<Response>;
}

const VALID_KEY = `sk-biz-${"a1b2c3d4e5f60718".repeat(2)}`; // 32 hex，形状合法
const VALID_USER_ID = 4242;
const AUTH = { authorization: `Bearer ${VALID_KEY}` };

interface WireCard {
  id: string;
  name: string;
  kind: string;
  prompt: string;
  reference_urls: string[];
  updated_at: string;
}

interface CardBody {
  object?: string;
  data?: WireCard | WireCard[];
  error?: { message: string; type: string; code: string; trace_id: string };
}

/**
 * 注册一整套断言到 `label` 这个挂载点上（同一份断言可对多条 route 各跑一次）。
 * 必须在测试档的模组顶层呼叫（node:test 的 hook 注册在呼叫当下生效）。
 */
export function registerBizCharacterCardRouteSuite(
  label: string,
  handlers: CharacterCardRouteHandlers,
): void {
  function reset() {
    delete process.env.GENERATION_DATABASE_URL;
    delete process.env.DATABASE_URL;
    delete process.env.BLOB_READ_WRITE_TOKEN; // 走 VPS 后端分支（测试 fetch 替身），不落进程内记忆体
    process.env.BIZ_API_KEY_HASHES = `${hashBizApiKey(VALID_KEY)}:${VALID_USER_ID}`;
    fakeBlobs.clear();
    __resetBizKeyStoreForTests();
    __resetCharacterCardStoreForTests();
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

  async function bodyOf(response: Response): Promise<CardBody> {
    return (await response.json()) as CardBody;
  }

  async function postCard(body: unknown, headers: Record<string, string> = AUTH) {
    return handlers.POST(req(`${label}`, { method: "POST", headers, body }));
  }

  async function listCards(query = "", headers: Record<string, string> = AUTH) {
    return handlers.GET(req(`${label}${query}`, { headers }));
  }

  async function listData(response: Response): Promise<WireCard[]> {
    const payload = await bodyOf(response);
    assert.ok(Array.isArray(payload.data), "列表 data 必须是数组");
    return payload.data as WireCard[];
  }

  test.beforeEach(() => {
    reset();
  });

  test.after(() => {
    delete process.env.BIZ_API_KEY_HASHES;
    globalThis.fetch = realFetch;
    __resetBizKeyStoreForTests();
    __resetCharacterCardStoreForTests();
  });

  // ─────────────────────────────────────────── 真行为：存得下、看得到

  test(`${label}｜POST 存一张卡 → GET 读回同一张（id/name/kind/prompt/reference_urls 逐栏相等）`, async () => {
    const input = {
      name: "霍辞渊",
      kind: "character",
      prompt: "黑色羊毛真丝高领礼服，冷白皮，细长凤眼",
      negative_prompt: "模糊, 多手",
      // 最小合法 1x1 PNG（透明）data URI：物化路径要求真图片魔数，不能用 "AAAA"。
      reference_urls: [
        "https://img.example/huo-1.png",
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      ],
    };
    const saved = await postCard(input);
    assert.equal(saved.status, 201, "新建/更新固定回 201");
    const savedBody = await bodyOf(saved);
    assert.equal(savedBody.object, "character_card");
    const created = savedBody.data as WireCard;
    assert.ok(created.id.startsWith("biz-"), "缺省 id 必须是决定性 biz- 前缀 id");
    assert.equal(created.name, "霍辞渊");
    assert.equal(created.kind, "character");
    assert.equal(created.prompt, input.prompt);
    // data:image 必须先物化成对象存储 URL；http(s) 输入原样保留。
    assert.equal(created.reference_urls[0], input.reference_urls[0], "https URL 原样保留");
    assert.match(
      created.reference_urls[1],
      /^http:\/\/blob\.test\/files\/character-cards\/4242\/refs\/[0-9a-f]+\.png$/,
      "data URI 必须物化成参考图 URL",
    );
    assert.equal(created.reference_urls[1].startsWith("data:image/"), false, "不得把内嵌图原样存下");

    // 空卡库→有卡：GET 真的读回同一张（不是只看 POST 的 201）
    const listed = await listCards();
    assert.equal(listed.status, 200);
    const cards = await listData(listed);
    assert.equal(cards.length, 1);
    const readBack = cards[0];
    assert.equal(readBack.id, created.id);
    assert.equal(readBack.name, created.name);
    assert.equal(readBack.kind, created.kind);
    assert.equal(readBack.prompt, created.prompt);
    assert.deepEqual(readBack.reference_urls, created.reference_urls);
    assert.equal(readBack.updated_at, created.updated_at);
    // 逐栏等价：GET 项的键集合就是契约那六个（内部栏位不得外泄）
    assert.deepEqual(
      Object.keys(readBack).sort(),
      ["id", "kind", "name", "prompt", "reference_urls", "updated_at"],
    );
  });

  test(`${label}｜空卡库回 200 \`{object:'list', data:[]}\`，不是 404`, async () => {
    const response = await listCards();
    assert.equal(response.status, 200);
    const payload = await bodyOf(response);
    assert.equal(payload.object, "list");
    assert.deepEqual(payload.data, []);
  });

  // ─────────────────────────────────────────── upsert 与负控制

  test(`${label}｜同一个 body 连 POST 两次 → GET 只回一张（决定性 id + store 的 upsert）`, async () => {
    const body = { name: "雨夜街", kind: "scene", prompt: "霓虹雨夜街道" };
    const first = await postCard(body);
    const second = await postCard(body);
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    const firstId = ((await bodyOf(first)).data as WireCard).id;
    const secondId = ((await bodyOf(second)).data as WireCard).id;
    assert.equal(firstId, secondId, "同名同 kind 两次 POST 必须铸出同一个 id");

    const cards = await listData(await listCards());
    assert.equal(cards.length, 1, "重复存同名同 kind 的卡必须是更新，不是新增");
    assert.equal(cards[0].name, "雨夜街");

    // 同 id 覆盖：改 prompt 再 POST 一次，仍是一张、内容已更新
    const updated = await postCard({ ...body, prompt: "霓虹雨夜街道，积水反光" });
    assert.equal(updated.status, 201);
    const after = await listData(await listCards());
    assert.equal(after.length, 1);
    assert.equal(after[0].prompt, "霓虹雨夜街道，积水反光");
  });

  test(`${label}｜负控制：不同 name → GET 回两张（证明上一条不是卡库坏了）`, async () => {
    await postCard({ name: "霍辞渊", kind: "character" });
    await postCard({ name: "林晚", kind: "character" });
    const cards = await listData(await listCards());
    assert.equal(cards.length, 2, "不同 name 必须落成两张卡");
    assert.deepEqual(cards.map((card) => card.name).sort(), ["林晚", "霍辞渊"]);
    assert.equal(new Set(cards.map((card) => card.id)).size, 2, "不同卡不得撞 id");
  });

  test(`${label}｜用户隔离：另一把 key（另一 userId）读不到这些卡`, async () => {
    await postCard({ name: "只属于 4242 的卡" });
    const otherKey = `sk-biz-${"cd".repeat(16)}`;
    process.env.BIZ_API_KEY_HASHES = `${hashBizApiKey(otherKey)}:${VALID_USER_ID + 1}`;
    __resetBizKeyStoreForTests();
    const cards = await listData(await listCards("", { authorization: `Bearer ${otherKey}` }));
    assert.deepEqual(cards, [], "卡库按密钥绑定的 userId 隔离");
  });

  // ─────────────────────────────────────────── 认证

  test(`${label}｜无 Bearer / 坏 Bearer → 401（authentication_error）`, async () => {
    const missing = await handlers.GET(req(label));
    assert.equal(missing.status, 401);
    const missingBody = await bodyOf(missing);
    assert.equal(missingBody.error?.type, "authentication_error");
    assert.equal(missingBody.error?.code, "missing_api_key");
    assert.ok(missingBody.error?.trace_id, "401 必须带 trace_id");

    const malformed = await handlers.GET(req(label, { headers: { authorization: "Bearer sk-biz-short" } }));
    assert.equal(malformed.status, 401);
    assert.equal((await bodyOf(malformed)).error?.code, "invalid_api_key");

    const unknownKey = `sk-biz-${"ff".repeat(16)}`;
    const unknown = await handlers.GET(req(label, { headers: { authorization: `Bearer ${unknownKey}` } }));
    assert.equal(unknown.status, 401);
    assert.equal((await bodyOf(unknown)).error?.code, "invalid_api_key");

    // POST 同样受闸，且未认证不得落卡
    const postMissing = await postCard({ name: "不该落地的卡" }, {});
    assert.equal(postMissing.status, 401);
    process.env.BIZ_API_KEY_HASHES = `${hashBizApiKey(VALID_KEY)}:${VALID_USER_ID}`;
    __resetBizKeyStoreForTests();
    assert.deepEqual(await listData(await listCards()), [], "401 的 POST 不得写入卡库");
  });

  // ─────────────────────────────────────────── 清洗（唯一收口 normalizeCharacterCard）

  test(`${label}｜kind 传乱值 → 收敛成 character，不报错`, async () => {
    const response = await postCard({ name: "乱填 kind 的卡", kind: "乱七八糟" });
    assert.equal(response.status, 201);
    const created = (await bodyOf(response)).data as WireCard;
    assert.equal(created.kind, "character");

    const readBack = await listData(await listCards());
    assert.equal(readBack[0].kind, "character", "GET 读回也必须是收敛后的 kind");

    // kind 过滤器精确匹配：五值之一命中，不认识的值不收敛成 character（免得假命中）
    assert.equal((await listData(await listCards("?kind=character"))).length, 1);
    assert.equal((await listData(await listCards("?kind=乱七八糟"))).length, 0);
  });

  test(`${label}｜reference_urls 含非法项 → 400，且不落卡；>8 条 → 400`, async () => {
    const invalid = await postCard({ name: "带坏 url 的卡", reference_urls: ["not-a-url"] });
    assert.equal(invalid.status, 400);
    const invalidBody = await bodyOf(invalid);
    assert.equal(invalidBody.error?.type, "invalid_request_error");
    assert.equal(invalidBody.error?.code, "invalid_reference_url");
    assert.ok(invalidBody.error?.trace_id);

    const tooMany = await postCard({
      name: "参考图超限的卡",
      reference_urls: Array.from({ length: 9 }, (_, i) => `https://img.example/${i}.png`),
    });
    assert.equal(tooMany.status, 400);
    assert.equal((await bodyOf(tooMany)).error?.code, "too_many_reference_urls");

    assert.deepEqual(await listData(await listCards()), [], "非法 payload 一律不得写入卡库");
  });

  test(`${label}｜name 缺失/超长 → 400（长度由 normalizeCharacterCard 的 1..100 收口）`, async () => {
    const missing = await postCard({ prompt: "没有名字" });
    assert.equal(missing.status, 400);
    assert.equal((await bodyOf(missing)).error?.code, "missing_name");

    const tooLong = await postCard({ name: "甲".repeat(101) });
    assert.equal(tooLong.status, 400);
    assert.equal((await bodyOf(tooLong)).error?.code, "invalid_payload");

    assert.deepEqual(await listData(await listCards()), []);
  });

  // ─────────────────────────────────────────── 过滤与分页

  test(`${label}｜q 按 name 子串不分大小写；limit 夹到 1..50`, async () => {
    await postCard({ name: "Huo Ci Yuan" });
    await postCard({ name: "Lin Wan" });
    await postCard({ name: "雨夜街", kind: "scene" });

    assert.equal((await listData(await listCards("?q=huo"))).length, 1);
    assert.equal((await listData(await listCards("?q=HUO"))).length, 1, "q 必须不分大小写");
    assert.equal((await listData(await listCards("?q=不存在"))).length, 0);
    assert.equal((await listData(await listCards("?limit=2"))).length, 2);
    assert.equal((await listData(await listCards("?limit=0"))).length, 1, "limit 越界夹到下限 1");
    assert.equal((await listData(await listCards("?limit=999"))).length, 3, "limit 越界夹到上限 50");
    assert.equal((await listData(await listCards("?kind=scene"))).length, 1);
  });

  test(`${label}｜GET 响应带 Cache-Control no-store（卡库随时可变，不得被缓存）`, async () => {
    const response = await listCards();
    assert.equal(response.headers.get("cache-control"), "no-store");
  });
}
