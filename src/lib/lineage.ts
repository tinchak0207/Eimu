// 资产血统（REQ-D1）：纯资料层——序列化形态、清洗收口、链条构建与两态判定。
//
// 裁决边界（2026-09-22 项目负责人四刀，见 PRD REQ-D1）：
//   * 血统只给人看：宿主是历史记录（HistoryEntry）与资产卡（CharacterCard）本体，
//     严禁补进 compactMetadataForAgent（agent 不读血统是裁决），也不进 canvas 节点 metadata。
//   * 栏位族复用现成资产/历史表示：`lineage: Array<{kind, assetId?, jobId?, nodeId?, at}>`，
//     parents 上限 5，超过截尾并显式标注截断（`lineageTruncated: true` 兄弟栏，
//     截断资讯必须落在数据上，否则读时 UI 无法区分「恰好 5 个」与「被砍过」）。
//   * 已删除 ≠ 来源不明，两个态必须分开：parent 有把手但查无记录 = 已删除；
//     本体完全没有血统登记 = 来源不明。
//
// 本档零依赖（不 import 带 node API 或端别专属的模组），前端抽屉、后端写入挂钩
// 与 tools/ 回溯补丁共用同一把尺。

// ─────────────────────────────────────────────── 栏位族

export const LINEAGE_KIND_VALUES = ["reference", "derivation", "remix", "rerun"] as const;
export type LineageKind = (typeof LINEAGE_KIND_VALUES)[number];

/** 血统条目四种来源语义的 UI 标签（词表唯一 owner 是本档）。 */
export const LINEAGE_KIND_LABEL: Record<LineageKind, string> = {
  reference: "参考",
  derivation: "衍生",
  remix: "混编",
  rerun: "重跑",
};

export interface LineageLink {
  kind: LineageKind;
  /** 资产把手：卡 id（`card-…`）、资产包历史把手（`history-…`）或产物 artifact id。 */
  assetId?: string;
  /** 任务把手：generation job / taskId。 */
  jobId?: string;
  /** 画布节点把手：序列化形态预留（裁决④画布不画血统边，本期挂钩不产出）。 */
  nodeId?: string;
  /** ISO 8601 时间戳。 */
  at: string;
}

/** parents 上限（项目负责人裁决定数）：超过截尾并显式标注截断。 */
export const MAX_LINEAGE_PARENTS = 5;

/** 宿主本体上承载血统的栏位族（HistoryEntry 与 CharacterCard 共用同形）。 */
export interface LineageHostFields {
  lineage?: LineageLink[];
  /** 显式截断标记：登记时曾有超过上限的直接来源被砍尾。 */
  lineageTruncated?: boolean;
}

const MAX_HANDLE_LENGTH = 160;

// ─────────────────────────────────────────────── 清洗与序列化

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 把手清洗：非空、限长、不带空白/控制字元（全站 id 形态都满足；灌串的丢弃）。 */
export function cleanLineageHandle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_HANDLE_LENGTH) return undefined;
  for (const ch of trimmed) {
    if (ch <= " " || ch === "\u007f") return undefined;
  }
  return trimmed;
}

/** `at` 只收 ISO 8601 可解析字串；缺省补当前时间（登记动作本身发生在「现在」）。 */
function cleanLineageAt(value: unknown): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed && !Number.isNaN(Date.parse(trimmed))) return new Date(trimmed).toISOString();
  }
  return new Date().toISOString();
}

export function isLineageKind(value: unknown): value is LineageKind {
  return typeof value === "string" && (LINEAGE_KIND_VALUES as readonly string[]).includes(value);
}

