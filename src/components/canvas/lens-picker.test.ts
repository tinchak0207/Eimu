// G7 测试：镜头词库选词入口（2026-09-16）。
// 惯例（同 StoryboardShotBody.test.ts / Scene3dPreview.test.ts）：node:test + 行为断言
// （纯函数直测 / SSR 真渲染 / 源码接线断言）。tsconfig 排除 *.test.tsx，故测试档用
// .ts + createElement（同款）。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// tsconfig jsx=preserve → classic runtime，SSR 渲染前补全局 React 桩（同款前例）。
(globalThis as unknown as Record<string, unknown>).React ??= React;

function read(relPath: string) {
  return readFileSync(join(process.cwd(), relPath), "utf8");
}

import {
  LENS_PICKER_MAX_SELECTION,
  LENS_SLOT_META,
  composeLensInsertion,
  lensPickerGroups,
  lensSelectionSummary,
  lensSlotOf,
  lensSlotOfName,
  toggleLensSelection,
} from "./lens-picker";
import { LensPickerSection } from "./LensPickerSection";
import {
  LENS_LANGUAGE_LIBRARY,
  LENS_LANGUAGE_SOURCE,
  composeLensFragment,
} from "@/lib/lens-language-library";

/** skill 生成器的类别顺序（`tools/gen-lens-skill.ts` GROUP_ORDER，逐字）。 */
const SKILL_GROUP_ORDER = [
  "composition",
  "shot_size",
  "camera_angle",
  "focal_length",
  "lens_type",
  "color_tone",
  "lighting",
  "exposure_blur",
  "camera_movement",
  "shooting_technique",
  "quality_base",
  "negative_base",
] as const;

const EXPECTED_COUNTS: Record<string, number> = {
  composition: 16,
  shot_size: 10,
  camera_angle: 13,
  focal_length: 9,
  lens_type: 5,
  color_tone: 15,
  lighting: 24,
  exposure_blur: 15,
  camera_movement: 17,
  shooting_technique: 13,
  quality_base: 3,
  negative_base: 2,
};

// ─────────────────────────── 分组

test("lens-picker: 12 类齐全、顺序与 skill 生成器一致、条数逐类对帐", () => {
  const groups = lensPickerGroups();
  assert.equal(groups.length, 12);
  assert.deepEqual(
    groups.map((g) => g.id),
    [...SKILL_GROUP_ORDER],
    "分组顺序必须等于 tools/gen-lens-skill.ts 的 GROUP_ORDER（单一真源不许漂移）",
  );
  let total = 0;
  for (const g of groups) {
    assert.equal(g.count, EXPECTED_COUNTS[g.id], `${g.id} 条数不符`);
    assert.equal(g.entries.length, g.count, `${g.id} entries 长度 ≠ count`);
    total += g.count;
  }
  assert.equal(total, 142, "12 类合计必须恰为 142 条");
  assert.equal(total, LENS_LANGUAGE_LIBRARY.length, "分组合计 ≠ 词库总数（有词条未归类）");
  assert.equal(LENS_LANGUAGE_SOURCE.totalEntries, 142);
});

test("lens-picker: 每组都有中文 label（未知分组回落原始 key，不捏造）", () => {
  for (const g of lensPickerGroups()) {
    assert.ok(g.label.trim().length > 0, `${g.id} 缺 label`);
    assert.notEqual(g.label, g.id, `${g.id} label 回落成 key = 漏登记`);
  }
});

test("lens-picker: 分组片段并集恰为词库全集（无词条漏出选词器）", () => {
  const union = lensPickerGroups().flatMap((g) => g.entries.map((e) => `${e.group}::${e.name}`));
  assert.equal(union.length, LENS_LANGUAGE_LIBRARY.length);
  assert.deepEqual(
    [...union].sort(),
    LENS_LANGUAGE_LIBRARY.map((e) => `${e.group}::${e.name}`).sort(),
  );
});

// ─────────────────────────── 选词

test("toggleLensSelection: 追加保持勾选顺序、再点取消、不改入参", () => {
  const first = toggleLensSelection([], "逆光");
  assert.deepEqual([...first], ["逆光"]);
  const second = toggleLensSelection(first, "三分构图");
  assert.deepEqual([...second], ["逆光", "三分构图"]);
  // 取消中间一条，其余顺序不变
  assert.deepEqual([...toggleLensSelection(second, "逆光")], ["三分构图"]);
  // 纯函数：入参未被原地修改
  assert.deepEqual([...first], ["逆光"]);
});

