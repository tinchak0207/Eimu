// 分镜层产能（P1-2，对称差 D9；2026-09-29）。
//
// 补的两个缺口（**不重写既有分镜契约**，只在其上加一层可编辑产物）：
//
//   ① 分镜级抽卡＋星标（D9 逐字：「一分镜 **≤4 条**；**星标选定**」）。
//      资料形状刻意**不是**「把候选摊平成多个节点」——一镜仍是一颗节点（identity 仍是
//      `metadata.storyboardShot.shotNumber`，见 `storyboard-contract.normalizeStoryboardShot`），
//      候选集就挂在该节点 metadata 的 `shotCandidates`（`{ items, selectedId }`）：
//         · `items`      —— 候选清单（每条自带交付 URL/模型/状态）
//         · `selectedId` —— **星标**选中的那一条＝本格的采用稿
//      语义上等同画布既有的批次族（父节点 `batchChildren` ＋ `batchPrimaryImageId` 选主图），
//      但**不新增节点**、不改动那条既有轮子；选中者被删时回退到剩余第一条——与 reducer
//      的批次主图回退规则（`reducer.ts` 的 `batchPrimaryImageId: kept[0]`）同款语义。
//
//   ② prompt 回溯（D9 逐字：「**`T` 回溯生成用 prompt**」）。
//      每条候选自带 `prompt`＝**产生它用的那一份 prompt**（键名照现场既有约定用 `prompt`，
//      不另立词表），可经 `shotCandidatePrompt` / `shotRerunRequest` 读回重跑。
//      没有 prompt 的候选在清洗端就整条丢弃（回溯是本功能的存在理由，不是选配）。
//
// 另外附分镜层的增删复制重排（决策表逐字「含……＋分镜增删复制重排」）。顺序真源＝清单阵列序，
// 与门禁桥接的既有推导同源（`storyboard-contract.storyboardQcShots`：`order ← 阵列序`）——
// **刻意不改 `shotNumber`**：它是镜的唯一键（QC 的 `shot_identity`、卡引用回填都吃它），
// 重排改的是位置不是身份。
//
// 双白名单铁律：`shotCandidates` 必须同时存在于还原端 `layout.toNodeMetadata` 与上行端
// `compactMetadataForAgent` 两处白名单（真源＝`node-metadata-fields.ts`），漏一端＝
// 刷新/回旧会话后候选集与星标凭空消失且不报错（同 sceneCard / storyboardShot 家族病灶）。

import { usableAudioUrl } from "@/lib/agent-output-cards";
import { normalizeTaskVersions } from "./task-versions";
import type { CanvasNode, CanvasNodeMetadata, CanvasNodeStatus } from "./types";

// ─────────────────────────────────────────── 值域与上限

/** 一分镜的候选上限（D9 逐字「一分镜 ≤4 条」）。 */
export const SHOT_CANDIDATE_LIMIT = 4;

/** 候选 id 上限（同族薄键的既有限法，128 远大于实务）。 */
export const SHOT_CANDIDATE_ID_MAX = 128;

/**
 * 候选 prompt 的单栏上限（字元）。取 `STORYBOARD_SNAPSHOT_FIELD_CHARS` 同一把尺（4000）：
 * 该值是「上行快照的单栏预算」（`storyboard-contract.ts` 已对 21 栏用同一数字），
 * 一份候选 prompt 不该比一栏分镜正文还重；≤4 条 × 4000 ≈ 16KB，仍在节点 metadata 量级内。
 */
export const MAX_SHOT_CANDIDATE_PROMPT_CHARS = 4000;

/** 交付 URL / 模型 id 的单栏上限。 */
const SHOT_CANDIDATE_FIELD_MAX = 2048;

/** 生成状态值域（与节点 status 同一份，不另立第二套枚举）。 */
const CANDIDATE_STATUSES: readonly CanvasNodeStatus[] = ["idle", "success", "loading", "error"];

// ─────────────────────────────────────────── 资料形状

