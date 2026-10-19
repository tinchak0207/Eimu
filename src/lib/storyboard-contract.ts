/**
 * 分镜 21 栏位契约（作品 → 剧集 → 分镜的第三层实体，刀 2）。
 *
 * 轮子来源：gzxx-2025/aid-server（MIT License，Copyright (c) 2026 光子讯息(杭州)科技有限公司）
 * 源档：`doc/提示词开发指南.md` §「分镜脚本与画师链路」输出栏位表（本地取证副本 `/tmp/aid-prompt-guide.md:840`）
 * 取得日：2026-09-15
 * 逐字保留：21 个英文 key 的名称**与顺序**（AID 硬规则 §开发要点 1：名称与顺序不可改动）
 * 白名单改写（仅此处）：
 *   1. **剔除第 22 栏 `sceneCode`**。AID v2.1.4 已明令（同档 §开发要点 5）「场景归属使用外层
 *      sceneName，禁止输出 sceneCode」；旧版 22 栏契约的 `sceneCode` 是场次编码（`aid_storyboard
 *      .source_scene_code`），本站无场次编码表，场景归属一律走 Group 节点的 `storyboardScene.sceneName`。
 *   2. AID 用 DB 表承载（`aid_storyboard` + `script_params` JSON）；本站**不建表、不建 migration**，
 *      改用既有 `CanvasNode.metadata`（Group 节点 = 场景外壳，子节点 = 一镜一 shot）——
 *      PRD `docs/symdiff-aid-swallow-prd.md` §刀 2「白名单改写」。
 *   3. AID 的 `image_prompt` / `video_prompt*` / `final_*_id` 不在 21 栏内，属**成片阶段**产物
 *      （画师 agent / 视觉导演 / 后端选片），本站由后续刀（分镜→成片）补，本档不冒充。
 *
 * 空值规则（逐字沿用 AID）：无内容栏位填 `""`，不写 null、不写「无」。
 *
 * 本档为纯常数 + 纯函数，无副作用。消费入口：
 *   - `CanvasNodeMetadata.storyboardShot`（子节点，一镜一 shot）/ `.storyboardScene`（Group 节点）
 *   - 双白名单两处：`layout.ts toNodeMetadata`（读取端）+ `canvas-chat-types.ts
 *     compactMetadataForAgent`（上行压缩端）。漏一端 = 刷新/换装置后 21 栏凭空消失
 *     （2026-09-03 director SVG 事故同型病灶，见记忆 canvas-snapshot-compressor-director-whitelist-fix）。
 *
 * REQ-B2（2026-09-23）：本档多了一个**纯逻辑**依赖 `./asset-scope`（零 IO、不成环），
 * 只为在「专案 cardIds → 锁定卡」这条**生成注入路径**上过一次作用域裁决
 * （`options.scope` 给了才生效；未给＝既有行为逐位不变）。
 *
 * 资产批准闸（2026-09-24）：型别 `ApprovalState` 与判定函式 `isAssetApproved` **单一真源在
 * `./character-cards`**（不另建第二套 shape、不重写第二套判定），本档只负责把它接到
 * **分镜卡引用栏**（`filterApprovedShotCardIds` ＋ `productionFieldsFromContext` 第 ⑥ 条）。
 * 档位语义同样在该档：**只有 `"collaborate"` 会挡**，`preset`/`auto`/未给 mode 一律放行（护城河）。
 */
import { isAssetApproved } from "./character-cards";
import type { ApprovalState } from "./character-cards";
import type { AgentInteractionMode } from "./agent-chat-client";
import { canUseAsset } from "./asset-scope";
import type { AssetScope, AssetShareRecord } from "./asset-scope";

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

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** 逐栏清洗：非字串 → `""`（AID 空值规则）；超长截断；其余**逐字保留**（不 trim，保 scriptContent 原文相加=完整剧本）。 */
function cleanField(v: unknown): string {
  if (typeof v !== "string") return "";
  return v.length > MAX_STORYBOARD_FIELD_CHARS ? v.slice(0, MAX_STORYBOARD_FIELD_CHARS) : v;
}

/**
 * 逐栏白名单清洗（照 `normalizeProject` / `normalizeEpisode` 范式）：只认 21 栏，其余丢弃。
 * 判据：非物件、或 `shotNumber`（镜号，本实体唯一键）清洗后为空 → 回 null（呼叫端丢弃该镜，不整份作废）。
 * 回传物件的 key **顺序 = `STORYBOARD_SHOT_FIELDS` 顺序**（AID 硬规则：顺序不可改动）。
 */
export function normalizeStoryboardShot(payload: unknown): StoryboardScriptShot | null {
  if (!isRecord(payload)) return null;
  const shotNumber = typeof payload.shotNumber === "string" ? payload.shotNumber.trim().slice(0, 16) : "";
  if (!shotNumber) return null;
  const out = {} as Record<StoryboardShotField, string>;
  for (const field of STORYBOARD_SHOT_FIELDS) {
    out[field] = field === "shotNumber" ? shotNumber : cleanField(payload[field]);
  }
  return out as StoryboardScriptShot;
}

/** 分镜清单清洗：逐镜白名单 → 丢弃非法项；`ordinal` 供「无法供应镜号」时回报位置资讯。 */
export function normalizeStoryboardShots(payload: unknown): StoryboardScriptShot[] | null {
  if (!Array.isArray(payload)) return null;
  const out: StoryboardScriptShot[] = [];
  for (const item of payload) {
    const shot = normalizeStoryboardShot(item);
    if (shot) out.push(shot);
  }
  return out;
}

// ─────────────────────────────────────────── 上行快照压缩（双白名单第二处的纯函数）

/**
 * 21 栏 → 快照用压缩形（逐栏截 `STORYBOARD_SNAPSHOT_FIELD_CHARS`）。
 * 供 `compactMetadataForAgent`（`src/hooks/canvas/canvas-chat-types.ts`）呼叫——
 * 压缩逻辑留在本档，是为了让「栏位清单只有一份」：新增栏位时只改
 * `STORYBOARD_SHOT_FIELDS`，压缩器与读取端自动跟上，不会出现
 * 「压缩端漏栏」（= 刷新后空壳，2026-09-03 director 事故）。
 */
