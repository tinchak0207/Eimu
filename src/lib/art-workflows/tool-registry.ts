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
  description: "已存在的圖片資產 URL 或 Canvas image/reference node id；不可用文字冒充圖片。",
};

const textInput: ArtFieldSpec = {
  type: "string",
  required: true,
  description: "創作意圖或研究問題。",
};

const noUpstream = (reason: string): string[] => [reason, "未提供可執行 adapter；不得以 prompt 拼接、人工分數或假 taskId 代替。"];

export const ART_TOOL_DEFINITIONS: readonly ArtToolDefinition[] = [
  {
    id: "moodboard_diverge_converge",
    workflow: "curatorial-creation",
    label: "情緒板發散與收斂",
    support: "supported",
    summary: "從參考資產建立可追溯的發散候選，再由使用者收斂成方向包。",
    input: {
      brief: textInput,
      referenceImages: { ...imageInput, required: false, description: "可選的參考圖片資產。" },
      candidateCount: { type: "number", required: false, description: "候選數，限制 3-12。", default: 6 },
    },
    output: {
      candidates: { type: "object", required: true, description: "候選卡：assetId、prompt、palette、compositionNotes。" },
      selectedDirection: { type: "object", required: true, description: "使用者選定的方向與排除理由。" },
    },
    gates: [
      { id: "moodboard-input", criterion: "至少有 brief；每個引用都能解析為真實 image/reference asset。", blocking: true },
      { id: "moodboard-convergence", criterion: "輸出包含一個明確 selectedDirection，未選定不得進入 key art。", blocking: true },
    ],
    unsupported: [],
    canvas: { nodeType: "group", fields: ["workflow_id", "candidateAssetIds", "selectedDirection", "status"], requiredRelations: ["candidate image nodes -> moodboard group"] },
    upstream: ["existing generation queue", "existing Canvas image/reference nodes"],
  },
  {
    id: "style_dna_extract",
    workflow: "style-deep-research",
    label: "風格 DNA 提取",
    support: "conditional",
    summary: "把已選參考圖整理成可人工核准的風格 DNA 結構，不宣稱由 VLM/CLIP 自動推論。",
    input: {
      referenceImages: imageInput,
      styleQuestions: { type: "string[]", required: false, description: "要核對的材質、色彩、構圖、光線欄位。" },
    },
    output: {
      styleDna: { type: "object", required: true, description: "可編輯的 style DNA 草稿與 evidence asset ids。" },
      evidence: { type: "object", required: true, description: "每個欄位對應的參考資產與人工註記。" },
    },
    gates: [
      { id: "style-dna-evidence", criterion: "每個 DNA 欄位都指向至少一個 reference asset 或標記 needs_review。", blocking: true },
      { id: "style-dna-approval", criterion: "使用者核准 DNA 草稿後才可鎖定 key art。", blocking: true },
    ],
    unsupported: ["未接 VLM/CLIP embedding 或 image caption upstream；本工具只做結構化與人工核准。"],
    canvas: { nodeType: "config", fields: ["workflow_id", "styleDna", "evidenceAssetIds", "approvalStatus"], requiredRelations: ["config -> reference image nodes"] },
    upstream: noUpstream("VLM/CLIP image understanding adapter 尚未接入"),
  },
  {
    id: "canonical_key_art_lock",
    workflow: "curatorial-creation",
    label: "主視覺鎖定",
    support: "supported",
    summary: "以已核准方向與 style DNA 生成一張 canonical key art，並把它標成不可悄悄替換的風格錨。",
    input: {
      approvedDirection: { type: "object", required: true, description: "已通過 moodboard convergence 的方向包。" },
      styleDna: { type: "object", required: true, description: "已核准的風格 DNA。" },
      size: { type: "string", required: true, description: "主視覺輸出尺寸。" },
    },
    output: {
      keyArtAsset: { type: "object", required: true, description: "生成結果、generation id、prompt snapshot。" },
      lockRecord: { type: "object", required: true, description: "canonical asset id、版本、核准狀態。" },
    },
    gates: [
      { id: "key-art-brief", criterion: "方向、DNA、尺寸均已存在且可回溯。", blocking: true },
      { id: "key-art-approval", criterion: "使用者核准結果後才可作為後續批次 style reference。", blocking: true },
    ],
    unsupported: [],
    canvas: { nodeType: "image", fields: ["workflow_id", "canonicalKeyArt", "locked", "prompt", "model", "size", "status"], requiredRelations: ["key art image -> style DNA config", "key art image -> selected direction"] },
    upstream: ["existing generation queue", "existing Canvas metadata"],
  },
  {
    id: "sketch_lock",
    workflow: "curatorial-creation",
    label: "草圖構圖鎖定",
    support: "supported",
    summary: "先保存黑白構圖與鏡頭欄位，再允許彩色/高成本生成沿用同一構圖決策。",
    input: {
      compositionBrief: textInput,
      canonicalKeyArt: { type: "string", required: false, description: "可選 canonical key art asset id。" },
      sketchAsset: { type: "string", required: false, description: "已上傳的草圖 asset id；未提供時可走生成 queue。" },
    },
    output: {
      sketchAsset: { type: "object", required: true, description: "草圖 asset 與 composition lock 欄位。" },
      shotSpec: { type: "object", required: true, description: "景別、機位、運鏡、比例。" },
    },
    gates: [
      { id: "sketch-composition", criterion: "草圖存在且 shotSpec 完整；不得用 final render 反推草圖。", blocking: true },
      { id: "sketch-approval", criterion: "構圖經使用者鎖定後才可出最終批次。", blocking: true },
    ],
    unsupported: [],
    canvas: { nodeType: "image", fields: ["workflow_id", "sketchLock", "shot_size", "camera_move", "locked", "status"], requiredRelations: ["sketch image -> prompt/config node"] },
    upstream: ["existing generation queue", "existing Canvas metadata"],
  },
  {
    id: "style_aligned_batch",
    workflow: "style-deep-research",
    label: "風格對齊批次",
    support: "unsupported",
    summary: "預留 StyleAligned attention-sharing 批次邊界；上游未接入時阻斷，不退化成 prompt 拼接。",
    input: {
      canonicalKeyArt: { type: "string", required: true, description: "canonical key art asset id。" },
      batchPrompts: { type: "string[]", required: true, description: "批次內容 prompt；每項需保留 subject delta。" },
      count: { type: "number", required: true, description: "批次數量，限制 1-32。" },
    },
    output: {
      batchJob: { type: "object", required: true, description: "只有在 StyleAligned adapter 可用時才可產生的 batch job。" },
    },
    gates: [
      { id: "style-aligned-upstream", criterion: "StyleAligned attention-sharing adapter health=ready 且回傳真實 batch id。", blocking: true },
      { id: "style-aligned-anchor", criterion: "canonical key art 與每項 prompt 均可回溯。", blocking: true },
    ],
    unsupported: noUpstream("StyleAligned attention-sharing upstream 未接入"),
    canvas: { nodeType: "group", fields: ["workflow_id", "styleAlignedAdapter", "canonicalKeyArt", "batchJobId", "status"], requiredRelations: ["batch group -> canonical key art", "batch result images -> batch group"] },
    upstream: ["Google StyleAligned research implementation (not installed)", "no local adapter"],
  },
  {
    id: "outlier_audit_regenerate",
    workflow: "style-deep-research",
    label: "離群審計與重生",
    support: "unsupported",
    summary: "預留 VLM/CLIP 影像審計與只重生離群項的閉環；未接模型時不產生虛構分數。",
    input: {
      batchAssets: imageInput,
      auditRubric: { type: "object", required: true, description: "人工或真實 audit adapter 的評分欄位與門檻。" },
      regenerateLimit: { type: "number", required: false, description: "最多重生項數。", default: 3 },
    },
    output: {
      auditReport: { type: "object", required: true, description: "真實 audit evidence、離群 asset ids、決策。" },
      regeneratedAssets: { type: "object", required: true, description: "只有通過 audit adapter 後才可存在的重生結果。" },
    },
    gates: [
      { id: "audit-upstream", criterion: "VLM 或 CLIP audit adapter 回傳可驗證的 evidence；沒有 evidence 就阻斷。", blocking: true },
      { id: "outlier-only", criterion: "只重生被 audit 標記的離群項，保留原 asset 與判定。", blocking: true },
    ],
    unsupported: noUpstream("VLM/CLIP image audit upstream 未接入"),
    canvas: { nodeType: "group", fields: ["workflow_id", "auditAdapter", "auditReportId", "outlierAssetIds", "status"], requiredRelations: ["audit group -> batch image nodes", "regenerated image -> source outlier image"] },
    upstream: ["OpenAI CLIP reference implementation (not installed)", "no VLM audit adapter"],
  },
  {
    id: "style_lora_train_optional",
    workflow: "style-deep-research",
    label: "風格 LoRA 訓練（可選）",
    support: "unsupported",
    summary: "預留以策展資料集訓練 LoRA 的手續與交付欄位；未接 trainer 時只輸出阻斷狀態。",
    input: {
      datasetAssets: imageInput,
      captions: { type: "string[]", required: true, description: "與資料集一一對應的人工核准 caption。" },
      trainerConfig: { type: "object", required: true, description: "rank、steps、base model 等 trainer 設定。" },
    },
    output: {
      trainingJob: { type: "object", required: true, description: "只有真實 LoRA trainer 回傳的 job。" },
      loraArtifact: { type: "object", required: false, description: "成功訓練後的權重 artifact、版本與 license。" },
    },
    gates: [
      { id: "lora-dataset", criterion: "資料集、caption、授權與 trainer config 一一對應。", blocking: true },
      { id: "lora-upstream", criterion: "真實 trainer adapter 回傳 job/artifact；不得把 LoRA 寫入 prompt 冒充訓練。", blocking: true },
    ],
    unsupported: noUpstream("LoRA training upstream/trainer 未接入"),
    canvas: { nodeType: "config", fields: ["workflow_id", "trainerAdapter", "datasetAssetIds", "trainingJobId", "loraArtifactId", "status"], requiredRelations: ["training config -> dataset image nodes", "artifact -> training config"] },
    upstream: ["Hugging Face Diffusers LoRA training docs (method reference only)", "no local trainer"],
  },
  {
    id: "exhibition_delivery_manifest",
    workflow: "curatorial-creation",
    label: "展覽交付清單",
    support: "supported",
    summary: "把已核准作品、版本、尺寸、色彩、授權與目錄欄位整理成可交付 manifest。",
    input: {
      approvedAssets: imageInput,
      exhibition: { type: "object", required: true, description: "展覽、作品編號、藝術家、場地與交付期限。" },
      derivatives: { type: "object", required: false, description: "印刷、網頁、縮圖等衍生規格。" },
    },
    output: {
      manifest: { type: "object", required: true, description: "版本固定、含 checksum 欄位與交付狀態的 manifest。" },
      deliveryChecklist: { type: "string[]", required: true, description: "可逐項核准的交付清單。" },
    },
    gates: [
      { id: "delivery-identity", criterion: "每筆資產有唯一 asset id、作品編號與版本；不可只靠檔名。", blocking: true },
      { id: "delivery-files", criterion: "每筆交付檔有 mime、尺寸、色彩空間、bytes、checksum 與授權狀態。", blocking: true },
      { id: "delivery-approval", criterion: "所有 required derivative 與 metadata 欄位完成後才標記 ready。", blocking: true },
    ],
    unsupported: ["外部印刷廠、館方 DAM、FTP/雲端交付未接入；本工具只產生 manifest，不宣稱已送達。"],
    canvas: { nodeType: "group", fields: ["workflow_id", "manifestId", "exhibitionId", "assetIds", "deliveryStatus"], requiredRelations: ["manifest group -> approved image nodes"] },
    upstream: ["existing Canvas image assets", "IIIF Presentation 3 manifest convention (format reference only)"],
  },
] as const;

