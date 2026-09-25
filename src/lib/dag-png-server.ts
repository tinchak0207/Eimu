// DAG 視覺渲染出口（**server-only**）。
//
// 為什麼單獨一檔而不是併進 workflow-png.ts：workflow-png.ts 會被客戶端元件
// import（ReferenceImageUpload 讀用戶拖入的 PNG），而本檔經 dag-png.ts 拉進
// sharp——sharp 是 Node 原生模組，`node:events` 進 browser bundle 會讓 webpack
// 直接炸（UnhandledSchemeError: Reading from "node:events" is not handled）。
// 拆檔是唯一乾淨的隔離方式：客戶端只碰零依賴的 workflow-png.ts，伺服器端
// （route / worker）才 import 本檔。
//
// ─────────────────── CJK 字型（2026-09-20 豆腐方框修復）───────────────────
// Vercel serverless 完全沒有系統字型（實測 fc-list=0），librsvg 渲染中文
// 全變方框。解法＝字型隨程式碼部署：
//   public/fonts/NotoSansCJKsc-subset.otf（Noto Sans CJK SC 子集，5MB，
//   常用漢字 U+4E00–U+9FA5 全覆蓋）
//   public/fonts/dag-fonts.conf（fontconfig 設定，dir 由路徑佔位符運行時替換）
// 放 public/ 的理由：Vercel 構建後 /var/task/public/ 的相對佈局穩定可預期
//（Next.js 靜態資產標準位置），源碼 src/ 目錄在 serverless bundle 內不存在。
// 本檔在首次渲染前：
//   1. 把 dag-fonts.conf 的 __FONT_DIR__ 佔位符替換成實際絕對路徑，寫到 /tmp；
//   2. 設 FONTCONFIG_FILE=/tmp/dag-fonts.conf——librsvg 經 fontconfig 找字型，
//      這是它唯一認的入口；
//   3. cachedir 指 /tmp/fontconfig-cache（serverless 唯一可寫目錄）。
// 本機開發（有系統字型）不受影響：FONTCONFIG_FILE 只在本檔設置，且即便
// fontconfig 找不到本子集，仍會 fallback 系統字型。
//
// 組合兩段純函式——renderDagSvg 算佈局並輸出 SVG，renderDagPng 走 sharp 轉 PNG。
// 刻意不在這裡做 workflow JSON 嵌入：嵌入（IEND 之後追加 trailing data）與視覺
// 渲染是兩件事，要一起用時由呼叫端自行
// `embedWorkflowIntoPng(await renderWorkflowDagPng(...))`。

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { DagConnectionInput, DagNodeInput, DagRenderOptions } from "./dag-renderer";
import { renderDagSvg } from "./dag-renderer";
import { renderDagPng } from "./dag-png";

/** 只跑一次：進程內第一張縮圖渲染前把 fontconfig 指向部署包內字型。 */
let fontConfigReady = false;
function ensureFontConfig(): void {
  if (fontConfigReady) return;
  fontConfigReady = true;
  try {
    const fontDir = path.join(process.cwd(), "public/fonts");
    const confSrc = path.join(fontDir, "dag-fonts.conf");
    if (!existsSync(confSrc)) return; // 找不到設定就交給系統 fontconfig（本機開發路徑）
    // cachedir 先建（fontconfig 不會自建目錄，缺目錄時直接棄用整份設定）
    try {
      mkdirSync("/tmp/fontconfig-cache", { recursive: true });
    } catch {
      /* 唯讀或已存在都不影響 */
    }
    const conf = readFileSync(confSrc, "utf8").replace("__FONT_DIR__", fontDir);
    writeFileSync("/tmp/dag-fonts.conf", conf);
    process.env.FONTCONFIG_FILE = "/tmp/dag-fonts.conf";
  } catch {
    // 字型設定失敗不擋渲染：寧可方框也不能讓歷史寫入陪葬（與縮圖失敗同款語義）
  }
}

/**
 * 端到端：DAG 資料 → PNG buffer（含 layout）。
 * 只能在 Node.js runtime 呼叫（sharp 為原生模組，Edge runtime 一定失敗）。
 */
export async function renderWorkflowDagPng(
  nodes: DagNodeInput[],
  connections: DagConnectionInput[],
  options?: DagRenderOptions,
): Promise<Buffer> {
  ensureFontConfig();
  const svg = renderDagSvg(nodes, connections, options);
  return renderDagPng(svg);
}
