// POST /api/canvas/video-frames — 视频节点「截帧 / 序列帧」的时间点计划接口。
//
// 为什么服务端只算计划、不抽像素：抽帧走 <video> + <canvas>
// （video-frames.ts 的 extractFramesAtTimes / extractVideoFrames），只有浏览器
// 有解码器。服务端要抽像素就得上 ffmpeg，那是第二份实现（本项目禁造轮子，
// 且 Vercel 无 ffmpeg）。因此本路由的职责 = 鉴权 + 入参校验 + 用与服务端同一份
// 纯函数 planFrameExtraction 算计划；像素由客户端 extractFramesAtTimes 执行，
// 响应里 execution:"client" 明确这一点。
//
// 2026-09-28：取样语义照竞品（hypit media frames/tiles）——intervalSec 走「从 0 起、
// 递增、不含片尾」的 intervalSamples，count 走等距中点的 tileSampleTimes，并新增
// mode:"at"（时间点清单，严格递增、全部 < 时长）。上限 600 帧 / 600 秒，到顶明确拒绝。
//
// 认证：requireVerifiedUser（上游 /api/user/self 验证身份，不信任 x-user-id）。
import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedUser } from "@/lib/server-user";
import {
  MAX_SEQUENCE_FRAMES,
  formatFrameTime,
  frameFileName,
  planFrameExtraction,
} from "@/lib/video-frames";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

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

/** mode:"at" 的时间点清单：必须真的是数组（非数组一律 undefined → 由计划层给出明确拒绝理由）。 */
function optionalNumberList(raw: unknown): number[] | undefined {
  return Array.isArray(raw) ? raw.map((value) => Number(value)) : undefined;
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
  if (mode !== "current" && mode !== "sequence" && mode !== "at") {
    return fail(400, "mode 必须是 current、sequence 或 at", "invalid_plan");
  }

  const durationSec = Number(body?.durationSec);
  const plan = planFrameExtraction({
    durationSec,
    mode,
    intervalSec: optionalNumber(body?.intervalSec),
    count: optionalNumber(body?.count),
    // current 收单个数（atSec: number）；at 收清单（atSec: number[]）。计划层按 mode 各自校验。
    atSec: mode === "at" ? optionalNumberList(body?.atSec) : optionalNumber(body?.atSec),
  });
  if (!plan.ok) return fail(400, plan.reason, "invalid_plan");

  const frames = plan.timesSec.map((timeSec, index) => ({
    index,
    timeSec,
    label: formatFrameTime(timeSec),
    // 帧档名（照竞品：frame-2_500s.jpg），客户端落图片节点/下载时直接用它，不再另起一套命名。
    fileName: frameFileName(timeSec),
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
