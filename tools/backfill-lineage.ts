/**
 * REQ-D1 存量回溯补丁（一次性交付件，非自造辅助脚本）。
 *
 * 从帐本/job 记录的现成栏位捡血统线索回填 lineage：
 *   历史条目：workflow.referenceImages[].sourceGenerationId/sourceResultId（生成时
 *   带的参考图来源把手）＋ entry.retryOfTaskId（「再来 N 组」父链）＋
 *   job 面 workflow.references（durable 任务投影带回的同一批把手）。
 *   资产卡：卡参考图 URL 对上历史条目结果图 URL → 该条历史就是卡的来源
 *   （「存为卡片」动作的既有事实，用 URL 等值还原挂钩 b 的登记）。
 * 补不回的资产不动栏位——溯源面板据「无 lineage 登记」老实显示「来源不明」。
 *
 * 幂等（重跑双登记必红的防御）：只补「没有 lineage 栏位」的宿主；已有登记的
 * 一条不碰。save* 走各存储的 upsert-by-id 语义，同一 userId 重跑结果恒等。
 *
 * 用法（repo 根目录）：
 *   npx tsx tools/backfill-lineage.ts --user-ids=82[,4] [--dry-run]
 *   - 存储后端与 seed 工具同款：BLOB_READ_WRITE_TOKEN（或 IMAGE_DATA_* 本地 api），
 *     缺凭证时落 memory store 仅供冒烟。
 *   - 结束打印覆盖率实数：补回 N / 标记来源不明 M（扫描数、逐类分列）。
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

/** 从历史条目既有栏位捡血统（挂钩 a/c 的回溯等价物；栏位一个不新增）。 */
export function lineageCandidatesFromEntry(entry: HistoryEntry): LineageLink[] {
  const at = new Date(entry.generatedAt).toISOString();
  const parents = parentsFromReferences(entry.workflow?.referenceImages, at);
  const retryOf = cleanLineageHandle(entry.retryOfTaskId);
  if (retryOf) parents.push({ kind: "rerun", jobId: retryOf, at });
  return parents;
}

/** 卡参考图 URL → 来源历史条目（「存为卡片」事实的 URL 等值还原）。 */
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
