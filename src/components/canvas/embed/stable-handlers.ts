"use client";

// 稳定事件回呼（2026-10-01 效能审计）：父层每帧重渲染时传下来的 on* 内联箭头都是新引用，
// 让 memo 失效。这里把 on* 换成「永远转呼最新版本」的稳定代理——子元件 memo 只看资料 props。
// 只代理 on 开头的事件回呼（事件发生在 commit 之后，读到的一定是最新 props）；
// render prop 之类在渲染期被呼叫的函式不代理，照常比对引用。有无（undefined ↔ 函式）的变化照样触发重渲染。

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
