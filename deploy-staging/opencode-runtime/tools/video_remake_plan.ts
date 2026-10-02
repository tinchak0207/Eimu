import { tool } from "@opencode-ai/plugin/tool"
import { existsSync } from "node:fs"
import { mkdir, readFile } from "node:fs/promises"
import { isAbsolute } from "node:path"
import { fail, ok } from "../lib/client"
import { blobPath, uploadBlob } from "../lib/img-composite"
import { buildRemakePlan, type RemakePlanResult } from "../lib/video-remake-plan"

// 影片翻拍計畫（解析 → 切段 → 角色替換確認）——薄包：邏輯全在 lib/video-remake-plan.ts。
// 解析＝複用 lib/video-analyze.ts（visualBoundaries＋本機 ASR 詞級時間軸；VLM 缺則誠實失敗）；
// 切段＝複用 lib/video-evidence.ts 的 cutSpans 真的切檔；
// 角色替換確認＝只出待確認清單（不自動替換、不呼叫任何生成）。零付費：不傳 allow_paid_vision。

function msgOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function classify(message: string): string {
  if (/no video stream$/u.test(message)) return "no_video_stream"
  if (/: no audio or video stream$/u.test(message) || /duration is unavailable$/u.test(message) || /Invalid data found/u.test(message)) return "not_media"
  if (/cannot read/u.test(message)) return "unreadable_source"
  if (/Destination .* already exists/u.test(message)) return "out_dir_conflict"
  if (/必須是絕對路徑|不得大於/u.test(message)) return "bad_args"
  if (/exited with|timed out after|could not start/u.test(message)) return "remake_plan_failed"
  return "remake_plan_failed"
}

const CONTENT_TYPE: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
}
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024
const UPLOAD_LIMIT = 24

