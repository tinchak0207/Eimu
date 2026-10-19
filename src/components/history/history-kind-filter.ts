// 历史种类筛选的 URL 白名单与解析（纯推导，零元件／零样式依赖）。
//
// 为什么不直接写在 HistoryClient.tsx：那支档 `import "@/components/history/history.css"`，
// node:test 下 tsx 会把 CSS 当 JS 编译而报错，导致「合法种类值」这条契约无法做真值断言。
// 把推导抽到这里，元件与测试读同一份清单；新增一种交付物时只要在
// /lib/deliverable-kind 注册表加一行，这里与 UI 自动跟上，不必再改历史页。
import { DELIVERABLE_KIND_IDS } from "@/lib/deliverable-kind";
import { NON_DELIVERABLE_ENTRY_KINDS } from "@/lib/history-types";
import type { HistoryEntryKind } from "@/lib/history-types";

/**
 * URL 种类参数（PARAM.kind）与种类筛选器认的合法值。
 * 真源＝交付物注册表（image/video/audio）∪ 非交付种类（workflow），此处逐值投影，不手写。
 */
export const ENTRY_KIND_VALUES: readonly HistoryEntryKind[] = [
  ...DELIVERABLE_KIND_IDS,
  ...NON_DELIVERABLE_ENTRY_KINDS,
];

/** 种类档位：某一具体种类，或「全部」。 */
export type EntryKindFilter = HistoryEntryKind | "all";

/** URL 白名单解析：只放行 ENTRY_KIND_VALUES；空字串／非法值一律视为「全部」。 */
export function parseEntryKind(value: string | null): EntryKindFilter {
  const trimmed = value?.trim();
  return trimmed && (ENTRY_KIND_VALUES as readonly string[]).includes(trimmed)
    ? (trimmed as HistoryEntryKind)
    : "all";
}
