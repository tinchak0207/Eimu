// AI 助理全局记忆库：私有库（账户级）+ 共享库（平台级）的持久化与索引。
//
// 本档以 src/lib/agent-profile-store.ts 为**逐行基底复制**（2026-09-15），只改
// 白名单栏位：blob key 路径、资料形状（AgentMemoryDoc）、函式名、业务逻辑
// （去重／配额／索引重建）。以下骨架一行未改，逐字沿用基底：
//   - readBlobText 双后端兼容（Vercel 回 { blob }、VPS 回 { stream }）
//   - dbAvailable() 探测（getGenerationSql 包 try/catch）
//   - Blob 失败 → 进程内 Map 兜底
//   - 错误吞噬策略（catch {} 吞掉，不把内部错误抛给调用方）
//   - blob 超时处理（由 blob-backend.ts 统一 10s 硬超时）
//
// Postgres 路径**未启用**（契约 §0 / PRD D4）：生产 `GENERATION_DATABASE_URL`
// 未配置，Vercel 与本地皆无 agent 记忆表，**blob 是唯一现实真源**。本档不建表、
// 不写 migration；dbAvailable() 仅保留同构探测供诊断，读写一律走 blob/Map。
//
// 闸门分工（契约 §5）：G1 结构／G2 证据／G3 敏感／G4 身份泄漏／G6 分数／G8 双模型
// 一致 = **gateway 职责**，repo 端**不重复拦**；本档只负责 **G5 去重**与 **G7 配额**。
// 因此含 `sk-`／`AIza`／邮箱的 doc 若已通过 gateway 闸门送达，本端点仍会写入
// （R6 尺：这是契约分工，不是漏洞）。
//
// 写入纪律：唯一入口是 HMAC 端点（ingest / retract），LLM 不得直触存储。
//
// 契约：`.gateway-work/prod-20260915/MEMORY-INTERFACES.md` §1 §2 §3.1 §3.2。

import { get, put } from "@/lib/blob-backend";
import { getGenerationSql } from "@/lib/generation-core/database";

// ─────────────────────────── 类型

export type MemoryScope = "private" | "shared";
export type MemoryType = "user" | "feedback" | "project" | "domain";
export type EvidenceKind = "tool_result" | "user_confirmed" | "verbatim";
export type MemoryStatus = "active" | "retracted" | "pending_review";

