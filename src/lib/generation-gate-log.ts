// 生成品质门日志（Blob 世代存储）。
//
// 模式对齐 character-card-store.ts / project-store：每用户一份 index 文件、
// 每次写入落到新路径 + 修剪旧世代（规避 Blob cacheControlMaxAge 60s 下限的
// 「刚存读不到」）、单用户写入门（write queue）串行、无 Blob 时内存降级。
// 容量：每用户上限 500 条滚动。
import { randomBytes } from "node:crypto";
import { del, ensureBlobBackendWritable, get, list, put } from "@/lib/blob-backend";
import { sanitizeBlobSegment } from "@/lib/history-types";
import { gatesBlock } from "./generation-gates";
import type { GateCheck } from "./generation-gates";

const GATE_LOG_SCHEMA_VERSION = 1;
const INDEX_GENERATIONS_KEPT = 2;
const MAX_GATE_LOG_ENTRIES = 500;
const INDEX_CACHE_TTL_MS = 3_000;

export interface GateLogEntry {
  id: string;
  /** ISO 时间戳。 */
  at: string;
  modelId: string;
  /** 本次请求是否被门阻断（存在任一 fail）。 */
  blocked: boolean;
  checks: GateCheck[];
}

export interface GateStat {
  id: string;
  label: string;
  pass: number;
  fail: number;
  skip: number;
  /** 触发率 = fail / (pass + fail)。skip 未评估，不计入分母。 */
  triggerRate: number;
}

const memoryStore = new Map<number, GateLogEntry[]>();
const indexCache = new Map<number, { entries: GateLogEntry[]; expiresAt: number }>();
const writeQueues = new Map<number, Promise<unknown>>();

function userPrefix(userId: number): string {
  return `generation-gates/${sanitizeBlobSegment(String(userId), "0")}`;
}

function indexPrefix(userId: number): string {
  return `${userPrefix(userId)}/index-`;
}

function enqueue<T>(userId: number, task: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(userId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  writeQueues.set(userId, next.catch(() => undefined));
  return next;
}

type BlobRef = { url: string; pathname: string; uploadedAt: Date };

async function listIndexBlobs(userId: number): Promise<BlobRef[]> {
  const blobs: BlobRef[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix: indexPrefix(userId), cursor });
    for (const blob of page.blobs) {
      blobs.push({ url: blob.url, pathname: blob.pathname, uploadedAt: blob.uploadedAt });
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return blobs.sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime());
}

function parseDocument(payload: unknown): GateLogEntry[] {
  const raw = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { entries?: unknown } | null)?.entries)
      ? (payload as { entries: GateLogEntry[] }).entries
      : [];
  return raw.flatMap((item) => {
    const entry = item as GateLogEntry | null;
    if (!entry || typeof entry !== "object" || !Array.isArray(entry.checks)) return [];
    return [{
      id: typeof entry.id === "string" ? entry.id : "",
      at: typeof entry.at === "string" ? entry.at : "",
      modelId: typeof entry.modelId === "string" ? entry.modelId : "",
      blocked: entry.blocked === true,
      checks: entry.checks.filter(
        (check): check is GateCheck =>
          Boolean(check) && typeof check === "object" && typeof (check as GateCheck).id === "string",
      ),
    }];
  });
}

async function readBlobDocument(urlOrPath: string): Promise<GateLogEntry[]> {
  try {
    const blob = await get(urlOrPath, { access: "public" });
    if (!blob || blob.statusCode !== 200) return [];
    const text = await new Response(blob.stream).text();
    if (!text) return [];
    return parseDocument(JSON.parse(text) as unknown);
  } catch {
    return [];
  }
}

async function fetchEntries(userId: number): Promise<GateLogEntry[]> {
  const blobs = await listIndexBlobs(userId);
  if (blobs.length) return readBlobDocument(blobs[0].url);
  return [];
}

async function readEntries(userId: number): Promise<GateLogEntry[]> {
  if (!ensureBlobBackendWritable("generation-gate-log.readEntries")) return [...(memoryStore.get(userId) ?? [])];
  const cached = indexCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return [...cached.entries];
  const entries = await fetchEntries(userId);
  indexCache.set(userId, { entries, expiresAt: Date.now() + INDEX_CACHE_TTL_MS });
  return [...entries];
}

async function writeEntries(userId: number, entries: GateLogEntry[]): Promise<void> {
  const capped = entries.slice(0, MAX_GATE_LOG_ENTRIES);
  if (!ensureBlobBackendWritable("generation-gate-log.writeEntries")) {
    memoryStore.set(userId, capped);
    indexCache.delete(userId);
    return;
  }
  const previous = await listIndexBlobs(userId).catch(() => [] as BlobRef[]);
  const document = { schemaVersion: GATE_LOG_SCHEMA_VERSION, entries: capped };
  const pathname = `${indexPrefix(userId)}${Date.now()}-${randomBytes(4).toString("hex")}.json`;
  await put(pathname, JSON.stringify(document), {
    access: "public",
    contentType: "application/json",
    cacheControlMaxAge: 60,
  });
  indexCache.set(userId, { entries: capped, expiresAt: Date.now() + INDEX_CACHE_TTL_MS });
  const stale = previous.slice(INDEX_GENERATIONS_KEPT - 1);
  if (stale.length) {
    await del(stale.map((b) => b.url)).catch((error) => {
      console.error("[generation-gates] 清理旧索引失败。", error);
    });
  }
}

// ─────────────────────────────────────────── 对外接口

/** 追加一条门日志（滚动上限 500 条，新的在前）。 */
export async function appendGateLog(userId: number, entry: GateLogEntry): Promise<void> {
  const normalized: GateLogEntry = {
    id: entry.id || `gate-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`,
    at: entry.at || new Date().toISOString(),
    modelId: typeof entry.modelId === "string" ? entry.modelId : "",
    blocked: entry.blocked === true || gatesBlock(entry.checks ?? []),
    checks: Array.isArray(entry.checks) ? entry.checks : [],
  };
  await enqueue(userId, async () => {
    const current = await readEntries(userId);
    await writeEntries(userId, [normalized, ...current].slice(0, MAX_GATE_LOG_ENTRIES));
  });
}

/** 读当前用户全部门日志（新的在前）。 */
export async function listGateLog(userId: number): Promise<GateLogEntry[]> {
  const entries = await readEntries(userId);
  return entries;
}

/** 聚合每道门的 pass/fail/skip 计数与触发率（fail / (pass + fail)）。 */
export function aggregateGateStats(entries: GateLogEntry[]): GateStat[] {
  const order: string[] = [];
  const stats = new Map<string, GateStat>();
  for (const entry of entries) {
    for (const check of entry.checks) {
      let stat = stats.get(check.id);
      if (!stat) {
        stat = { id: check.id, label: check.label, pass: 0, fail: 0, skip: 0, triggerRate: 0 };
        stats.set(check.id, stat);
        order.push(check.id);
      }
      if (check.status === "pass") stat.pass += 1;
      else if (check.status === "fail") stat.fail += 1;
      else stat.skip += 1;
    }
  }
  return order.map((id) => {
    const stat = stats.get(id)!;
    const evaluated = stat.pass + stat.fail;
    return { ...stat, triggerRate: evaluated ? stat.fail / evaluated : 0 };
  });
}

/** 仅测试：重置进程内状态。 */
export function __resetGateLogStoreForTests(): void {
  memoryStore.clear();
  indexCache.clear();
  writeQueues.clear();
}
