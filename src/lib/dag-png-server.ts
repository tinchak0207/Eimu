// DAG 視覺渲染出口（**server-only**）。
//
// 為什麼單獨一檔而不是併進 workflow-png.ts：workflow-png.ts 會被客戶端元件
// import（ReferenceImageUpload 讀用戶拖入的 PNG），而本檔經 dag-png.ts 拉進
// sharp——sharp 是 Node 原生模組，`node:events` 進 browser bundle 會讓 webpack
// 直接炸（UnhandledSchemeError: Reading from "node:events" is not handled）。
// 拆檔是唯一乾淨的隔離方式：客戶端只碰零依賴的 workflow-png.ts，伺服器端
// （route / worker）才 import 本檔。
//
// 組合兩段純函式——renderDagSvg 算佈局並輸出 SVG，renderDagPng 走 sharp 轉 PNG。
// 刻意不在這裡做 workflow JSON 嵌入：嵌入（IEND 之後追加 trailing data）與視覺
// 渲染是兩件事，要一起用時由呼叫端自行
// `embedWorkflowIntoPng(await renderWorkflowDagPng(...))`。

import type { DagConnectionInput, DagNodeInput, DagRenderOptions } from "./dag-renderer";
import { renderDagSvg } from "./dag-renderer";
import { renderDagPng } from "./dag-png";

/**
 * 端到端：DAG 資料 → PNG buffer（含 layout）。
 * 只能在 Node.js runtime 呼叫（sharp 為原生模組，Edge runtime 一定失敗）。
 */
export async function renderWorkflowDagPng(
  nodes: DagNodeInput[],
  connections: DagConnectionInput[],
  options?: DagRenderOptions,
): Promise<Buffer> {
  const svg = renderDagSvg(nodes, connections, options);
  return renderDagPng(svg);
}
