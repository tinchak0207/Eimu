// 画布节点 metadata 的**键集合单一真源**（2026-09-25）。
//
// 为什么要有这一层：节点 metadata 有**两个独立的白名单清洗入口**，键集合各自手工维护：
//   A（耐久化/还原端）`src/lib/canvas/layout.ts` 的 `toNodeMetadata`——所有载入路径
//     （Blob 专案＋gateway 快照）都收束到 `fromCanvasProject → normalizeCanvasNode →
//     toNodeMetadata`，漏一键＝该键重载后静默消失。
//   B（上行/压缩端）`src/hooks/canvas/canvas-chat-types.ts` 的 `compactMetadataForAgent`
//     ——上行快照（`canvas-project-sync.postCanvasSnapshot`）的唯一资料源，漏一键＝
//     回旧会话/换装置还原后该键静默消失。
// 两端任一漏放行的症状是「功能完全没反应」而不是报错（2026-09-24 `emitsEntity` 实锤：
// 闸道节点 metadata 好好的，一进前端就被剥成 undefined，整条自动落卡不可能触发）。
//
// 本档只放**清单与理由**（可机器列举），不放清洗实作：
//   · A 的清洗器实作留在 `layout.ts`（`DURABLE_FIELD_CLEANERS` 注册表，键集合由本档导出）
//   · B 的透传实作留在 `canvas-chat-types.ts`（依本档的 `transform` 分派）
// 这样两个入口的**键集合**只有一份，行为实作各自留在原档，避免搬家造成的 import 风暴。
//
// 契约测试：`src/lib/canvas/node-metadata-fields.test.ts`（遍历本档清单做真实往复断言）。

// ─────────────────────────────────────────── A：耐久化（还原端）键集合

/**
 * A 端清洗器名称。**每个名称都必须在 `layout.ts` 的 `DURABLE_FIELD_CLEANERS` 有实作**
 * （该表用 `Record<MetadataCleanerName, …>` 标型，漏一个 tsc 就红）。
 */
export type MetadataCleanerName =
  | "string"
  | "finiteNumber"
  | "nodeStatus"
  | "errorDetails"
  | "sourceImage"
  | "referenceRole"
  | "pipelineCard"
  | "unsupportedFlag"
  | "stringOrTrue"
  | "nullableString"
  | "booleanFlag"
  | "sceneCard"
  | "storyboardShot"
  | "storyboardScene"
  | "shotCandidates"
  | "idList"
  | "trimmedString"
  | "emitsEntity"
  | "cardName"
  | "fontSize"
  | "gateConfirm"
  | "approval"
  | "taskVersions";

/** 一个耐久化键：键名 ＋ 清洗器名称（型别对应）＋ 为何它必须活著。 */
export interface DurableFieldSpec {
  readonly key: string;
  readonly cleaner: MetadataCleanerName;
  readonly note: string;
}

/**
 * A 必须放行的键，**顺序＝`toNodeMetadata` 的输出键插入序**（改序会动到输出物件键序，
 * 属可观察行为，勿随意重排）。
 */
