// 画布指挥台：资料结构与 SSE 事件契约。
//
// 角色 owner：reference 节点的 referenceRole 直接引用 image-types 的
// ReferenceImageRole（type-only import），不建第二套枚举。
//
// 架构（暴君立场定稿 2026-08-12）：
//   deepseek（opencode agent）不思考画布的事。它只提交 image_* 生成请求。
//   VPS gateway 拦截每个 image_* 工具的参数与结果，自动产生「画布单元」，
//   并以 canvas.* 事件推送到前端。前端 reducer 接住事件自动渲染画布。
//
// 本档案 = 前端与后端共用的契约。任何改动必须同步两端。

import type { ReferenceImageRole } from "../image-types";
import type { StoryboardSceneRef, StoryboardScriptShot } from "../storyboard-contract";
import type { StoryboardShotCandidateSet } from "./storyboard-shots";
import type { TaskVersionSet } from "./task-versions";
import { AID_PROJECT_TYPE_ENUM, type AidProjectTypeEnumValue } from "../aid-enums/creation";
// 剧本型别（P1-5／D7）：值域直接取自既有 AID enum（见 CanvasProject.scriptType 的注解）。
import { type CanvasScriptType } from "./project-narration";
// 批准状态形状的单一真源（type-only：执行期零依赖，不成环——`storyboard-contract.ts`
// 已用同一写法 type-only import 本档，本档反向 type-only 取 `ApprovalState` 是同构先例）。
import type { ApprovalState } from "../character-cards";

// ─────────────────────────────────────────── 作品形态值域

/**
 * 作品形态值域：`movie`（电影）/ `series`（剧集）。
 *
 * 值域来源＝AID `ProjectTypeEnum`（`src/lib/aid-enums/creation.ts`，MIT 逐字入库）。
 * 本站的作品/剧集实体本身就是吞 AID 产品层刀 1 的产物，形态词汇不另立第二套——
 * 两处各写一份 `"movie" | "series"` 就是两个漂移点（AID 改值时本站默默不收）。
 *
 * 消费点：`CanvasProject.projectType`（落盘形状）与 `CanvasProjectMetaPatch.projectType`
 * （agent op 载荷）必须同值域，故共用本型别。
 */
export const CANVAS_PROJECT_TYPES = [
  AID_PROJECT_TYPE_ENUM.MOVIE.value,
  AID_PROJECT_TYPE_ENUM.SERIES.value,
] as const;

/** 作品形态（＝AID `ProjectTypeEnum` 的值集合）。 */
export type CanvasProjectType = AidProjectTypeEnumValue;

/**
 * 执行期判据。agent 载荷（SSE 反序列化）与 Blob 读回的值都不可信，一律过此；
 * 直接写 `v === "movie" || v === "series"` 则值域改动时必漏改一处。
 */
export function isCanvasProjectType(value: unknown): value is CanvasProjectType {
  return typeof value === "string" && (CANVAS_PROJECT_TYPES as readonly string[]).includes(value);
}

export type CanvasPosition = { x: number; y: number };

/** 平移 + 缩放，k = scale。 */
export type CanvasViewport = { x: number; y: number; k: number };

export enum CanvasNodeType {
  Image = "image",
  Text = "text",
  Config = "config",
  Video = "video",
  Group = "group",
  CharacterCard = "character_card",
  SceneCard = "scene_card",
  Audio = "audio",
  /** 提示词备忘节点：可直编文本，连到生成节点时文本注入为 prompt 前缀。 */
  Prompt = "prompt",
  /** 带角色的参考图节点：复用 ReferenceImageRole，连到生成节点时自动带图+角色。 */
  Reference = "reference",
  /**
   * 3D 导演台节点（2026-09-02 spec §5 片5）：gateway director.done 拦截同步，
   * metadata 带服务端预渲染 SVG 示意（topViewSvg/cameraViewSvg）与分镜摘要。
   */
  Director = "director",
  /**
   * 3D 场景卡（2026-09-06 Astra PRD P1-3）：3D 导演 subagent 出片落地位——
   * turntable 视频主体 + stills 缩图网格 + 资产下载（.blend/.glb），P1 只读+播放。
   * metadata 走 sceneCard 栏位族（Scene3dCardMetadata），双白名单铁律见
   * canvas-snapshot-compressor 记忆。
   */
  Scene3d = "scene_3d",
}

export type CanvasNodeStatus = "idle" | "success" | "loading" | "error";

/**
 * 错误详情物件形（2026-08-27 G-FE 合同）：gateway 对失败帧下发
 * `{ message, human_message }`——human_message 是给人看的中文短句，
 * message 是原文。旧载荷仍是纯字串，两形并存。
 */
export interface CanvasErrorDetails {
  message?: string;
  human_message?: string;
}

/** 错误详情 → 展示文字：带 human_message（中文短句）优先，缺省回落原文；空值回 undefined。 */
export function errorDetailsText(details: string | CanvasErrorDetails | undefined): string | undefined {
  if (typeof details === "string") return details.length > 0 ? details : undefined;
  if (!details) return undefined;
  const human = typeof details.human_message === "string" && details.human_message.length > 0 ? details.human_message : undefined;
  if (human !== undefined) return human;
  return typeof details.message === "string" && details.message.length > 0 ? details.message : undefined;
}

/**
 * 协作确认闸的裁决凭据（门禁卡 metadata.gateConfirm，2026-09-24）。
 * 写入者只有网关（workflow-gw 的 markGateNodeState），前端只读＋据此发一次
 * POST /api/agent/sessions/{session_id}/confirm（既有确认端点，不另开通路）。
 */
