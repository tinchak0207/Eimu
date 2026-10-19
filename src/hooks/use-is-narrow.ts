"use client";

// 窄屏判定。D-23：窄屏是另一个布局而不是缩放，有些差异（底部抽屉 vs 就地展开）
// 是行为差异而非样式差异，CSS media query 表达不了，必须让 JS 知道断点。
//
// 断点对齐 Tailwind 默认 `sm` = 640px：JSX 里的 `sm:` 前缀和这里必须是同一个数，
// 否则会出现「CSS 认为是宽屏、JS 认为是窄屏」的错位地带。
//
// SSR 安全：服务端没有 window，首帧一律回 false（宽屏布局），
// 挂载后立刻用真实视口纠正。首帧不猜窄屏是因为猜错时代价不对称——
// 宽屏布局在窄屏上只是挤，窄屏布局在宽屏上会留一片空白。

import { useEffect, useState } from "react";

/** Tailwind 默认 sm 断点。`sm:` 是 min-width，所以「窄」= 严格小于它。 */
export const NARROW_QUERY = "(max-width: 639.98px)";

export function useIsNarrow(query: string = NARROW_QUERY): boolean {
  const [narrow, setNarrow] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(query);
    setNarrow(mql.matches);
    const onChange = (event: MediaQueryListEvent) => setNarrow(event.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return narrow;
}