export interface AgentMemoryDoc {
  id: string;
  scope: MemoryScope;
  ownerKey?: string;
  domain: string;
  slug: string;
  description: string;
  type: MemoryType;
  body: string;
  links: string[];
  evidence: string;
  evidenceKind: EvidenceKind;
  selfScore: number;
  promptVersion: string;
  batchId: string;
  status: MemoryStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/** gateway 送来的 doc：id/status/revision/createdAt/updatedAt 由服务端生成。 */
export interface AgentMemoryDocInput {
  scope: MemoryScope;
  ownerKey?: string;
  domain: string;
  slug: string;
  description: string;
  type: MemoryType;
  body: string;
  links?: string[];
  evidence?: string;
  evidenceKind: EvidenceKind;
  selfScore: number;
  promptVersion?: string;
}

export type MemoryRejectReason = "duplicate" | "quota_scope" | "quota_domain" | "structure";

export interface MemoryIngestInput {
  batchId: string;
  promptVersion?: string;
  docs: AgentMemoryDocInput[];
  /** 测试注入，生产走当前时间。 */
  now?: Date;
}

export interface MemoryIngestResult {
  accepted: string[];
  rejected: Array<{ slug: string; reason: MemoryRejectReason }>;
  stats: { received: number; accepted: number; index_lines: number };
}

export interface MemoryRetractInput {
  batchId?: string;
  docIds?: string[];
}

/** 品質複核翻轉動作（PRD §5.6）：pending_review＝轉待人工複核；activate＝人工放行回 active。 */
export type MemoryReviewAction = "pending_review" | "activate";

export interface MemoryReviewInput {
  batchId?: string;
  docIds?: string[];
  action: MemoryReviewAction;
  /**
   * 可選 scope 過濾。缺省時：pending_review 默認**只動 shared**（PRD §5.6「private
   * 不自動轉 pending，只記 badge」——自動翻轉永不碰私有庫）；activate 不過濾
   * （人工複核放行，誰是 pending_review 就放誰）。
   */
  scope?: MemoryScope;
}

export interface MemoryReviewResult {
  reviewed: string[];
  action: MemoryReviewAction;
}

export interface MemoryScopeInput {
  scope: MemoryScope;
  ownerKey?: string;
}

/** catalog：G5 去重与 G7 配额的唯一计数来源（契约 §2 `agent-memory/catalog.json`）。 */
export interface MemoryCatalogEntry {
  id: string;
  scope: MemoryScope;
  ownerKey?: string;
  domain: string;
  slug: string;
  description: string;
  status: MemoryStatus;
  revision: number;
  batchId: string;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryCatalog {
  version: number;
  entries: MemoryCatalogEntry[];
}

export const MEMORY_CATALOG_VERSION = 1;
/** G7 配额（契约 §3.1）：单批 shared ≤20；单 ownerKey private ≤10/日；单 domain ≤8/日。 */
export const MEMORY_QUOTA_SHARED_PER_BATCH = 20;
export const MEMORY_QUOTA_PRIVATE_PER_OWNER_DAY = 10;
export const MEMORY_QUOTA_PER_DOMAIN_DAY = 8;
/** G5 去重门槛（契约 §3.1）：description token Jaccard > 0.8 → duplicate。 */
export const MEMORY_DUPLICATE_JACCARD = 0.8;
/** Blob 路径前缀（与 agent-profile-store 同款约定）。 */
export const AGENT_MEMORY_BLOB_PREFIX = "agent-memory";

// ─────────────────────────── 进程内兜底

const docsMemory = new Map<string, AgentMemoryDoc>();
const catalogMemory = new Map<string, MemoryCatalog>();
const CATALOG_MEMORY_KEY = "catalog";

// ─────────────────────────── helper

/** 路径片段净化：只去路径跳脱与分隔符，**保留 CJK**（domain 如「日本动漫」）。 */
function safeSegment(value: string, fallback: string): string {
  const cleaned = String(value ?? "")
    .replace(/[/\\]/g, "-")
    .replace(/\.{2,}/g, "-")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 80);
  return cleaned || fallback;
}

function bodyKey(
  scope: MemoryScope,
  ownerKey: string | undefined,
  domain: string,
  slug: string,
): string {
  return scope === "private"
    ? `${AGENT_MEMORY_BLOB_PREFIX}/p/${safeSegment(ownerKey ?? "", "unknown")}/${safeSegment(slug, "doc")}.json`
    : `${AGENT_MEMORY_BLOB_PREFIX}/s/${safeSegment(domain, "general")}/${safeSegment(slug, "doc")}.json`;
}

function indexKey(scope: MemoryScope, ownerKey?: string): string {
  return scope === "private"
    ? `${AGENT_MEMORY_BLOB_PREFIX}/p/${safeSegment(ownerKey ?? "", "unknown")}/INDEX.md`
    : `${AGENT_MEMORY_BLOB_PREFIX}/s/INDEX.md`;
}

function catalogKey(): string {
  return `${AGENT_MEMORY_BLOB_PREFIX}/catalog.json`;
}

function revisionKey(docId: string, revision: number): string {
  return `${AGENT_MEMORY_BLOB_PREFIX}/revisions/${safeSegment(docId, "doc")}-r${revision}.json`;
}

/** 兼容两条 blob 后端读文本：Vercel 返回 { blob }，VPS 返回 { stream }。 */
async function readBlobText(
  result: Awaited<ReturnType<typeof get>> | null,
): Promise<string | null> {
  if (!result) return null;
  const anyResult = result as unknown as { blob?: Blob; stream?: ReadableStream<Uint8Array> | null };
  if (anyResult.blob) return await anyResult.blob.text();
  if (anyResult.stream) {
    const reader = anyResult.stream.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    return new TextDecoder().decode(new Uint8Array(Buffer.concat(chunks as Buffer[])));
  }
  return null;
}

/** 读 blob 文本；任何失败回 null（由调用方回退 Map）。 */
async function readBlobTextAt(key: string): Promise<string | null> {
  try {
    const result = await get(key, { access: "private" }).catch(() => null);
    return await readBlobText(result);
  } catch {
    return null;
  }
}

async function readBlobJson<T>(key: string): Promise<T | null> {
  const text = await readBlobTextAt(key);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** 写文本到 blob；失败静默（调用方另有 Map 兜底）。 */
async function writeBlobText(key: string, text: string): Promise<boolean> {
  try {
    await put(key, text, {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
    });
    return true;
  } catch {
    return false;
  }
}

// ─────────────────────────── 文本切分与 Jaccard（契约 §7，零依赖）

/** token 化：ASCII 词按空白+标点切；CJK 按 bigram。 */
export function memoryTokens(text: string): string[] {
  const source = String(text ?? "");
  const tokens: string[] = [];
  tokens.push(...(source.toLowerCase().match(/[a-z0-9]+/g) ?? []));
  const runs =
    source.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]+/g) ?? [];
  for (const run of runs) {
    const chars = Array.from(run);
    if (chars.length === 1) {
      tokens.push(run);
      continue;
    }
    for (let i = 0; i + 1 < chars.length; i += 1) tokens.push(`${chars[i]}${chars[i + 1]}`);
  }
  return tokens;
}