/** 代表幀發佈（複用 lib/img-composite.ts 的 uploadBlob/blobPath，與 video_analyze 同一口徑）。 */
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
      const url = await uploadBlob(blobPath("video-remake-plan", extension.replace(".", "") || "bin"), bytes,
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
    "影片翻拍計畫（**解析 → 切段 → 角色替換確認**；本機優先、預設零付費）："
    + "① 解析＝複用 `video_analyze` 的同一條管線（`visualBoundaries` 機械式相鄰幀變化候選切場景＋各場景中點代表幀；"
    + "本機 loopback ASR 詞級台詞輪次），再由**台詞輪次落在哪個場景**聚合出「原角色候選／原場景候選」。"
    + "② 切段＝把相鄰場景併成「適合 AI 重生的短片段」（target_seconds 預設 5、單段不回超過 max_seconds 預設 10），"
    + "並用既有 `cut` 輪子（cutSpans）**真的切出 mp4**，每段回起訖秒＋該段台詞＋代表幀＋切檔實際時長。"
    + "③ 角色替換確認＝只出**待確認清單**：每條列 original（原角色名＋代表幀／原場景＋起訖）與 inferred"
    + "（推斷的新角色名／新角色 prompt／新場景名／新場景 prompt）＋可手動標定 action ∈ confirm|reject|rename。"
    + "**本工具不自動替換、不呼叫任何生成**。"
    + "誠實邊界：本機無 speaker diarization ⇒ 不判「誰說的」（speaker_identity=undetermined）；"
    + "本機無零付費 VLM ⇒ 不反推新角色/新場景提示詞，inferred 一律 status=needs_vision_model、new_name/new_prompt=null，"
    + "prompt 格照 `vlm_unavailable` 既有形狀附 probed 清單。零付費上游呼叫（allow_paid_vision 從不開啟）。"
    + "回傳 format=eimu.video-remake-plan@1：media／parse{scenes,dialogue,cast}／segments／confirmation／prompt／generation。"
    + "code ∈ remake_plan_failed|not_media|no_video_stream|unreadable_source|out_dir_conflict|bad_args。",
  args: {
    source: tool.schema.string().describe("本機影片絕對路徑（mp4/mov/mkv/webm…）"),
    frames_dir: tool.schema.string().describe("代表幀輸出目錄（絕對路徑；不存在會建立）"),
    out_dir: tool.schema.string().describe("短片段輸出目錄（絕對路徑；不存在會建立；同名的 segment-*.mp4 不得已存在）"),
    target_seconds: tool.schema.number().positive().max(60).optional().describe("目標段長（秒，預設 5）"),
    max_seconds: tool.schema.number().positive().max(120).optional().describe("單段上限（秒，預設 10；不得小於 target_seconds）"),
    scene_rate: tool.schema.number().min(1).max(120).optional().describe("場景變化取樣率（樣本/秒，預設 12）"),
    scene_threshold: tool.schema.number().min(0).max(1).optional().describe("場景變化分數門檻（0..1，預設 0.1）"),
    max_scenes: tool.schema.number().int().min(1).max(120).optional().describe("最多抽幾個場景代表幀（預設 12）"),
    language: tool.schema.string().optional().describe("台詞語言碼（en/zh/ja…）；預設 auto（由 ASR 啟發式解析）"),
    max_audio_seconds: tool.schema.number().positive().max(1800).optional().describe("音訊時長上限（秒）；超過即 dialogue.ok=false、code=too_long"),
    cut: tool.schema.boolean().optional().describe("false＝只出計畫不切檔（除錯用）；預設 true＝真的切出 segment-*.mp4"),
  },
  async execute(args, context) {
    const warnings: string[] = []
    try {
      if (typeof args.source !== "string" || !isAbsolute(args.source)) throw new Error("source 必須是絕對路徑")
      if (typeof args.frames_dir !== "string" || !isAbsolute(args.frames_dir)) throw new Error("frames_dir 必須是絕對路徑")
      if (typeof args.out_dir !== "string" || !isAbsolute(args.out_dir)) throw new Error("out_dir 必須是絕對路徑")
      if (!existsSync(args.source)) throw new Error(`cannot read ${args.source}: 來源檔案不存在`)
      await mkdir(args.frames_dir, { recursive: true })
      await mkdir(args.out_dir, { recursive: true })

      const result: RemakePlanResult = await buildRemakePlan(args.source, {
        frames_dir: args.frames_dir,
        out_dir: args.out_dir,
        ...(args.target_seconds === undefined ? {} : { target_seconds: args.target_seconds }),
        ...(args.max_seconds === undefined ? {} : { max_seconds: args.max_seconds }),
        ...(args.scene_rate === undefined ? {} : { scene_rate: args.scene_rate }),
        ...(args.scene_threshold === undefined ? {} : { scene_threshold: args.scene_threshold }),
        ...(args.max_scenes === undefined ? {} : { max_scenes: args.max_scenes }),
        ...(args.language === undefined ? {} : { language: args.language }),
        ...(args.max_audio_seconds === undefined ? {} : { max_audio_seconds: args.max_audio_seconds }),
        ...(args.cut === undefined ? {} : { cut: args.cut }),
        signal: context.abort,
      })

      const framePaths = result.parse.scenes.items.flatMap((scene) => (scene.frame_path === undefined ? [] : [scene.frame_path]))
      const artifacts = await publish(framePaths, warnings)
      const clips = result.segments.items.flatMap((segment) => (segment.clip === undefined ? [] : [segment.clip.path]))

      return ok({
        ...result,
        artifacts,
        clips,
        title: `翻拍計畫：${result.parse.scenes.count} 場景 / ${result.segments.count} 段`
          + ` / ${result.parse.dialogue.turn_count} 台詞輪次 / ${result.parse.cast.count} 角色候選`
          + ` / ${result.confirmation.count} 條待確認`,
        warnings,
      })
    } catch (error) {
      const message = msgOf(error)
      return fail(classify(message), message, { title: "翻拍計畫失敗", source: args.source, warnings })
    }
  },
})
