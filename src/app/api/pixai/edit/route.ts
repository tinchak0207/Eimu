// POST /api/pixai/edit
// 验证 + 按定价系统扣费（pixai-edit，基准 3 币起/按解析度浮动，admin /admin 可覆写），
// proxy 到 control plane /v1/images/edits。

import { NextResponse } from "next/server";
import { after } from "next/server";
import { authenticateImageUser } from "@/lib/image-billing";
import { refundSyncCharge, commitSyncCharge, reserveSyncCharge } from "@/lib/generation-core/sync-charge";
import { QUOTA_PER_COIN } from "@/lib/new-api-client";
import { generationCoins, resolutionFromImageSize } from "@/lib/generation-model-catalog";
import { PIXAI_EDIT_MODEL_ID } from "@/lib/image-model-ids.js";
import { syncModelPricing } from "@/lib/pricing-runtime";
import { sanitizeUpstreamBody } from "@/lib/proxy";

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

  // 先灌最新定价覆写，再按请求 size 的解析度算价扣费。
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
    // body 非 JSON 交给上游决定；计费用 1k 兜底。
  }
  const coins = generationCoins(PIXAI_EDIT_MODEL_ID, { resolution: resolutionFromImageSize(requestedSize) });
  const requiredQuota = Math.round(coins * QUOTA_PER_COIN);
  const auth = await authenticateImageUser(req.headers, requiredQuota);
  if (!auth.ok) {
    return NextResponse.json({ success: false, message: auth.message }, { status: auth.status });
  }

  // 钱走生产平面门面（V-08）：有帐本的实例留 billing_operation 列；失败一律 402 同形。
  const charged = await reserveSyncCharge({
    userId: auth.user.id,
    quota: requiredQuota,
    action: "images/edits",
    modelId: PIXAI_EDIT_MODEL_ID,
    kind: "image_edit",
    source: "web",
    tenantId: `web:${auth.user.id}`,
    requestedCount: 1,
  });
  if (!charged.ok) {
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
    // 错误路径不得原样透传上游 body（可能含内部栏位/SQL 文案）；成功路径仍逐位透传。
    const safe = sanitizeUpstreamBody(text);
    after(await refundSyncCharge(charged.charge, { status: response.status, detail: safe.slice(0, 2000) }));
    return new NextResponse(safe, {
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