export interface CanvasNodeGateConfirm {
  /** 网关 pendingConfirms 的键（裁决凭据；同一笔重放是幂等的）。 */
  request_id: string;
  /** 站点转发用的会话键（= 网关 session id）。 */
  session_id: string;
  /** 卡面状态真值：pending 可批准/退回；approved/rejected 为已裁决（唯读）。 */
  status: "pending" | "approved" | "rejected";
}

/** 节点元资料：承载 prompt/模型/尺寸/任务/结果。与 gateway autoCreateCanvasUnit 产出对齐。 */
export interface CanvasNodeMetadata {
  content?: string; // 图片节点 = public URL；文本节点 = 正文
  prompt?: string;
  negativePrompt?: string;
  model?: string;
  size?: string;
  quality?: string;
  count?: number;
  kind?: string; // "image" | "video"
  source_image?: string | null; // edit/upscale 的来源 mediaId/URL
  status?: CanvasNodeStatus;
  errorDetails?: string | CanvasErrorDetails;
  naturalWidth?: number;
  naturalHeight?: number;
  cost_coins?: number;
  /** canvas.plan 的预估花费（单位币；C-FE）：实际 cost_coins 落地前，节点卡显示「预估 N 币」。 */
  cost_hint?: number;
  imageTaskId?: string;
  startedAt?: number;
  progress?: number;
  // P1-3: 镜头语言 metadata
  shot_size?: string; // 景别：特写/近景/中景/全景/远景
  camera_move?: string; // 运镜：固定/推进/拉远/摇镜/跟拍
  // P1: workflow 识别
  workflow_id?: string;
  session_id?: string;
  // P2: 角色卡/场景卡 metadata
  description?: string;
  key_features?: string[];
  role?: string;
  locked?: boolean;
  // P3: 批次 & 查阅 metadata
  referenceNodeIds?: string[];
  batchIndex?: number;
  batchTotal?: number;
  storageKey?: string;
  mimeType?: string;
  bytes?: number;
  /** 文本节点字号（px）；未设取 14.5。 */
  fontSize?: number;
  /** reference 节点的参考图角色（复用 ReferenceImageRole，不另立枚举）。 */
  referenceRole?: ReferenceImageRole;
  /**
   * 流水线结构卡标记（agent-template-canvas 铺的泳道卡）：step_head = 步骤头卡、
   * tool = 工具卡、gate = 门禁卡、note = 配方卡（后端 derived notes，正文=content）、
   * director = 导演台卡（gateway director.done 同步）。
   * 渲染层（NodeBody/CanvasNodeView）据此走结构化分层正文；与既有 kind（image/video）分开，不混用。
   */
  pipelineCard?: "step_head" | "tool" | "gate" | "note" | "director";
  /** 工具卡：工具 id（等宽字体渲染）。 */
  toolId?: string;
  /** 工具卡：输入/输出契约。 */
  toolInput?: string;
  toolOutput?: string;
  /** 工具卡：harness 未接 upstream（红色警示行，不冒充可用）。 */
  unsupported?: boolean;
  /** 工具卡：缺失的上游能力标识。 */
  requiredCapability?: string;
  /** 步骤头卡：本步产出合同全文。 */
  deliverable?: string;
  /**
   * 骨架节点：本步验收门禁一行（后端 workflow 骨架经 SSE canvas.node.created/updated
   * 带入；与 pipelineCard 的 "gate" 卡型别是两回事，勿混）。boolean 形态是
   * workflow-dsl 的既有契约（compile.ts md.gate = true——「需人工批准」旗标），
   * 两种写入者共用本栏位，string = 全文门禁、true = 仅标记需批准。
   */
  gate?: string | boolean;
  /**
   * 门禁卡可操作状态（2026-09-24 协作确认闸）：网关在协作档的停点注册 pending
   * confirm 后，把该笔确认回写到门禁卡 metadata，前端据此把「验收条件」从纯文字
   * 变成可直接批准/退回的卡（不必回对话里找确认卡）。
   * 只在协作档、且仅在该次停点未决期间存在——批准/退回后 status 翻面并保持可读；
   * 交付物变更（重生成/换图）会重新回到 pending（网关按交付物指纹记批准）。
   */
  gateConfirm?: CanvasNodeGateConfirm;
  /**
   * 分镜批准状态（2026-09-24 WS-审查：分镜审查面板的批准/驳回写进节点）。
   * 形状与卡侧**同一个** `ApprovalState`（`character-cards.ts`，type-only import 不建
   * 第二套）；清洗唯一收口＝`normalizeApprovalState`（读取端与上行端共用同一把尺）。
   *
   * ⚠️ 本键**必须同时**存在于两处 metadata 白名单，否则刷新/回旧会话即静默消失
   *（不是当下失效，是同会话内看起来正常、重载后退回「未批准」态）：
   *   - 读取/还原端 `src/lib/canvas/layout.ts` 的 `toNodeMetadata`
   *   - 上行/压缩端 `src/hooks/canvas/canvas-chat-types.ts` 的 `compactMetadataForAgent`
   *
   * 与同层 `gateConfirm`（网关门禁裁决凭据）是**两个独立键**：前者＝人对分镜交付物的
   * 批准，后者＝协作确认闸的 pendingConfirms 凭据；不合并、不互相推导。
   */
  approval?: ApprovalState;
  /** 步骤头卡：本步输入来源。 */
  inputFrom?: string;
  /** 步骤序号（生成卡顶栏 stepName 条）。 */
  stepIndex?: number;
  /** 步骤全名（生成卡顶栏）。 */
  stepName?: string;
  /** 生成卡：本步 requiredTools 的 id 清单（agent 执行轨迹）。 */
  toolIds?: string[];
  // ── director 节点（pipelineCard: "director"，gateway director.done 拦截同步）──
  /** 导演工程所属的 gateway 会话 id。 */
  directorSessionId?: string;
  /** 当前活跃方案名（无方案 / reset 后为 null）。 */
  planName?: string | null;
  /** 活跃方案的镜头数。 */
  shotCount?: number;
  /** 分镜健康：true 绿徽章，false 琥珀。 */
  healthOk?: boolean;
  /** 服务端预渲染俯视图（<svg> 原文；合计 >48KB 时省略）。 */
  topViewSvg?: string;
  /** 服务端预渲染镜头框图（<svg> 原文；合计 >48KB 时省略）。 */
  cameraViewSvg?: string;
  /** 导演工程 revision（gateway doc.revision 透传）：已挂载视口比对变化重拉 state。 */
  revision?: number;
  // ── 3D 场景卡节点（type: scene_3d，2026-09-06 Astra PRD P1-3；3D 导演 subagent 回传写入）──
  /** 3D 场景卡栏位族（单一物件栏位，内部形状 = Scene3dCardMetadata）。 */
  sceneCard?: Scene3dCardMetadata;
  // ── 3D 舞台参考的回分镜溯源（P1-1，2026-09-28）──
  /**
   * 本生成节点的参考图来自哪个 3D 导演台 stage＝`scene_3d` 节点 id。
   * 键名沿用 director 族 `directorSessionId` 的 `<domain>Id` 形；值域＝节点 id 字串。
   * 写入者＝生成时 `resolveSceneDirectorReferences` 配对的 trace（scene-3d-reference.ts）；
   * **双白名单**：漏 `layout.toNodeMetadata` 或 `canvas-chat-types.compactMetadataForAgent`
   * 任一处＝刷新/回旧会话后指针凭空消失（与 sceneCard 同族铁律）。
   */
  directorStageId?: string;
  /**
   * 本生成所属镜号（`storyboard-contract` 生产形 `StoryboardShotProduction.shotId`
   * 口径＝`shotNumber`，上限 16 字）；无分镜归属＝缺席。
   * 与 `directorStageId` 成对＝回分镜可追溯指针；清洗规则同族。
   */
  shotId?: string;
  // ── 集归属（P1-2，2026-09-29；按集批次换模型／批次重跑的唯一分组维度）──
  /**
   * 本分镜属于哪一集＝`CanvasProject.episodes[].id`（`CanvasEpisode.id`，types.ts 的
   * 三级状态机第二层）。键名沿用同族 `<domain>Id` 形（`directorStageId`/`directorSessionId`）。
   *
   * **现场缺口如实记录**：画布没有 parent 边、场景外壳只带 `sceneName`、
   * `CanvasNodeMetadata` 原本无任何集栏位 ⇒ 分镜→集无法推导，故以本栏位明示。
   * 缺席＝不归任何一集（`storyboard-episode-batch.ts` 不猜、不按节点序切段）。
   * **双白名单**：漏 `layout.toNodeMetadata` 或 `compactMetadataForAgent` 任一处
   * ＝刷新/回旧会话后集归属消失（按集换模型会静默漏掉这些格）。
   */
  episodeId?: string;
  // ── 分镜级抽卡（P1-2，2026-09-29；对称差 D9「一分镜 ≤4 条＋星标选定」）──
  /**
   * 本镜的候选集＋星标选中者（形状＝`StoryboardShotCandidateSet`，真源
   * `./storyboard-shots.ts`）。**刻意不是新增多个候选节点**：一镜仍是一颗节点，
   * 候选集挂在此处，`selectedId` 就是采用稿。
   *
   * 清洗端＝`normalizeShotCandidates`（`id`+`prompt` 缺一即丢该条、同 id 去重、
   * 截到 `SHOT_CANDIDATE_LIMIT`、`selectedId` 必须是成员、空集合＝省略键）。
   * **双白名单**：与 `storyboardShot` 同族铁律。
   */
  shotCandidates?: StoryboardShotCandidateSet;
  // ── 任务版本＋标签＋选中（P1-9，对称差 D37；2026-09-29）──
  /**
   * 本格的任务版本史 ＋ 星标选中的那一版（形状＝`TaskVersionSet`，真源
   * `./task-versions.ts`）。**刻意不是「任务节点」**：一「格」＝一颗节点，同一格重跑
   * ＝追加一笔**新版本**（`items[].version` ＝任务时戳，ISO 8601 UTC），旧版本原样留著。
   *
   * `items[].tags` 值域＝`TASK_TAGS`（`main_image`/`main_video`，D37 字面）；
   * `selectedVersion` ＝素材 `Selected`（该版 `url` 即本格采用稿）。
   * 清洗端＝`normalizeTaskVersions`（`version` 解析不出即丢该笔、同版去重、按时序升序、
   * 裁到上限、`selectedVersion` 非成员即不收、空集合＝省略键）。
   *
   * **双白名单**：与 `shotCandidates` 同族铁律——漏 `layout.toNodeMetadata` 或
   * `canvas-chat-types.compactMetadataForAgent` 任一处＝刷新/回旧会话后版本史与采用稿消失。
   */
  taskVersions?: TaskVersionSet;
  // ── 单镜旁白文本 ＋ 对白／旁白双音轨（2026-09-30；`audioAnchorId` 的生产者）──
  /**
   * 单镜旁白**文本**（编剧/agent 写入；`storyboard-shots.bindShotAudioTrack` 只读不覆盖）。
   * **不是音档**：它是 TTS 逐镜合成的输入，不构成「配音就绪」。
   * **双白名单**：与 `shotCandidates` 同族铁律（真源 `node-metadata-fields.ts`）——
   * 漏一端＝刷新/回旧会话后旁白文本消失，逐镜 TTS 无输入。
   */
  narration?: string;
  /**
   * 该镜对白音档的资产 id（音轨锚 `audioAnchorId` 的优先来源）。
   * **双白名单**：与 `narration` 同族——漏一端＝重载后对白轨消失。
   */
  dialogueAudioId?: string;
  /** 该镜旁白音档的资产 id（无对白轨时为锚）。白名单规则同 `dialogueAudioId`。 */
  narrationAudioId?: string;
  /**
   * 音轨锚（**相容键**）＝`dialogueAudioId || narrationAudioId`；门禁
   * `audio_anchor_present`/`dialogue_alignment` 逐镜读它。白名单规则同 `dialogueAudioId`。
   */
  audioAnchorId?: string;
  // ── 分镜实体（2026-09-15 刀 2；AID 21 栏契约，MIT）──
  /**
   * 一镜（AID 21 栏契约，`src/lib/storyboard-contract.ts`）：挂在 Group 节点的子节点。
   * 形状 = `StoryboardScriptShot`（21 个字串栏，空值 = ""）。读取端以
   * `normalizeStoryboardShot` 收敛——`shotNumber` 为空则整包丢弃（不制造半形分镜）。
   */
  storyboardShot?: StoryboardScriptShot;
  /**
   * 场景外壳：挂在 **Group 节点**，`sceneName` 是场景归属唯一权威
   *（AID v2.1.4 已废 `sceneCode`）。真值 = 子节点的 `storyboardShot`，此处只存指针。
   */
  storyboardScene?: StoryboardSceneRef;
  // ── 分镜实体的卡引用（WS7 收口，2026-09-24；照 referenceNodeIds 的同款 id 阵列先例）──
  /**
   * 本镜引用的角色卡 id（agent 模板交付自动落卡后回填；项目级锁定在 `CanvasProject.cardIds`）。
   * 写入者：自动回填（agent-output-cards 的 shotBackfill）+ 人工/上游指定。
   * **双白名单**：与 storyboardShot 同族——漏 layout.ts toNodeMetadata 或
   * canvas-chat-types.ts compactMetadataForAgent 任一处 = 刷新/回旧会话后凭空消失。
   */
  characterCardIds?: string[];
  /** 本镜引用的场景卡 id。清洗/白名单规则同 `characterCardIds`。 */
  sceneCardIds?: string[];
  /** 本镜引用的道具卡 id。清洗/白名单规则同 `characterCardIds`。 */
  propCardIds?: string[];
  /** 本节点交付物自动落成的卡 id（幂等标记：同一节点不重复建卡）。 */
  entityCardId?: string;
  // ── 模板交付自动落卡（WS11 收口，2026-09-24；保留键，型别层具名）──
  /**
   * 本节点交付物自动落成的实体标记（保留键）。真源＝gateway 模板节点的
   * `defaults.emitsEntity`（`deploy-staging/gateway/workflow-templates/*`），
   * `expandTemplate` spread 进节点 metadata 后随 SSE `canvas.node.created/updated` 落地；
   * 画布侧据此自动建卡（`src/lib/agent-output-cards.ts` 的 `emittedEntityOf`）。
   *
   * ⚠️ 这个键必须**同时**存在于两处 metadata 白名单，否则**一进前端就被剥掉**
   *（不是重载才消失，是当下就没了）：
   *   - 读取/还原端 `src/lib/canvas/layout.ts` 的 `toNodeMetadata`
   *   - 上行/压缩端 `src/hooks/canvas/canvas-chat-types.ts` 的 `compactMetadataForAgent`
   * 症状是「整条功能完全没反应」，排查时先确认键有没有活过这两处。
   *
   * 形状与 `layout.ts` 的 `EmittedEntityMetadata`（＝`agent-output-cards.ts` 的
   * `EmittedEntitySpec` 同构）结构相容。五值字面与 `character-cards.ts` 的
   * `CHARACTER_CARD_KIND_VALUES` **逐字同步，刻意不 import 以避免环依赖**
   *（types → character-cards → agent-chat-client → agent-chat-types → types；
   * 措辞同 `layout.ts` 的 `EMITS_ENTITY_KINDS`——本档是前后端共用契约根，
   * 不反向依赖客户端卡模组）。漂移时会在本栏位的指派点炸型别错，不静默。
   */
  emitsEntity?: {
    kind: "character" | "scene" | "style" | "prop" | "audio";
    /** 卡名来源：预设节点标题；`"input"` ＝依序取底下三键的第一个非空值。 */
    nameFrom?: "nodeTitle" | "input";
    /**
     * 参考图来源 role 清单（模板作者宣告；四视图＝`["view2","view3","view4"]`）：
     * 同模板实例上哪些 role 的交付物是本实体的参考图。
     * 清洗走 `layout.ts` 的 `cleanEmitsEntity`（非空字串阵列、trim、去重、≤8 项、单项 ≤100）。
     */
    referenceRoles?: string[];
    /**
     * 参考图来源**节点 id** 清单（引擎 `expandTemplate` 的参考图 post-pass 解出；
     * 站点据此把兄弟节点的交付图并进同一张卡——四视图聚合的站点侧接线）。
     * 与 `referenceRoles` 同一个清洗函式（漏放行＝聚合功能当下被剥，不是重载才消失）。
     */
    referenceNodeIds?: string[];
  };
  /**
   * 落卡取卡名的来源（保留键；仅在 `emitsEntity.nameFrom === "input"` 时被读）。
   * 顺序真源＝`agent-output-cards.ts` 的 `NAME_FROM_INPUT_KEYS`（input → characterName
   * → sceneName），空字串/非字串在读取端就被省略键。
   * `input` 是通用键名，但 canvas 节点 metadata 只有本语义（与同层的 `inputFrom`
   * ＝步骤头卡输入来源、`toolInput`＝工具卡契约是**不同键**），故在此具名收敛。
   */
  input?: string;
  characterName?: string;
  sceneName?: string;
}

