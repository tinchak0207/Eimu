import { MEMORY_DUPLICATE_JACCARD, MEMORY_SHARED_MAX_ACTIVE_DOCS } from "./constants";
import { memoryJaccard } from "./text";
import type { AgentMemoryDoc, AgentMemoryDocInput, MemoryCatalog, MemoryCatalogEntry, MemoryScope } from "./types";

// ─────────────────────────── 索引

/** 单行字段清洗：换行→空格、连续空白折叠、trim（兼容历史脏数据，防伪造行）。 */
function lineSafe(value: unknown): string {
  return String(value ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 索引文本（契约 §2，一行一条）：
 * `- [domain] slug — description （v{revision}）`
 */
export function buildMemoryIndexMd(
  scope: MemoryScope,
  docs: AgentMemoryDoc[],
  ownerKey?: string,
): string {
  const scoped =
    scope === "private" && ownerKey ? docs.filter((doc) => doc.ownerKey === ownerKey) : docs;
  return [...scoped]
    .sort((a, b) => a.domain.localeCompare(b.domain) || a.slug.localeCompare(b.slug))
    .map(
      (doc) =>
        `- [${lineSafe(doc.domain)}] ${lineSafe(doc.slug)} — ${lineSafe(doc.description)} （v${doc.revision}）`,
    )
    .join("\n");
}

/**
 * 领域摘要（可选前置到 INDEX，默认关闭）：按 domain 分组输出
 * `- [domain] 共N条 — desc1；desc2；desc3`；每条 desc 截 60 字、最多 3 条，
 * 总长不超过 maxChars。只做确定性字符串拼接，不调 LLM。
 */
export function buildMemoryDomainDigestMd(
  docs: AgentMemoryDoc[],
  maxChars = 600,
): string {
  const groups = new Map<string, AgentMemoryDoc[]>();
  for (const doc of docs) {
    // 分组也按清洗后的 domain，避免脏数据把同一领域拆成多行。
    const domain = lineSafe(doc.domain);
    const list = groups.get(domain);
    if (list) list.push(doc);
    else groups.set(domain, [doc]);
  }
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 600;
  const lines: string[] = [];
  let used = 0;
  for (const domain of [...groups.keys()].sort((a, b) => a.localeCompare(b))) {
    const group = groups.get(domain) ?? [];
    const descriptions = group
      .slice(0, 3)
      .map((doc) => {
        const safe = lineSafe(doc.description);
        const chars = Array.from(safe);
        return chars.length > 60 ? chars.slice(0, 60).join("") : safe;
      })
      .join("；");
    const line = `- [${domain}] 共${group.length}条 — ${descriptions}`;
    if (used + line.length > limit) break;
    lines.push(line);
    used += line.length + 1;
  }
  const text = lines.join("\n");
  return text.length > limit ? text.slice(0, limit) : text;
}

function sameScope(
  entry: { scope: MemoryScope; ownerKey?: string },
  scope: MemoryScope,
  ownerKey: string | undefined,
): boolean {
  return entry.scope === scope && (scope === "shared" || entry.ownerKey === ownerKey);
}

function activeSharedCount(catalog: MemoryCatalog): number {
  return catalog.entries.filter(
    (entry) => entry.scope === "shared" && entry.status === "active",
  ).length;
}

/** catalog 中当前 pending_review shared 文档数（pending 上限的唯一计数来源）。 */
function pendingSharedCount(catalog: MemoryCatalog): number {
  return catalog.entries.filter(
    (entry) => entry.scope === "shared" && entry.status === "pending_review",
  ).length;
}

/**
 * 近重复佐证候选（仅 shared）：精确 slug 未命中时，为「同一知识的不同措辞」找既有
 * 文档作为本次写入目标。条件：shared、active|pending_review、同 domain、
 * description token Jaccard > `MEMORY_DUPLICATE_JACCARD`（0.8）。
 *
 * 取舍：0.8 直接复用既有 G5 去重门槛，代价是「相似但不同」的知识可能被并成同一条
 * （误合并面）；domain 必须完全相同是第二道约束，把误合并面收窄到同一知识域。多命中
 * 时取相似度最高者，避免 catalog 顺序影响结果。
 */
function findCorroborationEntry(
  entries: MemoryCatalogEntry[],
  candidate: AgentMemoryDocInput,
): MemoryCatalogEntry | null {
  let best: MemoryCatalogEntry | null = null;
  let bestScore = MEMORY_DUPLICATE_JACCARD;
  for (const entry of entries) {
    if (entry.scope !== "shared") continue;
    if (entry.status !== "active" && entry.status !== "pending_review") continue;
    if (entry.domain !== candidate.domain) continue;
    const score = memoryJaccard(entry.description, candidate.description);
    if (score > bestScore) {
      best = entry;
      bestScore = score;
    }
  }
  return best;
}

/**
 * 进入 active 的唯一容量闸（**所有路径**共用：新建达门槛、pending 合并达门槛、
 * proposed 提升、人工 review activate）。`alreadyActive`＝该文档本来就在 active，提案
 * 提升不增加 active 数，故直接放行；其余情况必须 activeSharedCount <
 * MEMORY_SHARED_MAX_ACTIVE_DOCS。人工放行不绕过此上限。
 */
function canActivateShared(catalog: MemoryCatalog, alreadyActive = false): boolean {
  if (alreadyActive) return true;
  return activeSharedCount(catalog) < MEMORY_SHARED_MAX_ACTIVE_DOCS;
}

export { sameScope, pendingSharedCount, findCorroborationEntry, canActivateShared };
