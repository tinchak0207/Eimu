import { SUPPORTED_IMAGE_SIZES } from "./generation-model-catalog";
import type {
  GenerationWorkflowMetadata,
  ReferenceImage,
  ReferenceImageRole,
  RegionalPromptMetadata,
} from "@/lib/image-types";

export interface GenerationWorkflowOptions {
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
  aspectRatio?: GenerationWorkflowMetadata["aspectRatio"];
  outputResolution?: GenerationWorkflowMetadata["outputResolution"];
  durationSeconds?: number;
  generateAudio?: boolean;
  styleTemplate?: string;
  qualityProfile?: string;
  seedHint?: string;
  regionalPrompts?: RegionalPromptMetadata[];
  estimatedCredits?: number;
  copies?: number;
  concurrency?: number;
  referenceImageRoles?: Record<string, ReferenceImageRole>;
}

export const WORKFLOW_SCHEMA_VERSION = 2;

function cleanText(value?: string) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function clampInteger(value: number | undefined, min: number, max: number) {
  if (!Number.isFinite(value)) return undefined;
  return Math.max(min, Math.min(max, Math.round(value as number)));
}

function normalizeCredits(value: number | undefined, copies: number | undefined) {
  return clampInteger(value ?? copies ?? 1, 1, 8) ?? 1;
}

const MAX_REGIONAL_PROMPTS = 8;
const MAX_REGIONAL_PROMPT_LENGTH = 240;
const SUPPORTED_WORKFLOW_IMAGE_SIZES = SUPPORTED_IMAGE_SIZES;

export function normalizeImageSizes(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const sizes = SUPPORTED_WORKFLOW_IMAGE_SIZES.filter((size) => value.includes(size));
  return sizes.length ? sizes : undefined;
}

export function normalizeRegionalPrompts(
  value: unknown,
): RegionalPromptMetadata[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const prompts = value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const text = typeof (item as { text?: unknown }).text === "string"
      ? (item as { text: string }).text.trim().slice(0, MAX_REGIONAL_PROMPT_LENGTH)
      : "";
    if (!text) return [];
    const weight = clampInteger((item as { weight?: number }).weight, 1, 100);
    return [{ text, ...(weight !== undefined ? { weight } : {}) }];
  }).slice(0, MAX_REGIONAL_PROMPTS);
  return prompts.length ? prompts : undefined;
}

export function normalizeGenerationWorkflowMetadata(
  workflow?: GenerationWorkflowMetadata,
): GenerationWorkflowMetadata | undefined {
  if (!workflow || Object.keys(workflow).length === 0) return undefined;
  const copies = clampInteger(workflow.copies, 1, 8);
  const concurrency = clampInteger(workflow.concurrency, 1, 4);
  const regionalPrompts = normalizeRegionalPrompts(workflow.regionalPrompts);
  const imageSizes = normalizeImageSizes(workflow.imageSizes);
  return {
    ...workflow,
    schemaVersion: workflow.schemaVersion ?? WORKFLOW_SCHEMA_VERSION,
    ...(copies ? { copies } : {}),
    ...(concurrency ? { concurrency } : {}),
    ...(regionalPrompts ? { regionalPrompts } : { regionalPrompts: undefined }),
    ...(imageSizes ? { imageSizes } : { imageSizes: undefined }),
    estimatedCredits: normalizeCredits(workflow.estimatedCredits, copies),
  };
}

