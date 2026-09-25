// `/api/biz/character-resolve` 的真行為斷言（不是源碼字串守門件）：
//   ①命中真卡（卡經 **真 HTTP API** 存進真 store）→ prompt 內 token 被片段取代 + 卡的圖進參考圖；
//   ②未命中 → token 原樣保留 + warning（fail-open）；
//   ③零 token 零參考圖 → prompt 逐位元不變；
//   ④data:image → 必須落地成公網 URL（本機無物件儲存後端 ⇒ 斷言 fail-closed 502，
//     並硬斷言回應裡**絕不出現 data: URI**——不拿 data: 冒充公網 URL）；壞圖 bytes → 400 invalid_image；
//   ⑤負控制：同一 prompt 餵空卡庫 → 不展開（證明展開來自卡庫，不是解析器恆真），存卡後再跑同一 prompt 才展開；
//   ⑥順序/去重：卡的圖在前、顯式參考圖在後、按 url 去重；
//   ⑦上限 5 張截尾 + warning（不靜默）；
//   ⑧形狀非法 400 / 未認證 401 / GET 405。
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

/** 1x1 PNG（67 bytes，真 IHDR）——用來走 data:image 分支，不是假字串。 */
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
  // 逼卡庫走 memoryStore（真 store，非 mock），並確保**沒有任何物件儲存後端**
  // （Vercel Blob / VPS image-data-api 兩條都關掉），data:image 的落地行為才可判定。
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

