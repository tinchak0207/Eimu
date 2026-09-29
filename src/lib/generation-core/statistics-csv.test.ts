// 統計／用量導出 CSV（P2-1／對稱差 D16）——真實行為斷言。
//
// 這個檔案的獨立 oracle 是**手寫的投影數字**：導出檔必須逐格等於我餵進去的值，
// 不是「跟同一個計算函式比對」（那會同源，錯了也一起錯）。另外釘住三條 Excel 相容性
// 與一條誠實規則：BOM／CRLF／RFC4180 轉義／缺值留空不填 0。
//
// 真執行器：`npx tsx --test src/lib/generation-core/statistics-csv.test.ts`

import test from "node:test";
import assert from "node:assert/strict";
import {
  STATISTICS_CSV_BOM,
  STATISTICS_CSV_HEADER,
  csvCell,
  csvRow,
  statisticsCsvFilename,
  statisticsToCsv,
  type StatisticsCsvInput,
} from "./statistics-csv";

/** 手寫投影（數字全部人工指定；故意含逗號／引號／換行的髒標籤）。 */
function projection(overrides: Partial<StatisticsCsvInput["consumption"]> = {}): StatisticsCsvInput {
  return {
    window: {
      days: 7,
      generatedAt: "2026-09-29T10:00:00.000Z",
      dayTimezone: "Asia/Shanghai",
      partial: true,
      windowStartDay: "2026-09-23",
    },
    configured: true,
    traffic: { includeInternal: false, internalUserIds: [87, 90] },
    consumption: {
      totalQuota: 12345,
      totalCoins: 12.345,
      operations: 7,
      chargedQuota: 20000,
      chargedCoins: 20,
      chargedOperations: 9,
      refundedQuota: 7655,
      refundedCoins: 7.655,
      refundedOperations: 2,
      byDay: [
        { key: "2026-09-28", label: "9月28日", quota: 8000, coins: 8, operations: 4, recordIds: ["r1", "r2"] },
      ],
      byModel: [
        { key: "gpt-image-2", label: '标准, "主力" 模型', quota: 9000, coins: 9, operations: 5, recordIds: ["r1"] },
      ],
      byChannel: [
        { key: "pixai", label: "PixAI\n主通道", quota: 3345, coins: 3.345, operations: 2, recordIds: [] },
      ],
      // 生成物類別切面（P2-2／D8b）：手寫值，當作獨立 oracle 比對導出檔逐格相等。
      // 刻意只給「真的會出現」的兩桶（角色/場景/道具在提交端尚無落盤事實 ⇒ 不出現）。
      byAssetKind: [
        { key: "shot_video", label: "分镜影片", quota: 5000, coins: 5, operations: 2, recordIds: ["r5"] },
        { key: "still_image", label: "一般图片", quota: 7345, coins: 7.345, operations: 5, recordIds: ["r1"] },
      ],
      unattributed: { quota: 0, coins: 0, operations: 0, recordIds: [] },
      refunded: {
        quota: 7655,
        coins: 7.655,
        operations: 2,
        jobs: 3,
        fullyRefundedJobs: 1,
        netZeroRows: 4,
        recordIds: ["r9"],
      },
      skippedNonFiniteRows: 1,
      ...overrides,
    },
  };
}

