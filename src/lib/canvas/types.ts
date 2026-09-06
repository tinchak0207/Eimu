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
  /**
   * 3D 導演台節點（2026-09-02 spec §5 片5）：gateway director.done 攔截同步，
   * metadata 帶服務端預渲染 SVG 示意（topViewSvg/cameraViewSvg）與分鏡摘要。
   */
  Director = "director",
  /**
   * 3D 場景卡（2026-09-06 Astra PRD P1-3）：3D 導演 subagent 出片落地位——
   * turntable 視頻主體 + stills 縮圖網格 + 資產下載（.blend/.glb），P1 只讀+播放。
   * metadata 走 sceneCard 欄位族（Scene3dCardMetadata），雙白名單鐵律見
   * canvas-snapshot-compressor 記憶。
   */
  Scene3d = "scene_3d",
}

export type CanvasNodeStatus = "idle" | "success" | "loading" | "error";

/**
 * 錯誤詳情物件形（2026-08-27 G-FE 合同）：gateway 對失敗幀下發
 * `{ message, human_message }`——human_message 是給人看的中文短句，
 * message 是原文。舊載荷仍是純字串，兩形並存。
 */
export interface CanvasErrorDetails {
  message?: string;
  human_message?: string;
}

/** 錯誤詳情 → 展示文字：帶 human_message（中文短句）優先，缺省回落原文；空值回 undefined。 */
export function errorDetailsText(details: string | CanvasErrorDetails | undefined): string | undefined {
  if (typeof details === "string") return details.length > 0 ? details : undefined;
  if (!details) return undefined;
  const human = typeof details.human_message === "string" && details.human_message.length > 0 ? details.human_message : undefined;
  if (human !== undefined) return human;
  return typeof details.message === "string" && details.message.length > 0 ? details.message : undefined;
}

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
  errorDetails?: string | CanvasErrorDetails;
  naturalWidth?: number;
  naturalHeight?: number;
  cost_coins?: number;
  /** canvas.plan 的預估花費（單位幣；C-FE）：實際 cost_coins 落地前，節點卡顯示「預估 N 幣」。 */
  cost_hint?: number;
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
  /**
   * 流水線結構卡標記（agent-template-canvas 鋪的泳道卡）：step_head = 步驟頭卡、
   * tool = 工具卡、gate = 門禁卡、director = 導演台卡（gateway director.done 同步）。
   * 渲染層（NodeBody/CanvasNodeView）據此走結構化分層正文；與既有 kind（image/video）分開，不混用。
   */
  pipelineCard?: "step_head" | "tool" | "gate" | "director";
  /** 工具卡：工具 id（等寬字體渲染）。 */
  toolId?: string;
  /** 工具卡：輸入/輸出契約。 */
  toolInput?: string;
  toolOutput?: string;
  /** 工具卡：harness 未接 upstream（紅色警示行，不冒充可用）。 */
  unsupported?: boolean;
  /** 工具卡：缺失的上游能力標識。 */
  requiredCapability?: string;
  /** 步驟頭卡：本步產出合同全文。 */
  deliverable?: string;
  /** 步驟頭卡：本步輸入來源。 */
  inputFrom?: string;
  /** 步驟序號（生成卡頂欄 stepName 條）。 */
  stepIndex?: number;
  /** 步驟全名（生成卡頂欄）。 */
  stepName?: string;
  /** 生成卡：本步 requiredTools 的 id 清單（agent 執行軌跡）。 */
  toolIds?: string[];
  // ── director 節點（pipelineCard: "director"，gateway director.done 攔截同步）──
  /** 導演工程所屬的 gateway 會話 id。 */
  directorSessionId?: string;
  /** 當前活躍方案名（無方案 / reset 後為 null）。 */
  planName?: string | null;
  /** 活躍方案的鏡頭數。 */
  shotCount?: number;
  /** 分鏡健康：true 綠徽章，false 琥珀。 */
  healthOk?: boolean;
  /** 服務端預渲染俯視圖（<svg> 原文；合計 >48KB 時省略）。 */
  topViewSvg?: string;
  /** 服務端預渲染鏡頭框圖（<svg> 原文；合計 >48KB 時省略）。 */
  cameraViewSvg?: string;
  /** 導演工程 revision（gateway doc.revision 透傳）：已掛載視口比對變化重拉 state。 */
  revision?: number;
  // ── 3D 場景卡節點（type: scene_3d，2026-09-06 Astra PRD P1-3；3D 導演 subagent 回傳寫入）──
  /** 3D 場景卡欄位族（單一物件欄位，內部形狀 = Scene3dCardMetadata）。 */
  sceneCard?: Scene3dCardMetadata;
}

/**
 * 3D 場景卡 metadata 形狀（契約：3D 導演 subagent 回傳寫入）。
 * 鐵律（canvas-snapshot-compressor 事故教訓）：本欄位族必須同步兩處白名單——
 * 讀取端 toNodeMetadata（layout.ts）與上行壓縮端 compactMetadataForAgent
 * （canvas-chat-types.ts），漏一端 = 刷新後欄位憑空消失；往復合同測試釘死。
 */
export interface Scene3dCardMetadata {
  /** turntable 旋轉展示視頻（mp4/webm 可播放 URL）。 */
  turntable_url: string;
  /** 渲染静帧縮圖（3-6 張，卡內網格展示）。 */
  stills_urls: string[];
  /** .blend 源檔下載路徑。 */
  blend_path: string;
  /** .glb 交換格式下載路徑。 */
  glb_path: string;
  /** 場景摘要（一句話，副標題展示）。 */
  scene_summary: string;
  /** turntable 時長（ms；無值時播放器自帶 duration 顯示）。 */
  duration_ms: number;
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
  /** canvas.plan 帶的預估花費（單位幣）；node.created 時蓋章到該單元的生成卡 metadata.cost_hint。workflow 計畫（tool 以 "workflow:" 開頭）例外——它是整圖總額，只進側欄不逐卡蓋章。 */
  costHint?: number;
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

/** canvas.node.disconnected — 斷一條連線。 */
export interface CanvasNodeDisconnectedEvent {
  unit_id: string;
  from: string;
  to: string;
}

/** gateway 自動製畫布可能送出的全部 canvas 事件。 */
export type CanvasSseEvent =
  | { name: "canvas.plan"; data: CanvasPlanEvent }
  | { name: "canvas.node.created"; data: CanvasNodeCreatedEvent }
  | { name: "canvas.node.updated"; data: CanvasNodeUpdatedEvent }
  | { name: "canvas.node.connected"; data: CanvasNodeConnectedEvent }
  | { name: "canvas.node.disconnected"; data: CanvasNodeDisconnectedEvent }
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
  "canvas.node.disconnected",
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
  [CanvasNodeType.Director]: { width: 420, height: 300, title: "导演台" },
  [CanvasNodeType.Scene3d]: { width: 420, height: 360, title: "3D 场景卡" },
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
