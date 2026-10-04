import { NextRequest, NextResponse } from "next/server";
import { listLoraUserState, upsertLoraUserState } from "@/lib/lora-user-state";
import { requireVerifiedUser } from "@/lib/server-user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

function fail(status: number, message: string, code: string) {
  return NextResponse.json({ success: false, message, code }, { status });
}

function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  return clean && clean.length <= max ? clean : null;
}

export async function GET(req: NextRequest) {
  const auth = await requireVerifiedUser(req);
  if (!auth.ok) return fail(auth.status, auth.message, "unauthorized");

  try {
    const items = await listLoraUserState(auth.user.id);
    return NextResponse.json({ success: true, data: { items } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[lora-preferences] list failed", error);
    return fail(503, "LoRA preferences are temporarily unavailable.", "preference_read_failed");
  }
}

export async function PATCH(req: NextRequest) {
  const auth = await requireVerifiedUser(req);
  if (!auth.ok) return fail(auth.status, auth.message, "unauthorized");

  let body: Record<string, unknown>;
  try {
    body = await req.json() as Record<string, unknown>;
  } catch {
    return fail(400, "Invalid JSON body.", "invalid_request");
  }

  const versionId = boundedString(body.versionId, 200);
  const title = boundedString(body.title, 300);
  const thumb = boundedString(body.thumb, 2_000);
  const favorite = typeof body.favorite === "boolean" ? body.favorite : undefined;
  const markUsed = body.markUsed === true;
  if (!versionId || !title || !thumb || (favorite === undefined && !markUsed)) {
    return fail(400, "A valid LoRA item and state change are required.", "invalid_request");
  }

  try {
    const item = await upsertLoraUserState({
      userId: auth.user.id,
      versionId,
      title,
      thumb,
      favorite,
      markUsed,
    });
    return NextResponse.json({ success: true, data: { item } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[lora-preferences] update failed", error);
    return fail(503, "LoRA preferences are temporarily unavailable.", "preference_write_failed");
  }
}
