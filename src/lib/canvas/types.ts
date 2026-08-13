// 畫布指揮臺：資料結構與 SSE 事件契約。
//
// 架構（暴君立場定稿 2026-08-12）：
//   deepseek（opencode agent）不思考畫布的事。它只提交 image_* 生成請求。
//   VPS gateway 攔截每個 image_* 工具的參數與結果，自動產生「畫布單元」，
//   並以 canvas.* 事件推送到前端。前端 reducer 接住事件自動渲染畫布。
//
// 本檔案 = 前端與後端共用的契約。任何改動必須同步兩端。

export type CanvasPosition = { x: number; y: number };

/** 平移 + 縮放，k = scale。 */
export type CanvasViewport = { x: number; y: number; k: number };

export enum CanvasNodeType {
  Image = "image",
  Text = "text",
  Config = "config",
  Video = "video",
  Group = "group",
}

export type CanvasNodeStatus = "idle" | "success" | "loading" | "error";

/** 節點元資料：承載 prompt/模型/尺寸/任務/結果。與 gateway autoCreateCanvasUnit 產出對齊。 */
export interface CanvasNodeMetadata {
  content?: string; // 圖片節點 = public URL；文本節點 = 正文
  prompt?: string;
  negativePrompt?: string;
  model?: string;
  size?: string;
  quality?: string;
  count?: number;
  kind?: string; // "image" | "video"
  source_image?: string | null; // edit/upscale 的來源 mediaId/URL
  status?: CanvasNodeStatus;
  errorDetails?: string;
  naturalWidth?: number;
  naturalHeight?: number;
  cost_coins?: number;
  imageTaskId?: string;
  startedAt?: number;
  progress?: number;
}

export interface CanvasNode {
  id: string;
  type: CanvasNodeType;
  title: string;
  position: CanvasPosition;
  width: number;
  height: number;
  metadata?: CanvasNodeMetadata;
}

export interface CanvasConnection {
  id: string;
  fromNodeId: string;
  toNodeId: string;
}

/** 自動製畫布的「畫布單元」：一次生成請求 = 文本節點 + 配置節點 + 結果圖片節點。 */
export interface CanvasUnit {
  unitId: string;
  tool: string;
  nodes: CanvasNode[];
  connections: CanvasConnection[];
}

// ─────────────────────────────────────────── SSE 事件契約（gateway → 前端）

/** canvas.plan — 一次生成請求的計畫卡。 */
export interface CanvasPlanEvent {
  unit_id: string;
  tool: string;
  label: string;
  prompt: string;
  model: string;
  size: string;
  count: number;
  kind: string;
  source_image: string | null;
  cost_hint: number | null;
}

/** canvas.node.created — 前端建一個節點。target_kind="result" 表示結果預留節點。 */
export interface CanvasNodeCreatedEvent {
  unit_id: string;
  node: CanvasNode;
  target_kind?: "result";
}

/** canvas.node.updated — 更新節點（通常是結果落地）。 */
export interface CanvasNodeUpdatedEvent {
  unit_id: string;
  node_id: string;
  patch: Partial<CanvasNodeMetadata> & { status?: CanvasNodeStatus };
  url?: string;
  cost_coins?: number;
}

/** canvas.node.connected — 建一條連線。 */
export interface CanvasNodeConnectedEvent {
  unit_id: string;
  connection: CanvasConnection;
  target_kind?: "result";
}

/** gateway 自動製畫布可能送出的全部 canvas 事件。 */
export type CanvasSseEvent =
  | { name: "canvas.plan"; data: CanvasPlanEvent }
  | { name: "canvas.node.created"; data: CanvasNodeCreatedEvent }
  | { name: "canvas.node.updated"; data: CanvasNodeUpdatedEvent }
  | { name: "canvas.node.connected"; data: CanvasNodeConnectedEvent }
  | { name: "canvas.node.generating"; data: { unit_id: string; node_id: string; status: string; progress?: number } }
  | { name: "canvas.node.deleted"; data: { unit_id: string; node_id?: string } }
  | { name: "canvas.derive.started"; data: { unit_id: string; source_node_id: string; instruction: string; interpretation?: string } }
  | { name: "canvas.budget.updated"; data: { unit_id?: string; used_coins: number; remaining_coins: number } };

export const CANVAS_EVENT_NAMES = [
  "canvas.plan",
  "canvas.node.created",
  "canvas.node.updated",
  "canvas.node.connected",
  "canvas.node.generating",
  "canvas.node.deleted",
  "canvas.derive.started",
  "canvas.budget.updated",
] as const;

// ─────────────────────────────────────────── 畫布專案（雲端持久化）

export interface CanvasProject {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  nodes: CanvasNode[];
  connections: CanvasConnection[];
  viewport: CanvasViewport;
  backgroundMode: "dots" | "lines" | "blank";
  budget?: { totalCoins: number; usedCoins: number };
}

// ─────────────────────────────────────────── 節點預設尺寸

export const CANVAS_NODE_DEFAULT_SIZE: Record<CanvasNodeType, { width: number; height: number; title: string }> = {
  [CanvasNodeType.Image]: { width: 340, height: 240, title: "图片" },
  [CanvasNodeType.Text]: { width: 340, height: 240, title: "文本" },
  [CanvasNodeType.Config]: { width: 440, height: 240, title: "生成配置" },
  [CanvasNodeType.Video]: { width: 420, height: 236, title: "视频" },
  [CanvasNodeType.Group]: { width: 760, height: 480, title: "组" },
};
