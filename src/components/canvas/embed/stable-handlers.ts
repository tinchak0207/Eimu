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
  const prevKeys = useRef<string[]>([]);
  const prevValues = useRef<unknown[]>([]);
  const stableOut = useRef<P | null>(null);

  const keys = Object.keys(props);
  const values: unknown[] = [];
  let same = stableOut.current !== null && prevKeys.current.length === keys.length;
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    const value = (props as Record<string, unknown>)[key];
    let next: unknown = value;
    if (typeof value === "function" && /^on[A-Z]/.test(key)) {
      let proxy = cache.current.get(key);
      if (!proxy) {
        proxy = (...args: unknown[]) => ((latest.current as Record<string, unknown>)[key] as AnyFn | undefined)?.(...args);
        cache.current.set(key, proxy);
      }
      next = proxy;
    }
    values.push(next);
    if (same && (prevKeys.current[i] !== key || !Object.is(prevValues.current[i], next))) same = false;
  }

  if (same && stableOut.current) return stableOut.current;

  const out: Record<string, unknown> = {};
  for (let i = 0; i < keys.length; i += 1) out[keys[i]] = values[i];
  const frozen = out as P;
  prevKeys.current = keys;
  prevValues.current = values;
  stableOut.current = frozen;
  return frozen;
}
