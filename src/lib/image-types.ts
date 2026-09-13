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
