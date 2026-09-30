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
// 這條後端把「4K 超分」的真源從 PixAI 的 factor 換成 gpt-image-2 的 檔位×比例
// （上游變體 `firefly-gpt-image-{resolution}-{ratio}`），所以這裡斷言的是映射本身：
// 檔位逐字等於 resolution、比例必須落在模型已宣告的可提交比例內、偏差如實回報。

test("後端默認＝legacy（PixAI bridge）：不設 UPSCALE_BACKEND 不會偷偷換後端", async () => {
  const { resolveUpscaleBackend } = await import("./upscale-backend.ts");
  assert.equal(resolveUpscaleBackend({} as NodeJS.ProcessEnv), "pixai-bridge");
  assert.equal(resolveUpscaleBackend({ UPSCALE_BACKEND: "" } as NodeJS.ProcessEnv), "pixai-bridge");
  assert.equal(resolveUpscaleBackend({ UPSCALE_BACKEND: "pixai" } as NodeJS.ProcessEnv), "pixai-bridge");
  assert.equal(resolveUpscaleBackend({ UPSCALE_BACKEND: "gpt-image-2" } as NodeJS.ProcessEnv), "gpt-image-2");
  assert.equal(resolveUpscaleBackend({ UPSCALE_BACKEND: " GPT-Image-2 " } as NodeJS.ProcessEnv), "gpt-image-2");
});

test("檔位→gpt-image-2 後端參數：resolution 逐字等於檔位，比例落在模型已宣告清單內", async () => {
  const { planGptImageUpscale, UPSCALE_BACKEND_MODEL_ID } = await import("./upscale-backend.ts");
  const { generationModel } = await import("@/lib/generation-model-catalog");

  const declared = generationModel(UPSCALE_BACKEND_MODEL_ID)?.aspectRatios ?? [];
  assert.ok(declared.length > 0, "後端模型必須宣告可提交比例（否則無從挑上游變體）");
  assert.ok(
    generationModel(UPSCALE_BACKEND_MODEL_ID)?.resolutions.includes("4k"),
    "4K 檔位的真源＝模型宣告了 4k（宣告沒有就不該賣）",
  );

  for (const tier of ["1k", "2k", "4k"] as const) {
    const plan = planGptImageUpscale({ tier, sourcePixels: { width: 1200, height: 800 } });
    assert.equal(plan.resolution, tier);
    assert.equal(plan.modelId, UPSCALE_BACKEND_MODEL_ID);
    assert.ok(declared.includes(plan.ratio), `比例 ${plan.ratio} 必須在模型宣告清單內`);
    // 1200x800 = 3:2，正是宣告內的比例 ⇒ 不該被折算。
    assert.equal(plan.ratio, "3:2");
    assert.equal(plan.ratioDeviation, 0);
    assert.match(plan.prompt, /保留/);
  }
});

test("標題外的原圖比例被貼近到可提交比例，並如實回報偏差（不靜默失真）", async () => {
  const { planGptImageUpscale } = await import("./upscale-backend.ts");

  // 1.9:1 不在 COMMON_IMAGE_RATIOS 內（最近的是 16:9=1.777…）⇒ 必須折算並報偏差。
  const plan = planGptImageUpscale({ tier: "2k", sourcePixels: { width: 1900, height: 1000 } });
  assert.equal(plan.ratio, "16:9");
  assert.ok(plan.ratioDeviation > 0 && plan.ratioDeviation < 0.15, `偏差應在可見範圍內：${plan.ratioDeviation}`);
  assert.equal(plan.ratioSource, "source_pixels");

  const explicit = planGptImageUpscale({ tier: "1k", ratio: "9:16" });
  assert.equal(explicit.ratio, "9:16");
  assert.equal(explicit.ratioSource, "explicit");
  assert.equal(explicit.ratioDeviation, 0);

  const nothing = planGptImageUpscale({ tier: "1k" });
  assert.equal(nothing.ratio, "1:1");
  assert.equal(nothing.ratioSource, "default");
  assert.equal(nothing.size, "1024x1024");
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
    "upscale_backend_timeout",
  ]) {
    assert.ok(description.includes(code), `文件未揭露具名閘碼 ${code}`);
  }
  assert.ok(description.includes("重新繪製"), "文件必須說明 gpt-image-2 後端是重新繪製（不是保真像素放大）");
  const imageObject = doc.components.schemas.ImageObject;
  assert.ok(imageObject.properties.width && imageObject.properties.height, "回應必須揭露實測 width/height（4K 交付要可自證）");
});
