// 每个使用者的 agent 对话 key（可还原加密存储）。
//
// 为什么要可还原：agent 闸道要求代理层「每次请求都拿明文 sk-biz- key」去打。
// 既有 B 端 key 走 sha256 存储（biz-api-keys.ts 的注解写得很清楚：Blob 泄露也换不回
// 明文），那是为「聚合平台自己持 key、站上只做验证」设计的；这里恰恰相反，
// 站上要代管 key 并在每次代理请求时明文出示，所以必须另存一份可还原的密文。
// 权衡：AES-256-GCM + AGENT_KEY_ENCRYPTION_SECRET 加密后，就算 Blob / DB 整库泄露，
// 没有 secret 也解不开；而 secret 只走环境变量，不在任何存储里。
//
// 唯一写入源为控制面 Postgres（agent_user_keys.user_id 唯一键）。
// Vercel 无数据库时走现有 HMAC 签名代理；Blob 仅只读迁移历史 key，不能写全索引或退内存。

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { blobBackendConfigured, get, list } from "@/lib/blob-backend";
import { BIZ_KEY_DEFAULT_RPM, generateBizApiKey, hashBizApiKey } from "@/lib/biz-api-keys";
import { issueBizApiKey } from "@/lib/biz-api-key-store";
import { bizKeyDatabaseEnabled, findBizKeyByHash } from "@/lib/biz-api-key-repository";
import { getGenerationSql } from "@/lib/generation-core/database";
import { BIZ_KEY_SYNC_SIGNATURE_HEADER, BIZ_KEY_SYNC_TIMESTAMP_HEADER, signBizKeySync } from "@/lib/biz-key-sync";

export const AGENT_KEY_PAYLOAD_VERSION = "v1";

/**
 * 「环境没配好」与「临时故障」是两件事，用型别分开，不靠比对 message 字串。
 *
 * 前者不会自己好（重试一万次还是缺 env），后者值得重试。共用一个 503
 * 「服务暂不可用，请稍后重试」会让部署漏配 env 假装成闸道抖动，查起来很贵。
 */
export class AgentKeyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentKeyConfigError";
  }
}

interface AgentUserKeyRecord {
  userId: number;
  bizKeyId: string;
  encryptedKey: string;
}

// ─────────────────────────── AES-256-GCM 纯函数（可在 node --test 下测）

/** 由 secret 推导 32 字节 AES 金钥。规范输入是 64 hex；任意长度用 sha256 归一化。 */
function encryptionKey(secret: string): Buffer {
  if (/^[0-9a-f]{64}$/i.test(secret)) return Buffer.from(secret, "hex");
  // sha256 归一化只为开发便利；换归一化方式会让旧密文解不开，两种都固定住。
  return createHash("sha256").update(secret, "utf8").digest();
}

/**
 * 加密明文 key，格式 `v1:<iv_hex>:<authTag_hex>:<ciphertext_hex>`。
 * GCM 同时保证机密性与完整性：篡改任何一段都会在解密时抛错，不会解出错误明文。
 */
