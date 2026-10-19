// 一键超分动线的**路由层**行为断言（P1-4／对称差 D10）。
//
// 走真 handler（`POST /api/pixai/upscale`）而不是源码字串：具名拒绝要能在 HTTP 上被看到
// （状态码＋code），且校准开关打开后同一支 handler 必须真的放行到下一层（认证／帐本）。
// 全程零上游呼叫：被拒的请求在档位闸就返回，放行的请求停在认证层（无 cookie ⇒ 401）。

import test from "node:test";
import assert from "node:assert/strict";

import { POST } from "../../app/api/pixai/upscale/route.ts";

const TIER_GATE_CODES = new Set([
  "upscale_tier_unsupported",
  "upscale_4k_upstream_unverified",
  "upscale_tier_not_declared_by_model",
  "upscale_bridge_size_unsupported",
  "upscale_factor_conflict",
  "upscale_input_too_large",
  "upscale_video_upstream_unsupported",
  "upscale_media_kind_unsupported",
  "upscale_image_missing",
]);

function withEnv<T>(env: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const before = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    before.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return run().finally(() => {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

const CONFIGURED = {
  GENERATION_CONTROL_PLANE_PROXY_ORIGIN: "https://control.example",
  PIXAI_INTERNAL_BIZ_KEY: "test-biz-key",
  UPSCALE_4K_UPSTREAM: undefined,
};

async function post(body: unknown) {
  const response = await POST(new Request("https://site.test/api/pixai/upscale", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
  return { status: response.status, payload: (await response.json()) as { success?: boolean; code?: string; message?: string } };
}

test("控面未配置时仍回 503（既有前置闸未被改动）", async () => {
  await withEnv({ ...CONFIGURED, GENERATION_CONTROL_PLANE_PROXY_ORIGIN: undefined }, async () => {
    const { status, payload } = await post({ image: "https://x/y.png" });
    assert.equal(status, 503);
    assert.equal(payload.code, undefined);
  });
});

test("4K 未校准：HTTP 400 ＋ 具名码 upscale_4k_upstream_unverified（不静默降级成 2K）", async () => {
  await withEnv(CONFIGURED, async () => {
    const { status, payload } = await post({ image: "https://x/y.png", tier: "4k" });
    assert.equal(status, 400);
    assert.equal(payload.code, "upscale_4k_upstream_unverified");
    assert.match(payload.message ?? "", /4k/);
  });
});

test("4K 校准开启后同一支 handler 放行到下一层（＝闸真的开，不是文案开）", async () => {
  await withEnv({ ...CONFIGURED, UPSCALE_4K_UPSTREAM: "1" }, async () => {
    const { status, payload } = await post({ image: "https://x/y.png", tier: "4k" });
    assert.equal(TIER_GATE_CODES.has(payload.code ?? ""), false, `档位闸仍拦下请求：${payload.code}`);
    assert.equal(status, 401, "无 cookie ⇒ 停在认证层（证明已越过档位闸，未触上游）");
  });
});

test("视频产物一键超分：明确拒绝并具名（上游无视频超分通道，不做假交付）", async () => {
  await withEnv(CONFIGURED, async () => {
    const { status, payload } = await post({ image: "https://x/y.mp4", mediaKind: "video" });
    assert.equal(status, 400);
    assert.equal(payload.code, "upscale_video_upstream_unsupported");
  });
});

test("未知档位字串与超量输入都在扣费前被具名挡下（400／413）", async () => {
  await withEnv(CONFIGURED, async () => {
    const unknown = await post({ image: "https://x/y.png", size: "8k" });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.payload.code, "upscale_tier_unsupported");

    const oversized = Buffer.alloc(25 * 1024 * 1024 + 64, 7).toString("base64");
    const tooLarge = await post({ image: `data:image/png;base64,${oversized}` });
    assert.equal(tooLarge.status, 413);
    assert.equal(tooLarge.payload.code, "upscale_input_too_large");
  });
});

test("C 端原图像素尺寸写法（WxH）走一键预设档位，不被当成档位、也不被拒", async () => {
  await withEnv(CONFIGURED, async () => {
    // 1024x1024 是原图尺寸（计费用），不是档位：必须越过档位闸 → 停在认证层。
    const { status, payload } = await post({ image: "https://x/y.png", size: "1024x1024", factor: 2 });
    assert.equal(TIER_GATE_CODES.has(payload.code ?? ""), false, `像素尺寸被误判成档位：${payload.code}`);
    assert.equal(status, 401);
  });
});

test("非 JSON 请求体具名拒绝（旧行为是 1k 兜底＋原样转发＝静默降级）", async () => {
  await withEnv(CONFIGURED, async () => {
    const response = await POST(new Request("https://site.test/api/pixai/upscale", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    }));
    const payload = (await response.json()) as { code?: string };
    assert.equal(response.status, 400);
    assert.equal(payload.code, "upscale_request_body_invalid");
  });
});
// ── 后端二：gpt-image-2 生成式重绘（2026-09-30 项目负责人指令）──────────────────────
// 这条后端把「4K 超分」的真源从 PixAI 的 factor 换成 gpt-image-2 的 **像素 size**
// （实有渠道是 openai_images 型的 /images/edits，adapter 只送 size／quality，不送
// resolution——所以档位必须折算成尺寸，否则就是「付 4K 的钱拿 1K 的图」）。
// 这里断言的就是那个折算：档位×比例 → 尺寸，落不进已知可交白名单就具名拒。

test("后端默认＝legacy（PixAI bridge）：不设 UPSCALE_BACKEND 不会偷偷换后端", async () => {
  const { resolveUpscaleBackend } = await import("./upscale-backend.ts");
  assert.equal(resolveUpscaleBackend({} as NodeJS.ProcessEnv), "pixai-bridge");
  assert.equal(resolveUpscaleBackend({ UPSCALE_BACKEND: "" } as NodeJS.ProcessEnv), "pixai-bridge");
  assert.equal(resolveUpscaleBackend({ UPSCALE_BACKEND: "pixai" } as NodeJS.ProcessEnv), "pixai-bridge");
  assert.equal(resolveUpscaleBackend({ UPSCALE_BACKEND: "gpt-image-2" } as NodeJS.ProcessEnv), "gpt-image-2");
  assert.equal(resolveUpscaleBackend({ UPSCALE_BACKEND: " GPT-Image-2 " } as NodeJS.ProcessEnv), "gpt-image-2");
});

test("档位折算成像素 size：1:1 的 1k／2k／4k 分别是 1024／2048／4096（逐字进白名单）", async () => {
  const { planGptImageUpscale, UPSCALE_BACKEND_MODEL_ID } = await import("./upscale-backend.ts");
  const { DURABLE_IMAGE_SIZES } = await import("./durable-image-sizes.ts");
  const { generationModel } = await import("@/lib/generation-model-catalog");

  assert.ok(
    generationModel(UPSCALE_BACKEND_MODEL_ID)?.resolutions.includes("4k"),
    "4K 档位的真源＝模型宣告了 4k（宣告没有就不该卖）",
  );

  const expected: Record<string, string> = { "1k": "1024x1024", "2k": "2048x2048", "4k": "4096x4096" };
  for (const [tier, size] of Object.entries(expected)) {
    const planned = planGptImageUpscale({ tier, ratio: "1:1" });
    assert.equal(planned.ok, true, `1:1 的 ${tier} 应该可规划：${planned.ok ? "" : planned.message}`);
    if (!planned.ok) continue;
    assert.equal(planned.plan.size, size);
    assert.equal(planned.plan.resolution, tier);
    assert.equal(planned.plan.modelId, UPSCALE_BACKEND_MODEL_ID);
    assert.ok(DURABLE_IMAGE_SIZES.includes(planned.plan.size), `${size} 必须在已知可交白名单内`);
    assert.match(planned.plan.prompt, /保留/);
  }
});

test("1k 的非 1:1 尺寸（1536x1024／1024x1536）可交付，且比例不被折算", async () => {
  const { planGptImageUpscale } = await import("./upscale-backend.ts");

  const landscape = planGptImageUpscale({ tier: "1k", sourcePixels: { width: 1200, height: 800 } });
  assert.equal(landscape.ok, true);
  if (landscape.ok) {
    assert.equal(landscape.plan.ratio, "3:2");
    assert.equal(landscape.plan.ratioDeviation, 0);
    assert.equal(landscape.plan.size, "1536x1024");
  }
  const portrait = planGptImageUpscale({ tier: "1k", ratio: "2:3" });
  assert.equal(portrait.ok, true);
  if (portrait.ok) assert.equal(portrait.plan.size, "1024x1536");
});

test("没有已知可交尺寸的 档位×比例 具名拒（不静默降级成较低档位）", async () => {
  const { planGptImageUpscale } = await import("./upscale-backend.ts");

  // 3:2 的 2k 折算成 3072x2048：上游没收过这个尺寸 ⇒ 拒，且不退回 1k。
  const refused = planGptImageUpscale({ tier: "2k", ratio: "3:2" });
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.equal(refused.code, "upscale_backend_size_unavailable");
    assert.match(refused.message, /3072x2048/);
  }
  // 16:9 的 1k 折算成 1792x1024，同样不在已知可交集合内 ⇒ 拒（与 generations 的 size 契约一致）。
  const wide = planGptImageUpscale({ tier: "1k", sourcePixels: { width: 1920, height: 1080 } });
  assert.equal(wide.ok, false);
  if (!wide.ok) assert.equal(wide.code, "upscale_backend_size_unavailable");
});

test("原图比例被贴近到可提交比例，并如实回报偏差（不静默失真）", async () => {
  const { planGptImageUpscale } = await import("./upscale-backend.ts");

  // 1.9:1 不在 COMMON_IMAGE_RATIOS 内（最近的是 16:9=1.777…）⇒ 折算并报偏差（比例本身仍照实回报）。
  const snapped = planGptImageUpscale({ tier: "1k", sourcePixels: { width: 1900, height: 1000 } });
  assert.equal(snapped.ok, false, "16:9 的 1k 没有已知可交尺寸 ⇒ 具名拒");
  if (!snapped.ok) assert.equal(snapped.code, "upscale_backend_size_unavailable");

  // 1.5:1 贴近 3:2（偏差 0）——这是可交组合，顺便把 ratioSource／deviation 一起验。
  const exact = planGptImageUpscale({ tier: "1k", sourcePixels: { width: 1500, height: 1000 } });
  assert.equal(exact.ok, true);
  if (exact.ok) {
    assert.equal(exact.plan.ratio, "3:2");
    assert.equal(exact.plan.ratioSource, "source_pixels");
    assert.equal(exact.plan.ratioDeviation, 0);
  }

  const nothing = planGptImageUpscale({ tier: "1k" });
  assert.equal(nothing.ok, true);
  if (nothing.ok) {
    assert.equal(nothing.plan.ratio, "1:1");
    assert.equal(nothing.plan.ratioSource, "default");
    assert.equal(nothing.plan.size, "1024x1024");
  }
});

test("B 端 handler 可被载入且在无凭证时停在认证层（模组图未因换后端而断）", async () => {
  const { POST: postUpscale } = await import("../../app/api/v1/upscale/route.ts");
  const response = await postUpscale(new Request("https://site.test/v1/upscale", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: "https://x/y.png", tier: "2k" }),
  }) as never);
  assert.equal(response.status, 401);
});

