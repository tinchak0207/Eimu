import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** 上下文里的 data URL 大约到 1MB 字符就该停。原图更大时先压，不拒绝。 */
export const MAX_CONTEXT_BASE64_CHARS = 1024 * 1024
export const MAX_CONTEXT_RAW_BYTES = Math.floor((MAX_CONTEXT_BASE64_CHARS * 3) / 4)

const PASSES: Array<[number, number]> = [
  [1280, 8],
  [768, 16],
  [512, 28],
]

function runFfmpeg(src: string, out: string, width: number, qv: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "ffmpeg",
      ["-y", "-i", src, "-vf", `scale='min(${width},iw)':-2`, "-q:v", String(qv), out],
      { stdio: "ignore" },
    )
    child.on("error", reject)
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`))))
  })
}

/** 超过上下文上限就压成 JPEG。压完仍超限则抛错。未超限原样返回。 */
export async function fitImageForContext(input: {
  bytes: Uint8Array
  mime: string
}): Promise<{ bytes: Uint8Array; mime: string; shrunk: boolean }> {
  if (input.bytes.byteLength <= MAX_CONTEXT_RAW_BYTES) {
    return { bytes: input.bytes, mime: input.mime, shrunk: false }
  }
  const dir = await mkdtemp(join(tmpdir(), "read-image-"))
  const src = join(dir, "in.bin")
  const out = join(dir, "out.jpg")
  try {
    await writeFile(src, input.bytes)
    for (const [width, qv] of PASSES) {
      await runFfmpeg(src, out, width, qv)
      const shrunk = await readFile(out)
      if (shrunk.byteLength <= MAX_CONTEXT_RAW_BYTES) {
        return { bytes: shrunk, mime: "image/jpeg", shrunk: true }
      }
    }
    throw new Error("图片缩小后仍超过上下文上限。")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