/** 单条血统：kind 非法丢整条；三个把手全缺也丢（无把手的血统既无法跳转也无法判「已删除」）。 */
export function normalizeLineageLink(raw: unknown): LineageLink | null {
  if (!isRecord(raw)) return null;
  if (!isLineageKind(raw.kind)) return null;
  const assetId = cleanLineageHandle(raw.assetId);
  const jobId = cleanLineageHandle(raw.jobId);
  const nodeId = cleanLineageHandle(raw.nodeId);
  if (!assetId && !jobId && !nodeId) return null;
  return {
    kind: raw.kind,
    ...(assetId ? { assetId } : {}),
    ...(jobId ? { jobId } : {}),
    ...(nodeId ? { nodeId } : {}),
    at: cleanLineageAt(raw.at),
  };
}

/** 血统条目的身份键：同 kind + 同把手 = 同一条（幂等合并的判据）。 */
function linkKey(link: LineageLink): string {
  return `${link.kind}|${link.assetId ?? ""}|${link.jobId ?? ""}|${link.nodeId ?? ""}`;
}

/**
 * 清洗一组血统登记：逐条白名单 → 去重（保留首见）→ 上限截尾。
 * truncated 只在「有合法条目被上限砍掉」时为 true（重复不计），
 * 这是「显式标注截断」的数据面，UI 据它显示「仅保留最近 5 个直接来源」。
 */
export function normalizeLineageLinks(raw: unknown): { parents: LineageLink[]; truncated: boolean } {
  if (!Array.isArray(raw)) return { parents: [], truncated: false };
  const seen = new Set<string>();
  const parents: LineageLink[] = [];
  let overflow = false;
  for (const item of raw) {
    const link = normalizeLineageLink(item);
    if (!link) continue;
    const key = linkKey(link);
    if (seen.has(key)) continue;
    if (parents.length >= MAX_LINEAGE_PARENTS) {
      overflow = true;
      continue;
    }
    seen.add(key);
    parents.push(link);
  }
  return { parents, truncated: overflow };
}

/** 读宿主栏位族：完全未登记血统返回 null（＝来源不明），登记了返回清洗后结果。 */
export function readHostLineage(host: Partial<LineageHostFields> | null | undefined): {
  parents: LineageLink[];
  truncated: boolean;
} | null {
  if (!host || !Array.isArray(host.lineage)) return null;
  const { parents, truncated } = normalizeLineageLinks(host.lineage);
  return { parents, truncated: truncated || host.lineageTruncated === true };
}

/**
 * 把新生成的血统登记并进宿主栏位（写入挂钩与回溯补丁共用的幂等入口）：
 *   - 既有条目原样保留（含其 at），新条目按 key 去重——重跑同一挂钩不会双登记；
 *   - 合并后统一过上限，溢出时显式标注截断；
 *   - 幂等：mergeLineageIntoHost(host, readHostLineage(host).parents) 与 host 等价。
 * 返回 null 表示没有任何可写内容（新旧皆空），调用方据此不落栏位。
 */
export function mergeLineageIntoHost(
  host: Partial<LineageHostFields> | null | undefined,
  added: LineageLink[],
): LineageHostFields | null {
  const existing = Array.isArray(host?.lineage) ? host.lineage : [];
  if (!existing.length && !added.length) return null;
  const { parents, truncated } = normalizeLineageLinks([...existing, ...added]);
  if (!parents.length) return null;
  return {
    lineage: parents,
    ...(truncated || host?.lineageTruncated === true ? { lineageTruncated: true } : {}),
  };
}

/** 序列化/反序列化往返（交付件要求形态可序列化；导出本期不做，口子留在这）。 */
export function serializeLineageFields(host: Partial<LineageHostFields>): string {
  return JSON.stringify({
    ...(host.lineage ? { lineage: host.lineage } : {}),
    ...(host.lineageTruncated ? { lineageTruncated: true } : {}),
  });
}

export function parseLineageFields(text: string): LineageHostFields | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) return null;
    const merged = mergeLineageIntoHost(null, Array.isArray(parsed.lineage) ? parsed.lineage : []);
    if (!merged) return null;
    if (parsed.lineageTruncated === true) merged.lineageTruncated = true;
    return merged;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────── 生成管线把手提取

