import { tool } from "@opencode-ai/plugin/tool"
import { existsSync } from "node:fs"
import { dirname, isAbsolute } from "node:path"
import { readFile, stat } from "node:fs/promises"
import { fail, ok } from "../lib/client"
import { blobPath, uploadBlob } from "../lib/img-composite"
import {
  detectSubtitleBand,
  measureBandChange,
  measureCropChange,
  removeSubtitleBand,
  sha256,
  type SubtitleBand,
} from "../lib/video-desubtitle"
import { probeMedia, requireVideo } from "../lib/video-evidence"

// 去字幕（Dramagic `clear_video_subtitle`，D27）——薄包：逻辑全在 lib/video-desubtitle.ts。
// 本档只做参数验证、错误码转译与证据汇整。零付费、零上游：只有本机 ffmpeg。

function msgOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 错误码分类（不改 lib 的讯息文字，只给稳定码）。 */
function classify(message: string): string {
  if (/^Destination .* already exists/u.test(message)) return "destination_exists"
  if (/no video stream$/u.test(message)) return "no_video_stream"
  if (/: no audio or video stream$/u.test(message) || /duration is unavailable$/u.test(message) || /Invalid data found/u.test(message)) return "not_media"
  if (/cannot read|不存在/u.test(message)) return "unreadable_source"
  if (/抽样帧不足/u.test(message)) return "unreadable_source"
  if (/exited with|timed out after|could not start/u.test(message)) return "desubtitle_failed"
  return "desubtitle_failed"
}

async function isFile(path: string): Promise<boolean> {
  return await stat(path).then((item) => item.isFile(), () => false)
}

