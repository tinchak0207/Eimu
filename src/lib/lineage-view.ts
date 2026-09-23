// REQ-D1 溯源抽屜的讀取端適配層：把現成的 HistoryEntry / CharacterCard
// 適配成 lineage.ts 的 LineageRecordView，並組出把手解析池。
//
// 鐵律複述：本檔只做「讀時透傳」——血統的真相存在記錄本體（lineage 欄位），
// 這裡不新增第二份存儲，也嚴禁把 lineage 帶進 canvas 節點 metadata 或
// compactMetadataForAgent（裁決②）。
//
// 池的掃描範圍：歷史按 GET /api/history 游標翻完（站點每用戶上限 500 條），
// 卡經 listCharacterCards 全量。「已刪除」的判據是「曾登記把手但池查無」，
// 池收全了這個判據才誠實。

import { fetchHistoryPage, getStoredToken } from "./new-api-client";
import { listCharacterCards } from "./character-card-client";
import { CHARACTER_CARD_KIND_LABEL } from "./character-cards";
import type { CharacterCard } from "./character-cards";
import { normalizeHistoryEntry } from "./history-types";
import { historyEntryHandles, cleanLineageHandle } from "./lineage";
import type { LineagePool, LineageRecordView } from "./lineage";
import type { HistoryEntry } from "./history-types";

/** 站點每用戶歷史上限（history-types 同步常量；這裡只是游標循環的安全帽）。 */
const MAX_POOL_PAGES = 6;

/** 歷史記錄 → 池視圖：縮圖取第一張可用結果圖，標籤取提示詞首行。 */
export function entryToLineageView(entry: HistoryEntry): LineageRecordView {
  const handles = historyEntryHandles(entry);
  const thumbnail = entry.results.find((r) => r.imageUrl || r.image || r.videoUrl);
  const thumbnailUrl = thumbnail?.imageUrl
    ?? (thumbnail?.image ? `data:image/png;base64,${thumbnail.image}` : null);
  const label = entry.prompt.trim().slice(0, 80) || entry.modelId || "生成记录";
  return {
    selfHandles: { jobId: handles.jobId, ...(handles.assetIds.length ? { assetId: handles.assetIds[0] } : {}) },
    label,
    thumbnailUrl: thumbnailUrl ?? null,
    timeMs: entry.generatedAt,
    ...(entry.lineage ? { lineage: entry.lineage } : {}),
    ...(entry.lineageTruncated ? { lineageTruncated: true } : {}),
  };
}

/** 資產卡 → 池視圖：縮圖取首張參考圖，標籤「[角色卡] 名称」。 */
export function cardToLineageView(card: CharacterCard): LineageRecordView {
  return {
    selfHandles: { assetId: cleanLineageHandle(card.id) ?? undefined },
    label: `${CHARACTER_CARD_KIND_LABEL[card.kind]}卡：${card.name}`,
    thumbnailUrl: card.references[0]?.url ?? null,
    timeMs: Date.parse(card.createdAt) || null,
    ...(card.lineage ? { lineage: card.lineage } : {}),
    ...(card.lineageTruncated ? { lineageTruncated: true } : {}),
  };
}

export interface LineagePoolData {
  pool: LineagePool;
  /** 池裡的歷史記錄（歷史頁跳轉灯箱要按記錄找 index）。 */
  entries: HistoryEntry[];
}

/** 用現成記錄數組同步建池（測試與增量場景；線上看 loadLineagePool）。 */
export function buildLineagePool(entries: HistoryEntry[], cards: CharacterCard[]): LineagePoolData {
  const byJob = new Map<string, LineageRecordView>();
  const byAsset = new Map<string, LineageRecordView>();
  for (const entry of entries) {
    const view = entryToLineageView(entry);
    if (view.selfHandles.jobId) byJob.set(view.selfHandles.jobId, view);
    for (const assetId of historyEntryHandles(entry).assetIds) byAsset.set(assetId, view);
  }
  for (const card of cards) {
    const view = cardToLineageView(card);
    if (view.selfHandles.assetId) byAsset.set(view.selfHandles.assetId, view);
  }
  return {
    entries,
    pool: {
      find(jobId, assetId) {
        if (jobId) {
          const byJobView = byJob.get(jobId);
          if (byJobView) return byJobView;
        }
        if (assetId) {
          const byAssetView = byAsset.get(assetId);
          if (byAssetView) return byAssetView;
        }
        // jobId 查無時再試 assetId 同名（同步直出記錄 id 同時是 task 投影的 id）。
        if (jobId) {
          const fallback = byAsset.get(`history-${jobId}`);
          if (fallback) return fallback;
        }
        return null;
      },
    },
  };
}

/**
 * 抽屜打開時的池加載：歷史翻完（≤500 條）＋卡全量。
 * fail-soft：任何一側失敗只減池不誤報——池不完整的記錄在抽屜裡仍按
 * 「查無＝已刪除」渲染？不行：會把加載失敗誤報成已刪除。因此 cards 側失敗
 * 時降級標記 entriesOnly，調用方據此把「卡把手查無」顯示為「來源不明」。
 */
export interface LineagePoolLoadResult extends LineagePoolData {
  cardsLoaded: boolean;
  historyLoaded: boolean;
}

export async function loadLineagePool(): Promise<LineagePoolLoadResult> {
  const token = getStoredToken();
  const entries: HistoryEntry[] = [];
  let historyLoaded = false;
  if (token) {
    try {
      let cursor: string | null = null;
      for (let page = 0; page < MAX_POOL_PAGES; page += 1) {
        const response = await fetchHistoryPage(token, {}, { cursor, pageSize: 100 });
        const data = response.data;
        if (!data) break;
        // StoredHistoryEntry 是 HTTP 面（無 source），正規化成 HistoryEntry
        // 再進池——與 GET /api/history 控制面代理的讀取端同款收口。
        entries.push(
          ...data.entries.flatMap((item) => {
            const normalized = normalizeHistoryEntry(item, "server");
            return normalized ? [normalized] : [];
          }),
        );
        historyLoaded = true;
        cursor = data.cursor;
        if (!cursor) break;
      }
    } catch {
      // fail-soft：池裡沒歷史，抽屜據 historyLoaded=false 走降級顯示。
    }
  }
  let cards: CharacterCard[] = [];
  let cardsLoaded = false;
  try {
    const result = await listCharacterCards();
    // CanvasClientResult 非判別聯合：ok 也可能缺 data，缺 data 視同未加載，
    // 不讓「卡池是空的」誤升級成「卡把手全已刪除」。
    if (result.ok && Array.isArray(result.data)) {
      cards = result.data;
      cardsLoaded = true;
    }
  } catch {
    // 同上：不誤報已刪除。
  }
  return { ...buildLineagePool(entries, cards), cardsLoaded, historyLoaded };
}
