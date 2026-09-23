/**
 * REQ-D1 存量回溯補丁（一次性交付件，非自造輔助腳本）。
 *
 * 從帳本/job 記錄的現成欄位撿血統線索回填 lineage：
 *   歷史條目：workflow.referenceImages[].sourceGenerationId/sourceResultId（生成時
 *   帶的參考圖來源把手）＋ entry.retryOfTaskId（「再來 N 組」父鏈）＋
 *   job 面 workflow.references（durable 任務投影帶回的同一批把手）。
 *   資產卡：卡參考圖 URL 對上歷史條目結果圖 URL → 該條歷史就是卡的來源
 *   （「存為卡片」動作的既有事實，用 URL 等值還原掛鉤 b 的登記）。
 * 補不回的資產不动欄位——溯源面板據「無 lineage 登記」老實顯示「來源不明」。
 *
 * 冪等（重跑雙登記必紅的防禦）：只補「沒有 lineage 欄位」的宿主；已有登記的
 * 一條不碰。save* 走各存儲的 upsert-by-id 語義，同一 userId 重跑結果恆等。
 *
 * 用法（repo 根目錄）：
 *   npx tsx tools/backfill-lineage.ts --user-ids=82[,4] [--dry-run]
 *   - 存儲後端與 seed 工具同款：BLOB_READ_WRITE_TOKEN（或 IMAGE_DATA_* 本地 api），
 *     缺憑證時落 memory store 僅供冒煙。
 *   - 結束打印覆蓋率實數：補回 N / 標記來源不明 M（掃描數、逐類分列）。
 */

import { listGeneratedHistoryEntries, saveGeneratedHistoryEntry } from "../src/lib/server-history-store";
import { listCharacterCards, saveCharacterCard } from "../src/lib/character-card-store";
import {
  cleanLineageHandle,
  historyEntryHandles,
  mergeLineageIntoHost,
  parentsFromReferences,
} from "../src/lib/lineage";
import type { LineageLink } from "../src/lib/lineage";
import type { HistoryEntry } from "../src/lib/history-types";
import type { CharacterCard } from "../src/lib/character-cards";

function parseUserIds(): number[] {
  const raw = (process.argv.find((arg) => arg.startsWith("--user-ids=")) ?? "").split("=")[1]
    ?? process.env.BACKFILL_LINEAGE_USER_IDS
    ?? "";
  const ids = raw
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);
  if (!ids.length) {
    throw new Error("必须提供 --user-ids=1[,2…]（或环境变量 BACKFILL_LINEAGE_USER_IDS）。");
  }
  return ids;
}

interface BackfillStats {
  entriesScanned: number;
  entriesBackfilled: number;
  entriesUntraceable: number;
  entriesAlreadyRegistered: number;
  cardsScanned: number;
  cardsBackfilled: number;
  cardsUntraceable: number;
  cardsAlreadyRegistered: number;
}

/** 從歷史條目既有欄位撿血統（掛鉤 a/c 的回溯等價物；欄位一個不新增）。 */
export function lineageCandidatesFromEntry(entry: HistoryEntry): LineageLink[] {
  const at = new Date(entry.generatedAt).toISOString();
  const parents = parentsFromReferences(entry.workflow?.referenceImages, at);
  const retryOf = cleanLineageHandle(entry.retryOfTaskId);
  if (retryOf) parents.push({ kind: "rerun", jobId: retryOf, at });
  return parents;
}

/** 卡參考圖 URL → 來源歷史條目（「存為卡片」事實的 URL 等值還原）。 */
function cardSourceLinks(card: CharacterCard, entries: HistoryEntry[]): LineageLink[] {
  const cardUrls = new Set(card.references.map((ref) => ref.url).filter(Boolean));
  if (!cardUrls.size) return [];
  const links: LineageLink[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const matched = entry.results.some((result) =>
      Boolean(result.imageUrl && cardUrls.has(result.imageUrl)),
    );
    if (!matched) continue;
    const handles = historyEntryHandles(entry);
    const link: LineageLink = handles.jobId
      ? { kind: "derivation", jobId: handles.jobId, at: new Date(entry.generatedAt).toISOString() }
      : { kind: "derivation", assetId: handles.assetIds[0], at: new Date(entry.generatedAt).toISOString() };
    const key = `${link.jobId ?? ""}|${link.assetId ?? ""}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    links.push(link);
  }
  return links;
}

async function backfillUser(userId: number, dryRun: boolean, stats: BackfillStats): Promise<void> {
  const entries = await listGeneratedHistoryEntries(userId);
  for (const entry of entries) {
    stats.entriesScanned += 1;
    if (Array.isArray(entry.lineage)) {
      stats.entriesAlreadyRegistered += 1;
      continue;
    }
    const candidates = lineageCandidatesFromEntry(entry);
    const merged = mergeLineageIntoHost(null, candidates);
    if (!merged?.lineage?.length) {
      stats.entriesUntraceable += 1;
      continue;
    }
    if (!dryRun) {
      await saveGeneratedHistoryEntry({ ...entry, userId, ...merged });
    }
    stats.entriesBackfilled += 1;
  }

  const cards = await listCharacterCards(userId);
  for (const card of cards) {
    stats.cardsScanned += 1;
    if (Array.isArray(card.lineage)) {
      stats.cardsAlreadyRegistered += 1;
      continue;
    }
    const merged = mergeLineageIntoHost(null, cardSourceLinks(card, entries));
    if (!merged?.lineage?.length) {
      stats.cardsUntraceable += 1;
      continue;
    }
    if (!dryRun) {
      await saveCharacterCard(userId, { ...card, ...merged });
    }
    stats.cardsBackfilled += 1;
  }
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const userIds = parseUserIds();
  const stats: BackfillStats = {
    entriesScanned: 0,
    entriesBackfilled: 0,
    entriesUntraceable: 0,
    entriesAlreadyRegistered: 0,
    cardsScanned: 0,
    cardsBackfilled: 0,
    cardsUntraceable: 0,
    cardsAlreadyRegistered: 0,
  };

  for (const userId of userIds) {
    await backfillUser(userId, dryRun, stats);
  }

  const entriesNeedable = stats.entriesScanned - stats.entriesAlreadyRegistered;
  const cardsNeedable = stats.cardsScanned - stats.cardsAlreadyRegistered;
  console.log(`[backfill-lineage]${dryRun ? " DRY-RUN" : ""} users=${userIds.join(",")}`);
  console.log(
    `[backfill-lineage] 历史：扫描 ${stats.entriesScanned}，待补 ${entriesNeedable}，` +
    `补回 ${stats.entriesBackfilled}，补不回（来源不明） ${stats.entriesUntraceable}，` +
    `已登记跳过 ${stats.entriesAlreadyRegistered}`,
  );
  console.log(
    `[backfill-lineage] 卡：扫描 ${stats.cardsScanned}，待补 ${cardsNeedable}，` +
    `补回 ${stats.cardsBackfilled}，补不回（来源不明） ${stats.cardsUntraceable}，` +
    `已登记跳过 ${stats.cardsAlreadyRegistered}`,
  );
}

if (process.argv[1] && process.argv[1].includes("backfill-lineage")) {
  main().catch((error) => {
    console.error("[backfill-lineage] 失败：", error);
    process.exitCode = 1;
  });
}