/**
 * 一条候选（一镜的一次抽卡结果）。每条都是**自带溯源的最小交付物**：
 * 没有它自己那一份 prompt，这条候选在产品语义上不成立（无法回溯、无法重跑）。
 */
export interface StoryboardShotCandidate {
  /** 候选 id（同一镜的候选集内唯一）。 */
  id: string;
  /** 产生本候选用的 prompt（`T` 回溯的唯一真源；空＝不成立，清洗端丢弃）。 */
  prompt: string;
  /** 产生本候选用的模型 id。 */
  model?: string;
  /** 交付物 URL（视频/图）。 */
  url?: string;
  /** 生成状态（沿用节点四态）。 */
  status?: CanvasNodeStatus;
  /** 生成时间（ISO 字串）。 */
  createdAt?: string;
  /** 若本候选另有落地节点，这里放它的节点 id（可选；缺席＝只存 metadata）。 */
  nodeId?: string;
}

/** 一镜的候选集＋星标选中者。 */
export interface StoryboardShotCandidateSet {
  /** 候选清单（≤ `SHOT_CANDIDATE_LIMIT`，首见序）。 */
  items: StoryboardShotCandidate[];
  /** 星标选中的候选 id（采用稿）；缺席＝尚未选定。 */
  selectedId?: string;
}

/** 一次候选集变更的结果（**诚实拒绝**：塞不下就明说，不静默丢弃）。 */
export interface ShotCandidateMutation {
  /** 变更后的集合（未接受时＝原集合的等值新物件，呼叫端不会拿到突变的旧物件）。 */
  set: StoryboardShotCandidateSet;
  accepted: boolean;
  /** 未被接受的原因（accepted=true 时缺席）。 */
  reason?: "full" | "invalid" | "duplicate";
}

// ─────────────────────────────────────────── 清洗（读取端／写入端共用）

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** trim 后非空才回字串（超长截断）。 */
function trimmed(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s ? s.slice(0, max) : undefined;
}

/** 单条候选清洗：`id` 与 `prompt` 缺一即丢（不制造没有溯源的半形候选）。 */
export function normalizeShotCandidate(raw: unknown): StoryboardShotCandidate | null {
  if (!isRecord(raw)) return null;
  const id = trimmed(raw.id, SHOT_CANDIDATE_ID_MAX);
  const prompt = trimmed(raw.prompt, MAX_SHOT_CANDIDATE_PROMPT_CHARS);
  if (!id || !prompt) return null;
  const model = trimmed(raw.model, SHOT_CANDIDATE_FIELD_MAX);
  const url = trimmed(raw.url, SHOT_CANDIDATE_FIELD_MAX);
  const createdAt = trimmed(raw.createdAt, SHOT_CANDIDATE_FIELD_MAX);
  const nodeId = trimmed(raw.nodeId, SHOT_CANDIDATE_FIELD_MAX);
  const status = CANDIDATE_STATUSES.includes(raw.status as CanvasNodeStatus)
    ? (raw.status as CanvasNodeStatus)
    : undefined;
  return {
    id,
    prompt,
    ...(model ? { model } : {}),
    ...(url ? { url } : {}),
    ...(status ? { status } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(nodeId ? { nodeId } : {}),
  };
}

/**
 * 候选集清洗（逐项白名单，照 `normalizeStoryboardShot` 的范式）：
 *   · 非物件 / 无 `items` 阵列 → `undefined`（省略键，不写空壳）
 *   · 逐条走 `normalizeShotCandidate`，非法条丢弃（不整包作废）
 *   · 同 id 去重（保留首见）→ 截到 `SHOT_CANDIDATE_LIMIT`
 *   · `selectedId` **必须是集合成员**才收（指向不存在者＝不制造悬空星标）
 *   · 清完是空集合 → `undefined`（没有候选＝没有这个键）
 */
export function normalizeShotCandidates(raw: unknown): StoryboardShotCandidateSet | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.items)) return undefined;
  const items: StoryboardShotCandidate[] = [];
  const seen = new Set<string>();
  for (const entry of raw.items) {
    const candidate = normalizeShotCandidate(entry);
    if (!candidate || seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    items.push(candidate);
    if (items.length >= SHOT_CANDIDATE_LIMIT) break;
  }
  if (items.length === 0) return undefined;
  const selectedId = trimmed(raw.selectedId, SHOT_CANDIDATE_ID_MAX);
  return {
    items,
    ...(selectedId && seen.has(selectedId) ? { selectedId } : {}),
  };
}

