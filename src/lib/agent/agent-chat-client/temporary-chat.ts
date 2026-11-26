/**
 * 临时对话：下一个新会话不读取、不写入任何记忆（网关据 create 时的 temporary:true 落地）。
 *
 * 会话是首条消息 lazy 建的，所以这里分两段：
 * - armed：用户点了「临时对话」，下一次 createAgentSession 会带 temporary:true 并消费该标记；
 * - sessionIds：已建成的临时会话（localStorage 保一份，刷新后头部徽标不丢）。
 * 只管本机 UI 状态；真正的「不记忆」由网关强制，不依赖这里。
 */
import { useSyncExternalStore } from "react";

const STORAGE_KEY = "agent-temporary-sessions-v1";
const MAX_REMEMBERED = 200;

let armed = false;
let version = 0;
const listeners = new Set<() => void>();

function emit(): void {
  version += 1;
  for (const l of listeners) l();
}

function readIds(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function writeIds(ids: string[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ids.slice(-MAX_REMEMBERED)));
  } catch {
    // 隐私模式：只影响刷新后的徽标，网关侧的临时语义不受影响。
  }
}

export function setTemporaryArmed(on: boolean): void {
  if (armed === on) return;
  armed = on;
  emit();
}

export function isTemporaryArmed(): boolean {
  return armed;
}

/** createAgentSession 调用：读取并消费 armed 标记。 */
export function consumeTemporaryArmed(): boolean {
  const was = armed;
  if (was) setTemporaryArmed(false);
  return was;
}

export function markSessionTemporary(sessionId: string): void {
  const ids = readIds();
  if (!ids.includes(sessionId)) writeIds([...ids, sessionId]);
  emit();
}

export function isSessionTemporary(sessionId: string | null | undefined): boolean {
  return !!sessionId && readIds().includes(sessionId);
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** 头部徽标用：当前会话是临时会话，或下一个新会话已被标为临时。 */
export function useTemporaryChat(sessionId: string | null | undefined): { armed: boolean; temporary: boolean } {
  useSyncExternalStore(subscribe, () => version, () => 0);
  return { armed, temporary: isSessionTemporary(sessionId) };
}
