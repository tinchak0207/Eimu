// S20 接线 2 验收：产物公网化（真文件复制，不 mock fs）。
// 判准：URL 形状稳定；目录不可写/不存在 → {url:null} 且不抛；源缺失不抛；同 artifact 二次发布幂等。
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const ROOT = mkdtempSync(join(tmpdir(), "s20-publish-"))
const UPLOADS = join(ROOT, "public", "uploads")
const BASE = "https://example.test/image-data/files/uploads"
process.env.PROJECT_PUBLIC_UPLOADS_DIR = UPLOADS
process.env.PROJECT_PUBLIC_BASE_URL = BASE

const { publishProjectArtifact, publicFileName, extForMime } = await import("./publish.ts")

afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

const REF = { sessionId: "ses_ab12-cd34", artifactId: "art_" + "a".repeat(16), mime: "video/mp4" }

function srcFile(name: string, bytes: string): string {
  const file = join(ROOT, name)
  writeFileSync(file, bytes)
  return file
}

describe("publishProjectArtifact", () => {
  test("成功：URL 形状 project-<sid8>-<artifactId>.<ext>，文件内容一致", async () => {
    const src = srcFile("master.mp4", "fake-mp4-bytes")
    const r = await publishProjectArtifact(src, REF)
    expect(r.url).toBe(`${BASE}/project-ses_ab12-art_${"a".repeat(16)}.mp4`)
    const finalPath = join(UPLOADS, publicFileName(REF))
    expect(statSync(finalPath).isFile()).toBe(true)
    expect(readFileSync(finalPath, "utf-8")).toBe("fake-mp4-bytes")
  })

  test("同 artifact 二次发布幂等：同 URL；公网文件被删后再发一次会补回", async () => {
    const src = srcFile("again.mp4", "idem-bytes")
    const first = await publishProjectArtifact(src, { ...REF, artifactId: "art_" + "b".repeat(16) })
    const second = await publishProjectArtifact(src, { ...REF, artifactId: "art_" + "b".repeat(16) })
    expect(first.url).toBe(second.url)
    const finalPath = join(UPLOADS, publicFileName({ ...REF, artifactId: "art_" + "b".repeat(16) }))
    unlinkSync(finalPath)
    const third = await publishProjectArtifact(src, { ...REF, artifactId: "art_" + "b".repeat(16) })
    expect(third.url).toBe(first.url)
    expect(statSync(finalPath).isFile()).toBe(true)
  })

  test("未知 mime → .bin 扩展名", () => {
    expect(extForMime("application/octet-stream")).toBe(".bin")
    expect(extForMime("image/png")).toBe(".png")
    expect(publicFileName({ sessionId: "x".repeat(20), artifactId: "art_1", mime: "nope/nope" })).toBe(
      `project-${"x".repeat(8)}-art_1.bin`,
    )
  })

  test("源文件不存在 → {url:null, reason}，不抛", async () => {
    const r = await publishProjectArtifact(join(ROOT, "missing.mp4"), REF)
    expect(r.url).toBeNull()
    if (r.url === null) expect(r.reason).toContain("ENOENT")
  })

  test("公网目录不可建（父路径是普通文件）→ {url:null}，不抛", async () => {
    const blocker = join(ROOT, "blocker")
    writeFileSync(blocker, "not a directory")
    const prev = process.env.PROJECT_PUBLIC_UPLOADS_DIR
    process.env.PROJECT_PUBLIC_UPLOADS_DIR = join(blocker, "uploads")
    try {
      const src = srcFile("blocked.mp4", "x")
      const r = await publishProjectArtifact(src, { ...REF, artifactId: "art_" + "c".repeat(16) })
      expect(r.url).toBeNull()
      if (r.url === null) expect(r.reason.length).toBeGreaterThan(0)
    } finally {
      process.env.PROJECT_PUBLIC_UPLOADS_DIR = prev
    }
  })
})
