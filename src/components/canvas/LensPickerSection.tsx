"use client";

// LensPickerSection —— 镜头语言词库选词区（2026-09-16，G7：词库的前端选词入口）。
//
// 修的是「资产已就绪但无消费端」：`src/lib/lens-language-library.ts` 的 142 条 / 12 类
// 此前只有 agent 侧 skill 通道（VPS `skills/lens-language/SKILL.md`），前端 0 引用。
// 本区把词库接到**既有的插入通道**上——props 里的 `onInsertText` / `onUsePrompt` 就是
// `CanvasLibraryPanel` 自有的两个回调（提示词卡 / 风格卡同款），不另造一套插入机制：
//   · 插入画布 → `onInsertText(text, title)` → CanvasEmbed 建新文本节点
//   · 用到当前节点 → `onUsePrompt(text)` → CanvasEmbed patchNodeMetadata({prompt})
//
// 结构照同目录既有 section 化范式（`RecipeTemplateSection` + `use-recipe-templates`）：
// 「纯函数层 + 薄渲染」分离，选词规则全在 `./lens-picker.ts`（可机器验证）。
//
// 视觉沿用面板既有语汇（lg-fill-active / text-ios-* / border-border / bg-card）；
// 尺寸铁律：正文 ≥13px（DESIGN.md §4），11px 只给来源声明与计数标签。渲染验收权在项目负责人，
// 本组件不做自我 UI 检查。
//
// 诚实边界（三条，写入 UI 文案而非藏在代码里）：
//   1. 词条原文含中文详解（AID 逐字契约），**插入的是原文**，不做英文改写、不缩略。
//   2. 单次注入上限 6 条（`composeLensFragment()` 默认 limit，skill 同款纪律）；超出如实报
//      「已忽略 N 条」，不静默吞掉。
//   3. 槽位视图**只归类不改语序**：实际插入文本按勾选顺序拼接；三个槽
//      （Format/Aspect Ratio、Setting/Environment、Subject/Scene）本站词库没有对应类别，
//      不假装覆盖。

