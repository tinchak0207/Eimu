import { readBlobJson } from "./blob-io";
import { legacyRevisionKey, revisionKey } from "./keys";
import { findCatalogEntryByIdOrAlias, loadCatalog, readDoc, revisionsMemory } from "./store";
import type { AgentMemoryDoc } from "./types";

/**
 * 读某文档的最近 50 个历史世代（start=max(1, revision-49) 到 revision）。读不到／
 * 形状不符的世代直接跳过（不抛）。`current` 是当前正文（可能已是 superseded／retracted）。
 */
export async function listMemoryRevisions(
  docId: string,
): Promise<{ current: AgentMemoryDoc | null; revisions: AgentMemoryDoc[] }> {
  const id = String(docId ?? "").trim();
  if (!id) return { current: null, revisions: [] };
  const catalog = await loadCatalog();
  const entry = findCatalogEntryByIdOrAlias(catalog, id);
  if (!entry) return { current: null, revisions: [] };
  const current = await readDoc(entry.scope, entry.ownerKey, entry.domain, entry.slug);
  // 只取最近 50 代（不是最早 50 代）：revision=56 → 7..56。
  const latestRevision = Math.max(
    0,
    Math.floor(entry.revision ?? 0),
    Math.floor(current?.revision ?? 0),
  );
  const startRevision = Math.max(1, latestRevision - 49);
  // entry.id 与合并前的旧 id（aliases）都可能是历史文件的键。
  const sourceIds = [entry.id, ...(entry.aliases ?? [])];
  const byRevision = new Map<number, AgentMemoryDoc>();
  // current 先补位：当前代可能只存在于正文／catalog，还没落 revision 文件。
  // 只有落在「最近 50 代」窗口内才补位（revision=56 时不能把 revision=1 也塞进去）。
  if (
    current &&
    Number.isFinite(current.revision) &&
    current.revision >= startRevision &&
    current.revision <= latestRevision
  ) {
    byRevision.set(current.revision, current);
  }
  outer: for (let revision = startRevision; revision <= latestRevision; revision += 1) {
    for (const sourceId of sourceIds) {
      // 新键（带短 hash）优先，再回落旧版无 hash 键（升级前历史）。
      for (const key of [revisionKey(sourceId, revision), legacyRevisionKey(sourceId, revision)]) {
        const parsed = revisionsMemory.get(key) ?? (await readBlobJson<AgentMemoryDoc>(key));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
        if (
          parsed.slug !== entry.slug ||
          parsed.domain !== entry.domain ||
          parsed.scope !== entry.scope
        ) {
          continue;
        }
        // blob／Map 找到的世代覆盖 current 补位（blob 优先），按 revision 去重。
        byRevision.set(revision, parsed);
        continue outer;
      }
    }
  }
  const revisions = [...byRevision.values()].sort((a, b) => a.revision - b.revision);
  return { current, revisions };
}
