// 畫布指揮臺：資料結構與 SSE 事件契約。
//
// 角色 owner：reference 節點的 referenceRole 直接引用 image-types 的
// ReferenceImageRole（type-only import），不建第二套枚舉。
//
// 架構（暴君立場定稿 2026-08-12）：
//   deepseek（opencode agent）不思考畫布的事。它只提交 image_* 生成請求。
//   VPS gateway 攔截每個 image_* 工具的參數與結果，自動產生「畫布單元」，
//   並以 canvas.* 事件推送到前端。前端 reducer 接住事件自動渲染畫布。
//
// 本檔案 = 前端與後端共用的契約。任何改動必須同步兩端。

import type { ReferenceImageRole } from "../image-types";

export type CanvasPosition = { x: number; y: number };

/** 平移 + 縮放，k = scale。 */
export type CanvasViewport = { x: number; y: number; k: number };

export enum CanvasNodeType {
  Image = "image",
  Text = "text",
  Config = "config",
  Video = "video",
  Group = "group",
  CharacterCard = "character_card",
  SceneCard = "scene_card",
  Audio = "audio",
  /** 提示詞備忘節點：可直編文本，連到生成節點時文本注入為 prompt 前綴。 */
  Prompt = "prompt",
  /** 帶角色的參考圖節點：復用 ReferenceImageRole，連到生成節點時自動帶圖+角色。 */
  Reference = "reference",
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
  // P1-3: 鏡頭語言 metadata
  shot_size?: string; // 景別：特寫/近景/中景/全景/遠景
  camera_move?: string; // 運鏡：固定/推進/拉遠/搖鏡/跟拍
  // P1: workflow 識別
  workflow_id?: string;
  session_id?: string;
  // P2: 角色卡/場景卡 metadata
  description?: string;
  key_features?: string[];
  role?: string;
  locked?: boolean;
  // P3: 批次 & 查閱 metadata
  referenceNodeIds?: string[];
  batchIndex?: number;
  batchTotal?: number;
  storageKey?: string;
  mimeType?: string;
  bytes?: number;
  /** 文本節點字號（px）；未設取 14.5。 */
  fontSize?: number;
  /** reference 節點的參考圖角色（復用 ReferenceImageRole，不另立枚舉）。 */
  referenceRole?: ReferenceImageRole;
}

export interface CanvasNode {
  id: string;
  type: CanvasNodeType;
  title: string;
  position: CanvasPosition;
  width: number;
  height: number;
  metadata?: CanvasNodeMetadata;
  /** 手動拖動過 = 不再參與自動排版（用戶掌控位置） */
  moved?: boolean;
  /** 批次父節點：子節點 id 列表 */
  batchChildren?: string[];
  /** 批次是否展開（收起時只顯示主圖片） */
  batchExpanded?: boolean;
  /** 批次主圖片節點 id（縮圖/封面） */
  batchPrimaryImageId?: string;
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
  | { name: "canvas.budget.updated"; data: { unit_id?: string; used_coins: number; remaining_coins: number } }
  | { name: "canvas.ops"; data: CanvasAgentOpsEvent };

export const CANVAS_EVENT_NAMES = [
  "canvas.plan",
  "canvas.node.created",
  "canvas.node.updated",
  "canvas.node.connected",
  "canvas.node.generating",
  "canvas.node.deleted",
  "canvas.derive.started",
  "canvas.budget.updated",
  "canvas.ops",
] as const;

// ─────────────────────────────────────────── Agent 操作畫布（Wave C）

/**
 * Agent 批量畫布操作：gateway 的 canvas_apply_ops 工具經 SSE 下發，
 * 前端執行（可先過確認閘）後把結果 POST 回 gateway resolve 該工具調用。
 * 與 infinite-canvas 的 8-op DSL 對齊，執行語義全在前端 reducer。
 */
export type CanvasAgentOp =
  | { type: "add_node"; node: Partial<CanvasNode> & { id: string; type: CanvasNodeType | string } }
  | { type: "update_node"; id: string; patch: { title?: string; position?: CanvasPosition; width?: number; height?: number; metadata?: Partial<CanvasNodeMetadata> } }
  | { type: "delete_nodes"; ids: string[] }
  | { type: "connect_nodes"; connections: { fromNodeId: string; toNodeId: string }[] }
  | { type: "delete_connections"; ids: string[] }
  | { type: "select_nodes"; ids: string[] }
  | { type: "set_viewport"; viewport: Partial<CanvasViewport> }
  | { type: "run_generation"; node_id: string; prompt?: string; model?: string; size?: string; count?: number };

export interface CanvasAgentOpsEvent {
  request_id: string;
  ops: CanvasAgentOp[];
  /** 給確認閘顯示的一句話意圖（agent 提供）。 */
  label?: string;
}

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
  /** P2 跨鏡頭一致性：鎖定到本畫布的角色/場景卡 id（CharacterCard.id）。 */
  cardIds?: string[];
}

// ─────────────────────────────────────────── 節點預設尺寸

export const CANVAS_NODE_DEFAULT_SIZE: Record<CanvasNodeType, { width: number; height: number; title: string }> = {
  [CanvasNodeType.Image]: { width: 340, height: 240, title: "图片" },
  [CanvasNodeType.Text]: { width: 340, height: 240, title: "文本" },
  [CanvasNodeType.Config]: { width: 440, height: 240, title: "生成配置" },
  [CanvasNodeType.Video]: { width: 420, height: 236, title: "视频" },
  [CanvasNodeType.Group]: { width: 760, height: 480, title: "组" },
  [CanvasNodeType.CharacterCard]: { width: 340, height: 280, title: "角色卡" },
  [CanvasNodeType.SceneCard]: { width: 340, height: 280, title: "场景卡" },
  [CanvasNodeType.Audio]: { width: 340, height: 240, title: "音频" },
  [CanvasNodeType.Prompt]: { width: 340, height: 200, title: "提示词" },
  [CanvasNodeType.Reference]: { width: 300, height: 260, title: "参考图" },
};

// ─────────────────────────────────────────── 批次 & 資源參考

/** 資源參考：節點關聯的可查閱資源（圖片/音訊等）。 */
export interface CanvasResourceReference {
  nodeId: string;
  kind: string; // 資源種類，如 "image" | "audio"
  label: string;
  title: string;
  previewUrl?: string;
  text?: string;
  active: boolean;
}

/** 批次操作指令：前端對批次父節點的本地操作。 */
export type CanvasBatchOperation =
  | { type: "add_child"; childId: string; imageUrl: string }
  | { type: "set_primary"; childId: string }
  | { type: "delete_child"; childId: string }
  | { type: "toggle_expanded" };