/** 卡經真 HTTP API 落庫（與 agent 工具走的是同一條路），回真 store 讀得到的卡。 */
async function save(body: unknown) {
  const response = await saveCard(req("/api/biz/character-cards", { method: "POST", headers: AUTH, body }));
  assert.equal(response.status, 201, "存卡必須成功（卡庫是後續斷言的前提）");
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

test("①命中真卡：prompt 內 token 就地換成卡的 prompt 片段，卡的參考圖進 reference_images", async () => {
  await save({
    name: "霍辞渊",
    kind: "character",
    prompt: "黑色羊毛真丝高领礼服，冷白皮，细长凤眼",
    reference_urls: ["https://img.example/huo-1.png"],
  });

  const response = await resolve({ prompt: "镜头里的 @[角色:霍辞渊] 站在雨里" });
  assert.equal(response.status, 200);
  const body = await bodyOf(response);
  // 期望值逐字手寫（來源是上面的用戶輸入，不是被測實現的輸出）
  assert.equal(body.prompt, "镜头里的 黑色羊毛真丝高领礼服，冷白皮，细长凤眼 站在雨里");
  assert.deepEqual(body.reference_images, ["https://img.example/huo-1.png"]);
  assert.deepEqual(body.warnings, []);
  assert.deepEqual(Object.keys(body).sort(), ["prompt", "reference_images", "warnings"], "回傳鍵集合即契約");
});

test("①b 片段為空的卡 → token 換成卡名（不是換成空字串）", async () => {
  await save({ name: "无名氏", kind: "character", prompt: "" });
  const body = await bodyOf(await resolve({ prompt: "@[角色:无名氏] 走进来" }));
  assert.equal(body.prompt, "无名氏 走进来");
});

// ─────────────────────────────────────────── ② 未命中 fail-open

test("②未命中：token 原樣保留在 prompt 裡，並有 warning（不靜默）", async () => {
  const prompt = "镜头里的 @[角色:不存在的人] 站在雨里";
  const response = await resolve({ prompt });
  assert.equal(response.status, 200);
  const body = await bodyOf(response);
  assert.equal(body.prompt, prompt, "未命中的 token 必須逐位元原樣保留");
  assert.deepEqual(body.reference_images, []);
  assert.equal(body.warnings.length, 1);
  assert.ok(body.warnings[0].includes("@[角色:不存在的人]"), "warning 必須帶未命中 token 原文");
});

// ─────────────────────────────────────────── ③ 零 token 零參考圖

test("③零 token 零參考圖：prompt 逐位元不變、參考圖空、warnings 空（零漂移）", async () => {
  const prompt = "一只猫\n坐在窗台上  看着雨（内部空白/換行必須保留）";
  const response = await resolve({ prompt });
  assert.equal(response.status, 200);
  const body = await bodyOf(response);
  assert.equal(body.prompt, prompt);
  assert.deepEqual(body.reference_images, []);
  assert.deepEqual(body.warnings, []);

  // 負對照：連 reference_images 鍵都不傳，結果相同（缺省不是錯誤）
  const bare = await bodyOf(await resolve({ prompt }));
  assert.deepEqual(bare, body);
});

// ─────────────────────────────────────────── ④ data:image 落地

test("④data:image：本機無物件儲存後端 ⇒ fail-closed 502，且回應絕不出現 data: URI（不冒充公網 URL）", async () => {
  const response = await resolve({
    prompt: "一只猫",
    reference_images: [`data:image/png;base64,${PNG_1X1}`],
  });
  const body = await bodyOf(response);
  const refs = body.reference_images ?? [];

  // 硬不變量：data: URI 不得被當成「公網 URL」回給呼叫端（錯誤訊息文字不在此限）
  assert.ok(!JSON.stringify(refs).includes("data:"), `reference_images 不得含 data: URI：${JSON.stringify(refs)}`);
  for (const url of refs) assert.ok(/^https?:\/\//i.test(url), `必須是公網 URL：${url}`);
  assert.equal(body.reference_images, undefined, "fail-closed 時不得回半套參考圖清單");

  // 本測試的 reset() 明確清掉三個後端 env ⇒ 必定走 fail-closed 分支（誠實失敗，不靜默丟圖）
  assert.equal(response.status, 502);
  assert.equal(body.error?.code, "reference_upload_failed");
  assert.ok(body.error?.trace_id);
});

test("④b 壞圖 bytes 的 data:image → 400 invalid_image（證明 data: 分支真的被校驗，不是直通）", async () => {
  const response = await resolve({
    prompt: "一只猫",
    reference_images: ["data:image/png;base64,AAAA"],
  });
  assert.equal(response.status, 400);
  const body = await bodyOf(response);
  assert.equal(body.error?.type, "invalid_request_error");
  assert.equal(body.error?.code, "invalid_image");
});

// ─────────────────────────────────────────── ⑤ 負控制：展開真的來自卡庫

test("⑤負控制：同一 prompt 餵空卡庫不展開；存卡後同一 prompt 才展開（展開來自卡庫，非解析器恆真）", async () => {
  const prompt = "镜头里的 @[角色:霍辞渊] 站在雨里";

  // 空卡庫
  const empty = await bodyOf(await resolve({ prompt }));
  assert.equal(empty.prompt, prompt, "空卡庫時 token 必須原樣保留");
  assert.equal(empty.warnings.length, 1);

  // 同一 prompt，存卡後再跑：必須展開（唯一變因就是卡庫）
  await save({ name: "霍辞渊", kind: "character", prompt: "玄色长袍" });
  const filled = await bodyOf(await resolve({ prompt }));
  assert.equal(filled.prompt, "镜头里的 玄色长袍 站在雨里");
  assert.deepEqual(filled.warnings, []);
});

test("⑤b 種類不符的卡（scene 卡叫同名）→ 不展開（負控制第二形態）", async () => {
  await save({ name: "雨夜街", kind: "scene", prompt: "霓虹雨夜街道" });
  const prompt = "@[角色:雨夜街] 走進來";
  const body = await bodyOf(await resolve({ prompt }));
  assert.equal(body.prompt, prompt, "kind 不符不得命中");
  assert.equal(body.warnings.length, 1);
});

// ─────────────────────────────────────────── ⑥ 順序與去重

test("⑥順序/去重：卡的圖在前、顯式參考圖在後，同 URL 只留首見那一份", async () => {
  await save({
    name: "霍辞渊",
    kind: "character",
    prompt: "玄色长袍",
    reference_urls: ["https://img.example/a1.png", "https://img.example/a2.png"],
  });

  const body = await bodyOf(
    await resolve({
      prompt: "@[角色:霍辞渊] 站在雨里",
      // a2 與卡的圖重複（去重後只留卡那份在前）；x 是顯式獨有的，必須排在卡圖之後
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

test("⑦上限 5 張：卡 8 張 + 顯式 3 張 = 11 → 保留前 5 張並 warning（不靜默截尾）", async () => {
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
    "上限 5：前 5 張（全來自卡）",
  );
  assert.equal(body.warnings.length, 1);
  assert.ok(body.warnings[0].includes("11"), "warning 必須報出真實總數 11");
  assert.ok(body.warnings[0].includes("5"), "warning 必須報出保留張數 5");
});

// ─────────────────────────────────────────── ⑧ 形狀與認證閘

test("⑧形狀非法 → 400（沿用 EditInputError 的碼）；未認證 → 401；GET → 405", async () => {
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
