import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import {
  videoDownloadEnvironment,
  requireVideoDownload,
  prepareVideoDownload,
  isVideoUrl,
  downloadVideo,
  downloadDirectMedia,
} from "../lib/video-fetch"

// 影片抓取（薄包）：全部逻辑在 lib/video-fetch.ts（照抄竞品 hypit packages/yt-dlp/src/*）。
// 本档只做参数转译与错误码映射。
export default tool({
  description:
    "影片抓取：把一个 **http(s) 连结**变成一个本机影片档（video＋audio 一起抓、一起封装）。" +
    "**URL 抓取前必须先 action=prepare**：yt-dlp 是显式准备的**钉版 Python 依赖**，不是机器刚好带的二进位——" +
    "它为追站点常改版而频繁发版，未钉版会让同一条连结在两台机器抓出不同结果。" +
    "action=prepare 会建**独立环境**（venv，路径含版本号）并安装 pyproject 钉死的 yt-dlp 版本；action=fetch **绝不自行安装**，" +
    "未就绪时回 code=video_fetch_unavailable 并附 prepare 指令；action=status 只读查环境与版本就绪状态。" +
    "只接受 http:/https: 连结（本机路径不是连结；Windows 单字母 scheme 如 c:\\clip.mp4 会被当成 URL 而误判，故明确排除）。" +
    "落地档名必须以 .mp4/.mkv/.webm/.mov 结尾（决定容器），并偏好 1080p H.264。",
  args: {
    action: tool.schema
      .enum(["fetch", "prepare", "status"])
      .describe("prepare=显式准备钉版 yt-dlp 环境（建 venv＋安装，可能数十秒）|fetch=抓取（需先 prepare）|status=只读查环境与版本就绪状态"),
    url: tool.schema.string().optional().describe("action=fetch 必填；只接受 http/https 连结"),
    to: tool.schema.string().optional().describe("action=fetch 必填；落地档名，必须以 .mp4/.mkv/.webm/.mov 结尾"),
  },
  async execute(args, context) {
    if (args.action === "status") {
      const environment = videoDownloadEnvironment()
      let ready = false
      let detail = ""
      try {
        ready = true
        detail = requireVideoDownload()
      } catch (e) {
        ready = false
        detail = (e as Error).message
      }
      return ok({
        action: "status",
        ready,
        version: environment.version,
        environment: environment.environment,
        executable: environment.executable,
        project: environment.project,
        detail,
      })
    }

    if (args.action === "prepare") {
      try {
        const executable = prepareVideoDownload()
        return ok({
          action: "prepare",
          version: videoDownloadEnvironment().version,
          executable,
          title: "钉版 yt-dlp 已就绪",
        })
      } catch (e) {
        return fail("video_fetch_prepare_failed", (e as Error).message || "准备失败")
      }
    }

    // action === "fetch"
    if (!args.url || !isVideoUrl(args.url)) {
      return fail(
        "video_fetch_bad_url",
        "action=fetch 需要 http(s) 的 url；本机路径或 Windows 单字母 scheme（c:\\clip.mp4）不是连结",
      )
    }
    if (!args.to) {
      return fail("video_fetch_bad_target", "action=fetch 需要 to（落地档名，.mp4/.mkv/.webm/.mov）")
    }
    // 直链媒体（.mp4 等、回 video/*）先走普通下载，不经 yt-dlp（见 lib downloadDirectMedia 注解）
    try {
      if (await downloadDirectMedia(args.url, args.to, { signal: context.abort })) {
        return ok({ action: "fetch", url: args.url, to: args.to, via: "direct", title: `已抓取 ${args.to}` })
      }
    } catch (e) {
      if (context.abort?.aborted) return fail("video_fetch_failed", (e as Error).message || "抓取中止")
    }
    try {
      requireVideoDownload()
    } catch (e) {
      return fail(
        "video_fetch_unavailable",
        `${(e as Error).message}｜请先呼叫 video_fetch action=prepare（建独立 venv 并安装 pyproject 钉死的 yt-dlp 版本）`,
        { prepare: 'video_fetch { action: "prepare" }' },
      )
    }
    try {
      await downloadVideo(args.url, args.to, { signal: context.abort })
      return ok({ action: "fetch", url: args.url, to: args.to, title: `已抓取 ${args.to}` })
    } catch (e) {
      return fail("video_fetch_failed", (e as Error).message || "抓取失败")
    }
  },
})
