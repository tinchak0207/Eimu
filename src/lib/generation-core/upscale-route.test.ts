// 一鍵超分動線的**路由層**行為斷言（P1-4／對稱差 D10）。
//
// 走真 handler（`POST /api/pixai/upscale`）而不是源碼字串：具名拒絕要能在 HTTP 上被看到
// （狀態碼＋code），且校準開關打開後同一支 handler 必須真的放行到下一層（認證／帳本）。
// 全程零上游呼叫：被拒的請求在檔位閘就返回，放行的請求停在認證層（無 cookie ⇒ 401）。

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

test("控面未配置時仍回 503（既有前置閘未被改動）", async () => {
  await withEnv({ ...CONFIGURED, GENERATION_CONTROL_PLANE_PROXY_ORIGIN: undefined }, async () => {
    const { status, payload } = await post({ image: "https://x/y.png" });
    assert.equal(status, 503);
    assert.equal(payload.code, undefined);
  });
});

test("4K 未校準：HTTP 400 ＋ 具名碼 upscale_4k_upstream_unverified（不靜默降級成 2K）", async () => {
  await withEnv(CONFIGURED, async () => {
    const { status, payload } = await post({ image: "https://x/y.png", tier: "4k" });
    assert.equal(status, 400);
    assert.equal(payload.code, "upscale_4k_upstream_unverified");
    assert.match(payload.message ?? "", /4k/);
  });
});

test("4K 校準開啟後同一支 handler 放行到下一層（＝閘真的開，不是文案開）", async () => {
  await withEnv({ ...CONFIGURED, UPSCALE_4K_UPSTREAM: "1" }, async () => {
    const { status, payload } = await post({ image: "https://x/y.png", tier: "4k" });
    assert.equal(TIER_GATE_CODES.has(payload.code ?? ""), false, `檔位閘仍攔下請求：${payload.code}`);
    assert.equal(status, 401, "無 cookie ⇒ 停在認證層（證明已越過檔位閘，未觸上游）");
  });
});

test("視頻產物一鍵超分：明確拒絕並具名（上游無視頻超分通道，不做假交付）", async () => {
  await withEnv(CONFIGURED, async () => {
    const { status, payload } = await post({ image: "https://x/y.mp4", mediaKind: "video" });
    assert.equal(status, 400);
    assert.equal(payload.code, "upscale_video_upstream_unsupported");
  });
});

