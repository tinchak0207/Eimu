import { randomBytes } from "node:crypto";
import { scanSensitiveContent, SENSITIVE_REASON_PREFIX } from "@/lib/agent-skills/user-skill";
import { entryMatchesIds, loadCatalog, purgeDocBlobs, readDoc, saveCatalog, withCatalogLock, writeCatalogEntry, writeDoc, writeRevision } from "./store";
import { deterministicDocId } from "./keys";
import { rebuildIndex } from "./validity";
import type { AgentMemoryDoc, MemoryCatalogEntry } from "./types";

/**
 * 用户在「我的记忆」面板里对自己私有库的增改删。
 * 与 agent 自动写入（ingest）的区别：用户亲手写＝user_confirmed／selfScore 5；
 * 不过 ingest 的日配额与近重复合并（用户明确要存的，不能被静默吞掉）；硬删不留证。
 */

export const USER_MEMORY_DOMAIN = "user";
export const USER_MEMORY_MAX_PER_OWNER = 200;
const DESCRIPTION_MAX = 120;
const BODY_MAX = 2000;

export type UserMemoryResult<T> = { ok: true; value: T } | { ok: false; reason: string };

function validateText(description: string, body: string): string | null {
  const desc = description.trim();
  const text = body.trim();
  if (!desc || desc.length > DESCRIPTION_MAX || /[\r\n]/.test(desc)) return "invalid_description";
  if (!text || text.length > BODY_MAX) return "invalid_body";
  for (const field of [desc, text]) {
    const scan = scanSensitiveContent(field);
    if (!scan.clean) return `${SENSITIVE_REASON_PREFIX}${scan.hits[0].kind}`;
  }
  return null;
}

function entryFromDoc(doc: AgentMemoryDoc): MemoryCatalogEntry {
  return {
    id: doc.id,
    scope: doc.scope,
    ownerKey: doc.ownerKey,
    domain: doc.domain,
    slug: doc.slug,
    description: doc.description,
    status: doc.status,
    revision: doc.revision,
    contributors: [],
    batchId: doc.batchId,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    validFrom: doc.validFrom,
    validTo: doc.validTo,
    lastConfirmedAt: doc.lastConfirmedAt,
  };
}

/** 该 owner 的私有条目（任意 status，供计数与删除用）。 */
function ownerEntries(entries: MemoryCatalogEntry[], ownerKey: string): MemoryCatalogEntry[] {
  return entries.filter((entry) => entry.scope === "private" && entry.ownerKey === ownerKey);
}

