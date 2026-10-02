import { tool } from "@opencode-ai/plugin/tool"
import { existsSync } from "node:fs"
import { mkdir, readFile } from "node:fs/promises"
import { isAbsolute } from "node:path"
import { fail, ok } from "../lib/client"
import { blobPath, uploadBlob } from "../lib/img-composite"
import { analyzeVideo, vlmProbe, type AnalyzeResult } from "../lib/video-analyze"

// 影片三合一分析（場景／人物台詞／提示詞反推）——薄包：邏輯全在 lib/video-analyze.ts。
// 場景＝複用 visualBoundaries；台詞＝複用本機 ASR 詞級時間軸；提示詞＝VLM（缺則誠實失敗）。
// 零付費預設：除非顯式 allow_paid_vision=true（須暴君逐次報備），不會發出任何付費上游請求。

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

/** 代表幀發佈（複用 lib/img-composite.ts 的 uploadBlob/blobPath）。 */
async function publish(paths: string[], warnings: string[]): Promise<{ path: string; url?: string }[]> {
  const published: { path: string; url?: string }[] = []
  for (const path of paths.slice(0, UPLOAD_LIMIT)) {
    const extension = path.slice(path.lastIndexOf(".")).toLowerCase()
    try {
      const bytes = await readFile(path)
      if (bytes.byteLength > MAX_UPLOAD_BYTES) {
        warnings.push(`${path}: ${bytes.byteLength} bytes 超過公網上傳上限 25MB，只回本機路徑`)
        published.push({ path })
        continue
      }
      const url = await uploadBlob(blobPath("video-analysis", extension.replace(".", "") || "bin"), bytes,
        CONTENT_TYPE[extension] ?? "application/octet-stream")
      published.push({ path, url })
    } catch (error) {
      warnings.push(`${path}: 公網上傳失敗（${msgOf(error)}），只回本機路徑`)
      published.push({ path })
    }
  }
  if (paths.length > UPLOAD_LIMIT) warnings.push(`另有 ${paths.length - UPLOAD_LIMIT} 張代表幀未上傳（單次上限 ${UPLOAD_LIMIT}）`)
  return published
}

export default tool({
  description:
    "影片三合一分析（**場景／人物台詞／提示詞反推**；本機優先、預設零付費）："
    + "① 場景＝複用 `visualBoundaries` 的機械式相鄰幀變化候選，切成場景並抽**每個場景中點的代表幀**（回檔名＋實際解碼時間）；"
    + "② 人物／台詞＝複用本機 loopback ASR 的**詞級時間軸**（turns＝台詞輪次，每詞 start/end 秒；本機無說話者分離，故不判「誰說的」）；"
    + "③ 提示詞反推＝需要視覺語言模型（VLM）。**本機無零付費 VLM 通道時一律回 prompt.ok=false、code=vlm_unavailable 並附 probed 清單**"
    + "（逐項列出探測過的執行檔／權重檔／loopback 端點），**絕不編造反推結果**。"
    + "付費中控通道（new-api 127.0.0.1:3001）預設 fail-closed；只有在暴君逐次報備後由呼叫端傳 allow_paid_vision=true 才會被使用。"
    + "回傳 format=eimu.video-analysis@1：media（時長/解析度/fps/有無音軌）、scenes（count/boundaries/items 代表幀）、"
    + "speech（ok/provider/language/word_count/turns）、prompt（ok 或 code＋probed）、warnings。"
    + "任一分格失敗不會讓整支工具變 ok:false——三格各自帶 ok/code/reason。"
    + "code ∈ analyze_failed|not_media|no_video_stream|unreadable_source|bad_args。",
  args: {
    source: tool.schema.string().describe("本機影片絕對路徑（mp4/mov/mkv/webm…）"),
    frames_dir: tool.schema.string().describe("代表幀輸出目錄（絕對路徑；不存在會建立）"),
    scene_rate: tool.schema.number().min(1).max(120).optional().describe("場景變化取樣率（樣本/秒，預設 12）"),
    scene_threshold: tool.schema.number().min(0).max(1).optional().describe("場景變化分數門檻（0..1，預設 0.1）"),
    max_scenes: tool.schema.number().int().min(1).max(120).optional().describe("最多抽幾個場景代表幀（預設 12）"),
    language: tool.schema.string().optional().describe("台詞語言碼（en/zh/ja…）；預設 auto（由 ASR 啟發式解析）"),
    max_seconds: tool.schema.number().positive().max(1800).optional().describe("音訊時長上限（秒）；超過即 speech.ok=false、code=too_long"),
    allow_paid_vision: tool.schema
      .boolean()
      .optional()
      .describe("**付費**：true 才使用 new-api 中控的視覺模型做提示詞反推（須暴君逐次報備；預設 false＝fail-closed）"),
    detect_vlm_only: tool.schema.boolean().optional().describe("true＝只跑 VLM 通道探測並回 probed 清單，不碰影片（除錯用）"),
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
          title: `VLM 探測：本機可用=${probe.local_vlm_available}，付費中控在場=${probe.paid_channel_present}`,
          warnings,
        })
      }
      if (typeof args.source !== "string" || !isAbsolute(args.source)) throw new Error("source 必須是絕對路徑")
      if (typeof args.frames_dir !== "string" || !isAbsolute(args.frames_dir)) throw new Error("frames_dir 必須是絕對路徑")
      if (!existsSync(args.source)) throw new Error(`cannot read ${args.source}: 來源檔案不存在`)
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
        title: `分析完成：${result.scenes.count} 場景 / ${result.speech.word_count ?? 0} 詞`
          + `（${result.speech.language ?? "?"}）/ 提示詞 ${result.prompt.ok ? "已反推" : `不可用（${result.prompt.code}）`}`,
        warnings,
      })
    } catch (error) {
      const message = msgOf(error)
      return fail(classify(message), message, { title: "影片分析失敗", source: args.source, warnings })
    }
  },
})
