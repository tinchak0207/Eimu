// 节点版本历史的纯函式层（2026-09-27）。
//
// 职责：快照落版、裁剪（保留上限 N 版）、按版号选取、版本 diff、把某版套回节点。
// 全部纯函式、零副作用、零 IO——reducer 动作与 API 路由共用同一份语义，不各写一套。
//
// 资料形状真源＝`types.ts` 的 `CanvasNodeVersion`（挂在 `CanvasProject.nodeVersions`，
// 不新增 DB/档案）。持久化清洗＝本档的 `normalizeNodeVersion(s)`，store 与读取端共用。

import type { CanvasNode, CanvasNodeMetadata, CanvasNodeVersion, CanvasNodeVersionReason } from "./types";

// ─────────────────────────────────────────── 上限与值域

/**
 * 单一节点保留的版本数上限（最早的先被裁掉）。
 * 20 版的理由：一次「生成→微调→再生成」的来回通常 ≤ 10 版，20 给一倍余裕；
 * 每个版本只存 title＋metadata（无座标/无二进位），不会随画布尺寸膨胀。
 */
export const MAX_NODE_VERSIONS_PER_NODE = 20;

/** 单一专案全部节点的版本数总上限（防「节点很多×每节点 20 版」撑爆 Blob）。 */
export const MAX_NODE_VERSIONS_PER_PROJECT = 400;

/** 落版原因值域（与 `CanvasNodeVersionReason` 同步；执行期判据用）。 */
export const NODE_VERSION_REASONS = ["created", "generated", "edited", "metadata", "revert"] as const;

export function isNodeVersionReason(v: unknown): v is CanvasNodeVersionReason {
  return typeof v === "string" && (NODE_VERSION_REASONS as readonly string[]).includes(v);
}

/**
 * 纯瞬态 metadata 键：这些键的变化**不算内容变更**，不落版。
 * （进度、开始时间、花费角标、任务 id、错误讯息、以及非 success 的 status 抖动）
 * 注意 `status` 在此被视为瞬态，但**翻到 success** 由 `isNodeContentChange` 优先判为
 * `generated`（生成完成是内容事件，不能因 status 在瞬态清单里被吃掉）。
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

// ─────────────────────────────────────────── 清洗（store / 读取端共用）

/** metadata 深拷贝：切断与当前节点的参考共用（版本是历史，不可被后续就地改写）。 */
function cloneMetadata(metadata: CanvasNodeMetadata | undefined | unknown): CanvasNodeMetadata {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
  return JSON.parse(JSON.stringify(metadata)) as CanvasNodeMetadata;
}

/**
 * 版本逐项清洗（照 `project-store.normalizeEpisode` 的逐栏白名单范式）：
 * 非法项回 null（呼叫端 flatMap 丢弃），不整份作废。
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
 * 版本清单清洗：逐项白名单 → 同节点同版号去重（保留首见）→ 逐节点裁剪到上限
 * → 总量裁剪（保留末段＝最新）。非阵列回 undefined（省略键）。
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

// ─────────────────────────────────────────── 查询

/** 同一节点的版本清单，按版号升序（＝时间序）。 */
export function listNodeVersions(versions: readonly CanvasNodeVersion[], nodeId: string): CanvasNodeVersion[] {
  return versions.filter((v) => v.nodeId === nodeId).sort((a, b) => a.version - b.version);
}

/** 最新一版；没有回 undefined。 */
export function latestNodeVersion(
  versions: readonly CanvasNodeVersion[],
  nodeId: string,
): CanvasNodeVersion | undefined {
  const list = listNodeVersions(versions, nodeId);
  return list.length > 0 ? list[list.length - 1] : undefined;
}

/** 下一版号（同节点最大版号 + 1；首版＝1）。 */
export function nextNodeVersion(versions: readonly CanvasNodeVersion[], nodeId: string): number {
  const list = listNodeVersions(versions, nodeId);
  return list.length > 0 ? list[list.length - 1].version + 1 : 1;
}

/**
 * 选版：`version` 有值＝取该版（找不到回 undefined）；省略＝取最新一版。
 * 纯查询，不改任何状态。
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
 * 「上一版」＝最新一版的前一版（回退的预设目标）。
 * 只有 1 版（或 0 版）时回 undefined＝没有更早的版本可回。
 */
export function previousNodeVersion(
  versions: readonly CanvasNodeVersion[],
  nodeId: string,
): CanvasNodeVersion | undefined {
  const list = listNodeVersions(versions, nodeId);
  return list.length >= 2 ? list[list.length - 2] : undefined;
}

// ─────────────────────────────────────────── 写入（纯函式，回新阵列）

/** 逐节点裁剪：每个节点只留最后 `maxPerNode` 版；键序/相对顺序保持不变。 */
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

/** 追加一版并裁剪（回新阵列，不改输入）。 */
export function appendNodeVersion(
  versions: readonly CanvasNodeVersion[],
  entry: CanvasNodeVersion,
  maxPerNode: number = MAX_NODE_VERSIONS_PER_NODE,
): CanvasNodeVersion[] {
  return pruneNodeVersions([...versions, entry], maxPerNode);
}

/**
 * 从当前节点造一版快照。版号＝同节点 nextNodeVersion。
 * `createdAt` 可注入（测试用固定时间，避免同毫秒去重歧义）。
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

// ─────────────────────────────────────────── 内容变更判定 / diff / 套用

/** 内容签名：title ＋ metadata 去掉瞬态键后稳定序列化。 */
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
 * 内容变更判定：回落版原因，或 null（＝不值得落版）。
 *   - status 翻到 success → `generated`（生成完成）
 *   - 内容签名变化 → title/content/prompt 之一变＝`edited`，其余＝`metadata`
 *   - 纯瞬态抖动（进度/费用/任务 id/非 success 的 status）→ null
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
 * 版本 diff（判断「两版差在哪」；UI 显示「与目前版本的差异」用）。
 * `changedKeys`＝两版 metadata 键联集里值不同者（稳定排序）；title 是否变另计。
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
 * 把某一版套回节点：**只换 title ＋ metadata**，座标/尺寸/连线等版面栏位原样保留
 * （版本＝内容历史，不是版面历史）。回新节点，不改输入。
 */
export function applyNodeVersion(node: CanvasNode, entry: CanvasNodeVersion): CanvasNode {
  return { ...node, title: entry.title, metadata: cloneMetadata(entry.metadata) };
}

/** 纯资料工具：某节点目前保留了几版（测试与上限显示用）。 */
export function countNodeVersions(versions: readonly CanvasNodeVersion[], nodeId: string): number {
  return listNodeVersions(versions, nodeId).length;
}
