// 角色卡 B 端路由的**共用斷言套件**。
//
// 為什麼要共用：`/api/v1/character-cards` 與 `/api/biz/character-cards` 是同一份實現的兩個
// 掛載點（實現只在 src/lib/biz-character-cards-route.ts）。兩邊各抄一份斷言 = 兩份會各自
// 漂移的「尺」；共用同一份斷言才能證明「兩條 route 真的代理到同一行為」。
//
// 斷言全是**真行為**（不是源碼字串守門件）：POST 一張卡 → GET 讀回同一張（逐欄相等），
// 走真 store（無 BLOB_READ_WRITE_TOKEN 時落 character-card-store 的 memoryStore，真 store
// 非 mock）＋ 真 normalizeCharacterCard；upsert 幂等；負控制（不同 name → 兩張）；
// 用戶隔離；401 閘；kind 收斂；reference_urls 非法 400。
import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

import { hashBizApiKey } from "./biz-api-keys";
import { __resetBizKeyStoreForTests } from "./biz-api-key-store";
import { __resetCharacterCardStoreForTests } from "./character-card-store";

/** 一個掛載點（route 檔）真正導出的 HTTP handler。 */
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
 * 註冊一整套斷言到 `label` 這個掛載點上（同一份斷言可對多條 route 各跑一次）。
 * 必須在測試檔的模組頂層呼叫（node:test 的 hook 註冊在呼叫當下生效）。
 */
export function registerBizCharacterCardRouteSuite(
  label: string,
  handlers: CharacterCardRouteHandlers,
): void {
  function reset() {
    delete process.env.GENERATION_DATABASE_URL;
    delete process.env.DATABASE_URL;
    delete process.env.BLOB_READ_WRITE_TOKEN; // 逼 store 走 memoryStore（真 store，非 mock）
    process.env.BIZ_API_KEY_HASHES = `${hashBizApiKey(VALID_KEY)}:${VALID_USER_ID}`;
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
    __resetBizKeyStoreForTests();
    __resetCharacterCardStoreForTests();
  });

  // ─────────────────────────────────────────── 真行為：存得下、看得到

  test(`${label}｜POST 存一張卡 → GET 讀回同一張（id/name/kind/prompt/reference_urls 逐欄相等）`, async () => {
    const input = {
      name: "霍辞渊",
      kind: "character",
      prompt: "黑色羊毛真丝高领礼服，冷白皮，细长凤眼",
      negative_prompt: "模糊, 多手",
      reference_urls: ["https://img.example/huo-1.png", "data:image/png;base64,AAAA"],
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
    assert.deepEqual(created.reference_urls, input.reference_urls);

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
    // 逐欄等價：GET 項的鍵集合就是契約那六個（內部欄位不得外洩）
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
    const response = await postCard({ name: "乱填 kind 的卡", kind: "亂七八糟" });
    assert.equal(response.status, 201);
    const created = (await bodyOf(response)).data as WireCard;
    assert.equal(created.kind, "character");

    const readBack = await listData(await listCards());
    assert.equal(readBack[0].kind, "character", "GET 读回也必须是收敛后的 kind");

    // kind 过滤器精确匹配：五值之一命中，不认识的值不收敛成 character（免得假命中）
    assert.equal((await listData(await listCards("?kind=character"))).length, 1);
    assert.equal((await listData(await listCards("?kind=亂七八糟"))).length, 0);
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
