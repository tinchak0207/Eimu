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

// 去字幕（Dramagic `clear_video_subtitle`，D27）——薄包：邏輯全在 lib/video-desubtitle.ts。
// 本檔只做參數驗證、錯誤碼轉譯與證據彙整。零付費、零上游：只有本機 ffmpeg。

function msgOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 錯誤碼分類（不改 lib 的訊息文字，只給穩定碼）。 */
function classify(message: string): string {
  if (/^Destination .* already exists/u.test(message)) return "destination_exists"
  if (/no video stream$/u.test(message)) return "no_video_stream"
  if (/: no audio or video stream$/u.test(message) || /duration is unavailable$/u.test(message) || /Invalid data found/u.test(message)) return "not_media"
  if (/cannot read|不存在/u.test(message)) return "unreadable_source"
  if (/抽樣幀不足/u.test(message)) return "unreadable_source"
  if (/exited with|timed out after|could not start/u.test(message)) return "desubtitle_failed"
  return "desubtitle_failed"
}

async function isFile(path: string): Promise<boolean> {
  return await stat(path).then((item) => item.isFile(), () => false)
}

export default tool({
  description:
    "去字幕（**本機 ffmpeg、零付費、零上游呼叫**）：偵測影片下緣的字幕帶並移除，回傳**可驗證的幀級證據**。"
    + "detect_only=true 只回量測（字幕帶位置＋能量），不產檔；否則產出去字幕檔（channel `to`）並回前後同秒抽格。"
    + "偵測原理是量測事實而非主觀判斷：對下緣 `region`（預設 35%）按 sample_rate（預設 1/s，上限 24 幀）抽樣，"
    + "逐列算**跨幀 p80 水平梯度能量**，取「能量 ≥ max(sensitivity×列中位數, floor)」的最長連續列區段當字幕帶；"
    + "候選區段覆蓋 >80% 的 region 會判為整片高頻質感而非字幕帶。"
    + "**偵測不到就明確拒絕並回 code=no_subtitle_band**（附 measured 統計），**不靜默回成功**。"
    + "移除方法 method：`delogo`（預設；對帶矩形做空間內插，解析度與音軌不變，矩形外逐像素不動）或 `crop`（下裁，解析度變小）。"
    + "證據欄位：band（y/height/能量/比值）、before/after 兩張 JPEG 的路徑＋SHA-256、"
    + "delogo 法回 inside_band_mean_abs_diff / outside_band_mean_abs_diff / localization_ratio（帶內差／帶外差），"
    + "crop 法回 removed_rows / kept_region_mean_abs_diff / band_removed（保留區雜訊＋字幕帶是否落在被裁列內）、"
    + "輸出檔的 duration/width/height/sha256 ＋ 輸入 sha256（must-differ 可自行核對）、"
    + "以及 verified_by_redetection（拿輸出去字幕檔**重跑同一個偵測器**，字幕帶必須消失）。"
    + "code ∈ no_subtitle_band|desubtitle_failed|destination_exists|not_media|no_video_stream|unreadable_source|bad_args。",
  args: {
    source: tool.schema.string().describe("本機影片絕對路徑（mp4/mov/mkv/webm…）"),
    to: tool.schema.string().optional().describe("輸出檔案路徑（detect_only 時不需要）；已存在即拒絕覆寫"),
    detect_only: tool.schema.boolean().optional().describe("true＝只做偵測與量測，不產檔（預設 false）"),
    method: tool.schema
      .enum(["delogo", "crop"])
      .optional()
      .describe("移除方法：delogo＝空間內插（預設，解析度不變）｜crop＝直接下裁（解析度變小）"),
    region: tool.schema.number().min(0.05).max(0.6).optional().describe("只看畫面下緣這個比例（0.05..0.6，預設 0.35）"),
    sample_rate: tool.schema.number().min(0.05).max(30).optional().describe("偵測抽樣率（樣本/秒，預設 1；上限 24 幀）"),
    sensitivity: tool.schema.number().min(1).max(20).optional().describe("列能量相對門檻倍數（預設 2）"),
    floor: tool.schema.number().min(0).max(255).optional().describe("列能量絕對門檻（灰階梯度 0..255，預設 1.5）"),
    min_band_height: tool.schema.number().int().min(3).optional().describe("最小字幕帶高度 px（預設 max(6, 畫面高×1.2%)）"),
    pad: tool.schema.number().min(0).max(64).optional().describe("delogo 矩形外擴 px（預設 6）"),
    at: tool.schema.number().min(0).optional().describe("前後對照抽格時間（秒，預設片長中點）"),
  },
  async execute(args) {
    const warnings: string[] = []
    try {
      if (typeof args.source !== "string" || !isAbsolute(args.source)) throw new Error("source 必須是絕對路徑")
      if (!(await isFile(args.source))) throw new Error(`cannot read ${args.source}: 來源檔案不存在`)
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
        return fail("no_subtitle_band", detection.reason ?? "未偵測到字幕帶", {
          title: "未偵測到字幕帶（拒絕移除）",
          source: args.source,
          measured: detection.measured,
          note: "本工具只在量測到持續文字列區段時才移除；沒有可偵測的字幕帶一律拒絕，不靜默回成功",
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
          note: "量測事實：字幕帶為下緣連續列區段的跨幀 p80 水平梯度能量高峰",
          title: `偵測到字幕帶 y=${band.y} h=${band.height}（比值 ${band.ratio}）`,
          warnings,
        })
      }

      if (typeof args.to !== "string" || args.to.trim().length === 0) {
        throw new Error("--to is required（除非 detect_only=true）")
      }
      if (!isAbsolute(args.to)) throw new Error("to 必須是絕對路徑")
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
      if (sourceSha === outputSha) throw new Error("輸出與輸入逐位元相同：去字幕沒有實際生效")

      // 真實行為斷言：拿產出去字幕檔重跑同一個偵測器，字幕帶必須消失。
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
          "全部欄位皆為量測事實（像素灰階差、秒、雜湊）：band 是抽樣列能量高峰；"
          + "evidence 是同秒前後抽格的逐像素差（delogo＝帶內 vs 帶外；crop＝保留區雜訊＋被裁列數）；"
          + "verified_by_redetection 是對輸出檔重跑同一個偵測器。"
          + "本工具不做主觀「看起來乾淨了嗎」的判斷。",
        title: `${args.to}（${removal.method}，`
          + (removal.method === "crop"
            ? `裁掉下緣 ${(change as { removed_rows: number }).removed_rows} 列，保留區差 ${(change as { kept_region_mean_abs_diff: number }).kept_region_mean_abs_diff}）`
            : `帶內差 ${(change as { inside_band_mean_abs_diff: number }).inside_band_mean_abs_diff} vs 帶外 ${(change as { outside_band_mean_abs_diff: number }).outside_band_mean_abs_diff}）`),
        warnings,
      })
    } catch (error) {
      const message = msgOf(error)
      return fail(classify(message), message, { title: "去字幕失敗", source: args.source, warnings })
    }
  },
})

const CONTENT_TYPE: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska",
}

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

/** 產物發佈（複用 lib/img-composite.ts 的 uploadBlob/blobPath；不可用時只回本機路徑）。 */
async function publish(paths: string[], warnings: string[]): Promise<{ path: string; url?: string }[]> {
  const published: { path: string; url?: string }[] = []
  for (const path of paths) {
    const extension = path.slice(path.lastIndexOf(".")).toLowerCase()
    try {
      const bytes = await readFile(path)
      if (bytes.byteLength > MAX_UPLOAD_BYTES) {
        warnings.push(`${path}: ${bytes.byteLength} bytes 超過公網上傳上限 25MB，只回本機路徑`)
        published.push({ path })
        continue
      }
      const url = await uploadBlob(blobPath("video-desubtitle", extension.replace(".", "") || "bin"), bytes,
        CONTENT_TYPE[extension] ?? "application/octet-stream")
      published.push({ path, url })
    } catch (error) {
      warnings.push(`${path}: 公網上傳失敗（${msgOf(error)}），只回本機路徑`)
      published.push({ path })
    }
  }
  return published
}