import { useMemo, useState } from "react";
import { Check, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { LENS_LANGUAGE_SOURCE } from "@/lib/lens-language-library";
import {
  LENS_PICKER_MAX_SELECTION,
  composeLensInsertion,
  lensPickerGroups,
  lensSelectionSummary,
  toggleLensSelection,
} from "./lens-picker";

// 尺寸铁律：正文 ≥13px（DESIGN.md §4）。本区的搜索框也走 13px（ios-footnote）——
// 同面板的提示词库/风格库搜索框是既有的 text-xs(12px)，本区刻意不跟：使用者要读/改的
// 文本不低于 13px，不为视觉一致牺牲可读性（既有那两处不属本片范围，未动）。
const INPUT_CLASS =
  "w-full rounded-lg border border-input bg-black/5 py-2 pl-8 pr-3 text-ios-footnote outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-ios-blue";

const ACTION_BTN_CLASS =
  "rounded-md bg-black/5 px-2 py-1 text-ios-caption2 font-medium text-muted-foreground transition-colors hover:bg-black/10 disabled:cursor-not-allowed disabled:opacity-50";

const PRIMARY_BTN_CLASS =
  "rounded-md bg-primary px-2 py-1 text-ios-caption2 font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40";

export interface LensPickerSectionProps {
  /** 插入文字到画布（新文本节点）——复用 `CanvasLibraryPanel.onInsertText`。 */
  onInsertText: (text: string, title?: string) => void;
  /** 填进当前打开的节点面板——复用 `CanvasLibraryPanel.onUsePrompt`（无则隐藏该按钮）。 */
  onUsePrompt?: (prompt: string) => void;
}

export function LensPickerSection({ onInsertText, onUsePrompt }: LensPickerSectionProps) {
  const groups = useMemo(() => lensPickerGroups(), []);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [groupFilter, setGroupFilter] = useState("");
  const [query, setQuery] = useState("");

  const insertion = useMemo(() => composeLensInsertion(selected), [selected]);
  const full = selected.length >= LENS_PICKER_MAX_SELECTION;

  const filteredGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return groups
      .filter((g) => !groupFilter || g.id === groupFilter)
      .map((g) => ({
        ...g,
        entries: g.entries.filter((e) => !q || e.name.toLowerCase().includes(q) || e.text.toLowerCase().includes(q)),
      }))
      .filter((g) => g.entries.length > 0);
  }, [groups, groupFilter, query]);

  const toggle = (name: string) => {
    // 选词规则在纯函数层（toggleLensSelection），组件不重写一遍上限判断。
    setSelected((current) => toggleLensSelection(current, name));
  };

  const insert = () => {
    if (!insertion.text) return;
    onInsertText(insertion.text, `镜头语言 · ${insertion.used.length} 条`);
  };

  const use = () => {
    if (!insertion.text || !onUsePrompt) return;
    onUsePrompt(insertion.text);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 头部：来源声明 + 已选计数 */}
      <div className="space-y-2 border-b px-3 py-2.5">
        <p className="text-ios-caption2 leading-snug text-foreground/45">
          来源：{LENS_LANGUAGE_SOURCE.repo}（{LENS_LANGUAGE_SOURCE.license}）· 逐字 {LENS_LANGUAGE_SOURCE.totalEntries} 条 /{" "}
          {groups.length} 类 · 插入的是词条原文，不改写
        </p>
        <div className="flex items-center gap-2">
          <span className="text-ios-footnote font-medium tabular-nums text-foreground">
            {lensSelectionSummary(selected)}
          </span>
          {full && <span className="text-ios-caption2 text-foreground/45">已满，先取消一条再选</span>}
          {selected.length > 0 && (
            <button type="button" onClick={() => setSelected([])} className={cn(ACTION_BTN_CLASS, "ml-auto")}>
              清空
            </button>
          )}
        </div>
      </div>

      {/* 已选 chips（点 ✕ 取消） */}
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-b px-3 py-2">
          {selected.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => toggle(name)}
              aria-label={`取消选择 ${name}`}
              className="flex shrink-0 items-center gap-1 rounded-full lg-fill-active px-2.5 py-1 text-ios-caption2 text-ios-blue"
            >
              {name}
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          ))}
        </div>
      )}

      {/* 六槽视图：按槽归类给用户看「这些词会落到哪一槽」 */}
      {insertion.slots.length > 0 && (
        <div className="space-y-1.5 border-b px-3 py-2.5">
          {insertion.slots.map((slot) => (
            <div key={slot.id}>
              <p className="text-ios-caption2 font-medium text-foreground/45">
                {slot.label} · {slot.names.length} 条 — {slot.note}
              </p>
              <p className="mt-0.5 text-ios-footnote leading-snug text-muted-foreground">{slot.text}</p>
            </div>
          ))}
          <p className="text-ios-caption2 leading-snug text-foreground/45">
            槽位只做归类，不改变语序：插入时按勾选顺序拼接原文
          </p>
          {insertion.omitted.length > 0 && (
            <p className="text-ios-caption2 leading-snug text-foreground/45">
              已忽略 {insertion.omitted.length} 条（重复或超出 {LENS_PICKER_MAX_SELECTION} 条上限）：
              {insertion.omitted.join("、")}
            </p>
          )}
        </div>
      )}

      {/* 插入动作：两个按钮就是面板既有的两条插入路径 */}
      <div className="flex items-center gap-1.5 border-b px-3 py-2.5">
        <button type="button" onClick={insert} disabled={!insertion.text} className={PRIMARY_BTN_CLASS}>
          插入画布
        </button>
        {onUsePrompt && (
          <button type="button" onClick={use} disabled={!insertion.text} className={ACTION_BTN_CLASS}>
            用到当前节点
          </button>
        )}
      </div>

      {/* 搜索 + 12 类 chips */}
      <div className="space-y-2 border-b px-3 py-2.5">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-foreground/45" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索镜头语言…"
            className={INPUT_CLASS}
          />
        </div>
        <div className="flex gap-1.5 overflow-x-auto pb-0.5">
          <button
            type="button"
            onClick={() => setGroupFilter("")}
            className={cn(
              "shrink-0 rounded-full px-2.5 py-1 text-ios-caption2 transition-colors",
              groupFilter === "" ? "lg-fill-active text-ios-blue" : "bg-black/5 text-muted-foreground hover:bg-black/10",
            )}
          >
            全部 {LENS_LANGUAGE_SOURCE.totalEntries}
          </button>
          {groups.map((g) => (
            <button
              key={g.id}
              type="button"
              onClick={() => setGroupFilter((current) => (current === g.id ? "" : g.id))}
              className={cn(
                "shrink-0 rounded-full px-2.5 py-1 text-ios-caption2 transition-colors",
                groupFilter === g.id ? "lg-fill-active text-ios-blue" : "bg-black/5 text-muted-foreground hover:bg-black/10",
              )}
            >
              {g.label} {g.count}
            </button>
          ))}
        </div>
      </div>

      {/* 词条列表：整卡可点选，原文全量显示（原文就是交付物的本体，不缩略） */}
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3">
        {filteredGroups.length === 0 && (
          <p className="py-10 text-center text-xs text-foreground/45">没有匹配的镜头语言</p>
        )}
        {filteredGroups.map((g) => (
          <div key={g.id} className="space-y-1.5">
            <p className="text-ios-caption2 font-medium text-foreground/45">
              {g.label}（{g.entries.length}）
            </p>
            {g.entries.map((entry) => {
              const picked = selected.includes(entry.name);
              const blocked = !picked && full;
              return (
                <button
                  key={`${g.id}::${entry.name}`}
                  type="button"
                  onClick={() => toggle(entry.name)}
                  aria-pressed={picked}
                  aria-label={`${picked ? "取消" : "选择"} ${entry.name}`}
                  disabled={blocked}
                  className={cn(
                    "w-full rounded-xl border p-2.5 text-left transition-colors",
                    picked ? "border-ios-blue/40 bg-ios-blue/5" : "border-border bg-card",
                    blocked ? "cursor-not-allowed opacity-50" : "hover:bg-black/5",
                  )}
                >
                  <span className="flex items-center gap-1.5">
                    <span className="min-w-0 flex-1 truncate text-ios-footnote font-medium text-foreground">
                      {entry.name}
                    </span>
                    {picked && <Check className="h-3.5 w-3.5 shrink-0 text-ios-blue" aria-hidden="true" />}
                  </span>
                  <span className="mt-0.5 block text-ios-footnote leading-snug text-muted-foreground">{entry.text}</span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

export default LensPickerSection;