/** 把 CSV 切回「列 × 格」（自己實作一個最小 RFC4180 解析器，獨立於產生端）。 */
function parseCsv(text: string): string[][] {
  const body = text.startsWith(STATISTICS_CSV_BOM) ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (quoted) {
      if (ch === '"') {
        if (body[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\r" && body[i + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i += 1;
    } else cell += ch;
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function rowFor(rows: string[][], section: string, key: string): string[] {
  const found = rows.find((r) => r[0] === section && r[1] === key);
  assert.ok(found, `找不到 ${section}/${key} 列`);
  return found!;
}

test("導出的數字逐格等於投影（含 section/key/label 與帳本行 id）", () => {
  const rows = parseCsv(statisticsToCsv(projection()));
  assert.deepEqual(rows[0], [...STATISTICS_CSV_HEADER], "表頭即契約");
  assert.deepEqual(rowFor(rows, "total", "total"), ["total", "total", "净消耗", "12345", "12.345", "7", ""]);
  assert.deepEqual(rowFor(rows, "total", "charged"), ["total", "charged", "扣费总额", "20000", "20", "9", ""]);
  assert.deepEqual(rowFor(rows, "day", "2026-09-28"), ["day", "2026-09-28", "9月28日", "8000", "8", "4", "r1|r2"]);
  assert.deepEqual(rowFor(rows, "model", "gpt-image-2"), [
    "model",
    "gpt-image-2",
    '标准, "主力" 模型',
    "9000",
    "9",
    "5",
    "r1",
  ]);
  assert.deepEqual(rowFor(rows, "channel", "pixai"), ["channel", "pixai", "PixAI\n主通道", "3345", "3.345", "2", ""]);
  assert.deepEqual(rowFor(rows, "asset_kind", "shot_video"), [
    "asset_kind",
    "shot_video",
    "分镜影片",
    "5000",
    "5",
    "2",
    "r5",
  ]);
  assert.deepEqual(rowFor(rows, "asset_kind", "still_image"), [
    "asset_kind",
    "still_image",
    "一般图片",
    "7345",
    "7.345",
    "5",
    "r1",
  ]);
  assert.deepEqual(rowFor(rows, "unattributed", "unattributed"), [
    "unattributed",
    "unattributed",
    "未归因净消耗",
    "0",
    "0",
    "0",
    "",
  ]);
});

test("退款的 job 層計數有自己具名的列（人工對帳要的三個數）", () => {
  const rows = parseCsv(statisticsToCsv(projection()));
  assert.deepEqual(rowFor(rows, "refunded", "refund"), ["refunded", "refund", "已退款", "7655", "7.655", "2", "r9"]);
  assert.equal(rowFor(rows, "refunded", "refund_jobs_total")[5], "3");
  assert.equal(rowFor(rows, "refunded", "refund_fully_refunded_jobs")[5], "1");
  assert.equal(rowFor(rows, "refunded", "refund_net_zero_rows")[5], "4");
  // 金額欄在純計數列留空（不填 0 冒充「金額是 0」）。
  assert.equal(rowFor(rows, "refunded", "refund_jobs_total")[3], "");
  assert.equal(rowFor(rows, "refunded", "refund_jobs_total")[4], "");
});

test("Excel 相容三件套：UTF-8 BOM＋CRLF＋RFC4180 轉義（髒標籤不得撐破列結構）", () => {
  const text = statisticsToCsv(projection());
  assert.equal(text.startsWith(STATISTICS_CSV_BOM), true, "缺 BOM ⇒ Excel 開簡中欄位名變亂碼");
  assert.equal(text.includes("\r\n"), true);
  // 含有逗號、引號、換行的標籤都必須被正確包住：解析回來的列數＝產出時的列數。
  const rows = parseCsv(text);
  const expectedRows = text.split("\r\n").length - 1; // 尾端 CRLF ⇒ 少一
  assert.equal(rows.length, expectedRows, "每一列只能對應一個 CRLF（髒標籤內部的換行必須被引號吃掉）");
  const model = rowFor(rows, "model", "gpt-image-2");
  assert.equal(model[2], '标准, "主力" 模型', "引號與逗號原樣還原");
  assert.equal(rowFor(rows, "channel", "pixai")[2], "PixAI\n主通道", "標籤內換行原樣還原");
  // 單元級：轉義規則本身。
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell("line\nbreak"), '"line\nbreak"');
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(undefined), "");
  assert.equal(csvCell(0), "0", "0 是有值，不是缺值");
  assert.equal(csvRow(["a", 1]).endsWith("\r\n"), true);
});

test("誠實規則：控制面 DB 未配置 / 缺值 ⇒ 不出現或留空，**不填 0**", () => {
  const unconfigured = statisticsToCsv({ ...projection(), configured: false, consumption: null });
  const rows = parseCsv(unconfigured);
  assert.equal(rows.some((r) => r[0] === "total"), false, "沒有消耗面 ⇒ 一列都不出（不吐一排 0）");
  assert.equal(rowFor(rows, "meta", "configured")[2], "false", "但如實記下未配置");
  // 非有限值（NaN/Infinity）＝「沒有這個數字」⇒ 空格。
  const nan = statisticsToCsv(
    projection({ totalQuota: Number.NaN, totalCoins: Number.POSITIVE_INFINITY }),
  );
  const total = rowFor(parseCsv(nan), "total", "total");
  assert.equal(total[3], "", "NaN 不當 0");
  assert.equal(total[4], "", "Infinity 不當 0");
});

test("meta 段帶出窗口與口徑（檔案自帶出處）", () => {
  const rows = parseCsv(statisticsToCsv(projection()));
  assert.equal(rowFor(rows, "meta", "days")[2], "7");
  assert.equal(rowFor(rows, "meta", "generated_at")[2], "2026-09-29T10:00:00.000Z");
  assert.equal(rowFor(rows, "meta", "window_start_day")[2], "2026-09-23");
  assert.equal(rowFor(rows, "meta", "timezone")[2], "Asia/Shanghai");
  assert.equal(rowFor(rows, "meta", "partial_window")[2], "true");
  assert.equal(rowFor(rows, "meta", "include_internal_traffic")[2], "false");
});

test("組織維度（總/團隊/子帳號/專案）目前缺席：一列都不偽造", () => {
  const rows = parseCsv(statisticsToCsv(projection()));
  assert.equal(
    rows.some((r) => r[0] === "scope"),
    false,
    "投影沒有 byScope 就不該出現 scope 列——偽造團隊/專案列比不導出更糟",
  );
});

test("跳過的非有限值帳本行如實單列（>0 才出現，不冒充一筆 operation）", () => {
  const withSkips = parseCsv(statisticsToCsv(projection()));
  assert.equal(rowFor(withSkips, "skipped_non_finite", "skipped_non_finite")[5], "1");
  const noSkips = parseCsv(statisticsToCsv(projection({ skippedNonFiniteRows: 0 })));
  assert.equal(noSkips.some((r) => r[0] === "skipped_non_finite"), false, "0 值不佔列");
});

test("檔名帶日期與窗口天數（同一資料夾多次導出不互相覆蓋）", () => {
  const name = statisticsCsvFilename(projection(), new Date("2026-09-29T10:00:00.000Z"));
  assert.equal(name, "statistics-2026-09-29-7d.csv");
});