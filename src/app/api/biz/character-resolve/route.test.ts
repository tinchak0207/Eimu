// `/api/biz/character-resolve` 的真行为断言（不是源码字串守门件）：
//   ①命中真卡（卡经 **真 HTTP API** 存进真 store）→ prompt 内 token 被片段取代 + 卡的图进参考图；
//   ②未命中 → token 原样保留 + warning（fail-open）；
//   ③零 token 零参考图 → prompt 逐位元不变；
//   ④data:image → 必须落地成公网 URL（本机无物件储存后端 ⇒ 断言 fail-closed 502，
//     并硬断言回应里**绝不出现 data: URI**——不拿 data: 冒充公网 URL）；坏图 bytes → 400 invalid_image；
//   ⑤负控制：同一 prompt 喂空卡库 → 不展开（证明展开来自卡库，不是解析器恒真），存卡后再跑同一 prompt 才展开；
//   ⑥顺序/去重：卡的图在前、显式参考图在后、按 url 去重；
//   ⑦上限 5 张截尾 + warning（不静默）；
//   ⑧形状非法 400 / 未认证 401 / GET 405。
import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

import { hashBizApiKey } from "../../../../lib/biz-api-keys";
import { __resetBizKeyStoreForTests } from "../../../../lib/biz-api-key-store";
import { __resetCharacterCardStoreForTests } from "../../../../lib/character-card-store";
import { POST as saveCard } from "../character-cards/route";
import { GET, POST } from "./route";

const VALID_KEY = `sk-biz-${"a1b2c3d4e5f60718".repeat(2)}`;
const VALID_USER_ID = 4242;
const AUTH = { authorization: `Bearer ${VALID_KEY}` };

/** 1x1 PNG（67 bytes，真 IHDR）——用来走 data:image 分支，不是假字串。 */
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

interface ResolveBody {
  prompt?: string;
  reference_images?: string[];
  warnings?: string[];
  error?: { message: string; type: string; code: string; trace_id: string };
}

