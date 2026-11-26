import { MEMORY_RECONCILE_CANDIDATE_JACCARD, MEMORY_RECONCILE_NOOP_BODY_JACCARD, MEMORY_RECONCILE_NOOP_JACCARD, MEMORY_RECONCILE_SUPERSEDE_JACCARD, MEMORY_SEED_PROMPT_VERSION } from "./constants";
import { normalizeSupersedes } from "./normalize";
import { looksContradictory, looksReplacement, memoryJaccard } from "./text";
import { readDoc, writeCatalogEntry, writeDoc, writeRevision } from "./store";
import type { AgentMemoryDoc, AgentMemoryDocInput, MemoryCatalogEntry, MemoryIngestInput } from "./types";

/**
 * promptVersion 落盘值：普通文档保持既有 `candidate ?? input ?? "v1"` 语义不变；
 * 种子文档在两者都为空（含空字符串）时落 `seed-local-mem-v1`，便于审计区分。
 */
function resolvePromptVersion(
  candidate: AgentMemoryDocInput,
  input: MemoryIngestInput,
  seedDoc: boolean,
): string {
  if (seedDoc) {
    const explicit = candidate.promptVersion ?? input?.promptVersion;
    const value = typeof explicit === "string" ? explicit.trim() : "";
    return value !== "" ? value : MEMORY_SEED_PROMPT_VERSION;
  }
  return String(candidate.promptVersion ?? input?.promptVersion ?? "v1");
}

/**
 * private 写入对账候选（仅同一 ownerKey 的 active 文档）：
 * - 候选自带 `supersedes`：先按 slug 精确命中，再按 body/description Jaccard ≥0.6 找。
 * - 否则按 description Jaccard ≥0.55 且 body Jaccard ≥0.35 取 top-1，再用纯启发式
 *   判断「矛盾／替换」是否成立；成立＝SUPERSEDE，不成立再看是否 NOOP。
 * 返回 null 表示正常 ADD。全程不调 LLM，宁可漏判不误判。
 */
interface PrivateReconcileMatch {
  entry: MemoryCatalogEntry;
  doc: AgentMemoryDoc;
  mode: "supersede" | "noop";
}

async function findPrivateReconcileMatch(
  entries: MemoryCatalogEntry[],
  candidate: AgentMemoryDocInput,
  ownerKey: string,
): Promise<PrivateReconcileMatch | null> {
  const activeEntries = entries.filter(
    (entry) =>
      entry.scope === "private" &&
      entry.ownerKey === ownerKey &&
      entry.status === "active" &&
      // 跨 domain 不 supersede（同 slug 不同 domain 是两条独立事实）。
      entry.domain === candidate.domain,
  );
  if (activeEntries.length === 0) return null;
  const loaded: Array<{ entry: MemoryCatalogEntry; doc: AgentMemoryDoc }> = [];
  for (const entry of activeEntries) {
    const doc = await readDoc("private", ownerKey, entry.domain, entry.slug);
    if (doc && doc.status === "active") loaded.push({ entry, doc });
  }
  if (loaded.length === 0) return null;

  // 显式 supersedes：只走这条路，找不到就正常 ADD（不再做隐式推断）。
  const explicit = normalizeSupersedes(candidate.supersedes);
  if (explicit) {
    for (const token of explicit) {
      const bySlug = loaded.find((item) => item.entry.slug === token);
      if (bySlug) return { ...bySlug, mode: "supersede" };
      let best: { entry: MemoryCatalogEntry; doc: AgentMemoryDoc } | null = null;
      let bestScore = 0;
      for (const item of loaded) {
        const score = Math.max(
          memoryJaccard(item.doc.body, token),
          memoryJaccard(item.doc.description, token),
        );
        if (score >= 0.6 && (!best || score > bestScore)) {
          best = item;
          bestScore = score;
        }
      }
      if (best) return { ...best, mode: "supersede" };
    }
    return null;
  }

  // 隐式：description 找候选（≥0.55），正文相似度 ≥0.35 才有资格被判为同一事实。
  let top: { entry: MemoryCatalogEntry; doc: AgentMemoryDoc } | null = null;
  let topDesc = -1;
  let topBody = 0;
  for (const item of loaded) {
    const descScore = memoryJaccard(item.doc.description, candidate.description);
    const bodyScore = memoryJaccard(item.doc.body, candidate.body);
    if (descScore > topDesc) {
      top = item;
      topDesc = descScore;
      topBody = bodyScore;
    }
  }
  if (!top || topDesc < MEMORY_RECONCILE_CANDIDATE_JACCARD) return null;
  if (topBody < MEMORY_RECONCILE_SUPERSEDE_JACCARD) return null;

  if (looksContradictory(top.doc.body, candidate.body) || looksReplacement(top.doc.body, candidate.body)) {
    return { ...top, mode: "supersede" };
  }
  // NOOP 门槛：description 近重复（>0.8）且正文高度一致（≥0.6）。
  if (topDesc > MEMORY_RECONCILE_NOOP_JACCARD && topBody >= MEMORY_RECONCILE_NOOP_BODY_JACCARD) {
    return { ...top, mode: "noop" };
  }
  return null;
}

/**
 * 对账命中后的旧文档更新：整篇写回并同步 catalog（revision+1，旧世代存档）。
 * supersede：status=superseded、validTo=nowIso；noop：只刷新 lastConfirmedAt。
 */
async function applyPrivateReconcileUpdate(
  entry: MemoryCatalogEntry,
  doc: AgentMemoryDoc,
  mode: "supersede" | "noop",
  nowIso: string,
): Promise<void> {
  await writeRevision(doc);
  const revision = Math.max(entry.revision ?? 0, doc.revision ?? 0) + 1;
  const next: AgentMemoryDoc =
    mode === "supersede"
      ? {
          ...doc,
          status: "superseded",
          validTo: nowIso,
          lastOperation: "supersede",
          revision,
          updatedAt: nowIso,
        }
      : {
          ...doc,
          lastConfirmedAt: nowIso,
          lastOperation: "noop",
          revision,
          updatedAt: nowIso,
        };
  await writeDoc(next);
  entry.status = next.status;
  entry.revision = revision;
  entry.updatedAt = nowIso;
  entry.validFrom = next.validFrom;
  entry.validTo = next.validTo;
  entry.lastConfirmedAt = next.lastConfirmedAt;
  // 逐文档日志：supersede／noop 都是条目变化，必须单独落盘。
  await writeCatalogEntry(entry);
}

export { resolvePromptVersion, findPrivateReconcileMatch, applyPrivateReconcileUpdate };
export type { PrivateReconcileMatch };
