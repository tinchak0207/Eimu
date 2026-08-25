/**
 * Ecommerce new-product launch adapter.
 *
 * This module is a planning/translation boundary only. It does not own queue,
 * billing, history, artifact storage, or canvas persistence. Mapped plans carry
 * the shape expected by generation-core; callers still submit through its owner.
 */

export const ECOMMERCE_TOOL_IDS = [
  "product_lock",
  "background_remove",
  "scene_pack_batch",
  "product_conditioned_generation",
  "pose_conditioned_inpaint",
  "detail_page_manifest",
  "aspect_reflow",
  "upscale_audit",
] as const;

export type EcommerceToolId = (typeof ECOMMERCE_TOOL_IDS)[number];
export type EcommerceToolSupport = "mapped" | "artifact_only" | "unsupported";
export type EcommercePlanStatus = "ready" | "invalid" | "unsupported";
export type EcommerceArtifactKind = "image" | "json" | "audit" | "manifest";
export type EcommerceGateState = "pass" | "pending" | "unsupported" | "fail";

export interface EcommerceInputField {
  name: string;
  type: "string" | "url" | "string[]" | "integer";
  required: boolean;
  description: string;
}

export interface EcommerceArtifactContract {
  name: string;
  kind: EcommerceArtifactKind;
  required: boolean;
  description: string;
}

export interface EcommerceGateContract {
  id: string;
  description: string;
  blocking: boolean;
}

export interface EcommerceCanvasContract {
  workflowId: `ecommerce.${string}`;
  nodeType: "reference" | "image" | "config" | "text" | "audit";
  metadataKeys: readonly string[];
}

export interface EcommerceOwnership {
  queue: "generation-core";
  billing: "generation-core";
  history: "generation-core";
  canvas: "canvas";
}

export interface EcommerceGenerationMapping {
  owner: "generation-core";
  /** Fields that can be merged into GenerationCommand before the caller adds auth/tenant context. */
  command: {
    kind: "image_generate" | "image_edit";
    modelId: string;
    prompt: string;
    ratio?: string;
    requestedCount: number;
    responseFormat: "url";
    workflow: {
      references: Array<{
        artifactId: string;
        url: string;
        mimeType: string;
        referenceRole: "product" | "composition" | "general";
      }>;
      metadata: Record<string, unknown>;
    };
  };
  kind: "image_generate" | "image_edit";
  modelId: string;
  prompt: string;
  ratio?: string;
  requestedCount: number;
  workflow: {
    references: Array<{
      artifactId: string;
      url: string;
      mimeType: string;
      referenceRole: "product" | "composition" | "general";
    }>;
    metadata: Record<string, unknown>;
  };
}

export interface EcommerceGenerationBatchMapping {
  owner: "generation-core";
  commands: EcommerceGenerationMapping[];
}

export interface EcommerceOutputArtifact {
  artifactId: string;
  kind: EcommerceArtifactKind;
  mimeType: string;
  metadata?: Record<string, unknown>;
}

export interface EcommerceToolDefinition {
  id: EcommerceToolId;
  label: string;
  support: EcommerceToolSupport;
  inputs: readonly EcommerceInputField[];
  outputs: readonly EcommerceArtifactContract[];
  gates: readonly EcommerceGateContract[];
  unsupported: readonly string[];
  canvas: EcommerceCanvasContract;
  ownership: EcommerceOwnership;
  mapping?: {
    owner: "generation-core";
    kind: "image_generate" | "image_edit";
    route: "submitGenerationCommand" | "/api/pixai/edit" | "/api/pixai/upscale";
  };
}

export interface EcommerceGateDecision {
  id: string;
  state: EcommerceGateState;
  detail: string;
}

export interface EcommerceInputIssue {
  param: string;
  code: "missing" | "invalid";
  message: string;
}

export interface EcommerceToolPlan {
  tool: EcommerceToolId;
  status: EcommercePlanStatus;
  issues: EcommerceInputIssue[];
  unsupported: string[];
  gates: EcommerceGateDecision[];
  artifacts: {
    inputs: Array<{ artifactId: string; kind: EcommerceArtifactKind }>;
    outputs: EcommerceOutputArtifact[];
  };
  canvas: {
    workflowId: `ecommerce.${string}`;
    nodeType: EcommerceCanvasContract["nodeType"];
    nodeMetadata: Record<string, unknown>;
  };
  generation?: EcommerceGenerationMapping;
  generationBatch?: EcommerceGenerationBatchMapping;
}

