// 影片抓取（fetch）——照抄竞品 hypit 的实作；配方＝
//   packages/yt-dlp/src/environment.ts  ＋  packages/yt-dlp/src/download.ts
//
// 设计注解（hypit download.ts:1-12 逐字，本档照此精神）：
//   The tool is a pinned Python dependency prepared explicitly by `hypit media prepare-fetch`, not a
//   binary the machine happens to carry. `yt-dlp` releases constantly because it is chasing sites that
//   keep changing, so an unpinned copy makes the same link fetch differently on two machines.
//
// 我方落地差异（已在回报逐条列出）：
//   1. 无 uv：prepare 走 `python3 -m venv` ＋ `pip install yt-dlp==<pin>`（同形状：钉版、独立环境、显式、使用前断言）。
//      有 uv 时仍走 hypit 原路（uv sync --project --frozen）。
//   2. ffmpeg 不在 PATH：可用性检查先试 PATH 的 `ffmpeg`，再试 /opt/agent-harness/bin/ffmpeg；
//      失败讯息逐字保留 hypit 原文。
//   3. 版本真源宣告在自带的 lib/video-fetch-runtime/pyproject.toml（hypit 是独立 runtime 套件）。

import { safeFetch } from "./sandbox"
import { execFile, spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { copyFile, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, extname, join } from "node:path"
import { fileURLToPath } from "node:url"

/** 钉版 runtime 专案（版本唯一真源在 pyproject.toml，environment() 以 regex 读出，与 hypit 同形）。 */
const PROJECT = join(dirname(fileURLToPath(import.meta.url)), "video-fetch-runtime")
const PROJECT_FILE = join(PROJECT, "pyproject.toml")
/** host state root：venv 落在此（独立环境，含版本号路径）。 */
const HOST_STATE_ROOT = "/opt/agent-harness/workspace/.opencode-state"
const FFMPEG_CANDIDATES = ["ffmpeg", "/opt/agent-harness/bin/ffmpeg"]

export interface VideoDownloadEnvironment {
  version: string
  environment: string
  executable: string
  project: string
}

/** One selected, locked environment. Fetching media never invokes its installer. */
export function videoDownloadEnvironment(): VideoDownloadEnvironment {
  let text: string
  try {
    text = readFileSync(PROJECT_FILE, "utf8")
  } catch {
    throw new Error(`yt-dlp runtime must declare its exact upstream version at ${PROJECT_FILE}`)
  }
  const version = /"yt-dlp(?:\[[^\]]+\])?==([^"]+)"/u.exec(text)?.[1]
  if (version === undefined) throw new Error("yt-dlp runtime must declare its exact upstream version")
  const environment = join(HOST_STATE_ROOT, "programs", "yt-dlp", version, ".venv")
  return { project: PROJECT, version, environment, executable: join(environment, "bin", "yt-dlp") }
}

/** 使用前版本断言：不符即抛，fetch 绝不触发安装。 */
export function requireVideoDownload(): string {
  const selected = videoDownloadEnvironment()
  const result = spawnSync(selected.executable, ["--ignore-config", "--version"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
  })
  // PyPI normalizes date-version leading zeroes; the executable retains them.
  const release = (value: string) =>
    value
      .trim()
      .split(".")
      .map((part) => part.replace(/^0+(?=\d)/u, ""))
      .join(".")
  if (result.status !== 0 || release(result.stdout ?? "") !== release(selected.version)) {
    throw new Error(
      `yt-dlp ${selected.version} is not ready at ${selected.executable}; run video_fetch action=prepare. ` +
        `${result.error?.message ?? result.stderr?.trim() ?? ""}`,
    )
  }
  return selected.executable
}

function hasUv(): boolean {
  const probe = spawnSync("uv", ["--version"], { encoding: "utf8", windowsHide: true, timeout: 15_000 })
  return !probe.error && probe.status === 0
}

/** Explicit provisioning. uv owns dependency resolution and the environment; 无 uv 时用 venv+pip 同形状。 */
export function prepareVideoDownload(): string {
  const selected = videoDownloadEnvironment()
  if (hasUv()) {
    const result = spawnSync("uv", ["sync", "--project", selected.project, "--frozen", "--no-dev"], {
      env: { ...process.env, UV_PROJECT_ENVIRONMENT: selected.environment },
      stdio: ["ignore", "inherit", "inherit"],
      windowsHide: true,
    })
    if (result.error || result.status !== 0) {
      throw new Error(`yt-dlp preparation failed: ${result.error?.message ?? `uv exited ${result.status}`}`)
    }
    return requireVideoDownload()
  }
  const venv = spawnSync("python3", ["-m", "venv", selected.environment], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 300_000,
  })
  if (venv.error || venv.status !== 0) {
    throw new Error(
      `yt-dlp preparation failed: ${venv.error?.message ?? venv.stderr?.trim() ?? `python3 -m venv exited ${venv.status}`}`,
    )
  }
  const install = spawnSync(join(selected.environment, "bin", "pip"), [
    "install",
    "--disable-pip-version-check",
    `yt-dlp==${selected.version}`,
  ], { encoding: "utf8", windowsHide: true, timeout: 600_000 })
  if (install.error || install.status !== 0) {
    throw new Error(
      `yt-dlp preparation failed: ${install.error?.message ?? install.stderr?.trim() ?? `pip exited ${install.status}`}`,
    )
  }
  return requireVideoDownload()
}

