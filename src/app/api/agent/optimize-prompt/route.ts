import { NextRequest, NextResponse } from "next/server";
import { optimizeVideoPromptWithAgent } from "@/lib/agent-prompt-optimizer";
import { directImagePrompt, directVideoPrompt } from "@/lib/invisible-prompt-director";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1";

const MAX_PROMPT_LENGTH = 4000;

/** media_type 白名单。默认 image：本端点主场景是生图前的 prompt 打磨。 */
const MEDIA_TYPES = ["image", "video"] as const;
type MediaType = (typeof MEDIA_TYPES)[number];

/** image 意图发给 VPS agent 的前置指令：强制按静帧理解，抑制镜头/音频/剪辑语汇。 */
const STILL_IMAGE_AGENT_DIRECTIVE =
  "Treat this as a STILL IMAGE prompt. No camera movement, no SFX, no cuts, no temporal language.";

/** 免费层限流：每 IP 每 10 分钟最多 10 次（2026-09-02 收緊，降低規則層可蒸餾面）。 */
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT = 10;

/**
 * 进程内时间戳桶。Vercel serverless 下多实例各记一份，放行量可能略高于限额 ——
 * 尽力而为、非精确，用途是挡失控客户端与明显滥用，不是精确配额。
 */
const ipHits = new Map<string, number[]>();

function fail(status: number, message: string, code: string) {
  return NextResponse.json({ success: false, message, code }, { status });
}

/**
 * POST /api/agent/optimize-prompt — 免登录的提示词优化免费端点（免费层钩子）。
 *
 * 复用现有优化管道：Agent 层（deepseek）优先，失败回落规则层，两者皆无效才 502。
 * 可选 media_type（image|video，默认 image）：image 时 Agent 请求前置静帧指令、
 * fallback 走 directImagePrompt；video 时 Agent 直传、fallback 走 directVideoPrompt。
 * 本路由是公开免费层：不得读取任何授权头，
 * AGENT_OPTIMIZE_KEY 只在 agent-prompt-optimizer 内部使用，绝不进响应。
 */
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return fail(400, "请求体格式不正确。", "invalid_request");
  }

  const rawPrompt = body.prompt;
  if (typeof rawPrompt !== "string" || !rawPrompt.trim()) {
    return fail(400, "prompt 不能为空。", "invalid_prompt");
  }
  const prompt = rawPrompt.trim();
  if (prompt.length > MAX_PROMPT_LENGTH) {
    return fail(400, `prompt 不能超过 ${MAX_PROMPT_LENGTH} 个字符。`, "prompt_too_long");
  }

  const mediaTypeRaw = body.media_type;
  if (mediaTypeRaw !== undefined && !MEDIA_TYPES.includes(mediaTypeRaw as MediaType)) {
    return fail(400, "media_type 只能是 image 或 video。", "invalid_media_type");
  }
  const mediaType: MediaType = mediaTypeRaw === "video" ? "video" : "image";

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const now = Date.now();
  const cutoff = now - RATE_WINDOW_MS;
  const hits = (ipHits.get(ip) ?? []).filter((timestamp) => timestamp > cutoff);
  if (hits.length >= RATE_LIMIT) {
    return fail(429, "请求过于频繁，请稍后再试。", "rate_limited");
  }
  hits.push(now);
  ipHits.set(ip, hits);

  // Agent 路径（VPS）：image 意图前置静帧指令，video 保持原样直传。
  const agentPrompt =
    mediaType === "image" ? `${STILL_IMAGE_AGENT_DIRECTIVE}\n${prompt}` : prompt;
  const agent = await optimizeVideoPromptWithAgent(agentPrompt);
  if (agent.ok) {
    return NextResponse.json({
      success: true,
      data: {
        prompt: agent.prompt,
        media_type: mediaType,
        usedAgent: true,
        ...(agent.model !== undefined ? { model: agent.model } : {}),
        ...(agent.ms !== undefined ? { ms: agent.ms } : {}),
      },
    });
  }

  // 规则层 fallback：按媒体类型分流。默认 image——插件主场景是生图。
  const ruled = mediaType === "video" ? directVideoPrompt(prompt) : directImagePrompt(prompt);
  if (ruled !== prompt) {
    return NextResponse.json({
      success: true,
      data: { prompt: ruled, media_type: mediaType, usedAgent: false },
    });
  }

  return fail(502, "提示词优化服务暂不可用，请稍后再试。", "optimize_failed");
}
