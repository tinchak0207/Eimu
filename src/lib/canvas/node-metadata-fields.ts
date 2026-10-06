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
  { key: "content", cleaner: "string", note: "图片节点=交付 URL；文本节点=正文（全部卡型都读）" },
  { key: "prompt", cleaner: "string", note: "生成提示词；重生成与 Config 卡都读" },
  { key: "negativePrompt", cleaner: "string", note: "负面词（介面宣告键；目前全库查无 metadata 读者）" },
  { key: "model", cleaner: "string", note: "模型 id（Config 卡「模型」行）" },
  { key: "size", cleaner: "string", note: "尺寸/比例（Config 卡「尺寸」行；分镜 QC 的 nodeSize 推导也读）" },
  { key: "quality", cleaner: "string", note: "质量档（Config 卡「质量」行）" },
  { key: "count", cleaner: "finiteNumber", note: "生成张数（Config 卡「数量」行）" },
  { key: "kind", cleaner: "string", note: "生成物种类 image|video（Config 卡「类型」行）" },
  { key: "source_image", cleaner: "sourceImage", note: "edit/upscale 来源（节点行＋重生成带 sourceImage；null 亦为合法值）" },
  { key: "status", cleaner: "nodeStatus", note: "四态状态（gateway 词汇映射；节点配色与骨架渲染）" },
  { key: "errorDetails", cleaner: "errorDetails", note: "失败人话（节点 error 分支显示）" },
  { key: "naturalWidth", cleaner: "finiteNumber", note: "自然宽（重生成尺寸提示）" },
  { key: "naturalHeight", cleaner: "finiteNumber", note: "自然高（重生成尺寸提示）" },
  { key: "cost_coins", cleaner: "finiteNumber", note: "实际花费（节点徽章）" },
  { key: "cost_hint", cleaner: "finiteNumber", note: "预估花费（节点「预估 N 币」）" },
  { key: "imageTaskId", cleaner: "string", note: "生成任务 id（以 task_id 对帐落地）" },
  { key: "startedAt", cleaner: "finiteNumber", note: "开始时间戳（介面宣告键；目前全库查无 metadata 读者）" },
  { key: "progress", cleaner: "finiteNumber", note: "进度（节点进度条＋批次聚合）" },
  { key: "referenceRole", cleaner: "referenceRole", note: "reference 节点参考角色（只收六种合法角色值）" },
  { key: "pipelineCard", cleaner: "pipelineCard", note: "结构卡标记 tool|gate|note|director（渲染分支的总开关）" },
  { key: "toolId", cleaner: "string", note: "工具卡：工具 id" },
  { key: "toolInput", cleaner: "string", note: "工具卡：输入契约" },
  { key: "toolOutput", cleaner: "string", note: "工具卡：输出契约" },
  { key: "requiredCapability", cleaner: "string", note: "工具卡：缺失的上游能力标识" },
  { key: "unsupported", cleaner: "unsupportedFlag", note: "工具卡：未接上游旗标（truthy→true，boolean 形态）" },
  { key: "deliverable", cleaner: "string", note: "步骤头卡：产出合同全文" },
  { key: "gate", cleaner: "stringOrTrue", note: "验收门禁：string 全文 或 true（需人工批准的旗标），两形态并存" },
  { key: "directorSessionId", cleaner: "string", note: "导演台：会话 id（小视口据此拉 state）" },
  { key: "planName", cleaner: "nullableString", note: "导演台：当前方案名；明确 null＝「目前无方案」是语义，必须保留 null" },
  { key: "shotCount", cleaner: "finiteNumber", note: "导演台：活跃方案镜头数" },
  { key: "healthOk", cleaner: "booleanFlag", note: "导演台：分镜健康徽章（true/false 两态都要）" },
  { key: "topViewSvg", cleaner: "string", note: "导演台：俯视图 SVG 原文（>48KB 级重料；上行端不透传）" },
  { key: "cameraViewSvg", cleaner: "string", note: "导演台：镜头框图 SVG 原文（同上）" },
  { key: "revision", cleaner: "finiteNumber", note: "导演台：工程 revision（变更比对重拉）" },
  { key: "sceneCard", cleaner: "sceneCard", note: "3D 场景卡（底线 glb_path+scene_summary，其余四栏可选；缺底线整包丢）" },
  { key: "directorStageId", cleaner: "trimmedString", note: "3D 舞台参考溯源：来源 scene_3d 节点 id（缺＝无溯源，不写空壳）" },
  { key: "shotId", cleaner: "trimmedString", note: "3D 舞台参考溯源：所属镜号（分镜契约 shotId 口径）" },
  { key: "episodeId", cleaner: "trimmedString", note: "分镜的集归属（按集批次换模型的分组维度；缺＝不归任何一集）" },
  { key: "storyboardShot", cleaner: "storyboardShot", note: "分镜 21 栏契约（shotNumber 为空即整包丢）" },
  // ── 单镜旁白文本 ＋ 对白／旁白双音轨（2026-09-30；介面冻结四键）──
  // 病灶：`audioAnchorId` 在分镜生产契约（storyboard-contract.ts）里是**无生产者的宣告**，
  // 17 道门禁的 `audio_anchor_present`／`dialogue_alignment` 结构上永远不可能过（
  // shortdrama-domain/index.ts:448/450 逐镜读 `shot.audioAnchorId`）。本四键补上生产者。
  { key: "narration", cleaner: "string", note: "单镜旁白文本（旁白轨的文本；漏放行＝刷新后旁白消失，TTS 逐镜合成无输入）" },
  { key: "dialogueAudioId", cleaner: "string", note: "该镜对白音档资产 id（audioAnchorId 的锚优先来源；漏放行＝重载后对白轨消失）" },
  { key: "narrationAudioId", cleaner: "string", note: "该镜旁白音档资产 id（无对白轨时为锚；漏放行＝重载后旁白轨消失）" },
  { key: "audioAnchorId", cleaner: "string", note: "音轨锚（相容键）＝dialogueAudioId || narrationAudioId；音轨门禁读它" },
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
    note: "任务版本史＋标签＋星标选中（version＝任务时戳，同格重跑追加新版本、旧版本留著；漏放行＝刷新后版本史与采用稿消失）",
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
  { key: "content", transform: "content", note: "正文/交付 URL；超预算时截断" },
  { key: "prompt", transform: "prompt", note: "提示词；截 120 字（token 预算）" },
  { key: "model", transform: "truthy", note: "模型 id" },
  { key: "size", transform: "truthy", note: "尺寸/比例" },
  { key: "status", transform: "truthy", note: "四态状态（agent 读画布状态要知道谁在跑谁失败）" },
  { key: "referenceRole", transform: "truthy", note: "参考图角色（agent 知道这张图以什么身份参与）" },
  { key: "deliverable", transform: "truthy", note: "步骤产出合同（漏传＝下行还原后骨架失语义）" },
  { key: "gate", transform: "truthy", note: "验收门禁（string 全文 / true 旗标）" },
  { key: "count", transform: "number", note: "生成张数" },
  { key: "cost_coins", transform: "number", note: "实际花费" },
  { key: "pipelineCard", transform: "pipelineCard", note: "结构卡标记；四值枚举（未列举值照旧丢）" },
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
    note: "工具卡族：未接上游旗标",
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
  { key: "storyboardShot", transform: "storyboardShot", note: "分镜 21 栏整族透传（逐栏截断）" },
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
    note: "任务版本史＋标签＋选中（漏传＝还原后重跑版本史与采用稿消失）",
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

// （截断预算的宣告清单与审计/排除清单已移出本档：见 `./node-metadata-audit`。
//  理由＝本档会被 `layout.ts` 与 `canvas-chat-types.ts` import，整份资料会进客户端 bundle；
//  审计判定（verdict/reason/evidence）与档名:行号属内部信息，不得进客户端，故独立成非打包档。）
