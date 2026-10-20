// 画布纯函式层：事件分流、事件正规化、几何、历史快照、专案序列化。
//
// 为什么要有这一层：gateway 的 canvas.* payload 是「宽松解析」过的
// （src/lib/agent-chat-types.ts 的 AgentCanvas* 型别：node 只有 id/type/title/metadata，
// 没有 position/width/height），而 src/lib/canvas/reducer.ts 吃的是完整的 CanvasNode。
// 中间这一步转换必须是纯函式，否则 React 元件里混进契约补齐逻辑，测不了也讲不清。
//
// 排版座标一律留 (0,0) 交给 reducer 的 nextPosition 决定（PRD §5：不允许在
// reducer 外再写一套排版）。这里只补「尺寸」与「型别」这种契约缺口。

export {
  isCanvasEventName,
  isReducibleCanvasEvent,
  toNodeType,
  toNodeStatus,
  EMITS_ENTITY_KINDS,
  CARD_NAME_KEYS,
  toCardMetadataName,
  cleanEmitsEntity,
  toNodeFontSize,
  toNodeMetadata,
  toGateConfirm,
  normalizeCanvasNode,
  normalizeCanvasEvent,
} from "./layout/normalize";
export type { CanvasPassthroughEvent, EmitsEntityKind, EmittedEntityMetadata } from "./layout/normalize";
export {
  CANVAS_SUMMARY_MAX_NODES,
  CANVAS_SUMMARY_MAX_CONNECTIONS,
  summarizeCanvasState,
} from "./layout/summary";
export type { CanvasStateSummaryNode, CanvasStateSummary } from "./layout/summary";
export {
  CANVAS_MIN_SCALE,
  CANVAS_MAX_SCALE,
  CANVAS_GRID_BASE,
  clampScale,
  zoomAtPoint,
  screenToWorld,
  worldToScreen,
  computeWorldBounds,
  CANVAS_READABLE_MIN_SCALE,
  fitToNodes,
  bezierPath,
  gridBackground,
} from "./layout/geometry";
export type { CanvasBounds } from "./layout/geometry";
export {
  CANVAS_HISTORY_LIMIT,
  CANVAS_EMPTY_HISTORY,
  pushSnapshot,
  undoSnapshot,
  redoSnapshot,
} from "./layout/history";
export type { CanvasSnapshot, CanvasHistory } from "./layout/history";
export {
  toCanvasProject,
  fromCanvasProject,
  canvasProjectMeta,
  normalizeProjectMetaPatch,
  CANVAS_EXPORT_KIND,
  CANVAS_EXPORT_VERSION,
  buildExportFile,
  parseImportFile,
} from "./layout/project";
export type { CanvasExportFile } from "./layout/project";
