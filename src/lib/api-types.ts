import { ModelMode, ProviderKey } from "./generation-core/provider-config";
import type { GenerationWorkflowMetadata } from "./media/image-types";
import type { AspectRatio, OutputResolution } from "./generation-core/generation-model-catalog";
import type { ControlNetSpec } from "./generation-core/pixai-controlnets";

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
  /** ControlNet 结构控制规格（pixai 渠道）。 */
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
