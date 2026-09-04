import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail, resolveKey } from "../lib/client"

// 时间线写入面（B2，2026-08-31）：包 gateway（loopback）/agent/v1/timeline/ops。
// 鉴权抄 tts_speak 同款轮子：resolveKey(sessionID) → Bearer sk-biz-*，不发明新机制。
const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

// 工具面 {op, clip_id, clip_ids, to_index} → gateway 原生 {type, clipId, clipIds, toIndex}；
// 其余字段（inSec/outSec/atSec/speed/meta/clip/index/audio/track/cue/transition/group/aspect）
// 与 B1 端点逐字同名，原样透传。
function normalizeOp(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw }
  if (out.type === undefined && typeof out.op === "string") {
    out.type = out.op
    delete out.op
  }
  if (out.clipId === undefined && typeof out.clip_id === "string") {
    out.clipId = out.clip_id
    delete out.clip_id
  }
  if (out.clipIds === undefined && Array.isArray(out.clip_ids)) {
    out.clipIds = out.clip_ids
    delete out.clip_ids
  }
  if (out.toIndex === undefined && typeof out.to_index === "number") {
    out.toIndex = out.to_index
    delete out.to_index
  }
  return out
}

/** 错误体两种形状：409 为 flat {error:string, blocked, reason}；400/404/500 为 {error:{message,type,code}} */
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
    "对当前会话的时间线批量执行语言驱动的剪辑操作（REQ-EDIT-04）。原子批语义：先全验证后套用，任一 op 非法或命中锁定片段则整批拒绝（返回 timeline_locked，什么都没改）。调用前先用 timeline_query(what=state) 拿当前 clip id 与字段；成功返回的 diff 是本次字段级变更（回读确认面），不要凭记忆猜时间线状态。幂等 op（无实际变化）不 bump 版本。",
  args: {
    ops: tool.schema
      .array(
        tool.schema
          .object({
            op: tool.schema.string().describe("操作类型：add|remove|reorder|trim|split|speed|lock|unlock|group|ungroup|set_transition|set_meta|add_audio|add_subtitle|set_aspect"),
          })
          .passthrough(),
      )
      .min(1)
      .max(200)
      .describe(
        "按顺序执行的操作数组，每项 {op, clip_id?, ...参数}，秒数均为源素材秒。15 种 op 的参数与语义：\n" +
          "add：新增视频/图片片段。clip={id,path,label,duration,inSec,outSec,speed?,volume?,sceneId?,shotSize?,emotionTag?,costCoins?}（id 全时间线唯一；duration=素材总时长；成片有效时长=(outSec-inSec)/speed；0≤inSec<outSec≤duration），index?=插入位置（默认追加末尾）\n" +
          "remove：删除片段。clip_id\n" +
          "reorder：移动片段。clip_id, to_index（0 起目标下标）\n" +
          "trim：改入点/出点。clip_id, inSec?, outSec?（须 inSec<outSec 且 outSec≤duration）\n" +
          "split：在切点拆两段。clip_id, atSec（须落在 (inSec,outSec) 内且两半有效时长≥0.1s；右半自动得 <id>_b 新 id）\n" +
          "speed：变速。clip_id, speed（0.1-4；有效时长=(outSec-inSec)/speed）\n" +
          "lock：锁定片段（此后任何变更 op 整批拒绝）。clip_id\n" +
          "unlock：解锁片段。clip_id\n" +
          "group：分组标记。clip_ids（数组）, group（组名 ≤64 字符）\n" +
          "ungroup：拆组。clip_ids? 或 group?（至少一个）\n" +
          "set_transition：设置该段与下一段的转场。clip_id, transition={type,duration}（type=cut/fade 或任意 ffmpeg xfade 名；duration 0-30 秒）\n" +
          "set_meta：改语义标注。clip_id, meta={sceneId?,shotSize?,emotionTag?,costCoins?}（至少一项；costCoins≥0 为该镜头累计生成成本）\n" +
          "add_audio：加音频片段。audio={id,trackId,path,startSec,inSec,outSec,duration,volume?(0-1)}，track?={id(须等于 audio.trackId),kind(bgm|sfx|voice),muted?}\n" +
          "add_subtitle：加字幕。cue={id,startSec,endSec,text}\n" +
          "set_aspect：全时间线画幅。aspect（16:9|9:16|1:1|4:3|3:4|21:9）",
      ),
    reason: tool.schema.string().min(1).describe("一句话说明为什么做这次剪辑（进决策日志，供审计）"),
  },
  async execute(args, context) {
    let key: string
    try {
      key = await resolveKey(context.sessionID, context.abort)
    } catch (e) {
      return fail("auth_error", (e as Error).message || "无法解析 API key")
    }
    try {
      const ops = (args.ops as Record<string, unknown>[]).map(normalizeOp)
      const res = await fetch(`${GATEWAY}/agent/v1/timeline/ops?session_id=${encodeURIComponent(context.sessionID)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ ops, reason: args.reason }),
        signal: context.abort,
      })
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (res.ok) {
        return ok({
          version: data.version,
          total_duration_sec: data.total_duration_sec,
          diff: data.diff,
          affected_clips: data.affected_clips,
          note: "diff 为本次字段级变更（回读确认面）；幂等 op 不 bump 版本。",
        })
      }
      const errMsg = extractError(data, res.status)
      if (res.status === 409) {
        return fail(
          "timeline_locked",
          `镜 ${typeof data.blocked === "string" ? data.blocked : "?"} 已锁定，整批未执行：${errMsg}。确需修改先单独发 unlock op 并在 reason 说明。`,
        )
      }
      if (res.status === 400) return fail("timeline_invalid_op", errMsg)
      if (res.status === 404) return fail("timeline_session_not_found", errMsg)
      return fail(`http_${res.status}`, errMsg)
    } catch (e) {
      return fail("network_error", (e as Error).message || "gateway 不可达")
    }
  },
})
