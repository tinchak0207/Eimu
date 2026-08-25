/**
 * Novel/IP visual package domain contracts.
 *
 * This is a declarative projection for the existing agent harness. It does not
 * own execution, queues, history, or model capabilities. Runtime owners remain
 * the existing agent gateway, Canvas state, generation queue, model catalog,
 * generation gates, and artifact service named by each tool.
 */

export type NovelIpVisualToolId =
  | "world_bible_extract"
  | "emotion_board_matrix"
  | "style_anchor_sref"
  | "character_dna_turnaround"
  | "story_sequence_consistency"
  | "multi_aspect_reflow"
  | "asset_provenance_archive";

export type NovelIpArtifactKind =
  | "world_bible"
  | "emotion_board"
  | "style_anchor"
  | "character_turnaround"
  | "story_sequence"
  | "aspect_reflow"
  | "provenance_archive";

export type NovelIpArtifactNodeType =
  | "text"
  | "character_card"
  | "scene_card"
  | "reference"
  | "image"
  | "group";

export interface NovelIpCanvasArtifactMetadata {
  artifactKind: NovelIpArtifactKind;
  artifactVersion: 1;
  nodeType: NovelIpArtifactNodeType;
  title: string;
  sourceTool: NovelIpVisualToolId;
  sourceNodeIds: string[];
  sourceArtifactIds: string[];
  referenceRoles: Array<"character" | "style" | "composition" | "general">;
  locked: boolean;
  provenance: {
    sourceUrls: string[];
    sourceRepos: string[];
    licenseNotes: string[];
    generatedAt?: string;
    modelId?: string;
    generationTaskIds: string[];
    sha256: string[];
  };
  gateResults: Array<{
    id: string;
    status: "pass" | "fail" | "skip";
    detail?: string;
  }>;
  unsupported: string[];
}

export interface NovelIpVisualToolDefinition {
  id: NovelIpVisualToolId;
  label: string;
  purpose: string;
  input: string;
  output: string;
  gate: string[];
  unsupported: string[];
  canvasArtifactMetadata: NovelIpCanvasArtifactMetadata;
  owner: {
    harness: string;
    execution: string;
    persistence: string;
    generation?: string;
  };
  researchBasis: string[];
}

const OWNER = {
  harness: "src/lib/agent-gateway.ts + existing VPS agent gateway tool registry",
  canvas: "src/app/api/agent/sessions/[id]/canvas-state/route.ts + src/lib/canvas/types.ts",
  generation: "src/app/api/generation-jobs/route.ts + src/lib/generation-core/command-service.ts",
  gates: "src/lib/generation-gates.ts",
  catalog: "src/lib/generation-model-catalog/",
  artifacts: "src/lib/generation-core/artifact-service.ts",
  assetStore: "src/lib/canvas/asset-store.ts",
} as const;

function artifact(
  artifactKind: NovelIpArtifactKind,
  nodeType: NovelIpArtifactNodeType,
  title: string,
  sourceTool: NovelIpVisualToolId,
  referenceRoles: NovelIpCanvasArtifactMetadata["referenceRoles"],
  unsupported: string[],
): NovelIpCanvasArtifactMetadata {
  return {
    artifactKind,
    artifactVersion: 1,
    nodeType,
    title,
    sourceTool,
    sourceNodeIds: [],
    sourceArtifactIds: [],
    referenceRoles,
    locked: true,
    provenance: {
      sourceUrls: [],
      sourceRepos: [],
      licenseNotes: [],
      generationTaskIds: [],
      sha256: [],
    },
    gateResults: [],
    unsupported,
  };
}

