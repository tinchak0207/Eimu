// workflow 历史记录的读取层：把 Phase 2 写进 entry.workflow 的 DAG 结构
// （节点/连线/缩略图 URL）读成前端能直接渲染的形状。
//
// 这些字段不属于生成的「配方」（配方是提交给 /api/generation-jobs 的参数集），
// 而是这条记录跑完后额外落盘的执行结果：dagNodes 的类型在 image-types 里是
// unknown[]（后端写入侧形状不受前端约束），所以读取必须逐字段宽容解析——
// 缺字段或形状不对时一律当作「这条记录没有 DAG 视图」，绝不猜测，也不抛错
// 让整页历史崩掉。
//
// 只用 `import type`，可在 node --test 下直接导入。
import type { HistoryEntry } from "./history-types";

/** DAG 节点的展示字段。只取渲染真正需要的那几项，其余原样忽略。 */
export interface HistoryDagNodeView {
  /** 节点标题；缺失时调用方按 role/kind 兜底显示。 */
  title: string | null;
  role: string | null;
  kind: string | null;
  status: string | null;
  /** 该节点实际消耗的币数（后端落盘的实付值，不是预估）。 */
  costCoins: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 这条记录带没带后端渲染好的 DAG 缩略图；没有就返回 null。 */
export function workflowDagThumbnailUrl(entry: HistoryEntry): string | null {
  return nonEmptyString(entry.workflow?.dagThumbnailUrl);
}

/**
 * 节点产物清单。返回 null 表示这条记录没有可展示的 DAG 节点（非工作流记录、
 * 或 dagNodes 尚未写入）——调用方据此不渲染这一整块，而不是渲染一个空列表。
 */
export function historyDagNodes(entry: HistoryEntry): HistoryDagNodeView[] | null {
  const raw = entry.workflow?.dagNodes;
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const nodes = raw.flatMap((item): HistoryDagNodeView[] => {
    if (!isRecord(item)) return [];
    return [{
      title: nonEmptyString(item.title) ?? nonEmptyString(item.label) ?? nonEmptyString(item.name),
      role: nonEmptyString(item.role),
      kind: nonEmptyString(item.kind),
      status: nonEmptyString(item.status),
      costCoins: finiteNumber(item.costCoins),
    }];
  });

  return nodes.length ? nodes : null;
}

/** 节点清单里所有已落盘的实付币数之和；没有任何节点带 costCoins 时返回 null。 */
export function historyDagNodesTotalCoins(nodes: HistoryDagNodeView[] | null): number | null {
  if (!nodes) return null;
  let total = 0;
  let seen = false;
  for (const node of nodes) {
    if (node.costCoins === null) continue;
    total += node.costCoins;
    seen = true;
  }
  return seen ? Math.round(total * 100) / 100 : null;
}