/**
 * 3D 场景卡 metadata 形状。**两条生产者**：
 *   - `source: "director"`（或未标）＝ 3D 导演 subagent 回传写入（`blender-delegate.ts`），
 *     六栏全形；卡面 turntable 播放器 ＋ stills 网格 ＋ 资产下载。
 *   - `source: "import"` ＝ 用户从本机导入的 GLB/GLTF（`scene-3d-import.ts` ＋
 *     `/api/canvas/scene-3d`），只保证 `glb_path`；卡面只出 GLB 视口与下载，
 *     **缺的栏位整块不渲染**（不给空播放器/空网格）。
 *
 * 契约底线（清洗端 `toScene3dCard` 的整包丢弃判据）：`glb_path` 与 `scene_summary`
 * 非空才算一张场景卡——导入卡也不例外（`scene_summary` 必须是**真实**来源文字，
 * 不许编造场景描述）。`turntable_url` / `stills_urls` / `blend_path` / `duration_ms`
 * 为**可选**栏位（2026-09-27 本机导入刀放宽；导演卡仍永远给全六栏）。
 *
 * 铁律（canvas-snapshot-compressor 事故教训）：本栏位族必须同步两处白名单——
 * 读取端 toNodeMetadata（layout.ts）与上行压缩端 compactMetadataForAgent
 * （canvas-chat-types.ts），漏一端 = 刷新后栏位凭空消失；往复合同测试钉死。
 */
