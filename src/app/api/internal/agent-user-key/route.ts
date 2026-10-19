// Vercel 的账号 Agent key 只通过域隔离签名通道到控制面原子解析。
import { NextRequest, NextResponse } from "next/server";
import {
  BIZ_KEY_SYNC_SIGNATURE_HEADER,
  BIZ_KEY_SYNC_TIMESTAMP_HEADER,
  verifyBizKeySync,
} from "@/lib/biz-key-sync";
import {
  getOrCreateAgentKeyOnControlPlane,
  lookupAgentKeyOnControlPlane,
  type AgentLegacyKeyCandidate,
} from "@/lib/agent-user-key";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function reply(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  const secret = process.env.GENERATION_BILLING_RELAY_SECRET?.trim();
  if (!secret) return reply({ ok: false, message: "账号密钥签名通道未配置。" }, 503);
  const limit = 8192;
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return reply({ ok: false, message: "请求体过大。" }, 413);
  let rawBody: string;
  try {
    const reader = req.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > limit) {
            await reader.cancel();
            return reply({ ok: false, message: "请求体过大。" }, 413);
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
    }
    rawBody = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    return reply({ ok: false, message: "请求体格式无效。" }, 400);
  }
  if (!verifyBizKeySync({
    secret,
    timestamp: req.headers.get(BIZ_KEY_SYNC_TIMESTAMP_HEADER),
    signature: req.headers.get(BIZ_KEY_SYNC_SIGNATURE_HEADER),
    rawBody,
    signatureDomain: "agent-user-key",
  })) return reply({ ok: false, message: "签名校验失败。" }, 401);

  let body: { op?: unknown; user_id?: unknown; legacy?: unknown };
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid body");
    body = parsed as typeof body;
  } catch {
    return reply({ ok: false, message: "请求体格式无效。" }, 400);
  }
  if (typeof body.user_id !== "number" || !Number.isSafeInteger(body.user_id) || body.user_id <= 0 ||
      (body.op !== "lookup" && body.op !== "get-or-create")) {
    return reply({ ok: false, message: "账号或操作无效。" }, 400);
  }
  let legacy: AgentLegacyKeyCandidate | undefined;
  if (body.legacy !== undefined) {
    if (!body.legacy || typeof body.legacy !== "object" || Array.isArray(body.legacy)) {
      return reply({ ok: false, message: "历史账号密钥格式无效。" }, 400);
    }
    const candidate = body.legacy as Partial<AgentLegacyKeyCandidate>;
    if (typeof candidate.bizKeyId !== "string" || !candidate.bizKeyId ||
        typeof candidate.key !== "string" || !candidate.key.startsWith("sk-biz-")) {
      return reply({ ok: false, message: "历史账号密钥格式无效。" }, 400);
    }
    legacy = { bizKeyId: candidate.bizKeyId, key: candidate.key };
  }
  try {
    const key = body.op === "lookup"
      ? await lookupAgentKeyOnControlPlane(body.user_id)
      : await getOrCreateAgentKeyOnControlPlane(body.user_id, legacy);
    return reply({ ok: true, key });
  } catch {
    // 不回显/记录密钥、请求体、SQL 或可还原密文。
    return reply({ ok: false, message: "账号密钥持久化解析失败。" }, 503);
  }
}