export const DURABLE_METADATA_FIELDS: readonly DurableFieldSpec[] = [
  { key: "content", cleaner: "string", note: "图片节点=交付 URL；文本节点=正文（NodeBody 全部卡型都读）" },
  { key: "prompt", cleaner: "string", note: "生成提示词；重生成与 Config 卡都读" },
  { key: "negativePrompt", cleaner: "string", note: "负面词（介面宣告键；目前全库查无 metadata 读者）" },
  { key: "model", cleaner: "string", note: "模型 id（Config 卡「模型」行）" },
  { key: "size", cleaner: "string", note: "尺寸/比例（Config 卡「尺寸」行；分镜 QC 的 nodeSize 推导也读）" },
  { key: "quality", cleaner: "string", note: "质量档（Config 卡「质量」行）" },
  { key: "count", cleaner: "finiteNumber", note: "生成张数（Config 卡「数量」行）" },
  { key: "kind", cleaner: "string", note: "生成物种类 image|video（Config 卡「类型」行）" },
  { key: "source_image", cleaner: "sourceImage", note: "edit/upscale 来源（NodeBody 行＋重生成带 sourceImage；null 亦为合法值）" },
  { key: "status", cleaner: "nodeStatus", note: "四态状态（gateway 词汇映射；节点配色与骨架渲染）" },
  { key: "errorDetails", cleaner: "errorDetails", note: "失败人话（NodeBody error 分支；errorDetailsText）" },
  { key: "naturalWidth", cleaner: "finiteNumber", note: "自然宽（重生成尺寸提示）" },
  { key: "naturalHeight", cleaner: "finiteNumber", note: "自然高（重生成尺寸提示）" },
  { key: "cost_coins", cleaner: "finiteNumber", note: "实际花费（CanvasNodeView 徽章）" },
  { key: "cost_hint", cleaner: "finiteNumber", note: "预估花费（CanvasNodeView「预估 N 币」）" },
  { key: "imageTaskId", cleaner: "string", note: "生成任务 id（canvas-event-settler 以 task_id 对帐落地）" },
  { key: "startedAt", cleaner: "finiteNumber", note: "开始时间戳（介面宣告键；目前全库查无 metadata 读者）" },
  { key: "progress", cleaner: "finiteNumber", note: "进度（NodeBody 进度条＋batch-utils 批次聚合）" },
  { key: "referenceRole", cleaner: "referenceRole", note: "reference 节点参考角色（只收 ReferenceImageRole 六值）" },
  { key: "pipelineCard", cleaner: "pipelineCard", note: "结构卡标记 tool|gate|note|director（渲染分支的总开关）" },
  { key: "toolId", cleaner: "string", note: "工具卡：工具 id" },
  { key: "toolInput", cleaner: "string", note: "工具卡：输入契约" },
  { key: "toolOutput", cleaner: "string", note: "工具卡：输出契约" },
  { key: "requiredCapability", cleaner: "string", note: "工具卡：缺失的上游能力标识" },
  { key: "unsupported", cleaner: "unsupportedFlag", note: "工具卡：harness 未接上游旗标（truthy→true，boolean 形态）" },
  { key: "deliverable", cleaner: "string", note: "步骤头卡：产出合同全文" },
  { key: "gate", cleaner: "stringOrTrue", note: "验收门禁：string 全文 或 true（DSL 需人工批准旗标），两形态并存" },
  { key: "directorSessionId", cleaner: "string", note: "导演台：gateway 会话 id（小视口据此拉 state）" },
  { key: "planName", cleaner: "nullableString", note: "导演台：当前方案名；明确 null＝「目前无方案」是语义，必须保留 null" },
  { key: "shotCount", cleaner: "finiteNumber", note: "导演台：活跃方案镜头数" },
  { key: "healthOk", cleaner: "booleanFlag", note: "导演台：分镜健康徽章（true/false 两态都要）" },
  { key: "topViewSvg", cleaner: "string", note: "导演台：俯视图 SVG 原文（>48KB 级重料；见 B 端排除理由）" },
  { key: "cameraViewSvg", cleaner: "string", note: "导演台：镜头框图 SVG 原文（同上）" },
  { key: "revision", cleaner: "finiteNumber", note: "导演台：工程 revision（变更比对重拉）" },
  { key: "sceneCard", cleaner: "sceneCard", note: "3D 场景卡（底线 glb_path+scene_summary，其余四栏可选；缺底线整包丢）" },
  { key: "directorStageId", cleaner: "trimmedString", note: "3D 舞台参考溯源：来源 scene_3d 节点 id（缺＝无溯源，不写空壳）" },
  { key: "shotId", cleaner: "trimmedString", note: "3D 舞台参考溯源：所属镜号（storyboard-contract shotId 口径）" },
  { key: "episodeId", cleaner: "trimmedString", note: "分镜的集归属（按集批次换模型的分组维度；缺＝不归任何一集）" },
  { key: "storyboardShot", cleaner: "storyboardShot", note: "分镜 AID 21 栏契约（shotNumber 为空即整包丢）" },
  // ── 单镜旁白文本 ＋ 对白／旁白双音轨（2026-09-30；介面冻结四键）──
  // 病灶：`audioAnchorId` 在分镜生产契约（storyboard-contract.ts）里是**无生产者的宣告**，
  // 17 道门禁的 `audio_anchor_present`／`dialogue_alignment` 结构上永远不可能过（
  // shortdrama-domain/index.ts:448/450 逐镜读 `shot.audioAnchorId`）。本四键补上生产者。
  { key: "narration", cleaner: "string", note: "单镜旁白文本（旁白轨的文本；漏放行＝刷新后旁白消失，TTS 逐镜合成无输入）" },
  { key: "dialogueAudioId", cleaner: "string", note: "该镜对白音档资产 id（audioAnchorId 的锚优先来源；漏放行＝重载后对白轨消失）" },
  { key: "narrationAudioId", cleaner: "string", note: "该镜旁白音档资产 id（无对白轨时为锚；漏放行＝重载后旁白轨消失）" },
  { key: "audioAnchorId", cleaner: "string", note: "音轨锚（相容键）＝dialogueAudioId || narrationAudioId；门禁 audio_anchor_present/dialogue_alignment 读它" },
  { key: "shotCandidates", cleaner: "shotCandidates", note: "分镜级抽卡候选集＋星标（id+prompt 缺一即丢该条；空集合＝省略键）" },
  { key: "storyboardScene", cleaner: "storyboardScene", note: "分镜场景归属（sceneName 是唯一权威）" },
  { key: "characterCardIds", cleaner: "idList", note: "分镜：角色卡引用 id 阵列" },
  { key: "sceneCardIds", cleaner: "idList", note: "分镜：场景卡引用 id 阵列" },
  { key: "propCardIds", cleaner: "idList", note: "分镜：道具卡引用 id 阵列" },
  { key: "entityCardId", cleaner: "trimmedString", note: "自动落卡幂等标记（trim 后非空才收）" },
  { key: "emitsEntity", cleaner: "emitsEntity", note: "模板实体宣告（驱动整条自动落卡；kind 不在五值域即整包丢）" },
  { key: "input", cleaner: "cardName", note: "卡名来源键①（nameFrom:\"input\" 依序取）" },
  { key: "characterName", cleaner: "cardName", note: "卡名来源键②" },
  { key: "sceneName", cleaner: "cardName", note: "卡名来源键③" },
  { key: "fontSize", cleaner: "fontSize", note: "文本节点字号（10..28 整数；漏放行＝重载回 14.5）" },
  { key: "gateConfirm", cleaner: "gateConfirm", note: "协作确认闸凭据（三栏全对才收；漏放行＝门禁卡退回纯文字）" },
  { key: "approval", cleaner: "approval", note: "分镜批准状态（status 三值域；漏放行＝批准态重载后翻面）" },
  {
    key: "taskVersions",
    cleaner: "taskVersions",
    note: "任务版本史＋标签＋星标选中（P1-9/D37：version＝任务时戳，同格重跑追加新版本、旧版本留著；漏放行＝刷新后版本史与采用稿消失）",
  },
];

