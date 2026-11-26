import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail, resolveKey } from "../lib/client"

// 母带检查+导出闸信号层（B6，2026-08-31）：包 gateway（loopback）/agent/v1/timeline/master 端点。
// check=聚合母带检查（时长/画幅/解析度+B4 lint must+B5 mix sync_errors）；export=导出闸（blockers 非空拒绝，
// 通过则 concat 渲染+mix.wav 音轨+字幕 ASS 烧录+封面帧+probeRenderedVideo 强校验）。
// 鉴权抄 timeline_mix 同款轮子（resolveKey → Bearer）。
const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

/** 错误体两种形状：409 为 flat {error:string}；400/404/500 为 {error:{message,type,code}} */
function extractError(data: Record<string, unknown>, status: number): string {
  const e = data?.error
  if (typeof e === "string" && e) return e
  if (e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string") {
    return (e as { message: string }).message
  }
  return `HTTP ${status}`
}

export default tool({
  description:
    "母带检查与导出（REQ-EDIT-07）：check 返回聚合报告——ok/blockers（lint must 级与 mix sync_errors 会拦下导出，附 fix_hint）、duration_sec、aspect、video_resolution（首个可达源实测）、mix_compliant（响度未达 -16 不是 blocker，POST /timeline/mix 可矫正）、notes。export 走导出闸：blockers 非空直接 400 拒绝；通过则按 preset（portrait_916 竖版 1080x1920 / landscape_169 横版 1920x1080 / cinema_239 影院 1920x804）渲染 master_<preset>.mp4（clip.filter 调色+mix.wav 音轨+字幕烧录（失败自动降级）+封面帧），probeRenderedVideo 强校验容器/解析度/时长/首帧后返回 out_path/probe。妥协：xfade 转场 v1 不烧录（transitionAfter 留给前端 composeEngine 渲染）；public_url 暂不挂公网路由。",
  args: {
    action: tool.schema.enum(["check", "export"]).describe("check=母带检查报告（只检查不导出）；export=走导出闸渲染母带"),
    preset: tool.schema.enum(["portrait_916", "landscape_169", "cinema_239"]).optional().describe("export：导出预设，缺省 landscape_169"),
    with_cover: tool.schema.boolean().optional().describe("export：是否提取封面帧，缺省 true"),
  },
  async execute(args, context) {
    let key: string
    try {
      key = await resolveKey(context.sessionID, context.abort)
    } catch (e) {
      return fail("auth_error", (e as Error).message || "无法解析 API key")
    }
    const url = `${GATEWAY}/agent/v1/timeline/master?session_id=${encodeURIComponent(context.sessionID)}`
    try {
      const res = args.action === "check"
        ? await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: context.abort })
        : await fetch(url, {
            method: "POST",
            headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
            body: JSON.stringify({ preset: args.preset ?? "landscape_169", with_cover: args.with_cover !== false }),
            signal: context.abort,
          })
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (res.ok) return ok(data)
      const errMsg = extractError(data, res.status)
      if (res.status === 400) return fail("master_gate_blocked", errMsg)
      if (res.status === 404) return fail("timeline_not_found", errMsg)
      return fail(`http_${res.status}`, errMsg)
    } catch (e) {
      return fail("network_error", (e as Error).message || "gateway 不可达")
    }
  },
})