export interface Scene3dCardMetadata {
  /** turntable 旋转展示视频（mp4/webm 可播放 URL）。导演卡必给；导入卡无此栏。 */
  turntable_url?: string;
  /** 渲染静帧缩图（3-6 张，卡内网格展示）。导演卡必给；导入卡无此栏。 */
  stills_urls?: string[];
  /** .blend 源档下载路径。导演卡必给；导入卡无此栏。 */
  blend_path?: string;
  /** .glb 交换格式下载路径（**契约底线，两条来源都必填**）。 */
  glb_path: string;
  /** 场景摘要（一句话，副标题展示）。**必填**：导入卡写真实来源（如「从本机导入的 GLB」）。 */
  scene_summary: string;
  /** turntable 时长（ms；无值时播放器自带 duration 显示）。导入卡无此栏。 */
  duration_ms?: number;
  /** 卡片来源：`director`＝3D 导演 subagent 六栏全形；`import`＝本机导入的 GLB。 */
  source?: "director" | "import";
}

export interface CanvasNode {
  id: string;
  type: CanvasNodeType;
  title: string;
  position: CanvasPosition;
  width: number;
  height: number;
  metadata?: CanvasNodeMetadata;
  /** 手动拖动过 = 不再参与自动排版（用户掌控位置） */
  moved?: boolean;
  /** 批次父节点：子节点 id 列表 */
  batchChildren?: string[];
  /** 批次是否展开（收起时只显示主图片） */
  batchExpanded?: boolean;
  /** 批次主图片节点 id（缩图/封面） */
  batchPrimaryImageId?: string;
  /**
   * 软删除标记（2026-09-27 节点版本历史＋回退）：ISO 时间戳，有值＝已软删。
   *
   * 软删的节点**不进** reducer 的可见 `nodes`（改收进 `deletedNodes`），呼叫端语义
   * （列表不含、连线断开）与旧的硬删一致；差别是资料还在，可经
   * `POST /api/canvas/nodes/restore` 或 `restoreCanvasNodes` 还原。
   * 节点级栏位（不是 metadata）：不进 metadata 双白名单，不会被 `toNodeMetadata` 剥掉。
   */
  deletedAt?: string;
}