/** token Jaccard 相似度；任一侧无 token 时回 0（不视为重复）。 */
export function memoryJaccard(a: string, b: string): number {
  const setA = new Set(memoryTokens(a));
  const setB = new Set(memoryTokens(b));
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const token of setA) if (setB.has(token)) intersection += 1;
  return intersection / (setA.size + setB.size - intersection);
}

// ─────────────────────────── Postgres 路径（未启用）

/** 探测 Postgres 是否可用（沿用基底：getGenerationSql 抛错即视为不可用）。 */
function dbAvailable(): boolean {
  try {
    getGenerationSql();
    return true;
  } catch {
    return false;
  }
}

/** 诊断用：本进程是否探测到 Postgres。写入一律 blob/Map（契约 §0）。 */
export function memoryStoreDbBackendAvailable(): boolean {
  return dbAvailable();
}

// ─────────────────────────── catalog

async function loadCatalog(): Promise<MemoryCatalog> {
  const cached = catalogMemory.get(CATALOG_MEMORY_KEY);
  if (cached) return cached;
  const fromBlob = await readBlobJson<MemoryCatalog>(catalogKey());
  if (fromBlob && Array.isArray(fromBlob.entries)) {
    catalogMemory.set(CATALOG_MEMORY_KEY, fromBlob);
    return fromBlob;
  }
  return { version: MEMORY_CATALOG_VERSION, entries: [] };
}

async function saveCatalog(catalog: MemoryCatalog): Promise<void> {
  const next: MemoryCatalog = { version: MEMORY_CATALOG_VERSION, entries: catalog.entries };
  await writeBlobText(catalogKey(), JSON.stringify(next));
  catalogMemory.set(CATALOG_MEMORY_KEY, next);
}

/** 仅测试：重置进程内状态。 */
export function __resetAgentMemoryStoreForTests(): void {
  docsMemory.clear();
  catalogMemory.clear();
}

// ─────────────────────────── 读写正文

async function readDoc(
  scope: MemoryScope,
  ownerKey: string | undefined,
  domain: string,
  slug: string,
): Promise<AgentMemoryDoc | null> {
  const key = bodyKey(scope, ownerKey, domain, slug);
  const cached = docsMemory.get(key);
  if (cached) return cached;
  const parsed = await readBlobJson<AgentMemoryDoc>(key);
  if (parsed) {
    docsMemory.set(key, parsed);
    return parsed;
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
  await writeBlobText(revisionKey(previous.id, previous.revision), JSON.stringify(previous));
}

// ─────────────────────────── 结构校验（形状防线；G1 在 gateway）

const SLUG_PATTERN = /^[a-z0-9-]{1,64}$/;
const SCOPES: MemoryScope[] = ["private", "shared"];
const TYPES: MemoryType[] = ["user", "feedback", "project", "domain"];
const EVIDENCE_KINDS: EvidenceKind[] = ["tool_result", "user_confirmed", "verbatim"];

function isStructurallyValid(input: AgentMemoryDocInput): boolean {
  if (!SCOPES.includes(input?.scope)) return false;
  if (!SLUG_PATTERN.test(String(input?.slug ?? ""))) return false;
  if (!String(input?.domain ?? "").trim()) return false;
  if (typeof input?.description !== "string") return false;
  if (input.description.length === 0 || input.description.length > 120) return false;
  if (typeof input?.body !== "string") return false;
  if (input.body.length === 0 || input.body.length > 2000) return false;
  if (!TYPES.includes(input?.type)) return false;
  if (!EVIDENCE_KINDS.includes(input?.evidenceKind)) return false;
  if (typeof input?.selfScore !== "number" || !Number.isFinite(input.selfScore)) return false;
  if (input.scope === "private" && !String(input.ownerKey ?? "").trim()) return false;
  return true;
}

// ─────────────────────────── 索引

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
    .map((doc) => `- [${doc.domain}] ${doc.slug} — ${doc.description} （v${doc.revision}）`)
    .join("\n");
}

