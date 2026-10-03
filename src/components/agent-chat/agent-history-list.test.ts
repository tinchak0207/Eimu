import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// tsconfig 的 jsx=preserve 让 tsx 对 .tsx 退回 classic runtime（React.createElement），
// 而组件源码不 import React（Next 构建走 automatic）。补全局 React 桩（同 agent-media-actions.test.ts）。
(globalThis as unknown as Record<string, unknown>).React ??= React;

import {
  AgentSessionList,
  filterAgentSessions,
  formatSessionRelativeTime,
} from "./AgentSessionList";
import type { AgentSessionSummary } from "@/lib/agent-chat-client";

const root = process.cwd();
const surfaceSrc = readFileSync(join(root, "src/components/agent-chat/AgentChatSurface.tsx"), "utf8");

const mk = (id: string, overrides: Partial<AgentSessionSummary> = {}): AgentSessionSummary => ({
  session_id: id,
  created_at: new Date(2026, 9, 1, 10, 0).getTime(),
  updated_at: new Date(2026, 9, 3, 15, 0).getTime(),
  last_activity_at: new Date(2026, 9, 3, 15, 0).getTime(),
  ...overrides,
});

// ─────────────────────────── 相對日期 helper（固定 now 注入，逐 case）

// now＝2026-10-03 16:46（本地時區的自然日，斷言不依賴 ICU）。
const NOW = new Date(2026, 9, 3, 16, 46, 0).getTime();

test("相对日期：今天 → HH:mm（含当天 00:00 边界与未来时间）", () => {
  assert.equal(formatSessionRelativeTime(new Date(2026, 9, 3, 4, 25).getTime(), NOW), "04:25");
  assert.equal(formatSessionRelativeTime(new Date(2026, 9, 3, 0, 0).getTime(), NOW), "00:00");
  // 今天稍晚（相对 now 是未来）仍算今天，不回「刚刚」也不落昨天。
  assert.equal(formatSessionRelativeTime(new Date(2026, 9, 3, 23, 5).getTime(), NOW), "23:05");
});

test("相对日期：昨天整天（含 23:59 边界）→ 「昨天」", () => {
  assert.equal(formatSessionRelativeTime(new Date(2026, 9, 2, 0, 0).getTime(), NOW), "昨天");
  assert.equal(formatSessionRelativeTime(new Date(2026, 9, 2, 23, 59, 59).getTime(), NOW), "昨天");
});

test("相对日期：昨天以前、7 个自然日内 → 星期几", () => {
  // 2026-09-30 是周几不由实现告诉答案：独立用 Date.getDay() 换出汉字。
  const threeDaysAgo = new Date(2026, 8, 30, 12, 0);
  const expected = `星期${"日一二三四五六"[threeDaysAgo.getDay()]}`;
  assert.equal(formatSessionRelativeTime(threeDaysAgo.getTime(), NOW), expected);
  // 边界：往前第 6 天 00:00 仍给星期几；第 7 天 00:00 落绝对日期。
  const day6 = new Date(2026, 8, 27, 0, 0);
  assert.equal(formatSessionRelativeTime(day6.getTime(), NOW), `星期${"日一二三四五六"[day6.getDay()]}`);
  assert.equal(formatSessionRelativeTime(new Date(2026, 8, 26, 23, 59, 59).getTime(), NOW), "9月26日");
});

test("相对日期：更早同年 → M月D日；跨年 → YYYY/M/D", () => {
  assert.equal(formatSessionRelativeTime(new Date(2026, 0, 5, 12, 0).getTime(), NOW), "1月5日");
  assert.equal(formatSessionRelativeTime(new Date(2025, 11, 25, 12, 0).getTime(), NOW), "2025/12/25");
});

// ─────────────────────────── 搜尋過濾（純函數行為）

const FILTER_FIXTURE: AgentSessionSummary[] = [
  mk("s1", { title: "Poster Draft v2" }),
  mk("s2", { title: "四格宣传海报" }),
  mk("s3", { title: null }), // 降级标签「10月1日 10:00 的对话」
];