test("toggleLensSelection: 上限 6 条，超出忽略本次（不挤掉已选、不抛）", () => {
  const six = ["逆光", "侧光", "顶光", "底光", "环境光", "黄金时刻"];
  assert.equal(six.length, LENS_PICKER_MAX_SELECTION);
  const capped = toggleLensSelection(six, "蓝调时刻");
  assert.deepEqual([...capped], six, "满额后追加必须被忽略且已选原封不动");
  // 满额时仍可取消（否则使用者被锁死）
  assert.equal(toggleLensSelection(six, "逆光").length, 5);
});

test("toggleLensSelection: 上限等于既有轮子 composeLensFragment 的预设 limit（双源不漂移）", () => {
  const seven = ["逆光", "侧光", "顶光", "底光", "环境光", "黄金时刻", "蓝调时刻"];
  // 轮子预设 limit=6：给 7 条只出 6 条
  assert.equal(composeLensFragment(seven).split("；").length, 6);
  assert.equal(LENS_PICKER_MAX_SELECTION, 6);
});

// ─────────────────────────── 组装

test("composeLensInsertion: text 逐字等于既有轮子 composeLensFragment(used)", () => {
  const names = ["逆光", "三分构图", "85mm 人像"];
  const result = composeLensInsertion(names);
  assert.deepEqual([...result.used], names);
  assert.equal(result.text, composeLensFragment(names));
  assert.equal(
    result.text,
    "逆光，主光自主体正后方射入，边缘被勾出一圈轮廓光，正面转入柔和剪影。；" +
      "三分法构图，主体置于三分线交点，画面均衡，视觉重心自然。；" +
      "八十五毫米中长焦，主体比例最讨喜，背景虚化柔和，主体与背景分离干净。",
  );
  assert.equal(result.omitted.length, 0);
});

test("composeLensInsertion: 未命中词条不编造、重复去重、超额如实列进 omitted", () => {
  const unknown = composeLensInsertion(["这不是词库里的词"]);
  assert.equal(unknown.text, "");
  assert.deepEqual([...unknown.used], []);
  assert.deepEqual([...unknown.omitted], ["这不是词库里的词"]);

  const dup = composeLensInsertion(["逆光", "逆光"]);
  assert.deepEqual([...dup.used], ["逆光"]);
  assert.deepEqual([...dup.omitted], ["逆光"]);

  const over = composeLensInsertion(["逆光", "侧光", "顶光", "底光", "环境光", "黄金时刻", "蓝调时刻", "硬光"]);
  assert.equal(over.used.length, 6);
  assert.deepEqual([...over.omitted], ["蓝调时刻", "硬光"]);
  // 超额不得静默：used + omitted 必等于输入长度
  assert.equal(over.used.length + over.omitted.length, 8);
});

test("composeLensInsertion: 空输入回空（不抛、不编造）", () => {
  const empty = composeLensInsertion([]);
  assert.equal(empty.text, "");
  assert.equal(empty.slots.length, 0);
  assert.equal(lensSelectionSummary([]), "已选 0/6 条");
});

test("composeLensInsertion: 槽视图只归类不改语序，槽内顺序 = 勾选顺序", () => {
  const result = composeLensInsertion(["逆光", "三分构图", "长焦", "暖色调"]);
  const byId = new Map(result.slots.map((s) => [s.id, s]));
  assert.deepEqual([...(byId.get("lighting")?.names ?? [])], ["逆光", "暖色调"]);
  assert.deepEqual([...(byId.get("action")?.names ?? [])], ["三分构图"]);
  assert.deepEqual([...(byId.get("style")?.names ?? [])], ["长焦"]);
  // 空槽不进 slots（不留空壳）
  assert.equal(byId.has("movement"), false);
  assert.equal(byId.has("negative"), false);
  // 槽片段同样走既有轮子
  assert.equal(byId.get("lighting")?.text, composeLensFragment(["逆光", "暖色调"]));
});

