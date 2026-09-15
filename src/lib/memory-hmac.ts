/**
 * 記憶庫端點的 HMAC 驗簽（契約 §3，唯一真源）。
 *
 * 為什麼按 raw body bytes 驗：gateway 簽的是它送出的那串位元組；repo 若先
 * `req.json()` 再重新序列化，鍵序、空白、`&`/`%20`/`+` 等 urlencoded 字形的差異
 * 會讓簽名對不上。所以端點一律 `await req.arrayBuffer()` 取原始位元組再算
 * HMAC-SHA256。
 *
 * GET（`/api/agent/memory/export`）沒有 body → 對「空 bytes」驗簽，gateway 端同。
 *
 * 密鑰 `MEMORY_INGEST_SECRET`：未配置時一律拒絕（401 由呼叫端回），不得放行、
 * 不得崩潰。不靠網絡位置做安全（契約 §3）：端點在公網，只有持有密鑰者能寫。
 *
 * 憑據紀律：密鑰與簽名值永不寫進 log／回應／記憶檔。
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const MEMORY_SIGNATURE_HEADER = "x-memory-signature";

const SIGNATURE_PREFIX = "sha256=";

/** 讀密鑰（每次呼叫即時讀 env，測試可動態設定）。未配置回空字串。 */
export function memoryIngestSecret(): string {
  return process.env.MEMORY_INGEST_SECRET?.trim() ?? "";
}

/** 產生 `sha256=<hex>` 簽名。gateway 側同算法；repo 只用於測試與自查。 */
export function signMemoryBody(rawBody: ArrayBuffer, secret: string): string {
  const digest = createHmac("sha256", secret).update(new Uint8Array(rawBody)).digest("hex");
  return `${SIGNATURE_PREFIX}${digest}`;
}

/** 解析 `sha256=<64 hex>`；形狀不合（缺前綴／非 hex／長度不對）回 null。 */
function parseSignatureHeader(header: string | null): string | null {
  if (typeof header !== "string") return null;
  const value = header.trim();
  if (!value.toLowerCase().startsWith(SIGNATURE_PREFIX)) return null;
  const hex = value.slice(SIGNATURE_PREFIX.length).trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

/**
 * 驗簽：raw body bytes + `X-Memory-Signature: sha256=<hex>`。
 *
 * 無簽名／錯簽名／密鑰未配置 → false（呼叫端回 401）。
 * 長度不等先返回 false：`timingSafeEqual` 對長度不等的輸入會拋錯。
 */
export function verifyMemorySignature(rawBody: ArrayBuffer, header: string | null): boolean {
  const secret = memoryIngestSecret();
  if (!secret) {
    console.warn("[memory-hmac] MEMORY_INGEST_SECRET 未配置，記憶庫端點拒絕所有請求。");
    return false;
  }
  const received = parseSignatureHeader(header);
  if (!received) return false;
  const expected = createHmac("sha256", secret).update(new Uint8Array(rawBody)).digest();
  const actual = Buffer.from(received, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