/** 节点 metadata → 候选集（缺键／空集合＝`null`，不制造半形候选集）。 */
export function readShotCandidates(
  metadata: CanvasNodeMetadata | undefined,
): StoryboardShotCandidateSet | null {
  return normalizeShotCandidates(metadata?.shotCandidates) ?? null;
}

/**
 * 候选集 → metadata patch（纯函式，呼叫端 `patchNodeMetadata` 直用）。
 * 空集合＝空 patch（不写空壳键，与 `sceneDirectorTraceMetadata` 同款诚实边界）。
 */
export function shotCandidatesMetadata(
  set: StoryboardShotCandidateSet | null | undefined,
): Pick<CanvasNodeMetadata, "shotCandidates"> {
  const normalized = normalizeShotCandidates(set);
  return normalized ? { shotCandidates: normalized } : {};
}

// ─────────────────────────────────────────── 抽卡：加／选／删

/** 集合的等值新物件（拒绝时回传，保证呼叫端拿不到可被误改的旧参考）。 */
function copySet(set: StoryboardShotCandidateSet): StoryboardShotCandidateSet {
  return {
    items: set.items.map((item) => ({ ...item })),
    ...(set.selectedId ? { selectedId: set.selectedId } : {}),
  };
}

/**
 * 加一条候选（抽卡）。
 *
 * 契约：
 *   · 脏条目（缺 id/prompt）→ `{ accepted:false, reason:"invalid" }`
 *   · 同 id → `duplicate`；已满 `SHOT_CANDIDATE_LIMIT` → `full`（**明说塞不下，不静默丢**）
 *   · 首条候选自动上星标（一镜要有采用稿；后续只加不抢星标——星标的移动只走
 *     `selectShotCandidate`，避免「抽到最后一条就自动换稿」这种隐式改稿）
 */
export function addShotCandidate(
  set: StoryboardShotCandidateSet | undefined,
  raw: unknown,
): ShotCandidateMutation {
  const current = set ? copySet(set) : { items: [] };
  const candidate = normalizeShotCandidate(raw);
  if (!candidate) return { set: current, accepted: false, reason: "invalid" };
  if (current.items.some((item) => item.id === candidate.id)) {
    return { set: current, accepted: false, reason: "duplicate" };
  }
  if (current.items.length >= SHOT_CANDIDATE_LIMIT) {
    return { set: current, accepted: false, reason: "full" };
  }
  return {
    set: {
      items: [...current.items, candidate],
      selectedId: current.selectedId ?? candidate.id,
    },
    accepted: true,
  };
}

/**
 * 星标选定（`T` 之外的「星标选定当前分镜视频」）：只有集合成员可被选中，
 * 非成员＝不改（`selected:false`，不制造悬空星标）。
 */
export function selectShotCandidate(
  set: StoryboardShotCandidateSet | undefined,
  candidateId: string,
): { set: StoryboardShotCandidateSet; selected: boolean } {
  const current = set ? copySet(set) : { items: [] };
  const id = candidateId.trim();
  if (!id || !current.items.some((item) => item.id === id)) {
    return { set: current, selected: false };
  }
  return { set: { items: current.items, selectedId: id }, selected: true };
}

/**
 * 删一条候选。删掉的正是星标者时，回退到**剩余第一条**（同 reducer 批次主图回退规则）；
 * 全删光＝没有 selectedId（空集合由 `shotCandidatesMetadata` 收成省略键）。
 */
