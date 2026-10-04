// 统计／用量导出（P2-1／对称差 D16「用量/对帐导出 CSV/Excel」）。
//
// 对标口径（唯一）：`Dramagic对称差-全站-0928.md:101` —— 对手有
// 「Export details…download data in **Excel format**」，含总/团队/子帐号/专案四层；
// 我方有对帐（`account-reconciliation`）与统计投影，**无导出**。
// 决策表 `Dramagic对称差-决策表-0928.md:49` 裁定逐字：P2-1「**做**」。
//
// 本档的立场（诚实边界，别让 CSV 变成第二个真相）：
//   1. **只序列化既有投影**：数字全部来自 `StatisticsProjection`，本档不查 DB、不算帐、
//      不补任何缺失的数。投影是唯一真源（`statistics-projection.ts` 的档头已声明）。
//   2. **缺的层如实缺席**：对手的四层是「总／团队／子帐号／专案」，我方投影目前只有
//      日／模型／渠道三个切面 ⇒ `byScope` 恒为空阵列，**不伪造**团队/专案列。
//      这一栏是 P2-2（按生成物类别切分）与组织维度用量的**唯一延伸点**：
//      新的切面只要往 `byScope` 塞桶，导出档自动多一层，不必改本档的栏位结构。
//   3. **Excel 相容不是改个副档名**：UTF-8 BOM（否则 Excel 开简中栏位名会变乱码）＋
//      CRLF ＋ RFC4180 引号转义（逗号／引号／换行）——三者缺一，使用者下载到的就是坏档。
//   4. **缺值留空，不填 0**：某桶没有这个指标时该格是空字串。填 0 等于宣称
//      「这笔量是 0」，与「没有这个数字」是两件事（同 `skippedNonFiniteRows` 的立场）。

import type { ConsumptionProjection, StatisticsProjection } from "./statistics-projection";

/**
 * 导出**实际读取的**投影面（不是整份投影）。
 *
 * 为什么收窄：① 契约显式化——本档只依赖这四个栏位，别的地方改动不会静默影响导出；
 * ② 用 indexed access 取得真实型别 ⇒ 栏位一旦在投影里改名，路由呼叫端**编译期**就红，
 * 不会静默吐出一个少了栏位的 CSV；③ 测试可以只造这四个栏位，不必造整份投影
 * （专案的健康度／漏斗／来源清单与导出无关）。
 */
export interface StatisticsCsvInput {
  window: StatisticsProjection["window"];
  configured: boolean;
  consumption: ConsumptionProjection | null;
  traffic: StatisticsProjection["traffic"];
}

/** UTF-8 BOM：Excel 靠它认出编码（缺它→中文栏位名变乱码）。 */
export const STATISTICS_CSV_BOM = "\uFEFF";

/**
 * 栏位名（**契约面，改动即破坏下游解析**）。
 * `section` ＝ 这列属于哪个切面；`key`/`label` ＝ 桶的识别；其后为量化栏位。
 * `operations` 的语义要读 `key`：消耗列＝帐本行数；`refunded` 的计数列（`*_jobs`／
 * `*_rows`）＝job 数或行数。**不做第二套栏位名**——同一个数字栏在不同切面承载计数，
 * 是靠 `key` 说清楚，不靠栏位数膨胀。
 */
export const STATISTICS_CSV_HEADER = [
  "section",
  "key",
  "label",
  "quota",
  "coins",
  "operations",
  "record_ids",
] as const;

/** 一个切面在导出档里的名字（＝sheet 的替代品，Excel 用筛选即可分开看）。 */
export type StatisticsCsvSection =
  /** 窗口事实与口径备注（无量化值，只为让档案自带出处）。 */
  | "meta"
  | "total"
  | "day"
  | "model"
  | "channel"
  /** 退款单列（口径变了：退款不是消耗的一部分，见投影的 RefundedBucket）。 */
  | "refunded"
  /** 帐本有行但找不到交付尝试的净消耗（不摊进任何渠道）。 */
  | "unattributed"
  /** 帐本有行但金额非有限值（不当 0 计）。 */
  | "skipped_non_finite"
  /** 组织维度（总/团队/子帐号/专案）——**目前恒空**，见档头第 2 条。 */
  | "scope"
  /** 生成物类别（P2-2／D8b）：分镜影片／一般图片／未归类。 */
  | "asset_kind";

/** 多笔 id 塞一格时的分隔字元（Excel 单格可读；不用逗号以免与 CSV 分隔冲突）。 */
export const STATISTICS_CSV_ID_SEPARATOR = "|";

/**
 * RFC4180 单格转义：
 *   - 含 `,`／`"`／`\r`／`\n` → 整格用 `"` 包住，内部 `"` 翻倍；
 *   - 其余原样输出。
 * 非字串值走 `String()`；`null`／`undefined`／空字串 → **空字串**（缺值留空，不填 0）。
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const raw = typeof value === "string" ? value : String(value);
  if (raw === "") return "";
  if (/[",\r\n]/.test(raw)) return `"${raw.replace(/"/g, '""')}"`;
  return raw;
}

/** 一列（以 CRLF 结尾，符合 Excel 的期待）。 */
export function csvRow(cells: readonly unknown[]): string {
  return `${cells.map(csvCell).join(",")}\r\n`;
}

