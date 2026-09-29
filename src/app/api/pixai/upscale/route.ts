// POST /api/pixai/upscale
// 验证 + 按定价系统扣费（pixai-upscale，基准 1 币起/按解析度浮动，admin /admin 可覆写），
// proxy 到 control plane /v1/upscale。请求 body 可带 size（WxH，前端从原图读取）用于
// 解析度计费。
//
// 2026-09-29（P1-4 一键超分到 4K）：
//   - **计费口径一字不改**：仍按**输入原图**像素尺寸（resolutionFromImageSize）计价。
//   - **输出档位**改由 generation-core/upscale-tier.ts 的档位契约决定：前端不传即走
//     「一键」默认＝最高可提交档位；转发给控面的 size 恒为 bridge 白名单值（1k／2k），
//     4K 用 (size="2k", factor=4) 表达——把 "4k" 当 size 送上去会被上游静默回退 1k。
//   - 档位不可提交（4K 未校准）／媒体种类不支持／体积超限 ⇒ 具名拒绝，不静默降级。

import { NextResponse } from "next/server";
import { after } from "next/server";
import { authenticateImageUser } from "@/lib/image-billing";
import { refundSyncCharge, commitSyncCharge, reserveSyncCharge } from "@/lib/generation-core/sync-charge";
import { QUOTA_PER_COIN } from "@/lib/new-api-client";
import { declaredUpscaleTiers, generationCoins, resolutionFromImageSize } from "@/lib/generation-model-catalog";
import { resolveUpscaleSubmission, UpscaleTierError } from "@/lib/generation-core/upscale-tier";
import { PIXAI_UPSCALE_MODEL_ID } from "@/lib/image-model-ids.js";
import { syncModelPricing } from "@/lib/pricing-runtime";

export const runtime = "nodejs";
export const maxDuration = 300;
export const preferredRegion = "sfo1";

export async function POST(req: Request) {
  try {
    return await handle(req);
  } catch (error) {
    return NextResponse.json(
      { success: false, message: `Internal error: ${error instanceof Error ? error.message : String(error)}` },
      { status: 500 },
    );
  }
}

async function handle(req: Request) {
  const controlPlaneOrigin = process.env.GENERATION_CONTROL_PLANE_PROXY_ORIGIN;
  const bizKey = process.env.PIXAI_INTERNAL_BIZ_KEY;
  if (!controlPlaneOrigin) {
    return NextResponse.json({ success: false, message: "Control plane not configured." }, { status: 503 });
  }
  if (!bizKey) {
    return NextResponse.json({ success: false, message: "Control plane not configured." }, { status: 503 });
  }

  // 先灌最新定價覆寫，再按請求 size 的解析度算價扣費。
  let raw: ArrayBuffer;
  try {
    raw = await req.arrayBuffer();
  } catch (error) {
    return NextResponse.json(
      { success: false, message: `Failed to read request body: ${error instanceof Error ? error.message : String(error)}` },
      { status: 400 },
    );
  }
  await syncModelPricing();
  let parsedBody: Record<string, unknown> | null = null;
  let requestedSize: string | undefined;
  try {
    const parsed = JSON.parse(Buffer.from(raw).toString("utf8")) as Record<string, unknown>;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      parsedBody = parsed;
      if (typeof parsed.size === "string") requestedSize = parsed.size;
    }
  } catch {
    // body 非 JSON ⇒ 無法解析檔位：具名拒絕（舊行為是「1k 兜底 + 原樣轉發」，等於靜默降級）。
    return NextResponse.json(
      { success: false, code: "upscale_request_body_invalid", message: "请求体必须是 JSON 对象。" },
      { status: 400 },
    );
  }
  if (!parsedBody) {
    return NextResponse.json(
      { success: false, code: "upscale_request_body_invalid", message: "请求体必须是 JSON 对象。" },
      { status: 400 },
    );
  }

  // 输出档位（一键默认＝最高可提交档位）；size 里的 "WxH" 只作计费提示，不作档位。
  let submission: ReturnType<typeof resolveUpscaleSubmission>;
  try {
    submission = resolveUpscaleSubmission({
      declaredTiers: declaredUpscaleTiers(PIXAI_UPSCALE_MODEL_ID),
      modelId: PIXAI_UPSCALE_MODEL_ID,
      input: parsedBody,
    });
  } catch (error) {
    if (error instanceof UpscaleTierError) {
      return NextResponse.json({ success: false, code: error.code, message: error.message }, { status: error.status });
    }
    throw error;
  }

  // 计费口径不变：按输入原图尺寸归类 1k/2k/4k（与改动前逐行等价）。
  const coins = generationCoins(PIXAI_UPSCALE_MODEL_ID, { resolution: resolutionFromImageSize(requestedSize) });
  const requiredQuota = Math.round(coins * QUOTA_PER_COIN);
  const auth = await authenticateImageUser(req.headers, requiredQuota);
  if (!auth.ok) {
    return NextResponse.json({ success: false, message: auth.message }, { status: auth.status });
  }

  // 錢走生產平面門面（V-08）：有帳本的實例留 billing_operation 列；失敗一律 402 同形。
  const charged = await reserveSyncCharge({
    userId: auth.user.id,
    quota: requiredQuota,
    action: "upscale",
    modelId: PIXAI_UPSCALE_MODEL_ID,
    kind: "image_edit",
    source: "web",
    tenantId: `web:${auth.user.id}`,
    requestedCount: 1,
  });
  if (!charged.ok) {
    return NextResponse.json({ success: false, message: "余额不足，请先充值。" }, { status: 402 });
  }

  const upstreamUrl = `${controlPlaneOrigin.replace(/\/+$/, "")}/image-control/v1/upscale`;

  // 转发体：剥掉客户端传入的 size（那是原图 WxH，只用于计费；控面会当档位读），
  // 改成档位契约的 (size=bridgeSize, factor)。控面旧副本读到 "2k" 同样会透传 factor，
  // 故本次改动对旧控面也是向前兼容的（4K 档位仍需控面同步部署才生效）。
  const upstreamBody = JSON.stringify({
    ...parsedBody,
    size: submission.bridgeSize,
    factor: submission.factor,
  });

  let response: Response;
  try {
    response = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bizKey}`,
      },
      body: upstreamBody,
      signal: AbortSignal.timeout(240_000),
    });
  } catch (error) {
    after(await refundSyncCharge(charged.charge, {
      status: 502,
      detail: `Control plane request failed: ${error instanceof Error ? error.message : String(error)}`,
    }));
    return NextResponse.json(
      { success: false, message: `Control plane request failed: ${error instanceof Error ? error.message : String(error)}` },
      { status: 502 },
    );
  }

  if (!response.ok) {
    const text = await response.text();
    after(await refundSyncCharge(charged.charge, { status: response.status, detail: text.slice(0, 2000) }));
    return new NextResponse(text, {
      status: response.status < 500 ? response.status : 502,
      headers: { "Content-Type": response.headers.get("content-type") ?? "application/json" },
    });
  }

  const text = await response.text();
  after(await commitSyncCharge(charged.charge, { delivered: charged.charge.requestedCount }));
  return new NextResponse(text, {
    status: response.status,
    headers: { "Content-Type": response.headers.get("content-type") ?? "application/json" },
  });
}