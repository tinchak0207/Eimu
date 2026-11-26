import { canActivateShared } from "./index-md";
import { entryMatchesIds, loadCatalog, readDoc, saveCatalog, withCatalogLock, writeCatalogEntry, writeDoc } from "./store";
import { rebuildIndex } from "./validity";
import type { MemoryRetractInput, MemoryReviewInput, MemoryReviewResult, MemoryScope, MemoryStatus } from "./types";

/**
 * 撤回：status=retracted + validTo=now + 清空未发布提案 + 从 INDEX 移除；**不删文件**
 * （留证只留 live 正文，不保留 proposed，避免人工 activate 后旧提案被后续佐证意外提升）。
 * superseded 是历史终态，不重复撤回（跳过）。
 */
async function retractMemoryDocsLocked(
  input: MemoryRetractInput,
): Promise<{ retracted: string[] }> {
  const docIds = new Set((input?.docIds ?? []).map((id) => String(id)));
  const batchId = String(input?.batchId ?? "").trim();
  if (docIds.size === 0 && !batchId) return { retracted: [] };
  const nowIso = new Date().toISOString();
  const catalog = await loadCatalog();
  const retracted: string[] = [];
  const touchedPrivateOwners = new Set<string>();
  let touchedShared = false;

  for (const entry of catalog.entries) {
    const matches = docIds.size > 0 ? entryMatchesIds(entry, docIds) : entry.batchId === batchId;
    if (!matches || entry.status === "retracted") continue;
    // superseded 已是历史终态：不重复撤回，也不改它的 validTo。
    if (entry.status === "superseded") continue;
    const doc = await readDoc(entry.scope, entry.ownerKey, entry.domain, entry.slug);
    if (!doc || doc.status === "superseded") continue;
    await writeDoc({
      ...doc,
      status: "retracted",
      validTo: nowIso,
      proposed: undefined,
      updatedAt: nowIso,
    });
    entry.status = "retracted";
    entry.updatedAt = nowIso;
    entry.validFrom = doc.validFrom;
    entry.validTo = nowIso;
    await writeCatalogEntry(entry);
    retracted.push(doc.id);
    if (doc.scope === "shared") touchedShared = true;
    else if (doc.ownerKey) touchedPrivateOwners.add(doc.ownerKey);
  }

  if (retracted.length > 0) {
    await saveCatalog(catalog, catalog.revision ?? 0);
    if (touchedShared) await rebuildIndex("shared");
    for (const ownerKey of touchedPrivateOwners) await rebuildIndex("private", ownerKey);
  }

  return { retracted };
}

/** 导出入口：整段函数体持锁。 */
export function retractMemoryDocs(
  input: MemoryRetractInput,
): Promise<{ retracted: string[] }> {
  return withCatalogLock(() => retractMemoryDocsLocked(input));
}

/**
 * 品质复核翻转（PRD §5.6 抽检判据；【契约外新增】，比照 §3.2 retract 的目录＋正文同步纪律）：
 * active↔pending_review 双向翻转，INDEX 重建沿用 rebuildIndex（pending_review 不在
 * activeDocs → 索引行自动消失）；retracted 永不翻转（留证不动，两个方向都不是它的来源态）。
 * activate 到 shared 与其他进入 active 的路径同受 `canActivateShared()` 约束：满 400 时
 * 保持 pending_review 并进回执 `blocked`——人工放行不绕过平台容量上限。
 */
async function reviewMemoryDocsLocked(
  input: MemoryReviewInput,
): Promise<MemoryReviewResult> {
  const action = input?.action;
  if (action !== "pending_review" && action !== "activate") {
    return { reviewed: [], action, blocked: [] };
  }
  const docIds = new Set((input?.docIds ?? []).map((id) => String(id)));
  const batchId = String(input?.batchId ?? "").trim();
  if (docIds.size === 0 && !batchId) return { reviewed: [], action, blocked: [] };

  const fromStatus: MemoryStatus = action === "pending_review" ? "active" : "pending_review";
  const toStatus: MemoryStatus = action === "pending_review" ? "pending_review" : "active";  const scopeFilter: MemoryScope | undefined =
    input?.scope === "private" || input?.scope === "shared"
      ? input.scope
      : action === "pending_review"
        ? "shared" // PRD §5.6：自动翻转仅限 shared；私有库要翻得显式带 scope
        : undefined;

  const nowIso = new Date().toISOString();
  const catalog = await loadCatalog();
  const reviewed: string[] = [];
  /** 人工 activate 撞上 active 容量上限而保持 pending_review 的 id。 */
  const blocked: string[] = [];
  const touchedPrivateOwners = new Set<string>();
  let touchedShared = false;

  for (const entry of catalog.entries) {
    const matches = docIds.size > 0 ? entryMatchesIds(entry, docIds) : entry.batchId === batchId;
    if (!matches || entry.status !== fromStatus) continue;
    if (scopeFilter && entry.scope !== scopeFilter) continue;
    // 人工放行不绕过平台容量上限：shared 且当前不是 active 时，必须过 canActivateShared。
    // 满 400 就保持 pending_review（不写正文、不改 catalog），并把 id 回报给调用方。
    // private 与本就 active 的文档不受此限（后者由 fromStatus 过滤，不会被处理）。
    if (action === "activate" && entry.scope === "shared" && entry.status !== "active") {
      if (!canActivateShared(catalog, false)) {
        blocked.push(entry.id);
        continue;
      }
    }
    const doc = await readDoc(entry.scope, entry.ownerKey, entry.domain, entry.slug);
    if (!doc || doc.status !== fromStatus) continue;
    await writeDoc({ ...doc, status: toStatus, updatedAt: nowIso });
    entry.status = toStatus;
    entry.updatedAt = nowIso;
    entry.validFrom = doc.validFrom;
    await writeCatalogEntry(entry);
    reviewed.push(doc.id);
    if (doc.scope === "shared") touchedShared = true;
    else if (doc.ownerKey) touchedPrivateOwners.add(doc.ownerKey);
  }

  if (reviewed.length > 0) {
    await saveCatalog(catalog, catalog.revision ?? 0);
    if (touchedShared) await rebuildIndex("shared");
    for (const ownerKey of touchedPrivateOwners) await rebuildIndex("private", ownerKey);
  }

  return { reviewed, action, blocked };
}

/** 导出入口：整段函数体持锁。 */
export function reviewMemoryDocs(input: MemoryReviewInput): Promise<MemoryReviewResult> {
  return withCatalogLock(() => reviewMemoryDocsLocked(input));
}
