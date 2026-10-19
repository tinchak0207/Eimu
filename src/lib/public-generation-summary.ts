import { generationModel, modelBaseName } from "@/lib/generation-model-catalog";
import type { GenerationWorkflowMetadata } from "@/lib/image-types";

export interface PublicGenerationSummaryInput {
  modelId?: string;
  mediaType?: "image" | "video" | "audio";
  workflow?: GenerationWorkflowMetadata;
}

const QUALITY_LABELS: Record<string, string> = {
  draft: "草稿",
  balanced: "均衡",
  print: "印刷高清",
};

const INTENT_LABELS: Record<string, string> = {
  general: "通用",
  ecommerce: "电商",
  campaign: "活动",
  character: "角色",
  social: "社媒",
};

function resolutionLabel(value?: string) {
  if (!value) return "";
  return /^\d+k$/i.test(value) ? value.toUpperCase() : value;
}

export function formatPublicGenerationSummary(input: PublicGenerationSummaryInput): string {
  const modelId = input.modelId?.trim();
  const workflow = input.workflow;
  const kind = input.mediaType ?? (modelId ? generationModel(modelId)?.kind : undefined);
  const parts = [modelId ? modelBaseName(modelId) : "等待生成"];

  if (kind === "video") {
    if (workflow?.durationSeconds) parts.push(`${workflow.durationSeconds} 秒`);
    if (workflow?.outputResolution) parts.push(resolutionLabel(workflow.outputResolution));
    if (workflow?.generateAudio !== undefined) {
      parts.push(workflow.generateAudio ? "音效开启" : "音效关闭");
    }
  } else {
    if (workflow?.aspectRatio) {
      parts.push(workflow.aspectRatio);
    } else if (workflow?.imageSize) {
      parts.push(workflow.imageSize);
    }
    if (workflow?.outputResolution) parts.push(resolutionLabel(workflow.outputResolution));
  }

  if (workflow?.qualityProfile) {
    parts.push(QUALITY_LABELS[workflow.qualityProfile] ?? workflow.qualityProfile);
  }
  if (workflow?.productionIntent) {
    parts.push(INTENT_LABELS[workflow.productionIntent] ?? workflow.productionIntent);
  }

  return parts.filter(Boolean).join(" · ");
}
