// Emu OAuth 回环授权凭证（stateless signed code）。
//
// 流程：DSH 插件在本地起 loopback server → 站点 /api/auth/emu-oauth/start?port=…
// 发起 GitHub OAuth → 站点 callback 成功后把「用户已登录」的事实签成一段
// 60 秒过期的 HMAC 凭证，302 回 http://127.0.0.1:<port>/emu-oauth/callback?code=…
// → 插件拿 code 调 /api/auth/emu-oauth/exchange 换取自动签发的 B 端密钥。
//
// 凭证无状态：不带 userId 的存根、不写库，验证只需要重新算一遍 HMAC，
// 因此不会引入会话存储，也没有可以被重放的长期 token。

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { generationDatabaseConfigured, getGenerationSql } from "@/lib/generation-core/database";

/** 凭证有效期。60 秒足够 302 落地，又不至于被捡走慢慢重放。 */
export const EMU_OAUTH_CODE_TTL_MS = 60_000;

/**
 * 签名密钥：EMU_OAUTH_SECRET 优先，回退到 GitHub OAuth 客户端密钥。
 * 两者皆无时抛错 —— 由调用处（start/callback 的配置校验）捕获。
 */
export function emuOauthSecret(): string {
  const secret = process.env.EMU_OAUTH_SECRET?.trim() || process.env.GITHUB_CLIENT_SECRET?.trim();
  if (!secret) throw new Error("EMU_OAUTH_SECRET / GITHUB_CLIENT_SECRET 未配置");
  return secret;
}

function base64url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function signHmac(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

/**
 * 签发：payload = "{userId}.{expiry}"，code = base64url(payload) + "." + hmacHex。
 * base64url 不含 "."，所以按最后一个 "." 拆分即可还原两段。
 */
export function signEmuOauthCode(userId: number): string {
  const secret = emuOauthSecret();
  const payload = `${userId}.${Date.now() + EMU_OAUTH_CODE_TTL_MS}`;
  return `${base64url(payload)}.${signHmac(secret, payload)}`;
}

/**
 * 验证：拆两段 → timingSafeEqual 验 HMAC → 过期拒绝 → 返回 userId。
 * 任何一步失败都回 null（不抛），调用方按「无效凭证」处理。
 */
export function verifyEmuOauthCode(code: string): number | null {
  try {
    const secret = emuOauthSecret();
    const dot = code.lastIndexOf(".");
    if (dot <= 0 || dot === code.length - 1) return null;

    const payloadEncoded = code.slice(0, dot);
    const signature = code.slice(dot + 1);

    // base64url 解码对非法字符宽容，解码结果交给下面的严格数字校验兜底。
    const payload = Buffer.from(payloadEncoded, "base64url").toString("utf8");
    const sep = payload.lastIndexOf(".");
    if (sep <= 0 || sep === payload.length - 1) return null;

    const userIdRaw = payload.slice(0, sep);
    const expiryRaw = payload.slice(sep + 1);
    if (!/^\d+$/.test(userIdRaw) || !/^\d+$/.test(expiryRaw)) return null;

    const userId = Number(userIdRaw);
    const expiresAt = Number(expiryRaw);
    if (!Number.isSafeInteger(userId) || userId <= 0 || !Number.isSafeInteger(expiresAt)) return null;

    const expected = signHmac(secret, payload);
    const received = Buffer.from(signature, "utf8");
    const wanted = Buffer.from(expected, "utf8");
    if (received.length !== wanted.length || !timingSafeEqual(received, wanted)) return null;

    if (expiresAt <= Date.now()) return null;
    return userId;
  } catch {
    return null;
  }
}

const consumedUntil = new Map<string, number>();
let consumeSchema: Promise<void> | null = null;

function codeHash(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

function rememberConsumed(code: string): boolean {
  const now = Date.now();
  for (const [key, expiry] of consumedUntil) {
    if (expiry <= now) consumedUntil.delete(key);
  }
  if (consumedUntil.has(code)) return false;
  consumedUntil.set(code, now + EMU_OAUTH_CODE_TTL_MS);
  return true;
}

async function persistConsumed(code: string): Promise<"inserted" | "duplicate" | "unavailable"> {
  if (!generationDatabaseConfigured()) return "unavailable";
  try {
    if (!consumeSchema) {
      consumeSchema = (async () => {
        const sql = getGenerationSql();
        await sql`
          CREATE TABLE IF NOT EXISTS emu_oauth_consumed (
            code_hash text PRIMARY KEY,
            consumed_at timestamptz NOT NULL DEFAULT now()
          )
        `;
      })().catch((error) => {
        consumeSchema = null;
        throw error;
      });
    }
    await consumeSchema;
    const sql = getGenerationSql();
    const rows = await sql`
      INSERT INTO emu_oauth_consumed (code_hash)
      VALUES (${codeHash(code)})
      ON CONFLICT (code_hash) DO NOTHING
      RETURNING code_hash
    `;
    return rows.length > 0 ? "inserted" : "duplicate";
  } catch {
    return "unavailable";
  }
}

/** 验签并单次消费。同一 code 第二次调用返回 null。 */
export async function consumeEmuOauthCode(code: string): Promise<number | null> {
  const userId = verifyEmuOauthCode(code);
  if (userId === null) return null;
  if (!rememberConsumed(code)) return null;
  const persisted = await persistConsumed(code);
  if (persisted === "duplicate") return null;
  return userId;
}
