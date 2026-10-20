import type { ApprovalState } from "../character-cards";
import type { AgentInteractionMode } from "../agent-chat-client";
import type { AssetScope, AssetShareRecord } from "../asset-scope";

/**
 * 21 栏名称，**顺序即 AID 契约顺序**（逐字取自 `doc/提示词开发指南.md` §分镜脚本 输出栏位表）。
 * 型别由本常数推导（`StoryboardShotField`），所以名称或顺序改动会同时改到型别——不会漂移。
 */
export const STORYBOARD_SHOT_FIELDS = [
  "shotNumber",
  "scriptContent",
  "visualDescription",
  "dialogue",
  "actionState",
  "narrativeFunction",
  "timeOfDay",
  "eraCoordinate",
  "dateCoordinate",
  "weather",
  "referenceAssets",
  "shotSize",
  "cameraAngle",
  "focalLength",
  "cameraMovement",
  "composition",
  "atmosphere",
  "colorTone",
  "lighting",
  "exposureBlur",
  "soundEffect",
] as const;

export type StoryboardShotField = (typeof STORYBOARD_SHOT_FIELDS)[number];

/** 一镜的 21 栏（全字串；空值 = `""`）。 */
export type StoryboardScriptShot = { readonly [K in StoryboardShotField]: string };

/**
 * 单栏长度上限（字元）。
 * 用途：`aid_storyboard` 对应栏位是 `text`（64KB byte），本站要过
 * `agent/sessions/[id]/canvas-state` 的 512KB 快照与 Blob 存档，故收敛到 20000 字/栏。
 * 刻意**不逐栏设不同上限**：21 栏各自一套数字 = 21 个漂移点；单一上限已远大于
 * AID 实务值（正文片段／画面描述／台词 ≤15 字），正常分镜不会触发。
 */
export const MAX_STORYBOARD_FIELD_CHARS = 20000;

/**
 * 上行快照（`compactMetadataForAgent`）的单栏上限。
 * 为何不是 20000（本档 `MAX_STORYBOARD_FIELD_CHARS`）：单镜 21 栏 × 20000 = 420KB，
 * 一颗节点就顶爆 `canvas-state` 的 512KB（`route.ts:15`）。4000 字/栏已远大于 AID 实务值
 * （`scriptContent` 是保序切片后的一段正文、`dialogue` ≤15 字、`visualDescription` 一段），
 * 21 栏 × 4000 ≈ 84KB 是理论上界、实务单镜约 1-2KB。
 *
 * **残余风险（诚实标记）**：截断只发生在「上行给 agent 的快照」这一层；Blob 正规存档
 * （`saveCanvasProject` → `normalizeProject`，nodes 原样透传）永远是全形值。但 agent 若把
 * 读到的截断值再经 `canvas_apply_ops` 写回，会覆盖真值——与 `canvas-project-sync.ts:168`
 * 记录的 episodes 写回风险同型。当前判据：4000 字远大于实务值，触发机率近零；
 * 若未来出现 >4000 字的单栏，改法应是「整镜不进快照」而非继续截。
 */
export const STORYBOARD_SNAPSHOT_FIELD_CHARS = 4000;

// ─────────────────────────────────────────── 场景外壳（AID 根结构 `scenes[].sceneName`）

/**
 * 场景外壳：挂在 Group 节点 metadata。
 * AID 根结构 = `{"scenes":[{"sceneName":"…","shots":[...]}]}`；本站 Group 节点承载
 * `sceneName`（场景归属的唯一权威，取代已废的 `sceneCode`），一镜一 shot 挂子节点。
 * `shotCount` 是给卡面显示的冗余指针，真值永远在子节点（不在此存 shots，避免双真源）。
 */
export interface StoryboardSceneRef {
  /** 场景名（AID 规则：必须逐字选自可用场景资产）。 */
  sceneName: string;
  /** 本场镜数（显示用指针）。 */
  shotCount: number;
}

// ─────────────────────────────────────────── referenceAssets 解析

/**
 * `referenceAssets` 结构化结果（AID 格式：`场景:[图名] 角色:[图名]、… 道具:[图名]`）。
 * 名称取自资产库，未命中者 AID 后端会剔除；本站解析只做结构化，不做资产存在性判定。
 */