/** 生成管线里带血统线索的参考图元数据（历史 workflow.referenceImages 与 job workflow.references 的交集形态）。 */
export interface LineageBearingReference {
  sourceResultId?: string | null;
  sourceGenerationId?: string | null;
}

/**
 * 挂钩 a 的共用尺：从 job/历史记录的参考图元数据提取 parents。
 *   - sourceGenerationId（参考图出自另一条生成任务）→ derivation，jobId 指回源任务；
 *   - 仅 sourceResultId（直接引用某产物 artifact）→ reference，assetId 指回产物；
 *   - 裸上传参考图（两个把手都没有）不登记：没有持久身份的来源无法跳转，
 *     登记了只会制造永久「查无」的假链条。
 * at 用本次生成时间；去重合并统一交给 mergeLineageIntoHost。
 */
export function parentsFromReferences(
  references: readonly LineageBearingReference[] | null | undefined,
  at: string,
): LineageLink[] {
  if (!Array.isArray(references)) return [];
  const links: LineageLink[] = [];
  for (const ref of references) {
    if (!isRecord(ref)) continue;
    const jobId = cleanLineageHandle(ref.sourceGenerationId);
    const assetId = cleanLineageHandle(ref.sourceResultId);
    if (jobId) links.push({ kind: "derivation", jobId, at });
    else if (assetId) links.push({ kind: "reference", assetId, at });
  }
  return links;
}

/** 历史记录自身可被血统引用的把手（抽屉解析与挂钩 b 共用同一套键）。 */
export function historyEntryHandles(entry: {
  id: string;
  taskId?: string | null;
  results?: readonly { resultId?: string | null }[] | null;
}): { jobId?: string; assetIds: string[] } {
  // jobId 只认真任务 id：同步直出记录的 entry.id 不是 job（没有 generation_job 行），
  // 冒充 jobId 会让「已删除」态对不上真正的任务记录——它统一走 `history-${id}` 资产把手。
  const jobId = cleanLineageHandle(entry.taskId);
  const assetIds: string[] = [];
  const asAsset = `history-${entry.id}`; // 资产包「存为资产」既有惯例（HistoryCard upsert id）。
  if (cleanLineageHandle(asAsset)) assetIds.push(asAsset);
  // 产物 artifact id 也是可被引用的把手（sourceResultId 指回的就是它）。
  for (const result of entry.results ?? []) {
    const resultId = cleanLineageHandle(result?.resultId);
    if (resultId && !assetIds.includes(resultId)) assetIds.push(resultId);
  }
  return { ...(jobId ? { jobId } : {}), assetIds };
}

/** 把记录的血统 parents 写进宿主栏位族用的统一时间源（挂钩 b/c 登记时刻）。 */
export function lineageTimestamp(millis: number): string {
  const ms = Number.isFinite(millis) && millis > 0 ? millis : Date.now();
  return new Date(ms).toISOString();
}

// ─────────────────────────────────────────────── 链条构建（抽屉读取端）

/** 池子为抽屉提供「把手 → 记录」的解析与展示信息。 */
export interface LineageRecordView extends LineageHostFields {
  /** 该记录自身的把手（判自引用与跳转用）。 */
  selfHandles: { jobId?: string; assetId?: string };
  /** 一行描述（prompt 前缀 / 卡名）。 */
  label: string;
  /** 缩图 URL（历史结果图 / 卡参考图首张），无则 null。 */
  thumbnailUrl: string | null;
  /** 时间（毫秒），无法解析时 null。 */
  timeMs: number | null;
}

export interface LineagePool {
  /** 给一个血统把手，找回记录；池查无返回 null（＝已删除态的依据）。 */
  find(jobId: string | undefined, assetId: string | undefined): LineageRecordView | null;
}