export function createUserMemory(
  ownerKey: string,
  input: { description: string; body: string },
): Promise<UserMemoryResult<AgentMemoryDoc>> {
  return withCatalogLock(async () => {
    if (!ownerKey) return { ok: false, reason: "no_owner" } as const;
    const invalid = validateText(String(input.description ?? ""), String(input.body ?? ""));
    if (invalid) return { ok: false, reason: invalid } as const;
    const catalog = await loadCatalog();
    if (ownerEntries(catalog.entries, ownerKey).length >= USER_MEMORY_MAX_PER_OWNER) {
      return { ok: false, reason: "quota_exceeded" } as const;
    }
    const slug = `u-${randomBytes(5).toString("hex")}`;
    const nowIso = new Date().toISOString();
    const doc: AgentMemoryDoc = {
      id: deterministicDocId({ scope: "private", ownerKey, domain: USER_MEMORY_DOMAIN, slug }),
      scope: "private",
      ownerKey,
      domain: USER_MEMORY_DOMAIN,
      slug,
      description: input.description.trim(),
      type: "user",
      body: input.body.trim(),
      links: [],
      evidence: "用户在「我的记忆」中手动添加",
      evidenceKind: "user_confirmed",
      selfScore: 5,
      promptVersion: "user-manual",
      batchId: `user-${nowIso.slice(0, 10)}`,
      status: "active",
      revision: 1,
      contributors: [],
      validFrom: nowIso,
      observedAt: nowIso,
      lastConfirmedAt: nowIso,
      lastOperation: "add",
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    await writeDoc(doc);
    const entry = entryFromDoc(doc);
    await writeCatalogEntry(entry);
    catalog.entries.push(entry);
    await saveCatalog(catalog, catalog.revision ?? 0);
    await rebuildIndex("private", ownerKey);
    return { ok: true, value: doc } as const;
  });
}

export function updateUserMemory(
  ownerKey: string,
  id: string,
  patch: { description?: string; body?: string },
): Promise<UserMemoryResult<AgentMemoryDoc>> {
  return withCatalogLock(async () => {
    if (!ownerKey) return { ok: false, reason: "no_owner" } as const;
    const catalog = await loadCatalog();
    const entry = ownerEntries(catalog.entries, ownerKey).find((item) => entryMatchesIds(item, new Set([id])));
    if (!entry) return { ok: false, reason: "not_found" } as const;
    const previous = await readDoc(entry.scope, entry.ownerKey, entry.domain, entry.slug);
    if (!previous || previous.status !== "active") return { ok: false, reason: "not_found" } as const;
    const description = patch.description === undefined ? previous.description : String(patch.description);
    const body = patch.body === undefined ? previous.body : String(patch.body);
    const invalid = validateText(description, body);
    if (invalid) return { ok: false, reason: invalid } as const;
    if (description.trim() === previous.description && body.trim() === previous.body) {
      return { ok: true, value: previous } as const;
    }
    const nowIso = new Date().toISOString();
    await writeRevision(previous);
    const doc: AgentMemoryDoc = {
      ...previous,
      description: description.trim(),
      body: body.trim(),
      evidenceKind: "user_confirmed",
      selfScore: 5,
      revision: previous.revision + 1,
      lastConfirmedAt: nowIso,
      lastOperation: "update",
      updatedAt: nowIso,
    };
    await writeDoc(doc);
    entry.description = doc.description;
    entry.revision = doc.revision;
    entry.updatedAt = nowIso;
    entry.lastConfirmedAt = nowIso;
    await writeCatalogEntry(entry);
    await saveCatalog(catalog, catalog.revision ?? 0);
    await rebuildIndex("private", ownerKey);
    return { ok: true, value: doc } as const;
  });
}

/**
 * 硬删：正文＋历史世代＋catalog 日志＋聚合快照条目＋INDEX 全部抹掉（不是 retract 留证）。
 * `ids` 为 null＝清空该 owner 的全部私有记忆。只认 owner 自己的 private 条目，
 * shared 与他人条目即使 id 命中也不动。
 */
export function deleteUserMemories(
  ownerKey: string,
  ids: string[] | null,
): Promise<{ deleted: string[]; failed: string[]; removed: Array<{ id: string; description: string; body: string }> }> {
  return withCatalogLock(async () => {
    const deleted: string[] = [];
    const failed: string[] = [];
    const removed: Array<{ id: string; description: string; body: string }> = [];
    if (!ownerKey) return { deleted, failed, removed };
    const idSet = ids ? new Set(ids.map((id) => String(id))) : null;
    if (idSet && idSet.size === 0) return { deleted, failed, removed };
    const catalog = await loadCatalog();
    const targets = ownerEntries(catalog.entries, ownerKey).filter((entry) => !idSet || entryMatchesIds(entry, idSet));
    const gone = new Set<MemoryCatalogEntry>();
    for (const entry of targets) {
      // 删之前先留下正文：网关要凭它把历史对话索引里复述同一事实的轮次一并抹掉。
      const doc = await readDoc(entry.scope, entry.ownerKey, entry.domain, entry.slug);
      if (doc) removed.push({ id: entry.id, description: doc.description, body: doc.body });
      const clean = await purgeDocBlobs(entry);
      // 目录条目无论 blob 删净与否都先摘掉：用户视角它必须立刻消失、不再被召回；
      // blob 残留只会让该 id 进 failed 上报，不会回到目录。
      gone.add(entry);
      (clean ? deleted : failed).push(entry.id);
    }
    if (gone.size > 0) {
      catalog.entries = catalog.entries.filter((entry) => !gone.has(entry));
      await saveCatalog(catalog, catalog.revision ?? 0);
      await rebuildIndex("private", ownerKey);
    }
    return { deleted, failed, removed };
  });
}