test("lensSlotOf: 12 类全部有槽位（新增类别未登记 → 测试红）", () => {
  for (const g of SKILL_GROUP_ORDER) {
    assert.ok(lensSlotOf(g), `${g} 未归入任何槽`);
  }
  assert.equal(lensSlotOf("不存在的类"), undefined);
  assert.equal(lensSlotOfName("逆光"), "lighting");
  assert.equal(lensSlotOfName("360度环绕"), "movement");
  assert.equal(lensSlotOfName("通用防崩坏负面词"), "negative");
  assert.equal(lensSlotOfName("不存在的词"), undefined);
});

test("lensSlotOf: 每个槽都有 label/note/groups（UI 直接印，不留空字串）", () => {
  assert.ok(LENS_SLOT_META.length >= 6);
  for (const slot of LENS_SLOT_META) {
    assert.ok(slot.label.trim().length > 0, `${slot.id} 缺 label`);
    assert.ok(slot.note.trim().length > 0, `${slot.id} 缺 note`);
    assert.ok(slot.groups.length > 0, `${slot.id} 缺 groups`);
  }
  // 槽之间不重叠（一个类别只归一槽，否则 UI 会显示两次同批词）
  const all = LENS_SLOT_META.flatMap((s) => s.groups);
  assert.equal(new Set(all).size, all.length, "槽位 groups 有重叠");
});

// ─────────────────────────── SSR 真渲染

test("LensPickerSection 真渲染：12 类 chips + 全部 142 条词条卡（非源码形状断言）", () => {
  const html = renderToStaticMarkup(
    createElement(LensPickerSection, {
      onInsertText: () => {},
      onUsePrompt: () => {},
    }),
  );

  // 12 类 chips（label + 条数）
  for (const [id, count] of Object.entries(EXPECTED_COUNTS)) {
    const label = LENS_LANGUAGE_LIBRARY.find((e) => e.group === id)!.group;
    assert.ok(label, id);
    assert.match(html, new RegExp(`${count}\\b`), `${id} 条数未显示`);
  }
  // 全部 142 条词条名都在 DOM（前端真的能看到并选到，不是只渲染一页）
  const missing = LENS_LANGUAGE_LIBRARY.filter((e) => !html.includes(`aria-label="选择 ${e.name}"`));
  assert.deepEqual(missing.map((e) => e.name), [], "有词条未渲染进 DOM");
  // 每条原文都在 DOM（原文 = 交付物本体）
  assert.equal((html.match(/aria-pressed="false"/g) ?? []).length, 142);
  // 未选任何词时插入钮禁用（不假装能插入空字串）
  assert.equal((html.match(/disabled=""/g) ?? []).length, 2);
  // 来源声明（MIT 溯源）在面板上
  assert.ok(html.includes(LENS_LANGUAGE_SOURCE.repo));
  assert.ok(html.includes(LENS_LANGUAGE_SOURCE.license));
  // 传了 onUsePrompt → 两个插入钮都在（下一个测试验「不传就不渲染」）
  assert.ok(html.includes("用到当前节点"));
});

test("LensPickerSection 真渲染：传了 onUsePrompt 才出第二个插入钮", () => {
  const html = renderToStaticMarkup(
    createElement(LensPickerSection, { onInsertText: () => {} }),
  );
  assert.equal(html.includes("插入画布"), true);
  assert.equal(html.includes("用到当前节点"), false);

  const withUse = renderToStaticMarkup(
    createElement(LensPickerSection, { onInsertText: () => {}, onUsePrompt: () => {} }),
  );
  assert.equal(withUse.includes("用到当前节点"), true);
});

test("LensPickerSection 真渲染：正文 ≥13px 铁律（11px 只给来源声明与计数标签）", () => {
  const html = renderToStaticMarkup(
    createElement(LensPickerSection, { onInsertText: () => {}, onUsePrompt: () => {} }),
  );
  // 词条原文（交付物本体）走 ios-footnote = 13px，不得掉到 caption2（11px）
  const entryTexts = html.match(/<span class="mt-0\.5 block text-ios-footnote[^"]*">/g) ?? [];
  assert.equal(entryTexts.length, 142, "词条原文必须 142 条且字级为 ios-footnote(13px)");
  assert.equal(/text-xs/.test(html), false, "不得使用 text-xs(12px) 于正文");
});

