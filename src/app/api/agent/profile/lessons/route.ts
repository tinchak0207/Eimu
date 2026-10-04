// POST /api/agent/profile/lessons —— 回合收官的静默教训提炼。
//
// 设计（用户指示：旁生静默，不让用户看到）：
//   - 前端在每轮 turnActive 落下后 fire-and-forget 调这里，无 loading、无 UI
//   - 这里收 transcript 语料 → 调网关 LLM 提炼 ≤N 条教训 → 写入 agent_lessons
//   - 提炼失败不报错返回（静默），下次再试
//   - lessons 只在用户明确确认后才进注入集合；本端点只负责「提议」，不确认
//
// 身份：复用 resolveAgentCaller（与 messages 路由一致的登录用户解析）。

import { NextRequest, NextResponse } from "next/server";
import { addAgentLesson, listAgentLessons } from "@/lib/agent-profile-store";
import { callAgentGateway } from "@/lib/agent-gateway";
import { agentCallerFailureCode, resolveAgentCaller } from "@/lib/agent-session-guard";
import type { AgentTranscriptItem } from "@/lib/agent-chat-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 与 VPS（闸道/控制面 DB，矽谷）同区：每次上游往返省一趟横跨美国（2026-10-01 效能审计）

const MAX_TRANSCRIPT_BYTES = 64 * 1024;
const MAX_LESSONS_PER_RUN = 6;
const LLM_TIMEOUT_MS = 25_000;
const MIN_TURNS_FOR_DIGEST = 2; // 至少 2 轮用户-助手往来才值得提炼

function fail(status: number, message: string, code: string): NextResponse {
  return NextResponse.json({ success: false, error: message, code }, { status });
}

/** 转录 → 紧凑文本（保留角色 + 文本/工具名，丢弃图片 base64 / 大字段）。 */
function transcriptToText(items: AgentTranscriptItem[]): string {
  const lines: string[] = [];
  for (const item of items) {
    switch (item.kind) {
      case "user":
        lines.push(`用户: ${item.text}`);
        break;
      case "assistant":
        lines.push(`助手: ${item.text}`);
        break;
      case "tool":
        lines.push(`工具[${item.status}]: ${item.tool}${item.argsSummary ? ` ${item.argsSummary}` : ""}`);
        break;
      default:
        break;
    }
  }
  return lines.join("\n");
}

/** 调网关 LLM 提炼教训。失败返回 null（静默），不 throw。 */
async function extractLessonsViaGateway(
  transcriptText: string,
  caller: { key: string },
): Promise<string[] | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
    try {
      const resp = await callAgentGateway("/agent/v1/extract-lessons", {
        method: "POST",
        key: caller.key,
        signal: controller.signal,
        body: {
          transcript: transcriptText,
          max_lessons: MAX_LESSONS_PER_RUN,
        },
      });
      if (resp.status >= 200 && resp.status < 300 && resp.json && typeof resp.json === "object") {
        const data = resp.json as { lessons?: unknown };
        if (Array.isArray(data.lessons)) {
          return data.lessons.map(String).map((s) => s.trim()).filter(Boolean).slice(0, MAX_LESSONS_PER_RUN);
        }
      }
      return null;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return null; // 静默失败
  }
}

export async function POST(req: NextRequest) {
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

  const rawSessionId = (body as { session_id?: unknown })?.session_id;
  const sessionId = typeof rawSessionId === "string" ? rawSessionId.trim() : "";
  if (!sessionId || !/^[A-Za-z0-9._-]+$/.test(sessionId)) {
    return fail(400, "会话 id 无效。", "invalid_session_id");
  }

  const rawItems = (body as { items?: unknown })?.items;
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return fail(400, "缺少会话记录。", "empty_items");
  }
  const items = rawItems as AgentTranscriptItem[];
  const transcript = transcriptToText(items);
  if (transcript.length === 0) {
    return NextResponse.json({ ok: true, lessons: [], skipped: "no_text" });
  }
  if (Buffer.byteLength(transcript) > MAX_TRANSCRIPT_BYTES) {
    return NextResponse.json({ ok: true, lessons: [], skipped: "too_large" });
  }
  const userTurnCount = items.filter((i) => i.kind === "user").length;
  if (userTurnCount < MIN_TURNS_FOR_DIGEST) {
    return NextResponse.json({ ok: true, lessons: [], skipped: "too_short" });
  }

  // 已有教训剔除：不重复写同摘要。
  const existing = await listAgentLessons(caller.userId, 20);
  const existingSummaries = new Set(existing.map((l) => l.summary));

  const lessons = await extractLessonsViaGateway(transcript, caller);
  if (!lessons) {
    return NextResponse.json({ ok: true, lessons: [], skipped: "llm_unavailable" });
  }

  const added: string[] = [];
  for (const summary of lessons) {
    if (existingSummaries.has(summary)) continue;
    await addAgentLesson({ userId: caller.userId, summary, sourceSessionId: sessionId });
    added.push(summary);
    existingSummaries.add(summary);
  }
  return NextResponse.json({ ok: true, lessons: added, skipped: undefined });
}