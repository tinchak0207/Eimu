// 镜头词库选词器的纯函数层（2026-09-16，G7：镜头语言词库的前端选词入口）。
//
// 为什么独立成纯函数档：选词规则（分组枚举、勾选上限、原文片段组装、六槽归属）是
// **可机器验证**的部分，渲染只是把它印出来。放这里让 `lens-picker.test.ts` 直接驱动，
// 不必开浏览器；组件只负责把结果画成 DOM。
//
// 数据源唯一：`src/lib/lens-language-library.ts`（AID MIT 逐字 142 条 / 12 类）。
// 本档**不新增任何词条、不改任何原文**——`composeLensFragment()` 是既有的注入轮子，
// 这里只做「多选 → 分组 → 拼装 → 六槽归属」的外壳，不写第二套拼装逻辑。
//
// 六槽归属表逐字取自 skill 生成物（`tools/gen-lens-skill.ts` 的「与 §2 六槽的对应」），
// 不自行发明映射。三处如实声明在 `LENS_SLOT_META.note`：本站词库覆盖不了
// Format/Aspect Ratio、Setting/Environment、Subject/Scene 三槽（无对应类别）。

import {
  LENS_LANGUAGE_GROUP_LABELS,
  LENS_LANGUAGE_LIBRARY,
  composeLensFragment,
  lensEntriesByGroup,
  type LensLanguageEntry,
} from "@/lib/lens-language-library";

/**
 * 单次注入上限 = 6 条。
 * 双源一致：`composeLensFragment()` 的默认 `limit = 6`，skill 纪律「单次注入 ≤6 条
 * （prompt 会爆炸）」。测试钉死两者相等（改轮子默认值而不改这里 → 测试红）。
 */
export const LENS_PICKER_MAX_SELECTION = 6;

/** 一个分组（12 类之一）：id = AID 原始 `prompt_type`，label 为展示层中文。 */
export interface LensPickerGroup {
  id: string;
  label: string;
  count: number;
  entries: readonly LensLanguageEntry[];
}

/**
 * 12 类分组（顺序 = 词库首见顺序，与 `tools/gen-lens-skill.ts` 的 GROUP_ORDER 逐字一致）。
 *
 * 为何由 library 首见顺序推导而不是再抄一份 GROUP_ORDER：词库是唯一真源，抄一份就多一个
 * 会漂移的副本；测试直接断言语组顺序 = 12 类期望序列，漂移必红。
 * 未知分组（词库新增类别而 label 未跟）label 回落原始 key——**不捏造中文**。
 */
export function lensPickerGroups(): readonly LensPickerGroup[] {
  const out: LensPickerGroup[] = [];
  const seen = new Set<string>();
  for (const entry of LENS_LANGUAGE_LIBRARY) {
    if (seen.has(entry.group)) continue;
    seen.add(entry.group);
    const entries = lensEntriesByGroup(entry.group);
    out.push({
      id: entry.group,
      label: LENS_LANGUAGE_GROUP_LABELS[entry.group] ?? entry.group,
      count: entries.length,
      entries,
    });
  }
  return out;
}

/** 六槽 + 三个库外挂槽的 id。 */
export type LensSlotId = "lighting" | "action" | "style" | "movement" | "quality" | "negative";

export interface LensSlotMeta {
  id: LensSlotId;
  /** 槽名（前三个逐字取 skill 的六槽对应表）。 */
  label: string;
  /** 该槽吃哪些类（同一张表）。 */
  groups: readonly string[];
  /** 该槽往哪去（诚实标注去向）。 */
  note: string;
}

/**
 * 槽位表：顺序 = 展示顺序（光与色 → 动作与构图 → 风格 → 运镜 → 保底）。
 *
 * 前三个槽对应 AGENTS.md §2 六槽的 Lighting/Color、Action/Composition、Style/Art
 * Direction（措辞逐字取 skill 表）；`camera_movement` 按 skill 说明用于**视频** prompt
 * 的运镜槽；`quality_base` / `negative_base` 按 skill 说明「按需附在末尾」。
 */
export const LENS_SLOT_META: readonly LensSlotMeta[] = [
  {
    id: "lighting",
    label: "Lighting/Color（光与色）",
    groups: ["lighting", "color_tone", "exposure_blur"],
    note: "进画面描述的光线与色彩槽",
  },
  {
    id: "action",
    label: "Action/Composition（动作与构图）",
    groups: ["composition", "shot_size", "camera_angle"],
    note: "进画面描述的构图与视角槽",
  },
  {
    id: "style",
    label: "Style/Art Direction（风格与美术方向）",
    groups: ["shooting_technique", "focal_length", "lens_type"],
    note: "进画面描述的风格槽",
  },
  {
    id: "movement",
    label: "运镜（视频 prompt）",
    groups: ["camera_movement"],
    note: "视频 prompt 的运镜槽；静帧图片用不上",
  },
  {
    id: "quality",
    label: "画质保底（附末尾）",
    groups: ["quality_base"],
    note: "粘在 prompt 末尾",
  },
  {
    id: "negative",
    label: "负向词保底（附末尾）",
    groups: ["negative_base"],
    note: "粘在 prompt 末尾；画布生成面板目前没有独立负向槽",
  },
];

