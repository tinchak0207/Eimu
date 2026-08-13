// B 端密钥的持久化。
//
// 三层数据源，优先级由高到低：
//
//   1. Postgres（`biz_api_key` 表）—— 权威源。与 control plane 同机同网，
//      是 /v1 认证路径上最短的依赖，且已经是耐久流水线的硬依赖，
//      用它不新增单点。签发与认证读写同一张表，不存在数据源分叉。
//   2. Vercel Blob —— 镜像。C 端 Vercel 部署没有 GENERATION_DATABASE_URL，
//      仍然走这条路；控制面则把它当异步备份写，写失败只记日志不影响签发。
//   3. `BIZ_API_KEY_HASHES` env —— 最后兜底。上面两层全挂时仍能放行已知 key。
//
// Blob 被 block 过一次（"Your store is blocked"），当时新签发的 key 全部 401，
// 应急手段是手动往 env 里加 hash 再重启容器。加进 Postgres 后这条路只是兜底，
// 且 env / Blob 里的记录会在首次读取时被导入 Postgres —— 让「临时兜底」
// 不再变成永久的第二份数据源。
//
// Blob 写入沿用 admin-pool-store 已在生产验证过的做法：每次写入落到新路径名 +
// 修剪旧世代。Blob 的 cacheControlMaxAge 下限是 60 秒，固定路径 + allowOverwrite
// 会让刚签发的密钥最长一分钟内校验不过 —— 对 B 端客户来说就是「你给的 key 是坏的」。

import { randomBytes } from "node:crypto";
import { del, get, list, put } from "@/lib/blob-backend";
import {
  hashBizApiKey,
  hashesEqual,
  looksLikeBizApiKey,
  previewBizApiKey,
  type BizApiKey,
  type BizKeyDraft,
  type RateWindow,
} from "./biz-api-keys";
import { consumeBizApiKeyRateLimit } from "./biz-api-key-rate-limit";
import {
  accumulateBizKeyUsageInDatabase,
  bizKeyDatabaseEnabled,
  deleteBizKeyFromDatabase,
  findBizKeyByHash,
  importBizKeysIntoDatabase,
  insertBizKeyIntoDatabase,
  listBizKeysFromDatabase,
  updateBizKeyInDatabase,
} from "./biz-api-key-repository";
import { bizKeySyncConfig, invokeBizKeySync } from "./biz-key-sync";

const STORE_PREFIX = "biz-keys/index.v1";

/** 保留的历史世代数，读者拿着略旧的 URL 也还能解析。 */
const GENERATIONS_KEPT = 2;

/** Env-backed records use this id prefix so they are never persisted back into Blob. */
const ENV_KEY_ID_PREFIX = "env-";

/**
 * Parse `BIZ_API_KEY_HASHES` into read-only auth records.
 *
 * Format: comma-separated `sha256(key)[:userId[:label]]`.
 * This is the emergency fallback when the Blob store is unavailable (e.g. a
 * suspended store), so `/v1/images/generations` can keep authenticating known
 * keys without reading the Blob key index.
 */
function envBizKeys(): BizApiKey[] {
  const raw = process.env.BIZ_API_KEY_HASHES?.trim();
  if (!raw) return [];

  const keys: BizApiKey[] = [];
  for (const part of raw.split(",")) {
    const token = part.trim();
    if (!token) continue;
    const [hash, userIdRaw, labelRaw] = token.split(":");
    if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) continue;
    const normalizedHash = hash.toLowerCase();
    keys.push({
      id: `${ENV_KEY_ID_PREFIX}${normalizedHash.slice(0, 12)}`,
      label: labelRaw ? `env:${labelRaw}` : `env:${normalizedHash.slice(0, 8)}`,
      keyHash: normalizedHash,
      keyPreview: "sk-biz-******",
      userId: Number(userIdRaw) || 0,
      enabled: true,
      rpm: 60,
      allowedModels: [],
      createdAt: 0,
      totalRequests: 0,
      totalImages: 0,
    });
  }
  return keys;
}

/** 进程内缓存。密钥校验在每个 B 端请求的关键路径上，不能每次都走两趟 Blob。 */
const CACHE_TTL_MS = 20_000;

let memoryKeys: BizApiKey[] = [];
let cache: { keys: BizApiKey[]; expiresAt: number } | null = null;

/** 限流窗口，按密钥 id。进程内，跨实例不共享 —— 见 consumeRateLimit 的说明。 */
const rateWindows = new Map<string, RateWindow>();

