// 每個使用者的 agent 對話 key（可還原加密存儲）。
//
// 為什麼要可還原：agent 閘道要求代理層「每次請求都拿明文 sk-biz- key」去打。
// 既有 B 端 key 走 sha256 存儲（biz-api-keys.ts 的註解寫得很清楚：Blob 泄露也換不回
// 明文），那是為「聚合平台自己持 key、站上只做驗證」設計的；這裡恰恰相反，
// 站上要代管 key 並在每次代理請求時明文出示，所以必須另存一份可還原的密文。
// 權衡：AES-256-GCM + AGENT_KEY_ENCRYPTION_SECRET 加密後，就算 Blob / DB 整庫泄露，
// 沒有 secret 也解不開；而 secret 只走環境變量，不在任何存儲裡。
//
// 存儲優先 Postgres（agent_user_keys 表），DB 不可用退回 Blob（沿用
// biz-api-key-store 的「新路徑 + 修剪舊世代」慣例），再退回進程內存 —— 這條
// 兜底鏈與 B 端 key 的 biz-api-key-store 一致，只是對象換成「明文可還原」的密文。

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { del, get, list, put } from "@/lib/blob-backend";
import { BIZ_KEY_DEFAULT_RPM, generateBizApiKey } from "@/lib/biz-api-keys";
import { issueBizApiKey } from "@/lib/biz-api-key-store";
import { bizKeyDatabaseEnabled } from "@/lib/biz-api-key-repository";
import { getGenerationSql } from "@/lib/generation-core/database";

export const AGENT_KEY_PAYLOAD_VERSION = "v1";

/**
 * 「環境沒配好」與「臨時故障」是兩件事，用型別分開，不靠比對 message 字串。
 *
 * 前者不會自己好（重試一萬次還是缺 env），後者值得重試。共用一個 503
 * 「服务暂不可用，请稍后重试」會讓部署漏配 env 假裝成閘道抖動，查起來很貴。
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

// ─────────────────────────── AES-256-GCM 純函數（可在 node --test 下測）

/** 由 secret 推導 32 字節 AES 金鑰。規範輸入是 64 hex；任意長度用 sha256 歸一化。 */
function encryptionKey(secret: string): Buffer {
  if (/^[0-9a-f]{64}$/i.test(secret)) return Buffer.from(secret, "hex");
  // sha256 歸一化只為開發便利；換歸一化方式會讓舊密文解不開，兩種都固定住。
  return createHash("sha256").update(secret, "utf8").digest();
}

/**
 * 加密明文 key，格式 `v1:<iv_hex>:<authTag_hex>:<ciphertext_hex>`。
 * GCM 同時保證機密性與完整性：篡改任何一段都會在解密時拋錯，不會解出錯誤明文。
 */
export function encryptAgentKey(plaintext: string, secret: string): string {
  const key = encryptionKey(secret);
  const iv = randomBytes(12); // GCM 建議 96-bit nonce。
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${AGENT_KEY_PAYLOAD_VERSION}:${iv.toString("hex")}:${authTag.toString("hex")}:${ciphertext.toString("hex")}`;
}

/**
 * 解密還原明文 key。
 * 所有 throw 訊息都是固定字串，不夾帶明文或任何變量 —— 這個檔案裡絕不能
 * 出現「把明文印進錯誤」的寫法，那等於把 key 送給下一個讀錯誤訊息的人。
 */
export function decryptAgentKey(payload: string, secret: string): string {
  const parts = payload.split(":");
  if (parts.length !== 4 || parts[0] !== AGENT_KEY_PAYLOAD_VERSION) {
    throw new Error("agent key 密文格式無效。");
  }
  const [, ivHex, authTagHex, ciphertextHex] = parts;
  if (
    !ivHex || !authTagHex || !ciphertextHex ||
    !/^[0-9a-f]+$/i.test(ivHex) || !/^[0-9a-f]+$/i.test(authTagHex) || !/^[0-9a-f]+$/i.test(ciphertextHex)
  ) {
    throw new Error("agent key 密文格式無效。");
  }
  const key = encryptionKey(secret);
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  if (iv.length !== 12 || authTag.length !== 16) {
    throw new Error("agent key 密文格式無效。");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  // final() 會驗 auth tag：secret 錯或密文被改都會在此拋錯，發生在返回明文之前。
  const clear = Buffer.concat([decipher.update(Buffer.from(ciphertextHex, "hex")), decipher.final()]);
  return clear.toString("utf8");
}

// ─────────────────────────── 存儲：Postgres → Blob → 進程內存

const BLOB_STORE_PREFIX = "agent-user-keys/index.v1";
const BLOB_GENERATIONS_KEPT = 2;

type BlobRef = { url: string; pathname: string; uploadedAt: Date };

/** 進程內快取 / 最後兜底。拿到記錄先落內存，省得每個請求都讀一遍 Blob。 */
const memoryRecords = new Map<number, AgentUserKeyRecord>();

function agentKeyDatabaseEnabled(): boolean {
  return bizKeyDatabaseEnabled();
}

function hasBlobStore(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

let ensureTablePromise: Promise<void> | null = null;
/** 建表（幂等）。只跑一次，避免每個請求都發一條 DDL。 */
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

/** 讀最新一檔可解析的索引；壞世代跳過往舊找，不讓一次寫壞抹掉全部。 */
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
      // 讀不動的一代就跳過，往下找舊的。
    }
  }
  return new Map();
}

/** 新增/更新一把記錄。每次寫到新路徑，再修剪舊世代 —— 沿用 biz-api-key-store。 */
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
      // DB 瞬時不可用就往下走，不因一次查詢失敗就報錯。
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
      // 同上，退回內存。
    }
  }

  return null;
}

async function saveRecord(record: AgentUserKeyRecord): Promise<void> {
  if (agentKeyDatabaseEnabled()) {
    try {
      await insertAgentKeyIntoDatabase(record); // ON CONFLICT DO NOTHING：併發時後到者自然放棄
      memoryRecords.set(record.userId, record);
      return;
    } catch {
      // DB 剛好壞的瞬間，B 端 key 已登記（issueBizApiKey 有它自己的兜底），
      // 這裡把加密記錄落 Blob，別讓本次簽發的 key 因為一次 DB 抖動就失憶。
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
    throw new AgentKeyConfigError("AGENT_KEY_ENCRYPTION_SECRET 未配置，無法加解密 agent key。");
  }
  return secret;
}

/** 同一使用者的創建併發共享一把 Promise，避免兩邊各簽一把 key。 */
const inflightForUser = new Map<number, Promise<string>>();

/** 取（必要時簽發）某使用者的明文 agent key。明文只在服務端內存流轉，絕不回給客戶端。 */
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
