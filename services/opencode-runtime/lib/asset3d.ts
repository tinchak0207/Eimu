// 造世界资产的共用件：抓输入图、转存平台、读 GLB 出资产报告。
//
// 为什么转存：上游（HF Space 的 gradio 临时档、Marble 的签名链接）都会过期，
// 交给使用者和 game_asset_manifest 的必须是平台存储的长期 URL。
import { createHash } from "node:crypto"
import { safeFetch } from "./sandbox"

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

export const MAX_INPUT_IMAGE_BYTES = 20 * 1024 * 1024

export async function fetchInputImage(url: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array; mime: string; ext: string }> {
  const timed = AbortSignal.timeout(60_000)
  const res = await safeFetch(url, { signal: signal ? AbortSignal.any([signal, timed]) : timed })
  if (!res.ok) throw new Error(`参考图下载失败 HTTP ${res.status}`)
  const buf = new Uint8Array(await res.arrayBuffer())
  if (!buf.byteLength) throw new Error("参考图为空")
  if (buf.byteLength > MAX_INPUT_IMAGE_BYTES) throw new Error("参考图超过 20MB")
  if (buf[0] === 0x89 && buf[1] === 0x50) return { bytes: buf, mime: "image/png", ext: "png" }
  if (buf[0] === 0xff && buf[1] === 0xd8) return { bytes: buf, mime: "image/jpeg", ext: "jpg" }
  if (Buffer.from(buf.subarray(0, 4)).toString("ascii") === "RIFF" && Buffer.from(buf.subarray(8, 12)).toString("ascii") === "WEBP") {
    return { bytes: buf, mime: "image/webp", ext: "webp" }
  }
  throw new Error("参考图不是 png/jpg/webp")
}

/** 转存到平台存储（与 document_upload／video_upload 同一个网关入口），回长期公网 URL。 */
export async function storeAsset(bytes: Uint8Array, filename: string, sessionID: string): Promise<{ url: string; bytes: number; sha256: string }> {
  const res = await fetch(`${GATEWAY}/internal/media/upload?session_id=${encodeURIComponent(sessionID)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path_b64: Buffer.from(bytes).toString("base64"), filename }),
  })
  const data: any = await res.json().catch(() => ({}))
  if (!res.ok || !data?.ok || typeof data.url !== "string") {
    const err = typeof data?.error === "string" ? data.error : data?.error?.message
    throw new Error(`资产转存失败（HTTP ${res.status}${err ? `：${err}` : ""}）`)
  }
  return { url: data.url, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") }
}

export interface GlbReport {
  format: "glb"
  bytes: number
  sha256: string
  meshes: number
  primitives: number
  triangles: number
  vertices: number
  materials: number
  textures: number
  has_uv: boolean
  /** POSITION accessor 的 min/max 合并（模型空间，未乘节点变换）。 */
  bbox_min: number[] | null
  bbox_max: number[] | null
  generator: string | null
}

/** 只读 GLB 头与 JSON chunk 出统计；不是合法 GLB 直接抛（上游给坏档要当场暴露）。 */
export function glbReport(bytes: Uint8Array): GlbReport {
  const buf = Buffer.from(bytes)
  if (buf.length < 20 || buf.toString("ascii", 0, 4) !== "glTF") throw new Error("产物不是 GLB（魔数不符）")
  const version = buf.readUInt32LE(4)
  if (version !== 2) throw new Error(`GLB 版本 ${version} 不支持`)
  if (buf.readUInt32LE(8) !== buf.length) throw new Error("GLB 文件长度与头部声明不一致")
  const jsonLen = buf.readUInt32LE(12)
  if (jsonLen % 4 || 20 + jsonLen > buf.length) throw new Error("GLB JSON chunk 长度无效")
  if (buf.toString("ascii", 16, 20) !== "JSON") throw new Error("GLB 第一个 chunk 不是 JSON")
  const gltf = JSON.parse(buf.toString("utf8", 20, 20 + jsonLen))
  const accessors: any[] = gltf.accessors ?? []
  let primitives = 0
  let triangles = 0
  let vertices = 0
  let hasUv = false
  let min: number[] | null = null
  let max: number[] | null = null
  for (const mesh of gltf.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      primitives++
      const pos = accessors[prim.attributes?.POSITION]
      if (pos) {
        vertices += pos.count ?? 0
        if (Array.isArray(pos.min) && Array.isArray(pos.max)) {
          min = min ? min.map((v, i) => Math.min(v, pos.min[i])) : [...pos.min]
          max = max ? max.map((v, i) => Math.max(v, pos.max[i])) : [...pos.max]
        }
      }
      if (prim.attributes?.TEXCOORD_0 !== undefined) hasUv = true
      const mode = prim.mode ?? 4
      const idx = prim.indices !== undefined ? accessors[prim.indices] : null
      const count = idx ? idx.count : pos?.count
      if (!Number.isSafeInteger(count) || count < 0) throw new Error("GLB primitive 缺少有效的 accessor count")
      if (mode === 4) {
        if (count % 3) throw new Error("GLB triangle primitive 的元素数量不是 3 的倍数")
        triangles += count / 3
      } else if (mode === 5 || mode === 6) triangles += Math.max(0, count - 2)
      else throw new Error(`GLB primitive mode=${mode} 不是三角网格`)
    }
  }
  return {
    format: "glb",
    bytes: buf.length,
    sha256: createHash("sha256").update(buf).digest("hex"),
    meshes: (gltf.meshes ?? []).length,
    primitives,
    triangles,
    vertices,
    materials: (gltf.materials ?? []).length,
    textures: (gltf.textures ?? []).length,
    has_uv: hasUv,
    bbox_min: min,
    bbox_max: max,
    generator: typeof gltf.asset?.generator === "string" ? gltf.asset.generator : null,
  }
}
