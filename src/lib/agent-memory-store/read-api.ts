import { readBlobTextAt } from "./blob-io";
import { buildMemoryDomainDigestMd, buildMemoryIndexMd } from "./index-md";
import { indexKey } from "./keys";
import { loadCatalog } from "./store";
import { expectedIndexKeys, persistedIndexKeys, sameIndexKeySet, scopedDocs, timeMs } from "./validity";
import type { AgentMemoryDoc, MemoryScope, MemoryScopeInput } from "./types";

// ─────────────────────────── 对外 API

/**
 * 列出某 scope 的文档。默认＝当前有效的 active docs；`asOf` 给定时按该时点过滤；
 * `includeHistory` 取全部非 retracted（含 superseded／过期）。private 缺 ownerKey 回空。
 */
export async function listMemoryDocs(input: MemoryScopeInput): Promise<AgentMemoryDoc[]> {
  const scope: MemoryScope = input?.scope === "private" ? "private" : "shared";
  if (scope === "private" && !String(input?.ownerKey ?? "").trim()) return [];
  const asOfMs = timeMs(input?.asOf);
  const docs = await scopedDocs(scope, input?.ownerKey, {
    asOf: asOfMs,
    includeHistory: input?.includeHistory === true,
  });
  return docs.sort((a, b) => a.domain.localeCompare(b.domain) || a.slug.localeCompare(b.slug));
}

/**
 * 读某 scope 的索引文本；无索引时空字符串。
 * - 默认：沿用既有 INDEX.md（写入时由 rebuildIndex 维护），但先做**集合对账**——
 *   用 catalog 条目算「当前应出现的 active 集合（domain+slug）」与持久化 INDEX 解析出的
 *   集合比较，不等就即时从正文重建。这样未来 `validFrom` 到点、`validTo` 过期、
 *   或同一刻一进一出（行数不变但集合变了）时索引都能自愈。
 * - `asOf`：按该时点从正文即时构建（历史索引，不读当前 INDEX.md）。
 * - env `MEMORY_INDEX_DIGEST === "1"`：口径不同，直接重建并前置领域摘要。
 */
export async function readMemoryIndexMd(
  scope: MemoryScope,
  ownerKey?: string,
  asOf?: string | Date,
): Promise<string> {
  const asOfMs = timeMs(asOf);
  const digestEnabled = process.env.MEMORY_INDEX_DIGEST === "1";
  if (asOfMs === undefined && !digestEnabled) {
    const fromBlob = await readBlobTextAt(indexKey(scope, ownerKey));
    if (fromBlob !== null) {
      // 集合对账（不是行数）：同一刻「一条过期 + 一条生效」行数不变，但集合不同。
      const catalog = await loadCatalog();
      const expected = expectedIndexKeys(catalog.entries, scope, ownerKey, Date.now());
      if (sameIndexKeySet(expected, persistedIndexKeys(fromBlob))) return fromBlob;
    }
  }
  const docs = await scopedDocs(scope, ownerKey, asOfMs === undefined ? {} : { asOf: asOfMs });
  const md = buildMemoryIndexMd(scope, docs, ownerKey);
  if (!digestEnabled) return md;
  const digest = buildMemoryDomainDigestMd(docs);
  return digest ? `${digest}\n${md}` : md;
}