/** A 必须放行的键名清单（供测试与消费端列举）。 */
export const DURABLE_METADATA_FIELD_KEYS: readonly string[] = DURABLE_METADATA_FIELDS.map((f) => f.key);

// ─────────────────────────────────────────── B：上行（agent 压缩端）键集合

/**
 * B 端透传动作。与 A 的清洗器刻意不同名：B 是「把 A 清洗过的值挑出来传」，
 * 部分键带 token 预算截断（见 `AGENT_TRUNCATION_BUDGETS`）。
 */
export type AgentFieldTransform =
  /** content：超 `AGENT_CONTENT_TRUNCATE_TRIGGER` 字则截 `…KEEP` 字＋省略号。 */
  | "content"
  /** prompt：无条件截 `AGENT_PROMPT_TRUNCATE_KEEP` 字。 */
  | "prompt"
  /** truthy 才写，值原样（模型/尺寸/状态/角色/合同/门禁/场景卡…）。 */
  | "truthy"
  /** `typeof === "number"` 才写（count/cost_coins/shotCount/revision）。 */
  | "number"
  /** `typeof === "boolean"` 才写（unsupported/healthOk）。 */
  | "boolean"
  /** `!== undefined` 才写（planName：明确 null 也是语义，必须传）。 */
  | "defined"
  /** pipelineCard 四值枚举（tool|gate|note|director）。 */
  | "pipelineCard"
  /** id 阵列收敛（非空字串、首见序去重、空集合省略键）。 */
  | "idList"
  /** 卡名收敛（trim＋上限 100）。 */
  | "cardName"
  /** 分镜 21 栏压缩（逐栏截 `STORYBOARD_SNAPSHOT_FIELD_CHARS`）。 */
  | "storyboardShot"
  /** emitsEntity 清洗（与 A 同一份 `cleanEmitsEntity`）。 */
  | "emitsEntity"
  /** 字号清洗（与 A 同一把尺 10..28）。 */
  | "fontSize"
  /** 门禁凭据清洗（与 A 同一份 `toGateConfirm`）。 */
  | "gateConfirm"
  /** 批准状态清洗（与 A 同一份 `normalizeApprovalState`）。 */
  | "approval";

