// POST /api/pixai/edit
// 验证 + 按定价系统扣费（pixai-edit，基准 3 币起/按解析度浮动，admin /admin 可覆写），
// proxy 到 control plane /v1/images/edits。

import { NextResponse } from "next/server";
import { after } from "next/server";
import {
  authenticateImageUser,
  reserveImageQuota,
  refundImageQuota,
  ImageBillingRevertedError,
} from "@/lib/image-billing";
import { QUOTA_PER_COIN } from "@/lib/new-api-client";
import { generationCoins, resolutionFromImageSize } from "@/lib/generation-model-catalog";
import { PIXAI_EDIT_MODEL_ID } from "@/lib/image-model-ids.js";
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
  let requestedSize: string | undefined;
  try {
    const parsed = JSON.parse(Buffer.from(raw).toString("utf8")) as { size?: unknown };
    requestedSize = typeof parsed?.size === "string" ? parsed.size : undefined;
  } catch {
    // body 非 JSON 交給上游決定；計費用 1k 兜底。
  }
  const coins = generationCoins(PIXAI_EDIT_MODEL_ID, { resolution: resolutionFromImageSize(requestedSize) });
  const requiredQuota = Math.round(coins * QUOTA_PER_COIN);
  const auth = await authenticateImageUser(req.headers, requiredQuota);
  if (!auth.ok) {
    return NextResponse.json({ success: false, message: auth.message }, { status: auth.status });
  }

  try {
    await reserveImageQuota(auth.user.id, requiredQuota, auth.user.quota);
  } catch (error) {
    if (error instanceof ImageBillingRevertedError) {
      return NextResponse.json({ success: false, message: "余额不足，请先充值。" }, { status: 402 });
    }
    return NextResponse.json({ success: false, message: "余额不足，请先充值。" }, { status: 402 });
  }

  const upstreamUrl = `${controlPlaneOrigin.replace(/\/+$/, "")}/image-control/v1/images/edits`;

  let response: Response;
  try {
    response = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bizKey}`,
      },
      body: raw,
      signal: AbortSignal.timeout(240_000),
    });
  } catch (error) {
    after(() => {
      void refundImageQuota(auth.user.id, requiredQuota).catch(() => {});
    });
    return NextResponse.json(
      { success: false, message: `Control plane request failed: ${error instanceof Error ? error.message : String(error)}` },
      { status: 502 },
    );
  }

  if (!response.ok) {
    const text = await response.text();
    after(() => {
      void refundImageQuota(auth.user.id, requiredQuota).catch(() => {});
    });
    return new NextResponse(text, {
      status: response.status < 500 ? response.status : 502,
      headers: { "Content-Type": response.headers.get("content-type") ?? "application/json" },
    });
  }

  const text = await response.text();
  return new NextResponse(text, {
    status: response.status,
    headers: { "Content-Type": response.headers.get("content-type") ?? "application/json" },
  });
}