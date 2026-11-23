/**
 * memory-redact.ts — 记忆链路的 secret 脱敏（对标 Codex phase1 sanitizer：送模型前＋入库前各一道）。
 *
 * 命中的片段一律替换为 `[REDACTED_SECRET]`。宁可多杀：这里只服务「记忆／历史索引」，
 * 误杀一个看起来像密钥的串，代价远小于把真密钥写进长期存储。
 */
const REDACTED = "[REDACTED_SECRET]"

const PATTERNS: RegExp[] = [
  // PEM 私钥块
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  // 常见前缀式 token
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  // JWT
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  // Authorization / Bearer
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  // 连接串里的口令
  /\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+):[^\s@/]{3,}@/gi,
  // key=value / key: value 形式
  /\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|口令|密码|密钥)\s*[:=：]\s*["']?[^\s"',;]{6,}["']?/gi,
]

export function redactSecrets(text: string): string {
  let out = String(text ?? "")
  for (const re of PATTERNS) {
    out = out.replace(re, (match, g1) => (typeof g1 === "string" && match.includes("://") ? `${g1}:${REDACTED}@` : REDACTED))
  }
  return out
}

export { REDACTED as REDACTED_SECRET }