export interface StoryboardReferenceAssets {
  scene: string[];
  character: string[];
  prop: string[];
}

// ─────────────────────────────────────────── storyboard_qc_17 门禁输入桥接

/**
 * `storyboard_qc_17`（VPS `workspace/.opencode/tools/storyboard_qc_17.ts`）的输入栏位名。
 * **注意**：门禁的栏名与 AID 21 栏**完全不同名**——门禁吃的是成片阶段口径
 * （`shotId/order/sceneId/prompt/durationSeconds/characterCardIds/sceneCardIds/keyframeId/
 * lastFrameId/audioAnchorId/aspectRatio`），21 栏是编剧阶段口径（`shotNumber/
 * scriptContent/visualDescription/…`）。不经本桥接直接喂 21 栏 → 门禁全门 block。
 */
export interface StoryboardQcShot {
  shotId: string;
  order: number;
  /** 生图/视频描述。21 栏无对应「画师 prompt」栏（AID 的 `image_prompt` 由画师 agent 另产），回退 `visualDescription`。 */
  prompt: string;
  sceneId?: string;
  durationSeconds?: number;
  characterCardIds: string[];
  sceneCardIds: string[];
  /**
   * 道具卡 id（本场镜头引用的道具资产，2026-09-24 加成栏位）。
   * **刻意不在 `QC_REQUIRED_FIELDS` 内**（见该常数上方注）：道具是加成不是门槛，
   * 缺道具不得让门禁 block。门禁读到不认得的键时忽略，故多带此键对 17 门判定零影响。
   */
  propCardIds: string[];
  /**
   * 本镜旁白文本（2026-09-30 加成栏位；单一镜的旁白，供旁白 TTS 逐镜合成对齐）。
   * 结构性动机：分镜过去无旁白栏 → 旁白 TTS 只能整段合成、无法按镜对齐
   * （记忆 `tts-multiline-narration-p2-bug`）。本栏是**加成栏位**：有则更好、无则不罚。
   * **刻意不在 `QC_REQUIRED_FIELDS` 内**（见该常数上方注）：我方 21 栏契约无旁白栏、AID 的
   * `dialogue` 也不是旁白（见 `productionFieldsFromContext`「刻意不做的推导」），一旦列为门槛，
   * 全部既有镜次会瞬间多一项 missing＝纯回归。门禁 `storyboard_qc_17` 读具名栏位、未知键忽略
   * → 本键对 17 门判定零影响。只在呼叫端供给时出现（不补默认值）。
   */
  narration?: string;
  keyframeId?: string;
  lastFrameId?: string;
  audioAnchorId?: string;
  aspectRatio?: string;
  /**
   * 本镜的分镜确认状态（决策 24：新建的分镜审查面板与资产面板同构，**与资产侧同一个 shape**）。
   * 缺省＝已批准（决策 23 存量相容）；只在呼叫端供给时出现（不补默认值）。
   * **不在 `QC_REQUIRED_FIELDS` 内**：门槛栏位清单一个字不加，否则全镜次瞬间多一项 missing。
   * 门禁 `storyboard_qc_17` 读具名栏位、未知键忽略 → 本键对 17 门判定零影响。
   */
  approval?: ApprovalState;
}

/**
 * 成片阶段栏位（21 栏契约无法供应，须由呼叫端提供；缺者列进 `missing` 并由门禁自行 block）。
 * 键 = `shotNumber`（AID 镜号三位数）。
 */
export interface StoryboardQcProductionFields {
  sceneId?: string;
  durationSeconds?: number;
  prompt?: string;
  characterCardIds?: string[];
  sceneCardIds?: string[];
  /** 道具卡 id（`kind === "prop"` 逐字命中；加成栏位，不入 `QC_REQUIRED_FIELDS`）。 */
  propCardIds?: string[];
  /** 本镜旁白文本（单一镜的旁白；**加成栏位**，不入 `QC_REQUIRED_FIELDS`——有则更好、无则不罚）。 */
  narration?: string;
  keyframeId?: string;
  lastFrameId?: string;
  audioAnchorId?: string;
  aspectRatio?: string;
  /**
   * 本镜的分镜确认状态（决策 24：分镜审查面板的载体，**与资产侧同一个 shape**）。
   * 缺省＝已批准（决策 23 存量相容）；只在呼叫端供给时出现（不补默认值）。
   * **不在 `QC_REQUIRED_FIELDS` 内**：门槛栏位清单一个字不加（加了＝全镜次多一项 missing）。
   */
  approval?: ApprovalState;
}

