#!/usr/bin/env python3
"""Patch /opt/eimu-harness/gateway/index.ts: zip 内容安检（路径穿越/炸弹/嵌套 zip）。"""
import sys

PATH = "/opt/eimu-harness/gateway/index.ts"
src = open(PATH).read()

HELPER = '''/** zip 内容安检（红队加固 2026-08-22）：路径穿越／绝对路径／条目过多／解压炸弹／嵌套 zip 一律拒。回 null=通过。 */
function zipProbe(dest: string): string | null {
  const names = Bun.spawnSync(["unzip", "-Z1", dest], { stdout: "pipe", stderr: "ignore" })
  if (names.exitCode !== 0) return "invalid zip archive"
  const entries = names.stdout.toString().split("\\n").filter((l) => l.length > 0)
  if (entries.length > 200) return `too many entries (${entries.length})`
  for (const e of entries) {
    if (e.startsWith("/") || e.includes("..") || e.includes("\\\\") || /^[a-zA-Z]:/.test(e)) return "unsafe entry path"
    if (e.toLowerCase().endsWith(".zip")) return "nested zip"
  }
  const sizes = Bun.spawnSync(["unzip", "-lv", dest], { stdout: "pipe", stderr: "ignore" })
  if (sizes.exitCode !== 0) return "invalid zip listing"
  let total = 0
  for (const line of sizes.stdout.toString().split("\\n")) {
    const m = line.match(/^\\s*(\\d+)\\s+\\d+\\s/)
    if (m) total += Number(m[1])
  }
  if (total > 32 * 1024 * 1024) return `uncompressed size too large (${Math.round(total / 1048576)}MB)`
  return null
}

'''

ANCHOR_HELPER = "async function handleAttachmentUpload("
assert ANCHOR_HELPER in src, "helper anchor not found"
assert "zipProbe" not in src, "already patched"
src = src.replace(ANCHOR_HELPER, HELPER + ANCHOR_HELPER, 1)

OLD_WRITE = '''      await Bun.write(dest, await file.arrayBuffer())
      results.push({ name: safeName, path: `uploads/${state.sessionId}/${safeName}`, size: file.size })'''
NEW_WRITE = '''      await Bun.write(dest, await file.arrayBuffer())
      if (safeName.toLowerCase().endsWith(".zip")) {
        const probe = zipProbe(dest)
        if (probe !== null) {
          await rm(dest, { force: true })
          return jsonError(400, `zip rejected: ${probe}`, "bad_request", "bad_request")
        }
      }
      results.push({ name: safeName, path: `uploads/${state.sessionId}/${safeName}`, size: file.size })'''
assert OLD_WRITE in src, "write anchor not found"
src = src.replace(OLD_WRITE, NEW_WRITE, 1)

open(PATH, "w").write(src)
print("patched OK")
