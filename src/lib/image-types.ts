import { ProviderKey } from "./provider-config";
import type { AspectRatio, OutputResolution } from "./generation-model-catalog";

export interface ReferenceImage {
  id: string;
  name: string;
  file: File;
  previewUrl: string;
  size: number;
  /** 原圖自然尺寸（新上傳由 ReferenceImageUpload 測量填入；舊資料可能缺）。
   *  為後續「跟隨參考圖比例」功能鋪樁。 */
  naturalWidth?: number;
  naturalHeight?: number;
  role?: ReferenceImageRole;
  strength?: number;
  sourceResultId?: string;
  sourceGenerationId?: string;
}

export type ReferenceImageRole =
  | "style"
  | "character"
  | "composition"
  | "product"
  | "face"
  | "general";

/**
 * ReferenceImageRole 的唯一運行時清單（2026-08-22 補）：
 * 角色枚舉的 owner 就是本檔案；畫布 reference 節點、API 校驗一律引用這裡，
 * 不另立第二套枚舉。標籤文案在 workstation-constants.REFERENCE_IMAGE_ROLES。
 */
export const REFERENCE_IMAGE_ROLE_VALUES: readonly ReferenceImageRole[] = [
  "style",
  "character",
  "composition",
  "product",
  "face",
  "general",
];

/** 未知值一律收斂為 "general"（舊數據/agent 亂填都不炸）。 */
export function toReferenceImageRole(value: unknown): ReferenceImageRole {
  return typeof value === "string" && (REFERENCE_IMAGE_ROLE_VALUES as readonly string[]).includes(value)
    ? (value as ReferenceImageRole)
    : "general";
}

export function isReferenceImageRole(value: unknown): value is ReferenceImageRole {
  return typeof value === "string" && (REFERENCE_IMAGE_ROLE_VALUES as readonly string[]).includes(value);
}

export interface ReferenceImageMetadata {
  name: string;
  role: ReferenceImageRole;
  size?: number;
  strength?: number;
  sourceResultId?: string;
  sourceGenerationId?: string;
}

export interface RegionalPromptMetadata {
  text: string;
  weight?: number;
}

export interface GenerationWorkflowMetadata {
  schemaVersion?: number;
  contextPrompt?: string;
  negativePrompt?: string;
  negativeHint?: string;
  workflowPreset?: string;
  workflowPresetLabel?: string;
  promptHint?: string;
  productionIntent?: string;
  imageSize?: string;
  imageSizes?: string[];
  aspectRatio?: AspectRatio;
  outputResolution?: OutputResolution;
  durationSeconds?: number;
  generateAudio?: boolean;
  styleTemplate?: string;
  qualityProfile?: string;
  seedHint?: string;
  regionalPrompts?: RegionalPromptMetadata[];
  referenceImages?: ReferenceImageMetadata[];
  estimatedCredits?: number;
  copies?: number;
  concurrency?: number;
  // ── 工作流跑批记录专用（2026-09-20 Phase 2）────────────────────────────
  // gateway 跑批完成推送落盘的 history 记录，除六槽配方外还带整张 DAG。
  // 全部 optional：既有记录（单图/视频生成的 workflow）不受影响，读端一律
  // 用 `Array.isArray(...)` 判存在，不做「缺值即默认」。
  //
  // 形状声明成 unknown[] 而非 DagNodeInput[] 是刻意的：本档是 UI 与生成路由
  // 共用的基础类型档，import dag-renderer 会把 dagre 拖进每一个引用它的
  // bundle；真正要用 DAG 的只有渲染 DAG 缩图的链路，那一侧自己 cast。
  /** DAG 节点（gateway 推送的原样投影：id/role/kind/title/status/content/costCoins/error）。 */
  dagNodes?: unknown[];
  /** DAG 连线（已正规化为 `{from: nodeId, to: nodeId}`，不是 role）。 */
  dagConnections?: unknown[];
  /** 后端渲染好的 DAG 缩略图公开 URL；渲染失败或未渲染时为 undefined。 */
  dagThumbnailUrl?: string;
  /** 整张工作流的实际币耗（各节点 costCoins 之和）；估算值走 estimatedCredits，两者不混。 */
  totalCostCoins?: number;
  /** gateway 侧的工作流 id（幂等键；历史记录 id 由它派生）。 */
  workflowId?: string;
  /** gateway 侧模板 id（single_image / feature_film / novel_film …）。 */
  templateId?: string;
}

export interface GeneratedImage {
  provider: ProviderKey;
  slotId?: string;
  image: string | null;
  imageUrl?: string | null;
  videoUrl?: string | null;
  mediaType?: "image" | "video" | "audio";
  modelId?: string;
  endpointLabel?: string;
  referenceImageNames?: string[];
  workflow?: GenerationWorkflowMetadata;
  taskId?: string;
  resultId?: string;
}

export interface ImageResult {
  provider: ProviderKey;
  slotId?: string;
  image: string | null;
  imageUrl: string | null;
  videoUrl?: string | null;
  mediaType?: "image" | "video" | "audio";
  modelId: string;
  endpointLabel?: string;
  referenceImageNames?: string[];
  workflow?: GenerationWorkflowMetadata;
  taskId?: string;
  resultId?: string;
}

export interface ImageError {
  provider: ProviderKey;
  message: string;
}

export interface ProviderTiming {
  startTime?: number;
  completionTime?: number;
  elapsed?: number;
  durationMs?: number;
}
