import { createHmac } from "node:crypto"
// ─────────────────────────── HMAC 签名工具（逐字比照 src/lib/memory-hmac.ts，契约 §3）
// 为什么按 raw body bytes 验签：gateway 签的是它送出的那串位元组；repo 端一律
// `await req.arrayBuffer()` 取原始位元组再算。GET（export）没有 body → 对「空 bytes」验签。
// 凭据纪律：密钥与签名值永不写进 log／回应／记忆档。

export const MEMORY_SIGNATURE_HEADER = "x-memory-signature"

const SIGNATURE_PREFIX = "sha256="

/** 产生 `sha256=<hex>` 签名（核心演算法逐字等同 repo 版 signMemoryBody）。 */
export function signMemoryBody(rawBody: ArrayBuffer, secret: string): string {
  const digest = createHmac("sha256", secret).update(new Uint8Array(rawBody)).digest("hex")
  return `${SIGNATURE_PREFIX}${digest}`
}

/** gateway 包装：string/Uint8Array → 将送出的 raw bytes → 签名头值。 */
export function signMemoryBytes(raw: string | Uint8Array, secret: string): string {
  const bytes = typeof raw === "string" ? new TextEncoder().encode(raw) : raw
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  return signMemoryBody(buffer, secret)
}

/** 签名 GET 用的空 bytes 签名（§3.3/3.4 召回语料拉取同此演算法）。 */
export function signEmptyMemoryBody(secret: string): string {
  return signMemoryBytes(new Uint8Array(0), secret)
}