test("未知檔位字串與超量輸入都在扣費前被具名擋下（400／413）", async () => {
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

test("C 端原圖像素尺寸寫法（WxH）走一鍵預設檔位，不被當成檔位、也不被拒", async () => {
  await withEnv(CONFIGURED, async () => {
    // 1024x1024 是原圖尺寸（計費用），不是檔位：必須越過檔位閘 → 停在認證層。
    const { status, payload } = await post({ image: "https://x/y.png", size: "1024x1024", factor: 2 });
    assert.equal(TIER_GATE_CODES.has(payload.code ?? ""), false, `像素尺寸被誤判成檔位：${payload.code}`);
    assert.equal(status, 401);
  });
});

test("非 JSON 請求體具名拒絕（舊行為是 1k 兜底＋原樣轉發＝靜默降級）", async () => {
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
// ── 後端二：gpt-image-2 生成式重繪（2026-09-30 暴君指令）──────────────────────
// 這條後端把「4K 超分」的真源從 PixAI 的 factor 換成 gpt-image-2 的 **像素 size**
// （實有渠道是 openai_images 型的 /images/edits，adapter 只送 size／quality，不送
// resolution——所以檔位必須折算成尺寸，否則就是「付 4K 的錢拿 1K 的圖」）。
// 這裡斷言的就是那個折算：檔位×比例 → 尺寸，落不進已知可交白名單就具名拒。

test("後端默認＝legacy（PixAI bridge）：不設 UPSCALE_BACKEND 不會偷偷換後端", async () => {
  const { resolveUpscaleBackend } = await import("./upscale-backend.ts");
  assert.equal(resolveUpscaleBackend({} as NodeJS.ProcessEnv), "pixai-bridge");
  assert.equal(resolveUpscaleBackend({ UPSCALE_BACKEND: "" } as NodeJS.ProcessEnv), "pixai-bridge");
  assert.equal(resolveUpscaleBackend({ UPSCALE_BACKEND: "pixai" } as NodeJS.ProcessEnv), "pixai-bridge");
  assert.equal(resolveUpscaleBackend({ UPSCALE_BACKEND: "gpt-image-2" } as NodeJS.ProcessEnv), "gpt-image-2");
  assert.equal(resolveUpscaleBackend({ UPSCALE_BACKEND: " GPT-Image-2 " } as NodeJS.ProcessEnv), "gpt-image-2");
});

test("檔位折算成像素 size：1:1 的 1k／2k／4k 分別是 1024／2048／4096（逐字進白名單）", async () => {
  const { planGptImageUpscale, UPSCALE_BACKEND_MODEL_ID } = await import("./upscale-backend.ts");
  const { DURABLE_IMAGE_SIZES } = await import("./durable-image-sizes.ts");
  const { generationModel } = await import("@/lib/generation-model-catalog");

  assert.ok(
    generationModel(UPSCALE_BACKEND_MODEL_ID)?.resolutions.includes("4k"),
    "4K 檔位的真源＝模型宣告了 4k（宣告沒有就不該賣）",
  );

  const expected: Record<string, string> = { "1k": "1024x1024", "2k": "2048x2048", "4k": "4096x4096" };
  for (const [tier, size] of Object.entries(expected)) {
    const planned = planGptImageUpscale({ tier, ratio: "1:1" });
    assert.equal(planned.ok, true, `1:1 的 ${tier} 應該可規劃：${planned.ok ? "" : planned.message}`);
    if (!planned.ok) continue;
    assert.equal(planned.plan.size, size);
    assert.equal(planned.plan.resolution, tier);
    assert.equal(planned.plan.modelId, UPSCALE_BACKEND_MODEL_ID);
    assert.ok(DURABLE_IMAGE_SIZES.includes(planned.plan.size), `${size} 必須在已知可交白名單內`);
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

test("沒有已知可交尺寸的 檔位×比例 具名拒（不靜默降級成較低檔位）", async () => {
  const { planGptImageUpscale } = await import("./upscale-backend.ts");

  // 3:2 的 2k 折算成 3072x2048：上游沒收過這個尺寸 ⇒ 拒，且不退回 1k。
  const refused = planGptImageUpscale({ tier: "2k", ratio: "3:2" });
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.equal(refused.code, "upscale_backend_size_unavailable");
    assert.match(refused.message, /3072x2048/);
  }
  // 16:9 的 1k 折算成 1792x1024，同樣不在已知可交集合內 ⇒ 拒（與 generations 的 size 契約一致）。
  const wide = planGptImageUpscale({ tier: "1k", sourcePixels: { width: 1920, height: 1080 } });
  assert.equal(wide.ok, false);
  if (!wide.ok) assert.equal(wide.code, "upscale_backend_size_unavailable");
});

test("原圖比例被貼近到可提交比例，並如實回報偏差（不靜默失真）", async () => {
  const { planGptImageUpscale } = await import("./upscale-backend.ts");

  // 1.9:1 不在 COMMON_IMAGE_RATIOS 內（最近的是 16:9=1.777…）⇒ 折算並報偏差（比例本身仍照實回報）。
  const snapped = planGptImageUpscale({ tier: "1k", sourcePixels: { width: 1900, height: 1000 } });
  assert.equal(snapped.ok, false, "16:9 的 1k 沒有已知可交尺寸 ⇒ 具名拒");
  if (!snapped.ok) assert.equal(snapped.code, "upscale_backend_size_unavailable");

  // 1.5:1 貼近 3:2（偏差 0）——這是可交組合，順便把 ratioSource／deviation 一起驗。
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

test("B 端 handler 可被載入且在無憑證時停在認證層（模組圖未因換後端而斷）", async () => {
  const { POST: postUpscale } = await import("../../app/api/v1/upscale/route.ts");
  const response = await postUpscale(new Request("https://site.test/v1/upscale", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: "https://x/y.png", tier: "2k" }),
  }) as never);
  assert.equal(response.status, 401);
});

// ── 對外文件與執行端同源（P1-4）：OpenAPI 的檔位列舉不得偏離實作常數 ──────────
// 走真 handler（`GET /v1/openapi.json`）取**服務出去的文件**，oracle＝執行端常數
// （UPSCALE_TIERS／檔位契約／上游 bridge 的比例表）。文件說 4K 可提交、執行端卻拒，
// 或反之，都會在這裡紅。
test("OpenAPI 的檔位契約與執行端同源：列舉、配對、具名閘碼三項都對得上", async () => {
  const { GET } = await import("../../app/api/v1/openapi.json/route.ts");
  const { UPSCALE_TIERS, UPSCALE_TIER_CONTRACTS, PIXAI_BRIDGE_UPSCALE_RATIO_SIZES } = await import("./upscale-tier.ts");
  const { DURABLE_IMAGE_SIZES } = await import("./durable-image-sizes.ts");

  const response = await GET(new Request("https://site.test/v1/openapi.json") as never);
  const doc = (await response.json()) as {
    paths: Record<string, { post: { description: string } }>;
    components: { schemas: Record<string, { properties: Record<string, { enum?: string[] }> }> };
  };

  const schema = doc.components.schemas.UpscaleRequest;
  assert.deepEqual(schema.properties.upscale_tier.enum, [...UPSCALE_TIERS], "檔位顯式鍵的列舉必須＝執行端檔位全集");
  assert.deepEqual(
    schema.properties.size.enum,
    Object.keys(PIXAI_BRIDGE_UPSCALE_RATIO_SIZES["1:1"]),
    "size 的列舉必須＝上游 bridge 比例表實際有的基底檔（未知 size 會被上游靜默回退）",
  );

  const description = doc.paths["/upscale"].post.description;
  for (const tier of UPSCALE_TIERS) {
    const contract = UPSCALE_TIER_CONTRACTS[tier];
    assert.ok(
      description.includes(`size"${contract.bridgeSize}"×${contract.factor}`),
      `文件缺少檔位 ${tier} 的上游配對（size=${contract.bridgeSize}、factor=${contract.factor}）`,
    );
  }
  // 具名閘碼：拒絕時呼叫端看得到的 code，必須在被拒前就寫在文件上。
  for (const code of [
    "upscale_4k_upstream_unverified",
    "upscale_factor_conflict",
    "upscale_video_upstream_unsupported",
    // 後端二（gpt-image-2 生成式重繪）的具名碼與「不是保真放大」的口徑也必須揭露。
    "upscale_backend_capability_missing",
    "upscale_backend_size_unavailable",
    "upscale_backend_timeout",
  ]) {
    assert.ok(description.includes(code), `文件未揭露具名閘碼 ${code}`);
  }
  assert.ok(description.includes("重新繪製"), "文件必須說明 gpt-image-2 後端是重新繪製（不是保真像素放大）");
  // 生成端同一條紀律：size 白名單與 resolution 檔位都不得偏離執行端常數。
  const generations = doc.components.schemas.ImageGenerationRequest;
  assert.deepEqual(generations.properties.size.enum, [...DURABLE_IMAGE_SIZES], "size 列舉必須＝執行端白名單（含 4096x4096）");
  assert.deepEqual(generations.properties.resolution.enum, ["1k", "2k", "4k"], "resolution 列舉必須＝檔位全集");
  assert.ok(generations.properties.output_resolution, "resolution 的別名要揭露");

  const imageObject = doc.components.schemas.ImageObject;
  assert.ok(imageObject.properties.width && imageObject.properties.height, "回應必須揭露實測 width/height（4K 交付要可自證）");
});
