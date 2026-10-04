/**
 * Art workflow domain contracts.
 *
 * This registry is deliberately separate from the shared agent/generation contracts.
 * It describes orchestration intent and honest capability boundaries; it does not
 * implement StyleAligned, LoRA training, CLIP, or VLM inference.
 */

export type ArtWorkflowId = "curatorial-creation" | "style-deep-research";
export type ArtToolSupport = "supported" | "conditional" | "unsupported";
export type ArtToolId =
  | "moodboard_diverge_converge"
  | "style_dna_extract"
  | "canonical_key_art_lock"
  | "sketch_lock"
  | "style_aligned_batch"
  | "outlier_audit_regenerate"
  | "style_lora_train_optional"
  | "exhibition_delivery_manifest";

export type ArtFieldType = "string" | "string[]" | "number" | "boolean" | "object";

export interface ArtFieldSpec {
  type: ArtFieldType;
  required: boolean;
  description: string;
  default?: string | number | boolean;
}

export interface ArtGateSpec {
  id: string;
  criterion: string;
  blocking: boolean;
}

export interface ArtCanvasMetadataSpec {
  nodeType: "prompt" | "reference" | "image" | "config" | "group" | "text";
  fields: string[];
  requiredRelations: string[];
}

export interface ArtToolDefinition {
  id: ArtToolId;
  workflow: ArtWorkflowId;
  label: string;
  support: ArtToolSupport;
  summary: string;
  input: Record<string, ArtFieldSpec>;
  output: Record<string, ArtFieldSpec>;
  gates: ArtGateSpec[];
  unsupported: string[];
  canvas: ArtCanvasMetadataSpec;
  upstream: string[];
}

export interface ArtWorkflowDefinition {
  id: ArtWorkflowId;
  label: string;
  purpose: string;
  toolOrder: ArtToolId[];
  handoff: string;
}

/** Existing owners discovered in this checkout; art tools compose these instead of replacing them. */
export const ART_EXISTING_TOOL_INVENTORY = [
  { id: "generate_image", owner: "src/lib/agent-tool-contract.ts", capability: "generation queue submission" },
  { id: "canvas_apply_ops", owner: "src/lib/agent-tool-contract.ts", capability: "Canvas node/connection operations" },
  { id: "reference_image_upload", owner: "src/components/ReferenceImageUpload.tsx", capability: "reference asset intake" },
  { id: "canvas_reference_nodes", owner: "src/lib/canvas/semantic-nodes.ts", capability: "reference role and generation input resolution" },
  { id: "canvas_metadata", owner: "src/lib/canvas/types.ts", capability: "workflow, asset, status and provenance metadata" },
  { id: "generation_jobs", owner: "src/app/api/generation-jobs/route.ts", capability: "async generation job validation and submission" },
] as const;

const imageInput: ArtFieldSpec = {
  type: "string[]",
  required: true,
  description: "已存在的图片资产 URL 或 Canvas image/reference node id；不可用文字冒充图片。",
};

const textInput: ArtFieldSpec = {
  type: "string",
  required: true,
  description: "创作意图或研究问题。",
};

const noUpstream = (reason: string): string[] => [reason, "未提供可执行 adapter；不得以 prompt 拼接、人工分数或假 taskId 代替。"];