export type LineageNodeStatus =
  | "root"
  | "resolved"
  /** parent 有把手但记录查无（曾有引用）＝已删除。 */
  | "deleted"
  /** 该级存在但没有血统登记（回溯补不回的存量）＝来源不明。 */
  | "unknown-origin"
  /** 链条指回自己（自引用守卫，不递归）。 */
  | "self"
  /** 链条成环（祖先里已出现同一把手）。 */
  | "cycle"
  /** 被深度/节点预算截断。 */
  | "pruned";

export interface LineageTreeNode {
  /** null = 根（正在看的那条记录）。 */
  link: LineageLink | null;
  status: LineageNodeStatus;
  depth: number;
  label: string;
  thumbnailUrl: string | null;
  timeMs: number | null;
  /** 该记录登记的 parents 是否曾被上限砍尾。 */
  truncated: boolean;
  /** 可跳转目标（resolved/Deleted/pruned 节点带把手；self/unknown-origin 无从跳）。 */
  jumpTo: { jobId?: string; assetId?: string } | null;
  children: LineageTreeNode[];
}

/** 默认展开层数（项目负责人裁决：3 层＋「继续向上」）。 */
export const LINEAGE_DEFAULT_DEPTH = 3;
/** 「继续向上」每次追加的层数。 */
export const LINEAGE_DEPTH_STEP = 3;
/** 全链节点预算：防病态图把抽屉卡死；超预算的子链标 pruned。 */
export const LINEAGE_MAX_NODES = 200;

interface TreeBuildContext {
  pool: LineagePool;
  /** 共享可变预算：必须跨兄弟链与递归共用同一个对象，快照式 spread 会把深链的耗计漏掉。 */
  budget: { remaining: number };
  maxDepth: number;
}

function handleKeysOf(handles: { jobId?: string; assetId?: string }): string[] {
  const keys: string[] = [];
  if (handles.jobId) keys.push(`job:${handles.jobId}`);
  if (handles.assetId) keys.push(`asset:${handles.assetId}`);
  return keys;
}

function linkHandles(link: LineageLink): { jobId?: string; assetId?: string } {
  // nodeId 本期不产出也不解析（画布不画血统边；池里也没有节点记录）。
  return {
    ...(link.jobId ? { jobId: link.jobId } : {}),
    ...(link.assetId ? { assetId: link.assetId } : {}),
  };
}

function cloneHandles(handles: { jobId?: string; assetId?: string }): { jobId?: string; assetId?: string } | null {
  const cloned = {
    ...(handles.jobId ? { jobId: handles.jobId } : {}),
    ...(handles.assetId ? { assetId: handles.assetId } : {}),
  };
  return Object.keys(cloned).length ? cloned : null;
}

function linkMatchesHandles(link: LineageLink, handles: { jobId?: string; assetId?: string }): boolean {
  return Boolean((link.jobId && link.jobId === handles.jobId) || (link.assetId && link.assetId === handles.assetId));
}