/** 分族透传条件：同伴键为指定字串值时，本键才透传。 */
export interface AgentFieldCondition {
  readonly key: string;
  readonly oneOf: readonly string[];
}

/** 一个 agent 透传键。 */
export interface AgentFieldSpec {
  readonly key: string;
  readonly transform: AgentFieldTransform;
  /** 分族条件（工具卡族要求 pipelineCard∈{tool,gate,note}；导演台族要求 =director）。 */
  readonly requires?: AgentFieldCondition;
  readonly note: string;
}

/** 工具卡族三值（pipelineCard）。 */
export const AGENT_TOOL_FAMILY_PIPELINE_CARDS = ["tool", "gate", "note"] as const;

/**
 * B 应透传的键，**顺序＝`compactMetadataForAgent` 的输出键插入序**（同 A：键序是可观察行为）。
 */
export const AGENT_METADATA_FIELDS: readonly AgentFieldSpec[] = [
  { key: "content", transform: "content", note: "正文/交付 URL；超预算截断（见 AGENT_TRUNCATION_BUDGETS）" },
  { key: "prompt", transform: "prompt", note: "提示词；截 120 字（token 预算）" },
  { key: "model", transform: "truthy", note: "模型 id" },
  { key: "size", transform: "truthy", note: "尺寸/比例" },
  { key: "status", transform: "truthy", note: "四态状态（agent 读画布状态要知道谁在跑谁失败）" },
  { key: "referenceRole", transform: "truthy", note: "参考图角色（agent 知道这张图以什么身份参与）" },
  { key: "deliverable", transform: "truthy", note: "步骤产出合同（漏传＝下行还原后骨架失语义）" },
  { key: "gate", transform: "truthy", note: "验收门禁（string 全文 / true 旗标）" },
  { key: "count", transform: "number", note: "生成张数" },
  { key: "cost_coins", transform: "number", note: "实际花费" },
  { key: "pipelineCard", transform: "pipelineCard", note: "结构卡标记；四值枚举（未列举值含 step_head 照旧丢）" },
  {
    key: "toolId",
    transform: "truthy",
    requires: { key: "pipelineCard", oneOf: AGENT_TOOL_FAMILY_PIPELINE_CARDS },
    note: "工具卡族（pipelineCard=tool|gate|note）",
  },
  {
    key: "toolInput",
    transform: "truthy",
    requires: { key: "pipelineCard", oneOf: AGENT_TOOL_FAMILY_PIPELINE_CARDS },
    note: "工具卡族",
  },
  {
    key: "toolOutput",
    transform: "truthy",
    requires: { key: "pipelineCard", oneOf: AGENT_TOOL_FAMILY_PIPELINE_CARDS },
    note: "工具卡族",
  },
  {
    key: "unsupported",
    transform: "boolean",
    requires: { key: "pipelineCard", oneOf: AGENT_TOOL_FAMILY_PIPELINE_CARDS },
    note: "工具卡族：harness 未接上游旗标",
  },
  {
    key: "requiredCapability",
    transform: "truthy",
    requires: { key: "pipelineCard", oneOf: AGENT_TOOL_FAMILY_PIPELINE_CARDS },
    note: "工具卡族：缺失能力标识",
  },
  {
    key: "directorSessionId",
    transform: "truthy",
    requires: { key: "pipelineCard", oneOf: ["director"] },
    note: "导演台族（pipelineCard=director）：缺指针＝还原出空壳导演台",
  },
  {
    key: "planName",
    transform: "defined",
    requires: { key: "pipelineCard", oneOf: ["director"] },
    note: "导演台族：明确 null（无方案）也是语义",
  },
  { key: "shotCount", transform: "number", requires: { key: "pipelineCard", oneOf: ["director"] }, note: "导演台族" },
  { key: "healthOk", transform: "boolean", requires: { key: "pipelineCard", oneOf: ["director"] }, note: "导演台族" },
  { key: "revision", transform: "number", requires: { key: "pipelineCard", oneOf: ["director"] }, note: "导演台族" },
  { key: "sceneCard", transform: "truthy", note: "3D 场景卡整族透传（导入卡只带 glb_path，全族皆小指针无 SVG 级重料）" },
  { key: "directorStageId", transform: "truthy", note: "3D 舞台参考溯源（漏传＝还原后回分镜指针消失）" },
  { key: "shotId", transform: "truthy", note: "3D 舞台参考溯源镜号（漏传＝还原后镜号消失）" },
  { key: "episodeId", transform: "truthy", note: "集归属（漏传＝还原后按集换模型漏掉这些格）" },
  { key: "storyboardShot", transform: "storyboardShot", note: "分镜 21 栏整族透传（逐栏截 STORYBOARD_SNAPSHOT_FIELD_CHARS）" },
  // 单镜旁白文本＋双音轨（漏传＝还原后旁白与音轨锚消失，门禁 audio_anchor_present/dialogue_alignment 卡死）
  { key: "narration", transform: "truthy", note: "单镜旁白文本" },
  { key: "dialogueAudioId", transform: "truthy", note: "对白音档资产 id（锚优先来源）" },
  { key: "narrationAudioId", transform: "truthy", note: "旁白音档资产 id" },
  { key: "audioAnchorId", transform: "truthy", note: "音轨锚（相容键）＝dialogueAudioId || narrationAudioId" },
  { key: "shotCandidates", transform: "truthy", note: "分镜候选集＋星标（漏传＝还原后抽卡结果与采用稿消失）" },
  { key: "storyboardScene", transform: "truthy", note: "分镜场景归属" },
  { key: "characterCardIds", transform: "idList", note: "分镜卡引用（漏传＝还原后卡引用消失）" },
  { key: "sceneCardIds", transform: "idList", note: "分镜卡引用" },
  { key: "propCardIds", transform: "idList", note: "分镜卡引用" },
  { key: "entityCardId", transform: "truthy", note: "落卡幂等标记" },
  { key: "emitsEntity", transform: "emitsEntity", note: "模板实体宣告（漏传＝还原后一卡都落不成）" },
  { key: "input", transform: "cardName", note: "卡名来源键①" },
  { key: "characterName", transform: "cardName", note: "卡名来源键②" },
  { key: "sceneName", transform: "cardName", note: "卡名来源键③" },
  { key: "fontSize", transform: "fontSize", note: "文本节点字号（漏传＝回旧会话字号回 14.5）" },
  { key: "gateConfirm", transform: "gateConfirm", note: "协作确认闸凭据（漏传＝重载后按不下批准）" },
  { key: "approval", transform: "approval", note: "分镜批准状态（漏传＝重载后批准态翻面）" },
  {
    key: "taskVersions",
    transform: "truthy",
    note: "任务版本史＋标签＋选中（P1-9/D37；漏传＝还原后重跑版本史与采用稿消失）",
  },
];

