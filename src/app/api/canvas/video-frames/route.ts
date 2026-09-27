// POST /api/canvas/video-frames — 视频节点「截帧 / 序列帧」的时间点计划接口。
//
// 为什么服务端只算计划、不抽像素：抽帧走 <video> + <canvas>
// （video-frames.ts 的 extractFramesAtTimes / extractVideoFrames），只有浏览器
// 有解码器。服务端要抽像素就得上 ffmpeg，那是第二份实现（本项目禁造轮子，
// 且 Vercel 无 ffmpeg）。因此本路由的职责 = 鉴权 + 入参校验 + 用与服务端同一份
// 纯函数 planFrameExtraction 算计划；像素由客户端 extractFramesAtTimes 执行，
// 响应里 execution:"client" 明确这一点。
//
// 认证：requireVerifiedUser（上游 /api/user/self 验证身份，不信任 x-user-id）。
import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedUser } from "@/lib/server-user";
import {
  MAX_SEQUENCE_FRAMES,
  formatFrameTime,
  planFrameExtraction,
} from "@/lib/video-frames";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function fail(status: number, message: string, code: string): NextResponse {
  return NextResponse.json({ success: false, error: message, code }, { status });
}

/** 只收 https 公网地址；服务端不 fetch，故无 SSRF 面（像素在客户端取）。 */
function parseVideoUrl(raw: unknown): { ok: true; url: string } | { ok: false; reason: string } {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { ok: false, reason: "缺少 videoUrl。" };
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: "videoUrl 不是合法网址。" };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, reason: "仅支持 https 视频地址。" };
  }
  return { ok: true, url: parsed.toString() };
}

/** 缺省 undefined 保持缺省（planFrameExtraction 靠它区分「没给」与「给了 0」）。 */
function optionalNumber(raw: unknown): number | undefined {
  return raw === undefined || raw === null ? undefined : Number(raw);
}

export async function POST(req: NextRequest) {
  const caller = await requireVerifiedUser(req);
  if (!caller.ok) return fail(caller.status, caller.message, "unauthorized");

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return fail(400, "请求体必须是合法 JSON", "invalid_json");
  }

  const urlResult = parseVideoUrl(body?.videoUrl);
  if (!urlResult.ok) return fail(400, urlResult.reason, "invalid_video_url");

  const mode = body?.mode;
  if (mode !== "current" && mode !== "sequence") {
    return fail(400, "mode 必须是 current 或 sequence", "invalid_plan");
  }

  const durationSec = Number(body?.durationSec);
  const plan = planFrameExtraction({
    durationSec,
    mode,
    intervalSec: optionalNumber(body?.intervalSec),
    count: optionalNumber(body?.count),
    atSec: optionalNumber(body?.atSec),
  });
  if (!plan.ok) return fail(400, plan.reason, "invalid_plan");

  const frames = plan.timesSec.map((timeSec, index) => ({
    index,
    timeSec,
    label: formatFrameTime(timeSec),
  }));

  return NextResponse.json(
    {
      success: true,
      videoUrl: urlResult.url,
      mode,
      durationSec,
      timesSec: plan.timesSec,
      frames,
      maxFrames: MAX_SEQUENCE_FRAMES,
      execution: "client",
    },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}