export const NOVEL_IP_VISUAL_TOOLS: readonly NovelIpVisualToolDefinition[] = [
  {
    id: "world_bible_extract",
    label: "世界观圣经提取",
    purpose: "从小说/IP 文本提取可复用的世界规则、地点、道具和视觉禁区。",
    input: "文本或文档引用、可选已有 Canvas 角色卡/场景卡 id；正文由 agent 解析，资产 id 必须来自现有 Canvas 节点。",
    output: "结构化世界观条目：rules、locations、props、visualDoNot；每条包含 sourceQuote 与 linkedNodeIds。",
    gate: ["world_bible.source_traceable", "world_bible.required_sections", "world_bible.node_ids_exist"],
    unsupported: ["不做事实核验或版权判定", "不凭空创建第二套角色/场景资产 id", "不直接生成图片"],
    canvasArtifactMetadata: artifact("world_bible", "text", "世界观圣经", "world_bible_extract", [], ["image_generation"]),
    owner: { harness: OWNER.harness, execution: "existing agent text/tool execution", persistence: OWNER.canvas },
    researchBasis: ["https://github.com/RD1241/NovelToComic#example-workflow", "https://github.com/RD1241/NovelToComic#what-is-noveltocomic"],
  },
  {
    id: "emotion_board_matrix",
    label: "情绪板矩阵",
    purpose: "把叙事节拍映射为情绪、色彩、光线和构图意图，供角色与分镜复用。",
    input: "世界观条目、剧情节拍、可选参考图 node id；每个 beat 可指定 intensity 1-5。",
    output: "按 beat 排序的 emotion matrix：emotion、intensity、palette、lighting、composition、negativeCues。",
    gate: ["emotion_board.beat_order", "emotion_board.intensity_range", "emotion_board.palette_complete"],
    unsupported: ["不把情绪百分比当成模型可执行控制", "不替代用户对最终画面的视觉判断", "不新增独立 history 记录"],
    canvasArtifactMetadata: artifact("emotion_board", "group", "情绪板矩阵", "emotion_board_matrix", ["style", "composition"], ["pixel_exact_color_control"]),
    owner: { harness: OWNER.harness, execution: "existing agent text/tool execution", persistence: OWNER.canvas },
    researchBasis: ["https://github.com/HVision-NKU/StoryDiffusion#storydiffusion-consistent-self-attention-for-long-range-image-and-video-generation", "https://github.com/RD1241/NovelToComic#example-workflow"],
  },
  {
    id: "style_anchor_sref",
    label: "风格锚点 SREF",
    purpose: "建立可追溯的风格参考锚点，并以既有 reference image role 注入后续生成。",
    input: "1-8 张参考图 node/artifact id、风格描述、可选 style template；引用图必须能解析为现有 Canvas image/reference 节点或 generation artifact。",
    output: "style anchor：reference ids、风格特征摘要、注入 role=style 的 references、来源和许可备注。",
    gate: ["style_anchor.reference_exists", "style_anchor.role_style", "style_anchor.provenance_present"],
    unsupported: ["不宣称平台原生 SREF 参数已可用", "不复制受限模型权重或第三方提示词资产", "不把风格参考改写成角色参考"],
    canvasArtifactMetadata: artifact("style_anchor", "reference", "风格锚点", "style_anchor_sref", ["style"], ["native_sref_parameter"]),
    owner: { harness: OWNER.harness, execution: "src/lib/canvas/semantic-nodes.ts reference resolution", persistence: OWNER.canvas, generation: "src/lib/generation-workflow.ts + src/lib/image-types.ts" },
    researchBasis: ["https://github.com/tencent-ailab/IP-Adapter#ip-adapter-text-compatible-image-prompt-adapter-for-text-to-image-diffusion-models", "https://github.com/tencent-ailab/IP-Adapter#ip-adapter-for-non-square-images"],
  },
  {
    id: "character_dna_turnaround",
    label: "角色 DNA 转面",
    purpose: "从角色卡与参考图生成可复用的角色身份、服饰、比例和多视角资产。",
    input: "现有 character_card node id、1-4 张角色参考 artifact/node id、年龄/体型/服装约束、视角集合。",
    output: "角色 DNA JSON + turnaround image task set；结果挂回同一角色卡的 reference/image 节点，保留 generation task id 与 sha256。",
    gate: ["character_dna.card_binding", "character_dna.reference_role", "character_dna.view_set", "generation.preflight"],
    unsupported: ["不保证跨模型身份像素级一致", "不生成或存储人脸识别生物特征", "参考图能力不可用时不伪造转面结果"],
    canvasArtifactMetadata: artifact("character_turnaround", "character_card", "角色 DNA 转面", "character_dna_turnaround", ["character"], ["pixel_identity_guarantee"]),
    owner: { harness: OWNER.harness, execution: "src/lib/canvas/semantic-nodes.ts + existing agent image tool", persistence: OWNER.canvas, generation: OWNER.generation },
    researchBasis: ["https://github.com/HVision-NKU/StoryDiffusion#storydiffusion-consistent-self-attention-for-long-range-image-and-video-generation", "https://github.com/tencent-ailab/IP-Adapter#ip-adapter-plus-face-demo"],
  },
  {
    id: "story_sequence_consistency",
    label: "故事序列一致性",
    purpose: "把连续分镜绑定到角色、场景、风格锚点并按序生成，保留每格的可追溯一致性证据。",
    input: "有序 shots、已有 character/scene/style node ids、每格 prompt、可选 ControlNet 条件图；每格最多 16 个卡引用。",
    output: "有序 story sequence artifact + 每格 generation task ids、reference roles、输入快照和 gate results。",
    gate: ["story_sequence.order_unique", "story_sequence.assets_resolve", "story_sequence.reference_roles", "generation.preflight"],
    unsupported: ["不承诺模型级长程一致性", "不在本地重建 StoryDiffusion/ControlNet 推理服务", "单格资产缺失时阻断该格，不阻断可独立生成的其他格"],
    canvasArtifactMetadata: artifact("story_sequence", "group", "故事序列", "story_sequence_consistency", ["character", "style", "composition", "general"], ["local_diffusion_runtime"]),
    owner: { harness: OWNER.harness, execution: "existing agent image tool + src/lib/canvas/semantic-nodes.ts", persistence: OWNER.canvas, generation: OWNER.generation },
    researchBasis: ["https://github.com/HVision-NKU/StoryDiffusion#comics-generation", "https://github.com/RD1241/NovelToComic#character-memory", "https://github.com/lllyasviel/ControlNet#combining-multiple-controlnets"],
  },
  {
    id: "multi_aspect_reflow",
    label: "多比例重排",
    purpose: "在不改变故事顺序和资产绑定的前提下，为目标画幅重排分镜与生成参数。",
    input: "现有 story_sequence artifact、目标 aspect ratio(s)、版式约束、可选每格优先级；比例必须来自 model catalog。",
    output: "aspect reflow manifest：目标比例、每格 composition 变更、被保留/裁切/重生的原因，以及需要提交的 generation tasks。",
    gate: ["reflow.aspect_supported", "reflow.order_preserved", "reflow.reference_bindings_preserved", "generation.preflight"],
    unsupported: ["不把裁切伪装成区域编辑", "不保证跨模型构图完全不变", "目标比例不在 catalog 时不提交生成任务"],
    canvasArtifactMetadata: artifact("aspect_reflow", "group", "多比例重排", "multi_aspect_reflow", ["composition", "character", "style"], ["regional_editing"]),
    owner: { harness: OWNER.harness, execution: "src/lib/generation-workflow.ts + src/lib/generation-model-catalog/", persistence: OWNER.canvas, generation: OWNER.generation },
    researchBasis: ["https://github.com/tencent-ailab/IP-Adapter#ip-adapter-for-non-square-images", "https://github.com/RD1241/NovelToComic#adaptive-panel-generation"],
  },
  {
    id: "asset_provenance_archive",
    label: "资产溯源归档",
    purpose: "将 Canvas 资产、生成任务、来源许可和内容哈希汇总为可审计的归档清单。",
    input: "Canvas node/artifact ids、generation task ids、来源 URL/repository、许可备注；不接受原始 secret/token。",
    output: "不可变 provenance archive：资产关系、source urls/repos、license notes、task ids、mime/尺寸/sha256 和 gate results。",
    gate: ["provenance.ids_resolve", "provenance.hash_present", "provenance.secret_free", "artifact.validated"],
    unsupported: ["不替代法律意见或版权登记", "不归档密码、token、cookie、私钥或原始认证材料", "没有 artifact 校验哈希时不标记为完整归档"],
    canvasArtifactMetadata: artifact("provenance_archive", "text", "资产溯源归档", "asset_provenance_archive", ["general"], ["legal_clearance"]),
    owner: { harness: OWNER.harness, execution: "existing agent tool result handling", persistence: OWNER.canvas, generation: OWNER.artifacts },
    researchBasis: ["https://github.com/RD1241/NovelToComic#architecture", "https://github.com/tencent-ailab/IP-Adapter#ip-adapter-text-compatible-image-prompt-adapter-for-text-to-image-diffusion-models"],
  },
] as const;

export const NOVEL_IP_VISUAL_TOOL_IDS = NOVEL_IP_VISUAL_TOOLS.map((tool) => tool.id);

export function getNovelIpVisualTool(id: string): NovelIpVisualToolDefinition | undefined {
  return NOVEL_IP_VISUAL_TOOLS.find((tool) => tool.id === id);
}