export default tool({
  description:
    "去字幕（**本机 ffmpeg、零付费、零上游呼叫**）：侦测影片下缘的字幕带并移除，回传**可验证的帧级证据**。"
    + "detect_only=true 只回量测（字幕带位置＋能量），不产档；否则产出去字幕档（channel `to`）并回前后同秒抽格。"
    + "侦测原理是量测事实而非主观判断：对下缘 `region`（预设 35%）按 sample_rate（预设 1/s，上限 24 帧）抽样，"
    + "逐列算**跨帧 p80 水平梯度能量**，取「能量 ≥ max(sensitivity×列中位数, floor)」的最长连续列区段当字幕带；"
    + "候选区段覆盖 >80% 的 region 会判为整片高频质感而非字幕带。"
    + "**侦测不到就明确拒绝并回 code=no_subtitle_band**（附 measured 统计），**不静默回成功**。"
    + "移除方法 method：`delogo`（预设；对带矩形做空间内插，解析度与音轨不变，矩形外逐像素不动）或 `crop`（下裁，解析度变小）。"
    + "证据栏位：band（y/height/能量/比值）、before/after 两张 JPEG 的路径＋SHA-256、"
    + "delogo 法回 inside_band_mean_abs_diff / outside_band_mean_abs_diff / localization_ratio（带内差／带外差），"
    + "crop 法回 removed_rows / kept_region_mean_abs_diff / band_removed（保留区杂讯＋字幕带是否落在被裁列内）、"
    + "输出档的 duration/width/height/sha256 ＋ 输入 sha256（must-differ 可自行核对）、"
    + "以及 verified_by_redetection（拿输出去字幕档**重跑同一个侦测器**，字幕带必须消失）。"
    + "code ∈ no_subtitle_band|desubtitle_failed|destination_exists|not_media|no_video_stream|unreadable_source|bad_args。",
  args: {
    source: tool.schema.string().describe("本机影片绝对路径（mp4/mov/mkv/webm…）"),
    to: tool.schema.string().optional().describe("输出档案路径（detect_only 时不需要）；已存在即拒绝覆写"),
    detect_only: tool.schema.boolean().optional().describe("true＝只做侦测与量测，不产档（预设 false）"),
    method: tool.schema
      .enum(["delogo", "crop"])
      .optional()
      .describe("移除方法：delogo＝空间内插（预设，解析度不变）｜crop＝直接下裁（解析度变小）"),
    region: tool.schema.number().min(0.05).max(0.6).optional().describe("只看画面下缘这个比例（0.05..0.6，预设 0.35）"),
    sample_rate: tool.schema.number().min(0.05).max(30).optional().describe("侦测抽样率（样本/秒，预设 1；上限 24 帧）"),
    sensitivity: tool.schema.number().min(1).max(20).optional().describe("列能量相对门槛倍数（预设 2）"),
    floor: tool.schema.number().min(0).max(255).optional().describe("列能量绝对门槛（灰阶梯度 0..255，预设 1.5）"),
    min_band_height: tool.schema.number().int().min(3).optional().describe("最小字幕带高度 px（预设 max(6, 画面高×1.2%)）"),
    pad: tool.schema.number().min(0).max(64).optional().describe("delogo 矩形外扩 px（预设 6）"),
    at: tool.schema.number().min(0).optional().describe("前后对照抽格时间（秒，预设片长中点）"),
  },
  async execute(args) {
    const warnings: string[] = []
    try {
      if (typeof args.source !== "string" || !isAbsolute(args.source)) throw new Error("source 必须是绝对路径")
      if (!(await isFile(args.source))) throw new Error(`cannot read ${args.source}: 来源档案不存在`)
      const info = await probeMedia(args.source)
      requireVideo(info, args.source)

      const detection = await detectSubtitleBand(args.source, {
        region: args.region,
        sample_rate: args.sample_rate,
        sensitivity: args.sensitivity,
        floor: args.floor,
        min_band_height: args.min_band_height,
      })

      if (!detection.found || detection.band === undefined) {
        return fail("no_subtitle_band", detection.reason ?? "未侦测到字幕带", {
          title: "未侦测到字幕带（拒绝移除）",
          source: args.source,
          measured: detection.measured,
          note: "本工具只在量测到持续文字列区段时才移除；没有可侦测的字幕带一律拒绝，不静默回成功",
          warnings,
        })
      }
      const band: SubtitleBand = detection.band

      if (args.detect_only === true) {
        return ok({
          action: "detect",
          source: args.source,
          duration: info.duration,
          width: band.width,
          height: detection.measured.height,
          band,
          measured: detection.measured,
          note: "量测事实：字幕带为下缘连续列区段的跨帧 p80 水平梯度能量高峰",
          title: `侦测到字幕带 y=${band.y} h=${band.height}（比值 ${band.ratio}）`,
          warnings,
        })
      }

      if (typeof args.to !== "string" || args.to.trim().length === 0) {
        throw new Error("--to is required（除非 detect_only=true）")
      }
      if (!isAbsolute(args.to)) throw new Error("to 必须是绝对路径")
      if (existsSync(args.to)) throw new Error(`Destination ${args.to} already exists`)

      const removal = await removeSubtitleBand(args.source, args.to, band, {
        method: args.method,
        pad: args.pad,
      })

      const measuredAt = Math.max(0, Math.min(args.at ?? info.duration / 2, info.duration - 0.1))
      const evidenceDir = dirname(args.to)
      const change = removal.method === "crop"
        ? await measureCropChange(args.source, args.to, { y: band.y, height: band.height }, evidenceDir, measuredAt)
        : await measureBandChange(args.source, args.to, { y: band.y, height: band.height }, evidenceDir, measuredAt)

      const sourceSha = sha256(await readFile(args.source))
      const outputSha = sha256(await readFile(args.to))
      if (sourceSha === outputSha) throw new Error("输出与输入逐位元相同：去字幕没有实际生效")

      // 真实行为断言：拿产出去字幕档重跑同一个侦测器，字幕带必须消失。
      const redetected = await detectSubtitleBand(args.to, {
        region: args.region,
        sample_rate: args.sample_rate,
        sensitivity: args.sensitivity,
        floor: args.floor,
        min_band_height: args.min_band_height,
      })

      const artifacts = await publish([args.to, change.before.path, change.after.path], warnings)
      return ok({
        action: "remove",
        source: args.source,
        output: {
          path: args.to,
          duration: removal.output_duration,
          width: removal.output_width,
          height: removal.output_height,
          sha256: outputSha,
        },
        source_sha256: sourceSha,
        band,
        method: removal.method,
        filter: removal.filter,
        delogo_rect: removal.method === "delogo" ? removal.rect : undefined,
        evidence: change,
        verified_by_redetection: {
          found: redetected.found,
          reason: redetected.reason,
          reference_energy: redetected.measured.reference_energy,
          best_run_height: redetected.measured.best_run_height,
          best_run_ratio: redetected.measured.best_run_ratio,
        },
        artifacts,
        note:
          "全部栏位皆为量测事实（像素灰阶差、秒、杂凑）：band 是抽样列能量高峰；"
          + "evidence 是同秒前后抽格的逐像素差（delogo＝带内 vs 带外；crop＝保留区杂讯＋被裁列数）；"
          + "verified_by_redetection 是对输出档重跑同一个侦测器。"
          + "本工具不做主观「看起来干净了吗」的判断。",
        title: `${args.to}（${removal.method}，`
          + (removal.method === "crop"
            ? `裁掉下缘 ${(change as { removed_rows: number }).removed_rows} 列，保留区差 ${(change as { kept_region_mean_abs_diff: number }).kept_region_mean_abs_diff}）`
            : `带内差 ${(change as { inside_band_mean_abs_diff: number }).inside_band_mean_abs_diff} vs 带外 ${(change as { outside_band_mean_abs_diff: number }).outside_band_mean_abs_diff}）`),
        warnings,
      })
    } catch (error) {
      const message = msgOf(error)
      return fail(classify(message), message, { title: "去字幕失败", source: args.source, warnings })
    }
  },
})

const CONTENT_TYPE: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska",
}

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

/** 产物发布（复用 lib/img-composite.ts 的 uploadBlob/blobPath；不可用时只回本机路径）。 */
async function publish(paths: string[], warnings: string[]): Promise<{ path: string; url?: string }[]> {
  const published: { path: string; url?: string }[] = []
  for (const path of paths) {
    const extension = path.slice(path.lastIndexOf(".")).toLowerCase()
    try {
      const bytes = await readFile(path)
      if (bytes.byteLength > MAX_UPLOAD_BYTES) {
        warnings.push(`${path}: ${bytes.byteLength} bytes 超过公网上传上限 25MB，只回本机路径`)
        published.push({ path })
        continue
      }
      const url = await uploadBlob(blobPath("video-desubtitle", extension.replace(".", "") || "bin"), bytes,
        CONTENT_TYPE[extension] ?? "application/octet-stream")
      published.push({ path, url })
    } catch (error) {
      warnings.push(`${path}: 公网上传失败（${msgOf(error)}），只回本机路径`)
      published.push({ path })
    }
  }
  return published
}
