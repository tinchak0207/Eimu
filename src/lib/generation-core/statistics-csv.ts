// 統計／用量導出（P2-1／對稱差 D16「用量/對帳導出 CSV/Excel」）。
//
// 對標口徑（唯一）：`Dramagic對稱差-全站-0928.md:101` —— 對手有
// 「Export details…download data in **Excel format**」，含總/團隊/子帳號/專案四層；
// 我方有對帳（`account-reconciliation`）與統計投影，**無導出**。
// 決策表 `Dramagic對稱差-決策表-0928.md:49` 裁定逐字：P2-1「**做**」。
//
// 本檔的立場（誠實邊界，別讓 CSV 變成第二個真相）：
//   1. **只序列化既有投影**：數字全部來自 `StatisticsProjection`，本檔不查 DB、不算帳、
//      不補任何缺失的數。投影是唯一真源（`statistics-projection.ts` 的檔頭已聲明）。
//   2. **缺的層如實缺席**：對手的四層是「總／團隊／子帳號／專案」，我方投影目前只有
//      日／模型／渠道三個切面 ⇒ `byScope` 恆為空陣列，**不偽造**團隊/專案列。
//      這一欄是 P2-2（按生成物類別切分）與組織維度用量的**唯一延伸點**：
//      新的切面只要往 `byScope` 塞桶，導出檔自動多一層，不必改本檔的欄位結構。
//   3. **Excel 相容不是改個副檔名**：UTF-8 BOM（否則 Excel 開簡中欄位名會變亂碼）＋
//      CRLF ＋ RFC4180 引號轉義（逗號／引號／換行）——三者缺一，使用者下載到的就是壞檔。
//   4. **缺值留空，不填 0**：某桶沒有這個指標時該格是空字串。填 0 等於宣稱
//      「這筆量是 0」，與「沒有這個數字」是兩件事（同 `skippedNonFiniteRows` 的立場）。

import type { ConsumptionProjection, StatisticsProjection } from "./statistics-projection";

/**
 * 導出**實際讀取的**投影面（不是整份投影）。
 *
 * 為什麼收窄：① 契約顯式化——本檔只依賴這四個欄位，別的地方改動不會靜默影響導出；
 * ② 用 indexed access 取得真實型別 ⇒ 欄位一旦在投影裡改名，路由呼叫端**編譯期**就紅，
 * 不會靜默吐出一個少了欄位的 CSV；③ 測試可以只造這四個欄位，不必造整份投影
 * （專案的健康度／漏斗／來源清單與導出無關）。
 */
export interface StatisticsCsvInput {
  window: StatisticsProjection["window"];
  configured: boolean;
  consumption: ConsumptionProjection | null;
  traffic: StatisticsProjection["traffic"];
}

/** UTF-8 BOM：Excel 靠它認出編碼（缺它→中文欄位名變亂碼）。 */
export const STATISTICS_CSV_BOM = "\uFEFF";

/**
 * 欄位名（**契約面，改動即破壞下游解析**）。
 * `section` ＝ 這列屬於哪個切面；`key`/`label` ＝ 桶的識別；其後為量化欄位。
 * `operations` 的語義要讀 `key`：消耗列＝帳本行數；`refunded` 的計數列（`*_jobs`／
 * `*_rows`）＝job 數或行數。**不做第二套欄位名**——同一個數字欄在不同切面承載計數，
 * 是靠 `key` 說清楚，不靠欄位數膨脹。
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

/** 一個切面在導出檔裡的名字（＝sheet 的替代品，Excel 用篩選即可分開看）。 */
export type StatisticsCsvSection =
  /** 窗口事實與口徑備註（無量化值，只為讓檔案自帶出處）。 */
  | "meta"
  | "total"
  | "day"
  | "model"
  | "channel"
  /** 退款單列（口徑變了：退款不是消耗的一部分，見投影的 RefundedBucket）。 */
  | "refunded"
  /** 帳本有行但找不到交付嘗試的淨消耗（不攤進任何渠道）。 */
  | "unattributed"
  /** 帳本有行但金額非有限值（不當 0 計）。 */
  | "skipped_non_finite"
  /** 組織維度（總/團隊/子帳號/專案）——**目前恆空**，見檔頭第 2 條。 */
  | "scope";

/** 多筆 id 塞一格時的分隔字元（Excel 單格可讀；不用逗號以免與 CSV 分隔衝突）。 */
export const STATISTICS_CSV_ID_SEPARATOR = "|";

/**
 * RFC4180 單格轉義：
 *   - 含 `,`／`"`／`\r`／`\n` → 整格用 `"` 包住，內部 `"` 翻倍；
 *   - 其餘原樣輸出。
 * 非字串值走 `String()`；`null`／`undefined`／空字串 → **空字串**（缺值留空，不填 0）。
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const raw = typeof value === "string" ? value : String(value);
  if (raw === "") return "";
  if (/[",\r\n]/.test(raw)) return `"${raw.replace(/"/g, '""')}"`;
  return raw;
}

/** 一列（以 CRLF 結尾，符合 Excel 的期待）。 */
export function csvRow(cells: readonly unknown[]): string {
  return `${cells.map(csvCell).join(",")}\r\n`;
}

/** 缺值留空的守門：非有限值一律當「沒有這個數字」，不回 0。 */
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
 * 投影 → CSV 全文（單表＋ `section` 欄，Excel 開啟後用篩選/pivot 即可分層看）。
 *
 * 為什麼不做多 sheet：真實 .xlsx 需要寫 zip＋XML（新依賴），而「CSV/Excel 導出」的
 * 使用者價值是「能把數字拿去算」——單表 + 分面欄完全滿足，且零新依賴、可被任何工具吃。
 */
export function statisticsToCsv(projection: StatisticsCsvInput): string {
  const lines: string[] = [csvRow(STATISTICS_CSV_HEADER)];

  // meta：窗口與口徑（讓檔案自帶出處，日後對帳不必回頭查網頁當下的參數）。
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
  // 未配置控制面 DB ⇒ 投影本身已宣告 configured:false（不吐看起來正常的空報表），
  // 這裡照抄它的誠實：沒有消耗面就**不出現任何消耗列**，而不是吐一排 0。
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
    // 這兩個桶在投影裡沒有 key/label（它們不是「按某個維度分桶」的結果），
  // 導出時補上具名 key/label——空 key 的列對消費 CSV 的人等於沒說這是什麼。
  lines.push(csvRow(bucketRow("refunded", { ...consumption.refunded, key: "refund", label: "已退款" })));
    // 退款的 job 層計數（金額欄留空，只有計數）——這是人工對帳最需要的三個數：
    // 涉及幾個 job、其中幾個全額退款、相抵為 0 的帳本行幾行。
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
    // 組織維度：投影尚未提供 ⇒ 一列都不寫（**不偽造團隊/專案列**）。這一行註解就是
    // 「要補這一層，往投影的 byScope 塞桶」的指標；CSV 結構本身不必改。
  }

  return STATISTICS_CSV_BOM + lines.join("");
}

/** 下載檔名（帶日期，避免同一資料夾多份 export 互相覆蓋）。 */
export function statisticsCsvFilename(projection: StatisticsProjection, now: Date = new Date()): string {
  const day = now.toISOString().slice(0, 10);
  return `statistics-${day}-${projection.window.days}d.csv`;
}
