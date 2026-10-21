import type { CanvasConnection, CanvasNode, CanvasViewport } from "../types";

// ─────────────────────────────────────────── 历史快照（undo/redo）

export interface CanvasSnapshot {
  nodes: CanvasNode[];
  connections: CanvasConnection[];
  viewport: CanvasViewport;
  /**
   * 软删节点（2026-09-27）：undo/redo 快照也要带，否则「删除→撤销」后
   * deletedNodes 会残留一份已回到节点清单的重复项。optional＝旧快照相容。
   */
  deletedNodes?: CanvasNode[];
}

export interface CanvasHistory {
  past: CanvasSnapshot[];
  future: CanvasSnapshot[];
}

export const CANVAS_HISTORY_LIMIT = 50;
export const CANVAS_EMPTY_HISTORY: CanvasHistory = { past: [], future: [] };

/** 推一格快照。任何新动作都会清空 future（分岔后旧的 redo 已经没有意义）。 */
export function pushSnapshot(history: CanvasHistory, snapshot: CanvasSnapshot): CanvasHistory {
  const past = [...history.past, snapshot];
  return { past: past.slice(Math.max(0, past.length - CANVAS_HISTORY_LIMIT)), future: [] };
}

/** 撤销：把 current 推进 future，回上一格。没得撤销时回 null。 */
export function undoSnapshot(
  history: CanvasHistory,
  current: CanvasSnapshot,
): { history: CanvasHistory; snapshot: CanvasSnapshot } | null {
  if (history.past.length === 0) return null;
  const snapshot = history.past[history.past.length - 1];
  return {
    history: { past: history.past.slice(0, -1), future: [current, ...history.future].slice(0, CANVAS_HISTORY_LIMIT) },
    snapshot,
  };
}

/** 重做：把 current 推回 past，回 future 的第一格。没得重做时回 null。 */
export function redoSnapshot(
  history: CanvasHistory,
  current: CanvasSnapshot,
): { history: CanvasHistory; snapshot: CanvasSnapshot } | null {
  if (history.future.length === 0) return null;
  const snapshot = history.future[0];
  return {
    history: { past: [...history.past, current].slice(-CANVAS_HISTORY_LIMIT), future: history.future.slice(1) },
    snapshot,
  };
}
