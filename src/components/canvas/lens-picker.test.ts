// G7 測試：镜头词库选词入口（2026-09-16）。
// 慣例（同 StoryboardShotBody.test.ts / Scene3dPreview.test.ts）：node:test + 行為斷言
// （純函數直測 / SSR 真渲染 / 源碼接線斷言）。tsconfig 排除 *.test.tsx，故測試檔用
// .ts + createElement（同款）。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// tsconfig jsx=preserve → classic runtime，SSR 渲染前補全局 React 桩（同款前例）。
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

/** skill 生成器的類別順序（`tools/gen-lens-skill.ts` GROUP_ORDER，逐字）。 */
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

// ─────────────────────────── 分組

test("lens-picker: 12 類齊全、順序與 skill 生成器一致、條數逐類對帳", () => {
  const groups = lensPickerGroups();
  assert.equal(groups.length, 12);
  assert.deepEqual(
    groups.map((g) => g.id),
    [...SKILL_GROUP_ORDER],
    "分組順序必須等於 tools/gen-lens-skill.ts 的 GROUP_ORDER（單一真源不許漂移）",
  );
  let total = 0;
  for (const g of groups) {
    assert.equal(g.count, EXPECTED_COUNTS[g.id], `${g.id} 條數不符`);
    assert.equal(g.entries.length, g.count, `${g.id} entries 長度 ≠ count`);
    total += g.count;
  }
  assert.equal(total, 142, "12 類合計必須恰為 142 條");
  assert.equal(total, LENS_LANGUAGE_LIBRARY.length, "分組合計 ≠ 詞庫總數（有詞條未歸類）");
  assert.equal(LENS_LANGUAGE_SOURCE.totalEntries, 142);
});

test("lens-picker: 每組都有中文 label（未知分組回落原始 key，不捏造）", () => {
  for (const g of lensPickerGroups()) {
    assert.ok(g.label.trim().length > 0, `${g.id} 缺 label`);
    assert.notEqual(g.label, g.id, `${g.id} label 回落成 key = 漏登記`);
  }
});

test("lens-picker: 分組片段並集恰為詞庫全集（無詞條漏出選詞器）", () => {
  const union = lensPickerGroups().flatMap((g) => g.entries.map((e) => `${e.group}::${e.name}`));
  assert.equal(union.length, LENS_LANGUAGE_LIBRARY.length);
  assert.deepEqual(
    [...union].sort(),
    LENS_LANGUAGE_LIBRARY.map((e) => `${e.group}::${e.name}`).sort(),
  );
});

// ─────────────────────────── 選詞

test("toggleLensSelection: 追加保持勾選順序、再點取消、不改入參", () => {
  const first = toggleLensSelection([], "逆光");
  assert.deepEqual([...first], ["逆光"]);
  const second = toggleLensSelection(first, "三分构图");
  assert.deepEqual([...second], ["逆光", "三分构图"]);
  // 取消中間一條，其餘順序不變
  assert.deepEqual([...toggleLensSelection(second, "逆光")], ["三分构图"]);
  // 純函數：入參未被原地修改
  assert.deepEqual([...first], ["逆光"]);
});

test("toggleLensSelection: 上限 6 條，超出忽略本次（不擠掉已選、不拋）", () => {
  const six = ["逆光", "侧光", "顶光", "底光", "环境光", "黄金时刻"];
  assert.equal(six.length, LENS_PICKER_MAX_SELECTION);
  const capped = toggleLensSelection(six, "蓝调时刻");
  assert.deepEqual([...capped], six, "滿額後追加必須被忽略且已選原封不動");
  // 滿額時仍可取消（否則使用者被鎖死）
  assert.equal(toggleLensSelection(six, "逆光").length, 5);
});

test("toggleLensSelection: 上限等於既有輪子 composeLensFragment 的預設 limit（雙源不漂移）", () => {
  const seven = ["逆光", "侧光", "顶光", "底光", "环境光", "黄金时刻", "蓝调时刻"];
  // 輪子預設 limit=6：給 7 條只出 6 條
  assert.equal(composeLensFragment(seven).split("；").length, 6);
  assert.equal(LENS_PICKER_MAX_SELECTION, 6);
});

// ─────────────────────────── 組裝

