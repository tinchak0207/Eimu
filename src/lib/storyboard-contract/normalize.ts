import { isAssetApproved } from "../character-cards";
import type { AgentInteractionMode } from "../agent-chat-client";
import { cleanField, isRecord } from "./validate";
import { STORYBOARD_SHOT_FIELDS, STORYBOARD_SNAPSHOT_FIELD_CHARS } from "./types";
import type { StoryboardQcCardRef, StoryboardReferenceAssets, StoryboardSceneRef, StoryboardScriptShot, StoryboardShotField } from "./types";

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
