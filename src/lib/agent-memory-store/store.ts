import { list } from "@/lib/blob-backend";
import { CATALOG_JOURNAL_PREFIX, MEMORY_CATALOG_VERSION } from "./constants";
import { bodyKey, catalogEntryKey, catalogKey, legacyPrivateBodyKey, memoryIdentity, revisionKey } from "./keys";
import { readBlobJson, writeBlobText } from "./blob-io";
import { normalizeAuditIdList, normalizeAuditString, normalizeContributors, normalizeIsoField, normalizeLastOperation, normalizeProposed, normalizeSupersedes } from "./normalize";
import type { AgentMemoryDoc, MemoryCatalog, MemoryCatalogEntry, MemoryScope } from "./types";

// ─────────────────────────── 进程内兜底

const docsMemory = new Map<string, AgentMemoryDoc>();
const catalogMemory = new Map<string, MemoryCatalog>();
const CATALOG_MEMORY_KEY = "catalog";
/** 旧世代正文的进程内副本（纯 Map 模式下 history 仍有数据）。 */
const revisionsMemory = new Map<string, AgentMemoryDoc>();
/** catalog 内存缓存时间戳（毫秒）；TTL 到期才重新 list 日志。 */
let catalogCachedAt = 0;
/** catalog 缓存 TTL：60s（写入路径会立即刷新本进程缓存，不用等 TTL）。 */
const CATALOG_CACHE_TTL_MS = 60_000;
/** 日志 list 分页硬上限（每页 1000；防御性终止，避免病态回圈）。 */
const CATALOG_JOURNAL_MAX_PAGES = 50;
// ─────────────────────────── catalog

/**
 * catalog 写入串行化（进程内 promise 链）：blob 的 read-modify-write 天然有竞态，
 * `revision` 只是跨进程检测手段；同一进程内由本锁保证三个写入口（ingest／retract／
 * review）不会互相覆盖。锁任何时刻只包「整个函数体」，不把锁泄漏给调用方。
 */
let catalogLock: Promise<unknown> = Promise.resolve();

