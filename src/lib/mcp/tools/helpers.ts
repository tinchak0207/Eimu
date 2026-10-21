import { isPlainObject } from "./validation";

// ─────────────────────────────────────────── 工具定义

/** 只丢掉 `undefined`（`null`/空字串是呼叫者的真实意图，不代他决定）。 */
export function compact(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export function bilingual(zh: string, en: string): string {
  return `${zh}\nEnglish: ${en}`;
}

export function asRecord(args: unknown): Record<string, unknown> {
  return isPlainObject(args) ? args : {};
}

export function pickString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}
