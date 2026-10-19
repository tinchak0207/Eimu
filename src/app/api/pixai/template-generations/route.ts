// POST /api/pixai/template-generations
// 验证 + 扣费 n * 5 coins，proxy 到 control plane /v1/template-generations。

import { NextResponse } from "next/server";
import { after } from "next/server";
import { authenticateImageUser } from "@/lib/image-billing";
import { refundSyncCharge, commitSyncCharge, reserveSyncCharge } from "@/lib/generation-core/sync-charge";
import { QUOTA_PER_COIN } from "@/lib/new-api-client";
import { PIXAI_TEMPLATE_MODEL_ID } from "@/lib/image-model-ids.js";
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

  // 钱走生产平面门面（V-08）：有帐本的实例留 billing_operation 列；失败一律 402 同形。
  const charged = await reserveSyncCharge({
    userId: auth.user.id,
    quota: requiredQuota,
    action: "template-generations",
    modelId: PIXAI_TEMPLATE_MODEL_ID,
    kind: "image_generate",
    source: "web",
    tenantId: `web:${auth.user.id}`,
    requestedCount: batch,
  });
  if (!charged.ok) {
    return NextResponse.json({ success: false, message: "余额不足，请先充值。" }, { status: 402 });
  }

  const upstreamUrl = `${controlPlaneOrigin.replace(/\/+$/, "")}/image-control/v1/template-generations`;
  let raw: ArrayBuffer;
  try {
    raw = await req.arrayBuffer();
  } catch (error) {
    // 已预扣：读体失败也必须退（旧码漏退；帐本化后不退会卡成 submit_unknown 冻结钱）。
    after(await refundSyncCharge(charged.charge, { status: 400, detail: "Failed to read request body." }));
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
    // 错误路径不得原样透传上游 body；成功路径仍逐位透传。
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