/** B 应透传的键名清单。 */
export const AGENT_METADATA_FIELD_KEYS: readonly string[] = AGENT_METADATA_FIELDS.map((f) => f.key);

// ─────────────────────────────────────────── B：截断预算（有理由的清单）

/**
 * content 触发截断的字数门槛（**值与既有 runtime 逐字相同，2026-09-25 只做单源化**）。
 * 超过则只留前 `AGENT_CONTENT_TRUNCATE_KEEP` 字＋省略号。
 */
export const AGENT_CONTENT_TRUNCATE_TRIGGER = 240;
/** content 超预算时保留的字数。 */
export const AGENT_CONTENT_TRUNCATE_KEEP = 120;
/** prompt 无条件截断后保留的字数。 */
export const AGENT_PROMPT_TRUNCATE_KEEP = 120;

/** 一条截断预算（供测试以行为断言验证宣告与实作一致）。 */
export interface AgentTruncationBudget {
  readonly key: string;
  /** 触发门槛；null ＝无条件截断到 keepChars。 */
  readonly triggerAt: number | null;
  readonly keepChars: number;
  readonly reason: string;
}

/**
 * B 的截断清单。**理由**：上行快照要过 `agent/sessions/[id]/canvas-state` 的 512KB 上限
 * （`route.ts:15`），base64/长文会顶爆；agent 读的是「画布状态」不是原文，
 * 需要全文时用工具读真值。
 */
