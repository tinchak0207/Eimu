import { TYPES } from "./validation";
import type { AgentMemoryDoc, MemoryProposal, MemoryType } from "./types";

/** contributors 正规化：去空、去重、保持既有顺序；非阵列（旧档缺栏）视为 `[]`。 */
function normalizeContributors(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    const key = String(item ?? "").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/** 合并佐证名单：既有顺序在前，新提出者追加（并集、稳定顺序）。next 可为单个 key。 */
function mergeContributors(previous: unknown, next: unknown): string[] {
  const incoming =
    typeof next === "string" ? normalizeContributors([next]) : normalizeContributors(next);
  return normalizeContributors([...normalizeContributors(previous), ...incoming]);
}

/** 内容四元组完全相同才算「幂等重提」；任一不同都视为一次内容变更。 */
function sameContent(
  a: { body: string; description: string; domain: string; type: MemoryType },
  b: { body: string; description: string; domain: string; type: MemoryType },
): boolean {
  return (
    a.body === b.body &&
    a.description === b.description &&
    a.domain === b.domain &&
    a.type === b.type
  );
}

/** 旧档／坏档的 proposed 容错：结构不完整即视为没有提案，不因缺栏报错。 */
function normalizeProposed(value: unknown): MemoryProposal | undefined {
  if (!value || typeof value !== "object") return undefined;
  const parsed = value as Partial<MemoryProposal>;
  if (
    typeof parsed.body !== "string" ||
    typeof parsed.description !== "string" ||
    typeof parsed.domain !== "string" ||
    !TYPES.includes(parsed.type as MemoryType)
  ) {
    return undefined;
  }
  return {
    body: parsed.body,
    description: parsed.description,
    domain: parsed.domain,
    type: parsed.type as MemoryType,
    contributors: normalizeContributors(parsed.contributors),
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
  };
}

// ─────────────────────────── 时间有效性／审计栏位清洗

/** 时间栏位上限：ISO 字串远短于此，超长视为坏值。 */
const MEMORY_DATE_FIELD_MAX_CHARS = 40;
/** `supersedes` 上限（契约：最多 5 条、每条 ≤200 字）。 */
const MEMORY_SUPERSEDES_MAX = 5;
const MEMORY_SUPERSEDES_MAX_CHARS = 200;
/** 审计 id 上限：会话 id 实际可超过 40 字，故放宽到 200 仍不落大字段进 catalog。 */
const MEMORY_AUDIT_ID_MAX_CHARS = 200;
const MEMORY_AUDIT_IDS_MAX = 20;

/**
 * 日期栏位宽松清洗：只接受可 parse 的字符串；坏值回 undefined（**不拒绝整条**）。
 * 读取旧档时同款调用，确保 Date.parse 不会拿到非字符串。
 */
function normalizeIsoField(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text || text.length > MEMORY_DATE_FIELD_MAX_CHARS) return undefined;
  return Number.isFinite(Date.parse(text)) ? text : undefined;
}

function normalizeAuditString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text || text.length > MEMORY_AUDIT_ID_MAX_CHARS) return undefined;
  return text;
}

function normalizeAuditIdList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    const id = normalizeAuditString(item);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MEMORY_AUDIT_IDS_MAX) break;
  }
  return out.length > 0 ? out : undefined;
}

/** `supersedes`：接受字串或字串阵列；去重、截断 200 字、最多 5 条。 */
function normalizeSupersedes(value: unknown): string[] | undefined {
  const list = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    const text = item.trim();
    if (!text) continue;
    const capped = text.length > MEMORY_SUPERSEDES_MAX_CHARS
      ? text.slice(0, MEMORY_SUPERSEDES_MAX_CHARS)
      : text;
    if (seen.has(capped)) continue;
    seen.add(capped);
    out.push(capped);
    if (out.length >= MEMORY_SUPERSEDES_MAX) break;
  }
  return out.length > 0 ? out : undefined;
}

function normalizeLastOperation(value: unknown): AgentMemoryDoc["lastOperation"] {
  return value === "add" || value === "update" || value === "noop" || value === "supersede"
    ? value
    : undefined;
}

export { normalizeContributors, mergeContributors, sameContent, normalizeProposed, normalizeIsoField, normalizeAuditString, normalizeAuditIdList, normalizeSupersedes, normalizeLastOperation };