export interface StoryboardQcBridgeResult {
  shots: StoryboardQcShot[];
  /** 仍有镜次缺的成片阶段栏位名（诚实回报，不补假值；门禁据此 block 是预期行为）。 */
  missing: string[];
  /** 全镜成片阶段栏位齐备（唯一可以宣告「门禁可望 17/17」的条件）。 */
  complete: boolean;
}

/**
 * 「缺了就列进 `missing`」的**门槛栏位**清单（门槛语义 = 缺 → `missing` → 门禁 block）。
 *
 * **刻意不含 `propCardIds`（2026-09-24 裁定，勿加）**：`missing` 会让 `storyboard_qc_17`
 * 门禁把该镜 block。现存所有镜次都没有 `propCardIds`，一旦把道具卡列为门槛栏位，
 * **全部镜次会瞬间多一项 missing**（门禁分数从 11/17 起直接再掉）＝纯回归，不是新能力。
 * 道具卡是**加成栏位**：它照样出现在 `StoryboardQcShot` 输出上（与
 * `characterCardIds`/`sceneCardIds` 同构）、照样有 `unresolvedProps` 诚实回报未命中的道具名，
 * 但**不参与** `missing` / `complete` 的判定——有则更好，无则不罚。
 *
 * **同样刻意不含 `narration`（2026-09-30 裁定，勿加）**：旁白是同一类**加成栏位**——只有呼叫端
 * 供给时才出现在输出上，未供给既不补默认值也不进 `missing`。理由同道具卡（加了＝全镜次多一项
 * missing＝纯回归）；且我方 21 栏契约无旁白栏、无合法推导来源（见下方「刻意不做的推导」）。
 */
export const QC_REQUIRED_FIELDS = [
  "sceneId",
  "durationSeconds",
  "characterCardIds",
  "sceneCardIds",
  "keyframeId",
  "lastFrameId",
  "audioAnchorId",
  "aspectRatio",
] as const;

// ─────────────────────────────────────────── 上下文 → 成片阶段栏位（G5 合法推导）

/**
 * 卡索引最小形：只吃解析需要的三栏。
 * **刻意不 import `character-cards.ts`**：`canvas/types.ts:19` 已 type-only import 本档，
 * 反向 import 会成环；本档维持「纯常数 + 纯函式、零依赖」。呼叫端传 `CharacterCard[]`
 * 结构相容（`id`/`name`/`kind` 三栏，见 `character-cards.ts:39-41`）。
 */
export interface StoryboardQcCardRef {
  id: string;
  name: string;
  kind: string;
  /**
   * REQ-B2 作用域（可选）。缺省＝personal（本帐号所有项目可用）。
   * 只在 `options.scope` 给了上下文时生效；未给＝既有行为逐位不变（零回归）。
   */
  scope?: AssetScope;
  /**
   * 资产批准状态（2026-09-24，**与 `CharacterCard.approval` 同一个 shape**，
   * 型别真源在 `./character-cards`）。缺省＝已批准（决策 23）。
   * 只在协作档当门槛（见 `filterApprovedShotCardIds`）。
   */
  approval?: ApprovalState;
}

/**
 * REQ-B2 作用域裁决上下文（可选）。给了它＝卡清单与 `project.cardIds` 都先过
 * `canUseAsset`（= `resolveAssetVisibility` 的唯一入口）：跨项目、未显式分享的卡
 * **不可见即不可用**——不进锁定集合、不进注入上下文，另在 `outOfScopeCardIds` 如实回报。
 */
export interface StoryboardQcScopeContext {
  viewerUserId: number;
  /** 当前项目 id；null＝无项目上下文（项目归属的卡一律不可用，个人卡照用）。 */
  projectId: string | null;
  shares: readonly AssetShareRecord[];
}