test("composeLensInsertion: text 逐字等於既有輪子 composeLensFragment(used)", () => {
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

test("composeLensInsertion: 未命中詞條不編造、重複去重、超額如實列進 omitted", () => {
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
  // 超額不得靜默：used + omitted 必等於輸入長度
  assert.equal(over.used.length + over.omitted.length, 8);
});

test("composeLensInsertion: 空輸入回空（不拋、不編造）", () => {
  const empty = composeLensInsertion([]);
  assert.equal(empty.text, "");
  assert.equal(empty.slots.length, 0);
  assert.equal(lensSelectionSummary([]), "已选 0/6 条");
});

test("composeLensInsertion: 槽視圖只歸類不改語序，槽內順序 = 勾選順序", () => {
  const result = composeLensInsertion(["逆光", "三分构图", "长焦", "暖色调"]);
  const byId = new Map(result.slots.map((s) => [s.id, s]));
  assert.deepEqual([...(byId.get("lighting")?.names ?? [])], ["逆光", "暖色调"]);
  assert.deepEqual([...(byId.get("action")?.names ?? [])], ["三分构图"]);
  assert.deepEqual([...(byId.get("style")?.names ?? [])], ["长焦"]);
  // 空槽不進 slots（不留空殼）
  assert.equal(byId.has("movement"), false);
  assert.equal(byId.has("negative"), false);
  // 槽片段同樣走既有輪子
  assert.equal(byId.get("lighting")?.text, composeLensFragment(["逆光", "暖色调"]));
});

test("lensSlotOf: 12 類全部有槽位（新增類別未登記 → 測試紅）", () => {
  for (const g of SKILL_GROUP_ORDER) {
    assert.ok(lensSlotOf(g), `${g} 未歸入任何槽`);
  }
  assert.equal(lensSlotOf("不存在的類"), undefined);
  assert.equal(lensSlotOfName("逆光"), "lighting");
  assert.equal(lensSlotOfName("360度环绕"), "movement");
  assert.equal(lensSlotOfName("通用防崩坏负面词"), "negative");
  assert.equal(lensSlotOfName("不存在的词"), undefined);
});

test("lensSlotOf: 每個槽都有 label/note/groups（UI 直接印，不留空字串）", () => {
  assert.ok(LENS_SLOT_META.length >= 6);
  for (const slot of LENS_SLOT_META) {
    assert.ok(slot.label.trim().length > 0, `${slot.id} 缺 label`);
    assert.ok(slot.note.trim().length > 0, `${slot.id} 缺 note`);
    assert.ok(slot.groups.length > 0, `${slot.id} 缺 groups`);
  }
  // 槽之間不重疊（一個類別只歸一槽，否則 UI 會顯示兩次同批詞）
  const all = LENS_SLOT_META.flatMap((s) => s.groups);
  assert.equal(new Set(all).size, all.length, "槽位 groups 有重疊");
});

// ─────────────────────────── SSR 真渲染

test("LensPickerSection 真渲染：12 類 chips + 全部 142 條詞條卡（非源碼形狀斷言）", () => {
  const html = renderToStaticMarkup(
    createElement(LensPickerSection, {
      onInsertText: () => {},
      onUsePrompt: () => {},
    }),
  );

  // 12 類 chips（label + 條數）
  for (const [id, count] of Object.entries(EXPECTED_COUNTS)) {
    const label = LENS_LANGUAGE_LIBRARY.find((e) => e.group === id)!.group;
    assert.ok(label, id);
    assert.match(html, new RegExp(`${count}\\b`), `${id} 條數未顯示`);
  }
  // 全部 142 條詞條名都在 DOM（前端真的能看到並選到，不是只渲染一頁）
  const missing = LENS_LANGUAGE_LIBRARY.filter((e) => !html.includes(`aria-label="选择 ${e.name}"`));
  assert.deepEqual(missing.map((e) => e.name), [], "有詞條未渲染進 DOM");
  // 每條原文都在 DOM（原文 = 交付物本體）
  assert.equal((html.match(/aria-pressed="false"/g) ?? []).length, 142);
  // 未選任何詞時插入鈕禁用（不假裝能插入空字串）
  assert.equal((html.match(/disabled=""/g) ?? []).length, 2);
  // 來源聲明（MIT 溯源）在面板上
  assert.ok(html.includes(LENS_LANGUAGE_SOURCE.repo));
  assert.ok(html.includes(LENS_LANGUAGE_SOURCE.license));
  // 傳了 onUsePrompt → 兩個插入鈕都在（下一個測試驗「不傳就不渲染」）
  assert.ok(html.includes("用到当前节点"));
});

test("LensPickerSection 真渲染：傳了 onUsePrompt 才出第二個插入鈕", () => {
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

test("LensPickerSection 真渲染：正文 ≥13px 铁律（11px 只给來源聲明與計數標籤）", () => {
  const html = renderToStaticMarkup(
    createElement(LensPickerSection, { onInsertText: () => {}, onUsePrompt: () => {} }),
  );
  // 詞條原文（交付物本體）走 ios-footnote = 13px，不得掉到 caption2（11px）
  const entryTexts = html.match(/<span class="mt-0\.5 block text-ios-footnote[^"]*">/g) ?? [];
  assert.equal(entryTexts.length, 142, "詞條原文必須 142 條且字級為 ios-footnote(13px)");
  assert.equal(/text-xs/.test(html), false, "不得使用 text-xs(12px) 於正文");
});

// ─────────────────────────── 接線（源碼形狀）

test("CanvasLibraryPanel 掛載鏡頭詞庫 tab：複用既有 onInsertText/onUsePrompt，不新增插入通道", () => {
  const panel = read("src/components/canvas/CanvasLibraryPanel.tsx");
  // tab 註冊（與提示詞庫/風格庫同層）
  assert.match(panel, /\{ id: "lens", label: "镜头词库" \}/);
  assert.match(panel, /type LibraryTab = "prompts" \| "styles" \| "recipes" \| "lens" \| "assets"/);
  // section 掛載：兩個回調原樣透傳（不包一層自造邏輯）
  assert.match(panel, /<LensPickerSection/);
  assert.match(panel, /onInsertText=\{onInsertText\}/);
  assert.match(panel, /onUsePrompt=\{onUsePrompt \? \(prompt\) => onUsePrompt\(prompt\) : undefined\}/);
  // props 介面零改動（插入通道仍是本體既有那對）
  assert.match(panel, /onInsertText: \(text: string, title\?: string\) => void;/);
  assert.match(panel, /onUsePrompt\?: \(prompt: string\) => void;/);
});

test("詞庫元件不碰 src/lib/：只讀 lens-language-library 的既有導出", () => {
  const picker = read("src/components/canvas/lens-picker.ts");
  const section = read("src/components/canvas/LensPickerSection.tsx");
  for (const src of [picker, section]) {
    // 只讀既有導出，不新增/改詞條
    assert.equal(/LENS_LANGUAGE_LIBRARY\s*=/.test(src), false, "不得在本片重新定義詞庫");
    assert.equal(/group:.*name:.*text:/.test(src), false, "不得在本片內聯詞條字面量");
  }
  assert.match(picker, /from "@\/lib\/lens-language-library"/);
  // 拼裝一律走既有輪子，不自造第二套
  assert.match(picker, /composeLensFragment\(/);
  assert.equal(/join\("；"\)/.test(picker), false, "不得手寫第二套拼接（須走 composeLensFragment）");
});

/**
 * CanvasLibraryPanel 的 tab 列無法在此 runner 內真渲染：該檔 import 了
 * `panels.css`，tsx 在 bare Node 進程下無 CSS loader（既有障礙，非本片引入；
 * 不為跑測試去改建既有檔）。故本片對面板只做**源碼形狀斷言 + tab 註冊表結構斷言**，
 * 而把「真渲染 142 條詞條」的舉證放在 LensPickerSection（該元件零 CSS import，
 * 可 SSR）。此為誠實缺口，已寫進回報。
 */
test("CanvasLibraryPanel 的 tab 註冊表含「镜头词库」且與既有 tab 同構（源碼形狀）", () => {
  const panel = read("src/components/canvas/CanvasLibraryPanel.tsx");
  // tab 註冊表是 inline 陣列；「镜头词库」必須在同一張表裡（不是孤立的死字串）
  const table = panel.slice(panel.indexOf("as { id: LibraryTab; label: string }[]"));
  const arr = panel.slice(panel.indexOf("[\n            { id: \"prompts\""), panel.indexOf("as { id: LibraryTab; label: string }[]"));
  const entries = [...arr.matchAll(/\{ id: "([a-z]+)"[^}]*label: "([^"]+)"/g)].map((m) => ({ id: m[1], label: m[2] }));
  assert.deepEqual(
    entries.map((e) => e.id),
    ["prompts", "styles", "lens", "recipes", "assets"],
    "tab 註冊表順序/成員不符（recipes 為條件展開，位置在 lens 之後、assets 之前）",
  );
  assert.equal(entries.find((e) => e.id === "lens")?.label, "镜头词库");
  // 條件式 recipes tab 仍在（既有行為不得被擠掉）
  assert.match(panel, /onApplyRecipeTemplate \? \[\{ id: "recipes" as LibraryTab, label: "配方模板" \}\] : \[\]/);
});

test("詞庫原文與 library 逐字一致（抽樣 12 類各一條，防渲染層改寫）", () => {
  const html = renderToStaticMarkup(
    createElement(LensPickerSection, { onInsertText: () => {} }),
  );
  for (const group of SKILL_GROUP_ORDER) {
    const entry = LENS_LANGUAGE_LIBRARY.find((e) => e.group === group)!;
    assert.ok(html.includes(entry.text), `${group}/${entry.name} 原文未逐字出現在 DOM`);
  }
});
