import { createHash } from "node:crypto";
import { AGENT_MEMORY_BLOB_PREFIX, CATALOG_JOURNAL_PREFIX } from "./constants";
import type { MemoryScope } from "./types";

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

function sha256Short(value: string, length = 16): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

/**
 * 文档身份（跨批次／跨进程稳定）：shared 不含 ownerKey；private 含 ownerKey。
 * domain 参与身份，同 slug 不同 domain 视为不同事实。
 */
function memoryIdentity(input: {
  scope: MemoryScope;
  ownerKey?: string;
  domain: string;
  slug: string;
}): string {
  const owner = input.scope === "private" ? String(input.ownerKey ?? "") : "";
  return `${input.scope}|${owner}|${input.domain}|${input.slug}`;
}

/** 确定性文档 id：同 identity 在任何进程／批次都得到同一个 id（历史锚定不靠批次号）。 */
function deterministicDocId(input: {
  scope: MemoryScope;
  ownerKey?: string;
  domain: string;
  slug: string;
}): string {
  return `mem-${sha256Short(memoryIdentity(input), 16)}`;
}

/**
 * 长键安全化：先净化路径片段并截断 64 字，再追加完整原值的 8 字 hash，
 * 避免「70 个 a 的 batchId」这类超长 docId 截断后撞名（路径逃逸净化保留）。
 */
function hashedSegment(value: string): string {
  const full = String(value ?? "");
  return `${safeSegment(full, "doc").slice(0, 64)}-${sha256Short(full, 8)}`;
}

function bodyKey(
  scope: MemoryScope,
  ownerKey: string | undefined,
  domain: string,
  slug: string,
): string {
  return scope === "private"
    ? `${AGENT_MEMORY_BLOB_PREFIX}/p/${safeSegment(ownerKey ?? "", "unknown")}/${safeSegment(domain, "general")}/${safeSegment(slug, "doc")}.json`
    : `${AGENT_MEMORY_BLOB_PREFIX}/s/${safeSegment(domain, "general")}/${safeSegment(slug, "doc")}.json`;
}

/** 旧版 private 正文路径（不含 domain）：只读兼容，写入一律走 `bodyKey`。 */
function legacyPrivateBodyKey(ownerKey: string | undefined, slug: string): string {
  return `${AGENT_MEMORY_BLOB_PREFIX}/p/${safeSegment(ownerKey ?? "", "unknown")}/${safeSegment(slug, "doc")}.json`;
}

function indexKey(scope: MemoryScope, ownerKey?: string): string {
  return scope === "private"
    ? `${AGENT_MEMORY_BLOB_PREFIX}/p/${safeSegment(ownerKey ?? "", "unknown")}/INDEX.md`
    : `${AGENT_MEMORY_BLOB_PREFIX}/s/INDEX.md`;
}

function catalogKey(): string {
  return `${AGENT_MEMORY_BLOB_PREFIX}/catalog.json`;
}


function catalogEntryKey(entry: {
  scope: MemoryScope;
  ownerKey?: string;
  domain: string;
  slug: string;
}): string {
  // 按 identity 落文件：两个进程并发写同一 slug 时写的是同一个文件（最后写者胜），
  // 不会产生两个同 identity 的条目文件。
  return `${CATALOG_JOURNAL_PREFIX}${sha256Short(memoryIdentity(entry), 16)}.json`;
}

/** 旧世代正文存档键（docId 加短 hash，避免超长 id 截断后撞名）。 */
function revisionKey(docId: string, revision: number): string {
  return `${AGENT_MEMORY_BLOB_PREFIX}/revisions/${hashedSegment(docId)}-r${revision}.json`;
}

/** 旧版存档键（无短 hash）：只用于读取兼容，不用于新写入。 */
function legacyRevisionKey(docId: string, revision: number): string {
  return `${AGENT_MEMORY_BLOB_PREFIX}/revisions/${safeSegment(docId, "doc")}-r${revision}.json`;
}

export { safeSegment, memoryIdentity, deterministicDocId, bodyKey, legacyPrivateBodyKey, indexKey, catalogKey, catalogEntryKey, revisionKey, legacyRevisionKey };