function reset() {
  delete process.env.GENERATION_DATABASE_URL;
  delete process.env.DATABASE_URL;
  // 逼卡库走 memoryStore（真 store，非 mock），并确保**没有任何物件储存后端**
  // （Vercel Blob / VPS image-data-api 两条都关掉），data:image 的落地行为才可判定。
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.IMAGE_DATA_BASE_URL;
  delete process.env.IMAGE_DATA_API_KEY;
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

async function bodyOf(response: Response): Promise<ResolveBody> {
  return (await response.json()) as ResolveBody;
}

function resolve(body: unknown, headers: Record<string, string> = AUTH) {
  return POST(req("/api/biz/character-resolve", { method: "POST", headers, body }));
}

/** 卡经真 HTTP API 落库（与 agent 工具走的是同一条路），回真 store 读得到的卡。 */
async function save(body: unknown) {
  const response = await saveCard(req("/api/biz/character-cards", { method: "POST", headers: AUTH, body }));
  assert.equal(response.status, 201, "存卡必须成功（卡库是后续断言的前提）");
  return response;
}

test.beforeEach(() => {
  reset();
});

test.after(() => {
  delete process.env.BIZ_API_KEY_HASHES;
  __resetBizKeyStoreForTests();
  __resetCharacterCardStoreForTests();
});

// ─────────────────────────────────────────── ① 命中真卡

test("①命中真卡：prompt 内 token 就地换成卡的 prompt 片段，卡的参考图进 reference_images", async () => {
  await save({
    name: "霍辞渊",
    kind: "character",
    prompt: "黑色羊毛真丝高领礼服，冷白皮，细长凤眼",
    reference_urls: ["https://img.example/huo-1.png"],
  });

  const response = await resolve({ prompt: "镜头里的 @[角色:霍辞渊] 站在雨里" });
  assert.equal(response.status, 200);
  const body = await bodyOf(response);
  // 期望值逐字手写（来源是上面的用户输入，不是被测实现的输出）
  assert.equal(body.prompt, "镜头里的 黑色羊毛真丝高领礼服，冷白皮，细长凤眼 站在雨里");
  assert.deepEqual(body.reference_images, ["https://img.example/huo-1.png"]);
  assert.deepEqual(body.warnings, []);
  assert.deepEqual(Object.keys(body).sort(), ["prompt", "reference_images", "warnings"], "回传键集合即契约");
});

test("①b 片段为空的卡 → token 换成卡名（不是换成空字串）", async () => {
  await save({ name: "无名氏", kind: "character", prompt: "" });
  const body = await bodyOf(await resolve({ prompt: "@[角色:无名氏] 走进来" }));
  assert.equal(body.prompt, "无名氏 走进来");
});

// ─────────────────────────────────────────── ② 未命中 fail-open

test("②未命中：token 原样保留在 prompt 里，并有 warning（不静默）", async () => {
  const prompt = "镜头里的 @[角色:不存在的人] 站在雨里";
  const response = await resolve({ prompt });
  assert.equal(response.status, 200);
  const body = await bodyOf(response);
  assert.equal(body.prompt, prompt, "未命中的 token 必须逐位元原样保留");
  assert.deepEqual(body.reference_images, []);
  assert.equal(body.warnings.length, 1);
  assert.ok(body.warnings[0].includes("@[角色:不存在的人]"), "warning 必须带未命中 token 原文");
});

// ─────────────────────────────────────────── ③ 零 token 零参考图

test("③零 token 零参考图：prompt 逐位元不变、参考图空、warnings 空（零漂移）", async () => {
  const prompt = "一只猫\n坐在窗台上  看着雨（内部空白/换行必须保留）";
  const response = await resolve({ prompt });
  assert.equal(response.status, 200);
  const body = await bodyOf(response);
  assert.equal(body.prompt, prompt);
  assert.deepEqual(body.reference_images, []);
  assert.deepEqual(body.warnings, []);

  // 负对照：连 reference_images 键都不传，结果相同（缺省不是错误）
  const bare = await bodyOf(await resolve({ prompt }));
  assert.deepEqual(bare, body);
});

// ─────────────────────────────────────────── ④ data:image 落地

test("④data:image：本机无物件储存后端 ⇒ fail-closed 502，且回应绝不出现 data: URI（不冒充公网 URL）", async () => {
  const response = await resolve({
    prompt: "一只猫",
    reference_images: [`data:image/png;base64,${PNG_1X1}`],
  });
  const body = await bodyOf(response);
  const refs = body.reference_images ?? [];

  // 硬不变量：data: URI 不得被当成「公网 URL」回给呼叫端（错误讯息文字不在此限）
  assert.ok(!JSON.stringify(refs).includes("data:"), `reference_images 不得含 data: URI：${JSON.stringify(refs)}`);
  for (const url of refs) assert.ok(/^https?:\/\//i.test(url), `必须是公网 URL：${url}`);
  assert.equal(body.reference_images, undefined, "fail-closed 时不得回半套参考图清单");

  // 本测试的 reset() 明确清掉三个后端 env ⇒ 必定走 fail-closed 分支（诚实失败，不静默丢图）
  assert.equal(response.status, 502);
  assert.equal(body.error?.code, "reference_upload_failed");
  assert.ok(body.error?.trace_id);
});

test("④b 坏图 bytes 的 data:image → 400 invalid_image（证明 data: 分支真的被校验，不是直通）", async () => {
  const response = await resolve({
    prompt: "一只猫",
    reference_images: ["data:image/png;base64,AAAA"],
  });
  assert.equal(response.status, 400);
  const body = await bodyOf(response);
  assert.equal(body.error?.type, "invalid_request_error");
  assert.equal(body.error?.code, "invalid_image");
});

// ─────────────────────────────────────────── ⑤ 负控制：展开真的来自卡库

test("⑤负控制：同一 prompt 喂空卡库不展开；存卡后同一 prompt 才展开（展开来自卡库，非解析器恒真）", async () => {
  const prompt = "镜头里的 @[角色:霍辞渊] 站在雨里";

  // 空卡库
  const empty = await bodyOf(await resolve({ prompt }));
  assert.equal(empty.prompt, prompt, "空卡库时 token 必须原样保留");
  assert.equal(empty.warnings.length, 1);

  // 同一 prompt，存卡后再跑：必须展开（唯一变因就是卡库）
  await save({ name: "霍辞渊", kind: "character", prompt: "玄色长袍" });
  const filled = await bodyOf(await resolve({ prompt }));
  assert.equal(filled.prompt, "镜头里的 玄色长袍 站在雨里");
  assert.deepEqual(filled.warnings, []);
});

test("⑤b 种类不符的卡（scene 卡叫同名）→ 不展开（负控制第二形态）", async () => {
  await save({ name: "雨夜街", kind: "scene", prompt: "霓虹雨夜街道" });
  const prompt = "@[角色:雨夜街] 走进来";
  const body = await bodyOf(await resolve({ prompt }));
  assert.equal(body.prompt, prompt, "kind 不符不得命中");
  assert.equal(body.warnings.length, 1);
});

// ─────────────────────────────────────────── ⑥ 顺序与去重

test("⑥顺序/去重：卡的图在前、显式参考图在后，同 URL 只留首见那一份", async () => {
  await save({
    name: "霍辞渊",
    kind: "character",
    prompt: "玄色长袍",
    reference_urls: ["https://img.example/a1.png", "https://img.example/a2.png"],
  });

  const body = await bodyOf(
    await resolve({
      prompt: "@[角色:霍辞渊] 站在雨里",
      // a2 与卡的图重复（去重后只留卡那份在前）；x 是显式独有的，必须排在卡图之后
      reference_images: [{ url: "https://img.example/a2.png" }, { url: "https://img.example/x.png", role: "style" }],
    }),
  );
  assert.deepEqual(body.reference_images, [
    "https://img.example/a1.png",
    "https://img.example/a2.png",
    "https://img.example/x.png",
  ]);
  assert.deepEqual(body.warnings, []);
});

// ─────────────────────────────────────────── ⑦ 上限截尾

test("⑦上限 5 张：卡 8 张 + 显式 3 张 = 11 → 保留前 5 张并 warning（不静默截尾）", async () => {
  await save({
    name: "参考图很多的卡",
    kind: "character",
    prompt: "玄色长袍",
    reference_urls: Array.from({ length: 8 }, (_, index) => `https://img.example/card-${index}.png`),
  });

  const explicit = Array.from({ length: 3 }, (_, index) => `https://img.example/extra-${index}.png`);
  const body = await bodyOf(await resolve({ prompt: "@[角色:参考图很多的卡] 站在雨里", reference_images: explicit }));

  assert.deepEqual(
    body.reference_images,
    Array.from({ length: 5 }, (_, index) => `https://img.example/card-${index}.png`),
    "上限 5：前 5 张（全来自卡）",
  );
  assert.equal(body.warnings.length, 1);
  assert.ok(body.warnings[0].includes("11"), "warning 必须报出真实总数 11");
  assert.ok(body.warnings[0].includes("5"), "warning 必须报出保留张数 5");
});

// ─────────────────────────────────────────── ⑧ 形状与认证闸

test("⑧形状非法 → 400（沿用 EditInputError 的码）；未认证 → 401；GET → 405", async () => {
  const notArray = await resolve({ prompt: "一只猫", reference_images: "https://img.example/a.png" });
  assert.equal(notArray.status, 400);
  assert.equal((await bodyOf(notArray)).error?.code, "invalid_reference_images");

  const tooMany = await resolve({
    prompt: "一只猫",
    reference_images: Array.from({ length: 6 }, (_, index) => `https://img.example/${index}.png`),
  });
  assert.equal(tooMany.status, 400);
  assert.equal((await bodyOf(tooMany)).error?.code, "invalid_reference_images");

  const missingPrompt = await resolve({ reference_images: ["https://img.example/a.png"] });
  assert.equal(missingPrompt.status, 400);
  assert.equal((await bodyOf(missingPrompt)).error?.code, "missing_prompt");

  const unauthenticated = await resolve({ prompt: "一只猫" }, {});
  assert.equal(unauthenticated.status, 401);
  const authBody = await bodyOf(unauthenticated);
  assert.equal(authBody.error?.type, "authentication_error");
  assert.equal(authBody.error?.code, "missing_api_key");
  assert.ok(authBody.error?.trace_id);

  const wrongMethod = await GET(req("/api/biz/character-resolve"));
  assert.equal(wrongMethod.status, 405);
  assert.equal((await bodyOf(wrongMethod)).error?.code, "method_not_allowed");
});