function newDocId(batchId: string, slug: string): string {
  return `${batchId}-${slug}`;
}

function sameScope(
  entry: { scope: MemoryScope; ownerKey?: string },
  scope: MemoryScope,
  ownerKey: string | undefined,
): boolean {
  return entry.scope === scope && (scope === "shared" || entry.ownerKey === ownerKey);
}

/** 读某 scope 的全部 active 正文（由 catalog 驱动，不依赖 blob list）。 */
async function activeDocs(scope: MemoryScope, ownerKey?: string): Promise<AgentMemoryDoc[]> {
  const catalog = await loadCatalog();
  const docs: AgentMemoryDoc[] = [];
  for (const entry of catalog.entries) {
    if (entry.status !== "active") continue;
    if (!sameScope(entry, scope, ownerKey)) continue;
    if (scope === "shared" && !ownerKey && entry.scope !== "shared") continue;
    const doc = await readDoc(entry.scope, entry.ownerKey, entry.domain, entry.slug);
    if (doc && doc.status === "active") docs.push(doc);
  }
  return docs;
}

/** 重建 INDEX.md（active docs）。回传重建后的行数。 */
async function rebuildIndex(scope: MemoryScope, ownerKey?: string): Promise<number> {
  const docs = await activeDocs(scope, ownerKey);
  const md = buildMemoryIndexMd(scope, docs, ownerKey);
  await writeBlobText(indexKey(scope, ownerKey), md);
  return docs.length;
}

// ─────────────────────────── 对外 API

/** 列出某 scope 的 active docs。private 缺 ownerKey 时回空数组。 */
export async function listMemoryDocs(input: MemoryScopeInput): Promise<AgentMemoryDoc[]> {
  const scope: MemoryScope = input?.scope === "private" ? "private" : "shared";
  if (scope === "private" && !String(input?.ownerKey ?? "").trim()) return [];
  const docs = await activeDocs(scope, input?.ownerKey);
  return docs.sort((a, b) => a.domain.localeCompare(b.domain) || a.slug.localeCompare(b.slug));
}

/** 读某 scope 的索引文本；无索引时空字符串。 */
export async function readMemoryIndexMd(scope: MemoryScope, ownerKey?: string): Promise<string> {
  const fromBlob = await readBlobTextAt(indexKey(scope, ownerKey));
  if (fromBlob !== null) return fromBlob;
  const docs = await activeDocs(scope, ownerKey);
  return buildMemoryIndexMd(scope, docs, ownerKey);
}