export function removeShotCandidate(
  set: StoryboardShotCandidateSet | undefined,
  candidateId: string,
): { set: StoryboardShotCandidateSet; removed: boolean } {
  const current = set ? copySet(set) : { items: [] };
  const id = candidateId.trim();
  if (!id || !current.items.some((item) => item.id === id)) {
    return { set: current, removed: false };
  }
  const items = current.items.filter((item) => item.id !== id);
  const selectedId =
    current.selectedId && current.selectedId !== id
      ? current.selectedId
      : items[0]?.id;
  return { set: { items, ...(selectedId ? { selectedId } : {}) }, removed: true };
}

/** 星标选中的候选（采用稿）；未选定／集合空＝`null`。 */
export function selectedShotCandidate(
  set: StoryboardShotCandidateSet | null | undefined,
): StoryboardShotCandidate | null {
  if (!set?.selectedId) return null;
  return set.items.find((item) => item.id === set.selectedId) ?? null;
}

// ─────────────────────────────────────────── prompt 回溯（`T`）

/** 回溯：这条候选是**用哪一份 prompt 生出来的**（找不到该候选＝`null`）。 */
export function shotCandidatePrompt(
  set: StoryboardShotCandidateSet | null | undefined,
  candidateId: string,
): string | null {
  const id = candidateId.trim();
  if (!id) return null;
  return set?.items.find((item) => item.id === id)?.prompt ?? null;
}

/** 模拟 `T` 的预设落点：对**星标那一条**回溯 prompt。 */
export function selectedShotCandidatePrompt(
  set: StoryboardShotCandidateSet | null | undefined,
): string | null {
  const selected = selectedShotCandidate(set);
  return selected ? selected.prompt : null;
}

/** 分镜节点的镜号（`storyboardShot.shotNumber`；空＝不是分镜节点）。 */
export function shotNumberOf(node: CanvasNode | undefined): string | undefined {
  const raw = node?.metadata?.storyboardShot?.shotNumber;
  if (typeof raw !== "string") return undefined;
  const shotNumber = raw.trim();
  return shotNumber || undefined;
}

/** 分镜节点判准（现场唯一判准＝`metadata.storyboardShot.shotNumber` 非空）。 */
export function isStoryboardShotNode(node: CanvasNode | undefined): boolean {
  return shotNumberOf(node) !== undefined;
}

/**
 * 单镜的重跑请求（「拿回来重跑」的落地形）。
 *
 * prompt 来源**照优先序**：星标候选的 prompt（＝这格真正用过的稿）→ 节点自身
 * `metadata.prompt`（未抽卡时的一次生成 prompt）。都没有＝`null`（没有 prompt 就没有重跑，
 * 不编造）。model 同序：星标候选的 model → 节点 `metadata.model`。
 */
export interface ShotRerunRequest {
  nodeId: string;
  shotNumber: string;
  prompt: string;
  model?: string;
}

export function shotRerunRequest(node: CanvasNode | undefined): ShotRerunRequest | null {
  const shotNumber = shotNumberOf(node);
  if (!node || !shotNumber) return null;
  const set = readShotCandidates(node.metadata);
  const selected = selectedShotCandidate(set);
  const prompt = selected?.prompt ?? (typeof node.metadata?.prompt === "string" ? node.metadata.prompt.trim() : "");
  if (!prompt) return null;
  const nodeModel = typeof node.metadata?.model === "string" ? node.metadata.model.trim() : "";
  const model = selected?.model ?? (nodeModel || undefined);
  return { nodeId: node.id, shotNumber, prompt, ...(model ? { model } : {}) };
}

// ─────────────────────────────────────────── 旁白文本 ＋ 对白／旁白双音轨（2026-09-30）

/**
 * 分镜音轨角色：**对白轨**（dialogue，台词音档）／**旁白轨**（narration，旁白音档）。
 * 两轨各自独立、互不覆盖（同一镜可同时有对白与旁白）。
 */
export type ShotAudioTrackRole = "dialogue" | "narration";