// 標題格式化在生產由 AgentChatSurface 注入（唯一實作在該檔，測試不對它下斷言）。
// 這裡給濾網一份自帶的替身標籤：無 title 的會話降級成時間標籤，形狀照生產的
// 「<日期> <時間> 的对话」，值由測試自備——濾網的契約是「比對呼叫方給的標籤」，
// 不是比對降級邏輯本身。
const fixtureLabel = (it: AgentSessionSummary): string => it.title ?? "10月1日 10:00 的对话";

test("搜索过滤：大小写不敏感、命中降级时间标签、空白词不过滤", () => {
  assert.deepEqual(filterAgentSessions(FILTER_FIXTURE, "poster", fixtureLabel).map((s) => s.session_id), ["s1"]);
  assert.deepEqual(filterAgentSessions(FILTER_FIXTURE, "POSTER", fixtureLabel).map((s) => s.session_id), ["s1"]);
  assert.deepEqual(filterAgentSessions(FILTER_FIXTURE, "海报", fixtureLabel).map((s) => s.session_id), ["s2"]);
  // 无 title 的会话用降级标签也能被搜到（「的对话」是降级标签的尾巴）。
  assert.deepEqual(filterAgentSessions(FILTER_FIXTURE, "的对话", fixtureLabel).map((s) => s.session_id), ["s3"]);
  assert.equal(filterAgentSessions(FILTER_FIXTURE, "   ", fixtureLabel).length, 3);
  assert.equal(filterAgentSessions(FILTER_FIXTURE, "", fixtureLabel).length, 3);
  assert.deepEqual(filterAgentSessions(FILTER_FIXTURE, "不存在的词", fixtureLabel), []);
});

// ─────────────────────────── 渲染行為（renderToStaticMarkup）

const RENDER_FIXTURE: AgentSessionSummary[] = [
  mk("s1", { title: "海报构图三轮修" }),
  mk("s2", { title: "视频分镜脚本" }),
  mk("s3", { title: "旧的一年", last_activity_at: new Date(2025, 11, 25, 12, 0).getTime() }),
];

const baseProps = {
  sessions: RENDER_FIXTURE,
  currentSessionId: "s2",
  switchingTo: null as string | null,
  startingNew: false,
  // 標題格式化照樣注入（生產＝AgentChatSurface.formatSessionLabel；斷言只對
  // 「渲染出來的是注入的那份標籤」，不對降級規則本身）。
  formatLabel: (it: AgentSessionSummary) => it.title ?? "10月1日 10:00 的对话",
  onPick: () => {},
  onStartNew: () => {},
};

/** 取出某会话列按钮的开标签（按 data-session-id 定位）。 */
function rowTag(markup: string, sessionId: string): string {
  return markup.match(new RegExp(`<button[^>]*data-session-id="${sessionId}"[^>]*>`))?.[0] ?? "";
}

test("当前会话高亮：aria-current 与浅灰圆角 class 只落在当前列", () => {
  const markup = renderToStaticMarkup(createElement(AgentSessionList, baseProps));
  const current = rowTag(markup, "s2");
  assert.match(current, /aria-current="true"/);
  assert.match(current, /bg-black\/\[0\.05\]/);
  assert.match(current, /rounded-\[14px\]/);
  for (const id of ["s1", "s3"]) {
    const tag = rowTag(markup, id);
    assert.ok(tag.length > 0, `列 ${id} 应渲染`);
    assert.doesNotMatch(tag, /aria-current/);
    assert.doesNotMatch(tag, /bg-black\/\[0\.05\]/);
  }
  // 相对日期真的上屏：今天的给 HH:mm，跨年的给 YYYY/M/D。
  assert.match(markup, /15:00/);
  assert.match(markup, /2025\/12\/25/);
  // 触控与行高契约：整列可点、min-height 52px、active 态。
  assert.match(rowTag(markup, "s1"), /min-h-\[52px\]/);
  assert.match(rowTag(markup, "s1"), /active:bg-black\/\[0\.07\]/);
});

