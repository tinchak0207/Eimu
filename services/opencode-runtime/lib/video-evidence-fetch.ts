import { mkdir } from "node:fs/promises"
import { dirname, extname } from "node:path"
import { assert, exists, runProcess } from "./video-evidence-process"
import { downloadDirectMedia, requireVideoDownload, videoDownloadEnvironment } from "./video-fetch"

// ---------------------------------------------------------------------------
// fetch 的 yt-dlp 政策（§D：钉版＋独立环境＋显式 prepare＋版本断言；
// 本轮只实作「未就绪就诚实失败」，不在 fetch 时自动安装）
//
// `yt-dlp` 因为在追持续改动的站点而频繁发版，未钉版的一份会让同一个连结在两台机器上抓出不同的结果。

/** 钉版 Python 环境的落点：唯一真源是 lib/video-fetch.ts 的 videoDownloadEnvironment()（prepare 由外部显式执行）。 */
export const YTDLP_HOME = dirname(videoDownloadEnvironment().environment)
export const YTDLP_BIN = videoDownloadEnvironment().executable

/** 可执行的 prepare 指引（显式、可复核；fetch 绝不自行安装）。 */
export function ytDlpPrepareCommand(): string {
  const selected = videoDownloadEnvironment()
  return `video_fetch { "action": "prepare" }（钉版 yt-dlp==${selected.version}，独立 venv：${selected.environment}）`
}

export class YtDlpUnavailableError extends Error {
  readonly code = "video_fetch_unavailable"
  readonly prepare: string
  constructor(detail: string, prepare: string) {
    super(detail)
    this.name = "YtDlpUnavailableError"
    this.prepare = prepare
  }
}

export function isVideoUrl(value: string): boolean {
  return /^https?:\/\/\S+$/u.test(value)
}

/**
 * 把一个网址变成档案（影片＋音讯一起）。政策：只使用钉版的独立环境，
 * 使用前断言 `--version` **完全相符**，绝不在 fetch 时自动安装。
 */
export async function fetchVideo(url: string, target: string): Promise<void> {
  const prepare = ytDlpPrepareCommand()
  assert(isVideoUrl(url), "name an http or https link first")
  assert([".mp4", ".mkv", ".webm", ".mov"].includes(extname(target).toLowerCase()), "--to must end in .mp4, .mkv, .webm or .mov")
  assert(!(await exists(target)), `Destination ${target} already exists`)
  await mkdir(dirname(target), { recursive: true })
  // 直链媒体（store.* 的 mp4 等）先走普通 HTTP 下载，不经 yt-dlp；失败才回落到站点页抓取。
  if (await downloadDirectMedia(url, target)) return
  let executable: string
  try {
    executable = requireVideoDownload()
  } catch (error) {
    throw new YtDlpUnavailableError((error as Error).message, prepare)
  }
  await runProcess(executable, ["--no-playlist", "-f", "bv*+ba/b", "-o", target, url], 900_000)
}
