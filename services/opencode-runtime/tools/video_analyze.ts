import { tool } from "@opencode-ai/plugin/tool"
import { existsSync } from "node:fs"
import { mkdir, readFile } from "node:fs/promises"
import { isAbsolute } from "node:path"
import { fail, ok } from "../lib/client"
import { explainMissingPath } from "../lib/agent-paths"
import { blobPath, uploadBlob } from "../lib/img-composite"
import { analyzeVideo, vlmProbe, type AnalyzeResult } from "../lib/video-analyze"

// 影片三合一分析（场景／人物台词／提示词反推）——薄包：逻辑全在 lib/video-analyze.ts。
// 场景＝复用 visualBoundaries；台词＝复用本机 ASR 词级时间轴；提示词＝VLM（缺则诚实失败）。
// 零付费预设：除非显式 allow_paid_vision=true（须暴君逐次报备），不会发出任何付费上游请求。

function msgOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function classify(message: string): string {
  if (/no video stream$/u.test(message)) return "no_video_stream"
  if (/: no audio or video stream$/u.test(message) || /duration is unavailable$/u.test(message) || /Invalid data found/u.test(message)) return "not_media"
  if (/cannot read/u.test(message)) return "unreadable_source"
  if (/exited with|timed out after|could not start/u.test(message)) return "analyze_failed"
  return "analyze_failed"
}

const CONTENT_TYPE: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
}
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024
const UPLOAD_LIMIT = 24

/** 代表帧发布（复用 lib/img-composite.ts 的 uploadBlob/blobPath）。 */
async function publish(paths: string[], warnings: string[]): Promise<{ path: string; url?: string }[]> {
  const published: { path: string; url?: string }[] = []
  for (const path of paths.slice(0, UPLOAD_LIMIT)) {
    const extension = path.slice(path.lastIndexOf(".")).toLowerCase()
    try {
      const bytes = await readFile(path)
      if (bytes.byteLength > MAX_UPLOAD_BYTES) {
        warnings.push(`${path}: ${bytes.byteLength} bytes 超过公网上传上限 25MB，只回本机路径`)
        published.push({ path })
        continue
      }
      const url = await uploadBlob(blobPath("video-analysis", extension.replace(".", "") || "bin"), bytes,
        CONTENT_TYPE[extension] ?? "application/octet-stream")
      published.push({ path, url })
    } catch (error) {
      warnings.push(`${path}: 公网上传失败（${msgOf(error)}），只回本机路径`)
      published.push({ path })
    }
  }
  if (paths.length > UPLOAD_LIMIT) warnings.push(`另有 ${paths.length - UPLOAD_LIMIT} 张代表帧未上传（单次上限 ${UPLOAD_LIMIT}）`)
  return published
}

export default tool({
  description:
    "影片三合一分析（**场景／人物台词／提示词反推**；本机优先、预设零付费）："
    + "① 场景＝复用 `visualBoundaries` 的机械式相邻帧变化候选，切成场景并抽**每个场景中点的代表帧**（回档名＋实际解码时间）；"
    + "② 人物／台词＝复用本机 loopback ASR 的**词级时间轴**（turns＝台词轮次，每词 start/end 秒；本机无说话者分离，故不判「谁说的」）；"
    + "③ 提示词反推＝需要视觉语言模型（VLM）。**本机无零付费 VLM 通道时一律回 prompt.ok=false、code=vlm_unavailable 并附 probed 清单**"
    + "（逐项列出探测过的执行档／权重档／loopback 端点），**绝不编造反推结果**。"
    + "付费中控通道（new-api 127.0.0.1:3001）预设 fail-closed；只有在暴君逐次报备后由呼叫端传 allow_paid_vision=true 才会被使用。"
    + "回传 format=eimu.video-analysis@1：media（时长/解析度/fps/有无音轨）、scenes（count/boundaries/items 代表帧）、"
    + "speech（ok/provider/language/word_count/turns）、prompt（ok 或 code＋probed）、warnings。"
    + "任一分格失败不会让整支工具变 ok:false——三格各自带 ok/code/reason。"
    + "code ∈ analyze_failed|not_media|no_video_stream|unreadable_source|bad_args。",
  args: {
    source: tool.schema.string().describe("本机影片绝对路径（mp4/mov/mkv/webm…）"),
    frames_dir: tool.schema.string().describe("代表帧输出目录（绝对路径；不存在会建立）"),
    scene_rate: tool.schema.number().min(1).max(120).optional().describe("场景变化取样率（样本/秒，预设 12）"),
    scene_threshold: tool.schema.number().min(0).max(1).optional().describe("场景变化分数门槛（0..1，预设 0.1）"),
    max_scenes: tool.schema.number().int().min(1).max(120).optional().describe("最多抽几个场景代表帧（预设 12）"),
    language: tool.schema.string().optional().describe("台词语言码（en/zh/ja…）；预设 auto（由 ASR 启发式解析）"),
    max_seconds: tool.schema.number().positive().max(1800).optional().describe("音讯时长上限（秒）；超过即 speech.ok=false、code=too_long"),
    allow_paid_vision: tool.schema
      .boolean()
      .optional()
      .describe("**付费**：true 才使用 new-api 中控的视觉模型做提示词反推（须暴君逐次报备；预设 false＝fail-closed）"),
    detect_vlm_only: tool.schema.boolean().optional().describe("true＝只跑 VLM 通道探测并回 probed 清单，不碰影片（除错用）"),
  },
  async execute(args) {
    const warnings: string[] = []
    try {
      if (args.detect_vlm_only === true) {
        const probe = await vlmProbe()
        return ok({
          action: "vlm_probe",
          local_vlm_available: probe.local_vlm_available,
          paid_channel_present: probe.paid_channel_present,
          probed: probe.probed,
          note: probe.note,
          title: `VLM 探测：本机可用=${probe.local_vlm_available}，付费中控在场=${probe.paid_channel_present}`,
          warnings,
        })
      }
      if (typeof args.source !== "string" || !isAbsolute(args.source)) throw new Error("source 必须是绝对路径")
      if (typeof args.frames_dir !== "string" || !isAbsolute(args.frames_dir)) throw new Error("frames_dir 必须是绝对路径")
      if (!existsSync(args.source)) throw new Error(`cannot read ${args.source}: 来源档案不存在${explainMissingPath(args.source) ?? ""}`)
      await mkdir(args.frames_dir, { recursive: true })

      const result: AnalyzeResult = await analyzeVideo(args.source, {
        frames_dir: args.frames_dir,
        scene_rate: args.scene_rate,
        scene_threshold: args.scene_threshold,
        max_scenes: args.max_scenes,
        language: args.language,
        max_seconds: args.max_seconds,
        allow_paid_vision: args.allow_paid_vision === true,
      })

      const framePaths = result.scenes.items.flatMap((item) => (item.frame_path === undefined ? [] : [item.frame_path]))
      const artifacts = await publish(framePaths, warnings)

      return ok({
        ...result,
        artifacts,
        title: `分析完成：${result.scenes.count} 场景 / ${result.speech.word_count ?? 0} 词`
          + `（${result.speech.language ?? "?"}）/ 提示词 ${result.prompt.ok ? "已反推" : `不可用（${result.prompt.code}）`}`,
        warnings,
      })
    } catch (error) {
      const message = msgOf(error)
      return fail(classify(message), message, { title: "影片分析失败", source: args.source, warnings })
    }
  },
})