/** 每镜每栏的**值来源**（合法推导的可审计痕迹；缺者不在表内，改进 `missing`）。 */
export type StoryboardQcFieldSource = "production" | "referenceAssets" | "nodeSize" | "nodeMetadata";

/**
 * 分镜节点 metadata 的最小形（**结构相容 `CanvasNodeMetadata`，不 import**）。
 * 为何不 import `canvas/types.ts`：该档已 type-only import 本档（`types.ts:19`），反向 import
 * 会成环；本档维持「纯常数 + 纯函式、零依赖」（同 `StoryboardQcCardRef` / `StoryboardQcNodeRef` 范式）。
 *
 * `size` 语义不变（canvas 的 `size` 就是交付比例，见 ③ 条推导）。三个卡 id 栏（2026-09-24 新增）
 * 的真源是 agent 自动落卡后回填进节点 metadata 的引用——**粗（可能把该模板产出的卡全填上）**，
 * 因此推导优先序刻意排在 `referenceAssets`（编剧逐字指名）之后。
 *
 * `audioAnchorId`（2026-09-30 新增）**有真生产者**：逐镜配音（`storyboard-voiceover`）把
 * `dialogueAudioId || narrationAudioId` 写回节点 metadata；本栏供 `productionFieldsFromContext`
 * 第 ⑤ 条在呼叫端未供给时把它喂进门禁的 `audio_anchor_present`/`dialogue_alignment`。
 */
export interface StoryboardQcShotNodeMetadata {
  size?: unknown;
  /** 本镜引用的实体卡 id（canvas 节点 metadata；真源见 `CanvasNodeMetadata`）。 */
  characterCardIds?: unknown;
  sceneCardIds?: unknown;
  propCardIds?: unknown;
  /**
   * 本镜的音轨锚 id（2026-09-30 新增；节点 metadata 的相容键
   * `CanvasNodeMetadata.audioAnchorId` = `dialogueAudioId || narrationAudioId`，写入者 =
   * `storyboard-voiceover` 逐镜配音回写）。**单值语义**（同 `size`，非卡 id 的集合语义）：
   * 同镜多节点取首个非空，矛盾则整个不给——音轨锚是单一交付物，猜不得。
   */
  audioAnchorId?: unknown;
}

/**
 * 推导上下文。**每个栏位只在有真实来源时才生成**，缺者一律留在 `missing`（不补默认值）。
 *
 * - `production`：呼叫端已有的成片阶段栏位（最高优先，覆盖一切推导）
 * - `cards`：卡实体清单（唯一真源 = `character-card-store.listCharacterCards`，
 *   `src/lib/character-card-store.ts:122`）。**只用于名称→id 解析**，不背书卡的存在性判定
 * - `shotMetadata`：每镜节点 metadata（键 = `shotNumber`）。用两族栏位：
 *   `size` 一栏推 `aspectRatio`（③）；`characterCardIds`/`sceneCardIds`/`propCardIds` 三栏推
 *   同名成片栏位（⑤，**只在 `production` 与 `referenceAssets` 都没供给时才生效**）；
 *   `audioAnchorId` 一栏推同名成片栏位（⑤，2026-09-30；**单值语义**，只在 `production` 未供给时生效）
 * - `locked*CardIds`：专案级锁定卡（真源 = `CanvasProject.cardIds`，`src/lib/canvas/types.ts:356`）
 */
export interface StoryboardQcContext {
  production?: Readonly<Record<string, StoryboardQcProductionFields>>;
  cards?: readonly StoryboardQcCardRef[];
  shotMetadata?: Readonly<Record<string, StoryboardQcShotNodeMetadata>>;
  lockedCharacterCardIds?: readonly string[];
  lockedSceneCardIds?: readonly string[];
  segmentDurationSeconds?: number;
  /**
   * 互动档位（型别真源 = `AgentInteractionMode`，`src/lib/agent-chat-client.ts:749`）。
   * **只有 `"collaborate"` 会让批准闸（第 ⑥ 条）生效**；未给 = `preset`/`auto` 待遇 =
   * 既有行为逐位不变（决策 2：全自动档零改动、不停不阻塞＝护城河）。
   */
  mode?: AgentInteractionMode;
}

