import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { text } from "@/lib/ui-strings";

function read(relPath: string) {
  return readFileSync(join(process.cwd(), relPath), "utf8");
}

/**
 * REQ-D1 溯源抽屜的界面契約（暴君四刀④）：卡片「溯源」抽屉——歷史卡與資產卡
 * 都有入口；展開鏈條面板逐級（類型＋時間＋縮圖或一行描述＋可點擊跳轉）；
 * 默認展開 3 層＋「繼續向上」；兩態文案分開且都上屏。
 * 斷言風格復用 HistoryQuality.test.ts：逐字源碼釘，防「順手改壞」。
 */

test("history card and lightbox both carry the 溯源 entry", () => {
  const card = read("src/components/history/HistoryCard.tsx");
  const lightbox = read("src/components/history/HistoryLightbox.tsx");

  assert.match(card, /label="溯源"/);
  assert.match(card, /onShowLineage\?: \(entry: HistoryEntry\) => void/);
  assert.match(lightbox, /label="溯源"/);
  assert.match(lightbox, /onShowLineage\?: \(entry: HistoryEntry\) => void/);
  // 入口對所有記錄常駐（來源不明的存量也要點進來看到「來源不明」，不能藏）。
  assert.match(card, /\{onShowLineage && \(/);
});

test("asset card panel carries the 溯源 entry with a page-level drawer", () => {
  const overlays = read("src/components/canvas/embed/CanvasEmbedOverlays.tsx");
  assert.match(overlays, /aria-label=\{`溯源卡 \$\{card\.name\}`\}/);
  assert.match(overlays, /<LineageDrawer/);
  assert.match(overlays, /cardToLineageView\(lineageCard\)/);
  assert.match(overlays, /hostKindLabel="资产卡"/);
});

test("drawer renders the ruled chain semantics verbatim", () => {
  const drawer = read("src/components/lineage/LineageDrawer.tsx");

  // 默認 3 層＋「繼續向上」（默認值引用常量而非硬編數字，防兩處漂移）。
  assert.match(drawer, /LINEAGE_DEFAULT_DEPTH/);
  assert.match(drawer, /LINEAGE_DEPTH_STEP/);
  assert.match(drawer, /text\("lineage\.expandMore"/);
  // 文案搬進單一來源（src/lib/ui-strings.ts）後，逐字文案改在運行期釘（元件只留鍵）。
  assert.equal(text("lineage.expandMore", { depth: 3 }), "继续向上（当前展开 3 层）");
  // 兩態文案：已刪除與來源明是兩個態，字面都必須在場（去刪除態／查無態／來源不明態各自成句）。
  assert.match(drawer, /"lineage\.status\.deleted"/);
  assert.match(drawer, /"lineage\.status\.unscanned"/);
  assert.match(drawer, /"lineage\.status\.unknownOrigin"/);
  assert.doesNotMatch(
    drawer,
    /lineage\.status\.deleted[\s\S]{0,40}lineage\.status\.unknownOrigin/,
    "兩態文案不得混在同一判定裡",
  );
  assert.equal(text("lineage.status.deleted"), "已删除 · 曾有引用，记录已不在");
  assert.equal(text("lineage.status.unscanned"), "查无 · 本范围扫描不完整");
  assert.equal(text("lineage.status.unknownOrigin"), "来源不明 · 未登记血统");
  // 每級：類型 badge＋時間＋縮圖或描述＋跳轉鈕。
  assert.match(drawer, /nodeKindLabel\(node\)/);
  assert.match(drawer, /formatRelativeTime\(node\.timeMs\)/);
  assert.match(drawer, /node\.thumbnailUrl \?/);
  assert.match(drawer, /onClick=\{\(\) => onOpenNode\(node\)\}/);
  // 加載不完整時不得把「查無」說成「已刪除」（誠實鐵律）。
  assert.match(drawer, /poolComplete/);
  assert.match(drawer, /"lineage\.status\.unscanned"/);
});

/** 裁決②（讀權＝只給人看）：血統嚴禁補進 agent 上行白名單與畫布節點 metadata。 */
test("lineage stays out of the agent upload whitelist and canvas node metadata", () => {
  const agentCompaction = read("src/hooks/canvas/canvas-project-sync.ts");
  // 白名單函數本體（export const compactMetadataForAgent = ... 起）內零 lineage。
  assert.doesNotMatch(agentCompaction, /lineage/, "compactMetadataForAgent 不得讀寫血統欄位");
  const nodeMetadata = read("src/lib/canvas/types.ts");
  assert.doesNotMatch(nodeMetadata, /lineage/, "canvas 節點 metadata 型別不得出現血統欄位");
});

/** 欄位族契約：宿主是本體記錄，不是第二套存儲。 */
test("hosts carry the lineage field family and normalize passes it through", () => {
  const historyTypes = read("src/lib/history-types.ts");
  const cards = read("src/lib/character-cards.ts");

  assert.match(historyTypes, /lineage\?: LineageLink\[\]/);
  assert.match(historyTypes, /lineageTruncated\?: boolean/);
  assert.match(historyTypes, /normalizeLineageLinks/);
  assert.match(cards, /lineage\?: LineageLink\[\]/);
  assert.match(cards, /normalizeLineageLinks/);
});

/** 寫入掛鉤三處必須存在且復用現成事件流（不新造）。 */
test("write hooks a/b/c are wired at the existing choke points", () => {
  const syncRoute = read("src/app/api/generate-images/route.ts");
  const projection = read("src/lib/generation-task-history.ts");
  const anchor = read("src/lib/history-card-anchor.ts");

  // a. 生成完成落成品索引：歷史保存前組 parents。
  assert.match(syncRoute, /parentsFromReferences\(workflow\?\.referenceImages/);
  assert.match(syncRoute, /saveGeneratedHistoryEntry\(\{[\s\S]{0,400}\.\.\.\(historyLineage \?\? \{\}\)/);
  // a+c. job 面讀時透傳（durable 任務沒有落盤歷史可寫，投影即成品索引讀取端）。
  assert.match(projection, /parentsFromReferences\(job\.workflow\?\.references/);
  assert.match(projection, /kind: "rerun", jobId: job\.retryOfTaskId/);
  // b. 存為卡片：卡本體登記 derivation。
  assert.match(anchor, /kind: "derivation", jobId: handles\.jobId/);
});

/** 存量回溯補丁是交付件的一部分（tools/ 慣例位置，幂等＝已有登記零觸碰）。 */
test("backfill tool lives at the repo convention and skips registered hosts", () => {
  const tool = read("tools/backfill-lineage.ts");
  assert.match(tool, /Array\.isArray\(entry\.lineage\)/);
  assert.match(tool, /Array\.isArray\(card\.lineage\)/);
  assert.match(tool, /--dry-run/);
  assert.match(tool, /来源不明/);
  assert.match(tool, /mergeLineageIntoHost/);
});