export const AGENT_TRUNCATION_BUDGETS: readonly AgentTruncationBudget[] = [
  {
    key: "content",
    triggerAt: AGENT_CONTENT_TRUNCATE_TRIGGER,
    keepChars: AGENT_CONTENT_TRUNCATE_KEEP,
    reason: "content 可能是交付 URL 或长正文；超 240 字只留前 120 字＋省略号（agent 需要原图时走工具读）",
  },
  {
    key: "prompt",
    triggerAt: null,
    keepChars: AGENT_PROMPT_TRUNCATE_KEEP,
    reason: "prompt 无条件截 120 字（提示词全文对「画布状态」判读无增益，且可能夹带长文本）",
  },
];

// ─────────────────────────────────────────── B：显式排除清单（有理由）

/**
 * 排除理由的分类（机器可读，供报告与裁定）：
 *   · `intentional`     —— 刻意排除，有明确设计理由（如 SVG 级重料）。
 *   · `suspected-gap`   —— 有**被读的消费端**，B 不透传＝回旧会话/换装置还原后功能退化。
 *                          这是待暴君裁定的真缺口（本档只登记，不改 runtime 语义）。
 *   · `dormant`         —— A 放行但全库查无 metadata 读者；透传缺一暂无可观察后果。
 */
export type AgentExclusionVerdict = "intentional" | "suspected-gap" | "dormant";

/** 一条排除：为何这个耐久键刻意不进 agent 上行快照。 */
export interface AgentFieldExclusion {
  readonly key: string;
  readonly reason: string;
  readonly verdict: AgentExclusionVerdict;
  /** 消费端/判据证据（档案:行 或 grep 结论），供覆核。 */
  readonly evidence: string;
}

/**
 * A 放行、但 B **刻意不透传**的键。每一个都必须有理由（测试会读出来断言非空）。
 *
 * 排除清单**不得说谎**：列在这里的键若实际上被 B 透传（存活），契约测试会红
 * （`findStaleAgentExclusions`），所以不能靠「把键全列进排除」把破口洗白。
 */
export const AGENT_EXCLUDED_METADATA_FIELDS: readonly AgentFieldExclusion[] = [
  {
    key: "negativePrompt",
    reason: "介面宣告键，但全库查无 metadata 读者（生成入口读的是 request body.negative_prompt）",
    verdict: "dormant",
    evidence: "grep 'metadata?.negativePrompt' 零命中；src/app/api/canvas/generate/route.ts:136 读 body.negative_prompt",
  },
  {
    key: "quality",
    reason: "Config 卡「质量」行读它；不透传＝还原后 Config 卡少一行",
    verdict: "suspected-gap",
    evidence: "src/components/canvas/node-view/NodeBody.tsx:584",
  },
  {
    key: "kind",
    reason: "Config 卡「类型」行读它；不透传＝还原后 Config 卡少一行",
    verdict: "suspected-gap",
    evidence: "src/components/canvas/node-view/NodeBody.tsx:586",
  },
  {
    key: "source_image",
    reason: "Config 卡「参考图」行＋重生成带 sourceImage；不透传＝还原后 edit/upscale 节点丢失来源",
    verdict: "suspected-gap",
    evidence: "src/components/canvas/node-view/NodeBody.tsx:587；src/components/canvas/embed/use-canvas-generation.ts:318",
  },
  {
    key: "errorDetails",
    reason: "失败人话渲染；不透传＝还原后错误节点只剩通用错误态",
    verdict: "suspected-gap",
    evidence: "src/components/canvas/node-view/NodeBody.tsx:226（errorDetailsText）",
  },
  {
    key: "naturalWidth",
    reason: "重生成尺寸提示（与 naturalHeight 成对）；不透传＝还原后尺寸提示消失",
    verdict: "suspected-gap",
    evidence: "src/components/canvas/embed/use-canvas-generation.ts:344-345",
  },
  {
    key: "naturalHeight",
    reason: "同 naturalWidth（成对使用）",
    verdict: "suspected-gap",
    evidence: "src/components/canvas/embed/use-canvas-generation.ts:344-345",
  },
  {
    key: "cost_hint",
    reason: "生成卡「预估 N 币」徽章；不透传＝还原后预估花费消失",
    verdict: "suspected-gap",
    evidence: "src/components/canvas/CanvasNodeView.tsx:240/503",
  },
  {
    key: "imageTaskId",
    reason: "canvas-event-settler 以 task_id 对帐落地；不透传＝还原后在飞节点无法被 SSE 结算（卡在 pending）",
    verdict: "suspected-gap",
    evidence: "src/hooks/canvas/canvas-event-settler.ts:120/131/148",
  },
  {
    key: "startedAt",
    reason: "介面宣告键，但全库查无 metadata.startedAt 读者（同名栏位散见于 tool registry/job repository，非节点 metadata）",
    verdict: "dormant",
    evidence: "grep 'metadata?.startedAt' 零命中",
  },
  {
    key: "progress",
    reason: "NodeBody 进度条＋批次聚合读它；不透传＝还原后在飞节点失去进度（暂态，重载即过）",
    verdict: "suspected-gap",
    evidence: "src/components/canvas/node-view/NodeBody.tsx:218-219；src/lib/canvas/batch-utils.ts:59",
  },
  {
    key: "topViewSvg",
    reason: "SVG 级重料（可达 48KB×2）会顶爆 512KB 上行快照；agent 用 director 工具读工程真值、不读 SVG",
    verdict: "intentional",
    evidence: "canvas-chat-types.test.ts:14 已钉死；NodeBody.tsx:670 读者存在（靠 directorSessionId 拉 /director/state 补）",
  },
  {
    key: "cameraViewSvg",
    reason: "同 topViewSvg（成对的 SVG 级重料）",
    verdict: "intentional",
    evidence: "canvas-chat-types.test.ts:14 已钉死；NodeBody.tsx:671",
  },
];

