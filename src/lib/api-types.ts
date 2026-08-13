import { ModelMode, ProviderKey } from "./provider-config";
import type { GenerationWorkflowMetadata } from "./image-types";
import type { AspectRatio, OutputResolution } from "./generation-model-catalog";
import type { ControlNetSpec } from "./pixai-controlnets";

export interface GenerateImageRequest {
  prompt: string;
  provider: ProviderKey;
  modelId: string;
  qualityMode?: ModelMode;
  aspectRatio?: AspectRatio;
  outputResolution?: OutputResolution;
  durationSeconds?: number;
  generateAudio?: boolean;
  loraModelVersionIds?: string[];
  referenceImages?: File[];
  /** ControlNet 結構控制規格（pixai 渠道）。 */
  controlNets?: ControlNetSpec[];
  workflow?: GenerationWorkflowMetadata;
}

export interface GenerateImageResponse {
  image?: string;
  imageUrl?: string;
  videoUrl?: string;
  mediaType?: "image" | "video";
  endpointLabel?: string;
  error?: string;
}