/** ratio 形状（`9:16`）。**只认已显式是比例的栏位**，不把像素尺寸换算成比例（见 `productionFieldsFromContext` 注）。 */
export const RATIO_SHAPE = /^\d+:\d+$/;

// ─────────────────────────────────────────── 资产批准闸（档位相关，2026-09-24）

/** 分镜的三条卡引用栏（键名 = `storyboard_qc_17` 门禁栏名；本档唯一清单，勿另立）。 */
export const SHOT_CARD_ID_FIELDS = ["characterCardIds", "sceneCardIds", "propCardIds"] as const;

export interface StoryboardQcContextFields {
  /** 键 = `shotNumber`；值只含**真的有来源**的栏位（呼叫端 production 覆盖推导值）。 */
  fields: Record<string, StoryboardQcProductionFields>;
  /** 键 = `shotNumber` → 栏位 → 值来源（审计迹；无来源栏位不出现，改进 `missing`）。 */
  sources: Record<string, Record<string, StoryboardQcFieldSource>>;
  /**
   * 键 = `shotNumber` → 被批准闸挡下的卡 id（**只在协作档且真的有挡到时出现**）。
   * 为何要回报：被挡下的 id 不进 `fields`（连带该栏进 `missing`），若不同时回报，
   * 呼叫端只看到「凭空少了一张卡」＝无法解释，正是本闸要修的「不明不白」病灶。
   */
  blockedCardIdsByShot?: Record<string, string[]>;
}

// ─────────────────────────────────────────── 专案上下文 → 桥接上下文（G5 接线）

/**
 * 专案侧最小形（**结构相容 `CanvasProject`，不 import**）：只吃推导真正需要的两个栏位。
 * 为何不 import `canvas/types.ts`：该档已 type-only import 本档（`types.ts:19`），反向 import
 * 会成环；本档维持「纯常数 + 纯函式、零依赖」。
 */
export interface StoryboardQcProjectRef {
  /** 专案级锁定卡 id（真源 = `CanvasProject.cardIds`，`src/lib/canvas/types.ts:356`）。 */
  cardIds?: readonly string[];
  /** 节点清单（真源 = `CanvasProject.nodes`）；只用 `metadata.size` 一栏推比例。 */
  nodes?: readonly StoryboardQcNodeRef[];
}

/** 节点侧最小形（结构相容 `CanvasNode`）：用 `metadata` 的 `size`、卡 id 三栏与镜号。 */
export interface StoryboardQcNodeRef {
  /**
   * 节点 id（真源 = `CanvasNode.id`）。**只**供 `affectedShotNodesByCardIds` 回报
   * 「受影响的分镜节点 id」；缺省/非字串 → 不回报该节点（不臆造 id）。
   */
  id?: unknown;
  metadata?:
    | (StoryboardQcShotNodeMetadata & { storyboardShot?: { shotNumber?: unknown } | null })
    | null;
}

export interface StoryboardQcGateArgs {
  /** 本地判定逻辑（`runShortDramaTool("storyboard_qc_17", input)`，`shortdrama-domain/index.ts:411`）的输入。 */
  input: {
    shots: StoryboardQcShot[];
    lockedCharacterCardIds?: string[];
    lockedSceneCardIds?: string[];
    segmentDurationSeconds?: number;
  };
  /** VPS 工具 `storyboard_qc_17` 的 args（`shots` 与锁定 id 是 **JSON 字串**，见工具 schema）。 */
  toolArgs: {
    shots: string;
    locked_character_card_ids?: string;
    locked_scene_card_ids?: string;
    segment_duration_seconds?: number;
  };
  /**
   * 门禁输入缺项（栏位名）。**含两个门禁层输入**：`lockedCharacterCardIds`/`lockedSceneCardIds`
   *（缺 → 空集合 → `character_lock`/`scene_lock` 必 block）与 `segmentDurationSeconds`
   *（缺/≤0 → `segment_duration` 必 block）。诚实回报 = 不让「只是没填」被误读成「门禁过了」。
   */
  missing: string[];
  /** 所有门禁输入齐备（**不同于** `storyboardQcShots().complete`——后者只算镜栏位）。 */
  complete: boolean;
  sources: Record<string, Record<string, StoryboardQcFieldSource>>;
}
