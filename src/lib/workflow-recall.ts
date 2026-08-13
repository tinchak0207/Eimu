import type { ReferenceImageRole, RegionalPromptMetadata } from "./image-types";

export interface WorkflowRecallConfig {
  prompt?: string;
  contextPrompt?: string;
  negativePrompt?: string;
  workflowPreset?: string;
  imageSize?: string;
  imageSizes?: string[];
  styleTemplate?: string;
  qualityProfile?: string;
  productionIntent?: string;
  seedHint?: string;
  copies?: number;
  concurrency?: number;
  regionalPrompts?: RegionalPromptMetadata[];
  referenceImageRolesByName?: Record<string, ReferenceImageRole>;
}

export type WorkflowRecallParseResult =
  | { ok: true; config: WorkflowRecallConfig }
  | { ok: false; error: string };

const VALID_REFERENCE_ROLES = new Set<ReferenceImageRole>([
  "style",
  "character",
  "composition",
  "product",
  "face",
  "general",
]);

const VALID_IMAGE_SIZES = new Set(["1024x1024", "1536x1024", "1024x1536"]);
const VALID_QUALITY_PROFILES = new Set(["draft", "balanced", "print"]);
const VALID_PRODUCTION_INTENTS = new Set(["general", "ecommerce", "campaign", "character", "social"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function cleanText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function cleanEnum(value: unknown, valid: Set<string>) {
  const text = cleanText(value);
  return text && valid.has(text) ? text : undefined;
}

function clampRange(value: unknown, min: number, max: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function readReferenceRoles(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  const entries = value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const name = cleanText(item.name);
    const role = item.role;
    if (!name || typeof role !== "string" || !VALID_REFERENCE_ROLES.has(role as ReferenceImageRole)) return [];
    return [[name, role as ReferenceImageRole] as const];
  });
  return entries.length ? Object.fromEntries(entries) : undefined;
}

// 与 generation-workflow.ts 的 normalizeRegionalPrompts 保持同一约束（node --test 下不能跨文件做值导入）
function readRegionalPrompts(value: unknown): RegionalPromptMetadata[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const prompts = value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const text = typeof item.text === "string" ? item.text.trim().slice(0, 240) : "";
    if (!text) return [];
    const weight = clampRange(item.weight, 1, 100);
    return [{ text, ...(weight !== undefined ? { weight } : {}) }];
  }).slice(0, 8);
  return prompts.length ? prompts : undefined;
}

export function parseWorkflowRecallConfig(raw: string): WorkflowRecallParseResult {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { ok: false, error: "配置 JSON 无法解析" };
  }

  if (!isRecord(payload)) return { ok: false, error: "没有可导入的工作站配置" };
  const prompt = cleanText(payload.prompt);
  const contextPrompt = cleanText(payload.contextPrompt);
  const negativePrompt = cleanText(payload.negativePrompt);
  const workflowPreset = cleanText(payload.workflowPreset);
  const imageSize = cleanEnum(payload.imageSize, VALID_IMAGE_SIZES);
  const imageSizes = Array.isArray(payload.imageSizes)
    ? Array.from(VALID_IMAGE_SIZES).filter((size) => (payload.imageSizes as unknown[]).includes(size))
    : [];
  const styleTemplate = cleanText(payload.styleTemplate);
  const qualityProfile = cleanEnum(payload.qualityProfile, VALID_QUALITY_PROFILES);
  const productionIntent = cleanEnum(payload.productionIntent, VALID_PRODUCTION_INTENTS);
  const seedHint = cleanText(payload.seedHint);
  const copies = clampRange(payload.copies, 1, 8);
  const concurrency = clampRange(payload.concurrency, 1, 4);
  const regionalPrompts = readRegionalPrompts(payload.regionalPrompts);
  const referenceImageRolesByName = readReferenceRoles(payload.referenceImages);

  const config: WorkflowRecallConfig = {
    ...(prompt ? { prompt } : {}),
    ...(contextPrompt ? { contextPrompt } : {}),
    ...(negativePrompt ? { negativePrompt } : {}),
    ...(workflowPreset ? { workflowPreset } : {}),
    ...(imageSize ? { imageSize } : {}),
    ...(imageSizes.length ? { imageSizes } : {}),
    ...(styleTemplate ? { styleTemplate } : {}),
    ...(qualityProfile ? { qualityProfile } : {}),
    ...(productionIntent ? { productionIntent } : {}),
    ...(seedHint ? { seedHint } : {}),
    ...(copies ? { copies } : {}),
    ...(concurrency ? { concurrency } : {}),
    ...(regionalPrompts ? { regionalPrompts } : {}),
    ...(referenceImageRolesByName ? { referenceImageRolesByName } : {}),
  };

  return Object.keys(config).length
    ? { ok: true, config }
    : { ok: false, error: "没有可导入的工作站配置" };
}

export function extractPromptSection(prompt: string) {
  const trimmed = prompt.trim();
  const match = trimmed.match(/(?:^|\n\n)Prompt:\n([\s\S]*?)(?:\n\n(?:Workflow preset:|Preset guidance:|Reference images:|Avoid:)|$)/);
  return (match?.[1] ?? trimmed).trim();
}
