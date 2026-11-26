/**
 * 记忆库端点的 HMAC 验签（契约 §3，唯一真源）。
 *
 * 为什么按 raw body bytes 验：gateway 签的是它送出的那串位元组；repo 若先
 * `req.json()` 再重新序列化，键序、空白、`&`/`%20`/`+` 等 urlencoded 字形的差异
 * 会让签名对不上。所以端点一律 `await req.arrayBuffer()` 取原始位元组再算
 * HMAC-SHA256。
 *
 * GET（`/api/agent/memory/export`）没有 body → 对「空 bytes」验签，gateway 端同。
 *
 * 密钥 `MEMORY_INGEST_SECRET`：未配置时一律拒绝（401 由呼叫端回），不得放行、
 * 不得崩溃。不靠网络位置做安全（契约 §3）：端点在公网，只有持有密钥者能写。
 *
 * 凭据纪律：密钥与签名值永不写进 log／回应／记忆档。
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const MEMORY_SIGNATURE_HEADER = "x-memory-signature";

const SIGNATURE_PREFIX = "sha256=";

/** 读密钥（每次呼叫即时读 env，测试可动态设定）。未配置回空字串。 */
export function memoryIngestSecret(): string {
  return process.env.MEMORY_INGEST_SECRET?.trim() ?? "";
}

/** 产生 `sha256=<hex>` 签名。gateway 侧同算法；repo 只用于测试与自查。 */
export function signMemoryBody(rawBody: ArrayBuffer, secret: string): string {
  const digest = createHmac("sha256", secret).update(new Uint8Array(rawBody)).digest("hex");
  return `${SIGNATURE_PREFIX}${digest}`;
}

/** 解析 `sha256=<64 hex>`；形状不合（缺前缀／非 hex／长度不对）回 null。 */
function parseSignatureHeader(header: string | null): string | null {
  if (typeof header !== "string") return null;
  const value = header.trim();
  if (!value.toLowerCase().startsWith(SIGNATURE_PREFIX)) return null;
  const hex = value.slice(SIGNATURE_PREFIX.length).trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

/**
 * 验签：raw body bytes + `X-Memory-Signature: sha256=<hex>`。
 *
 * 无签名／错签名／密钥未配置 → false（呼叫端回 401）。
 * 长度不等先返回 false：`timingSafeEqual` 对长度不等的输入会抛错。
 */
export function verifyMemorySignature(rawBody: ArrayBuffer, header: string | null): boolean {
  const secret = memoryIngestSecret();
  if (!secret) {
    console.warn("[memory-hmac] MEMORY_INGEST_SECRET 未配置，记忆库端点拒绝所有请求。");
    return false;
  }
  const received = parseSignatureHeader(header);
  if (!received) return false;
  const expected = createHmac("sha256", secret).update(new Uint8Array(rawBody)).digest();
  const actual = Buffer.from(received, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
