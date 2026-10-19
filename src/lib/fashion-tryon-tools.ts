/**
 * Fashion flat-lay -> model seeding domain.
 *
 * This module is a declaration layer. It does not turn a prompt into a claim
 * that a segmentation, identity, try-on, hand-repair, or layout model exists.
 * Only the batch tool maps to capabilities already owned by this workspace.
 */

export const FASHION_TOOL_IDS = [
  "garment_extract",
  "garment_dna_lock",
  "model_identity_lock",
  "virtual_tryon",
  "hand_contact_repair",
  "shot_grid_batch",
  "detail_page_evidence_map",
  "platform_reflow",
] as const;

export type FashionToolId = (typeof FASHION_TOOL_IDS)[number];
export type FashionToolAvailability = "available" | "unsupported";
export type FashionFieldType = "image" | "image[]" | "string" | "string[]" | "number" | "enum" | "object";

export interface FashionToolField {
  name: string;
  type: FashionFieldType;
  required: boolean;
  description: string;
  enum?: readonly string[];
}

export interface FashionToolPort {
  fields: readonly FashionToolField[];
  description: string;
}

export interface FashionGate {
  id: string;
  description: string;
  blocking: boolean;
}

export interface UnsupportedCapability {
  reason: string;
  requiredCapability: string;
  notReplacedByPrompt: true;
}

export type FashionCanvasNodeKind = "reference" | "image" | "group" | "config" | "text";
export type FashionArtifactStatus = "ready" | "blocked" | "pending" | "succeeded";

/** Domain metadata carried alongside an existing Canvas node; no shared contract changes. */
export interface FashionCanvasArtifactMetadata {
  artifactKind: "fashion_tryon";
  artifactId: string;
  toolId: FashionToolId;
  nodeKind: FashionCanvasNodeKind;
  title: string;
  status: FashionArtifactStatus;
  workflowId: string;
  inputRoles: readonly string[];
  outputRoles: readonly string[];
  gateIds: readonly string[];
  lineage: {
    sourceArtifactIds: readonly string[];
    sourceAssetRoles: readonly string[];
  };
  blockedReason?: string;
  requiredCapabilities?: readonly string[];
}

export interface FashionToolDefinition {
  id: FashionToolId;
  label: string;
  availability: FashionToolAvailability;
  owner: "fashion-domain";
  input: FashionToolPort;
  output: FashionToolPort;
  gates: readonly FashionGate[];
  unsupported: UnsupportedCapability | null;
  canvasArtifact: {
    nodeKind: FashionCanvasNodeKind;
    artifactRole: string;
    metadataFields: readonly string[];
  };
  upstreamEvidence: readonly string[];
}

export interface FashionShotGridInput {
  garmentImage: string;
  modelImages: readonly string[];
  shotTypes: readonly string[];
  model: string;
  size: "1024x1024" | "1536x1024" | "1024x1536";
  countPerShot?: number;
  workflowId?: string;
}

export interface FashionShotGridTask {
  index: number;
  shotType: string;
  prompt: string;
  model: string;
  size: FashionShotGridInput["size"];
  count: number;
  referenceImages: readonly string[];
  artifact: FashionCanvasArtifactMetadata;
}

const COMMON_GATES: readonly FashionGate[] = [
  {
    id: "input.images_resolvable",
    description: "All referenced image URLs or media IDs must resolve before submission.",
    blocking: true,
  },
  {
    id: "artifact.lineage_present",
    description: "Every output must retain source asset roles and a stable workflow ID.",
    blocking: true,
  },
];

const SOURCE = {
  catVton: "https://github.com/Zheng-Chong/CatVTON",
  idmVton: "https://github.com/yisol/IDM-VTON",
  biRefNet: "https://github.com/ZhengPeng7/BiRefNet",
  controlNetOpenPose: "https://github.com/lllyasviel/ControlNet",
  ipAdapter: "https://github.com/tencent-ailab/IP-Adapter",
  ipAdapterFaceId: "https://github.com/cubiq/ComfyUI_IPAdapter_plus",
  meshGraphormer: "https://github.com/microsoft/MeshGraphormer",
  generationBatch: "src/lib/generation-core/batch-service.ts",
  canvasBatch: "src/lib/canvas/batch-utils.ts",
  canvasContract: "src/lib/canvas/types.ts (read-only integration boundary)",
  imageEdit: "src/app/api/canvas/generate/route.ts (existing image edit/reference route)",
} as const;

