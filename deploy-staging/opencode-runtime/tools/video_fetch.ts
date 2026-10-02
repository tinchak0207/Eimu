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

// 影片抓取（薄包）：全部邏輯在 lib/video-fetch.ts（照抄競品 hypit packages/yt-dlp/src/*）。
// 本檔只做參數轉譯與錯誤碼映射。
export default tool({
  description:
    "影片抓取：把一個 **http(s) 連結**變成一個本機影片檔（video＋audio 一起抓、一起封裝）。" +
    "**URL 抓取前必須先 action=prepare**：yt-dlp 是顯式準備的**釘版 Python 依賴**，不是機器剛好帶的二進位——" +
    "它為追站點常改版而頻繁發版，未釘版會讓同一條連結在兩台機器抓出不同結果。" +
    "action=prepare 會建**獨立環境**（venv，路徑含版本號）並安裝 pyproject 釘死的 yt-dlp 版本；action=fetch **絕不自行安裝**，" +
    "未就緒時回 code=video_fetch_unavailable 並附 prepare 指令；action=status 只讀查環境與版本就緒狀態。" +
    "只接受 http:/https: 連結（本機路徑不是連結；Windows 單字母 scheme 如 c:\\clip.mp4 會被當成 URL 而誤判，故明確排除）。" +
    "落地檔名必須以 .mp4/.mkv/.webm/.mov 結尾（決定容器），並偏好 1080p H.264。",
  args: {
    action: tool.schema
      .enum(["fetch", "prepare", "status"])
      .describe("prepare=顯式準備釘版 yt-dlp 環境（建 venv＋安裝，可能數十秒）|fetch=抓取（需先 prepare）|status=只讀查環境與版本就緒狀態"),
    url: tool.schema.string().optional().describe("action=fetch 必填；只接受 http/https 連結"),
    to: tool.schema.string().optional().describe("action=fetch 必填；落地檔名，必須以 .mp4/.mkv/.webm/.mov 結尾"),
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
          title: "釘版 yt-dlp 已就緒",
        })
      } catch (e) {
        return fail("video_fetch_prepare_failed", (e as Error).message || "準備失敗")
      }
    }

    // action === "fetch"
    if (!args.url || !isVideoUrl(args.url)) {
      return fail(
        "video_fetch_bad_url",
        "action=fetch 需要 http(s) 的 url；本機路徑或 Windows 單字母 scheme（c:\\clip.mp4）不是連結",
      )
    }
    if (!args.to) {
      return fail("video_fetch_bad_target", "action=fetch 需要 to（落地檔名，.mp4/.mkv/.webm/.mov）")
    }
    // 直鏈媒體（.mp4 等、回 video/*）先走普通下載，不經 yt-dlp（見 lib downloadDirectMedia 註解）
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
        `${(e as Error).message}｜請先呼叫 video_fetch action=prepare（建獨立 venv 並安裝 pyproject 釘死的 yt-dlp 版本）`,
        { prepare: 'video_fetch { action: "prepare" }' },
      )
    }
    try {
      await downloadVideo(args.url, args.to, { signal: context.abort })
      return ok({ action: "fetch", url: args.url, to: args.to, title: `已抓取 ${args.to}` })
    } catch (e) {
      return fail("video_fetch_failed", (e as Error).message || "抓取失敗")
    }
  },
})