test("搜索中的列表只渲染命中列；无命中给「没有匹配的对话」", () => {
  const hit = renderToStaticMarkup(createElement(AgentSessionList, { ...baseProps, query: "分镜" }));
  assert.match(hit, /视频分镜脚本/);
  assert.doesNotMatch(hit, /海报构图三轮修/);
  const miss = renderToStaticMarkup(createElement(AgentSessionList, { ...baseProps, query: "查无此词" }));
  assert.match(miss, /没有匹配的对话/);
  assert.equal(rowTag(miss, "s1"), "");
});

test("加载中与真空态：沿用既有文案与开新对话 CTA", () => {
  const loading = renderToStaticMarkup(createElement(AgentSessionList, { ...baseProps, sessions: null }));
  assert.match(loading, /正在加载历史会话…/);
  const empty = renderToStaticMarkup(createElement(AgentSessionList, { ...baseProps, sessions: [] }));
  assert.match(empty, /还没有历史对话/);
  assert.match(empty, /开始新对话/);
});

// ─────────────────────────── 點列 → 切會話 callback（真行為斷言，不走 DOM：
// 元件無 hooks，直接呼叫取元素樹，對列按鈕的 onClick 逐一斷言）

type AnyElement = { props?: Record<string, unknown> & { children?: unknown } };

function collectSessionButtons(node: unknown, out: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
  if (Array.isArray(node)) {
    for (const child of node) collectSessionButtons(child, out);
    return out;
  }
  if (node && typeof node === "object" && "props" in (node as AnyElement)) {
    const el = node as AnyElement;
    const props = el.props ?? {};
    if (typeof props["data-session-id"] === "string") out.push(props);
    collectSessionButtons(props.children, out);
  }
  return out;
}

test("点某一列触发 onPick（带该列 session_id）；切换中全列 disabled", () => {
  const picked: string[] = [];
  const tree = AgentSessionList({ ...baseProps, onPick: (id) => picked.push(id) });
  const buttons = collectSessionButtons(tree);
  assert.equal(buttons.length, 3);
  const byId = new Map(buttons.map((props) => [props["data-session-id"] as string, props]));
  (byId.get("s2")?.onClick as (() => void) | undefined)?.();
  assert.deepEqual(picked, ["s2"]);
  (byId.get("s1")?.onClick as (() => void) | undefined)?.();
  assert.deepEqual(picked, ["s2", "s1"]);
  // 切换中：每列都 disabled（防连点产生并发 switchSession）。
  const busyTree = AgentSessionList({ ...baseProps, switchingTo: "s1" });
  for (const props of collectSessionButtons(busyTree)) {
    assert.equal(props.disabled, true);
  }
});

test("空态 CTA 触发 onStartNew", () => {
  let started = 0;
  const tree = AgentSessionList({ ...baseProps, sessions: [], onStartNew: () => { started += 1; } });
  const buttons = collectSessionButtons(tree);
  assert.equal(buttons.length, 0, "空态没有会话列");
  // 空态的唯一按钮就是 CTA；直接翻元素树里带 onClick 的 button。
  const findCta = (node: unknown): Record<string, unknown> | null => {
    if (Array.isArray(node)) {
      for (const child of node) {
        const hit = findCta(child);
        if (hit) return hit;
      }
      return null;
    }
    if (node && typeof node === "object" && "props" in (node as AnyElement)) {
      const el = node as AnyElement & { type?: unknown };
      if (el.type === "button") return el.props ?? null;
      return findCta(el.props?.children);
    }
    return null;
  };
  const cta = findCta(tree);
  assert.ok(cta, "空态应渲染开新对话 CTA");
  (cta.onClick as () => void)();
  assert.equal(started, 1);
});