export function createGenerationWorkflow(
  options: GenerationWorkflowOptions = {},
  referenceImages: ReferenceImage[] = [],
): GenerationWorkflowMetadata | undefined {
  const contextPrompt = cleanText(options.contextPrompt);
  const negativePrompt = cleanText(options.negativePrompt);
  const negativeHint = cleanText(options.negativeHint);
  const workflowPreset = cleanText(options.workflowPreset);
  const workflowPresetLabel = cleanText(options.workflowPresetLabel);
  const promptHint = cleanText(options.promptHint);
  const productionIntent = cleanText(options.productionIntent);
  const imageSize = cleanText(options.imageSize);
  const imageSizes = normalizeImageSizes(options.imageSizes);
  const styleTemplate = cleanText(options.styleTemplate);
  const qualityProfile = cleanText(options.qualityProfile);
  const seedHint = cleanText(options.seedHint);
  const regionalPrompts = normalizeRegionalPrompts(options.regionalPrompts);
  const copies = clampInteger(options.copies, 1, 8);
  const concurrency = clampInteger(options.concurrency, 1, 4);
  const imageMetadata = referenceImages.map((image) => ({
    name: image.name,
    role: image.role ?? options.referenceImageRoles?.[image.id] ?? options.referenceImageRoles?.[image.name] ?? "general",
    size: image.size,
    ...(clampInteger(image.strength, 1, 100) !== undefined
      ? { strength: clampInteger(image.strength, 1, 100) }
      : {}),
    ...(image.sourceResultId ? { sourceResultId: image.sourceResultId } : {}),
    ...(image.sourceGenerationId ? { sourceGenerationId: image.sourceGenerationId } : {}),
  }));

  const workflow: GenerationWorkflowMetadata = {
    schemaVersion: options.schemaVersion ?? WORKFLOW_SCHEMA_VERSION,
    ...(contextPrompt ? { contextPrompt } : {}),
    ...(negativePrompt ? { negativePrompt } : {}),
    ...(negativeHint ? { negativeHint } : {}),
    ...(workflowPreset ? { workflowPreset } : {}),
    ...(workflowPresetLabel ? { workflowPresetLabel } : {}),
    ...(promptHint ? { promptHint } : {}),
    ...(productionIntent ? { productionIntent } : {}),
    ...(imageSize ? { imageSize } : {}),
    ...(imageSizes ? { imageSizes } : {}),
    ...(options.aspectRatio ? { aspectRatio: options.aspectRatio } : {}),
    ...(options.outputResolution ? { outputResolution: options.outputResolution } : {}),
    ...(options.durationSeconds ? { durationSeconds: options.durationSeconds } : {}),
    ...(options.generateAudio !== undefined ? { generateAudio: options.generateAudio } : {}),
    ...(styleTemplate ? { styleTemplate } : {}),
    ...(qualityProfile ? { qualityProfile } : {}),
    ...(seedHint ? { seedHint } : {}),
    ...(regionalPrompts ? { regionalPrompts } : {}),
    ...(imageMetadata.length ? { referenceImages: imageMetadata } : {}),
    estimatedCredits: normalizeCredits(options.estimatedCredits, copies),
    ...(copies ? { copies } : {}),
    ...(concurrency ? { concurrency } : {}),
  };

  return Object.keys(workflow).length ? workflow : undefined;
}

export function buildWorkflowPrompt(
  prompt: string,
  workflow?: GenerationWorkflowMetadata,
) {
  const basePrompt = prompt.trim();
  if (!workflow) return basePrompt;

  const sections = [
    workflow.contextPrompt?.trim() ? `Project context:\n${workflow.contextPrompt.trim()}` : "",
    basePrompt ? `Prompt:\n${basePrompt}` : "",
    workflow.workflowPreset?.trim()
      ? `Workflow preset: ${(workflow.workflowPresetLabel ?? workflow.workflowPreset).trim()}`
      : "",
    workflow.promptHint?.trim() ? `Preset guidance:\n${workflow.promptHint.trim()}` : "",
    workflow.regionalPrompts?.length
      ? `Regional requirements (apply to the matching part of the image):\n${workflow.regionalPrompts
          .map((item, index) => `${index + 1}. ${item.text}${item.weight !== undefined ? ` (importance ${item.weight}%)` : ""}`)
          .join("\n")}`
      : "",
    [workflow.productionIntent, workflow.imageSize, workflow.qualityProfile, workflow.seedHint].some((item) => item?.trim())
      ? `Production profile:\n${[
          workflow.productionIntent?.trim() ? `Intent: ${workflow.productionIntent.trim()}` : "",
          workflow.imageSize?.trim() ? `Size: ${workflow.imageSize.trim()}` : "",
          workflow.qualityProfile?.trim() ? `Quality: ${workflow.qualityProfile.trim()}` : "",
          workflow.seedHint?.trim() ? `Seed hint: ${workflow.seedHint.trim()}` : "",
        ].filter(Boolean).join("\n")}`
      : "",
    workflow.referenceImages?.length
      ? `Reference images:\n${workflow.referenceImages
          .map((image) => `- ${image.name} as ${image.role}${image.strength !== undefined ? ` (influence ${image.strength}%)` : ""}`)
          .join("\n")}`
      : "",
    [workflow.negativeHint, workflow.negativePrompt].some((item) => item?.trim())
      ? `Avoid:\n${[workflow.negativeHint, workflow.negativePrompt]
          .map((item) => item?.trim())
          .filter(Boolean)
          .join("\n")}`
      : "",
  ].filter(Boolean);

  return sections.join("\n\n");
}
