// POST /api/pixai/upload
// 验证 user 已登入（不扣费），proxy 到 control plane /v1/uploads。
// 浏览器不带 biz key，由 Next.js server side 用 PIXAI_INTERNAL_BIZ_KEY 代打。

import { NextResponse } from "next/server";
import { authenticateImageUser } from "@/lib/image-billing";

export const runtime = "nodejs";
export const maxDuration = 60;
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／閘道／image-data-api blob／控制面）都在矽谷，同區省一趟橫跨美國（2026-10-01 效能審計）

export async function POST(req: Request) {
  const controlPlaneOrigin = process.env.GENERATION_CONTROL_PLANE_PROXY_ORIGIN;
  const bizKey = process.env.PIXAI_INTERNAL_BIZ_KEY;
  if (!controlPlaneOrigin) {
    return NextResponse.json({ success: false, message: "Control plane not configured." }, { status: 503 });
  }
  if (!bizKey) {
    return NextResponse.json({ success: false, message: "Control plane not configured." }, { status: 503 });
  }

  const authorization = req.headers.get("authorization");
  const userId = req.headers.get("x-user-id") ?? req.headers.get("New-Api-User");
  if (!authorization || !userId) {
    return NextResponse.json({ success: false, status: 401, message: "请先登录再生成图片。" }, { status: 401 });
  }

  // requiredQuota = 0：上传不扣费，只做登录校验。
  const auth = await authenticateImageUser(req.headers, 0);
  if (!auth.ok) {
    return NextResponse.json({ success: false, message: auth.message }, { status: auth.status });
  }

  // Buffer the request body and forward it explicitly; stream-body forwarding
  // (req.body as ReadableStream) is flaky under Vercel/Next.js and caused 500s.
  const upstreamUrl = `${controlPlaneOrigin.replace(/\/+$/, "")}/image-control/v1/uploads`;
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
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, message: `Control plane request failed: ${error instanceof Error ? error.message : String(error)}` },
      { status: 502 },
    );
  }

  const text = await response.text();
  return new NextResponse(text, {
    status: response.status,
    headers: { "Content-Type": response.headers.get("content-type") ?? "application/json" },
  });
}