/**
 * 分镜音轨绑定后的 metadata patch（键名与型别＝**介面冻结**，逐字照用，不改名不改型）。
 *
 * `narration` 是旁白**文本**（编剧/agent 写入，本层只读不覆盖）；`dialogueAudioId`／
 * `narrationAudioId` 是两轨的**资产 id**；`audioAnchorId` 是**相容键**，其值恒等于
 * `dialogueAudioId || narrationAudioId`（对白轨优先，否则旁白轨；两轨皆空＝省略键）。
 *
 * 为何要有 `audioAnchorId`：分镜生产契约（`storyboard-contract.ts`）宣告了它，17 道门禁的
 * `audio_anchor_present`／`dialogue_alignment` 逐镜读它（`shortdrama-domain/index.ts:448/450`），
 * 但全库原本**无生产者**——本层就是它的生产者。四键皆为耐久键（双白名单真源
 * `node-metadata-fields.ts`），否则刷新/回旧会话后音轨与锚静默消失、门禁永远不可能过。
 */
export interface StoryboardShotAudioMetadata {
  /** 单一镜的旁白文本。 */
  narration?: string;
  /** 该镜对白音档的资产 id。 */
  dialogueAudioId?: string;
  /** 该镜旁白音档的资产 id。 */
  narrationAudioId?: string;
  /** 音轨锚（相容键）＝`dialogueAudioId || narrationAudioId`；两轨皆空时缺席。 */
  audioAnchorId?: string;
}

/**
 * 一次音轨变更的结果（**诚实拒绝**，照 `ShotCandidateMutation` 的形）：
 * `accepted:false` 时 `patch` ＝输入状态的等值新物件（呼叫端不会拿到可被误改的旧参考）。
 */
export interface ShotAudioMutation {
  patch: StoryboardShotAudioMetadata;
  accepted: boolean;
  /** 未被接受的原因（accepted=true 时缺席）。 */
  reason?: "invalid-audio";
}

/** 读出 metadata 上两轨的**可用**音档（判准＝既有轮子 `usableAudioUrl`，不另立第二套）。 */
function readAudioTracks(metadata: CanvasNodeMetadata | undefined): {
  dialogueAudioId?: string;
  narrationAudioId?: string;
} {
  const bag = (metadata ?? {}) as Record<string, unknown>;
  const dialogueAudioId = usableAudioUrl(bag.dialogueAudioId);
  const narrationAudioId = usableAudioUrl(bag.narrationAudioId);
  return {
    ...(dialogueAudioId ? { dialogueAudioId } : {}),
    ...(narrationAudioId ? { narrationAudioId } : {}),
  };
}

/** 两轨 → patch，并依规则重算锚（对白轨优先；两轨皆空＝不写 `audioAnchorId` 空壳键）。 */
function audioPatchWithAnchor(tracks: { dialogueAudioId?: string; narrationAudioId?: string }): StoryboardShotAudioMetadata {
  const anchor = tracks.dialogueAudioId || tracks.narrationAudioId;
  return { ...tracks, ...(anchor ? { audioAnchorId: anchor } : {}) };
}

/**
 * 绑定某轨音档（纯函式，**不动输入**）。
 *
 * 契约：
 *   · 值先过**既有轮子** `usableAudioUrl`（认 `.mp3/.m4a/.wav/...` 与 `data:audio/*`）；
 *     非音频值（`.png` 图 URL／无副档名裸 URL／空字串）→ `{ accepted:false, reason:"invalid-audio" }`
 *     （**不冒充已绑定**，与「不建空壳音频卡」同一姿态）。
 *   · 绑定一轨不动另一轨；`audioAnchorId` 依 `dialogueAudioId || narrationAudioId` 重算。
 */
