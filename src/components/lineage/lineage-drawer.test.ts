import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { text } from "@/lib/ui-strings";

function read(relPath: string) {
  return readFileSync(join(process.cwd(), relPath), "utf8");
}

/**
 * REQ-D1 溯源抽屉的界面契约（暴君四刀④）：卡片「溯源」抽屉——历史卡与资产卡
 * 都有入口；展开链条面板逐级（类型＋时间＋缩图或一行描述＋可点击跳转）；
 * 默认展开 3 层＋「继续向上」；两态文案分开且都上屏。
 * 断言风格复用 HistoryQuality.test.ts：逐字源码钉，防「顺手改坏」。
 */

test("history card and lightbox both carry the 溯源 entry", () => {
  const card = read("src/components/history/HistoryCard.tsx");
  const lightbox = read("src/components/history/HistoryLightbox.tsx");

  assert.match(card, /label="溯源"/);
  assert.match(card, /onShowLineage\?: \(entry: HistoryEntry\) => void/);
  assert.match(lightbox, /label="溯源"/);
  assert.match(lightbox, /onShowLineage\?: \(entry: HistoryEntry\) => void/);
  // 入口对所有记录常驻（来源不明的存量也要点进来看到「来源不明」，不能藏）。
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

  // 默认 3 层＋「继续向上」（默认值引用常量而非硬编数字，防两处漂移）。
  assert.match(drawer, /LINEAGE_DEFAULT_DEPTH/);
  assert.match(drawer, /LINEAGE_DEPTH_STEP/);
  assert.match(drawer, /text\("lineage\.expandMore"/);
  // 文案搬进单一来源（src/lib/ui-strings.ts）后，逐字文案改在运行期钉（元件只留键）。
  assert.equal(text("lineage.expandMore", { depth: 3 }), "继续向上（当前展开 3 层）");
  // 两态文案：已删除与来源明是两个态，字面都必须在场（去删除态／查无态／来源不明态各自成句）。
  assert.match(drawer, /"lineage\.status\.deleted"/);
  assert.match(drawer, /"lineage\.status\.unscanned"/);
  assert.match(drawer, /"lineage\.status\.unknownOrigin"/);
  assert.doesNotMatch(
    drawer,
    /lineage\.status\.deleted[\s\S]{0,40}lineage\.status\.unknownOrigin/,
    "两态文案不得混在同一判定里",
  );
  assert.equal(text("lineage.status.deleted"), "已删除 · 曾有引用，记录已不在");
  assert.equal(text("lineage.status.unscanned"), "查无 · 本范围扫描不完整");
  assert.equal(text("lineage.status.unknownOrigin"), "来源不明 · 未登记血统");
  // 每级：类型 badge＋时间＋缩图或描述＋跳转钮。
  assert.match(drawer, /nodeKindLabel\(node\)/);
  assert.match(drawer, /formatRelativeTime\(node\.timeMs\)/);
  assert.match(drawer, /node\.thumbnailUrl \?/);
  assert.match(drawer, /onClick=\{\(\) => onOpenNode\(node\)\}/);
  // 加载不完整时不得把「查无」说成「已删除」（诚实铁律）。
  assert.match(drawer, /poolComplete/);
  assert.match(drawer, /"lineage\.status\.unscanned"/);
});

/** 裁决②（读权＝只给人看）：血统严禁补进 agent 上行白名单与画布节点 metadata。 */
test("lineage stays out of the agent upload whitelist and canvas node metadata", () => {
  const agentCompaction = read("src/hooks/canvas/canvas-project-sync.ts");
  // 白名单函数本体（export const compactMetadataForAgent = ... 起）内零 lineage。
  assert.doesNotMatch(agentCompaction, /lineage/, "compactMetadataForAgent 不得读写血统栏位");
  const nodeMetadata = read("src/lib/canvas/types.ts");
  assert.doesNotMatch(nodeMetadata, /lineage/, "canvas 节点 metadata 型别不得出现血统栏位");
});

/** 栏位族契约：宿主是本体记录，不是第二套存储。 */
test("hosts carry the lineage field family and normalize passes it through", () => {
  const historyTypes = read("src/lib/history-types.ts");
  const cards = read("src/lib/character-cards.ts");

  assert.match(historyTypes, /lineage\?: LineageLink\[\]/);
  assert.match(historyTypes, /lineageTruncated\?: boolean/);
  assert.match(historyTypes, /normalizeLineageLinks/);
  assert.match(cards, /lineage\?: LineageLink\[\]/);
  assert.match(cards, /normalizeLineageLinks/);
});

/** 写入挂钩三处必须存在且复用现成事件流（不新造）。 */
test("write hooks a/b/c are wired at the existing choke points", () => {
  const syncRoute = read("src/app/api/generate-images/route.ts");
  const projection = read("src/lib/generation-task-history.ts");
  const anchor = read("src/lib/history-card-anchor.ts");

  // a. 生成完成落成品索引：历史保存前组 parents。
  assert.match(syncRoute, /parentsFromReferences\(workflow\?\.referenceImages/);
  assert.match(syncRoute, /saveGeneratedHistoryEntry\(\{[\s\S]{0,400}\.\.\.\(historyLineage \?\? \{\}\)/);
  // a+c. job 面读时透传（durable 任务没有落盘历史可写，投影即成品索引读取端）。
  assert.match(projection, /parentsFromReferences\(job\.workflow\?\.references/);
  assert.match(projection, /kind: "rerun", jobId: job\.retryOfTaskId/);
  // b. 存为卡片：卡本体登记 derivation。
  assert.match(anchor, /kind: "derivation", jobId: handles\.jobId/);
});

/** 存量回溯补丁是交付件的一部分（tools/ 惯例位置，幂等＝已有登记零触碰）。 */
test("backfill tool lives at the repo convention and skips registered hosts", () => {
  const tool = read("tools/backfill-lineage.ts");
  assert.match(tool, /Array\.isArray\(entry\.lineage\)/);
  assert.match(tool, /Array\.isArray\(card\.lineage\)/);
  assert.match(tool, /--dry-run/);
  assert.match(tool, /来源不明/);
  assert.match(tool, /mergeLineageIntoHost/);
});