/**
 * Whether this is a link to fetch rather than a path to open.
 *
 * Only `http` and `https`. A Windows path opens as a URL with a single-letter scheme (`c:\clip.mp4`
 * parses with protocol `c:`), and reading that as a link would hand the whole path to `yt-dlp` and
 * report a network failure for a file sitting on the disk.
 */
export function isVideoUrl(value: string): boolean {
  try {
    const parsed = new URL(value.trim())
    return parsed.protocol === "http:" || parsed.protocol === "https:"
  } catch {
    return false
  }
}

function runExec(
  file: string,
  args: readonly string[],
  options: {
    readonly timeout?: number
    readonly maxBuffer?: number
    readonly signal?: AbortSignal | undefined
  } = {},
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], { encoding: "utf8", windowsHide: true, ...options }, (error, stdout, stderr) => {
      if (error !== null) reject(Object.assign(error, { stdout, stderr }))
      else resolve({ stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

async function ensureFfmpeg(signal?: AbortSignal): Promise<void> {
  for (const candidate of FFMPEG_CANDIDATES) {
    try {
      await runExec(candidate, ["-version"], { timeout: 15_000, signal })
      return
    } catch (error) {
      if (signal?.aborted) throw error
    }
  }
  throw new Error("FFmpeg is unavailable on PATH; install your selected media toolchain before fetching video")
}

/**
 * Fetch one video into exactly the file the caller named.
 *
 * Video and audio are asked for together and muxed: sites serve the two separately now, so the best
 * single file resolves to a video-only stream, and a video with no audio has no transcript. H.264 at
 * 1080 is preferred rather than required; a `height<=1080` filter would refuse a link that offers
 * nothing under the bound. `--no-playlist` keeps a link inside a playlist from fetching the playlist.
 * The container follows the target's extension.
 */
export async function downloadVideo(
  url: string,
  target: string,
  options: { readonly signal?: AbortSignal } = {},
): Promise<void> {
  const container = extname(target).slice(1).toLowerCase()
  if (!["mp4", "mkv", "webm", "mov"].includes(container)) {
    throw new Error(`${target} must end in .mp4, .mkv, .webm or .mov`)
  }
  const executable = requireVideoDownload()
  await ensureFfmpeg(options.signal)
  const work = await mkdtemp(join(tmpdir(), "ytdl-fetch-"))
  try {
    try {
      await runExec(
        executable,
        [
          "--ignore-config", "--no-update", "--no-remote-components", "--no-plugin-dirs",
          "--no-js-runtimes", "--js-runtimes", `node:${process.execPath}`,
          "--no-playlist", "--no-progress", "--quiet",
          "--format", "bv*+ba/b",
          "--merge-output-format", container,
          "--format-sort", "res:1080,vcodec:h264",
          "--output", join(work, "video.%(ext)s"),
          url,
        ],
        { timeout: 900_000, maxBuffer: 10 * 1024 * 1024, signal: options.signal },
      )
    } catch (cause) {
      if (options.signal?.aborted) throw cause
      const error = cause as { stderr?: string; message?: string }
      throw new Error(`yt-dlp could not fetch ${url}: ${(error.stderr ?? error.message ?? "").trim().slice(-2000)}`)
    }
    const finished = (await readdir(work)).filter((name) => !name.endsWith(".part"))
    const [file] = finished.sort()
    if (file === undefined) throw new Error(`yt-dlp reported success for ${url} but wrote no file`)
    const staged = join(work, file)
    try {
      await rename(staged, target)
    } catch (cause) {
      // Staging lives in the OS temp directory, which is often on a different volume from the
      // project. A rename cannot cross volumes, so copy the bytes over instead; the staging
      // directory is removed either way.
      if ((cause as NodeJS.ErrnoException).code !== "EXDEV") throw cause
      await copyFile(staged, target)
    }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

// 直链媒体快路径（2026-09-29 e2e 实锤）：用户贴 .mp4 直链时，yt-dlp 的 generic 抽取器会先把它当网页抓，
// 在 Cloudflare 后的站（含 eimu.dev 自家 showcase）回 SSL EOF／403 anti-bot，而同一 URL 普通 GET 就是 200 video/mp4。
// 回 true＝已落地；回 false＝不是直链媒体（HTML 页／非 2xx），交回 yt-dlp。
export async function downloadDirectMedia(
  url: string,
  target: string,
  options: { readonly signal?: AbortSignal } = {},
): Promise<boolean> {
  const container = extname(target).slice(1).toLowerCase()
  if (!["mp4", "mkv", "webm", "mov"].includes(container)) {
    throw new Error(`${target} must end in .mp4, .mkv, .webm or .mov`)
  }
  const res = await safeFetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36" },
    signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(900_000)]) : AbortSignal.timeout(900_000),
  }).catch(() => null)
  if (!res || !res.ok || !res.body) return false
  const type = (res.headers.get("content-type") || "").toLowerCase()
  const mediaByExt = /\.(mp4|m4v|mov|webm|mkv)(\?|#|$)/i.test(new URL(url).pathname + "")
  if (!(type.startsWith("video/") || (mediaByExt && type.startsWith("application/octet-stream")))) {
    await res.body.cancel().catch(() => {})
    return false
  }
  const bytes = Buffer.from(await res.arrayBuffer())
  if (bytes.length === 0) return false
  await writeFile(target, bytes)
  return true
}