/** 排除清单的键名（供测试列举）。 */
export const AGENT_EXCLUDED_METADATA_FIELD_KEYS: readonly string[] = AGENT_EXCLUDED_METADATA_FIELDS.map(
  (e) => e.key,
);

// ─────────────────────────────────────────── 契约检查器（供测试／CI 用）

/** 一个通道破口：耐久键既没被 B 透传、也没被显式排除（或排除条目无理由）。 */
export interface AgentChannelGap {
  readonly key: string;
  readonly reason: string;
}

/**
 * 找出「A 放行、B 却既不透传也不排除」的键。
 *
 * 这是本模组的存在理由：把「两份手工键集合要同步」从注释约定升级成**可执行判据**。
 * 参数全部可注入（测试用注入清单构造「新增键未同步」的案例，不必改源码）。
 */
export function findAgentChannelGaps(
  durable: readonly DurableFieldSpec[],
  transmittedKeys: readonly string[],
  exclusions: readonly AgentFieldExclusion[],
): AgentChannelGap[] {
  const transmitted = new Set(transmittedKeys);
  const excluded = new Map(exclusions.map((e) => [e.key, e]));
  const gaps: AgentChannelGap[] = [];
  for (const field of durable) {
    if (transmitted.has(field.key)) continue;
    const exclusion = excluded.get(field.key);
    if (!exclusion) {
      gaps.push({ key: field.key, reason: "耐久键未列入 agent 透传清单，且未列入显式排除清单（双白名单漏一端）" });
      continue;
    }
    if (!exclusion.reason.trim()) gaps.push({ key: field.key, reason: "排除清单条目没有理由（不许静默排除）" });
  }
  return gaps;
}

/**
 * 找出**说谎的排除条目**：已被 B 透传（实际存活）却仍列在排除清单，或根本不是耐久键。
 * 用途＝防止「把键全塞进排除清单」把 `findAgentChannelGaps` 洗白。
 */
export function findStaleAgentExclusions(
  durable: readonly DurableFieldSpec[],
  transmittedKeys: readonly string[],
  exclusions: readonly AgentFieldExclusion[],
): AgentFieldExclusion[] {
  const durableKeys = new Set(durable.map((f) => f.key));
  const transmitted = new Set(transmittedKeys);
  return exclusions.filter((e) => transmitted.has(e.key) || !durableKeys.has(e.key));
}
