// 歷史記錄 → 資產卡錨點（純函式）：把一條歷史記錄的圖錨定成 character-card。
//
// 只做增量：卡的最終清洗仍走 normalizeCharacterCard（character-cards.ts 是唯一
// 資產 owner，這裡不建第二套資產系統，只負責從 HistoryEntry 構造 payload）。
// 消費端：src/components/history/SaveCardDialog.tsx（歷史頁「存为角色卡」動作）。
import { toReferenceImageRole } from "./image-types";
import type { ReferenceImageRole } from "./image-types";
import { CHARACTER_CARD_KIND_LABEL, toCharacterCardKind } from "./character-cards";
import type { CharacterCard, CharacterCardKind } from "./character-cards";
import type { HistoryEntry } from "./history-types";

const MAX_ANCHOR_NAME_LENGTH = 100;

/** 與站內一致的可用圖 URL 判定（http(s) 與 data:image）。 */
function isUsableImageUrl(url: string): boolean {
  return url.startsWith("http") || url.startsWith("data:image/");
}

/**
 * 取歷史記錄的錨定圖 URL：任何結果裡有可用公網 imageUrl 就用它（可持久、體積小），
 * 全都沒有才由 base64 組 data URL 兜底（本地緩存記錄）。
 */
export function anchorImageUrlOf(entry: HistoryEntry): string | null {
  for (const result of entry.results) {
    if (result.imageUrl && isUsableImageUrl(result.imageUrl)) return result.imageUrl;
  }
  for (const result of entry.results) {
    if (result.image && typeof result.image === "string") {
      const dataUrl = result.image.startsWith("data:image/") ? result.image : `data:image/png;base64,${result.image}`;
      if (isUsableImageUrl(dataUrl)) return dataUrl;
    }
  }
  return null;
}

/** 卡種類 → 參考圖角色：style/character 有同名的 ReferenceImageRole，scene 無對應角色收斂 general。 */
function anchorRoleOf(kind: CharacterCardKind): ReferenceImageRole {
  return toReferenceImageRole(kind === "scene" ? "general" : kind);
}

/**
 * 從歷史記錄構造一張「純參考圖卡」：
 *   - 名稱必填（trim 後非空，上限 100 與 normalizeCharacterCard 一致）
 *   - 圖取第一張可用結果（無圖記錄（計費日誌等）返回 null，不建空卡）
 *   - locked prompt 為空（可在卡面板事後補描述），kind 未知值收斂 character
 */
export function cardFromHistoryEntry(
  entry: HistoryEntry,
  kind: unknown,
  name: string,
): CharacterCard | null {
  const url = anchorImageUrlOf(entry);
  if (!url) return null;
  const cleanName = typeof name === "string" ? name.trim().slice(0, MAX_ANCHOR_NAME_LENGTH) : "";
  if (!cleanName) return null;
  const safeKind = toCharacterCardKind(kind);
  const now = new Date().toISOString();
  return {
    id: `card-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: cleanName,
    kind: safeKind,
    prompt: "",
    references: [{ url, role: anchorRoleOf(safeKind), name: cleanName }],
    createdAt: now,
    updatedAt: now,
  };
}

/** 統一的結果文案（對話框與 toast 共用）。 */
export function anchorSuccessMessage(card: CharacterCard): string {
  return `已存为${CHARACTER_CARD_KIND_LABEL[card.kind]}卡：${card.name}`;
}
