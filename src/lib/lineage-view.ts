// REQ-D1 溯源抽屉的读取端适配层：把现成的 HistoryEntry / CharacterCard
// 适配成 lineage.ts 的 LineageRecordView，并组出把手解析池。
//
// 铁律复述：本档只做「读时透传」——血统的真相存在记录本体（lineage 栏位），
// 这里不新增第二份存储，也严禁把 lineage 带进 canvas 节点 metadata 或
// compactMetadataForAgent（裁决②）。
//
// 池的扫描范围：历史按 GET /api/history 游标翻完（站点每用户上限 500 条），
// 卡经 listCharacterCards 全量。「已删除」的判据是「曾登记把手但池查无」，
// 池收全了这个判据才诚实。

import { fetchHistoryPage, getStoredToken } from "./new-api-client";
import { listCharacterCards } from "./character-card-client";
import { CHARACTER_CARD_KIND_LABEL } from "./character-cards";
import type { CharacterCard } from "./character-cards";
import { normalizeHistoryEntry } from "./history-types";
import { historyEntryHandles, cleanLineageHandle } from "./lineage";
import type { LineagePool, LineageRecordView } from "./lineage";
import type { HistoryEntry } from "./history-types";

/** 站点每用户历史上限（history-types 同步常量；这里只是游标循环的安全帽）。 */
const MAX_POOL_PAGES = 6;

/** 历史记录 → 池视图：缩图取第一张可用结果图，标签取提示词首行。 */
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

/** 资产卡 → 池视图：缩图取首张参考图，标签「[角色卡] 名称」。 */
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
  /** 池里的历史记录（历史页跳转灯箱要按记录找 index）。 */
  entries: HistoryEntry[];
}

/** 用现成记录数组同步建池（测试与增量场景；线上看 loadLineagePool）。 */
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
        // jobId 查无时再试 assetId 同名（同步直出记录 id 同时是 task 投影的 id）。
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
 * 抽屉打开时的池加载：历史翻完（≤500 条）＋卡全量。
 * fail-soft：任何一侧失败只减池不误报——池不完整的记录在抽屉里仍按
 * 「查无＝已删除」渲染？不行：会把加载失败误报成已删除。因此 cards 侧失败
 * 时降级标记 entriesOnly，调用方据此把「卡把手查无」显示为「来源不明」。
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
        // StoredHistoryEntry 是 HTTP 面（无 source），正规化成 HistoryEntry
        // 再进池——与 GET /api/history 控制面代理的读取端同款收口。
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
      // fail-soft：池里没历史，抽屉据 historyLoaded=false 走降级显示。
    }
  }
  let cards: CharacterCard[] = [];
  let cardsLoaded = false;
  try {
    const result = await listCharacterCards();
    // CanvasClientResult 非判别联合：ok 也可能缺 data，缺 data 视同未加载，
    // 不让「卡池是空的」误升级成「卡把手全已删除」。
    if (result.ok && Array.isArray(result.data)) {
      cards = result.data;
      cardsLoaded = true;
    }
  } catch {
    // 同上：不误报已删除。
  }
  return { ...buildLineagePool(entries, cards), cardsLoaded, historyLoaded };
}