export const ART_TOOL_DEFINITIONS: readonly ArtToolDefinition[] = [
  {
    id: "moodboard_diverge_converge",
    workflow: "curatorial-creation",
    label: "情绪板发散与收敛",
    support: "supported",
    summary: "从参考资产建立可追溯的发散候选，再由使用者收敛成方向包。",
    input: {
      brief: textInput,
      referenceImages: { ...imageInput, required: false, description: "可选的参考图片资产。" },
      candidateCount: { type: "number", required: false, description: "候选数，限制 3-12。", default: 6 },
    },
    output: {
      candidates: { type: "object", required: true, description: "候选卡：assetId、prompt、palette、compositionNotes。" },
      selectedDirection: { type: "object", required: true, description: "使用者选定的方向与排除理由。" },
    },
    gates: [
      { id: "moodboard-input", criterion: "至少有 brief；每个引用都能解析为真实 image/reference asset。", blocking: true },
      { id: "moodboard-convergence", criterion: "输出包含一个明确 selectedDirection，未选定不得进入 key art。", blocking: true },
    ],
    unsupported: [],
    canvas: { nodeType: "group", fields: ["workflow_id", "candidateAssetIds", "selectedDirection", "status"], requiredRelations: ["candidate image nodes -> moodboard group"] },
    upstream: ["existing generation queue", "existing Canvas image/reference nodes"],
  },
  {
    id: "style_dna_extract",
    workflow: "style-deep-research",
    label: "风格 DNA 提取",
    support: "conditional",
    summary: "把已选参考图整理成可人工核准的风格 DNA 结构，不宣称由 VLM/CLIP 自动推论。",
    input: {
      referenceImages: imageInput,
      styleQuestions: { type: "string[]", required: false, description: "要核对的材质、色彩、构图、光线栏位。" },
    },
    output: {
      styleDna: { type: "object", required: true, description: "可编辑的 style DNA 草稿与 evidence asset ids。" },
      evidence: { type: "object", required: true, description: "每个栏位对应的参考资产与人工注记。" },
    },
    gates: [
      { id: "style-dna-evidence", criterion: "每个 DNA 栏位都指向至少一个 reference asset 或标记 needs_review。", blocking: true },
      { id: "style-dna-approval", criterion: "使用者核准 DNA 草稿后才可锁定 key art。", blocking: true },
    ],
    unsupported: ["未接 VLM/CLIP embedding 或 image caption upstream；本工具只做结构化与人工核准。"],
    canvas: { nodeType: "config", fields: ["workflow_id", "styleDna", "evidenceAssetIds", "approvalStatus"], requiredRelations: ["config -> reference image nodes"] },
    upstream: noUpstream("VLM/CLIP image understanding adapter 尚未接入"),
  },
  {
    id: "canonical_key_art_lock",
    workflow: "curatorial-creation",
    label: "主视觉锁定",
    support: "supported",
    summary: "以已核准方向与 style DNA 生成一张 canonical key art，并把它标成不可悄悄替换的风格锚。",
    input: {
      approvedDirection: { type: "object", required: true, description: "已通过 moodboard convergence 的方向包。" },
      styleDna: { type: "object", required: true, description: "已核准的风格 DNA。" },
      size: { type: "string", required: true, description: "主视觉输出尺寸。" },
    },
    output: {
      keyArtAsset: { type: "object", required: true, description: "生成结果、generation id、prompt snapshot。" },
      lockRecord: { type: "object", required: true, description: "canonical asset id、版本、核准状态。" },
    },
    gates: [
      { id: "key-art-brief", criterion: "方向、DNA、尺寸均已存在且可回溯。", blocking: true },
      { id: "key-art-approval", criterion: "使用者核准结果后才可作为后续批次 style reference。", blocking: true },
    ],
    unsupported: [],
    canvas: { nodeType: "image", fields: ["workflow_id", "canonicalKeyArt", "locked", "prompt", "model", "size", "status"], requiredRelations: ["key art image -> style DNA config", "key art image -> selected direction"] },
    upstream: ["existing generation queue", "existing Canvas metadata"],
  },
  {
    id: "sketch_lock",
    workflow: "curatorial-creation",
    label: "草图构图锁定",
    support: "supported",
    summary: "先保存黑白构图与镜头栏位，再允许彩色/高成本生成沿用同一构图决策。",
    input: {
      compositionBrief: textInput,
      canonicalKeyArt: { type: "string", required: false, description: "可选 canonical key art asset id。" },
      sketchAsset: { type: "string", required: false, description: "已上传的草图 asset id；未提供时可走生成 queue。" },
    },
    output: {
      sketchAsset: { type: "object", required: true, description: "草图 asset 与 composition lock 栏位。" },
      shotSpec: { type: "object", required: true, description: "景别、机位、运镜、比例。" },
    },
    gates: [
      { id: "sketch-composition", criterion: "草图存在且 shotSpec 完整；不得用 final render 反推草图。", blocking: true },
      { id: "sketch-approval", criterion: "构图经使用者锁定后才可出最终批次。", blocking: true },
    ],
    unsupported: [],
    canvas: { nodeType: "image", fields: ["workflow_id", "sketchLock", "shot_size", "camera_move", "locked", "status"], requiredRelations: ["sketch image -> prompt/config node"] },
    upstream: ["existing generation queue", "existing Canvas metadata"],
  },
  {
    id: "style_aligned_batch",
    workflow: "style-deep-research",
    label: "风格对齐批次",
    support: "unsupported",
    summary: "预留 StyleAligned attention-sharing 批次边界；上游未接入时阻断，不退化成 prompt 拼接。",
    input: {
      canonicalKeyArt: { type: "string", required: true, description: "canonical key art asset id。" },
      batchPrompts: { type: "string[]", required: true, description: "批次内容 prompt；每项需保留 subject delta。" },
      count: { type: "number", required: true, description: "批次数量，限制 1-32。" },
    },
    output: {
      batchJob: { type: "object", required: true, description: "只有在 StyleAligned adapter 可用时才可产生的 batch job。" },
    },
    gates: [
      { id: "style-aligned-upstream", criterion: "StyleAligned attention-sharing adapter health=ready 且回传真实 batch id。", blocking: true },
      { id: "style-aligned-anchor", criterion: "canonical key art 与每项 prompt 均可回溯。", blocking: true },
    ],
    unsupported: noUpstream("StyleAligned attention-sharing upstream 未接入"),
    canvas: { nodeType: "group", fields: ["workflow_id", "styleAlignedAdapter", "canonicalKeyArt", "batchJobId", "status"], requiredRelations: ["batch group -> canonical key art", "batch result images -> batch group"] },
    upstream: ["Google StyleAligned research implementation (not installed)", "no local adapter"],
  },
  {
    id: "outlier_audit_regenerate",
    workflow: "style-deep-research",
    label: "离群审计与重生",
    support: "unsupported",
    summary: "预留 VLM/CLIP 影像审计与只重生离群项的闭环；未接模型时不产生虚构分数。",
    input: {
      batchAssets: imageInput,
      auditRubric: { type: "object", required: true, description: "人工或真实 audit adapter 的评分栏位与门槛。" },
      regenerateLimit: { type: "number", required: false, description: "最多重生项数。", default: 3 },
    },
    output: {
      auditReport: { type: "object", required: true, description: "真实 audit evidence、离群 asset ids、决策。" },
      regeneratedAssets: { type: "object", required: true, description: "只有通过 audit adapter 后才可存在的重生结果。" },
    },
    gates: [
      { id: "audit-upstream", criterion: "VLM 或 CLIP audit adapter 回传可验证的 evidence；没有 evidence 就阻断。", blocking: true },
      { id: "outlier-only", criterion: "只重生被 audit 标记的离群项，保留原 asset 与判定。", blocking: true },
    ],
    unsupported: noUpstream("VLM/CLIP image audit upstream 未接入"),
    canvas: { nodeType: "group", fields: ["workflow_id", "auditAdapter", "auditReportId", "outlierAssetIds", "status"], requiredRelations: ["audit group -> batch image nodes", "regenerated image -> source outlier image"] },
    upstream: ["OpenAI CLIP reference implementation (not installed)", "no VLM audit adapter"],
  },
  {
    id: "style_lora_train_optional",
    workflow: "style-deep-research",
    label: "风格 LoRA 训练（可选）",
    support: "unsupported",
    summary: "预留以策展资料集训练 LoRA 的手续与交付栏位；未接 trainer 时只输出阻断状态。",
    input: {
      datasetAssets: imageInput,
      captions: { type: "string[]", required: true, description: "与资料集一一对应的人工核准 caption。" },
      trainerConfig: { type: "object", required: true, description: "rank、steps、base model 等 trainer 设定。" },
    },
    output: {
      trainingJob: { type: "object", required: true, description: "只有真实 LoRA trainer 回传的 job。" },
      loraArtifact: { type: "object", required: false, description: "成功训练后的权重 artifact、版本与 license。" },
    },
    gates: [
      { id: "lora-dataset", criterion: "资料集、caption、授权与 trainer config 一一对应。", blocking: true },
      { id: "lora-upstream", criterion: "真实 trainer adapter 回传 job/artifact；不得把 LoRA 写入 prompt 冒充训练。", blocking: true },
    ],
    unsupported: noUpstream("LoRA training upstream/trainer 未接入"),
    canvas: { nodeType: "config", fields: ["workflow_id", "trainerAdapter", "datasetAssetIds", "trainingJobId", "loraArtifactId", "status"], requiredRelations: ["training config -> dataset image nodes", "artifact -> training config"] },
    upstream: ["Hugging Face Diffusers LoRA training docs (method reference only)", "no local trainer"],
  },
  {
    id: "exhibition_delivery_manifest",
    workflow: "curatorial-creation",
    label: "展览交付清单",
    support: "supported",
    summary: "把已核准作品、版本、尺寸、色彩、授权与目录栏位整理成可交付 manifest。",
    input: {
      approvedAssets: imageInput,
      exhibition: { type: "object", required: true, description: "展览、作品编号、艺术家、场地与交付期限。" },
      derivatives: { type: "object", required: false, description: "印刷、网页、缩图等衍生规格。" },
    },
    output: {
      manifest: { type: "object", required: true, description: "版本固定、含 checksum 栏位与交付状态的 manifest。" },
      deliveryChecklist: { type: "string[]", required: true, description: "可逐项核准的交付清单。" },
    },
    gates: [
      { id: "delivery-identity", criterion: "每笔资产有唯一 asset id、作品编号与版本；不可只靠档名。", blocking: true },
      { id: "delivery-files", criterion: "每笔交付档有 mime、尺寸、色彩空间、bytes、checksum 与授权状态。", blocking: true },
      { id: "delivery-approval", criterion: "所有 required derivative 与 metadata 栏位完成后才标记 ready。", blocking: true },
    ],
    unsupported: ["外部印刷厂、馆方 DAM、FTP/云端交付未接入；本工具只产生 manifest，不宣称已送达。"],
    canvas: { nodeType: "group", fields: ["workflow_id", "manifestId", "exhibitionId", "assetIds", "deliveryStatus"], requiredRelations: ["manifest group -> approved image nodes"] },
    upstream: ["existing Canvas image assets", "IIIF Presentation 3 manifest convention (format reference only)"],
  },
] as const;