export function bindShotAudioTrack(
  metadata: CanvasNodeMetadata | undefined,
  role: ShotAudioTrackRole,
  audio: string,
): ShotAudioMutation {
  const tracks = readAudioTracks(metadata);
  const clean = usableAudioUrl(audio);
  if (!clean) return { patch: audioPatchWithAnchor(tracks), accepted: false, reason: "invalid-audio" };
  const next = role === "dialogue" ? { ...tracks, dialogueAudioId: clean } : { ...tracks, narrationAudioId: clean };
  return { patch: audioPatchWithAnchor(next), accepted: true };
}

/**
 * 清除某轨（纯函式，**不动输入**）：移除该轨后 `audioAnchorId` 依剩余轨重算；
 * 清除不存在的轨＝合法 no-op（`accepted:true`）；两轨皆清空＝不写 `audioAnchorId`。
 * 锚**不再指向被清掉的那轨**，也不会留著悬空值。
 */
export function clearShotAudioTrack(
  metadata: CanvasNodeMetadata | undefined,
  role: ShotAudioTrackRole,
): ShotAudioMutation {
  const tracks = readAudioTracks(metadata);
  if (role === "dialogue") delete tracks.dialogueAudioId;
  else delete tracks.narrationAudioId;
  return { patch: audioPatchWithAnchor(tracks), accepted: true };
}

// ─────────────────────────────────────────── 单镜媒体就绪（引导面板进度推导，2026-09-30）

/**
 * 单一镜的媒体就绪状态：**纯投影**，三条都只由「该镜自己的 metadata 里真的有的东西」
 * 推导——**不往外捞别的节点**（节点本体图、连线邻居一律不看；那是审查面板
 * `reviewShotsFromNodes` 的投影职责，本函式不越界、也不另立第二套状态语义）。
 */
export interface ShotMediaReadiness {
  readonly hasImage: boolean;
  readonly hasVideo: boolean;
  readonly hasAudio: boolean;
}

/** 值是否为 trim 后非空的字串（本档既有的「空字串／纯空白不算有值」纪律）。 */
function hasNonEmptyText(v: unknown): boolean {
  return typeof v === "string" && v.trim() !== "";
}

/**
 * 单镜媒体就绪（判准写死在这里，逐条说明为何这样判）：
 *
 *   · `hasAudio` ← 三支**音轨键**（`dialogueAudioId`／`narrationAudioId`／`audioAnchorId`）
 *     任一 trim 后非空。判准故意是「非空」而非音频副档名白名单：这三键在型别层是
 *     **资产 id**（不保证是 URL），写入侧 `bindShotAudioTrack` 已用 `usableAudioUrl`
 *     把过一次，读取端再拿副档名尺去卡会把合法资产 id 误判成「没配音」。
 *     **`narration`（旁白文本）不算**——文本是编剧输入、是 TTS 的原料，不是配音交付物，
 *     拿文本冒充配音就是谎报（`tts-multiline-narration-p2-bug`：旁白必须逐镜真的合成出音轨）。
 *
 *   · `hasVideo` ← `taskVersions`（`./task-versions.ts`）中任一条带 `main_video` 标签
 *     **且 `url` 非空**的任务版本。这是本库**唯一**的 per-shot 图/影区分语义（`TASK_TAGS`
 *     ＝`main_image`/`main_video`）⇒ 影片**只认有影片语义的栏位**。无 `url` 的版本＝只有
 *     计画值、尚无实际产物，不算就绪（计画值不冒充实际产物）。**绝不用图冒充影片**。
 *     现场注记（与原任务假设不符，如实记录）：本 repo **并非**「无 per-shot 影片就绪判据」
 *     ——`main_video` 就是既有判据，缺的是**生产者**（全库尚无 `taskVersions` 写入者），
 *     故 `hasVideo` 在有该版任务时会如实为 true，不是恒 false。
 *
 *   · `hasImage` ← 两条**既有轮子**的并集：
 *       ① `taskVersions` 任一条带 `main_image` 标签且 `url` 非空（真·图交付物）；
 *       ② `shotCandidates`（本档）候选集**非空且有采用稿**（星标 `selectedId`）。
 *     ②的理由：候选形状（`StoryboardShotCandidate`）**本来就没有图/影之分**（`url` 栏的
 *     注释逐字＝「交付物 URL（视频/图）」）——**不发明新栏位**（禁自造轮子），退回本档既有的
 *     「星标＝采用稿」语义，只当「本镜有采用稿」的证据；有候选但尚未星标（无采用稿）不算。
 */