/** 用量计数缓冲。每次请求都写 Blob 会把 Blob 打爆，所以攒着定期落盘。 */
const usageBuffer = new Map<string, { requests: number; images: number; lastUsedAt: number }>();
const USAGE_FLUSH_INTERVAL_MS = 60_000;
let lastUsageFlushAt = 0;

function hasBlobStore(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

type BlobRef = { url: string; pathname: string; uploadedAt: Date };

async function listIndexBlobs(): Promise<BlobRef[]> {
  const blobs: BlobRef[] = [];
  let cursor: string | undefined;

  // list() 按路径名分页，必须走完所有页，否则最新索引可能落在第二页被漏掉。
  do {
    const page = await list({ prefix: STORE_PREFIX, cursor });
    for (const blob of page.blobs) {
      blobs.push({ url: blob.url, pathname: blob.pathname, uploadedAt: blob.uploadedAt });
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);

  return blobs.sort(
    (a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime() || b.pathname.localeCompare(a.pathname),
  );
}

function coerceKeys(payload: unknown): BizApiKey[] {
  if (!Array.isArray(payload)) return [];
  return payload.flatMap((item): BizApiKey[] => {
    if (typeof item !== "object" || item === null) return [];
    const raw = item as Partial<BizApiKey>;
    if (typeof raw.id !== "string" || typeof raw.keyHash !== "string" || typeof raw.userId !== "number") return [];
    return [{
      id: raw.id,
      label: typeof raw.label === "string" ? raw.label : "未命名",
      keyHash: raw.keyHash,
      keyPreview: typeof raw.keyPreview === "string" ? raw.keyPreview : "sk-biz-…",
      userId: raw.userId,
      enabled: raw.enabled !== false,
      rpm: typeof raw.rpm === "number" && raw.rpm > 0 ? raw.rpm : 60,
      allowedModels: Array.isArray(raw.allowedModels)
        ? raw.allowedModels.filter((model): model is string => typeof model === "string")
        : [],
      createdAt: typeof raw.createdAt === "number" ? raw.createdAt : 0,
      ...(typeof raw.lastUsedAt === "number" ? { lastUsedAt: raw.lastUsedAt } : {}),
      totalRequests: typeof raw.totalRequests === "number" ? raw.totalRequests : 0,
      totalImages: typeof raw.totalImages === "number" ? raw.totalImages : 0,
    }];
  });
}

async function fetchKeys(): Promise<BizApiKey[]> {
  try {
    // Walk newest-first and skip unreadable or empty generations: a transient
    // failure must not shadow older valid records with an empty index.
    const blobs = await listIndexBlobs();
    for (const latest of blobs) {
      const blob = await get(latest.url, { access: "public" });
      if (!blob || blob.statusCode !== 200) continue;
      const parsed = JSON.parse(await new Response(blob.stream).text()) as unknown;
      const keys = coerceKeys(parsed);
      if (keys.length > 0) return keys;
    }
    return [];
  } catch {
    // 索引读不出来时返回空表，等于所有 B 端请求 401。
    // 这比放行更安全 —— 宁可服务不可用，也不能让校验失效。
    return [];
  }
}

/**
 * 把 env 与 Blob 里的记录一次性收进 Postgres。
 *
 * 只跑一次（进程级）。失败不重试也不抛：导入是收敛动作，不是认证的前置条件 ——
 * 导入失败时 env / Blob 仍然作为兜底层参与匹配，认证不受影响。
 */
let importPromise: Promise<void> | null = null;

async function ensureExternalKeysImported(): Promise<void> {
  if (!bizKeyDatabaseEnabled()) return;
  if (!importPromise) {
    importPromise = (async () => {
      const external = [...envBizKeys()];
      if (hasBlobStore()) external.push(...(await fetchKeys().catch(() => [] as BizApiKey[])));
      if (!external.length) return;

      const imported = await importBizKeysIntoDatabase(external);
      if (imported > 0) {
        console.info(`[biz-keys] 已把 ${imported} 把外部来源密钥（env/Blob）导入 Postgres。`);
        cache = null;
      }
    })().catch((error) => {
      console.error("[biz-keys] 外部来源密钥导入 Postgres 失败，继续以兜底层认证。", error);
    });
  }
  await importPromise;
}

/**
 * 读全表。
 *
 * Postgres 可用时它是唯一权威源，env 仍然附加在后面 —— 导入尚未完成、
 * 或导入失败时不能让已知 key 掉线。id 去重时先到者胜（Postgres 优先）。
 */
async function readKeys(): Promise<BizApiKey[]> {
  const fallback = envBizKeys();

  if (bizKeyDatabaseEnabled()) {
    await ensureExternalKeysImported();
    const now = Date.now();
    if (cache && cache.expiresAt > now) return dedupeByHash([...cache.keys, ...fallback]);

    const rows = await listBizKeysFromDatabase().catch((error) => {
      console.error("[biz-keys] 读取 Postgres 密钥表失败，回退到 Blob。", error);
      return null;
    });
    if (rows) {
      cache = { keys: rows, expiresAt: now + CACHE_TTL_MS };
      return dedupeByHash([...rows, ...fallback]);
    }
  }

  if (!hasBlobStore()) return dedupeByHash([...memoryKeys, ...fallback]);

  const now = Date.now();
  if (cache && cache.expiresAt > now) return dedupeByHash([...cache.keys, ...fallback]);

  const keys = await fetchKeys();
  cache = { keys, expiresAt: now + CACHE_TTL_MS };
  return dedupeByHash([...keys, ...fallback]);
}

/** 同一把 key 可能同时存在于 Postgres 与 env，按 hash 保留第一条（权威源在前）。 */
function dedupeByHash(keys: BizApiKey[]): BizApiKey[] {
  const seen = new Set<string>();
  const result: BizApiKey[] = [];
  for (const key of keys) {
    const hash = key.keyHash.toLowerCase();
    if (seen.has(hash)) continue;
    seen.add(hash);
    result.push(key);
  }
  return result;
}

async function writeKeys(keys: BizApiKey[]): Promise<void> {
  const blobKeys = keys.filter((key) => !key.id.startsWith(ENV_KEY_ID_PREFIX));
  if (blobKeys.length === 0) {
    // Never persist an empty index: a transient backend read failure must not
    // wipe the key store (the env fallback would otherwise write "[]").
    cache = null;
    return;
  }
  if (!hasBlobStore()) {
    if (process.env.NODE_ENV === "production") throw new Error("BLOB_READ_WRITE_TOKEN 未配置。");
    memoryKeys = blobKeys;
    cache = null;
    return;
  }

  const previous = await listIndexBlobs().catch(() => [] as BlobRef[]);
  const pathname = `${STORE_PREFIX}-${Date.now()}-${randomBytes(4).toString("hex")}.json`;

  await put(pathname, JSON.stringify(blobKeys), {
    access: "public",
    contentType: "application/json",
    cacheControlMaxAge: 60,
  });

  cache = { keys, expiresAt: Date.now() + CACHE_TTL_MS };

  const stale = previous.slice(GENERATIONS_KEPT - 1);
  if (stale.length) {
    await del(stale.map((blob) => blob.url)).catch((error) => {
      console.error("[biz-keys] 清理旧索引失败。", error);
    });
  }
}

// ─────────────────────────────────────────────────────────── 对外接口

/**
 * 后台列表。
 *
 * Postgres 不在本机（Vercel）时走签名通道去控制面取权威列表，而不是读 Blob 镜像 ——
 * 后台显示的用量与启停状态必须是认证侧真正在用的那一份，否则管理员会对着
 * 一份过期镜像做判断。通道不可用才退回本地。
 */
export async function listBizApiKeys(): Promise<BizApiKey[]> {
  if (!bizKeyDatabaseEnabled()) {
    const sync = bizKeySyncConfig();
    if (sync) {
      try {
        const rows = await invokeBizKeySync({ op: "list" }, sync) as BizApiKey[] | null;
        if (Array.isArray(rows)) return dedupeByHash([...rows, ...envBizKeys()]);
      } catch (error) {
        console.error("[biz-keys] 从控制面读取密钥列表失败，退回本地镜像。", error);
      }
    }
  }
  return readKeys();
}

export interface IssuedBizApiKey {
  record: BizApiKey;
  /** 明文密钥，只在这一次返回。 */
  key: string;
}

export async function issueBizApiKey(draft: BizKeyDraft, generated: { key: string; keyHash: string }): Promise<IssuedBizApiKey> {
  const record: BizApiKey = {
    id: randomBytes(6).toString("hex"),
    label: draft.label,
    keyHash: generated.keyHash,
    keyPreview: previewBizApiKey(generated.key),
    userId: draft.userId,
    enabled: draft.enabled,
    rpm: draft.rpm,
    allowedModels: draft.allowedModels,
    createdAt: Date.now(),
    totalRequests: 0,
    totalImages: 0,
  };

  // 权威写先落地，失败就直接抛给 admin —— 签发成功却没落到认证读的那张表，
  // 比签发失败更糟：客户拿着一把永远 401 的 key。
  if (bizKeyDatabaseEnabled()) {
    await insertBizKeyIntoDatabase(record);
    cache = null;
    await mirrorToBlob();
    return { record, key: generated.key };
  }

  const sync = bizKeySyncConfig();
  if (sync) {
    await invokeBizKeySync({ op: "insert", record }, sync);
    cache = null;
    // Blob 仍然写一份：C 端 Vercel 这侧的读路径（无 Postgres）要看得到它。
    await writeKeys([record, ...(await readKeys())]).catch((error) => {
      console.error("[biz-keys] 签发已落控制面 Postgres，Blob 镜像失败。", error);
    });
    return { record, key: generated.key };
  }

  await writeKeys([record, ...(await readKeys())]);
  return { record, key: generated.key };
}

export async function updateBizApiKey(
  id: string,
  patch: Partial<Pick<BizApiKey, "label" | "enabled" | "rpm" | "allowedModels" | "userId">>,
): Promise<BizApiKey | null> {
  if (bizKeyDatabaseEnabled()) {
    const updated = await updateBizKeyInDatabase(id, patch);
    if (!updated) return null;
    cache = null;
    await mirrorToBlob();
    return updated;
  }

  const sync = bizKeySyncConfig();
  if (sync) {
    const updated = await invokeBizKeySync({ op: "update", id, patch }, sync) as BizApiKey | null;
    if (!updated) return null;
    cache = null;
    return updated;
  }

  const keys = await readKeys();
  const index = keys.findIndex((key) => key.id === id);
  if (index < 0) return null;

  const updated: BizApiKey = { ...keys[index], ...patch };
  const next = [...keys];
  next[index] = updated;
  await writeKeys(next);
  return updated;
}

export async function revokeBizApiKey(id: string): Promise<boolean> {
  if (bizKeyDatabaseEnabled()) {
    const deleted = await deleteBizKeyFromDatabase(id);
    if (!deleted) return false;
    cache = null;
    rateWindows.delete(id);
    usageBuffer.delete(id);
    await mirrorToBlob();
    return true;
  }

  const sync = bizKeySyncConfig();
  if (sync) {
    const deleted = await invokeBizKeySync({ op: "delete", id }, sync) === true;
    cache = null;
    rateWindows.delete(id);
    usageBuffer.delete(id);
    // 控制面已删，Blob 镜像也要删，否则 C 端读路径还认这把 key。
    const keys = (await readKeys()).filter((key) => key.id !== id);
    await writeKeys(keys).catch(() => undefined);
    return deleted;
  }

  const keys = await readKeys();
  const next = keys.filter((key) => key.id !== id);
  if (next.length === keys.length) return false;

  await writeKeys(next);
  rateWindows.delete(id);
  usageBuffer.delete(id);
  return true;
}

/**
 * 把 Postgres 的当前状态同步到 Blob。
 *
 * Blob 此时只是镜像：写失败只记日志。Blob 被 block 时签发照样成功 ——
 * 这正是问题 1 要消除的那个单点。
 */
async function mirrorToBlob(): Promise<void> {
  if (!hasBlobStore()) return;
  try {
    const rows = await listBizKeysFromDatabase();
    if (rows && rows.length) await writeKeys(rows);
  } catch (error) {
    console.error("[biz-keys] Blob 镜像写入失败（不影响签发，Postgres 已是权威源）。", error);
  }
}

export type BizKeyAuthResult =
  | { ok: true; key: BizApiKey }
  | { ok: false; status: number; message: string; code: string; retryAfterSeconds?: number };

/**
 * 按 hash 找 key，逐层降级。
 *
 * Postgres 可用时走单行索引查询而不是拉全表：认证在每个 B 端请求的关键路径上，
 * 密钥数量增长时不该线性变慢。查不到 / 查失败再落到 Blob + env 全表匹配 ——
 * 这一层同时兜住「Postgres 短暂不可用」和「导入还没跑完」两种情况。
 */
async function lookupByHash(hash: string): Promise<BizApiKey | null> {
  if (bizKeyDatabaseEnabled()) {
    try {
      const row = await findBizKeyByHash(hash);
      if (row) return row;
    } catch (error) {
      console.error("[biz-keys] Postgres 认证查询失败，回退到 Blob/env。", error);
    }
  }

  const keys = await readKeys();
  return keys.find((key) => hashesEqual(key.keyHash, hash)) ?? null;
}

/**
 * 校验 B 端密钥并计一次限流。
 *
 * 顺序有讲究：先做形状检查（免掉一次 Blob 读），再查表，最后才限流 ——
 * 无效密钥不应该消耗合法客户的限流名额。
 */
export async function authenticateBizApiKey(
  rawKey: string | null,
  options: { consumeRateLimit?: boolean } = {},
): Promise<BizKeyAuthResult> {
  if (!rawKey) {
    return { ok: false, status: 401, message: "缺少 API 密钥。请在 Authorization 头中提供 Bearer 令牌。", code: "missing_api_key" };
  }
  if (!looksLikeBizApiKey(rawKey)) {
    return { ok: false, status: 401, message: "API 密钥无效。", code: "invalid_api_key" };
  }

  const hash = hashBizApiKey(rawKey);
  const matched = await lookupByHash(hash);

  if (!matched) {
    return { ok: false, status: 401, message: "API 密钥无效。", code: "invalid_api_key" };
  }
  if (!matched.enabled) {
    return { ok: false, status: 403, message: "该 API 密钥已被停用。", code: "api_key_disabled" };
  }

  if (options.consumeRateLimit !== false) {
    const decision = await consumeBizApiKeyRateLimit(matched.id, matched.rpm, rateWindows);
    if (!decision.allowed) {
      return {
        ok: false,
        status: 429,
        message: `请求过于频繁，当前上限为每分钟 ${matched.rpm} 次。`,
        code: "rate_limit_exceeded",
        retryAfterSeconds: decision.retryAfterSeconds,
      };
    }
  }

  return { ok: true, key: matched };
}

/**
 * 记一次用量。攒在内存里，到间隔才落盘。
 *
 * 计数只用于后台观察，不是账本 —— 真正的账在 New API 的配额上，
 * 所以进程重启丢掉几条计数是可以接受的，换来的是不把 Blob 写爆。
 */
export function recordBizApiKeyUsage(id: string, images: number): void {
  const current = usageBuffer.get(id) ?? { requests: 0, images: 0, lastUsedAt: 0 };
  usageBuffer.set(id, {
    requests: current.requests + 1,
    images: current.images + images,
    lastUsedAt: Date.now(),
  });
}

/** 把攒下的用量落盘。由路由在响应之后通过 after() 调用。 */
export async function flushBizApiKeyUsage(force = false): Promise<void> {
  if (!usageBuffer.size) return;
  if (!force && Date.now() - lastUsageFlushAt < USAGE_FLUSH_INTERVAL_MS) return;

  lastUsageFlushAt = Date.now();
  const pending = new Map(usageBuffer);
  usageBuffer.clear();

  try {
    if (bizKeyDatabaseEnabled()) {
      // 用 SQL 自增：多实例同时 flush 时，读改写会互相盖掉计数。
      await accumulateBizKeyUsageInDatabase(pending);
      cache = null;
      return;
    }

    const keys = await readKeys();
    let changed = false;

    const next = keys.map((key) => {
      const usage = pending.get(key.id);
      if (!usage) return key;
      changed = true;
      return {
        ...key,
        totalRequests: key.totalRequests + usage.requests,
        totalImages: key.totalImages + usage.images,
        lastUsedAt: usage.lastUsedAt,
      };
    });

    if (changed) await writeKeys(next);
  } catch (error) {
    // 落盘失败就把计数还回缓冲，下次再试。
    for (const [id, usage] of pending) {
      const current = usageBuffer.get(id) ?? { requests: 0, images: 0, lastUsedAt: usage.lastUsedAt };
      usageBuffer.set(id, {
        requests: current.requests + usage.requests,
        images: current.images + usage.images,
        lastUsedAt: Math.max(current.lastUsedAt, usage.lastUsedAt),
      });
    }
    console.error("[biz-keys] 用量落盘失败，已退回缓冲。", error);
  }
}

/** 仅供测试使用。 */
export function __resetBizKeyStoreForTests(): void {
  memoryKeys = [];
  cache = null;
  rateWindows.clear();
  usageBuffer.clear();
  lastUsageFlushAt = 0;
  importPromise = null;
}
