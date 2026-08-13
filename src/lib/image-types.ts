import { ProviderKey } from "./provider-config";
import type { AspectRatio, OutputResolution } from "./generation-model-catalog";

export interface ReferenceImage {
  id: string;
  name: string;
  file: File;
  previewUrl: string;
  size: number;
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
  mediaType?: "image" | "video";
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
  mediaType?: "image" | "video";
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