export function shotMediaReadiness(metadata: Record<string, unknown>): ShotMediaReadiness {
  const bag = metadata ?? {};
  const hasAudio =
    hasNonEmptyText(bag.dialogueAudioId) ||
    hasNonEmptyText(bag.narrationAudioId) ||
    hasNonEmptyText(bag.audioAnchorId);

  const versions = normalizeTaskVersions(bag.taskVersions);
  const hasDeliveredVersion = (tag: "main_image" | "main_video"): boolean =>
    !!versions?.items.some((entry) => entry.tags.includes(tag) && hasNonEmptyText(entry.url));

  const hasImage = hasDeliveredVersion("main_image") || !!selectedShotCandidate(normalizeShotCandidates(bag.shotCandidates));

  return { hasImage, hasVideo: hasDeliveredVersion("main_video"), hasAudio };
}

// ─────────────────────────────────────────── 分镜增删复制重排

/**
 * 分镜清单项（顺序真源＝阵列序；`shotNumber` 是唯一键，重排不动它）。
 */
export interface ShotListEntry {
  nodeId: string;
  shotNumber: string;
}

/** 分镜清单操作的结果（`ok:false` 时 `shots` ＝输入的等值新阵列）。 */
export interface ShotListMutation {
  shots: ShotListEntry[];
  ok: boolean;
  /** 被拒绝的原因（ok=true 时缺席）。 */
  reason?: "unknown-node" | "duplicate-node" | "duplicate-shot-number" | "out-of-range";
}

function copyList(entries: readonly ShotListEntry[]): ShotListEntry[] {
  return entries.map((entry) => ({ ...entry }));
}

/**
 * 新增一颗分镜在 `at` 位置（`at` 为插入后的 0-based 索引；`at === length` ＝ 追加到末尾）。
 * 节点 id 与镜号都必须是清单内未出现过的（分镜清单内两者是唯一键）。
 */
export function insertShotEntry(
  entries: readonly ShotListEntry[],
  at: number,
  entry: ShotListEntry,
): ShotListMutation {
  const shots = copyList(entries);
  if (!Number.isInteger(at) || at < 0 || at > shots.length) return { shots, ok: false, reason: "out-of-range" };
  const nodeId = entry.nodeId.trim();
  const shotNumber = entry.shotNumber.trim();
  if (!nodeId || !shotNumber) return { shots, ok: false, reason: "unknown-node" };
  if (shots.some((item) => item.nodeId === nodeId)) return { shots, ok: false, reason: "duplicate-node" };
  if (shots.some((item) => item.shotNumber === shotNumber)) return { shots, ok: false, reason: "duplicate-shot-number" };
  shots.splice(at, 0, { nodeId, shotNumber });
  return { shots, ok: true };
}

/** 删一颗分镜。 */
export function deleteShotEntry(
  entries: readonly ShotListEntry[],
  nodeId: string,
): ShotListMutation {
  const shots = copyList(entries);
  const id = nodeId.trim();
  if (!shots.some((item) => item.nodeId === id)) return { shots, ok: false, reason: "unknown-node" };
  return { shots: shots.filter((item) => item.nodeId !== id), ok: true };
}

/**
 * 复制一颗分镜：新项插在**来源的正后一格**（人的直觉＝「这格后面再来一格」）。
 * 新镜号不得与既有任何一颗撞号（撞号＝`duplicate-shot-number`；镜号是唯一键，不许自动编号）。
 */
