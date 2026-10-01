"use client";

// 穩定事件回呼（2026-10-01 效能審計）：父層每幀重渲染時傳下來的 on* 內聯箭頭都是新引用，
// 讓 memo 失效。這裡把 on* 換成「永遠轉呼最新版本」的穩定代理——子元件 memo 只看資料 props。
// 只代理 on 開頭的事件回呼（事件發生在 commit 之後，讀到的一定是最新 props）；
// render prop 之類在渲染期被呼叫的函式不代理，照常比對引用。有無（undefined ↔ 函式）的變化照樣觸發重渲染。

import { useRef } from "react";

type AnyFn = (...args: unknown[]) => unknown;

export function useStableHandlers<P extends object>(props: P): P {
  const latest = useRef(props);
  latest.current = props;
  const cache = useRef(new Map<string, AnyFn>());
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(props)) {
    const value = (props as Record<string, unknown>)[key];
    if (typeof value === "function" && /^on[A-Z]/.test(key)) {
      let proxy = cache.current.get(key);
      if (!proxy) {
        proxy = (...args: unknown[]) => ((latest.current as Record<string, unknown>)[key] as AnyFn | undefined)?.(...args);
        cache.current.set(key, proxy);
      }
      out[key] = proxy;
    } else {
      out[key] = value;
    }
  }
  return out as P;
}
