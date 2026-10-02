// 歷史種類篩選的 URL 白名單與解析（純推導，零元件／零樣式依賴）。
//
// 為什麼不直接寫在 HistoryClient.tsx：那支檔 `import "@/components/history/history.css"`，
// node:test 下 tsx 會把 CSS 當 JS 編譯而報錯，導致「合法種類值」這條契約無法做真值斷言。
// 把推導抽到這裡，元件與測試讀同一份清單；新增一種交付物時只要在
// /lib/deliverable-kind 註冊表加一行，這裡與 UI 自動跟上，不必再改歷史頁。
import { DELIVERABLE_KIND_IDS } from "@/lib/deliverable-kind";
import { NON_DELIVERABLE_ENTRY_KINDS } from "@/lib/history-types";
import type { HistoryEntryKind } from "@/lib/history-types";

/**
 * URL 種類參數（PARAM.kind）與種類篩選器認的合法值。
 * 真源＝交付物註冊表（image/video/audio）∪ 非交付種類（workflow），此處逐值投影，不手寫。
 */
export const ENTRY_KIND_VALUES: readonly HistoryEntryKind[] = [
  ...DELIVERABLE_KIND_IDS,
  ...NON_DELIVERABLE_ENTRY_KINDS,
];

/** 種類檔位：某一具體種類，或「全部」。 */
export type EntryKindFilter = HistoryEntryKind | "all";

/** URL 白名單解析：只放行 ENTRY_KIND_VALUES；空字串／非法值一律視為「全部」。 */
export function parseEntryKind(value: string | null): EntryKindFilter {
  const trimmed = value?.trim();
  return trimmed && (ENTRY_KIND_VALUES as readonly string[]).includes(trimmed)
    ? (trimmed as HistoryEntryKind)
    : "all";
}