export const ART_WORKFLOWS: readonly ArtWorkflowDefinition[] = [
  {
    id: "curatorial-creation",
    label: "策展式创作",
    purpose: "从方向探索、主视觉与构图锁定，到可核对的展览交付清单。",
    toolOrder: ["moodboard_diverge_converge", "canonical_key_art_lock", "sketch_lock", "exhibition_delivery_manifest"],
    handoff: "每一步都把 asset id、版本与 gate 状态写入 Canvas metadata；未核准不得跳步。",
  },
  {
    id: "style-deep-research",
    label: "风格深研",
    purpose: "从参考图证据整理 style DNA，并在真实 StyleAligned、audit、LoRA upstream 可用时才扩展批次研究。",
    toolOrder: ["style_dna_extract", "style_aligned_batch", "outlier_audit_regenerate", "style_lora_train_optional"],
    handoff: "unsupported 工具只返回结构化阻断与所缺 upstream，不转成 prompt-only 近似结果。",
  },
];

export function getArtToolDefinition(id: ArtToolId): ArtToolDefinition | undefined {
  return ART_TOOL_DEFINITIONS.find((tool) => tool.id === id);
}

export function getArtWorkflowDefinition(id: ArtWorkflowId): ArtWorkflowDefinition | undefined {
  return ART_WORKFLOWS.find((workflow) => workflow.id === id);
}

