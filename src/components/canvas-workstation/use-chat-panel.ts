"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

/** 面板拖宽范围（与 CSS 默认 clamp 同族，2026-09-24 用户版面方案上限 560→720）。 */
export const CHAT_PANEL_MIN_WIDTH = 320;
export const CHAT_PANEL_MAX_WIDTH = 720;

/**
 * 宽度持久化 v2 key（2026-09-24 垃圾值大赦，暴君回报「Ctrl+Shift+R 聊天框先占
 * 几乎半屏、秒缩回 30% 以下，非常恐怖」）：只认「用户真的拖过宽」写入的值。
 * 旧 key（v1 时代）存的是垃圾——useState(420) 时代 mount effect 无条件落盘 420、
 * 40vw mount effect 落盘旧视口快照——视口变了或从未手动拖过时该值 ≠ CSS 默认，
 * 造成「首帧 clamp（40vw 半屏）→ 水合后被垃圾值缩回」的跳变。v1 一律不读，
 * 载入即 removeItem 清除。layout.tsx 的 pre-paint 同步脚本与本档读同一个 v2、
 * 同一套校验（320–720 整数；下限取拖宽底 320 而非 clamp 底 360——用户真的拖到
 * 320 时若脚本拒认，首帧 clamp 水合后跳 320，同款跳变只是换了方向）。
 */
export const CHAT_PANEL_WIDTH_STORAGE_KEY = "canvas-chat-panel-width.v2";
/** 已作废的 v1 key：只准 removeItem，禁止任何读取。 */
export const CHAT_PANEL_WIDTH_LEGACY_KEY = "canvas-chat-panel-width";

/** v2 存值校验：320–720 的整数才可信；其余（null/空字串/浮点/越界）＝无存值。 */
export function parseStoredPanelWidth(raw: string | null): number | null {
  if (raw === null) return null;
  const w = Number(raw);
  if (!Number.isInteger(w) || w < CHAT_PANEL_MIN_WIDTH || w > CHAT_PANEL_MAX_WIDTH) return null;
  return w;
}

/**
 * 画布工作站聊天面板的私有状态：expanded|rail 两态 + 右缘拖宽（320–720px），
 * localStorage 记忆。面板壳（样式/overlay/拖宽手柄）在 CanvasChatWorkstation，
 * 这里只持有 state 与持久化 effect——呼叫方是面板壳组件本身，对外零 props。
 *
 * 宽度单一真相源（2026-09-24 首秒零回缩 + 同日追杀回填跳变）：面板宽的唯一
 * 表示是 CSS 自订属性 --ws-panel-w——面板 width、overlay 的 --ce-dock-left、
 * navbar 的 --ws-navbar-inset 全部读它。其值有两源：
 *   - 无存值：CSS :root 默认 clamp(360px,40vw,720px)（宣告在 CanvasChatWorkstation
 *     的 <style>），SSR 首帧即新用户终态——JS 什么都不写；
 *   - 有 v2 存值：由 <head>/body 顶端的 pre-paint 同步脚本（src/app/layout.tsx）
 *     在首个 paint 前把显式 px 写进 <html>——「首帧即终态」对冷载入（Ctrl+Shift+R）
 *     同样成立。useLayoutEffect 对冷载入无能为力：HTML+CSS 早已绘出第一帧，
 *     水合再「paint 前」写入也已是 paint 之后的第二次变更。本档初始态经
 *     readStoredPanelWidth() 同步读同一个 v2，mount 时 useLayoutEffect 重写
 *     同一值＝零视觉变化；React markup 从不内联 width，SSR 端不读 window 也
 *     不产生 hydration mismatch。
 * 旧实装「初始值 420 + mount effect 改写视口 40%」与「useLayoutEffect 读旧
 * localStorage 回填」两代都是 reload 跳变元凶，已全部拆掉。
 *
 * rail 态读取已大赦（2026-09-24 第二跳变源）：收合钮 09-05 从 UI 裁掉后，
 * rail 对现行 UI 不可达，任何 state="rail" 持久值都是纯旧垃圾；水合后载入它
 * 会让面板从首帧 expanded 缩成 44px FAB（比宽度跳变更夸张），故一律不读。
 * state 持久化写入保留（恒为 expanded，向后相容旧读取方）。
 */
export function useChatPanel() {
  const [chatPanelState, setChatPanelState] = useState<"expanded" | "rail">("expanded");
  // 初始态＝同步读同一个校验过的 v2（SSR 端 typeof window 守卫回 null）。
  // 这里不能留 null 等 useLayoutEffect 回填：null 会让 mount 时的写入 effect
  // removeProperty 掉 pre-paint 脚本刚设好的显式宽——跳变只是换了方向。
  const [chatPanelWidth, setChatPanelWidth] = useState<number | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      return parseStoredPanelWidth(window.localStorage.getItem(CHAT_PANEL_WIDTH_STORAGE_KEY));
    } catch {
      return null;
    }
  });
  const chatPanelDragRef = useRef<{ pointerId: number; startX: number; startW: number } | null>(null);
  // 面板壳 DOM：拖宽起始值要 getBoundingClientRect().width 实测——
  // chatPanelWidth 为 null 时宽度活在 CSS 侧，JS 从来不知道它是几。
  const chatPanelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    window.localStorage.setItem("canvas-chat-panel-state", chatPanelState);
  }, [chatPanelState]);
  // 持久化只收显式宽度（用户真的拖过），且只写 v2；null = CSS 默认跟随视口，
  // 禁止固化落盘（旧实装连默认值都写进 localStorage，把「40vw 跟视口」的活
  // 语义钉死成 px，且首个 commit 先落盘初始值——全部不再可能：state 为 null
  // 时根本不写）。旧 key 垃圾值顺手清除，永绝后患。
  useEffect(() => {
    try {
      window.localStorage.removeItem(CHAT_PANEL_WIDTH_LEGACY_KEY);
    } catch {
      /* 无存储环境静默 */
    }
    if (chatPanelWidth === null) return;
    try {
      window.localStorage.setItem(CHAT_PANEL_WIDTH_STORAGE_KEY, String(chatPanelWidth));
    } catch {
      /* 无存储环境静默 */
    }
  }, [chatPanelWidth]);
  // --ws-panel-w 唯一 JS 写入端：有显式值→写 px；无→移除，让 CSS :root 默认
  // （clamp）接管。useLayoutEffect = 首个 effect、paint 前完成；此刻 width
  // transition 的 settled 闸还未开启，写入＝瞬变终值零动画。冷载入的首帧前
  // 套用由 layout.tsx pre-paint 脚本完成，本 effect 重写同一值＝零跳。
  useLayoutEffect(() => {
    if (chatPanelWidth === null) {
      document.documentElement.style.removeProperty("--ws-panel-w");
    } else {
      document.documentElement.style.setProperty("--ws-panel-w", `${chatPanelWidth}px`);
    }
  }, [chatPanelWidth]);

  return {
    chatPanelState,
    setChatPanelState,
    chatPanelWidth,
    setChatPanelWidth,
    chatPanelDragRef,
    chatPanelRef,
  };
}