/** 类别 → 槽位；未归属（词库新增类别而本表未跟）回 undefined，不硬塞。 */
export function lensSlotOf(group: string): LensSlotId | undefined {
  for (const slot of LENS_SLOT_META) {
    if (slot.groups.includes(group)) return slot.id;
  }
  return undefined;
}

/** 词条名 → 槽位（词条不存在回 undefined）。 */
export function lensSlotOfName(name: string): LensSlotId | undefined {
  const entry = LENS_LANGUAGE_LIBRARY.find((e) => e.name === name);
  return entry ? lensSlotOf(entry.group) : undefined;
}

/**
 * 勾选切换：已选则移除，未选则追加到尾部（保持勾选顺序，插入语序可预期）。
 * 纯函数——不原地改入参；超出 `LENS_PICKER_MAX_SELECTION` 时**忽略本次追加**
 * （不静默挤掉已选的，也不抛）。
 */
export function toggleLensSelection(
  selected: readonly string[],
  name: string,
  max: number = LENS_PICKER_MAX_SELECTION,
): readonly string[] {
  if (selected.includes(name)) return selected.filter((n) => n !== name);
  if (selected.length >= max) return selected;
  return [...selected, name];
}

/** 某个槽的组装结果（仅非空槽会出现在返回值里）。 */
export interface LensSlotDraft {
  id: LensSlotId;
  label: string;
  note: string;
  /** 落进该槽的词条名（勾选顺序的子序列）。 */
  names: readonly string[];
  /** 原文片段（`composeLensFragment` 同款 `；` 连接）。 */
  text: string;
}

/** 多选 → 插入结果。 */
export interface LensInsertion {
  /** 直接喂 `onInsertText` / `onUsePrompt` 的文本（= 既有轮子 `composeLensFragment()` 输出）。 */
  text: string;
  /** 实际进了 prompt 的词条名（去重、命中、受 limit 约束）。 */
  used: readonly string[];
  /** 没进的词条名（重复/词库未命中/超额），UI 如实列出，不静默吞掉。 */
  omitted: readonly string[];
  /** 六槽（+3 个库外挂槽）组装视图：仅非空槽，顺序 = `LENS_SLOT_META`。 */
  slots: readonly LensSlotDraft[];
}

/**
 * 一趟扫描同时给出「进 prompt 的」与「没进的（及原因）」：
 * 去重 + 词库命中过滤 + 上限截断。**规则必须与 `composeLensFragment()` 内部等价**——
 * 测试对同一批输入断言 `text === composeLensFragment(used)`，规则漂移即红。
 */
function resolveNames(
  names: readonly string[],
  limit: number,
): { used: readonly string[]; omitted: readonly string[] } {
  const seen = new Set<string>();
  const used: string[] = [];
  const omitted: string[] = [];
  for (const name of names) {
    if (seen.has(name) || !LENS_LANGUAGE_LIBRARY.some((e) => e.name === name) || used.length >= limit) {
      omitted.push(name);
      continue;
    }
    seen.add(name);
    used.push(name);
  }
  return { used, omitted };
}

/** 把 `used` 按槽切开（槽内保持勾选顺序；空槽不出现）。 */
export function lensSlotDrafts(used: readonly string[]): readonly LensSlotDraft[] {
  const out: LensSlotDraft[] = [];
  for (const slot of LENS_SLOT_META) {
    const inSlot = used.filter((name) => {
      const entry = LENS_LANGUAGE_LIBRARY.find((e) => e.name === name);
      return entry ? slot.groups.includes(entry.group) : false;
    });
    if (inSlot.length === 0) continue;
    out.push({
      id: slot.id,
      label: slot.label,
      note: slot.note,
      names: inSlot,
      text: composeLensFragment(inSlot, inSlot.length),
    });
  }
  return out;
}

/**
 * 多选 → 插入文本 + 六槽视图。
 *
 * 文本**恒等于** `composeLensFragment(used)`（既有注入轮子的默认 limit = 6）——本档不在
 * 这里写第二套拼接。`slots[].text` 是同一批词条按槽重切的等长视图（槽内不受全局 6 条
 * 影响，因为槽视图的条数上限就是 `used.length`）。
 */
export function composeLensInsertion(
  names: readonly string[],
  limit: number = LENS_PICKER_MAX_SELECTION,
): LensInsertion {
  const safeLimit = Math.max(0, Math.floor(limit));
  const { used, omitted } = resolveNames(names, safeLimit);
  return {
    // safeLimit ≥ used.length 恒成立，故这里不会二次截断（默认 limit 下与
    // `composeLensFragment(used)` 逐字相等，由测试钉死）。
    text: composeLensFragment(used, safeLimit),
    used,
    omitted,
    slots: lensSlotDrafts(used),
  };
}

/** 已选条数的展示文案（不吹不瞒：上限就是上限）。 */
export function lensSelectionSummary(selected: readonly string[], max: number = LENS_PICKER_MAX_SELECTION): string {
  return `已选 ${selected.length}/${max} 条`;
}
