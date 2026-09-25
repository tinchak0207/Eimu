// /v1/images/generations 的參考圖與行內實體 tag 真行為斷言（不是源碼字串守門件）：
//   零回歸  → 無 token、無參考圖時 prompt 逐位元不變，提交命令的 workflow 展開是**空物件**；
//   真行為  → `@[角色:Kael]` 命中真卡庫 → token 就地換成卡的 prompt 片段、卡的圖進 workflow.references；
//   未命中  → token 原樣保留（fail-open）＋ warning，不報錯、不吞內容；
//   上限    → 6 張 reference_images → 400 invalid_reference_images（不靜默截斷），5 張放行；
//   負控制  → 同一個 token 餵空卡庫 → 不展開（證明上面那條的展開來自卡庫，不是解析器恆真）。
//
// 全鏈路單進程可測、零 mock：認證走 BIZ_API_KEY_HASHES 兜底層；卡庫在無
// BLOB_READ_WRITE_TOKEN 時落 character-card-store 的 memoryStore（**真 store**，非 mock）。
// route 層只覆蓋「進 I/O 之前就該拒絕」的分支（400 / 501）——durable 分支的提交 payload
// 需要真控制面 DB，由 orchestrator 的端到端驗收覆蓋（本檔不偽造）。
import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

import { hashBizApiKey } from "@/lib/biz-api-keys";
import { __resetBizKeyStoreForTests } from "@/lib/biz-api-key-store";
import { __resetCharacterCardStoreForTests, listCharacterCards, saveCharacterCard } from "@/lib/character-card-store";
import type { CharacterCard } from "@/lib/character-cards";
import {
  EditInputError,
  MAX_REFERENCE_IMAGES,
  buildGenerationWorkflow,
  generationWorkflowField,
  normalizeBizReferenceRole,
  parseReferenceImageSpecs,
  planBizGenerationInput,
  resolveEditReference,
} from "@/lib/biz-image-references";
import { POST } from "./route";

const VALID_KEY = `sk-biz-${"a1b2c3d4e5f60718".repeat(2)}`;
const USER_ID = 4242;
const AUTH = { authorization: `Bearer ${VALID_KEY}` };
const MODEL = "gpt-image-2";

/**
 * referenceRole 契约值域（`src/lib/generation-core/types.ts:36-44`）。
 * **独立 oracle**：字面量抄自契约，不是从被测实现里读出来的。
 */
const ROLE_DOMAIN = ["general", "character", "product", "style", "composition"];

const KAEL: CharacterCard = {
  id: "card-kael",
  name: "Kael",
  kind: "character",
  prompt: "silver-white undercut hair",
  references: [{ url: "https://cdn/x.png", role: "character", name: "kael-front" }],
  createdAt: "2026-09-25T00:00:00.000Z",
  updatedAt: "2026-09-25T00:00:00.000Z",
};

function reset() {
  delete process.env.GENERATION_DATABASE_URL;
  delete process.env.DATABASE_URL;
  delete process.env.GENERATION_CONTROL_PLANE_ENABLED;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  process.env.BIZ_API_KEY_HASHES = `${hashBizApiKey(VALID_KEY)}:${USER_ID}`;
  __resetBizKeyStoreForTests();
  __resetCharacterCardStoreForTests();
}

function req(body: unknown, headers: Record<string, string> = AUTH): NextRequest {
  const head = new Headers(headers);
  head.set("content-type", "application/json");
  return new NextRequest("http://localhost/v1/images/generations", {
    method: "POST",
    headers: head,
    body: JSON.stringify(body),
  });
}

async function post(body: unknown, headers: Record<string, string> = AUTH) {
  const response = await POST(req(body, headers));
  return { response, body: (await response.json()) as { error?: { code?: string; trace_id?: string; message?: string } } };
}

function planInput(prompt: string, extra: Partial<Parameters<typeof planBizGenerationInput>[0]> = {}) {
  return planBizGenerationInput({
    prompt,
    rawReferenceImages: undefined,
    tenantId: "biz:test",
    idempotencyKey: "k-test",
    ...extra,
  });
}

test.beforeEach(() => {
  reset();
});

test.after(() => {
  delete process.env.BIZ_API_KEY_HASHES;
  __resetBizKeyStoreForTests();
  __resetCharacterCardStoreForTests();
});

