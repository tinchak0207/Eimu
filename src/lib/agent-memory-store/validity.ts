import { writeBlobText } from "./blob-io";
import { indexKey } from "./keys";
import { buildMemoryIndexMd, sameScope } from "./index-md";
import { loadCatalog, readDoc } from "./store";
import type { AgentMemoryDoc, MemoryCatalogEntry, MemoryScope } from "./types";

// ─────────────────────────── 时间有效性（单一真源）

/** 时间栏位 → epoch ms；不可 parse 回 undefined（调用方视为「无边界」）。 */
function timeMs(value: unknown): number | undefined {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : undefined;
  }
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/** 当前有效性：status=active 且 validFrom<=now 且（无 validTo 或 validTo>now）。 */
export function isMemoryCurrentlyValid(doc: AgentMemoryDoc, nowMs: number): boolean {
  if (doc.status !== "active") return false;
  const fromMs = timeMs(doc.validFrom) ?? timeMs(doc.createdAt);
  if (fromMs !== undefined && fromMs > nowMs) return false;
  if (doc.validTo) {
    const toMs = timeMs(doc.validTo);
    if (toMs !== undefined && toMs <= nowMs) return false;
  }
  return true;
}

/** 历史时点有效性：validFrom<=asOf 且（无 validTo 或 validTo>asOf）。 */
function isMemoryValidAt(doc: AgentMemoryDoc, asOfMs: number): boolean {
  const fromMs = timeMs(doc.validFrom) ?? timeMs(doc.createdAt);
  if (fromMs !== undefined && fromMs > asOfMs) return false;
  if (doc.validTo) {
    const toMs = timeMs(doc.validTo);
    if (toMs !== undefined && toMs <= asOfMs) return false;
  }
  return true;
}

/** 时间区间自检：两端都可 parse 且 validTo <= validFrom 视为空区间／非法。 */
function hasInvalidTimeRange(fromIso?: string, toIso?: string): boolean {
  if (!fromIso || !toIso) return false;
  const fromMs = timeMs(fromIso);
  const toMs = timeMs(toIso);
  return fromMs !== undefined && toMs !== undefined && toMs <= fromMs;
}

interface ScopedDocsOptions {
  asOf?: number;
  includeHistory?: boolean;
}

/**
 * 按 scope 取文档的唯一入口（listMemoryDocs／activeDocs／读索引共用）：
 * - 默认：只取 status=active 且当前有效的文档。
 * - `asOf`：取该时点有效的文档（validFrom <= asOf < validTo）；retracted 排除，
 *   superseded 可包含（它是历史事实）；pending_review 从未发布，不进入历史索引。
 * - `includeHistory`：取该 scope 全部非 retracted 文档（含 superseded／过期／pending）。
 */
async function scopedDocs(
  scope: MemoryScope,
  ownerKey?: string,
  opts: ScopedDocsOptions = {},
): Promise<AgentMemoryDoc[]> {
  const catalog = await loadCatalog();
  const nowMs = Date.now();
  const asOfMs = typeof opts.asOf === "number" && Number.isFinite(opts.asOf) ? opts.asOf : undefined;
  const includeHistory = opts.includeHistory === true;
  const docs: AgentMemoryDoc[] = [];
  for (const entry of catalog.entries) {
    if (!sameScope(entry, scope, ownerKey)) continue;
    if (includeHistory) {
      if (entry.status === "retracted") continue;
    } else if (asOfMs !== undefined) {
      if (entry.status === "retracted" || entry.status === "pending_review") continue;
    } else if (entry.status !== "active") {
      continue;
    }
    const doc = await readDoc(entry.scope, entry.ownerKey, entry.domain, entry.slug);
    if (!doc) continue;
    if (includeHistory) {
      if (doc.status === "retracted") continue;
      docs.push(doc);
      continue;
    }
    if (asOfMs !== undefined) {
      if (doc.status === "retracted" || doc.status === "pending_review") continue;
      if (!isMemoryValidAt(doc, asOfMs)) continue;
      docs.push(doc);
      continue;
    }
    if (!isMemoryCurrentlyValid(doc, nowMs)) continue;
    docs.push(doc);
  }
  return docs;
}

/** 读某 scope 的全部 active 正文（由 catalog 驱动，不依赖 blob list）。 */
async function activeDocs(scope: MemoryScope, ownerKey?: string): Promise<AgentMemoryDoc[]> {
  return scopedDocs(scope, ownerKey);
}

/** catalog 条目级有效性（不读正文）：用于 INDEX 集合对账。 */
function isCatalogEntryCurrentlyValid(entry: MemoryCatalogEntry, nowMs: number): boolean {
  if (entry.status !== "active") return false;
  const fromMs = timeMs(entry.validFrom) ?? timeMs(entry.createdAt);
  if (fromMs !== undefined && fromMs > nowMs) return false;
  if (entry.validTo) {
    const toMs = timeMs(entry.validTo);
    if (toMs !== undefined && toMs <= nowMs) return false;
  }
  return true;
}

function indexEntryKey(domain: string, slug: string): string {
  return `${domain}\u0000${slug}`;
}

/** 当前应出现在 INDEX 里的条目集合（status=active 且时间有效；按 domain+slug 去重）。 */
function expectedIndexKeys(
  entries: MemoryCatalogEntry[],
  scope: MemoryScope,
  ownerKey: string | undefined,
  nowMs: number,
): Set<string> {
  const keys = new Set<string>();
  for (const entry of entries) {
    if (!sameScope(entry, scope, ownerKey)) continue;
    if (!isCatalogEntryCurrentlyValid(entry, nowMs)) continue;
    keys.add(indexEntryKey(entry.domain, entry.slug));
  }
  return keys;
}

/** 从持久化 INDEX 行解析 `- [domain] slug — …`；兼容行尾 `（vN）`。 */
function persistedIndexKeys(md: string): Set<string> {
  const keys = new Set<string>();
  for (const line of md.split("\n")) {
    const match = line.match(/^- \[(.*?)\] (\S+) —/);
    if (match) keys.add(indexEntryKey(match[1], match[2]));
  }
  return keys;
}

function sameIndexKeySet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const key of a) if (!b.has(key)) return false;
  return true;
}

/** 重建 INDEX.md（active docs）。回传重建后的行数。 */
async function rebuildIndex(scope: MemoryScope, ownerKey?: string): Promise<number> {
  const docs = await activeDocs(scope, ownerKey);
  const md = buildMemoryIndexMd(scope, docs, ownerKey);
  await writeBlobText(indexKey(scope, ownerKey), md);
  return docs.length;
}

export { timeMs, hasInvalidTimeRange, scopedDocs, expectedIndexKeys, persistedIndexKeys, sameIndexKeySet, rebuildIndex };