function withCatalogLock<T>(work: () => Promise<T>): Promise<T> {
  // 前一个任务失败也要继续跑下一个；链上只保留已吞错的 promise，避免 unhandled rejection。
  const run = catalogLock.then(work, work);
  catalogLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** catalog 条目正规化（snapshot 与逐文档日志共用；旧档缺栏不报错）。 */
function normalizeCatalogEntry(raw: MemoryCatalogEntry): MemoryCatalogEntry {
  const entry = (raw ?? {}) as MemoryCatalogEntry;
  return {
    ...entry,
    revision:
      typeof entry.revision === "number" && Number.isFinite(entry.revision)
        ? entry.revision
        : 0,
    contributors: normalizeContributors(
      (entry as unknown as { contributors?: unknown })?.contributors,
    ),
    validFrom: normalizeIsoField((entry as unknown as { validFrom?: unknown })?.validFrom),
    validTo: normalizeIsoField((entry as unknown as { validTo?: unknown })?.validTo),
    lastConfirmedAt: normalizeIsoField(
      (entry as unknown as { lastConfirmedAt?: unknown })?.lastConfirmedAt,
    ),
    aliases: normalizeAuditIdList((entry as unknown as { aliases?: unknown })?.aliases),
  };
}

interface CatalogJournalRead {
  entries: MemoryCatalogEntry[];
  maxUploadedAt: number;
  ok: boolean;
}

/**
 * 分页读逐文档 catalog 日志：只 get `uploadedAt > sinceMs` 的条目（无快照时 sinceMs=0
 * 即全量）。list 失败返回 ok=false，调用方保留缓存／快照，绝不把失败当「目录为空」。
 */
async function readCatalogJournal(sinceMs: number): Promise<CatalogJournalRead> {
  const entries: MemoryCatalogEntry[] = [];
  let maxUploadedAt = 0;
  let cursor: string | undefined;
  try {
    for (let page = 0; page < CATALOG_JOURNAL_MAX_PAGES; page += 1) {
      const result = await list({
        prefix: CATALOG_JOURNAL_PREFIX,
        limit: 1000,
        ...(cursor ? { cursor } : {}),
      });
      const blobs = Array.isArray(result?.blobs) ? result.blobs : [];
      for (const blob of blobs) {
        const uploadedMs =
          blob.uploadedAt instanceof Date
            ? blob.uploadedAt.getTime()
            : Date.parse(String(blob.uploadedAt));
        if (Number.isFinite(uploadedMs)) maxUploadedAt = Math.max(maxUploadedAt, uploadedMs);
        // 只用不早于快照水位的日志；用 `>=` 是为了避免「list 快照同毫秒写入」
        // 被水位线永久跳过（边界条目每次刷新重读一次，合并按 identity 幂等）。
        if (!(uploadedMs >= sinceMs)) continue;
        const pathname = typeof blob.pathname === "string" ? blob.pathname : "";
        if (!pathname) continue;
        const parsed = await readBlobJson<MemoryCatalogEntry>(pathname);
        if (!parsed || typeof parsed !== "object" || typeof parsed.id !== "string") continue;
        entries.push(normalizeCatalogEntry(parsed));
      }
      if (!result?.hasMore || !result?.cursor) {
        return { entries, maxUploadedAt, ok: true };
      }
      cursor = result.cursor;
    }
    // 分页上限内仍未列完：**不推进 watermark**（ok=false），避免把未读条目永久跳过。
    return { entries, maxUploadedAt: 0, ok: false };
  } catch {
    return { entries: [], maxUploadedAt: 0, ok: false };
  }
}

/**
 * 按 **identity** 合并去重：同 scope/ownerKey/domain/slug 只保留一条，
 * `updatedAt` 较新者胜（同值取后写入者，保留其 id）。旧数据里同 identity 不同 id 的
 * 重复条目会合并成一条；被淘汰的旧 id 进入 `aliases`，旧 id 仍可查 history/retract/review。
 */
function mergeCatalogEntries(
  groups: Array<MemoryCatalogEntry[]>,
): MemoryCatalogEntry[] {
  const byIdentity = new Map<string, MemoryCatalogEntry>();
  const order: string[] = [];
  for (const group of groups) {
    for (const entry of group) {
      if (!entry || typeof entry.id !== "string") continue;
      const identity = memoryIdentity(entry);
      const existing = byIdentity.get(identity);
      if (!existing) {
        byIdentity.set(identity, entry);
        order.push(identity);
        continue;
      }
      const winner =
        String(entry.updatedAt) >= String(existing.updatedAt) ? entry : existing;
      const loser = winner === entry ? existing : entry;
      const aliases = normalizeAuditIdList([
        ...(winner.aliases ?? []),
        ...(loser.aliases ?? []),
        loser.id,
      ])?.filter((id) => id !== winner.id);
      byIdentity.set(
        identity,
        aliases && aliases.length > 0 ? { ...winner, aliases } : winner,
      );
    }
  }
  return order
    .map((identity) => byIdentity.get(identity))
    .filter((entry): entry is MemoryCatalogEntry => Boolean(entry));
}

/** 按 id 或 aliases 找条目（合并后旧 id 仍可定位）。 */
function findCatalogEntryByIdOrAlias(
  catalog: MemoryCatalog,
  id: string,
): MemoryCatalogEntry | null {
  return (
    catalog.entries.find(
      (entry) => entry.id === id || (entry.aliases ?? []).includes(id),
    ) ?? null
  );
}

/** 条目是否被指定的 docIds 命中（含旧 id alias）。 */
function entryMatchesIds(
  entry: MemoryCatalogEntry,
  docIds: Set<string>,
): boolean {
  if (docIds.has(entry.id)) return true;
  return (entry.aliases ?? []).some((alias) => docIds.has(alias));
}

/**
 * 读目录：内存缓存 60s TTL；刷新时以 `catalog.json` 聚合快照为底，再分页 list
 * `agent-memory/catalog/` 逐文档日志，只 get 比快照 `journalSyncedAt` 更新的条目，
 * 按 id（updatedAt 较新者胜）合并。合并后 journalSyncedAt 推进到本次 list 的最大
 * uploadedAt，并把聚合快照 best-effort 写回。
 *
 * 正确性不依赖快照：并发进程各写自己的条目文件，任何一次刷新都能把两边合起来。
 */
async function loadCatalog(): Promise<MemoryCatalog> {
  const cached = catalogMemory.get(CATALOG_MEMORY_KEY);
  const now = Date.now();
  if (cached && now - catalogCachedAt < CATALOG_CACHE_TTL_MS) return cached;

  const snapshotRaw = await readBlobJson<MemoryCatalog>(catalogKey());
  const snapshotEntries =
    snapshotRaw && Array.isArray(snapshotRaw.entries)
      ? snapshotRaw.entries.map(normalizeCatalogEntry)
      : [];
  const snapshotSyncedAt =
    snapshotRaw &&
    typeof snapshotRaw.journalSyncedAt === "number" &&
    Number.isFinite(snapshotRaw.journalSyncedAt)
      ? Math.max(0, Math.floor(snapshotRaw.journalSyncedAt))
      : 0;
  const journal = await readCatalogJournal(snapshotSyncedAt);

  // 后端完全不可达且本进程已有缓存：保留缓存（Map 兜底），只续 TTL。
  if (!snapshotRaw && !journal.ok && cached && journal.entries.length === 0) {
    catalogCachedAt = now;
    return cached;
  }

  const snapshotRevision =
    snapshotRaw && typeof snapshotRaw.revision === "number" && Number.isFinite(snapshotRaw.revision)
      ? Math.max(0, Math.floor(snapshotRaw.revision))
      : 0;
  const next: MemoryCatalog = {
    version: MEMORY_CATALOG_VERSION,
    revision: Math.max(snapshotRevision, cached?.revision ?? 0),
    journalSyncedAt: journal.ok
      ? Math.max(snapshotSyncedAt, journal.maxUploadedAt)
      : snapshotSyncedAt,
    generatedAt: new Date().toISOString(),
    // 缓存条目也并入：本进程写入但 blob 落盘失败／快照被覆盖时仍可保留（journal 较新者胜）。
    entries: mergeCatalogEntries([
      snapshotEntries,
      journal.entries,
      cached?.entries ?? [],
    ]),
  };
  catalogMemory.set(CATALOG_MEMORY_KEY, next);
  catalogCachedAt = now;
  // 聚合快照 best-effort：失败不影响真相（逐文档日志仍在）。
  if (journal.ok) void writeBlobText(catalogKey(), JSON.stringify(next));
  return next;
}

/**
 * 保存聚合快照（best-effort）。正确性由逐文档日志保证，这里的 revision 只作审计／
 * 兼容；不再依赖 re-read+merge 防覆盖。`expectedRevision` 保留为签名兼容。
 *
 * 写失败只 console.error（不回显正文、不 throw）并照旧更新进程缓存。
 */
async function saveCatalog(
  catalog: MemoryCatalog,
  expectedRevision?: number,
): Promise<void> {
  const currentRevision =
    typeof catalog.revision === "number" && Number.isFinite(catalog.revision)
      ? Math.max(0, Math.floor(catalog.revision))
      : 0;
  const expected =
    typeof expectedRevision === "number" && Number.isFinite(expectedRevision)
      ? Math.max(0, Math.floor(expectedRevision))
      : currentRevision;

  const next: MemoryCatalog = {
    version: MEMORY_CATALOG_VERSION,
    revision: Math.max(currentRevision, expected) + 1,
    journalSyncedAt:
      typeof catalog.journalSyncedAt === "number" &&
      Number.isFinite(catalog.journalSyncedAt)
        ? Math.max(0, Math.floor(catalog.journalSyncedAt))
        : 0,
    generatedAt: new Date().toISOString(),
    // 快照也按 identity 去重，避免并发／旧数据把重复条目写回快照。
    entries: mergeCatalogEntries([catalog.entries]),
  };
  const ok = await writeBlobText(catalogKey(), JSON.stringify(next));
  if (!ok) {
    console.error("[agent-memory-store] catalog 写入失败（已用进程内缓存兜底）");
  }
  catalogMemory.set(CATALOG_MEMORY_KEY, next);
  catalogCachedAt = Date.now();
}

/** 条目变化时写它自己的日志文件（并发写不同 doc 不共享文件）。失败静默。 */
async function writeCatalogEntry(entry: MemoryCatalogEntry): Promise<void> {
  await writeBlobText(catalogEntryKey(entry), JSON.stringify(entry));
}

/** 仅测试：重置进程内状态。 */
export function __resetAgentMemoryStoreForTests(): void {
  docsMemory.clear();
  catalogMemory.clear();
  revisionsMemory.clear();
  catalogCachedAt = 0;
}
// ─────────────────────────── 读写正文

/**
 * blob 读回正文的形状防线：后端错误响应体（如 404 JSON）也可能被 JSON.parse 成普通
 * 对象。只有「普通对象 + 身份三件套（scope/domain/slug）全对 + 合法 status」才算真
 * 文档，任一不符一律当不存在（调用方据此回退，绝不把错误体当 live 文档）。
 */
function isDocShapeValid(
  value: unknown,
  scope: MemoryScope,
  domain: string,
  slug: string,
): value is AgentMemoryDoc {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const doc = value as Record<string, unknown>;
  return (
    doc.slug === slug &&
    doc.domain === domain &&
    doc.scope === scope &&
    (doc.status === "active" ||
      doc.status === "pending_review" ||
      doc.status === "retracted" ||
      doc.status === "superseded")
  );
}

async function readDoc(
  scope: MemoryScope,
  ownerKey: string | undefined,
  domain: string,
  slug: string,
): Promise<AgentMemoryDoc | null> {
  const key = bodyKey(scope, ownerKey, domain, slug);
  const cached = docsMemory.get(key);
  if (cached) return cached;
  // 先读新 key（private 已含 domain）；不存在再回落旧路径（只读兼容）。
  let parsed = await readBlobJson<AgentMemoryDoc>(key);
  if (!parsed && scope === "private") {
    parsed = await readBlobJson<AgentMemoryDoc>(legacyPrivateBodyKey(ownerKey, slug));
  }
  if (parsed) {
    if (!isDocShapeValid(parsed, scope, domain, slug)) {
      // 错误体不得进入进程缓存（避免后续读取继续被污染）。
      docsMemory.delete(key);
      return null;
    }
    // 旧档没有 contributors 栏：读取容错为 []，且**不因缺栏降级既有 status**。
    const createdAt = typeof parsed.createdAt === "string" ? parsed.createdAt : "";
    const updatedAt = typeof parsed.updatedAt === "string" ? parsed.updatedAt : "";
    const doc: AgentMemoryDoc = {
      ...parsed,
      contributors: normalizeContributors(
        (parsed as unknown as { contributors?: unknown })?.contributors,
      ),
      // 旧档没有 proposed：保持 undefined；坏形状视为无提案（不丢 live 内容）。
      proposed: normalizeProposed((parsed as unknown as { proposed?: unknown })?.proposed),
      // 时间栏位读取容错（不因缺栏改 status）：validFrom／observedAt 回落 createdAt，
      // lastConfirmedAt 回落 updatedAt；坏值视为 undefined 交给有效性判定。
      validFrom: normalizeIsoField(parsed.validFrom) ?? (createdAt || undefined),
      validTo: normalizeIsoField(parsed.validTo),
      observedAt: normalizeIsoField(parsed.observedAt) ?? (createdAt || undefined),
      referenceTime: normalizeIsoField(parsed.referenceTime),
      lastConfirmedAt: normalizeIsoField(parsed.lastConfirmedAt) ?? (updatedAt || undefined),
      lastUsedAt: normalizeIsoField(parsed.lastUsedAt),
      supersedes: normalizeSupersedes(parsed.supersedes),
      sourceSessionId: normalizeAuditString(parsed.sourceSessionId),
      sourceMessageIds: normalizeAuditIdList(parsed.sourceMessageIds),
      lastOperation: normalizeLastOperation(parsed.lastOperation),
    };
    docsMemory.set(key, doc);
    return doc;
  }
  return null;
}

async function writeDoc(doc: AgentMemoryDoc): Promise<void> {
  const key = bodyKey(doc.scope, doc.ownerKey, doc.domain, doc.slug);
  await writeBlobText(key, JSON.stringify(doc));
  docsMemory.set(key, doc);
}

/** 旧世代正文存档（契约 §2 `agent-memory/revisions/{id}-r{n}.json`）。 */
async function writeRevision(previous: AgentMemoryDoc): Promise<void> {
  const key = revisionKey(previous.id, previous.revision);
  // 纯 Map 模式（本机无 blob 凭证）下 history 也要有资料。
  revisionsMemory.set(key, previous);
  await writeBlobText(key, JSON.stringify(previous));
}

export { withCatalogLock, findCatalogEntryByIdOrAlias, entryMatchesIds, loadCatalog, saveCatalog, writeCatalogEntry, readDoc, writeDoc, writeRevision, revisionsMemory };
