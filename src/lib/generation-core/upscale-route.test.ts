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