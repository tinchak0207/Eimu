// 每个使用者的 agent 对话 key（可还原加密存储）。
//
// 为什么要可还原：agent 闸道要求代理层「每次请求都拿明文 sk-biz- key」去打。
// 既有 B 端 key 走 sha256 存储（biz-api-keys.ts 的注解写得很清楚：Blob 泄露也换不回
// 明文），那是为「聚合平台自己持 key、站上只做验证」设计的；这里恰恰相反，
// 站上要代管 key 并在每次代理请求时明文出示，所以必须另存一份可还原的密文。
// 权衡：AES-256-GCM + AGENT_KEY_ENCRYPTION_SECRET 加密后，就算 Blob / DB 整库泄露，
// 没有 secret 也解不开；而 secret 只走环境变量，不在任何存储里。
//
// 存储优先 Postgres（agent_user_keys 表），DB 不可用退回 Blob（沿用
// biz-api-key-store 的「新路径 + 修剪旧世代」惯例），再退回进程内存 —— 这条
// 兜底链与 B 端 key 的 biz-api-key-store 一致，只是对象换成「明文可还原」的密文。

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { del, get, list, put } from "@/lib/blob-backend";
import { BIZ_KEY_DEFAULT_RPM, generateBizApiKey } from "@/lib/biz-api-keys";
import { issueBizApiKey } from "@/lib/biz-api-key-store";
import { bizKeyDatabaseEnabled } from "@/lib/biz-api-key-repository";
import { getGenerationSql } from "@/lib/generation-core/database";

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
const BLOB_GENERATIONS_KEPT = 2;

type BlobRef = { url: string; pathname: string; uploadedAt: Date };

/** 进程内快取 / 最后兜底。拿到记录先落内存，省得每个请求都读一遍 Blob。 */
const memoryRecords = new Map<number, AgentUserKeyRecord>();

function agentKeyDatabaseEnabled(): boolean {
  return bizKeyDatabaseEnabled();
}

function hasBlobStore(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
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
    `.then(() => undefined);
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

async function insertAgentKeyIntoDatabase(record: AgentUserKeyRecord): Promise<void> {
  if (!agentKeyDatabaseEnabled()) return;
  await ensureAgentKeyTable();
  await getGenerationSql()`
    INSERT INTO agent_user_keys (user_id, biz_key_id, encrypted_key)
    VALUES (${record.userId}, ${record.bizKeyId}, ${record.encryptedKey})
    ON CONFLICT (user_id) DO NOTHING
  `;
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
    if (typeof item !== "object" || item === null) continue;
    const raw = item as Partial<AgentUserKeyRecord>;
    if (typeof raw.userId !== "number" || typeof raw.bizKeyId !== "string" || typeof raw.encryptedKey !== "string") continue;
    out.set(raw.userId, { userId: raw.userId, bizKeyId: raw.bizKeyId, encryptedKey: raw.encryptedKey });
  }
  return out;
}

/** 读最新一档可解析的索引；坏世代跳过往旧找，不让一次写坏抹掉全部。 */
async function readBlobRecords(): Promise<Map<number, AgentUserKeyRecord>> {
  const refs = await listStoreBlobs();
  for (const ref of refs) {
    try {
      const blob = await get(ref.url, { access: "public" });
      if (!blob || blob.statusCode !== 200) continue;
      const parsed = JSON.parse(await new Response(blob.stream).text()) as unknown;
      const records = coerceRecords(parsed);
      if (records.size > 0) return records;
    } catch {
      // 读不动的一代就跳过，往下找旧的。
    }
  }
  return new Map();
}

/** 新增/更新一把记录。每次写到新路径，再修剪旧世代 —— 沿用 biz-api-key-store。 */
async function writeBlobRecord(record: AgentUserKeyRecord): Promise<void> {
  if (!hasBlobStore()) return;
  const records = await readBlobRecords();
  records.set(record.userId, record);
  const previous = await listStoreBlobs().catch(() => [] as BlobRef[]);
  const pathname = `${BLOB_STORE_PREFIX}-${Date.now()}-${randomBytes(4).toString("hex")}.json`;
  await put(pathname, JSON.stringify([...records.values()]), {
    access: "public",
    contentType: "application/json",
    cacheControlMaxAge: 60,
  });
  const stale = previous.slice(BLOB_GENERATIONS_KEPT - 1);
  if (stale.length) {
    await del(stale.map((blob) => blob.url)).catch(() => undefined);
  }
}

async function findEncryptedKey(userId: number): Promise<string | null> {
  const cached = memoryRecords.get(userId);
  if (cached) return cached.encryptedKey;

  if (agentKeyDatabaseEnabled()) {
    try {
      const row = await findAgentKeyInDatabase(userId);
      if (row) {
        memoryRecords.set(userId, row);
        return row.encryptedKey;
      }
    } catch {
      // DB 瞬时不可用就往下走，不因一次查询失败就报错。
    }
  }

  if (hasBlobStore()) {
    try {
      const record = (await readBlobRecords()).get(userId);
      if (record) {
        memoryRecords.set(userId, record);
        return record.encryptedKey;
      }
    } catch {
      // 同上，退回内存。
    }
  }

  return null;
}

async function saveRecord(record: AgentUserKeyRecord): Promise<void> {
  if (agentKeyDatabaseEnabled()) {
    try {
      await insertAgentKeyIntoDatabase(record); // ON CONFLICT DO NOTHING：并发时后到者自然放弃
      memoryRecords.set(record.userId, record);
      return;
    } catch {
      // DB 刚好坏的瞬间，B 端 key 已登记（issueBizApiKey 有它自己的兜底），
      // 这里把加密记录落 Blob，别让本次签发的 key 因为一次 DB 抖动就失忆。
    }
  }
  await writeBlobRecord(record);
  memoryRecords.set(record.userId, record);
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

  await saveRecord(record);
  return generated.key;
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
    const secret = requireEncryptionSecret();
    const encrypted = await findEncryptedKey(userId);
    if (encrypted) return decryptAgentKey(encrypted, secret);
    return createAndStore(userId, secret);
  })();

  inflightForUser.set(userId, promise);
  try {
    return await promise;
  } finally {
    inflightForUser.delete(userId);
  }
}