const unsupported = (
  reason: string,
  requiredCapability: string,
): UnsupportedCapability => ({ reason, requiredCapability, notReplacedByPrompt: true });

const fields = (
  description: string,
  values: readonly FashionToolField[],
): FashionToolPort => ({ description, fields: values });

const image = (name: string, required: boolean, description: string): FashionToolField => ({
  name,
  type: "image",
  required,
  description,
});

const images = (name: string, required: boolean, description: string): FashionToolField => ({
  name,
  type: "image[]",
  required,
  description,
});

const text = (name: string, required: boolean, description: string): FashionToolField => ({
  name,
  type: "string",
  required,
  description,
});

const numberField = (name: string, required: boolean, description: string): FashionToolField => ({
  name,
  type: "number",
  required,
  description,
});

const enumField = (name: string, required: boolean, description: string, values: readonly string[]): FashionToolField => ({
  name,
  type: "enum",
  required,
  description,
  enum: values,
});

const tool = (
  definition: Omit<FashionToolDefinition, "owner">,
): FashionToolDefinition => ({ ...definition, owner: "fashion-domain" });

export const FASHION_TRYON_TOOLS: readonly FashionToolDefinition[] = [
  tool({
    id: "garment_extract",
    label: "Extract garment from flat-lay",
    availability: "unsupported",
    input: fields("Flat-lay garment image and optional crop guidance.", [
      image("garmentImage", true, "A flat-lay garment image."),
      text("cropHint", false, "Optional crop or region hint; not a segmentation mask."),
    ]),
    output: fields("A garment cutout and mask with measurable edge evidence.", [
      image("garmentCutout", true, "RGBA garment cutout."),
      image("garmentMask", true, "Binary or soft alpha mask."),
      text("maskQuality", true, "Mask quality evidence and dimensions."),
    ]),
    gates: [
      ...COMMON_GATES,
      { id: "garment.mask_valid", description: "Mask must be non-empty, bounded, and match the source dimensions.", blocking: true },
    ],
    unsupported: unsupported(
      "No BiRefNet/rembg or other segmentation/matting adapter is wired into this workspace.",
      "A production segmentation or matting upstream such as BiRefNet, with checkpoint loading and mask artifact persistence.",
    ),
    canvasArtifact: { nodeKind: "reference", artifactRole: "garment_source_or_cutout", metadataFields: ["artifactKind", "artifactId", "toolId", "status", "lineage", "blockedReason"] },
    upstreamEvidence: [SOURCE.biRefNet],
  }),
  tool({
    id: "garment_dna_lock",
    label: "Lock garment DNA",
    availability: "unsupported",
    input: fields("Garment source plus an extracted garment mask or cutout.", [
      image("garmentImage", true, "Garment source or cutout."),
      image("garmentMask", true, "Verified garment mask."),
      images("detailReferences", false, "Close-ups for texture, logo, seams, and hardware."),
    ]),
    output: fields("A machine-verifiable garment identity package.", [
      text("garmentDnaId", true, "Stable identity record ID."),
      image("identityAtlas", true, "Reference atlas for garment identity."),
      text("invariants", true, "Measured color, logo, seam, texture, and proportion invariants."),
    ]),
    gates: [
      ...COMMON_GATES,
      { id: "garment.mask_verified", description: "A segmentation/matting result must be verified before locking identity.", blocking: true },
      { id: "garment.invariants_measured", description: "Identity invariants must be measured or sourced from an upstream encoder.", blocking: true },
    ],
    unsupported: unsupported(
      "The current reference-image path can pass images to generation but cannot compute or enforce a garment identity lock.",
      "A garment identity encoder/atlas plus masked edit or try-on execution that reports identity evidence.",
    ),
    canvasArtifact: { nodeKind: "config", artifactRole: "garment_dna_record", metadataFields: ["artifactKind", "artifactId", "toolId", "status", "workflowId", "lineage", "requiredCapabilities"] },
    upstreamEvidence: [SOURCE.catVton, SOURCE.idmVton, SOURCE.biRefNet],
  }),
  tool({
    id: "model_identity_lock",
    label: "Lock model identity",
    availability: "unsupported",
    input: fields("A model reference set and requested shot pose.", [
      images("modelReferences", true, "Reference images of the same model."),
      text("identityLabel", true, "Human-readable identity label."),
      text("poseIntent", false, "Requested pose or shot intent."),
    ]),
    output: fields("An identity embedding/anchor usable by a downstream generator.", [
      text("identityLockId", true, "Stable identity lock ID."),
      image("identityAtlas", true, "Identity reference atlas."),
      text("embeddingProvider", true, "Provider and checkpoint used to create the embedding."),
    ]),
    gates: [
      ...COMMON_GATES,
      { id: "identity.reference_consistent", description: "References must belong to one accepted identity set.", blocking: true },
      { id: "identity.embedding_verified", description: "An embedding provider must return a verifiable identity artifact.", blocking: true },
    ],
    unsupported: unsupported(
      "No IP-Adapter FaceID/InsightFace or identity-embedding adapter is integrated with the current generation scheduler.",
      "IP-Adapter FaceID or equivalent identity encoder, required model/LoRA weights, and scheduler wiring that consumes the embedding.",
    ),
    canvasArtifact: { nodeKind: "reference", artifactRole: "model_identity_record", metadataFields: ["artifactKind", "artifactId", "toolId", "status", "lineage", "requiredCapabilities"] },
    upstreamEvidence: [SOURCE.ipAdapter, SOURCE.ipAdapterFaceId],
  }),
  tool({
    id: "virtual_tryon",
    label: "Virtual try-on",
    availability: "unsupported",
    input: fields("Person and garment images plus masks/pose where required by the model.", [
      image("personImage", true, "Target model image."),
      image("garmentImage", true, "Garment image or cutout."),
      image("garmentMask", false, "Garment mask when required by the selected upstream."),
      image("personMask", false, "Person/agnostic mask when required by the selected upstream."),
      text("poseData", false, "Pose or dense-pose artifact from an actual detector."),
    ]),
    output: fields("A rendered try-on image with source lineage and provider evidence.", [
      image("tryOnImage", true, "Rendered person wearing the garment."),
      text("provider", true, "Actual VTON provider and checkpoint."),
      text("qualityEvidence", true, "Provider output and validation evidence."),
    ]),
    gates: [
      ...COMMON_GATES,
      { id: "tryon.inputs_complete", description: "Person, garment, and all upstream-required masks/pose artifacts are present.", blocking: true },
      { id: "tryon.provider_verified", description: "A real VTON provider must accept the request and return an artifact.", blocking: true },
    ],
    unsupported: unsupported(
      "CatVTON and IDM-VTON are research repositories, not integrated suppliers in this workspace; generic image editing is not virtual try-on execution.",
      "A deployed CatVTON or IDM-VTON inference adapter, checkpoint/runtime, person/garment preprocessing, and generation-worker routing.",
    ),
    canvasArtifact: { nodeKind: "image", artifactRole: "virtual_tryon_result", metadataFields: ["artifactKind", "artifactId", "toolId", "status", "workflowId", "lineage", "blockedReason"] },
    upstreamEvidence: [SOURCE.catVton, SOURCE.idmVton],
  }),
  tool({
    id: "hand_contact_repair",
    label: "Repair hand/garment contact",
    availability: "unsupported",
    input: fields("A try-on render and a localized contact region.", [
      image("tryOnImage", true, "Rendered try-on image."),
      image("contactMask", true, "Hand/garment contact region mask."),
      text("repairPolicy", true, "Allowed repair scope and preservation constraints."),
    ]),
    output: fields("A localized repair result with before/after evidence.", [
      image("repairedImage", true, "Repaired render."),
      image("repairRegion", true, "Localized repaired crop or mask."),
      text("repairEvidence", true, "Evidence that only the requested region changed."),
    ]),
    gates: [
      ...COMMON_GATES,
      { id: "hands.region_verified", description: "The repair region must be explicitly localized before editing.", blocking: true },
      { id: "hands.anatomy_verified", description: "A hand/mesh or equivalent anatomy verifier must approve the result.", blocking: true },
    ],
    unsupported: unsupported(
      "No MeshGraphormer/MANO hand mesh or localized hand inpainting/repair upstream is connected to image editing.",
      "Hand/body mesh estimation plus localized inpainting or repair model with before/after region verification.",
    ),
    canvasArtifact: { nodeKind: "image", artifactRole: "hand_contact_repair_result", metadataFields: ["artifactKind", "artifactId", "toolId", "status", "lineage", "requiredCapabilities"] },
    upstreamEvidence: [SOURCE.meshGraphormer, SOURCE.controlNetOpenPose],
  }),
  tool({
    id: "shot_grid_batch",
    label: "Batch shot grid",
    availability: "available",
    input: fields("A garment reference, model references, and a finite shot list for existing image generation.", [
      image("garmentImage", true, "Garment reference image."),
      images("modelImages", true, "Model reference images passed through the existing reference-image path."),
      text("shotTypes", true, "Comma-separated or structured shot list."),
      text("model", true, "Existing catalog model ID."),
      enumField("size", true, "Existing supported image size.", ["1024x1024", "1536x1024", "1024x1536"]),
      numberField("countPerShot", false, "Number of variants per shot, bounded by the existing batch contract."),
    ]),
    output: fields("A batch plan whose tasks use the existing generation queue and Canvas batch artifacts.", [
      text("batchId", true, "Existing generation batch ID after submission."),
      images("resultImages", true, "Generated result URLs or media IDs."),
      text("partialFailureReport", true, "Per-item status and failure evidence."),
    ]),
    gates: [
      ...COMMON_GATES,
      { id: "shots.catalog_model_supported", description: "The selected model and size must pass the existing generation catalog and API validation.", blocking: true },
      { id: "shots.batch_contract", description: "The plan must obey the existing batch item/count limits and idempotency path.", blocking: true },
      { id: "shots.no_identity_claim", description: "Reference images may be passed through, but the result must not claim garment or model identity lock.", blocking: true },
    ],
    unsupported: null,
    canvasArtifact: { nodeKind: "group", artifactRole: "shot_grid_batch", metadataFields: ["artifactKind", "artifactId", "toolId", "status", "workflowId", "lineage", "gateIds"] },
    upstreamEvidence: [SOURCE.generationBatch, SOURCE.canvasBatch, SOURCE.canvasContract, SOURCE.imageEdit],
  }),
  tool({
    id: "detail_page_evidence_map",
    label: "Map detail-page evidence",
    availability: "unsupported",
    input: fields("Product images and a detail-page evidence specification.", [
      images("productImages", true, "Product, material, construction, and fit images."),
      text("evidenceSpec", true, "Claims and required visual proof regions."),
      text("platform", false, "Target commerce platform."),
    ]),
    output: fields("A structured evidence map tied to image regions and claims.", [
      text("evidenceMapId", true, "Stable evidence map ID."),
      text("claimRegionLinks", true, "Claim-to-region links with coordinates and confidence."),
      text("missingEvidence", true, "Claims without sufficient visual proof."),
    ]),
    gates: [
      ...COMMON_GATES,
      { id: "evidence.region_grounded", description: "Every claim must link to a measured image region, not generated prose alone.", blocking: true },
      { id: "evidence.coverage_report", description: "Missing or ambiguous proof must be reported before page assembly.", blocking: true },
    ],
    unsupported: unsupported(
      "No OCR, region detector, claim-to-image evidence mapper, or deterministic detail-page assembler is integrated.",
      "Visual region detection/OCR plus an evidence-map store and renderer that links each claim to source pixels.",
    ),
    canvasArtifact: { nodeKind: "group", artifactRole: "detail_page_evidence_map", metadataFields: ["artifactKind", "artifactId", "toolId", "status", "workflowId", "lineage", "requiredCapabilities"] },
    upstreamEvidence: [SOURCE.canvasContract],
  }),
  tool({
    id: "platform_reflow",
    label: "Reflow for commerce platforms",
    availability: "unsupported",
    input: fields("An approved asset set and target platform constraints.", [
      images("approvedAssets", true, "Assets that passed upstream review."),
      text("platform", true, "Target platform identifier."),
      text("templateId", true, "Deterministic platform template identifier."),
      text("copy", false, "Copy to fit into declared template regions."),
    ]),
    output: fields("Platform-specific exports with safe-area and overflow evidence.", [
      images("exports", true, "Rendered platform exports."),
      text("layoutReport", true, "Dimensions, safe areas, overflow, and missing-field report."),
      text("reflowBatchId", true, "Stable reflow job ID."),
    ]),
    gates: [
      ...COMMON_GATES,
      { id: "layout.template_known", description: "The platform template and export constraints must be machine-readable.", blocking: true },
      { id: "layout.overflow_checked", description: "Text, logos, and product regions must pass safe-area and overflow checks.", blocking: true },
    ],
    unsupported: unsupported(
      "Current generation and Canvas capabilities can request image sizes but do not implement platform templates, copy fitting, safe areas, or export validation.",
      "A deterministic platform-template renderer with safe-area rules, text fitting, export formats, and validation artifacts.",
    ),
    canvasArtifact: { nodeKind: "group", artifactRole: "platform_reflow_exports", metadataFields: ["artifactKind", "artifactId", "toolId", "status", "workflowId", "lineage", "requiredCapabilities"] },
    upstreamEvidence: [SOURCE.canvasContract, SOURCE.generationBatch],
  }),
] as const;