/** 入库：G5 去重 + G7 配额 + 写正文 + 重建 INDEX.md + 更新 catalog.json。 */
export async function ingestMemoryDocs(input: MemoryIngestInput): Promise<MemoryIngestResult> {
  const batchId = String(input?.batchId ?? "").trim();
  const now = input?.now ?? new Date();
  const nowIso = now.toISOString();
  const todayKey = nowIso.slice(0, 10);
  const candidates = Array.isArray(input?.docs) ? input.docs : [];
  const accepted: string[] = [];
  const rejected: Array<{ slug: string; reason: MemoryRejectReason }> = [];

  if (!batchId) {
    for (const doc of candidates) {
      rejected.push({ slug: String(doc?.slug ?? ""), reason: "structure" });
    }
    return {
      accepted,
      rejected,
      stats: { received: candidates.length, accepted: 0, index_lines: 0 },
    };
  }

  const catalog = await loadCatalog();
  const entries = catalog.entries;
  const touchedPrivateOwners = new Set<string>();
  let sharedAcceptedThisBatch = 0;
  let touchedShared = false;

  for (const candidate of candidates) {
    const slug = String(candidate?.slug ?? "");
    if (!isStructurallyValid(candidate)) {
      rejected.push({ slug, reason: "structure" });
      continue;
    }
    const scope = candidate.scope;
    const ownerKey = scope === "private" ? candidate.ownerKey : undefined;
    const existingIndex = entries.findIndex(
      (entry) => sameScope(entry, scope, ownerKey) && entry.slug === candidate.slug,
    );
    const existingEntry = existingIndex >= 0 ? entries[existingIndex] : null;

    // G5（其二）：description 与既有 active 条目 token Jaccard > 0.8 → duplicate。
    if (!existingEntry) {
      const duplicate = entries.find(
        (entry) =>
          entry.status === "active" &&
          sameScope(entry, scope, ownerKey) &&
          memoryJaccard(entry.description, candidate.description) > MEMORY_DUPLICATE_JACCARD,
      );
      if (duplicate) {
        rejected.push({ slug, reason: "duplicate" });
        continue;
      }
    }

    if (!existingEntry) {
      // G7：单批 shared ≤20。
      if (scope === "shared" && sharedAcceptedThisBatch >= MEMORY_QUOTA_SHARED_PER_BATCH) {
        rejected.push({ slug, reason: "quota_scope" });
        continue;
      }
      // G7：单 domain ≤8/日（当日 catalog 计数）。
      const domainCount = entries.filter(
        (entry) => entry.domain === candidate.domain && entry.createdAt.slice(0, 10) === todayKey,
      ).length;
      if (domainCount >= MEMORY_QUOTA_PER_DOMAIN_DAY) {
        rejected.push({ slug, reason: "quota_domain" });
        continue;
      }
      // G7：单 ownerKey private ≤10/日。
      if (scope === "private") {
        const ownerCount = entries.filter(
          (entry) =>
            entry.scope === "private" &&
            entry.ownerKey === ownerKey &&
            entry.createdAt.slice(0, 10) === todayKey,
        ).length;
        if (ownerCount >= MEMORY_QUOTA_PRIVATE_PER_OWNER_DAY) {
          rejected.push({ slug, reason: "quota_scope" });
          continue;
        }
      }
    }

    // G5（其一）：同 scope+ownerKey+slug 已存在 → 更新（revision+1，旧 body 存档）。
    const previous = await readDoc(scope, ownerKey, candidate.domain, candidate.slug);
    const revision = existingEntry ? Math.max(existingEntry.revision, previous?.revision ?? 0) + 1 : 1;
    if (previous) await writeRevision(previous);

    const doc: AgentMemoryDoc = {
      id: existingEntry?.id ?? newDocId(batchId, candidate.slug),
      scope,
      ownerKey,
      domain: candidate.domain,
      slug: candidate.slug,
      description: candidate.description,
      type: candidate.type,
      body: candidate.body,
      links: Array.isArray(candidate.links) ? candidate.links.map((link) => String(link)) : [],
      evidence: typeof candidate.evidence === "string" ? candidate.evidence.slice(0, 200) : "",
      evidenceKind: candidate.evidenceKind,
      selfScore: candidate.selfScore,
      promptVersion: String(candidate.promptVersion ?? input?.promptVersion ?? "v1"),
      batchId: existingEntry?.batchId ?? batchId,
      status: "active",
      revision,
      createdAt: existingEntry?.createdAt ?? nowIso,
      updatedAt: nowIso,
    };
    await writeDoc(doc);

    const entry: MemoryCatalogEntry = {
      id: doc.id,
      scope: doc.scope,
      ownerKey: doc.ownerKey,
      domain: doc.domain,
      slug: doc.slug,
      description: doc.description,
      status: doc.status,
      revision: doc.revision,
      batchId: doc.batchId,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
    if (existingIndex >= 0) entries[existingIndex] = entry;
    else {
      entries.push(entry);
      if (scope === "shared") sharedAcceptedThisBatch += 1;
    }
    if (scope === "shared") touchedShared = true;
    else if (ownerKey) touchedPrivateOwners.add(ownerKey);
    accepted.push(doc.id);
  }

  await saveCatalog(catalog);

  let indexLines = 0;
  if (accepted.length > 0) {
    if (touchedShared) indexLines += await rebuildIndex("shared");
    for (const ownerKey of touchedPrivateOwners) {
      indexLines += await rebuildIndex("private", ownerKey);
    }
  }

  return {
    accepted,
    rejected,
    stats: { received: candidates.length, accepted: accepted.length, index_lines: indexLines },
  };
}

/** 撤回：status=retracted + 从 INDEX 移除；**不删文件**（留证）。 */
export async function retractMemoryDocs(input: MemoryRetractInput): Promise<{ retracted: string[] }> {
  const docIds = new Set((input?.docIds ?? []).map((id) => String(id)));
  const batchId = String(input?.batchId ?? "").trim();
  if (docIds.size === 0 && !batchId) return { retracted: [] };
  const nowIso = new Date().toISOString();
  const catalog = await loadCatalog();
  const retracted: string[] = [];
  const touchedPrivateOwners = new Set<string>();
  let touchedShared = false;

  for (const entry of catalog.entries) {
    const matches = docIds.size > 0 ? docIds.has(entry.id) : entry.batchId === batchId;
    if (!matches || entry.status === "retracted") continue;
    const doc = await readDoc(entry.scope, entry.ownerKey, entry.domain, entry.slug);
    if (!doc) continue;
    await writeDoc({ ...doc, status: "retracted", updatedAt: nowIso });
    entry.status = "retracted";
    entry.updatedAt = nowIso;
    retracted.push(doc.id);
    if (doc.scope === "shared") touchedShared = true;
    else if (doc.ownerKey) touchedPrivateOwners.add(doc.ownerKey);
  }

  if (retracted.length > 0) {
    await saveCatalog(catalog);
    if (touchedShared) await rebuildIndex("shared");
    for (const ownerKey of touchedPrivateOwners) await rebuildIndex("private", ownerKey);
  }

  return { retracted };
}

/**
 * 品質複核翻轉（PRD §5.6 抽檢判據；【契約外新增】，比照 §3.2 retract 的目錄＋正文同步紀律）：
 * active↔pending_review 雙向翻轉，INDEX 重建沿用 rebuildIndex（pending_review 不在
 * activeDocs → 索引行自動消失）；retracted 永不翻轉（留證不動，兩個方向都不是它的來源態）。
 */
export async function reviewMemoryDocs(
  input: MemoryReviewInput,
): Promise<MemoryReviewResult> {
  const action = input?.action;
  if (action !== "pending_review" && action !== "activate") {
    return { reviewed: [], action };
  }
  const docIds = new Set((input?.docIds ?? []).map((id) => String(id)));
  const batchId = String(input?.batchId ?? "").trim();
  if (docIds.size === 0 && !batchId) return { reviewed: [], action };

  const fromStatus: MemoryStatus = action === "pending_review" ? "active" : "pending_review";
  const toStatus: MemoryStatus = action === "pending_review" ? "pending_review" : "active";
  const scopeFilter: MemoryScope | undefined =
    input?.scope === "private" || input?.scope === "shared"
      ? input.scope
      : action === "pending_review"
        ? "shared" // PRD §5.6：自動翻轉僅限 shared；私有庫要翻得顯式帶 scope
        : undefined;

  const nowIso = new Date().toISOString();
  const catalog = await loadCatalog();
  const reviewed: string[] = [];
  const touchedPrivateOwners = new Set<string>();
  let touchedShared = false;

  for (const entry of catalog.entries) {
    const matches = docIds.size > 0 ? docIds.has(entry.id) : entry.batchId === batchId;
    if (!matches || entry.status !== fromStatus) continue;
    if (scopeFilter && entry.scope !== scopeFilter) continue;
    const doc = await readDoc(entry.scope, entry.ownerKey, entry.domain, entry.slug);
    if (!doc || doc.status !== fromStatus) continue;
    await writeDoc({ ...doc, status: toStatus, updatedAt: nowIso });
    entry.status = toStatus;
    entry.updatedAt = nowIso;
    reviewed.push(doc.id);
    if (doc.scope === "shared") touchedShared = true;
    else if (doc.ownerKey) touchedPrivateOwners.add(doc.ownerKey);
  }

  if (reviewed.length > 0) {
    await saveCatalog(catalog);
    if (touchedShared) await rebuildIndex("shared");
    for (const ownerKey of touchedPrivateOwners) await rebuildIndex("private", ownerKey);
  }

  return { reviewed, action };
}

/** 批次报告落盘（契约 §2 `agent-memory/batches/{batchId}.json`）。 */
export async function saveBatchReport(batchId: string, report: unknown): Promise<void> {
  await writeBlobText(
    `${AGENT_MEMORY_BLOB_PREFIX}/batches/${safeSegment(batchId, "batch")}.json`,
    JSON.stringify(report),
  );
}