// ── 对外文件与执行端同源（P1-4）：OpenAPI 的档位列举不得偏离实作常数 ──────────
// 走真 handler（`GET /v1/openapi.json`）取**服务出去的文件**，oracle＝执行端常数
// （UPSCALE_TIERS／档位契约／上游 bridge 的比例表）。文件说 4K 可提交、执行端却拒，
// 或反之，都会在这里红。
test("OpenAPI 的档位契约与执行端同源：列举、配对、具名闸码三项都对得上", async () => {
  const { GET } = await import("../../app/api/v1/openapi.json/route.ts");
  const { UPSCALE_TIERS, UPSCALE_TIER_CONTRACTS, PIXAI_BRIDGE_UPSCALE_RATIO_SIZES } = await import("./upscale-tier.ts");
  const { DURABLE_IMAGE_SIZES } = await import("./durable-image-sizes.ts");

  const response = await GET(new Request("https://site.test/v1/openapi.json") as never);
  const doc = (await response.json()) as {
    paths: Record<string, { post: { description: string } }>;
    components: { schemas: Record<string, { properties: Record<string, { enum?: string[] }> }> };
  };

  const schema = doc.components.schemas.UpscaleRequest;
  assert.deepEqual(schema.properties.upscale_tier.enum, [...UPSCALE_TIERS], "档位显式键的列举必须＝执行端档位全集");
  assert.deepEqual(
    schema.properties.size.enum,
    Object.keys(PIXAI_BRIDGE_UPSCALE_RATIO_SIZES["1:1"]),
    "size 的列举必须＝上游 bridge 比例表实际有的基底档（未知 size 会被上游静默回退）",
  );

  const description = doc.paths["/upscale"].post.description;
  for (const tier of UPSCALE_TIERS) {
    const contract = UPSCALE_TIER_CONTRACTS[tier];
    assert.ok(
      description.includes(`size"${contract.bridgeSize}"×${contract.factor}`),
      `文件缺少档位 ${tier} 的上游配对（size=${contract.bridgeSize}、factor=${contract.factor}）`,
    );
  }
  // 具名闸码：拒绝时呼叫端看得到的 code，必须在被拒前就写在文件上。
  for (const code of [
    "upscale_4k_upstream_unverified",
    "upscale_factor_conflict",
    "upscale_video_upstream_unsupported",
    // 后端二（gpt-image-2 生成式重绘）的具名码与「不是保真放大」的口径也必须揭露。
    "upscale_backend_capability_missing",
    "upscale_backend_size_unavailable",
    "upscale_backend_timeout",
  ]) {
    assert.ok(description.includes(code), `文件未揭露具名闸码 ${code}`);
  }
  assert.ok(description.includes("重新绘制"), "文件必须说明 gpt-image-2 后端是重新绘制（不是保真像素放大）");
  // 生成端同一条纪律：size 白名单与 resolution 档位都不得偏离执行端常数。
  const generations = doc.components.schemas.ImageGenerationRequest;
  assert.deepEqual(generations.properties.size.enum, [...DURABLE_IMAGE_SIZES], "size 列举必须＝执行端白名单（含 4096x4096）");
  assert.deepEqual(generations.properties.resolution.enum, ["1k", "2k", "4k"], "resolution 列举必须＝档位全集");
  assert.ok(generations.properties.output_resolution, "resolution 的别名要揭露");

  const imageObject = doc.components.schemas.ImageObject;
  assert.ok(imageObject.properties.width && imageObject.properties.height, "回应必须揭露实测 width/height（4K 交付要可自证）");
});

