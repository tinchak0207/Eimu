// POST /api/pixai/template-generations
// 验证 + 扣费 n * 5 coins，proxy 到 control plane /v1/template-generations。

import { NextResponse } from "next/server";
import { after } from "next/server";
import {
  authenticateImageUser,
  reserveImageQuota,
  refundImageQuota,
  ImageBillingRevertedError,
} from "@/lib/image-billing";
import { QUOTA_PER_COIN } from "@/lib/new-api-client";

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

  // 从 request body 解析 n（batch，预设1，上限6）。
  let batch = 1;
  try {
    const parsed = (await req.clone().json()) as { n?: number };
    if (typeof parsed.n === "number" && Number.isFinite(parsed.n)) {
      batch = Math.max(1, Math.min(6, Math.floor(parsed.n)));
    }
  } catch {
    // body 非 JSON 或为空时按 0 处理，await fails — 用 clone 解析避免消费 body。
  }

  const requiredQuota = batch * 5 * QUOTA_PER_COIN;
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

  const upstreamUrl = `${controlPlaneOrigin.replace(/\/+$/, "")}/image-control/v1/template-generations`;
  let raw: ArrayBuffer;
  try {
    raw = await req.arrayBuffer();
  } catch (error) {
    return NextResponse.json(
      { success: false, message: `Failed to read request body: ${error instanceof Error ? error.message : String(error)}` },
      { status: 400 },
    );
  }

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