// ─────────────────────────── 窄屏抽屜：portal 結構斷言（原始碼層；runner 無 jsdom）
//
// 真行為（scrim 是否等於全視窗、抽屜內點擊不被 outside-click 誤收）由 Playwright
// 在 390×844 實測複驗，數字見交付回報；這裡鎖住產生那棵 DOM 的結構：
// scrim 是 createPortal 的第一個參數、容器是 document.body、drawer ref 掛在
// scrim 上、outside-click 同時認 historyRef 與 historyDrawerRef（純函數
// isInsideHistorySurface）。這些任一改壞，Playwright 那條也就會紅，屬結構契約。

/** 取出 createPortal(...) 呼叫本體（到該呼叫的收尾 `)` 為止，含嵌套括號配對）。 */
function portalCallRegion(src: string): string {
  const at = src.indexOf("createPortal(");
  if (at < 0) return "";
  let depth = 0;
  for (let i = at + "createPortal".length; i < src.length; i += 1) {
    if (src[i] === "(") depth += 1;
    else if (src[i] === ")") {
      depth -= 1;
      if (depth === 0) return src.slice(at, i + 1);
    }
  }
  return src.slice(at);
}

test("窄屏抽屉 portal 结构：scrim 是 portal 子节点、容器为 document.body、ref 挂 scrim（结构断言）", () => {
  const region = portalCallRegion(surfaceSrc);
  assert.ok(region.length > 0, "必须存在 createPortal 调用");
  // 第一个参数＝带 agent-param-scrim 与 historyDrawerRef 的 div（抽屜不在卡片子树内）。
  assert.match(region, /className="agent-param-scrim"/);
  assert.match(region, /ref=\{historyDrawerRef\}/);
  // 第二个参数＝document.body：抽屜掛到 body 直下，不再受卡片 backdrop-filter 的
  // containing block 影响（否则 scrim 会被缩成卡片大小，非全屏）。
  assert.match(region, /,\s*document\.body,?\s*\)\s*$/);
  // portal 出去的抽屜不含 lg-sheet（半透）——材质改 agent-pop，字不叠字。
  assert.match(region, /agent-param-drawer agent-pop/);
  assert.doesNotMatch(region, /lg-sheet/);
});

test("窄屏抽屉放行逻辑：outside-click 同时认 historyRef 与 portal 的 historyDrawerRef（结构断言）", () => {
  // 抽屜 portal 后不在 historyRef 子树内，必须以第二个 ref 放行抽屜内点击，
  // 否则点搜索框／点列都会被当成「点外面」而收掉（本刀必须一起改的连带项）。
  assert.match(
    surfaceSrc,
    /isInsideHistorySurface\(historyRef\.current, historyDrawerRef\.current, ev\.target as Node\)/,
  );
  // 纯函数本体就在 surface 内，两 ref 任一命中即算「里面」。
  assert.match(surfaceSrc, /export function isInsideHistorySurface\(/);
  assert.match(surfaceSrc, /return Boolean\(anchor\?\.contains\(target\) \|\| drawer\?\.contains\(target\)\)/);
  // SSR 安全守：document 未定义时不渲染 portal。
  assert.match(surfaceSrc, /typeof document !== "undefined" &&/);
});

// ─────────────────────────── 變更探針（源碼字串，只證明改動在場，不計入已驗證）

test("探针：工具列走廊修复与抽屉轮子在场（非行为断言）", () => {
  assert.match(surfaceSrc, /max-sm:justify-between/);
  assert.match(surfaceSrc, /flex items-center gap-0\.5 max-sm:contents/);
  assert.match(surfaceSrc, /ml-auto flex items-center gap-0\.5 max-sm:contents/);
  assert.match(surfaceSrc, /agent-param-scrim/);
  // 抽屜材質改 agent-pop（不透明彈層），不再用半透 lg-sheet（底下消息流的字會透上來）。
  assert.match(surfaceSrc, /agent-param-drawer agent-pop/);
  assert.doesNotMatch(surfaceSrc, /agent-param-drawer lg-sheet/);
  assert.match(surfaceSrc, /agent-param-drawer-body/);
  assert.match(surfaceSrc, /placeholder="搜索对话"/);
});
