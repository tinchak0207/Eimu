// GET/PUT /api/agent/profile —— 账户画像（L0）的读取与保存。
//
// 画像 = 用户确认过的「我是谁、怎么合作」，不是模型推断。只有在这里（或
// onboarding 表单）写入；模型提炼的教训走 /profile/lessons，两者分开存储。
//
// 身份：resolveAgentCaller（与 messages / sessions 一致）。

import { NextRequest, NextResponse } from "next/server";
import { agentCallerFailureCode, resolveAgentCaller } from "@/lib/agent-session-guard";
import { loadAgentProfile, saveAgentProfile, type AgentProfile } from "@/lib/agent-profile-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 與 VPS（閘道/控制面 DB，矽谷）同區：每次上游往返省一趟橫跨美國（2026-10-01 效能審計）

function fail(status: number, message: string, code: string): NextResponse {
  return NextResponse.json({ success: false, error: message, code }, { status });
}

/** 单个字符串字段上限（防塞巨型文本）。 */
const FIELD_MAX_LENGTH = 500;
const LIST_MAX_ITEMS = 12;

function sanitizeProfile(raw: unknown): Omit<AgentProfile, "userId" | "version" | "updatedAt"> | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const str = (v: unknown): string | undefined =>
    typeof v === "string" ? v.trim().slice(0, FIELD_MAX_LENGTH) : undefined;
  const strList = (v: unknown): string[] | undefined => {
    if (!Array.isArray(v)) return undefined;
    const items = v.map((x) => (typeof x === "string" ? x.trim().slice(0, FIELD_MAX_LENGTH) : "")).filter(Boolean);
    return items.slice(0, LIST_MAX_ITEMS).length > 0 ? items.slice(0, LIST_MAX_ITEMS) : undefined;
  };
  return {
    industry: str(obj.industry) ?? undefined,
    assetTypes: strList(obj.assetTypes),
    typicalSpecs: strList(obj.typicalSpecs),
    stylePreferences: strList(obj.stylePreferences),
    prohibitions: strList(obj.prohibitions),
    habits: strList(obj.habits),
    notes: str(obj.notes) ?? undefined,
  };
}

export async function GET(req: NextRequest) {
  const caller = await resolveAgentCaller(req);
  if (!caller.ok) {
    return fail(caller.status, caller.message, agentCallerFailureCode(caller));
  }
  const profile = await loadAgentProfile(caller.userId);
  return NextResponse.json({ ok: true, profile });
}

export async function PUT(req: NextRequest) {
  const caller = await resolveAgentCaller(req);
  if (!caller.ok) {
    return fail(caller.status, caller.message, agentCallerFailureCode(caller));
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(400, "请求体格式无效。", "invalid_request");
  }
  const fields = sanitizeProfile(body);
  if (!fields) {
    return fail(400, "画像格式无效。", "invalid_profile");
  }

  const current = await loadAgentProfile(caller.userId);
  const merged = {
    ...current,
    ...fields,
    userId: caller.userId,
  };
  const { profile } = await saveAgentProfile(merged);
  return NextResponse.json({ ok: true, profile });
}