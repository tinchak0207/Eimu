import Taro from '@tarojs/taro';

import { useSyncExternalStore } from "react";

// 仅控制本浏览器显示，独立于发送给网关的 AgentSettings。
const STORAGE_KEY = "agent-hide-reasoning-v1";
let hidden = false;
let initialized = false;
const listeners = new Set<() => void>();

function getSnapshot(): boolean {
  if (!initialized) {
    initialized = true;
    try {
      hidden = Taro.getStorageSync(STORAGE_KEY) === "true";
    } catch {
      // 隐私模式禁用存储时，当前页面仍可即时切换。
    }
  }
  return hidden;
}

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setHideAgentReasoning(value: boolean): void {
  hidden = value;
  initialized = true;
  try {
    Taro.setStorageSync(STORAGE_KEY, String(value));
  } catch {
    // 存储失败不阻断显示开关。
  }
  notify();
}

export function useHideAgentReasoning(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