/**
 * 节点版本快照的落版原因（2026-09-27 节点版本历史＋回退）：
 *   · created   —— agent/模板首次落节点
 *   · generated —— 生成完成（status → success / 交付 URL 落地）
 *   · edited    —— 内容编辑（文本直编提交、改名、prompt 改写）
 *   · metadata  —— 非内容的 metadata 更新（模型/尺寸/角色…）
 *   · revert    —— 由某一版回退产生的新版本（版本历史是**追加式**，回退本身也留痕）
 */
export type CanvasNodeVersionReason = "created" | "generated" | "edited" | "metadata" | "revert";

/**
 * 节点版本快照（2026-09-27）：一次「内容变更」＝一版。
 *
 * 「内容」＝ `title` ＋ `metadata`（纯资料面）。座标/尺寸/连线**不进版本**——
 * 它们是版面状态不是内容，回退一版不该把节点搬回旧位置（版面权在前端 reducer）。
 *
 * 持久化：挂在既有 `CanvasProject.nodeVersions`（不新增 DB/档案）；上限由
 * `node-versions.ts` 的 `MAX_NODE_VERSIONS_PER_NODE` 逐节点裁剪。
 */
export interface CanvasNodeVersion {
  /** 同一节点内 1 起、单调递增（append-only，回退也 +1）。 */
  version: number;
  nodeId: string;
  createdAt: string;
  reason: CanvasNodeVersionReason;
  /** 该版快照的节点标题。 */
  title: string;
  /** 该版快照的节点 metadata（深拷贝，不与当前节点共用参考）。 */
  metadata: CanvasNodeMetadata;
}