const TOOL_BY_ID = new Map(FASHION_TRYON_TOOLS.map((definition) => [definition.id, definition]));

export const FASHION_UPSTREAM_SOURCES = [
  SOURCE.catVton,
  SOURCE.idmVton,
  SOURCE.biRefNet,
  SOURCE.controlNetOpenPose,
  SOURCE.ipAdapter,
  SOURCE.ipAdapterFaceId,
  SOURCE.meshGraphormer,
] as const;

export function getFashionToolDefinition(toolId: FashionToolId): FashionToolDefinition {
  const definition = TOOL_BY_ID.get(toolId);
  if (!definition) throw new Error(`Unknown fashion tool: ${toolId}`);
  return definition;
}

export function isFashionToolAvailable(toolId: FashionToolId): boolean {
  return getFashionToolDefinition(toolId).availability === "available";
}

export function buildFashionCanvasArtifact(
  toolId: FashionToolId,
  input: { artifactId: string; workflowId: string; sourceArtifactIds?: readonly string[]; sourceAssetRoles?: readonly string[] },
): FashionCanvasArtifactMetadata {
  const definition = getFashionToolDefinition(toolId);
  const blocked = definition.unsupported;
  return {
    artifactKind: "fashion_tryon",
    artifactId: input.artifactId,
    toolId,
    nodeKind: definition.canvasArtifact.nodeKind,
    title: definition.label,
    status: blocked ? "blocked" : "ready",
    workflowId: input.workflowId,
    inputRoles: definition.input.fields.filter((field) => field.required).map((field) => field.name),
    outputRoles: definition.output.fields.map((field) => field.name),
    gateIds: definition.gates.map((gate) => gate.id),
    lineage: {
      sourceArtifactIds: input.sourceArtifactIds ?? [],
      sourceAssetRoles: input.sourceAssetRoles ?? [],
    },
    ...(blocked
      ? {
          blockedReason: blocked.reason,
          requiredCapabilities: [blocked.requiredCapability],
        }
      : {}),
  };
}

