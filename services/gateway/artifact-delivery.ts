import { createHash } from "node:crypto"
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs"
import path from "node:path"
import { assetDir, localAssetPath, writeAssetFile } from "./artifact-store-paths.ts"
import { db, versionRow } from "./artifact-store-index.ts"
import { contentTypeFor } from "./artifact-store-io.ts"
import { ARTIFACT_DELIVERY_MAX_BYTES, ArtifactError } from "./artifact-store-types.ts"

const publishedKey = "published-version"

function openSnapshot(artifactId: number, sha256: string, expectedBytes: number): number {
  const target = localAssetPath(artifactId, sha256, publishedKey)
  if (!target || !/^[a-f0-9]{64}$/.test(sha256) || !Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > ARTIFACT_DELIVERY_MAX_BYTES) throw new ArtifactError("artifact_not_found", "产物不存在", 404)
  let fd: number | undefined
  try {
    // The configured private store may itself live below a symlinked mount;
    // the managed assets/ID directories must not be replaced with symlinks.
    const directory = assetDir(artifactId)
    const root = path.dirname(path.dirname(directory))
    for (const parent of [path.dirname(directory), directory]) {
      const stat = lstatSync(parent)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("invalid snapshot directory")
    }
    const canonicalRoot = realpathSync(root)
    const canonicalTarget = realpathSync(target)
    const relative = path.relative(canonicalRoot, canonicalTarget)
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("snapshot escaped store")
    const before = lstatSync(target)
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new Error("invalid snapshot")
    fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== expectedBytes || stat.size > ARTIFACT_DELIVERY_MAX_BYTES) throw new Error("invalid snapshot")
    const bytes = Buffer.alloc(64 * 1024)
    const hash = createHash("sha256")
    let length = 0
    while (length < stat.size) {
      const count = readSync(fd, bytes, 0, Math.min(bytes.length, stat.size - length), length)
      if (!count) break
      hash.update(bytes.subarray(0, count))
      length += count
    }
    const after = fstatSync(fd)
    if (length !== expectedBytes || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || hash.digest("hex") !== sha256) throw new Error("snapshot changed")
    const opened = fd
    fd = undefined
    return opened
  } catch {
    throw new ArtifactError("artifact_snapshot_unavailable", "产物快照不可用，请重新发布", 404)
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function deliveryOwners() {
  const store = db()
  store.exec("CREATE TABLE IF NOT EXISTS artifact_delivery_owners (artifact_id INTEGER PRIMARY KEY, gateway_session_id TEXT NOT NULL)")
  return store
}

export function persistArtifactSnapshot(id: number, sha256: string, bytes: Buffer, gatewaySessionId?: string): void {
  if (gatewaySessionId) {
    const store = deliveryOwners()
    const owner = store.query("SELECT gateway_session_id FROM artifact_delivery_owners WHERE artifact_id=?").get(id) as any
    if (owner && owner.gateway_session_id !== gatewaySessionId) throw new ArtifactError("artifact_owner_conflict", "产物归属不匹配", 403)
    store.query("INSERT OR IGNORE INTO artifact_delivery_owners(artifact_id,gateway_session_id) VALUES(?,?)").run(id, gatewaySessionId)
  }
  writeAssetFile(id, sha256, publishedKey, bytes)
  closeSync(openSnapshot(id, sha256, bytes.length))
}

export function artifactDownloadUrl(gatewaySessionId: string, id: number, version: number): string {
  return `https://eimu.dev/api/agent/biz/sessions/${encodeURIComponent(gatewaySessionId)}/artifacts/${id}/versions/${version}/download`
}

/** Identity comes from an owned gateway session, never from request body or file path. */
export function downloadArtifactVersion(ownerGatewaySessionId: string, id: number, version: number): Response {
  const owner = deliveryOwners().query("SELECT gateway_session_id FROM artifact_delivery_owners WHERE artifact_id=?").get(id) as any
  const artifact = db().query("SELECT * FROM artifacts WHERE id=?").get(id) as any
  if (!artifact || !owner || owner.gateway_session_id !== ownerGatewaySessionId || artifact.session_id !== artifact.owner_key) throw new ArtifactError("artifact_not_found", "产物不存在", 404)
  const row = versionRow(id, version)
  if (!row) throw new ArtifactError("artifact_not_found", "产物不存在", 404)
  const fd = openSnapshot(id, String(row.sha256), Number(row.bytes))
  const verified = fstatSync(fd)
  const deliveryHash = createHash("sha256")
  let position = 0
  let closed = false
  const close = () => { if (!closed) { closed = true; closeSync(fd) } }
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      try {
        const before = fstatSync(fd)
        if (before.size !== verified.size || before.mtimeMs !== verified.mtimeMs || before.ctimeMs !== verified.ctimeMs) throw new Error("artifact snapshot changed during delivery")
        const chunk = Buffer.alloc(Math.min(64 * 1024, Number(row.bytes) - position))
        if (!chunk.length) { close(); controller.close(); return }
        const count = readSync(fd, chunk, 0, chunk.length, position)
        if (!count) throw new Error("artifact snapshot changed during delivery")
        const after = fstatSync(fd)
        if (after.size !== verified.size || after.mtimeMs !== verified.mtimeMs || after.ctimeMs !== verified.ctimeMs) throw new Error("artifact snapshot changed during delivery")
        deliveryHash.update(chunk.subarray(0, count))
        position += count
        if (position === Number(row.bytes) && deliveryHash.digest("hex") !== String(row.sha256)) throw new Error("artifact snapshot hash changed during delivery")
        controller.enqueue(chunk.subarray(0, count))
      } catch (error) { close(); controller.error(error) }
    },
    cancel() { close() },
  })
  const ext = path.extname(String(row.path ?? "")).replace(/[^.A-Za-z0-9]/g, "").slice(0, 16)
  const filename = `${String(artifact.slug).replace(/[^A-Za-z0-9_-]/g, "_")}-v${version}${ext}`
  return new Response(stream, { headers: {
    "Content-Type": /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+(?:;[^\r\n]*)?$/.test(String(row.content_type ?? "")) ? String(row.content_type) : contentTypeFor(filename),
    "Content-Length": String(row.bytes),
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Artifact-SHA256": String(row.sha256),
  } })
}