export interface CanvasConnection {
  id: string;
  fromNodeId: string;
  toNodeId: string;
}

/** 自动制画布的「画布单元」：一次生成请求 = 文本节点 + 配置节点 + 结果图片节点。 */
export interface CanvasUnit {
  unitId: string;
  tool: string;
  nodes: CanvasNode[];
  connections: CanvasConnection[];
  /** canvas.plan 带的预估花费（单位币）；node.created 时盖章到该单元的生成卡 metadata.cost_hint。workflow 计画（tool 以 "workflow:" 开头）例外——它是整图总额，只进侧栏不逐卡盖章。 */
  costHint?: number;
}

// ─────────────────────────────────────────── SSE 事件契约（gateway → 前端）

/** canvas.plan — 一次生成请求的计画卡。 */
export interface CanvasPlanEvent {
  unit_id: string;
  tool: string;
  label: string;
  prompt: string;
  model: string;
  size: string;
  count: number;
  kind: string;
  source_image: string | null;
  cost_hint: number | null;
}

/** canvas.node.created — 前端建一个节点。target_kind="result" 表示结果预留节点。 */
export interface CanvasNodeCreatedEvent {
  unit_id: string;
  node: CanvasNode;
  target_kind?: "result";
}

/** canvas.node.updated — 更新节点（通常是结果落地）。 */
export interface CanvasNodeUpdatedEvent {
  unit_id: string;
  node_id: string;
  patch: Partial<CanvasNodeMetadata> & { status?: CanvasNodeStatus };
  url?: string;
  cost_coins?: number;
}

/** canvas.node.connected — 建一条连线。 */
export interface CanvasNodeConnectedEvent {
  unit_id: string;
  connection: CanvasConnection;
  target_kind?: "result";
}

/** canvas.node.disconnected — 断一条连线。 */
export interface CanvasNodeDisconnectedEvent {
  unit_id: string;
  from: string;
  to: string;
}

/** gateway 自动制画布可能送出的全部 canvas 事件。 */
export type CanvasSseEvent =
  | { name: "canvas.plan"; data: CanvasPlanEvent }
  | { name: "canvas.node.created"; data: CanvasNodeCreatedEvent }
  | { name: "canvas.node.updated"; data: CanvasNodeUpdatedEvent }
  | { name: "canvas.node.connected"; data: CanvasNodeConnectedEvent }
  | { name: "canvas.node.disconnected"; data: CanvasNodeDisconnectedEvent }
  | { name: "canvas.node.generating"; data: { unit_id: string; node_id: string; status: string; progress?: number } }
  | { name: "canvas.node.deleted"; data: { unit_id: string; node_id?: string } }
  | { name: "canvas.derive.started"; data: { unit_id: string; source_node_id: string; instruction: string; interpretation?: string } }
  | { name: "canvas.budget.updated"; data: { unit_id?: string; used_coins: number; remaining_coins: number } }
  | { name: "canvas.ops"; data: CanvasAgentOpsEvent };

export const CANVAS_EVENT_NAMES = [
  "canvas.plan",
  "canvas.node.created",
  "canvas.node.updated",
  "canvas.node.connected",
  "canvas.node.disconnected",
  "canvas.node.generating",
  "canvas.node.deleted",
  "canvas.derive.started",
  "canvas.budget.updated",
  "canvas.ops",
] as const;

// ─────────────────────────────────────────── Agent 操作画布（Wave C）

/**
 * 专案级栏位补丁（作品类型 / 流程步 / 剧集清单）。
 *
 * 形状刻意与 `useCanvasChat().setProjectMeta` 的参数同构——那是这三栏的**唯一写入口**
 * （`projectType`/`currentStep`/`episodes` 在 `CanvasProject` 顶层，不在 reducer state）。
 * 载荷一律不可信：执行前必须过 `normalizeProjectMetaPatch`（layout.ts）逐栏白名单。
 */
export interface CanvasProjectMetaPatch {
  projectType?: CanvasProjectType;
  currentStep?: number;
  episodes?: CanvasEpisode[];
  /**
   * 专案级风格绑定（P1-8／对称差 D34）：`StyleTemplate.id`（值域唯一真源＝`STYLE_LIBRARY`，
   * 清洗见 `project-style.ts` 的 `normalizeProjectStyleId`）。型别是宽的 string 是因为
   * 载荷不可信——合法性一律在执行/落盘前判，非法值省略该键（同其余三栏语义）。
   */
  styleId?: string;
  /**
   * 剧本型别（P1-5／对称差 D7）：值域与清洗同 `CanvasProject.scriptType`
   * （`project-narration.ts` 的 `normalizeProjectNarration`）。型别是宽的 string 是因为
   * 载荷不可信——合法性一律在执行/落盘前判，非法值省略该键（同其余栏语义）。
   */
  scriptType?: string;
  /** 旁白音色（P1-5／对称差 D7）：`voice-library` 认可的 id；未知不落键。 */
  narrationVoice?: string;
}