// ─────────────────────────── 接线（源码形状）

test("CanvasLibraryPanel 挂载镜头词库 tab：复用既有 onInsertText/onUsePrompt，不新增插入通道", () => {
  const panel = read("src/components/canvas/CanvasLibraryPanel.tsx");
  // tab 注册（与提示词库/风格库同层）
  assert.match(panel, /\{ id: "lens", label: "镜头词库" \}/);
  assert.match(panel, /type LibraryTab = "prompts" \| "styles" \| "recipes" \| "lens" \| "assets"/);
  // section 挂载：两个回调原样透传（不包一层自造逻辑）
  assert.match(panel, /<LensPickerSection/);
  assert.match(panel, /onInsertText=\{onInsertText\}/);
  assert.match(panel, /onUsePrompt=\{onUsePrompt \? \(prompt\) => onUsePrompt\(prompt\) : undefined\}/);
  // props 介面零改动（插入通道仍是本体既有那对）
  assert.match(panel, /onInsertText: \(text: string, title\?: string\) => void;/);
  assert.match(panel, /onUsePrompt\?: \(prompt: string\) => void;/);
});

test("词库元件不碰 src/lib/：只读 lens-language-library 的既有导出", () => {
  const picker = read("src/components/canvas/lens-picker.ts");
  const section = read("src/components/canvas/LensPickerSection.tsx");
  for (const src of [picker, section]) {
    // 只读既有导出，不新增/改词条
    assert.equal(/LENS_LANGUAGE_LIBRARY\s*=/.test(src), false, "不得在本片重新定义词库");
    assert.equal(/group:.*name:.*text:/.test(src), false, "不得在本片内联词条字面量");
  }
  assert.match(picker, /from "@\/lib\/lens-language-library"/);
  // 拼装一律走既有轮子，不自造第二套
  assert.match(picker, /composeLensFragment\(/);
  assert.equal(/join\("；"\)/.test(picker), false, "不得手写第二套拼接（须走 composeLensFragment）");
});

/**
 * CanvasLibraryPanel 的 tab 列无法在此 runner 内真渲染：该档 import 了
 * `panels.css`，tsx 在 bare Node 进程下无 CSS loader（既有障碍，非本片引入；
 * 不为跑测试去改建既有档）。故本片对面板只做**源码形状断言 + tab 注册表结构断言**，
 * 而把「真渲染 142 条词条」的举证放在 LensPickerSection（该元件零 CSS import，
 * 可 SSR）。此为诚实缺口，已写进回报。
 */
test("CanvasLibraryPanel 的 tab 注册表含「镜头词库」且与既有 tab 同构（源码形状）", () => {
  const panel = read("src/components/canvas/CanvasLibraryPanel.tsx");
  // tab 注册表是 inline 阵列；「镜头词库」必须在同一张表里（不是孤立的死字串）
  const arr = panel.slice(panel.indexOf("[\n            { id: \"prompts\""), panel.indexOf("as { id: LibraryTab; label: string }[]"));
  const entries = [...arr.matchAll(/\{ id: "([a-z]+)"[^}]*label: "([^"]+)"/g)].map((m) => ({ id: m[1], label: m[2] }));
  assert.deepEqual(
    entries.map((e) => e.id),
    ["prompts", "styles", "lens", "recipes", "assets"],
    "tab 注册表顺序/成员不符（recipes 为条件展开，位置在 lens 之后、assets 之前）",
  );
  assert.equal(entries.find((e) => e.id === "lens")?.label, "镜头词库");
  // 条件式 recipes tab 仍在（既有行为不得被挤掉）
  assert.match(panel, /onApplyRecipeTemplate \? \[\{ id: "recipes" as LibraryTab, label: "配方模板" \}\] : \[\]/);
});

test("词库原文与 library 逐字一致（抽样 12 类各一条，防渲染层改写）", () => {
  const html = renderToStaticMarkup(
    createElement(LensPickerSection, { onInsertText: () => {} }),
  );
  for (const group of SKILL_GROUP_ORDER) {
    const entry = LENS_LANGUAGE_LIBRARY.find((e) => e.group === group)!;
    assert.ok(html.includes(entry.text), `${group}/${entry.name} 原文未逐字出现在 DOM`);
  }
});
