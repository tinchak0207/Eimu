import { MAX_STORYBOARD_FIELD_CHARS } from "./types";

export function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** 逐栏清洗：非字串 → `""`（AID 空值规则）；超长截断；其余**逐字保留**（不 trim，保 scriptContent 原文相加=完整剧本）。 */
export function cleanField(v: unknown): string {
  if (typeof v !== "string") return "";
  return v.length > MAX_STORYBOARD_FIELD_CHARS ? v.slice(0, MAX_STORYBOARD_FIELD_CHARS) : v;
}

/** 非空（trim 后）字串——门禁读值前一律 trim（VPS `text()`），故纯空白字串等于「没有值」。 */
export function isNonBlankString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/** 卡 id 阵列 → 只留非空字串（门禁 `strArr` 只认字串；非字串项不送过去，避免制造假绑定）。 */
export function usableCardIds(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((id): id is string => isNonBlankString(id)) : [];
}

/**
 * `usableCardIds` + 去重（清洗规则**完全复用**，只多一步「同一来源内重复 id 只留一份」）。
 * 为何要一致：①②④ 的名称解析路径（`resolveReferenceAssetsToCardIds`）与
 * `storyboardQcContextFromProject` 的节点累积本来就 `!ids.includes(id)` 去重；
 * ⑤ 若不去重，同一批 id 会在 `fields` 里长成 `["a","a"]`（审计迹与输出无谓膨胀）。
 */
export function uniqueCardIds(v: unknown): string[] {
  const out: string[] = [];
  for (const id of usableCardIds(v)) if (!out.includes(id)) out.push(id);
  return out;
}
