// PNG 工作流嵌入／提取（零依賴）。
//
// 格式：在整段合法 PNG（含 IEND chunk 與其 CRC）之後追加 trailing data：
//   [JSON payload（UTF-8，該 JSON 即 workflow-recall 相容的工作流配置）]
//   [magic：8 位元組 "WFSTUDIO"]
//   [version：1 位元組，目前為 1]
//   [payload 長度：4 位元組 unsigned big-endian]
//
// 長度寫在尾端，提取時只需讀最後 13 個位元組就知道 payload 起點，
// 不必整檔掃描；magic + PNG 簽名雙重校驗 + JSON 合法性校驗來擋壞檔誤判。
//
// 本檔另有端到端視覺渲染出口 renderWorkflowDagPng（DAG 資料 → PNG buffer）：
// 與上面 trailing data 的前綴／尾端格式無關，只是共用「工作流 PNG」這個檔名語義。

import type { DagConnectionInput, DagNodeInput, DagRenderOptions } from "./dag-renderer";
import { renderDagSvg } from "./dag-renderer";
import { renderDagPng } from "./dag-png";

export const WORKFLOW_PNG_MAGIC = "WFSTUDIO";
export const WORKFLOW_PNG_VERSION = 1;
export const WORKFLOW_PNG_HEADER_SIZE = 8 + 1 + 4; // magic + version + length

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function toMagicBytes(): Uint8Array {
  const bytes = new Uint8Array(8);
  for (let index = 0; index < 8; index += 1) {
    bytes[index] = WORKFLOW_PNG_MAGIC.charCodeAt(index);
  }
  return bytes;
}

const MAGIC_BYTES = toMagicBytes();

function hasPngSignature(png: Uint8Array): boolean {
  if (png.length < PNG_SIGNATURE.length) return false;
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (png[index] !== PNG_SIGNATURE[index]) return false;
  }
  return true;
}

/**
 * 把工作流 JSON 字串附加到合法 PNG 的檔尾（IEND 之後的 trailing data）。
 * 回傳一個新的 Uint8Array，原 PNG 位元組原封不動地作為前綴保留。
 */
export function embedWorkflowIntoPng(png: Uint8Array, workflow: string): Uint8Array {
  const payload = new TextEncoder().encode(workflow);
  const output = new Uint8Array(png.length + payload.length + WORKFLOW_PNG_HEADER_SIZE);
  output.set(png, 0);
  output.set(payload, png.length);
  output.set(MAGIC_BYTES, png.length + payload.length);
  output[png.length + payload.length + 8] = WORKFLOW_PNG_VERSION;
  const lengthOffset = png.length + payload.length + 9;
  const length = payload.length;
  output[lengthOffset] = (length >>> 24) & 0xff;
  output[lengthOffset + 1] = (length >>> 16) & 0xff;
  output[lengthOffset + 2] = (length >>> 8) & 0xff;
  output[lengthOffset + 3] = length & 0xff;
  return output;
}

/**
 * 從 PNG trailing data 提取工作流 JSON 字串。
 * 任何一個校驗不過（非 PNG、無 magic、版本不符、長度越界、payload 非合法 JSON）
 * 都回 null。
 */
export function extractWorkflowFromPng(png: Uint8Array): string | null {
  if (png.length < PNG_SIGNATURE.length + WORKFLOW_PNG_HEADER_SIZE) return null;
  if (!hasPngSignature(png)) return null;

  const headerOffset = png.length - WORKFLOW_PNG_HEADER_SIZE;
  for (let index = 0; index < MAGIC_BYTES.length; index += 1) {
    if (png[headerOffset + index] !== MAGIC_BYTES[index]) return null;
  }
  if (png[headerOffset + 8] !== WORKFLOW_PNG_VERSION) return null;

  const length =
    ((png[headerOffset + 9] << 24) >>> 0) +
    (png[headerOffset + 10] << 16) +
    (png[headerOffset + 11] << 8) +
    png[headerOffset + 12];
  if (length <= 0 || headerOffset - length < PNG_SIGNATURE.length) return null;

  const payloadOffset = headerOffset - length;
  const text = new TextDecoder().decode(png.subarray(payloadOffset, headerOffset));
  try {
    JSON.parse(text);
    return text;
  } catch {
    return null;
  }
}

/**
 * 端到端：DAG 資料 → PNG buffer（含 layout）。
 *
 * 組合兩段純函式——renderDagSvg 算佈局並輸出 SVG，renderDagPng 走 sharp 轉 PNG。
 * 刻意不在這裡做 workflow JSON 嵌入：嵌入（IEND 之後追加 trailing data）與
 * 視覺渲染是兩件事，要一起用時由呼叫端自行 `embedWorkflowIntoPng(await renderWorkflowDagPng(...))`。
 */
export async function renderWorkflowDagPng(
  nodes: DagNodeInput[],
  connections: DagConnectionInput[],
  options?: DagRenderOptions,
): Promise<Buffer> {
  const svg = renderDagSvg(nodes, connections, options);
  return renderDagPng(svg);
}
