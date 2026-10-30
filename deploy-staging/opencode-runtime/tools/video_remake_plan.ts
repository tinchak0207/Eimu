import { tool } from "@opencode-ai/plugin/tool"
import { existsSync } from "node:fs"
import { mkdir, readFile } from "node:fs/promises"
import { isAbsolute } from "node:path"
import { fail, ok } from "../lib/client"
import { blobPath, uploadBlob } from "../lib/img-composite"
import { buildRemakePlan, type RemakePlanResult } from "../lib/video-remake-plan"

// 影片翻拍计画（解析 → 切段 → 角色替换确认）——薄包：逻辑全在 lib/video-remake-plan.ts。
// 解析＝复用 lib/video-analyze.ts（visualBoundaries＋本机 ASR 词级时间轴；VLM 缺则诚实失败）；
// 切段＝复用 lib/video-evidence.ts 的 cutSpans 真的切档；
// 角色替换确认＝只出待确认清单（不自动替换、不呼叫任何生成）。零付费：不传 allow_paid_vision。

function msgOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function classify(message: string): string {
  if (/no video stream$/u.test(message)) return "no_video_stream"
  if (/: no audio or video stream$/u.test(message) || /duration is unavailable$/u.test(message) || /Invalid data found/u.test(message)) return "not_media"
  if (/cannot read/u.test(message)) return "unreadable_source"
  if (/Destination .* already exists/u.test(message)) return "out_dir_conflict"
  if (/必须是绝对路径|不得大于/u.test(message)) return "bad_args"
  if (/exited with|timed out after|could not start/u.test(message)) return "remake_plan_failed"
  return "remake_plan_failed"
}

const CONTENT_TYPE: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
}
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024
const UPLOAD_LIMIT = 24

/** 代表帧发布（复用 lib/img-composite.ts 的 uploadBlob/blobPath，与 video_analyze 同一口径）。 */
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
      const url = await uploadBlob(blobPath("video-remake-plan", extension.replace(".", "") || "bin"), bytes,
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
    "影片翻拍计画（**解析 → 切段 → 角色替换确认**；本机优先、预设零付费）："
    + "① 解析＝复用 `video_analyze` 的同一条管线（`visualBoundaries` 机械式相邻帧变化候选切场景＋各场景中点代表帧；"
    + "本机 loopback ASR 词级台词轮次），再由**台词轮次落在哪个场景**聚合出「原角色候选／原场景候选」。"
    + "② 切段＝把相邻场景并成「适合 AI 重生的短片段」（target_seconds 预设 5、单段不回超过 max_seconds 预设 10），"
    + "并用既有 `cut` 轮子（cutSpans）**真的切出 mp4**，每段回起讫秒＋该段台词＋代表帧＋切档实际时长。"
    + "③ 角色替换确认＝只出**待确认清单**：每条列 original（原角色名＋代表帧／原场景＋起讫）与 inferred"
    + "（推断的新角色名／新角色 prompt／新场景名／新场景 prompt）＋可手动标定 action ∈ confirm|reject|rename。"
    + "**本工具不自动替换、不呼叫任何生成**。"
    + "诚实边界：本机无 speaker diarization ⇒ 不判「谁说的」（speaker_identity=undetermined）；"
    + "本机无零付费 VLM ⇒ 不反推新角色/新场景提示词，inferred 一律 status=needs_vision_model、new_name/new_prompt=null，"
    + "prompt 格照 `vlm_unavailable` 既有形状附 probed 清单。零付费上游呼叫（allow_paid_vision 从不开启）。"
    + "回传 format=eimu.video-remake-plan@1：media／parse{scenes,dialogue,cast}／segments／confirmation／prompt／generation。"
    + "code ∈ remake_plan_failed|not_media|no_video_stream|unreadable_source|out_dir_conflict|bad_args。",
  args: {
    source: tool.schema.string().describe("本机影片绝对路径（mp4/mov/mkv/webm…）"),
    frames_dir: tool.schema.string().describe("代表帧输出目录（绝对路径；不存在会建立）"),
    out_dir: tool.schema.string().describe("短片段输出目录（绝对路径；不存在会建立；同名的 segment-*.mp4 不得已存在）"),
    target_seconds: tool.schema.number().positive().max(60).optional().describe("目标段长（秒，预设 5）"),
    max_seconds: tool.schema.number().positive().max(120).optional().describe("单段上限（秒，预设 10；不得小于 target_seconds）"),
    scene_rate: tool.schema.number().min(1).max(120).optional().describe("场景变化取样率（样本/秒，预设 12）"),
    scene_threshold: tool.schema.number().min(0).max(1).optional().describe("场景变化分数门槛（0..1，预设 0.1）"),
    max_scenes: tool.schema.number().int().min(1).max(120).optional().describe("最多抽几个场景代表帧（预设 12）"),
    language: tool.schema.string().optional().describe("台词语言码（en/zh/ja…）；预设 auto（由 ASR 启发式解析）"),
    max_audio_seconds: tool.schema.number().positive().max(1800).optional().describe("音讯时长上限（秒）；超过即 dialogue.ok=false、code=too_long"),
    cut: tool.schema.boolean().optional().describe("false＝只出计画不切档（除错用）；预设 true＝真的切出 segment-*.mp4"),
  },
  async execute(args, context) {
    const warnings: string[] = []
    try {
      if (typeof args.source !== "string" || !isAbsolute(args.source)) throw new Error("source 必须是绝对路径")
      if (typeof args.frames_dir !== "string" || !isAbsolute(args.frames_dir)) throw new Error("frames_dir 必须是绝对路径")
      if (typeof args.out_dir !== "string" || !isAbsolute(args.out_dir)) throw new Error("out_dir 必须是绝对路径")
      if (!existsSync(args.source)) throw new Error(`cannot read ${args.source}: 来源档案不存在`)
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
        title: `翻拍计画：${result.parse.scenes.count} 场景 / ${result.segments.count} 段`
          + ` / ${result.parse.dialogue.turn_count} 台词轮次 / ${result.parse.cast.count} 角色候选`
          + ` / ${result.confirmation.count} 条待确认`,
        warnings,
      })
    } catch (error) {
      const message = msgOf(error)
      return fail(classify(message), message, { title: "翻拍计画失败", source: args.source, warnings })
    }
  },
})