export function encryptAgentKey(plaintext: string, secret: string): string {
  const key = encryptionKey(secret);
  const iv = randomBytes(12); // GCM 建议 96-bit nonce。
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${AGENT_KEY_PAYLOAD_VERSION}:${iv.toString("hex")}:${authTag.toString("hex")}:${ciphertext.toString("hex")}`;
}

/**
 * 解密还原明文 key。
 * 所有 throw 讯息都是固定字串，不夹带明文或任何变量 —— 这个档案里绝不能
 * 出现「把明文印进错误」的写法，那等于把 key 送给下一个读错误讯息的人。
 */
export function decryptAgentKey(payload: string, secret: string): string {
  const parts = payload.split(":");
  if (parts.length !== 4 || parts[0] !== AGENT_KEY_PAYLOAD_VERSION) {
    throw new Error("agent key 密文格式无效。");
  }
  const [, ivHex, authTagHex, ciphertextHex] = parts;
  if (
    !ivHex || !authTagHex || !ciphertextHex ||
    !/^[0-9a-f]+$/i.test(ivHex) || !/^[0-9a-f]+$/i.test(authTagHex) || !/^[0-9a-f]+$/i.test(ciphertextHex)
  ) {
    throw new Error("agent key 密文格式无效。");
  }
  const key = encryptionKey(secret);
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  if (iv.length !== 12 || authTag.length !== 16) {
    throw new Error("agent key 密文格式无效。");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  // final() 会验 auth tag：secret 错或密文被改都会在此抛错，发生在返回明文之前。
  const clear = Buffer.concat([decipher.update(Buffer.from(ciphertextHex, "hex")), decipher.final()]);
  return clear.toString("utf8");
}

// ─────────────────────────── 存储：Postgres → Blob → 进程内存

const BLOB_STORE_PREFIX = "agent-user-keys/index.v1";

type BlobRef = { url: string; pathname: string; uploadedAt: Date };

function agentKeyDatabaseEnabled(): boolean {
  return bizKeyDatabaseEnabled();
}

function hasBlobStore(): boolean {
  return blobBackendConfigured();
}

let ensureTablePromise: Promise<void> | null = null;
/** 建表（幂等）。只跑一次，避免每个请求都发一条 DDL。 */
function ensureAgentKeyTable(): Promise<void> {
  if (!agentKeyDatabaseEnabled()) return Promise.resolve();
  if (!ensureTablePromise) {
    ensureTablePromise = getGenerationSql()`
      CREATE TABLE IF NOT EXISTS agent_user_keys (
        user_id bigint PRIMARY KEY,
        biz_key_id text NOT NULL,
        encrypted_key text NOT NULL,
        created_at timestamptz DEFAULT now()
      )
    `.then(() => undefined).catch((error) => {
      ensureTablePromise = null;
      throw error;
    });
  }
  return ensureTablePromise;
}

type Row = { user_id: number; biz_key_id: string; encrypted_key: string };

async function findAgentKeyInDatabase(userId: number): Promise<AgentUserKeyRecord | null> {
  if (!agentKeyDatabaseEnabled()) return null;
  await ensureAgentKeyTable();
  const rows = await getGenerationSql()<Row[]>`
    SELECT user_id, biz_key_id, encrypted_key
    FROM agent_user_keys
    WHERE user_id = ${userId}
    LIMIT 1
  `;
  const row = rows[0];
  return row
    ? { userId: Number(row.user_id), bizKeyId: row.biz_key_id, encryptedKey: row.encrypted_key }
    : null;
}

async function insertAgentKeyIntoDatabase(record: AgentUserKeyRecord): Promise<AgentUserKeyRecord | null> {
  if (!agentKeyDatabaseEnabled()) return null;
  await ensureAgentKeyTable();
  await getGenerationSql()`
    INSERT INTO agent_user_keys (user_id, biz_key_id, encrypted_key)
    VALUES (${record.userId}, ${record.bizKeyId}, ${record.encryptedKey})
    ON CONFLICT (user_id) DO NOTHING
  `;
  // 并发跨进程只认数据库获胜行，不能把本进程未写入的随机 key 缓存成账号身份。
  const winner = await findAgentKeyInDatabase(record.userId);
  if (!winner) throw new Error("agent key 持久化后无法读取。");
  return winner;
}

async function listStoreBlobs(): Promise<BlobRef[]> {
  const blobs: BlobRef[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix: BLOB_STORE_PREFIX, cursor });
    for (const blob of page.blobs) {
      blobs.push({ url: blob.url, pathname: blob.pathname, uploadedAt: blob.uploadedAt });
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return blobs.sort(
    (a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime() || b.pathname.localeCompare(a.pathname),
  );
}

function coerceRecords(payload: unknown): Map<number, AgentUserKeyRecord> {
  const out = new Map<number, AgentUserKeyRecord>();
  if (!Array.isArray(payload)) return out;
  for (const item of payload) {
    if (typeof item !== "object" || item === null) throw new Error("历史 agent key 记录格式无效。");
    const raw = item as Partial<AgentUserKeyRecord>;
    if (typeof raw.userId !== "number" || !Number.isSafeInteger(raw.userId) || raw.userId < 0 ||
        typeof raw.bizKeyId !== "string" || !raw.bizKeyId || typeof raw.encryptedKey !== "string" || !raw.encryptedKey) {
      throw new Error("历史 agent key 记录格式无效。");
    }
    out.set(raw.userId, { userId: raw.userId, bizKeyId: raw.bizKeyId, encryptedKey: raw.encryptedKey });
  }
  return out;
}

/** 历史 Blob 只读：按世代为当前账号寻找既有记录，读取失败不能伪装成不存在。 */
async function readLegacyBlobRecord(userId: number): Promise<AgentUserKeyRecord | null> {
  if (!hasBlobStore()) return null;
  for (const ref of await listStoreBlobs()) {
    const blob = await get(ref.url, { access: "public" });
    if (!blob || blob.statusCode !== 200) throw new Error("历史 agent key 读取失败。");
    const parsed: unknown = JSON.parse(await new Response(blob.stream).text());
    if (!Array.isArray(parsed)) throw new Error("历史 agent key 索引格式无效。");
    const record = coerceRecords(parsed).get(userId);
    if (record) return record;
  }
  return null;
}

export interface AgentLegacyKeyCandidate {
  bizKeyId: string;
  key: string;
}

/** 只读权威账号记录；库错误直接失败，不向 Blob/进程内存降级。 */
export async function lookupAgentKeyOnControlPlane(userId: number): Promise<string | null> {
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error("agent user id 无效。");
  if (!agentKeyDatabaseEnabled()) throw new AgentKeyConfigError("agent key 控制面数据库未配置。");
  const existing = await findAgentKeyInDatabase(userId);
  return existing ? decryptAgentKey(existing.encryptedKey, requireEncryptionSecret()) : null;
}

/** 内部签名端点的唯一写入路径。已存在账号保持原 key；候选必须由真实 B key 注册表证明属主。 */
export async function getOrCreateAgentKeyOnControlPlane(
  userId: number,
  legacy?: AgentLegacyKeyCandidate,
): Promise<string> {
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error("agent user id 无效。");
  if (!agentKeyDatabaseEnabled()) throw new AgentKeyConfigError("agent key 控制面数据库未配置。");
  const secret = requireEncryptionSecret();
  const existing = await findAgentKeyInDatabase(userId);
  if (existing) return decryptAgentKey(existing.encryptedKey, secret);
  if (legacy) {
    // 只认控制面注册表当前真实记录，不接受 Blob/env 认证兜底来证明迁移属主。
    const registered = await findBizKeyByHash(hashBizApiKey(legacy.key));
    if (!registered || !registered.enabled || registered.userId !== userId || registered.id !== legacy.bizKeyId) {
      throw new Error("历史 agent key 归属校验失败。");
    }
    const saved = await insertAgentKeyIntoDatabase({
      userId,
      bizKeyId: registered.id,
      encryptedKey: encryptAgentKey(legacy.key, secret),
    });
    if (!saved) throw new Error("agent key 持久化不可用。");
    return decryptAgentKey(saved.encryptedKey, secret);
  }
  return createAndStore(userId, secret);
}

/** 无 DB 的 Vercel 只调用中心原子 get-or-create；断线/拒绝不回落到本地另签身份。 */
async function relayAgentKey(userId: number): Promise<string> {
  const origin = process.env.GENERATION_CONTROL_PLANE_PROXY_ORIGIN?.trim().replace(/\/+$/, "");
  const secret = process.env.GENERATION_BILLING_RELAY_SECRET?.trim();
  if (!origin || !secret) throw new AgentKeyConfigError("agent key 签名代理通道未配置。");
  const request = async (op: "lookup" | "get-or-create", legacy?: AgentLegacyKeyCandidate): Promise<string | null> => {
    const rawBody = JSON.stringify({ op, user_id: userId, ...(legacy ? { legacy } : {}) });
    const timestamp = String(Date.now());
    const response = await fetch(`${origin}/image-control/api/internal/agent-user-key`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [BIZ_KEY_SYNC_TIMESTAMP_HEADER]: timestamp,
        [BIZ_KEY_SYNC_SIGNATURE_HEADER]: signBizKeySync(secret, timestamp, rawBody, "agent-user-key"),
      },
      body: rawBody,
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    const payload = await response.json().catch(() => null) as { ok?: boolean; key?: unknown } | null;
    if (!response.ok || payload?.ok !== true) throw new Error("agent key 控制面解析失败。");
    if (op === "lookup" && payload.key === null) return null;
    if (typeof payload.key !== "string" || !payload.key.startsWith("sk-biz-")) throw new Error("agent key 控制面响应无效。");
    return payload.key;
  };
  // 中央已有 key 时完全不依赖旧 Blob；仅首次迁移才读取旧记录。
  const existing = await request("lookup");
  if (existing) return existing;
  const legacyRecord = await readLegacyBlobRecord(userId);
  const legacy = legacyRecord ? {
    bizKeyId: legacyRecord.bizKeyId,
    key: decryptAgentKey(legacyRecord.encryptedKey, requireEncryptionSecret()),
  } : undefined;
  const key = await request("get-or-create", legacy);
  if (!key) throw new Error("agent key 控制面响应无效。");
  return key;
}

async function createAndStore(userId: number, secret: string): Promise<string> {
  const generated = generateBizApiKey();
  const issued = await issueBizApiKey(
    {
      label: `agent:user:${userId}`,
      userId,
      rpm: BIZ_KEY_DEFAULT_RPM,
      allowedModels: [],
      enabled: true,
    },
    { key: generated.key, keyHash: generated.keyHash },
  );

  const record: AgentUserKeyRecord = {
    userId,
    bizKeyId: issued.record.id,
    encryptedKey: encryptAgentKey(generated.key, secret),
  };

  const saved = await insertAgentKeyIntoDatabase(record);
  if (!saved) throw new Error("agent key 持久化不可用。");
  return decryptAgentKey(saved.encryptedKey, secret);
}

function requireEncryptionSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.AGENT_KEY_ENCRYPTION_SECRET?.trim();
  if (!secret) {
    throw new AgentKeyConfigError("AGENT_KEY_ENCRYPTION_SECRET 未配置，无法加解密 agent key。");
  }
  return secret;
}

/** 同一使用者的创建并发共享一把 Promise，避免两边各签一把 key。 */
const inflightForUser = new Map<number, Promise<string>>();

/** 取（必要时签发）某使用者的明文 agent key。明文只在服务端内存流转，绝不回给客户端。 */
export async function getOrCreateAgentKeyForUser(userId: number): Promise<string> {
  const inflight = inflightForUser.get(userId);
  if (inflight) return inflight;

  const promise = (async () => {
    if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error("agent user id 无效。");
    if (!agentKeyDatabaseEnabled()) return relayAgentKey(userId);
    const existing = await lookupAgentKeyOnControlPlane(userId);
    if (existing) return existing;
    // 控制面公开解析入口也必须迁移既有 Blob，不能抢在 Vercel 前另签身份。
    const old = await readLegacyBlobRecord(userId);
    const legacy = old ? { bizKeyId: old.bizKeyId, key: decryptAgentKey(old.encryptedKey, requireEncryptionSecret()) } : undefined;
    return getOrCreateAgentKeyOnControlPlane(userId, legacy);
  })();

  inflightForUser.set(userId, promise);
  try {
    return await promise;
  } finally {
    inflightForUser.delete(userId);
  }
}