// ── 收费跟后端走（2026-10-01 项目负责人授权「4K放大后端你自己决定 做好就行」）───────────
// 真行为断言：读真 catalog 的 `imageCredits`、走真的收费／预扣函式，断言**金额本身**；
// 不是扫源码字串。病根＝4K 已改成 gpt-image-2 生成式重绘（有真实上游成本），收费却仍是
// legacy 的 0.001 币一口价（1k／2k／4k 同价 ⇒ 4K 自打成免费升级，每档赔钱）。

const CHARGE_TIERS = ["1k", "2k", "4k"] as const;

test("① gpt-image-2 后端按档位价收费（1k=1／2k=2／4k=8 币），逐档严格递增", async () => {
  const { upscaleChargeModelId, upscaleChargeQuota } = await import("./upscale-backend.ts");
  const { generationModel } = await import("@/lib/generation-model-catalog");
  const { QUOTA_PER_COIN } = await import("@/lib/quota-constants");

  // 定价键＝后端模型本身（不再是 legacy 的 pixai-upscale）。
  assert.equal(upscaleChargeModelId("gpt-image-2"), "gpt-image-2");
  // 独立 oracle：直接读 catalog 的 imageCredits 原值（不是从 generationCoins 反推）。
  const credits = generationModel("gpt-image-2")?.imageCredits;
  assert.ok(credits, "gpt-image-2 必须有 imageCredits 表，否则档位价会退回 0");
  assert.deepEqual([credits["1k"], credits["2k"], credits["4k"]], [10, 20, 80]);

  const coins = CHARGE_TIERS.map((tier) => upscaleChargeQuota("gpt-image-2", tier, QUOTA_PER_COIN) / QUOTA_PER_COIN);
  assert.deepEqual(coins, [1, 2, 8]);
  assert.ok(coins[0] < coins[1] && coins[1] < coins[2], "1k < 2k < 4k 必须严格递增（4K 不再被自己打成免费升级）");
});