/**
 * Agent 批量画布操作：gateway 的 canvas_apply_ops 工具经 SSE 下发，
 * 前端一到即自动执行（画布操作自动化，无人工确认闸）后把结果 POST 回 gateway resolve 该工具调用。
 * 与 infinite-canvas 的 8-op DSL 对齐，执行语义全在前端 reducer。
 *
 * 唯一例外：`set_project_meta`（2026-09-16 G1）改的是**专案级**栏位，不是画布结构，
 * 由 hook 层的 `setProjectMeta` 执行（同 select_nodes / set_viewport / run_generation 的分工）。
 */
export type CanvasAgentOp =
  | { type: "add_node"; node: Partial<CanvasNode> & { id: string; type: CanvasNodeType | string } }
  | { type: "update_node"; id: string; patch: { title?: string; position?: CanvasPosition; width?: number; height?: number; metadata?: Partial<CanvasNodeMetadata> } }
  | { type: "delete_nodes"; ids: string[] }
  | { type: "connect_nodes"; connections: { fromNodeId: string; toNodeId: string }[] }
  | { type: "delete_connections"; ids: string[] }
  | { type: "select_nodes"; ids: string[] }
  | { type: "set_viewport"; viewport: Partial<CanvasViewport> }
  | { type: "run_generation"; node_id: string; prompt?: string; model?: string; size?: string; count?: number }
  /**
   * 专案级栏位补丁（2026-09-16 G1，刀 1 全链最后一环）：
   * `CanvasProject.currentStep/episodes/projectType` 在专案顶层，先前 8 个 op 无一可达
   * （PRD 全链定义「agent 调用 canvas_apply_ops 写入 episode 节点成功」的缺口）。
   * 执行端 = hook 层 `setProjectMeta`；载荷清洗 = `normalizeProjectMetaPatch`。
   */
  | { type: "set_project_meta"; patch: CanvasProjectMetaPatch }
  /**
   * 节点版本回退（2026-10-03，人机共笔「版本回退」落地）：把该节点内容还原到指定版
   * （`version` 省略＝回上一版）。语义完全复用 reducer 的 `revert_node`（`applyNodeVersion`
   * 只还原 title+metadata，座标/尺寸不动；回退本身也 append 一版 reason="revert"，可再被回退）。
   * 与 `update_node` 的分工：update_node 写新值；本 op 回到旧值——版本史住在画布端，
   * agent 不必先把旧 metadata 抄进上下文。执行端＝adapter 的 agent_ops 分派（同一次 dispatch）。
   */
  | { type: "revert_node"; nodeId: string; version?: number };

export interface CanvasAgentOpsEvent {
  request_id: string;
  ops: CanvasAgentOp[];
  /** 一句话意图（agent 提供）。 */
  label?: string;
}

// ─────────────────────────────────────────── 画布专案（云端持久化）

export interface CanvasProject {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  nodes: CanvasNode[];
  connections: CanvasConnection[];
  viewport: CanvasViewport;
  backgroundMode: "dots" | "lines" | "blank";
  budget?: { totalCoins: number; usedCoins: number };
  /** P2 跨镜头一致性：锁定到本画布的角色/场景卡 id（CharacterCard.id）。 */
  cardIds?: string[];
  // ── 作品/剧集三级状态机（2026-09-15 吞 AID 产品层刀 1；全部 optional，向后相容）──
  /** 作品类型：movie=电影（剧本用 episode 0）/ series=剧集。 */
  projectType?: CanvasProjectType;
  /** 7 步流程当前步骤（1..7）；未开始则 undefined。 */
  currentStep?: number;
  /** 剧集分集清单（电影留空）。 */
  episodes?: CanvasEpisode[];
  /**
   * 专案级风格绑定（P1-8／对称差 D34）：`StyleTemplate.id`（见 `@/lib/style-library`）。
   *
   * 对应对手 `CreateProject.VisualPromptId`——风格 id 是**专案建立时的一等参数**，
   * 不是只在 skill/prompt 层的当次选择；生成时由 `project-style.ts` 把 id 展开成
   * 对手 `VisualMeta.VisualStyle` 那样的全文素材。**缺省＝无绑定，旧专案零改动**；
   * 注册表查不到的 id 不落盘（`normalizeProject` 逐栏白名单省略该键）。
   */
  styleId?: string;
  /**
   * 剧本型别（P1-5／对称差 D7）：`plot`（剧情演绎）｜`monologue`（真人解说漫＝**解说剧**）。
   *
   * 对应对手「AI Short drama」／「AI Commentary Drama」两种型别。值域**不另立**，
   * 逐字取自既有 `AID_SCRIPT_TYPE_ENUM`（`@/lib/aid-enums/creation`）——该 enum 早就
   * 定义了这两型，只是全 repo 没有任何消费端（这正是 D7 说「零命中」的形状）。
   * **缺省＝未宣告，旧专案零改动**；值域外的一律不落盘（`normalizeProject` 逐栏白名单省略该键）。
   */
  scriptType?: CanvasScriptType;
  /**
   * 旁白音色（P1-5／对称差 D7）：对应对手的「narration voice configuration item」。
   *
   * 值域＝`voice-library.ts` 的语音库（`normalizeVoiceId`，与 `POST /v1/tts/generations`
   * 的 `voice` 同一把尺）——避免出现「专案里设了某音色、合成时被 400 voice_unknown」的假设定。
   * **只在 `scriptType === "monologue"` 时生效**；其他型别绑了＝冲突，
   * 由 `narrationVoiceConflicts` 具名回报（不静默忽略、也不代用户清掉）。
   * 缺省＝用上游预设音色（`DEFAULT_TTS_VOICE`），不假装绑了某一颗。
   */
  narrationVoice?: string;
  /**
   * 节点版本历史（2026-09-27）：所有节点的版本快照，按节点＋版号检索。
   * 挂在既有专案物件上（不新增 DB/档案）；逐节点上限见 node-versions.ts。
   * 旧专案无此栏＝空历史，向后相容。
   */
  nodeVersions?: CanvasNodeVersion[];
  /**
   * 画布作用域（2026-09-27 片P 刀 1）：`personal`（缺省）＝个人画布，
   * 落 `canvas/<userId>/…`；`team`＝团队共享画布，落 `canvas/team/<teamId>/…`，
   * 该团队所有成员可读同一份（读路径合并），写入仍为单写（普通 PUT，后写覆盖，
   * 刻意不做锁／CRDT／冲突解决）。
   *
   * **向后相容**：旧专案无此栏 ⇒ 一律视为 personal，路径逐字不变。
   * 专案级栏位（不是节点/metadata）——不进 metadata 双白名单，不会被 toNodeMetadata 剥掉
   *（同款先例：节点级 `deletedAt`／`nodeVersions`）。
   *
   * `teamId` 是**服务端盖章**的权威值（来源＝控制面 team-membership 查询），
   * 客户端送来的 teamId 不采信（见 team-canvas-gate.ts）。
   */
  scope?: "personal" | "team";
  /** 团队画布所属团队 id（仅 scope="team" 时有意义；由服务端以已验成员身份盖章）。 */
  teamId?: string;
}