export function compactStoryboardShot(shot: StoryboardScriptShot): StoryboardScriptShot {
  const out = {} as Record<StoryboardShotField, string>;
  for (const field of STORYBOARD_SHOT_FIELDS) {
    const v = shot[field] ?? "";
    out[field] = v.length > STORYBOARD_SNAPSHOT_FIELD_CHARS ? v.slice(0, STORYBOARD_SNAPSHOT_FIELD_CHARS) : v;
  }
  return out as StoryboardScriptShot;
}

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

/** 场景外壳清洗：sceneName 非空字串才成立；shotCount 非负整数，缺省 0。 */
export function normalizeStoryboardSceneRef(payload: unknown): StoryboardSceneRef | null {
  if (!isRecord(payload)) return null;
  const sceneName = typeof payload.sceneName === "string" ? payload.sceneName.trim() : "";
  if (!sceneName) return null;
  const raw = payload.shotCount;
  const shotCount =
    typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
  return { sceneName: sceneName.slice(0, 200), shotCount };
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

const REFERENCE_LABELS: ReadonlyArray<{ key: keyof StoryboardReferenceAssets; label: RegExp }> = [
  { key: "scene", label: /场景\s*[:：]/ },
  { key: "character", label: /角色\s*[:：]/ },
  { key: "prop", label: /道具\s*[:：]/ },
];

/** `场景:[A] 角色:[B]、[C] 道具:[D]` → `{scene:["A"],character:["B","C"],prop:["D"]}`；无标签段落入前一个标签；空输入回三空阵列。 */
export function parseReferenceAssets(text: string): StoryboardReferenceAssets {
  const out: StoryboardReferenceAssets = { scene: [], character: [], prop: [] };
  if (typeof text !== "string" || text.length === 0) return out;
  const marks: { key: keyof StoryboardReferenceAssets; start: number; end: number }[] = [];
  for (const { key, label } of REFERENCE_LABELS) {
    const m = label.exec(text);
    if (m) marks.push({ key, start: m.index, end: m.index + m[0].length });
  }
  marks.sort((a, b) => a.start - b.start);
  for (let i = 0; i < marks.length; i++) {
    const from = marks[i].end;
    const to = i + 1 < marks.length ? marks[i + 1].start : text.length;
    for (const name of text.slice(from, to).matchAll(/\[([^[\]]+)\]/g)) {
      const clean = name[1].trim();
      if (clean) out[marks[i].key].push(clean);
    }
  }
  return out;
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
const QC_REQUIRED_FIELDS = [
  "sceneId",
  "durationSeconds",
  "characterCardIds",
  "sceneCardIds",
  "keyframeId",
  "lastFrameId",
  "audioAnchorId",
  "aspectRatio",
] as const;

/** 非空（trim 后）字串——门禁读值前一律 trim（VPS `text()`），故纯空白字串等于「没有值」。 */
function isNonBlankString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * 「这一栏真的有值」的判准——**判的是值，不是键存不存在**。
 *
 * 为何不能只判 `v === undefined`（2026-09-17 实测缺陷，已修）：
 *   - `sceneId: ""` 旧判准算「已供给」→ `missing` 漏报、`complete` 回 `true`；
 *     但门禁 `Boolean(text(s.sceneId))` 照样 block →「桥接宣告可望 17/17、门禁实际 11/17」。
 *   - `durationSeconds: NaN` 旧判准算「已供给」，且 `typeof NaN === "number"` 让它**真的被送进门禁**；
 *     `JSON.stringify` 把 NaN 变成 `null` → 门禁 `num(null)` → `undefined` → 一样 block。
 *   两者都是「用空值骗门禁」的同型病灶，故本判准与门禁自身的正规化（trim 后非空、有限数）对齐。
 */
function hasUsableQcValue(field: (typeof QC_REQUIRED_FIELDS)[number], v: unknown): boolean {
  if (field === "characterCardIds" || field === "sceneCardIds") {
    return Array.isArray(v) && v.some((id): boolean => isNonBlankString(id));
  }
  if (field === "durationSeconds") return typeof v === "number" && Number.isFinite(v);
  return isNonBlankString(v);
}

/** 卡 id 阵列 → 只留非空字串（门禁 `strArr` 只认字串；非字串项不送过去，避免制造假绑定）。 */
function usableCardIds(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((id): id is string => isNonBlankString(id)) : [];
}

/**
 * `usableCardIds` + 去重（清洗规则**完全复用**，只多一步「同一来源内重复 id 只留一份」）。
 * 为何要一致：①②④ 的名称解析路径（`resolveReferenceAssetsToCardIds`）与
 * `storyboardQcContextFromProject` 的节点累积本来就 `!ids.includes(id)` 去重；
 * ⑤ 若不去重，同一批 id 会在 `fields` 里长成 `["a","a"]`（审计迹与输出无谓膨胀）。
 */
function uniqueCardIds(v: unknown): string[] {
  const out: string[] = [];
  for (const id of usableCardIds(v)) if (!out.includes(id)) out.push(id);
  return out;
}

/**
 * 21 栏分镜 → 门禁输入。只做**栏名映射**，不制造 21 栏里不存在的值：
 *   - `shotId` ← `shotNumber`（无则 `S{序}`）、`order` ← 阵列序（门禁 `shot_order` 要求 1..N 连续）
 *   - `prompt` ← `production.prompt` ?? `visualDescription`
 *   - 其余成片阶段栏位只从 `production` 取，缺者列进 `missing`。
 */
export function storyboardQcShots(
  shots: readonly StoryboardScriptShot[],
  production?: Readonly<Record<string, StoryboardQcProductionFields>>,
): StoryboardQcBridgeResult {
  return storyboardQcShotsWith(shots, production);
}

/** `storyboardQcShots` 的实作本体（保持原函数签名与语义不动，只抽出可被下方复用）。 */
function storyboardQcShotsWith(
  shots: readonly StoryboardScriptShot[],
  production?: Readonly<Record<string, StoryboardQcProductionFields>>,
): StoryboardQcBridgeResult {
  const missing = new Set<string>();
  const out = shots.map((shot, i) => {
    const p = production?.[shot.shotNumber] ?? {};
    const prompt = isNonBlankString(p.prompt) ? p.prompt : shot.visualDescription.trim();
    if (!prompt) missing.add("prompt");
    for (const field of QC_REQUIRED_FIELDS) {
      if (!hasUsableQcValue(field, p[field])) missing.add(field);
    }
    return {
      shotId: shot.shotNumber || `S${i + 1}`,
      order: i + 1,
      prompt,
      ...(isNonBlankString(p.sceneId) ? { sceneId: p.sceneId.trim() } : {}),
      ...(typeof p.durationSeconds === "number" && Number.isFinite(p.durationSeconds)
        ? { durationSeconds: p.durationSeconds }
        : {}),
      characterCardIds: usableCardIds(p.characterCardIds),
      sceneCardIds: usableCardIds(p.sceneCardIds),
      propCardIds: usableCardIds(p.propCardIds),
      ...(isNonBlankString(p.keyframeId) ? { keyframeId: p.keyframeId.trim() } : {}),
      ...(isNonBlankString(p.lastFrameId) ? { lastFrameId: p.lastFrameId.trim() } : {}),
      ...(isNonBlankString(p.audioAnchorId) ? { audioAnchorId: p.audioAnchorId.trim() } : {}),
      ...(isNonBlankString(p.aspectRatio) ? { aspectRatio: p.aspectRatio.trim() } : {}),
      // 旁白（加成栏位）：呼叫端供给才带（同 `approval` 范式，未供给不补默认值 → 既有输出键逐位不变）。
      ...(isNonBlankString(p.narration) ? { narration: p.narration.trim() } : {}),
      // 分镜确认状态：呼叫端供给才带（未供给＝缺省＝已批准，不补默认值 → 既有输出键逐位不变）。
      ...(p.approval ? { approval: p.approval } : {}),
    } satisfies StoryboardQcShot;
  });
  const missingList = [...missing];
  return { shots: out, missing: missingList, complete: shots.length > 0 && missingList.length === 0 };
}

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
const RATIO_SHAPE = /^\d+:\d+$/;

/**
 * 卡名 → 卡 id 索引（**同名同kind 歧义者整批排除**）。
 *
 * 为何排除而非取首个：`CharacterCard.name` 没有唯一性约束（`character-cards.ts:85` 只验非空与长度），
 * 撞名时任取一个就是**猜**——宁可回报未解析（该镜进 `missing`），也不把两张卡混为一谈。
 * 名称比对用 trim 后逐字相等（不做大小写/前缀模糊匹配：模糊匹配会把不同卡黏在一起）。
 * `prop` 表**沿用完全同一套规则**（同 kind 逐字命中、同名同 kind 歧义整批排除），
 * 不为道具另立规则；`style` 卡不进任何表（风格不是道具）。
 */
export function indexCardsByName(cards: readonly StoryboardQcCardRef[]): {
  character: Map<string, string>;
  scene: Map<string, string>;
  prop: Map<string, string>;
} {
  const seen = new Map<string, { id: string; duplicated: boolean }>();
  for (const card of cards) {
    if (!card || typeof card.id !== "string" || typeof card.name !== "string" || typeof card.kind !== "string") continue;
    const id = card.id.trim();
    const name = card.name.trim();
    if (!id || !name) continue;
    const key = `${card.kind}\u0000${name}`;
    const prev = seen.get(key);
    if (prev) prev.duplicated = true;
    else seen.set(key, { id, duplicated: false });
  }
  const character = new Map<string, string>();
  const scene = new Map<string, string>();
  const prop = new Map<string, string>();
  for (const [key, entry] of seen) {
    if (entry.duplicated) continue;
    const [kind, name] = key.split("\u0000");
    if (kind === "character") character.set(name, entry.id);
    else if (kind === "scene") scene.set(name, entry.id);
    else if (kind === "prop") prop.set(name, entry.id);
    // 其余 kind（含 "style"）不进任何表：风格卡不是道具、也不属门禁两集。
  }
  return { character, scene, prop };
}

/**
 * `referenceAssets` → 卡 id（**名称逐字命中才成立**）。
 *
 * 语义边界（诚实标记）：AID 的 `referenceAssets` 名称取自**资产库**（`storyboard-contract.ts`
 * 契约注：名称取自资产库、未命中者 AID 后端剔除），本站资产库有两族：
 *   - `CharacterCard`（`kind: "character"|"scene"|"prop"`）→ 可解析成卡 id
 *   - 资产包/历史资产条目（`node-to-asset-items.ts`）→ **没有卡 id**，解析不到（留在 unsolved）
 * 故：解析失败 = 名称不存在于卡清单，或该名称属资产包另一族，或同名歧义 —— 三种都**不臆造 id**。
 *
 * **三段的 `unresolved*` 语义现在一致**（2026-09-24 统一）：「真的没命中」的名称清单——
 * 名称在卡清单里找不到（含同名歧义、kind 不符）才进这里。旧版 `unresolvedProps` 是
 * 「本站没有对应栏位」的原样回报（`propCardIds` 不存在于门禁 Shot），道具卡走完解析链后
 * 该语义已失效：`prop` 段现在与角色/场景段**逐字同一条解析规则**（`kind === "prop"` 命中
 * `indexCardsByName` 的 prop 表 → 卡 id；未命中 → `unresolvedProps`）。
 */
export function resolveReferenceAssetsToCardIds(
  referenceAssets: string,
  cards: readonly StoryboardQcCardRef[],
): {
  characterCardIds: string[];
  sceneCardIds: string[];
  propCardIds: string[];
  unresolvedCharacters: string[];
  unresolvedScenes: string[];
  unresolvedProps: string[];
} {
  const parsed = parseReferenceAssets(referenceAssets);
  const index = indexCardsByName(cards);
  const resolve = (names: string[], table: Map<string, string>) => {
    const ids: string[] = [];
    const unresolved: string[] = [];
    for (const name of names) {
      const id = table.get(name);
      if (id === undefined) unresolved.push(name);
      else if (!ids.includes(id)) ids.push(id);
    }
    return { ids, unresolved };
  };
  const character = resolve(parsed.character, index.character);
  const scene = resolve(parsed.scene, index.scene);
  const prop = resolve(parsed.prop, index.prop);
  return {
    characterCardIds: character.ids,
    sceneCardIds: scene.ids,
    propCardIds: prop.ids,
    unresolvedCharacters: character.unresolved,
    unresolvedScenes: scene.unresolved,
    unresolvedProps: prop.unresolved,
  };
}

// ─────────────────────────────────────────── 资产批准闸（档位相关，2026-09-24）

/** 分镜的三条卡引用栏（键名 = `storyboard_qc_17` 门禁栏名；本档唯一清单，勿另立）。 */
const SHOT_CARD_ID_FIELDS = ["characterCardIds", "sceneCardIds", "propCardIds"] as const;

/**
 * 卡 id 过批准闸（纯函式；**只有协作档会挡**——护城河写在函式体内，不靠呼叫端自律）。
 *
 * 规则（决策 2/23）：
 *   - `mode !== "collaborate"`（含 `preset`/`auto`/**未给 mode**）→ **原样回传**：
 *     顺序与重复项逐位不变（全自动档零改动、既有呼叫端零漂移）。
 *   - `mode === "collaborate"` → 逐 id 问 `isAssetApproved`（判定单一真源在 `./character-cards`）：
 *     显式 `pending`/`rejected` 的卡 id 剔除；缺 `approval` 的卡（＝已批准）保留。
 *   - **卡清单里查不到的 id → 保留**：查不到 ≠ 未批准，不猜（与 `unresolvedCardIds` 同一条界线）。
 *   - 同 id 多笔卡且其中有未批准者 → **挡**（不能证明已批准的，不当已批准处理）。
 *
 * 呼叫端＝写入/消费分镜卡引用栏的人（分镜审查面板、`productionFieldsFromContext` 第 ⑥ 条）。
 * 本函式**只做判定**：不做 UI 触发、不改 gateway、不动扣费。
 */
export function filterApprovedShotCardIds(
  ids: readonly string[] | undefined,
  cards: readonly StoryboardQcCardRef[],
  mode?: AgentInteractionMode,
): string[] {
  const list = Array.isArray(ids) ? ids : [];
  if (mode !== "collaborate") return [...list];
  const unapproved = new Set<string>();
  for (const card of cards ?? []) {
    if (!card || typeof card.id !== "string") continue;
    const id = card.id.trim();
    if (!id) continue;
    if (!isAssetApproved(card.approval, mode)) unapproved.add(id);
  }
  return list.filter((id) => typeof id === "string" && !unapproved.has(id.trim()));
}

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

/**
 * 上下文 → 成片阶段栏位（纯函数，唯一推导入口——**不用隐式魔法、不改任何既有函数语义**）。
 *
 * 目前**只有五条**推导成立（每条都有来源，逐条列在回报）：
 *   1. `characterCardIds` ← `referenceAssets` 的 `角色:[…]` 名称 → 卡 id（`kind==="character"` 逐字命中）
 *   2. `sceneCardIds` ← `referenceAssets` 的 `场景:[…]` 名称 → 卡 id（`kind==="scene"` 逐字命中）
 *   3. `aspectRatio` ← 该镜节点 `metadata.size`（canvas 的 `size` **就是比例**：
 *      `src/app/api/canvas/generate/route.ts:133` `const aspectRatio = body.size ?? "1:1"`；
 *      可选值域见 `src/components/canvas/CanvasNodePromptPanel.tsx:96-102`）
 *   4. `propCardIds` ← `referenceAssets` 的 `道具:[…]` 名称 → 卡 id（`kind==="prop"` 逐字命中，
 *      2026-09-24 新增）。**加成栏位**：推导不到不进 `missing`（`QC_REQUIRED_FIELDS` 刻意不含它，
 *      否则全部既有镜次瞬间多一项 missing＝门禁回归）。`kind==="style"` 的卡不进 prop 表。
 *   5. `characterCardIds`/`sceneCardIds`/`propCardIds`/`audioAnchorId` ← 该镜节点 `metadata` 的同名
 *      栏（2026-09-24 卡 id；2026-09-30 `audioAnchorId`）。来源 = agent 自动落卡后回填 ＋ 逐镜配音
 *      回写（闭环的消费端）。卡 id 是**集合**语义（联集去重）；`audioAnchorId` 是**单值**语义
 *      （同镜矛盾不给，值真源见 `storyboardQcContextFromProject`）。
 *
 * **推导优先序（照抄，勿改）**：`production`（呼叫端供给） > `referenceAssets`（①②④）
 * > 节点 metadata（⑤）。理由：`referenceAssets` 是**编剧阶段逐字写下的意图**（名称级、有明确
 * 指名）；节点 metadata 的卡 id 多半是**机器自动落卡后回填**（粗：可能把该模板产出的卡全填上）。
 * 若让 metadata 优先，会用「机器猜的较大集合」盖掉「编剧明确指名的较小集合」。
 * 实作上 ①②④ 的 `if (!out.x …)` 写法保证「已供给者不被覆盖」，⑤ 再对同一条件做第二次检查。
 *
 * **刻意不做的推导（附理由，避免下游误以为漏做）**：
 *   - `durationSeconds`：本 repo 有两把尺但**互相冲突**且**输入契约不同**——
 *     `drama-recipe.ts:340 deriveDurations`（4 字/秒，吃「场次 beat 清单」）与
 *     `shortdrama-domain/index.ts:499`（4 字/秒，吃「台词行清单」），而剧本模板教义写 **4.5 字/秒**
 *     （`agent-templates-payload.ts:103`）。射手的 `dialogue` 是**单一字串**、其 `[角色]：「…」`
 *     标记格式无契约文件，硬套等于**自造转换**→ 不生成，留 `missing` 由门禁如实 block。
 *   - `narration`（2026-09-30）：**旁白不从 `dialogue` 猜**。我方 21 栏契约**无旁白栏**，
 *     射手的 `dialogue` 是**单一字串**且其 `[角色]：「…」` 标记格式**无契约文件**——从 `dialogue`
 *     切出旁白＝**自造转换**（同 `durationSeconds` 的病灶），且分镜的旁白本就非逐镜台词可比。
 *     故本档不推导 `narration`，一律留给呼叫端供给：供给即进 `fields`（来源记 `production`）；
 *     未供给＝加成栏位不罚（不进 `missing`）。
 *   - `sceneId`：门禁 `sceneId` 是**场次编号**（`drama-recipe.ts:111-112` `DramaScriptScene.sceneId`
 *     「场次编号（如 S01）」），21 栏只有外层 `sceneName` = **场景资产名**（`storyboard-contract.ts:148`）。
 *     两者是不同实体，名称不可互换 → 不生成。
 *   - `keyframeId`/`lastFrameId`：本 repo **无生产者**（`grep keyframeId src/` 除本档与
 *     `shortdrama-domain` 型别外无写入端）→ 不生成。
 *   - `audioAnchorId`：**2026-09-30 起有生产者**——`storyboard-voiceover`／voiceboard 把
 *     `dialogueAudioId || narrationAudioId` 写回节点 metadata 的相容键，本桥第 ⑤ 条现会在
 *     呼叫端未供给时从节点 metadata 读取（单值语义：同镜矛盾不给）。因为 `audioAnchorId`
 *     已在 `QC_REQUIRED_FIELDS` 内，供给后自然不再进 `missing`。（旧注「无生产者→不生成」已过时。）
 *   - `pixels→ratio` 换算（`aspectRatioFromImageSize`）：canvas 存的是比例不是像素，用不到；
 *     且会把「尺寸」与「交付比例」两概念混一，故只认已是 ratio 形状的值。
 */
export function productionFieldsFromContext(
  shots: readonly StoryboardScriptShot[],
  context?: StoryboardQcContext,
): StoryboardQcContextFields {
  const fields: Record<string, StoryboardQcProductionFields> = {};
  const sources: Record<string, Record<string, StoryboardQcFieldSource>> = {};
  const blockedByShot: Record<string, string[]> = {};
  const cards = context?.cards ?? [];
  for (const shot of shots) {
    const key = shot.shotNumber;
    if (!key) continue;
    const supplied = context?.production?.[key] ?? {};
    const out: StoryboardQcProductionFields = { ...supplied };
    const src: Record<string, StoryboardQcFieldSource> = {};
    for (const field of QC_REQUIRED_FIELDS) {
      if (supplied[field] !== undefined) src[field] = "production";
    }
    if (supplied.prompt) src.prompt = "production";
    // `propCardIds` 不在 `QC_REQUIRED_FIELDS`（加成栏位，见该常数注），故上面的回圈不会标它；
    // 呼叫端有供给时补记来源（与 `prompt` 同一范式），否则它在审计迹里会是「有值却无来源」。
    if (supplied.propCardIds !== undefined) src.propCardIds = "production";
    // `narration` 同样不在 `QC_REQUIRED_FIELDS`（加成栏位，见该常数注），回圈不标它；呼叫端供给时
    // 补记来源（与 `propCardIds`/`prompt` 同一范式），否则审计迹里会是「有值却无来源」。
    if (supplied.narration !== undefined) src.narration = "production";

    // ① / ② referenceAssets 名称 → 卡 id（仅在呼叫端未供给时才推导；已供给者不被覆盖）
    const resolved = resolveReferenceAssetsToCardIds(shot.referenceAssets, cards);
    if (!(out.characterCardIds && out.characterCardIds.length > 0) && resolved.characterCardIds.length > 0) {
      out.characterCardIds = resolved.characterCardIds;
      src.characterCardIds = "referenceAssets";
    }
    if (!(out.sceneCardIds && out.sceneCardIds.length > 0) && resolved.sceneCardIds.length > 0) {
      out.sceneCardIds = resolved.sceneCardIds;
      src.sceneCardIds = "referenceAssets";
    }

    // ③ 节点 ratio → aspectRatio（只认已是 ratio 形状者，绝不做像素换算或补默认值）
    const nodeSize = context?.shotMetadata?.[key]?.size;
    if (!out.aspectRatio && typeof nodeSize === "string" && RATIO_SHAPE.test(nodeSize.trim())) {
      out.aspectRatio = nodeSize.trim();
      src.aspectRatio = "nodeSize";
    }

    // ④ referenceAssets 道具名称 → propCardIds（仅在呼叫端未供给时才推导）
    // 加成栏位：推导不到不进 missing（`QC_REQUIRED_FIELDS` 刻意不含它），有命中才回报来源。
    if (!(out.propCardIds && out.propCardIds.length > 0) && resolved.propCardIds.length > 0) {
      out.propCardIds = resolved.propCardIds;
      src.propCardIds = "referenceAssets";
    }

    // ⑤ 分镜节点 metadata 的卡 id → 三栏（**只在 ①②④ 都没推导到、且呼叫端未供给时**才生效）
    // 优先序最低的理由见上方函数注（编剧逐字指名 > 机器自动落卡的较大集合）。
    // 清洗复用 `usableCardIds`（`uniqueCardIds` = 同规则 + 去重）。
    const nodeCards = context?.shotMetadata?.[key];
    if (!(out.characterCardIds && out.characterCardIds.length > 0)) {
      const ids = uniqueCardIds(nodeCards?.characterCardIds);
      if (ids.length > 0) {
        out.characterCardIds = ids;
        src.characterCardIds = "nodeMetadata";
      }
    }
    if (!(out.sceneCardIds && out.sceneCardIds.length > 0)) {
      const ids = uniqueCardIds(nodeCards?.sceneCardIds);
      if (ids.length > 0) {
        out.sceneCardIds = ids;
        src.sceneCardIds = "nodeMetadata";
      }
    }
    if (!(out.propCardIds && out.propCardIds.length > 0)) {
      const ids = uniqueCardIds(nodeCards?.propCardIds);
      if (ids.length > 0) {
        out.propCardIds = ids;
        src.propCardIds = "nodeMetadata";
      }
    }
    // `audioAnchorId` 同样由节点 metadata 带入（2026-09-30；写法与上方三条卡 id 逐行对称，
    // 含 `src[X] = "nodeMetadata"` 的来源补记）。**单值语义**（同 `size`，非卡 id 的集合语义），
    // 故只在呼叫端未供给且节点值是非空字串时才拿；因为本栏在 `QC_REQUIRED_FIELDS` 内，
    // 供给后自然不再进 `missing`。
    if (!isNonBlankString(out.audioAnchorId)) {
      const nodeAudioAnchorId = nodeCards?.audioAnchorId;
      if (isNonBlankString(nodeAudioAnchorId)) {
        out.audioAnchorId = nodeAudioAnchorId.trim();
        src.audioAnchorId = "nodeMetadata";
      }
    }

    // ⑥ 资产批准闸（**只在协作档生效**，决策 2/23）：未批准的卡 id 不得进分镜卡引用栏。
    // 未给 mode／preset／auto → 整段跳过（既有行为逐位不变，这是全自动档的护城河）。
    // 三条栏一律过（不论值来自 production 还是 ①②④⑤ 推导）：使用者在落卡后才驳回时，
    // 节点 metadata 里的旧绑定照样要被挡——否则「驳回」只是事后贴纸。
    // 挡到一个都不剩 → **连键与来源一起移除**（改进 `missing` 让门禁如实 block，
    // 不留 `[]` 这种「有键无值」骗门禁的空值；挡下的 id 记进 `blockedCardIdsByShot` 回报）。
    if (context?.mode === "collaborate") {
      for (const field of SHOT_CARD_ID_FIELDS) {
        const before = out[field];
        if (!before || before.length === 0) continue;
        const after = filterApprovedShotCardIds(before, cards, context.mode);
        if (after.length === before.length) continue;
        const blocked = before.filter((id) => !after.includes(id));
        if (blocked.length === 0) continue;
        const list = (blockedByShot[key] ??= []);
        for (const id of blocked) if (!list.includes(id)) list.push(id);
        if (after.length > 0) out[field] = after;
        else {
          delete out[field];
          delete src[field];
        }
      }
    }

    fields[key] = out;
    sources[key] = src;
  }
  return {
    fields,
    sources,
    ...(Object.keys(blockedByShot).length > 0 ? { blockedCardIdsByShot: blockedByShot } : {}),
  };
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

/**
 * 专案上下文 → 桥接上下文（**唯一专案级推导入口，显式不魔法**）。
 *
 * 目前只有四条专案级推导成立（每条都有来源）：
 *   1. `lockedCharacterCardIds` / `lockedSceneCardIds` ← `project.cardIds` 按卡 `kind` 分流
 *      （卡实体真源 = `listCharacterCards`，`src/lib/character-card-store.ts:122`）。
 *      门禁 `character_lock`/`scene_lock` 要求「每镜引用的卡都在锁定集合内」——集合就是专案锁定卡。
 *      `kind` 分流只认门禁真有集合的两族：`style`/`prop`（2026-09-24 起 prop 是真 kind）都
 *      **静默略过**（既不进锁定集合也不算未解析）——门禁 `Shot` 没有 lockedStyle/lockedProp 这两集。
 *   2. `shotMetadata[k]` ← `project.nodes` 中 `metadata.size`（供 `productionFieldsFromContext`
 *      推 `aspectRatio`；该栏位是否**真的**已是 ratio 形状由下游 `RATIO_SHAPE` 把关）。
 *   3. `shotMetadata[k]` ← `project.nodes` 中 `metadata.characterCardIds`/`sceneCardIds`/
 *      `propCardIds`（2026-09-24 新增；供 `productionFieldsFromContext` 第 ⑤ 条推导——即
 *      「agent 自动落卡 → 节点 metadata 宣告 → 门禁消费」闭环的带入端）。清洗用 `usableCardIds`，
 *      **空阵列省略该键**（不造 `characterCardIds: []` 的空键，否则 `src` 审计迹会误报「有值」）。
 *   4. `shotMetadata[k]` ← `project.nodes` 中 `metadata.audioAnchorId`（2026-09-30 新增；供第 ⑤ 条
 *      推导——「逐镜配音回写 → 节点 metadata → 门禁 `audio_anchor_present`/`dialogue_alignment`」
 *      闭环的带入端）。**单值语义**（同 `size`）：同镜多节点取首个非空，矛盾则整个不给；空值/非
 *      字串一律省略该键（不臆造、不误报「有值」）。
 *
 * **刻意不做的推导**：`aspectRatio` 没有专案级栏位可取（`grep aspectRatio src/lib/canvas/types.ts`
 * 为空——比例只存在于**节点** metadata，不在 `CanvasProject`），故不「从专案继承」；
 * 亦无 `segmentDurationSeconds` 的专案级来源（`CanvasEpisode` 无时长栏位）。
 *
 * `unresolvedCardIds`：`cardIds` 中**查不到卡片实体**的 id（卡未载入/已删）。这些 id 无法判定
 * `kind` → **不猜**、不塞进任一锁定集合，如实回报。缺卡清单时（`cards` 未提供）同理：
 * 宁可回报全部未解析，也不把角色卡当场景卡通关。
 */
export function storyboardQcContextFromProject(
  project?: StoryboardQcProjectRef,
  options?: {
    cards?: readonly StoryboardQcCardRef[];
    production?: Readonly<Record<string, StoryboardQcProductionFields>>;
    segmentDurationSeconds?: number;
    /**
     * 互动档位（`AgentInteractionMode`）。未给 → 既有行为逐位不变（零回归）；
     * 给了 `"collaborate"` → 推导出的分镜卡引用栏再过一次批准闸（第 ⑥ 条）。
     */
    mode?: AgentInteractionMode;
    /**
     * REQ-B2 作用域上下文。未给 → 既有行为逐位不变（零回归）；
     * 给了 → 卡与 cardIds 先过作用域裁决（不可见即不可用）。
     */
    scope?: StoryboardQcScopeContext;
  },
): { context: StoryboardQcContext; unresolvedCardIds: string[]; outOfScopeCardIds: string[] } {
  const cards = options?.cards ?? [];
  const scope = options?.scope;
  // 作用域裁决：唯一入口 canUseAsset（= resolveAssetVisibility）。未给上下文＝全放行
  // （＝本刀之前的行为，逐位不变）；给了＝跨项目未分享的卡在此不可用。
  const usableCard = (card: StoryboardQcCardRef): boolean => {
    if (!scope) return true;
    const id = typeof card?.id === "string" ? card.id.trim() : "";
    if (!id) return true; // 无 id 的卡既非可见也非不可见，走原有「不猜」路径
    return canUseAsset(
      { id, kind: "card", scope: card.scope, ownerUserId: scope.viewerUserId },
      { viewerUserId: scope.viewerUserId, projectId: scope.projectId, shares: scope.shares },
    );
  };
  const visibleCards = scope ? cards.filter(usableCard) : cards;
  // 被作用域拒掉的卡 id：与「查不到卡实体」分开如实回报（两态不混）。
  const outOfScopeCardIds: string[] = [];
  if (scope) {
    for (const card of cards) {
      if (usableCard(card)) continue;
      const id = typeof card?.id === "string" ? card.id.trim() : "";
      if (id && !outOfScopeCardIds.includes(id)) outOfScopeCardIds.push(id);
    }
  }

  const kindById = new Map<string, string>();
  for (const card of visibleCards) {
    if (!card || typeof card.id !== "string" || typeof card.kind !== "string") continue;
    const id = card.id.trim();
    if (!id) continue;
    // 同 id 多卡：kind 不一致 → 无法判定，标成歧义（空字串）以排除出两个锁定集合
    const prev = kindById.get(id);
    if (prev !== undefined && prev !== card.kind) kindById.set(id, "\u0000ambiguous");
    else if (prev === undefined) kindById.set(id, card.kind);
  }

  const lockedCharacterCardIds: string[] = [];
  const lockedSceneCardIds: string[] = [];
  const unresolvedCardIds: string[] = [];
  for (const raw of project?.cardIds ?? []) {
    if (!isNonBlankString(raw)) continue;
    const id = raw.trim();
    // 不可见即不可用：跨项目未分享的卡不进锁定集合（已在上方如实回报，不重复算未解析）。
    if (outOfScopeCardIds.includes(id)) continue;
    const kind = kindById.get(id);
    if (kind === "character") {
      if (!lockedCharacterCardIds.includes(id)) lockedCharacterCardIds.push(id);
    } else if (kind === "scene") {
      if (!lockedSceneCardIds.includes(id)) lockedSceneCardIds.push(id);
    } else if (kind === "style") {
      // style 卡不属门禁两集（`Shot` 无 styleCardIds）→ 既非未解析也非两者之一，静默略过
    } else if (kind === "prop") {
      // prop 卡同理：门禁 `Shot` 没有 lockedPropCardIds 这一集（道具是加成栏位，不设锁），
      // 故既不入角色/场景锁定集合，也**不得**被当成「查不到卡实体」而误进 unresolvedCardIds。
    } else {
      // 查不到卡实体 / id 撞 kind / 非字串 kind → 不猜
      if (!unresolvedCardIds.includes(id)) unresolvedCardIds.push(id);
    }
  }

  const shotMetadata: Record<string, StoryboardQcShotNodeMetadata> = {};
  // 卡 id 三栏与 `size` **分开累积**：`size` 是同镜矛盾就整个不给（比例是单一交付格式，猜不得）；
  // 卡 id 是**集合**语义（节点宣告「本镜引用这些卡」），同镜多节点取联集去重、不取首个也不丢资讯。
  const cardsByShot: Record<string, { character: string[]; scene: string[]; prop: string[] }> = {};
  // `audioAnchorId` 与 `size` **同范式（单值语义）**、**不照卡 id 的联集**：同镜多节点取首个非空，
  // 一旦矛盾（第二个非空值不同）就整个不给（`null` 哨兵），后续节点不得把它「救回」——音轨锚是
  // 单一交付物，猜不得。空/非字串值一律忽略（不占位、不算首个）。
  const anchorByShot: Record<string, string | null> = {};
  for (const node of project?.nodes ?? []) {
    const meta = node?.metadata;
    const shotNumber = meta?.storyboardShot?.shotNumber;
    if (!isNonBlankString(shotNumber)) continue; // 无镜号的节点不归属任一镜（不臆造键）
    const key = shotNumber.trim();

    const bucket = (cardsByShot[key] ??= { character: [], scene: [], prop: [] });
    const collect = (target: string[], raw: unknown) => {
      for (const id of uniqueCardIds(raw)) if (!target.includes(id)) target.push(id);
    };
    collect(bucket.character, meta?.characterCardIds);
    collect(bucket.scene, meta?.sceneCardIds);
    collect(bucket.prop, meta?.propCardIds);

    const rawAnchor = meta?.audioAnchorId;
    if (isNonBlankString(rawAnchor)) {
      const anchor = rawAnchor.trim();
      const prevAnchor = anchorByShot[key];
      if (prevAnchor === undefined) anchorByShot[key] = anchor;
      else if (prevAnchor !== anchor) anchorByShot[key] = null; // 同镜矛盾 → 不给（不取首个猜）
    }

    const size = meta?.size;
    if (size === undefined) continue;
    // 同镜号多节点：ratio 不一致 → 宁可不给（该镜 aspectRatio 留 missing），不取首个猜
    const prev = shotMetadata[key];
    if (prev === undefined) shotMetadata[key] = { size };
    else if (prev.size !== size) shotMetadata[key] = {};
  }
  // 音轨锚：真的有单一非空值时才挂上；同镜矛盾则**保留该镜键但不给值**（照 `size` 范式——
  // `{ [key]: {} }`，审计迹不误报「有值」）。
  for (const [key, anchor] of Object.entries(anchorByShot)) {
    const entry = (shotMetadata[key] ??= {});
    if (anchor === null) continue;
    entry.audioAnchorId = anchor;
  }
  // 卡 id 只在真的有值时挂上（空阵列省略该键 → 审计迹不误报「有值」）
  for (const [key, bucket] of Object.entries(cardsByShot)) {
    if (bucket.character.length === 0 && bucket.scene.length === 0 && bucket.prop.length === 0) continue;
    const entry = (shotMetadata[key] ??= {});
    if (bucket.character.length > 0) entry.characterCardIds = bucket.character;
    if (bucket.scene.length > 0) entry.sceneCardIds = bucket.scene;
    if (bucket.prop.length > 0) entry.propCardIds = bucket.prop;
  }

  const context: StoryboardQcContext = {
    ...(options?.production ? { production: options.production } : {}),
    // 注入上下文只带可用（可见）的卡：不可见即不可用，卡实体也不例外。
    cards: visibleCards,
    ...(Object.keys(shotMetadata).length > 0 ? { shotMetadata } : {}),
    ...(lockedCharacterCardIds.length > 0 ? { lockedCharacterCardIds } : {}),
    ...(lockedSceneCardIds.length > 0 ? { lockedSceneCardIds } : {}),
    ...(typeof options?.segmentDurationSeconds === "number" ? { segmentDurationSeconds: options.segmentDurationSeconds } : {}),
    ...(options?.mode ? { mode: options.mode } : {}),
  };
  return { context, unresolvedCardIds, outOfScopeCardIds };
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

/**
 * 一次组出**可直接喂门禁的两形 args**（本地判定 + VPS 工具），把推导结果真的接到门禁。
 * `missing` 为空不代表 17 门全过（门禁有自己的值域判定，如 `4:3` 不在 9:16/16:9/1:1 内），
 * 也不代表 `duration_bounds`/`scene_binding` 等已成立——**本函数只保证「输入没有缺项」**。
 */
export function storyboardQcGateArgs(
  shots: readonly StoryboardScriptShot[],
  context?: StoryboardQcContext,
): StoryboardQcGateArgs {
  const derived = productionFieldsFromContext(shots, context);
  const bridge = storyboardQcShotsWith(shots, derived.fields);
  const missing = new Set(bridge.missing);

  const lockedCharacters = (context?.lockedCharacterCardIds ?? []).filter((id) => typeof id === "string" && id.length > 0);
  const lockedScenes = (context?.lockedSceneCardIds ?? []).filter((id) => typeof id === "string" && id.length > 0);
  if (lockedCharacters.length === 0) missing.add("lockedCharacterCardIds");
  if (lockedScenes.length === 0) missing.add("lockedSceneCardIds");

  const segment = context?.segmentDurationSeconds;
  const segmentOk = typeof segment === "number" && Number.isFinite(segment) && segment > 0;
  if (!segmentOk) missing.add("segmentDurationSeconds");

  const input: StoryboardQcGateArgs["input"] = {
    shots: bridge.shots,
    ...(lockedCharacters.length > 0 ? { lockedCharacterCardIds: lockedCharacters } : {}),
    ...(lockedScenes.length > 0 ? { lockedSceneCardIds: lockedScenes } : {}),
    ...(segmentOk ? { segmentDurationSeconds: segment } : {}),
  };
  const toolArgs: StoryboardQcGateArgs["toolArgs"] = {
    shots: JSON.stringify(bridge.shots),
    ...(lockedCharacters.length > 0 ? { locked_character_card_ids: JSON.stringify(lockedCharacters) } : {}),
    ...(lockedScenes.length > 0 ? { locked_scene_card_ids: JSON.stringify(lockedScenes) } : {}),
    ...(segmentOk ? { segment_duration_seconds: segment } : {}),
  };
  const missingList = [...missing];
  return {
    input,
    toolArgs,
    missing: missingList,
    complete: shots.length > 0 && missingList.length === 0,
    sources: derived.sources,
  };
}

// ─────────────────────────────────────────── 重跑影响面（纯判定，2026-09-24）

/**
 * 「某步重跑 → 哪些已完成结果受影响」的**纯判定**（决策 15：步骤条可回跳，只重跑后续）。
 *
 * 输入：
 *   - `nodes`：专案节点（`CanvasProject.nodes`，结构相容 `StoryboardQcNodeRef`）
 *   - `cardIds`：本轮会重做的卡 id。例：重跑资产步 → 该步节点的卡 id ＝
 *     `entityCardIdForNode(nodeId)`（`agent-output-cards.ts:154`，决定性推导），
 *     把这批 id 原样喂进来即得影响面（**不新建节点→卡的第二套推导**）。
 * 输出：
 *   - `affectedCardIds`：真的被某颗分镜节点引用到的卡 id（输入里没被引用的不回报）
 *   - `shotNodeIds`：宣告了这些卡的**分镜节点** id（`metadata.storyboardShot.shotNumber`
 *     非空才算分镜节点；节点无 id／非分镜节点 → 不回报，不臆造）
 *
 * **边界（诚实标记）**：只认**节点 metadata 三条卡引用栏**宣告的绑定；专案级锁定集合
 * （`CanvasProject.cardIds` → 全项目注入）不在此判定内。只回报，不触发任何重跑/UI/写入。
 */
export function affectedShotNodesByCardIds(
  nodes: readonly StoryboardQcNodeRef[],
  cardIds: readonly string[],
): { affectedCardIds: string[]; shotNodeIds: string[] } {
  const targets = new Set(uniqueCardIds(cardIds));
  const affectedCardIds: string[] = [];
  const shotNodeIds: string[] = [];
  if (targets.size === 0) return { affectedCardIds, shotNodeIds };
  for (const node of nodes ?? []) {
    const meta = node?.metadata;
    if (!isNonBlankString(meta?.storyboardShot?.shotNumber)) continue;
    const hits: string[] = [];
    for (const field of SHOT_CARD_ID_FIELDS) {
      for (const id of uniqueCardIds(meta?.[field])) if (targets.has(id)) hits.push(id);
    }
    if (hits.length === 0) continue;
    for (const id of hits) if (!affectedCardIds.includes(id)) affectedCardIds.push(id);
    const nodeId = isNonBlankString(node.id) ? node.id.trim() : "";
    if (nodeId && !shotNodeIds.includes(nodeId)) shotNodeIds.push(nodeId);
  }
  return { affectedCardIds, shotNodeIds };
}
