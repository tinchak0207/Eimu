// PNG 工作流嵌入／提取（零依赖）。
//
// 格式：在整段合法 PNG（含 IEND chunk 与其 CRC）之后追加 trailing data：
//   [JSON payload（UTF-8，该 JSON 即 workflow-recall 相容的工作流配置）]
//   [magic：8 位元组 "WFSTUDIO"]
//   [version：1 位元组，目前为 1]
//   [payload 长度：4 位元组 unsigned big-endian]
//
// 长度写在尾端，提取时只需读最后 13 个位元组就知道 payload 起点，
// 不必整档扫描；magic + PNG 签名双重校验 + JSON 合法性校验来挡坏档误判。
//
// 本档**零依赖且可在浏览器端使用**（ReferenceImageUpload 等客户端元件会
// import extractWorkflowFromPng 读取用户拖进来的 PNG）。因此视觉渲染出口
// （renderWorkflowDagPng，走 sharp 原生模组）刻意拆到 ./dag-png-server.ts：
// 把 sharp 放进本档会让 webpack 把它拖进 browser bundle，build 直接失败
// （实锤：UnhandledSchemeError: Reading from "node:events" is not handled）。


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
 * 把工作流 JSON 字串附加到合法 PNG 的档尾（IEND 之后的 trailing data）。
 * 回传一个新的 Uint8Array，原 PNG 位元组原封不动地作为前缀保留。
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
 * 从 PNG trailing data 提取工作流 JSON 字串。
 * 任何一个校验不过（非 PNG、无 magic、版本不符、长度越界、payload 非合法 JSON）
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