/**
 * 剧集分集（作品 → 剧集 → 分镜的第二层）。
 *
 * 轮子来源：gzxx-2025/aid-server（MIT License，Copyright (c) 2026 光子讯息(杭州)科技有限公司）
 * 源档：sql/aid-init.sql 的 `aid_comic_episode` 表 + `aid_comic_script.original_text`
 * 取得日：2026-09-15
 * 逐字保留：episode_no（→ episodeNo）/ comic_title（→ title）/ original_text（→ script）
 * 白名单改写（仅两处）：
 *   1. 砍掉 AID 的审核三态 —— EpisodeStatusEnum 六态（0草稿/1制作中/2完成未审核/3审核中/
 *      4审核通过/5审核失败）在本站收敛为 `draft | processing | finished`（本站无审核队列）。
 *   2. 剔除 pending_*（待审栏位）/ comic_desc / comic_cover_url / gen_mode / creation_mode /
 *      del_flag / create_by / update_by / remark。
 */
export interface CanvasEpisode {
  id: string;
  /** 集号，1 起整数。 */
  episodeNo: number;
  title: string;
  /** 完成状态（砍 AID 审核三态）。 */
  status: "draft" | "processing" | "finished";
  /** 该集剧本原文（对应 aid_comic_script.original_text）。 */
  script?: string;
  createdAt: string;
  updatedAt: string;
}

// ─────────────────────────────────────────── 节点预设尺寸

export const CANVAS_NODE_DEFAULT_SIZE: Record<CanvasNodeType, { width: number; height: number; title: string }> = {
  [CanvasNodeType.Image]: { width: 340, height: 240, title: "图片" },
  [CanvasNodeType.Text]: { width: 340, height: 240, title: "文本" },
  [CanvasNodeType.Config]: { width: 440, height: 240, title: "生成配置" },
  [CanvasNodeType.Video]: { width: 420, height: 236, title: "视频" },
  [CanvasNodeType.Group]: { width: 760, height: 480, title: "组" },
  [CanvasNodeType.CharacterCard]: { width: 340, height: 280, title: "角色卡" },
  [CanvasNodeType.SceneCard]: { width: 340, height: 280, title: "场景卡" },
  [CanvasNodeType.Audio]: { width: 340, height: 240, title: "音频" },
  [CanvasNodeType.Prompt]: { width: 340, height: 200, title: "提示词" },
  [CanvasNodeType.Reference]: { width: 300, height: 260, title: "参考图" },
  [CanvasNodeType.Director]: { width: 420, height: 300, title: "导演台" },
  [CanvasNodeType.Scene3d]: { width: 420, height: 360, title: "3D 场景卡" },
};

// ─────────────────────────────────────────── 批次 & 资源参考

/** 资源参考：节点关联的可查阅资源（图片/音讯等）。 */
export interface CanvasResourceReference {
  nodeId: string;
  kind: string; // 资源种类，如 "image" | "audio"
  label: string;
  title: string;
  previewUrl?: string;
  text?: string;
  active: boolean;
}

/** 批次操作指令：前端对批次父节点的本地操作。 */
export type CanvasBatchOperation =
  | { type: "add_child"; childId: string; imageUrl: string }
  | { type: "set_primary"; childId: string }
  | { type: "delete_child"; childId: string }
  | { type: "toggle_expanded" };
