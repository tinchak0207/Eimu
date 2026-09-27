// 節點版本歷史的純函式層（2026-09-27）。
//
// 職責：快照落版、裁剪（保留上限 N 版）、按版號選取、版本 diff、把某版套回節點。
// 全部純函式、零副作用、零 IO——reducer 動作與 API 路由共用同一份語義，不各寫一套。
//
// 資料形狀真源＝`types.ts` 的 `CanvasNodeVersion`（掛在 `CanvasProject.nodeVersions`，
// 不新增 DB/檔案）。持久化清洗＝本檔的 `normalizeNodeVersion(s)`，store 與讀取端共用。

import type { CanvasNode, CanvasNodeMetadata, CanvasNodeVersion, CanvasNodeVersionReason } from "./types";

// ─────────────────────────────────────────── 上限與值域

/**
 * 單一節點保留的版本數上限（最早的先被裁掉）。
 * 20 版的理由：一次「生成→微調→再生成」的來回通常 ≤ 10 版，20 給一倍餘裕；
 * 每個版本只存 title＋metadata（無座標/無二進位），不會隨畫布尺寸膨脹。
 */
export const MAX_NODE_VERSIONS_PER_NODE = 20;

/** 單一專案全部節點的版本數總上限（防「節點很多×每節點 20 版」撐爆 Blob）。 */
export const MAX_NODE_VERSIONS_PER_PROJECT = 400;

/** 落版原因值域（與 `CanvasNodeVersionReason` 同步；執行期判據用）。 */
export const NODE_VERSION_REASONS = ["created", "generated", "edited", "metadata", "revert"] as const;

export function isNodeVersionReason(v: unknown): v is CanvasNodeVersionReason {
  return typeof v === "string" && (NODE_VERSION_REASONS as readonly string[]).includes(v);
}

/**
 * 純瞬態 metadata 鍵：這些鍵的變化**不算內容變更**，不落版。
 * （進度、開始時間、花費角標、任務 id、錯誤訊息、以及非 success 的 status 抖動）
 * 注意 `status` 在此被視為瞬態，但**翻到 success** 由 `isNodeContentChange` 優先判為
 * `generated`（生成完成是內容事件，不能因 status 在瞬態清單裡被吃掉）。
 */
const VOLATILE_METADATA_KEYS = new Set([
  "progress",
  "startedAt",
  "cost_hint",
  "cost_coins",
  "imageTaskId",
  "errorDetails",
  "status",
]);

// ─────────────────────────────────────────── 清洗（store / 讀取端共用）

/** metadata 深拷貝：切斷與當前節點的參考共用（版本是歷史，不可被後續就地改寫）。 */
function cloneMetadata(metadata: CanvasNodeMetadata | undefined | unknown): CanvasNodeMetadata {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
  return JSON.parse(JSON.stringify(metadata)) as CanvasNodeMetadata;
}

/**
 * 版本逐項清洗（照 `project-store.normalizeEpisode` 的逐欄白名單範式）：
 * 非法項回 null（呼叫端 flatMap 丟棄），不整份作廢。
 */
export function normalizeNodeVersion(raw: unknown): CanvasNodeVersion | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Partial<CanvasNodeVersion>;
  if (typeof v.nodeId !== "string" || v.nodeId.length === 0) return null;
  if (typeof v.version !== "number" || !Number.isInteger(v.version) || v.version < 1) return null;
  if (typeof v.title !== "string") return null;
  if (!isNodeVersionReason(v.reason)) return null;
  return {
    version: v.version,
    nodeId: v.nodeId.slice(0, 200),
    createdAt: typeof v.createdAt === "string" ? v.createdAt : new Date().toISOString(),
    reason: v.reason,
    title: v.title.slice(0, 200),
    metadata: cloneMetadata(v.metadata),
  };
}