// ─────────────────────────────────────────── 1. 零回歸

test("零回归：无 token、无参考图 → prompt 逐位元不变，提交命令的 workflow 展开是空对象（不加 workflow 键）", async () => {
  const prompt = "一只戴墨镜的猫，霓虹雨夜，cinematic";
  let cardReads = 0;
  const plan = await planInput(prompt, {
    loadCards: async () => {
      cardReads += 1;
      throw new Error("无 token 的请求不得读卡库");
    },
  });

  assert.equal(plan.prompt, prompt, "prompt 必须逐位元不变");
  assert.deepEqual(plan.references, []);
  assert.deepEqual(plan.warnings, []);
  assert.equal(cardReads, 0, "无 token 的请求不得读卡库（零 I/O、零额外延迟）");

  // 提交命令的 workflow 展开：零键 = 与改动前的 payload 逐位元等价
  assert.equal(buildGenerationWorkflow({ references: plan.references }), undefined);
  assert.deepEqual(generationWorkflowField({ references: plan.references }), {});
  assert.equal(Object.keys(generationWorkflowField({ references: plan.references })).length, 0);

  // 阳性对照①：既有 control_nets 行为一字不变（无参考图时仍只带 metadata.controlNets）
  const nets = [{ type: "canny", image: "https://cdn/c.png" }];
  assert.deepEqual(generationWorkflowField({ references: plan.references, controlNets: nets }), {
    workflow: { metadata: { controlNets: nets } },
  });
  // 阳性对照②：真带参考图时同一个函数会多出 workflow 键（证明上一条不是恒真）
  assert.deepEqual(
    Object.keys(generationWorkflowField({
      references: [{ url: "https://cdn/x.png", mimeType: "image/png", referenceRole: "general" }],
    })),
    ["workflow"],
  );
});

// ─────────────────────────────────────────── 2. 真行为：token 命中真卡库