function assertNonEmpty(value: string, field: string): void {
  if (!value.trim()) throw new Error(`${field} is required`);
}

export function buildShotGridBatchPlan(input: FashionShotGridInput): FashionShotGridTask[] {
  assertNonEmpty(input.garmentImage, "garmentImage");
  assertNonEmpty(input.model, "model");
  if (input.modelImages.length === 0) throw new Error("modelImages is required");
  if (input.shotTypes.length === 0) throw new Error("shotTypes is required");
  const count = input.countPerShot ?? 1;
  if (!Number.isInteger(count) || count < 1 || count > 4) throw new Error("countPerShot must be an integer from 1 to 4");

  const workflowId = input.workflowId?.trim() || `fashion-shot-grid-${Date.now()}`;
  return input.shotTypes.map((shotType, index) => {
    assertNonEmpty(shotType, `shotTypes[${index}]`);
    const artifact = buildFashionCanvasArtifact("shot_grid_batch", {
      artifactId: `${workflowId}-shot-${index + 1}`,
      workflowId,
      sourceAssetRoles: ["garment_reference", "model_reference"],
    });
    return {
      index,
      shotType,
      prompt: `Create a ${shotType} fashion commerce shot using the supplied garment and model references. Preserve references as inputs; do not claim identity or garment locking.`,
      model: input.model,
      size: input.size,
      count,
      referenceImages: [input.garmentImage, ...input.modelImages],
      artifact,
    };
  });
}