/** 缺值留空的守门：非有限值一律当「没有这个数字」，不回 0。 */
function metric(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

function ids(list: readonly string[] | undefined): string {
  return list && list.length ? list.join(STATISTICS_CSV_ID_SEPARATOR) : "";
}

function bucketRow(section: StatisticsCsvSection, bucket: {
  key?: string;
  label?: string;
  quota?: number;
  coins?: number;
  operations?: number;
  recordIds?: string[];
}): string[] {
  return [
    section,
    bucket.key ?? "",
    bucket.label ?? "",
    metric(bucket.quota),
    metric(bucket.coins),
    metric(bucket.operations),
    ids(bucket.recordIds),
  ];
}

/**
 * 投影 → CSV 全文（单表＋ `section` 栏，Excel 开启后用筛选/pivot 即可分层看）。
 *
 * 为什么不做多 sheet：真实 .xlsx 需要写 zip＋XML（新依赖），而「CSV/Excel 导出」的
 * 使用者价值是「能把数字拿去算」——单表 + 分面栏完全满足，且零新依赖、可被任何工具吃。
 */
export function statisticsToCsv(projection: StatisticsCsvInput): string {
  const lines: string[] = [csvRow(STATISTICS_CSV_HEADER)];

  // meta：窗口与口径（让档案自带出处，日后对帐不必回头查网页当下的参数）。
  const metaRows: Array<[string, string]> = [
    ["days", String(projection.window.days)],
    ["generated_at", projection.window.generatedAt],
    ["window_start_day", projection.window.windowStartDay],
    ["timezone", projection.window.dayTimezone],
    ["partial_window", projection.window.partial ? "true" : "false"],
    ["configured", projection.configured ? "true" : "false"],
    ["include_internal_traffic", projection.traffic.includeInternal ? "true" : "false"],
  ];
  for (const [key, value] of metaRows) lines.push(csvRow(["meta", key, value, "", "", "", ""]));

  const consumption = projection.consumption;
  // 未配置控制面 DB ⇒ 投影本身已宣告 configured:false（不吐看起来正常的空报表），
  // 这里照抄它的诚实：没有消耗面就**不出现任何消耗列**，而不是吐一排 0。
  if (consumption) {
    lines.push(csvRow([
      "total",
      "total",
      "净消耗",
      metric(consumption.totalQuota),
      metric(consumption.totalCoins),
      metric(consumption.operations),
      "",
    ]));
    lines.push(csvRow([
      "total",
      "charged",
      "扣费总额",
      metric(consumption.chargedQuota),
      metric(consumption.chargedCoins),
      metric(consumption.chargedOperations),
      "",
    ]));
    for (const bucket of consumption.byDay) lines.push(csvRow(bucketRow("day", bucket)));
    for (const bucket of consumption.byModel) lines.push(csvRow(bucketRow("model", bucket)));
    for (const bucket of consumption.byChannel) lines.push(csvRow(bucketRow("channel", bucket)));
    // 生成物类别切面（P2-2／D8b）：桶键即类别值域，label 已是中文（投影带出来）。
    // D8b 的角色／场景／道具在提交端还没有落盘事实 ⇒ 不会出现这三列（见 usage-asset-kind.ts）；
    // 出现的只有分镜影片／一般图片／未归类——**未归类不摊进任何一类**。
    for (const bucket of consumption.byAssetKind) lines.push(csvRow(bucketRow("asset_kind", bucket)));
    // 这两个桶在投影里没有 key/label（它们不是「按某个维度分桶」的结果），
  // 导出时补上具名 key/label——空 key 的列对消费 CSV 的人等于没说这是什么。
  lines.push(csvRow(bucketRow("refunded", { ...consumption.refunded, key: "refund", label: "已退款" })));
    // 退款的 job 层计数（金额栏留空，只有计数）——这是人工对帐最需要的三个数：
    // 涉及几个 job、其中几个全额退款、相抵为 0 的帐本行几行。
    lines.push(csvRow([
      "refunded",
      "refund_jobs_total",
      "退款涉及 job 数",
      "",
      "",
      metric(consumption.refunded.jobs),
      "",
    ]));
    lines.push(csvRow([
      "refunded",
      "refund_fully_refunded_jobs",
      "全额退款 job 数",
      "",
      "",
      metric(consumption.refunded.fullyRefundedJobs),
      "",
    ]));
    lines.push(csvRow([
      "refunded",
      "refund_net_zero_rows",
      "相抵为 0 的帐本行数",
      "",
      "",
      metric(consumption.refunded.netZeroRows),
      "",
    ]));
    lines.push(
      csvRow(bucketRow("unattributed", { ...consumption.unattributed, key: "unattributed", label: "未归因净消耗" })),
    );
    if (consumption.skippedNonFiniteRows > 0) {
      lines.push(csvRow([
        "skipped_non_finite",
        "skipped_non_finite",
        "金额非有限值而跳过的帐本行",
        "",
        "",
        metric(consumption.skippedNonFiniteRows),
        "",
      ]));
    }
    // 组织维度：投影尚未提供 ⇒ 一列都不写（**不伪造团队/专案列**）。这一行注解就是
    // 「要补这一层，往投影的 byScope 塞桶」的指标；CSV 结构本身不必改。
  }

  return STATISTICS_CSV_BOM + lines.join("");
}

/** 下载档名（带日期，避免同一资料夹多份 export 互相覆盖）。 */
export function statisticsCsvFilename(projection: StatisticsProjection, now: Date = new Date()): string {
  const day = now.toISOString().slice(0, 10);
  return `statistics-${day}-${projection.window.days}d.csv`;
}