/**
 * 版本清單清洗：逐項白名單 → 同節點同版號去重（保留首見）→ 逐節點裁剪到上限
 * → 總量裁剪（保留末段＝最新）。非陣列回 undefined（省略鍵）。
 */
export function normalizeNodeVersions(
  raw: unknown,
  maxPerNode: number = MAX_NODE_VERSIONS_PER_NODE,
): CanvasNodeVersion[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  const out: CanvasNodeVersion[] = [];
  for (const item of raw) {
    const entry = normalizeNodeVersion(item);
    if (!entry) continue;
    const key = `${entry.nodeId}#${entry.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  const pruned = pruneNodeVersions(out, maxPerNode);
  return pruned.length > 0 ? pruned.slice(-MAX_NODE_VERSIONS_PER_PROJECT) : undefined;
}

// ─────────────────────────────────────────── 查詢

/** 同一節點的版本清單，按版號升序（＝時間序）。 */
export function listNodeVersions(versions: readonly CanvasNodeVersion[], nodeId: string): CanvasNodeVersion[] {
  return versions.filter((v) => v.nodeId === nodeId).sort((a, b) => a.version - b.version);
}

/** 最新一版；沒有回 undefined。 */
export function latestNodeVersion(
  versions: readonly CanvasNodeVersion[],
  nodeId: string,
): CanvasNodeVersion | undefined {
  const list = listNodeVersions(versions, nodeId);
  return list.length > 0 ? list[list.length - 1] : undefined;
}

/** 下一版號（同節點最大版號 + 1；首版＝1）。 */
export function nextNodeVersion(versions: readonly CanvasNodeVersion[], nodeId: string): number {
  const list = listNodeVersions(versions, nodeId);
  return list.length > 0 ? list[list.length - 1].version + 1 : 1;
}

/**
 * 選版：`version` 有值＝取該版（找不到回 undefined）；省略＝取最新一版。
 * 純查詢，不改任何狀態。
 */
export function selectNodeVersion(
  versions: readonly CanvasNodeVersion[],
  nodeId: string,
  version?: number,
): CanvasNodeVersion | undefined {
  if (version === undefined) return latestNodeVersion(versions, nodeId);
  return listNodeVersions(versions, nodeId).find((v) => v.version === version);
}

/**
 * 「上一版」＝最新一版的前一版（回退的預設目標）。
 * 只有 1 版（或 0 版）時回 undefined＝沒有更早的版本可回。
 */
export function previousNodeVersion(
  versions: readonly CanvasNodeVersion[],
  nodeId: string,
): CanvasNodeVersion | undefined {
  const list = listNodeVersions(versions, nodeId);
  return list.length >= 2 ? list[list.length - 2] : undefined;
}

// ─────────────────────────────────────────── 寫入（純函式，回新陣列）

/** 逐節點裁剪：每個節點只留最後 `maxPerNode` 版；鍵序/相對順序保持不變。 */
export function pruneNodeVersions(
  versions: readonly CanvasNodeVersion[],
  maxPerNode: number = MAX_NODE_VERSIONS_PER_NODE,
): CanvasNodeVersion[] {
  if (versions.length === 0) return [];
  const byNode = new Map<string, CanvasNodeVersion[]>();
  for (const v of versions) {
    const bucket = byNode.get(v.nodeId);
    if (bucket) bucket.push(v);
    else byNode.set(v.nodeId, [v]);
  }
  const kept = new Set<CanvasNodeVersion>();
  for (const bucket of byNode.values()) {
    for (const v of bucket.slice(Math.max(0, bucket.length - Math.max(1, maxPerNode)))) kept.add(v);
  }
  return versions.filter((v) => kept.has(v));
}

/** 追加一版並裁剪（回新陣列，不改輸入）。 */
export function appendNodeVersion(
  versions: readonly CanvasNodeVersion[],
  entry: CanvasNodeVersion,
  maxPerNode: number = MAX_NODE_VERSIONS_PER_NODE,
): CanvasNodeVersion[] {
  return pruneNodeVersions([...versions, entry], maxPerNode);
}

/**
 * 從當前節點造一版快照。版號＝同節點 nextNodeVersion。
 * `createdAt` 可注入（測試用固定時間，避免同毫秒去重歧義）。
 */
export function createNodeVersion(
  node: CanvasNode,
  reason: CanvasNodeVersionReason,
  versions: readonly CanvasNodeVersion[] = [],
  createdAt: string = new Date().toISOString(),
): CanvasNodeVersion {
  return {
    version: nextNodeVersion(versions, node.id),
    nodeId: node.id,
    createdAt,
    reason,
    title: node.title,
    metadata: cloneMetadata(node.metadata),
  };
}

// ─────────────────────────────────────────── 內容變更判定 / diff / 套用

/** 內容簽名：title ＋ metadata 去掉瞬態鍵後穩定序列化。 */
function nodeContentSignature(node: CanvasNode): string {
  const metadata = node.metadata;
  const stable: Record<string, unknown> = {};
  if (metadata) {
    for (const key of Object.keys(metadata).sort()) {
      if (VOLATILE_METADATA_KEYS.has(key)) continue;
      stable[key] = (metadata as Record<string, unknown>)[key];
    }
  }
  return JSON.stringify({ title: node.title, metadata: stable });
}

/**
 * 內容變更判定：回落版原因，或 null（＝不值得落版）。
 *   - status 翻到 success → `generated`（生成完成）
 *   - 內容簽名變化 → title/content/prompt 之一變＝`edited`，其餘＝`metadata`
 *   - 純瞬態抖動（進度/費用/任務 id/非 success 的 status）→ null
 */
export function isNodeContentChange(prev: CanvasNode, next: CanvasNode): CanvasNodeVersionReason | null {
  const prevStatus = prev.metadata?.status;
  const nextStatus = next.metadata?.status;
  if (nextStatus === "success" && prevStatus !== "success") return "generated";
  if (nodeContentSignature(prev) === nodeContentSignature(next)) return null;
  if (prev.title !== next.title) return "edited";
  if (prev.metadata?.content !== next.metadata?.content) return "edited";
  if (prev.metadata?.prompt !== next.metadata?.prompt) return "edited";
  return "metadata";
}

/**
 * 版本 diff（判斷「兩版差在哪」；UI 顯示「與目前版本的差異」用）。
 * `changedKeys`＝兩版 metadata 鍵聯集裡值不同者（穩定排序）；title 是否變另計。
 */
export function diffNodeVersions(
  a: CanvasNodeVersion,
  b: CanvasNodeVersion,
): { titleChanged: boolean; changedKeys: string[] } {
  const keys = new Set([...Object.keys(a.metadata ?? {}), ...Object.keys(b.metadata ?? {})]);
  const changedKeys: string[] = [];
  for (const key of keys) {
    const av = (a.metadata as Record<string, unknown> | undefined)?.[key];
    const bv = (b.metadata as Record<string, unknown> | undefined)?.[key];
    if (JSON.stringify(av) !== JSON.stringify(bv)) changedKeys.push(key);
  }
  changedKeys.sort();
  return { titleChanged: a.title !== b.title, changedKeys };
}

/**
 * 把某一版套回節點：**只換 title ＋ metadata**，座標/尺寸/連線等版面欄位原樣保留
 * （版本＝內容歷史，不是版面歷史）。回新節點，不改輸入。
 */
export function applyNodeVersion(node: CanvasNode, entry: CanvasNodeVersion): CanvasNode {
  return { ...node, title: entry.title, metadata: cloneMetadata(entry.metadata) };
}

/** 純資料工具：某節點目前保留了幾版（測試與上限顯示用）。 */
export function countNodeVersions(versions: readonly CanvasNodeVersion[], nodeId: string): number {
  return listNodeVersions(versions, nodeId).length;
}