const OWNERSHIP: EcommerceOwnership = {
  queue: "generation-core",
  billing: "generation-core",
  history: "generation-core",
  canvas: "canvas",
};

const PRODUCT_LOCK_INPUTS: EcommerceInputField[] = [
  { name: "productArtifactId", type: "string", required: true, description: "Existing source product artifact identifier." },
  { name: "productImageUrl", type: "url", required: true, description: "Source product image URL owned by the artifact store." },
  { name: "productName", type: "string", required: true, description: "Human-readable product label." },
];

const PRODUCT_LOCK_GATE_CONTRACTS: EcommerceGateContract[] = [
  { id: "input_validated", description: "Product identity and source artifact are present.", blocking: true },
  { id: "artifact_owned", description: "The artifact must be resolved by the existing artifact/history owner.", blocking: true },
];

const GENERATION_GATE_CONTRACTS: EcommerceGateContract[] = [
  { id: "input_validated", description: "Required product lock and prompt fields are present.", blocking: true },
  { id: "product_reference_resolved", description: "The existing artifact owner must resolve the product reference.", blocking: true },
  { id: "generation_capability", description: "generation-core must confirm model, kind, ratio, and resolution capability.", blocking: true },
  { id: "billing_reserved", description: "generation-core billing must reserve before queue submission.", blocking: true },
  { id: "history_linked", description: "The resulting job must remain in the existing history owner.", blocking: false },
];

const UNSUPPORTED_GATE_CONTRACTS: EcommerceGateContract[] = [
  { id: "upstream_capability", description: "A verified upstream implementation must be configured before execution.", blocking: true },
];

function definition(
  id: EcommerceToolId,
  label: string,
  support: EcommerceToolSupport,
  inputs: EcommerceInputField[],
  outputs: EcommerceArtifactContract[],
  gates: EcommerceGateContract[],
  unsupported: string[],
  canvas: EcommerceCanvasContract,
  mapping?: EcommerceToolDefinition["mapping"],
): EcommerceToolDefinition {
  return { id, label, support, inputs, outputs, gates, unsupported, canvas, ownership: OWNERSHIP, ...(mapping ? { mapping } : {}) };
}

export const ECOMMERCE_UPSTREAM_SOURCES = [
  {
    name: "ComfyUI-RMBG",
    url: "https://github.com/1038lab/ComfyUI-RMBG",
    capability: "RMBG-2.0 and segmentation-oriented background removal nodes",
  },
  {
    name: "ComfyUI_IPAdapter_plus",
    url: "https://github.com/cubiq/ComfyUI_IPAdapter_plus",
    capability: "IP-Adapter reference-image conditioning",
  },
  {
    name: "comfyui_controlnet_aux",
    url: "https://github.com/Fannovel16/comfyui_controlnet_aux",
    capability: "ControlNet auxiliary preprocessors including OpenPose",
  },
  {
    name: "Real-ESRGAN",
    url: "https://github.com/xinntao/Real-ESRGAN",
    capability: "Super-resolution/upscale candidate for audit pipeline",
  },
] as const;

const UNSUPPORTED = {
  background_remove: ["No configured RMBG/BiRefNet upstream in Image Studio."],
  pose_conditioned_inpaint: ["No configured OpenPose/ControlNet or IP-Adapter upstream in Image Studio."],
  aspect_reflow: ["No verified layout-aware aspect reflow upstream; prompt-only resizing is not reflow."],
  upscale_audit: ["Existing PixAI upscale route has no configured VLM audit stage; upscale alone is not an audit."],
} as const;