export const ART_WORKFLOWS: readonly ArtWorkflowDefinition[] = [
  {
    id: "curatorial-creation",
    label: "策展式創作",
    purpose: "從方向探索、主視覺與構圖鎖定，到可核對的展覽交付清單。",
    toolOrder: ["moodboard_diverge_converge", "canonical_key_art_lock", "sketch_lock", "exhibition_delivery_manifest"],
    handoff: "每一步都把 asset id、版本與 gate 狀態寫入 Canvas metadata；未核准不得跳步。",
  },
  {
    id: "style-deep-research",
    label: "風格深研",
    purpose: "從參考圖證據整理 style DNA，並在真實 StyleAligned、audit、LoRA upstream 可用時才擴展批次研究。",
    toolOrder: ["style_dna_extract", "style_aligned_batch", "outlier_audit_regenerate", "style_lora_train_optional"],
    handoff: "unsupported 工具只返回結構化阻斷與所缺 upstream，不轉成 prompt-only 近似結果。",
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
  { id: "storydiffusion", url: "https://github.com/HVision-NKU/StoryDiffusion", use: "系列角色/場景一致性研究來源；未接成本地 adapter。" },
  { id: "stylealigned", url: "https://github.com/google/style-aligned", use: "StyleAligned attention-sharing 研究來源；未接成本地 adapter。" },
  { id: "openai-clip", url: "https://github.com/openai/CLIP", use: "CLIP 圖文表徵與 audit 方法來源；未接本地 audit。" },
  { id: "diffusers-lora", url: "https://huggingface.co/docs/diffusers/en/training/lora", use: "LoRA training 方法與資料集邊界來源；未接 trainer。" },
  { id: "iiif-presentation", url: "https://iiif.io/api/presentation/3.0/", use: "展覽/目錄 manifest 欄位與資產識別格式參考。" },
] as const;