test("实体 tag 命中真卡库：token 就地换成卡的 prompt 片段，卡的参考图进 workflow.references（role 合法）", async () => {
  await saveCharacterCard(USER_ID, KAEL);
  const cards = await listCharacterCards(USER_ID);
  assert.equal(cards.length, 1, "前置：卡真的落进了 store（memoryStore，无 BLOB token）");

  const plan = await planInput("镜头里的 @[角色:Kael] 站在雨里", {
    loadCards: () => listCharacterCards(USER_ID),
  });

  // ① token 已被卡的片段就地取代
  assert.equal(plan.prompt, "镜头里的 silver-white undercut hair 站在雨里");
  assert.doesNotMatch(plan.prompt, /@\[/, "命中的 token 不得残留");
  assert.deepEqual(plan.warnings, []);

  // ② workflow.references 含卡的图，且 referenceRole 在契约值域内
  assert.equal(plan.references.length, 1);
  assert.equal(plan.references[0].url, "https://cdn/x.png");
  assert.equal(plan.references[0].mimeType, "image/png");
  assert.ok(
    ROLE_DOMAIN.includes(plan.references[0].referenceRole ?? ""),
    `referenceRole 必须在契约值域 ${ROLE_DOMAIN.join("/")} 内，实得 ${String(plan.references[0].referenceRole)}`,
  );

  // ③ 送进 submitGenerationCommand 的那个 workflow 对象：references 与 controlNets 互不覆盖
  const nets = [{ type: "depth", image: "https://cdn/d.png" }];
  const field = generationWorkflowField({ references: plan.references, controlNets: nets });
  assert.ok(field.workflow, "有参考图时必须带 workflow");
  assert.deepEqual(field.workflow.references?.map((reference) => reference.url), ["https://cdn/x.png"]);
  assert.deepEqual(field.workflow.metadata, { controlNets: nets });
  assert.deepEqual(Object.keys(field.workflow).sort(), ["metadata", "references"]);
});

test("卡的图在前、显式 reference_images 在后；同 URL 去重；role 缺省收敛为 general", async () => {
  await saveCharacterCard(USER_ID, KAEL);
  const plan = await planInput("参考 @[角色:Kael] 的画面", {
    rawReferenceImages: [
      "https://cdn/y.png",
      { url: "https://cdn/x.png", role: "style", name: "显式重复" },
    ],
    loadCards: () => listCharacterCards(USER_ID),
  });

  assert.deepEqual(plan.references.map((reference) => reference.url), ["https://cdn/x.png", "https://cdn/y.png"]);
  assert.equal(plan.references[0].referenceRole, "character", "卡的图用卡自己的 role（值域内原样保留）");
  assert.equal(plan.references[1].referenceRole, "general", "字符串元素无 role → general");
});

test("上限：卡的图 + 显式参考图合计超过 5 张 → 截尾并回 warning（不静默截）", async () => {
  const crowded: CharacterCard = {
    ...KAEL,
    references: Array.from({ length: 5 }, (_, index) => ({
      url: `https://cdn/card-${index}.png`,
      role: "character" as const,
      name: `card-${index}`,
    })),
  };
  await saveCharacterCard(USER_ID, crowded);
  const plan = await planInput("参考 @[角色:Kael] 的画面", {
    rawReferenceImages: ["https://cdn/extra-1.png", "https://cdn/extra-2.png"],
    loadCards: () => listCharacterCards(USER_ID),
  });

  assert.equal(plan.references.length, MAX_REFERENCE_IMAGES, "合计受 5 张上限");
  assert.deepEqual(
    plan.references.map((reference) => reference.url),
    ["https://cdn/card-0.png", "https://cdn/card-1.png", "https://cdn/card-2.png", "https://cdn/card-3.png", "https://cdn/card-4.png"],
    "保留的是卡的图（在前）——截尾截掉显式参考图",
  );
  assert.equal(plan.warnings.length, 1, "截尾必须留下可见的 warning");
  assert.match(plan.warnings[0], /5/);
});

// ─────────────────────────────────────────── 3. 未命中 fail-open

test("未命中 fail-open：token 名不存在 → prompt 原样保留 token、无 references、有 warning", async () => {
  await saveCharacterCard(USER_ID, KAEL);
  const prompt = "镜头里的 @[角色:不存在的人] 站在雨里";
  const plan = await planInput(prompt, { loadCards: () => listCharacterCards(USER_ID) });

  assert.equal(plan.prompt, prompt, "未命中的 token 必须原样保留（fail-open，不吞内容）");
  assert.deepEqual(plan.references, []);
  assert.equal(plan.warnings.length, 1, "未命中必须让调用端看得见");
  assert.match(plan.warnings[0], /不存在的人/);
});

test("卡库读取失败（Blob 抖动）→ 生成不失败：prompt 原样、token 不展开、有 warning", async () => {
  const prompt = "镜头里的 @[角色:Kael] 站在雨里";
  const plan = await planInput(prompt, {
    loadCards: async () => {
      throw new Error("blob timeout");
    },
  });

  assert.equal(plan.prompt, prompt, "卡库挂了不得让生成失败，prompt 原样提交");
  assert.deepEqual(plan.references, []);
  assert.ok(plan.warnings.some((warning) => /卡库读取失败/.test(warning)), "必须留下卡库降级的 warning");
});

// ─────────────────────────────────────────── 5. 负控制

test("负控制：同一个 token 喂空卡库 → 不展开（证明上一条的展开来自卡库，不是解析器恒真）", async () => {
  const prompt = "镜头里的 @[角色:Kael] 站在雨里";
  const plan = await planInput(prompt, { loadCards: async () => [] });

  assert.equal(plan.prompt, prompt, "卡库为空时 token 不得被展开");
  assert.deepEqual(plan.references, []);
  assert.equal(plan.warnings.length, 1);
});

test("负控制：卡存在但 kind 不符（scene 卡叫 Kael）→ 同样不展开", async () => {
  await saveCharacterCard(USER_ID, { ...KAEL, id: "card-kael-scene", kind: "scene" });
  const prompt = "镜头里的 @[角色:Kael] 站在雨里";
  const plan = await planInput(prompt, { loadCards: () => listCharacterCards(USER_ID) });

  assert.equal(plan.prompt, prompt);
  assert.deepEqual(plan.references, []);
});

// ─────────────────────────────────────────── 形状校验与 role 收敛

test("role 收敛：值域外的值（face / 乱填 / 缺省）一律 general，值域内的原样保留", () => {
  const specs = parseReferenceImageSpecs([
    "https://cdn/a.png",
    { url: "https://cdn/b.png", role: "face" },
    { url: "https://cdn/c.png", role: "style" },
    { url: "https://cdn/d.png", role: "乱填" },
  ]);
  assert.deepEqual(specs.map((spec) => spec.role), ["general", "general", "style", "general"]);
  for (const spec of specs) {
    assert.ok(ROLE_DOMAIN.includes(spec.role), "任何输出的 role 都必须在契约值域内");
  }
  assert.equal(normalizeBizReferenceRole(undefined), "general");
  assert.equal(normalizeBizReferenceRole("composition"), "composition");
});

test("形状校验：非数组 / 非 http(s)/data:image / 超过 5 张 → EditInputError(400 invalid_reference_images)", () => {
  const cases: unknown[] = [
    "https://cdn/a.png",
    ["ftp://cdn/a.png"],
    [{ url: 42 }],
    [{}],
    [null],
    Array.from({ length: 6 }, (_, index) => `https://cdn/${index}.png`),
  ];
  for (const input of cases) {
    let caught: unknown;
    try {
      parseReferenceImageSpecs(input);
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof EditInputError, `形状 ${JSON.stringify(input)} 必须抛 EditInputError`);
    assert.equal((caught as EditInputError).status, 400);
    assert.equal((caught as EditInputError).code, "invalid_reference_images");
  }
  // 边界正对照：5 张放行
  assert.equal(parseReferenceImageSpecs(Array.from({ length: 5 }, (_, index) => `https://cdn/${index}.png`)).length, 5);
});

test("搬移过来的 helper 行为不变：http(s) 直通按扩展名定 mimeType，非两种形状抛 invalid_image", async () => {
  const jpeg = await resolveEditReference("https://cdn/a.jpeg?x=1", "biz:test", "k");
  assert.deepEqual(jpeg, { url: "https://cdn/a.jpeg?x=1", mimeType: "image/jpeg", referenceRole: "general" });
  const webp = await resolveEditReference("https://cdn/a.webp", "biz:test", "k");
  assert.equal(webp.mimeType, "image/webp");

  await assert.rejects(
    () => resolveEditReference("pixai-media-id-123", "biz:test", "k"),
    (error: unknown) => error instanceof EditInputError && error.code === "invalid_image",
  );
});

// ─────────────────────────────────────────── route 层：400 / 501 分支

test("route：6 张 reference_images → 400 invalid_reference_images（不静默截断）", async () => {
  const { response, body } = await post({
    model: MODEL,
    prompt: "一只猫",
    reference_images: Array.from({ length: 6 }, (_, index) => `https://cdn.example/${index}.png`),
  });
  assert.equal(response.status, 400);
  assert.equal(body.error?.code, "invalid_reference_images");
  assert.ok(body.error?.trace_id, "400 必须带 trace_id");
});

test("route：形状非法的 reference_images → 400（不落到生成分支）", async () => {
  const notArray = await post({ model: MODEL, prompt: "一只猫", reference_images: "https://cdn.example/a.png" });
  assert.equal(notArray.response.status, 400);
  assert.equal(notArray.body.error?.code, "invalid_reference_images");

  const badScheme = await post({ model: MODEL, prompt: "一只猫", reference_images: [{ url: "ftp://cdn/a.png" }] });
  assert.equal(badScheme.response.status, 400);
  assert.equal(badScheme.body.error?.code, "invalid_reference_images");
});

test("route：控制面未启用 + 带参考图 → 501 references_require_control_plane（fail-closed，不静默丢图）", async () => {
  const five = await post({
    model: MODEL,
    prompt: "一只猫",
    reference_images: Array.from({ length: 5 }, (_, index) => `https://cdn.example/${index}.png`),
  });
  assert.equal(five.response.status, 501, "5 张（上限内）必须放行到 fail-closed 分支，不是 400");
  assert.equal(five.body.error?.code, "references_require_control_plane");
});

test("route：无参考图时不进 fail-closed 分支（零回归的 route 层对照）", async () => {
  const bare = await post({ model: MODEL, prompt: "一只猫" });
  // 无参考图 → 一路走到既有的「没有可用上游端点」检查（本机无渠道配置）：502 no_endpoints。
  // 关键是它**不是** 501 references_require_control_plane —— 新分支只咬真的带了参考图的请求。
  assert.equal(bare.response.status, 502);
  assert.equal(bare.body.error?.code, "no_endpoints");
});