export const ECOMMERCE_PRODUCT_TOOLS: Record<EcommerceToolId, EcommerceToolDefinition> = {
  product_lock: definition(
    "product_lock",
    "Lock product reference",
    "artifact_only",
    PRODUCT_LOCK_INPUTS,
    [{ name: "productLock", kind: "json", required: true, description: "Durable product identity, source reference, and lock metadata." }],
    PRODUCT_LOCK_GATE_CONTRACTS,
    [],
    { workflowId: "ecommerce.product_lock", nodeType: "reference", metadataKeys: ["productArtifactId", "productName", "referenceRole", "locked"] },
  ),
  background_remove: definition(
    "background_remove",
    "Remove product background",
    "unsupported",
    [{ name: "productLockArtifactId", type: "string", required: true, description: "Locked product reference artifact." }],
    [{ name: "transparentProduct", kind: "image", required: true, description: "RGBA product cutout." }],
    UNSUPPORTED_GATE_CONTRACTS,
    [...UNSUPPORTED.background_remove],
    { workflowId: "ecommerce.background_remove", nodeType: "image", metadataKeys: ["productLockArtifactId", "alphaMatte", "unsupported"] },
  ),
  scene_pack_batch: definition(
    "scene_pack_batch",
    "Generate scene pack batch",
    "mapped",
    [
      { name: "productLockArtifactId", type: "string", required: true, description: "Locked product reference artifact." },
      { name: "productReferenceUrl", type: "url", required: true, description: "Resolved product image URL from the artifact owner." },
      { name: "scenes", type: "string[]", required: true, description: "Ordered scene prompts." },
      { name: "modelId", type: "string", required: true, description: "Existing generation model identifier." },
      { name: "aspectRatio", type: "string", required: true, description: "Existing generation aspect ratio." },
    ],
    [{ name: "scenePackImages", kind: "image", required: true, description: "One generation-core image artifact per scene." }],
    GENERATION_GATE_CONTRACTS,
    [],
    { workflowId: "ecommerce.scene_pack_batch", nodeType: "image", metadataKeys: ["productLockArtifactId", "batchIndex", "batchTotal", "scene"] },
    { owner: "generation-core", kind: "image_generate", route: "submitGenerationCommand" },
  ),
  product_conditioned_generation: definition(
    "product_conditioned_generation",
    "Generate with locked product",
    "mapped",
    [
      { name: "productLockArtifactId", type: "string", required: true, description: "Locked product reference artifact." },
      { name: "productReferenceUrl", type: "url", required: true, description: "Resolved product image URL from the artifact owner." },
      { name: "prompt", type: "string", required: true, description: "Scene or campaign direction." },
      { name: "modelId", type: "string", required: true, description: "Existing generation model identifier." },
      { name: "aspectRatio", type: "string", required: true, description: "Existing generation aspect ratio." },
    ],
    [{ name: "conditionedImage", kind: "image", required: true, description: "Image artifact returned by generation-core." }],
    GENERATION_GATE_CONTRACTS,
    [],
    { workflowId: "ecommerce.product_conditioned_generation", nodeType: "image", metadataKeys: ["productLockArtifactId", "referenceRole", "prompt", "modelId"] },
    { owner: "generation-core", kind: "image_generate", route: "submitGenerationCommand" },
  ),
  pose_conditioned_inpaint: definition(
    "pose_conditioned_inpaint",
    "Inpaint with pose condition",
    "unsupported",
    [
      { name: "productLockArtifactId", type: "string", required: true, description: "Locked product reference artifact." },
      { name: "poseArtifactId", type: "string", required: true, description: "OpenPose or equivalent pose artifact." },
      { name: "prompt", type: "string", required: true, description: "Inpaint instruction." },
    ],
    [{ name: "poseConditionedImage", kind: "image", required: true, description: "Pose-conditioned inpaint result." }],
    UNSUPPORTED_GATE_CONTRACTS,
    [...UNSUPPORTED.pose_conditioned_inpaint],
    { workflowId: "ecommerce.pose_conditioned_inpaint", nodeType: "image", metadataKeys: ["productLockArtifactId", "poseArtifactId", "maskArtifactId", "unsupported"] },
  ),
  detail_page_manifest: definition(
    "detail_page_manifest",
    "Build detail page manifest",
    "artifact_only",
    [
      { name: "productLockArtifactId", type: "string", required: true, description: "Locked product reference artifact." },
      { name: "deliverables", type: "string[]", required: true, description: "Ordered detail-page deliverable roles." },
    ],
    [{ name: "detailPageManifest", kind: "manifest", required: true, description: "Ordered manifest linking product and requested deliverables." }],
    [{ id: "input_validated", description: "Product lock and deliverables are present.", blocking: true }, { id: "history_linked", description: "Manifest is saved through the existing history/artifact owner.", blocking: false }],
    [],
    { workflowId: "ecommerce.detail_page_manifest", nodeType: "config", metadataKeys: ["productLockArtifactId", "deliverables", "manifestVersion"] },
  ),
  aspect_reflow: definition(
    "aspect_reflow",
    "Reflow product composition",
    "unsupported",
    [
      { name: "sourceArtifactId", type: "string", required: true, description: "Existing source image artifact." },
      { name: "targetAspectRatio", type: "string", required: true, description: "Requested target aspect ratio." },
    ],
    [{ name: "reflowedImage", kind: "image", required: true, description: "Layout-aware reflowed image." }],
    UNSUPPORTED_GATE_CONTRACTS,
    [...UNSUPPORTED.aspect_reflow],
    { workflowId: "ecommerce.aspect_reflow", nodeType: "image", metadataKeys: ["sourceArtifactId", "targetAspectRatio", "layoutAudit", "unsupported"] },
  ),
  upscale_audit: definition(
    "upscale_audit",
    "Upscale and audit details",
    "unsupported",
    [
      { name: "sourceArtifactId", type: "string", required: true, description: "Existing source image artifact." },
      { name: "targetResolution", type: "string", required: true, description: "Requested output resolution." },
    ],
    [{ name: "upscaledImage", kind: "image", required: true, description: "Upscaled image artifact." }, { name: "detailAudit", kind: "audit", required: true, description: "VLM detail audit report." }],
    UNSUPPORTED_GATE_CONTRACTS,
    [...UNSUPPORTED.upscale_audit],
    { workflowId: "ecommerce.upscale_audit", nodeType: "audit", metadataKeys: ["sourceArtifactId", "targetResolution", "vlmAudit", "unsupported"] },
  ),
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

function validateInput(definition: EcommerceToolDefinition, input: Record<string, unknown>): EcommerceInputIssue[] {
  return definition.inputs.flatMap<EcommerceInputIssue>((field) => {
    const value = input[field.name];
    if (field.required && (value === undefined || value === null || value === "")) {
      return [{ param: field.name, code: "missing" as const, message: `${field.name} is required.` }];
    }
    if (value === undefined || value === null) return [];
    const valid = field.type === "string" ? isNonEmptyString(value)
      : field.type === "url" ? isNonEmptyString(value) && /^https?:\/\//.test(value)
      : field.type === "string[]" ? isStringArray(value)
      : typeof value === "number" && Number.isInteger(value);
    return valid ? [] : [{ param: field.name, code: "invalid" as const, message: `${field.name} has an invalid value.` }];
  });
}

function basePlan(definition: EcommerceToolDefinition, status: EcommercePlanStatus, issues: EcommerceToolPlan["issues"] = []): EcommerceToolPlan {
  const unsupported = [...definition.unsupported];
  const gates: EcommerceGateDecision[] = definition.gates.map((gate) => ({
    id: gate.id,
    state: status === "unsupported" ? "unsupported" : issues.length ? "fail" : gate.id === "input_validated" ? "pass" : "pending",
    detail: status === "unsupported" ? unsupported.join(" ") : gate.description,
  }));
  return {
    tool: definition.id,
    status,
    issues,
    unsupported,
    gates,
    artifacts: { inputs: [], outputs: [] },
    canvas: { workflowId: definition.canvas.workflowId, nodeType: definition.canvas.nodeType, nodeMetadata: { ecommerceTool: definition.id } },
  };
}

function productReference(productLockArtifactId: string, productReferenceUrl: string) {
  return {
    artifactId: productLockArtifactId,
    url: productReferenceUrl,
    mimeType: "image/*",
    referenceRole: "product" as const,
  };
}

function mappedGeneration(input: Record<string, unknown>, tool: "product_conditioned_generation" | "scene_pack_batch", prompt: string, batchIndex?: number, batchTotal?: number): EcommerceGenerationMapping {
  const productLockArtifactId = String(input.productLockArtifactId);
  const modelId = String(input.modelId);
  const ratio = String(input.aspectRatio);
  const workflow = {
    references: [productReference(productLockArtifactId, String(input.productReferenceUrl))],
    metadata: {
      ecommerceTool: tool,
      productLockArtifactId,
      referenceRole: "product",
      ...(batchIndex !== undefined ? { batchIndex } : {}),
      ...(batchTotal !== undefined ? { batchTotal } : {}),
    },
  };
  const command = {
    kind: "image_generate" as const,
    modelId,
    prompt,
    ratio,
    requestedCount: 1,
    responseFormat: "url" as const,
    workflow,
  };
  return { owner: "generation-core", command, ...command };
}

export function buildEcommerceToolPlan(request: { tool: EcommerceToolId; input: Record<string, unknown> }): EcommerceToolPlan {
  const definition = ECOMMERCE_PRODUCT_TOOLS[request.tool];
  const issues = validateInput(definition, request.input);
  if (definition.support === "unsupported") return basePlan(definition, "unsupported", issues);
  if (issues.length) return basePlan(definition, "invalid", issues);

  const plan = basePlan(definition, "ready");
  const input = request.input;

  if (request.tool === "product_lock") {
    const productArtifactId = String(input.productArtifactId);
    plan.artifacts.outputs.push({
      artifactId: `product-lock:${productArtifactId}`,
      kind: "json",
      mimeType: "application/json",
      metadata: { productArtifactId, productImageUrl: String(input.productImageUrl), productName: String(input.productName), referenceRole: "product", locked: true },
    });
    plan.canvas.nodeMetadata = { ecommerceTool: request.tool, productArtifactId, productName: String(input.productName), referenceRole: "product", locked: true };
    plan.gates = plan.gates.map((gate) => gate.id === "artifact_owned" ? { ...gate, state: "pending" } : gate);
    return plan;
  }

  if (request.tool === "detail_page_manifest") {
    const deliverables = (input.deliverables as string[]).map((item) => item.trim());
    plan.artifacts.inputs.push({ artifactId: String(input.productLockArtifactId), kind: "json" });
    plan.artifacts.outputs.push({
      artifactId: `detail-page-manifest:${String(input.productLockArtifactId)}`,
      kind: "manifest",
      mimeType: "application/json",
      metadata: { productLockArtifactId: String(input.productLockArtifactId), deliverables, manifestVersion: 1 },
    });
    plan.canvas.nodeMetadata = { ecommerceTool: request.tool, productLockArtifactId: String(input.productLockArtifactId), deliverables, manifestVersion: 1 };
    return plan;
  }

  if (request.tool === "product_conditioned_generation") {
    plan.artifacts.inputs.push({ artifactId: String(input.productLockArtifactId), kind: "json" });
    plan.generation = mappedGeneration(input, request.tool, String(input.prompt));
    plan.canvas.nodeMetadata = { ecommerceTool: request.tool, productLockArtifactId: String(input.productLockArtifactId), referenceRole: "product", prompt: String(input.prompt), modelId: String(input.modelId) };
    return plan;
  }

  if (request.tool === "scene_pack_batch") {
    const scenes = input.scenes as string[];
    plan.artifacts.inputs.push({ artifactId: String(input.productLockArtifactId), kind: "json" });
    plan.generationBatch = { owner: "generation-core", commands: scenes.map((scene, index) => mappedGeneration(input, "scene_pack_batch", scene, index, scenes.length)) };
    plan.canvas.nodeMetadata = { ecommerceTool: request.tool, productLockArtifactId: String(input.productLockArtifactId), batchTotal: scenes.length, referenceRole: "product" };
    return plan;
  }

  return plan;
}

export const ECOMMERCE_PRODUCT_SKILL = {
  id: "ecommerce-product-launch",
  domain: "ecommerce",
  version: 1,
  tools: ECOMMERCE_TOOL_IDS,
  sourceEvidence: ECOMMERCE_UPSTREAM_SOURCES,
  invariant: "Never claim a product artifact, generation, edit, reflow, upscale, or audit succeeded without an owner result artifact and its gate evidence.",
  owners: OWNERSHIP,
} as const;