function buildChildren(
  record: LineageRecordView,
  ctx: TreeBuildContext,
  depth: number,
  path: Set<string>,
): {
  children: LineageTreeNode[];
  truncated: boolean;
} {
  const own = readHostLineage(record);
  const parents = own?.parents ?? [];
  const children: LineageTreeNode[] = [];
  for (const link of parents) {
    const handles = linkHandles(link);
    const kindLabel = LINEAGE_KIND_LABEL[link.kind];
    const linkTimeMs = Number.isFinite(Date.parse(link.at)) ? Date.parse(link.at) : null;
    if (!handles.jobId && !handles.assetId) {
      children.push({ link, status: "unknown-origin", depth, label: kindLabel, thumbnailUrl: null, timeMs: linkTimeMs, truncated: false, jumpTo: null, children: [] });
      continue;
    }
    if (linkMatchesHandles(link, record.selfHandles)) {
      children.push({ link, status: "self", depth, label: kindLabel, thumbnailUrl: null, timeMs: linkTimeMs, truncated: false, jumpTo: null, children: [] });
      continue;
    }
    if (depth > ctx.maxDepth || ctx.budget.remaining <= 0) {
      children.push({ link, status: "pruned", depth, label: kindLabel, thumbnailUrl: null, timeMs: linkTimeMs, truncated: false, jumpTo: cloneHandles(handles), children: [] });
      continue;
    }
    const cycleKey = handleKeysOf(handles).find((key) => path.has(key));
    if (cycleKey) {
      children.push({ link, status: "cycle", depth, label: kindLabel, thumbnailUrl: null, timeMs: linkTimeMs, truncated: false, jumpTo: cloneHandles(handles), children: [] });
      continue;
    }
    ctx.budget.remaining -= 1;
    const found = ctx.pool.find(handles.jobId, handles.assetId);
    if (!found) {
      // 有把手、池查无、但血统登记确实在——曾有引用＝已删除（与「来源不明」严格分开）。
      children.push({ link, status: "deleted", depth, label: kindLabel, thumbnailUrl: null, timeMs: linkTimeMs, truncated: false, jumpTo: cloneHandles(handles), children: [] });
      continue;
    }
    const nextPath = new Set(path);
    for (const key of handleKeysOf(found.selfHandles)) nextPath.add(key);
    const nested = buildChildren(found, ctx, depth + 1, nextPath);
    children.push({
      link,
      // 池找得到的祖先＝resolved（可看可跳）。它自己没登记更高级链不降格本级——
      // 「来源不明」只属于两种场合：宿主面板无登记（rootHasLineage=false），
      // 或链中某级只有 kind 没有把手（见上方的 unknown-origin 分支）。
      status: "resolved",
      depth,
      label: found.label || kindLabel,
      thumbnailUrl: found.thumbnailUrl,
      timeMs: found.timeMs ?? linkTimeMs,
      truncated: nested.truncated,
      jumpTo: cloneHandles(found.selfHandles),
      children: nested.children,
    });
  }
  return { children, truncated: own?.truncated ?? false };
}

/**
 * 以一条记录为根，沿 parents 向上建链条树（抽屉的读取端）。
 *   - 根没登记血统 → children=[]，调用方据 `rootHasLineage=false` 显示「来源不明」；
 *   - 自引用标 self；成环标 cycle；超 maxDepth/预算标 pruned——都不误报「已删除」。
 */
export function buildLineageTree(
  root: LineageRecordView,
  pool: LineagePool,
  options: { maxDepth?: number; maxNodes?: number } = {},
): { tree: LineageTreeNode; rootHasLineage: boolean } {
  const ctx: TreeBuildContext = {
    pool,
    budget: { remaining: Math.max(1, options.maxNodes ?? LINEAGE_MAX_NODES) },
    maxDepth: options.maxDepth ?? LINEAGE_DEFAULT_DEPTH,
  };
  const sub = buildChildren(root, ctx, 1, new Set(handleKeysOf(root.selfHandles)));
  return {
    tree: {
      link: null,
      status: "root",
      depth: 0,
      label: root.label,
      thumbnailUrl: root.thumbnailUrl,
      timeMs: root.timeMs,
      truncated: sub.truncated,
      jumpTo: cloneHandles(root.selfHandles),
      children: sub.children,
    },
    rootHasLineage: Array.isArray(root.lineage),
  };
}

/** 把树展平成可见行（缩进渲染用）：超出 visibleDepth 的链收合成一行「更深链条未展开」。 */
export function flattenLineageTree(tree: LineageTreeNode, visibleDepth: number): LineageTreeNode[] {
  const rows: LineageTreeNode[] = [];
  const walk = (node: LineageTreeNode) => {
    rows.push(node);
    if (!node.children.length) return;
    if (node.depth >= visibleDepth) {
      rows.push({
        link: null,
        status: "pruned",
        depth: node.depth + 1,
        label: "更深链条未展开",
        thumbnailUrl: null,
        timeMs: null,
        truncated: false,
        jumpTo: null,
        children: [],
      });
      return;
    }
    for (const child of node.children) walk(child);
  };
  walk(tree);
  return rows;
}