test("② legacy 未被打到：pixai-bridge 后端仍是 pixai-upscale 的一口价 0.001 币（与档位无关）", async () => {
  const { upscaleChargeModelId, upscaleChargeQuota } = await import("./upscale-backend.ts");
  const { QUOTA_PER_COIN } = await import("@/lib/quota-constants");

  assert.equal(upscaleChargeModelId("pixai-bridge"), "pixai-upscale");
  const expected = Math.round(0.001 * QUOTA_PER_COIN);
  for (const tier of CHARGE_TIERS) {
    assert.equal(upscaleChargeQuota("pixai-bridge", tier, QUOTA_PER_COIN), expected, `legacy ${tier} 必须维持 0.001 币`);
  }
});

test("③ 上游不双扣：同步层收足档位价、durable 提交额恒 0（0 额快车道外呼零次）", async () => {
  const { upscaleChargeQuota, UPSCALE_UPSTREAM_BILLING_AMOUNT } = await import("./upscale-backend.ts");
  const { reserveGenerationBilling } = await import("./billing-ledger.ts");
  const { QUOTA_PER_COIN } = await import("@/lib/quota-constants");

  // 同步层真的收钱（route 的 reserveSyncCharge 用的就是这个额）。
  assert.ok(upscaleChargeQuota("gpt-image-2", "4k", QUOTA_PER_COIN) > 0, "同步层必须真的收钱");
  // route 提交上游时消费的常数恒 0（钱已在本层收过，上游再记一次＝双扣）。
  assert.equal(UPSCALE_UPSTREAM_BILLING_AMOUNT, 0, "上游提交额必须 0");

  // 真行为：billingAmount=0 的 durable 预扣走零额快车道，一次外部扣款都不发。
  let externalDebits = 0;
  const now = new Date();
  const row = {
    id: "job-zero-1", tenant_id: "biz:key-zero", api_key_id: "key-zero", billing_user_id: 7,
    source: "biz", idempotency_key: "idem-zero", request_hash: "hash", kind: "image_edit",
    routing_class: "generic", model_id: "gpt-image-2", size: "4096x4096", ratio: "1:1",
    resolution: "4k", quality: "quality", prompt_ciphertext: "v1.a.b.c",
    workflow_json: {}, response_format: "url", callback_url: null, retry_of_job_id: null,
    batch_id: null, batch_index: null, primary_artifact_id: null,
    status: "pending_billing", requested_count: 1, completed_count: 0, attempt_count: 0,
    billing_amount: 0, deadline_at: now, available_at: now, lease_owner: null,
    lease_expires_at: null, failure_class: null, failure_detail: null, failure_record_json: null,
    result_json: null, created_at: now, started_at: null, finished_at: null, updated_at: now,
  };
  const sql = (async (strings: TemplateStringsArray) => {
    const text = strings.join(" ");
    if (text.includes("UPDATE generation_job")) return [];
    if (text.includes("INSERT INTO job_events")) return [];
    if (text.includes("FROM generation_job")) return [row];
    return [];
  }) as never;
  const job = { id: "job-zero-1", billingAmount: 0 } as never;
  const adapter = { reserve: async () => { externalDebits += 1; }, refund: async () => { externalDebits += 1; } } as never;

  await reserveGenerationBilling({ job, executorId: "test", adapter }, sql);
  assert.equal(externalDebits, 0, "billingAmount=0 的提交不得再动一次上游钱包");
});

test("④ 4K 闸关闭时行为不变：一键预设仍是 2k、4K 具名拒（改价不动闸语义）", async () => {
  const { resolveUpscaleSubmission, defaultUpscaleTier } = await import("./upscale-tier.ts");

  const before = process.env.UPSCALE_4K_UPSTREAM;
  delete process.env.UPSCALE_4K_UPSTREAM;
  try {
    assert.equal(defaultUpscaleTier(["1k", "2k", "4k"]), "2k", "闸关时一键预设＝2k（不会默默收 4K 的价）");
    assert.throws(
      () => resolveUpscaleSubmission({
        declaredTiers: ["1k", "2k", "4k"],
        modelId: "pixai-upscale",
        input: { image: "https://x/y.png", tier: "4k" },
      }),
      (error: unknown) => (error as { code?: string }).code === "upscale_4k_upstream_unverified",
      "闸关时 4K 仍在档位闸被具名拒（先于计费）",
    );
  } finally {
    if (before === undefined) delete process.env.UPSCALE_4K_UPSTREAM;
    else process.env.UPSCALE_4K_UPSTREAM = before;
  }
});