export function validateArtToolDefinition(tool: ArtToolDefinition): string[] {
  const errors: string[] = [];
  if (!tool.id || !tool.workflow || !tool.label) errors.push("identity");
  if (!Object.keys(tool.input).length || !Object.keys(tool.output).length) errors.push("input-output");
  if (!tool.gates.length) errors.push("gates");
  if (!tool.canvas.fields.length || !tool.canvas.requiredRelations.length) errors.push("canvas-metadata");
  if (!tool.upstream.length) errors.push("upstream");
  if ((tool.support === "unsupported" || tool.support === "conditional") && tool.unsupported.length === 0) errors.push("unsupported-boundary");
  if (tool.support === "unsupported" && !tool.unsupported.some((item) => /未接|未提供|not installed|no local/i.test(item))) errors.push("unsupported-evidence");
  return errors;
}

export function unsupportedToolMessage(tool: ArtToolDefinition): string | null {
  if (tool.support !== "unsupported") return null;
  return `${tool.id} unsupported: ${tool.unsupported.join(" ")}`;
}

export const ART_RESEARCH_SOURCES = [
  { id: "storydiffusion", url: "https://github.com/HVision-NKU/StoryDiffusion", use: "系列角色/场景一致性研究来源；未接成本地 adapter。" },
  { id: "stylealigned", url: "https://github.com/google/style-aligned", use: "StyleAligned attention-sharing 研究来源；未接成本地 adapter。" },
  { id: "openai-clip", url: "https://github.com/openai/CLIP", use: "CLIP 图文表征与 audit 方法来源；未接本地 audit。" },
  { id: "diffusers-lora", url: "https://huggingface.co/docs/diffusers/en/training/lora", use: "LoRA training 方法与资料集边界来源；未接 trainer。" },
  { id: "iiif-presentation", url: "https://iiif.io/api/presentation/3.0/", use: "展览/目录 manifest 栏位与资产识别格式参考。" },
] as const;