export function duplicateShotEntry(
  entries: readonly ShotListEntry[],
  sourceNodeId: string,
  copy: ShotListEntry,
): ShotListMutation {
  const shots = copyList(entries);
  const sourceIndex = shots.findIndex((item) => item.nodeId === sourceNodeId.trim());
  if (sourceIndex < 0) return { shots, ok: false, reason: "unknown-node" };
  const nodeId = copy.nodeId.trim();
  const shotNumber = copy.shotNumber.trim();
  if (!nodeId || !shotNumber) return { shots, ok: false, reason: "unknown-node" };
  if (shots.some((item) => item.nodeId === nodeId)) return { shots, ok: false, reason: "duplicate-node" };
  if (shots.some((item) => item.shotNumber === shotNumber)) return { shots, ok: false, reason: "duplicate-shot-number" };
  shots.splice(sourceIndex + 1, 0, { nodeId, shotNumber });
  return { shots, ok: true };
}

/**
 * 重排：把某一颗移到 `toIndex`（**目标为最终 0-based 位置**，先摘除再插入）。
 * 移到原位 = 合法 no-op（`ok:true`，顺序不变）。
 */
export function moveShotEntry(
  entries: readonly ShotListEntry[],
  nodeId: string,
  toIndex: number,
): ShotListMutation {
  const shots = copyList(entries);
  const fromIndex = shots.findIndex((item) => item.nodeId === nodeId.trim());
  if (fromIndex < 0) return { shots, ok: false, reason: "unknown-node" };
  if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= shots.length) {
    return { shots, ok: false, reason: "out-of-range" };
  }
  const [moved] = shots.splice(fromIndex, 1);
  shots.splice(toIndex, 0, moved);
  return { shots, ok: true };
}

/** 分镜节点清单 → 分镜清单项（非分镜节点自动剔除，不臆造镜号）。 */
export function shotListEntries(nodes: readonly CanvasNode[]): ShotListEntry[] {
  const out: ShotListEntry[] = [];
  for (const node of nodes) {
    const shotNumber = shotNumberOf(node);
    if (node && shotNumber) out.push({ nodeId: node.id, shotNumber });
  }
  return out;
}

/**
 * 复制分镜节点（纯函式，回传新节点；**不动输入**）。
 *
 * 形状＝逐栏复制 CanvasNode（含 metadata 深拷贝），只改白名单四件事：
 *   ① `id` / `shotNumber`（新身份）
 *   ② `title`（预设带新镜号；来源标题不含镜号时补上，避免复制品与来源同名）
 *   ③ 剥掉**属于来源那一格的产物与裁决**：
 *      `shotCandidates`（新格还没抽卡）、`entityCardId`（落卡幂等标记属于来源节点）、
 *      `approval`（复制品是未批准的新稿）、`directorStageId`/`shotId`（溯源指针指向来源那一格）。
 *   ④ 位置（可选传入；不传＝沿用来源座标，版面由呼叫端决定）
 *
 * 卡引用（`characterCardIds`/`sceneCardIds`/`propCardIds`）**照抄**——那是这一镜的内容，
 * 复制分镜的用途正是沿用同一组角色/场景再改。
 */
export interface CloneShotNodeOptions {
  id: string;
  shotNumber: string;
  title?: string;
  position?: { x: number; y: number };
}

export function cloneShotNode(node: CanvasNode, options: CloneShotNodeOptions): CanvasNode {
  const nextShotNumber = options.shotNumber.trim();
  const metadata: CanvasNodeMetadata = { ...node.metadata };
  delete metadata.shotCandidates;
  delete metadata.entityCardId;
  delete metadata.approval;
  delete metadata.directorStageId;
  delete metadata.shotId;
  if (metadata.storyboardShot) {
    metadata.storyboardShot = { ...metadata.storyboardShot, shotNumber: nextShotNumber };
  }
  const title =
    options.title?.trim() ||
    (nextShotNumber && !node.title.includes(nextShotNumber) ? `${node.title} ${nextShotNumber}` : node.title);
  return {
    ...node,
    id: options.id.trim(),
    title,
    ...(options.position ? { position: { ...options.position } } : {}),
    ...(metadata ? { metadata } : {}),
  };
}