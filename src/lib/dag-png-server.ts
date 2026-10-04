// DAG 视觉渲染出口（**server-only**）。
//
// 为什么单独一档而不是并进 workflow-png.ts：workflow-png.ts 会被客户端元件
// import（ReferenceImageUpload 读用户拖入的 PNG），而本档经 dag-png.ts 拉进
// sharp——sharp 是 Node 原生模组，`node:events` 进 browser bundle 会让 webpack
// 直接炸（UnhandledSchemeError: Reading from "node:events" is not handled）。
// 拆档是唯一干净的隔离方式：客户端只碰零依赖的 workflow-png.ts，伺服器端
// （route / worker）才 import 本档。
//
// ─────────────────── CJK 字型（2026-09-20 豆腐方框修复）───────────────────
// Vercel serverless 完全没有系统字型（实测 fc-list=0），librsvg 渲染中文
// 全变方框。解法＝字型随程式码部署：
//   public/fonts/NotoSansCJKsc-subset.otf（Noto Sans CJK SC 子集，5MB，
//   常用汉字 U+4E00–U+9FA5 全覆盖）
//   public/fonts/dag-fonts.conf（fontconfig 设定，dir 由路径占位符运行时替换）
// 放 public/ 的理由：Vercel 构建后 /var/task/public/ 的相对布局稳定可预期
//（Next.js 静态资产标准位置），源码 src/ 目录在 serverless bundle 内不存在。
// 本档在首次渲染前：
//   1. 把 dag-fonts.conf 的 __FONT_DIR__ 占位符替换成实际绝对路径，写到 /tmp；
//   2. 设 FONTCONFIG_FILE=/tmp/dag-fonts.conf——librsvg 经 fontconfig 找字型，
//      这是它唯一认的入口；
//   3. cachedir 指 /tmp/fontconfig-cache（serverless 唯一可写目录）。
// 本机开发（有系统字型）不受影响：FONTCONFIG_FILE 只在本档设置，且即便
// fontconfig 找不到本子集，仍会 fallback 系统字型。
//
// 组合两段纯函式——renderDagSvg 算布局并输出 SVG，renderDagPng 走 sharp 转 PNG。
// 刻意不在这里做 workflow JSON 嵌入：嵌入（IEND 之后追加 trailing data）与视觉
// 渲染是两件事，要一起用时由呼叫端自行
// `embedWorkflowIntoPng(await renderWorkflowDagPng(...))`。

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { DagConnectionInput, DagNodeInput, DagRenderOptions } from "./dag-renderer";
import { renderDagSvg } from "./dag-renderer";
import { renderDagPng } from "./dag-png";

/** 只跑一次：进程内第一张缩图渲染前把 fontconfig 指向部署包内字型。 */
let fontConfigReady = false;
function ensureFontConfig(): void {
  if (fontConfigReady) return;
  fontConfigReady = true;
  try {
    const fontDir = path.join(process.cwd(), "public/fonts");
    const confSrc = path.join(fontDir, "dag-fonts.conf");
    if (!existsSync(confSrc)) return; // 找不到设定就交给系统 fontconfig（本机开发路径）
    // cachedir 先建（fontconfig 不会自建目录，缺目录时直接弃用整份设定）
    try {
      mkdirSync("/tmp/fontconfig-cache", { recursive: true });
    } catch {
      /* 唯读或已存在都不影响 */
    }
    const conf = readFileSync(confSrc, "utf8").replace("__FONT_DIR__", fontDir);
    writeFileSync("/tmp/dag-fonts.conf", conf);
    process.env.FONTCONFIG_FILE = "/tmp/dag-fonts.conf";
  } catch {
    // 字型设定失败不挡渲染：宁可方框也不能让历史写入陪葬（与缩图失败同款语义）
  }
}

/**
 * 端到端：DAG 资料 → PNG buffer（含 layout）。
 * 只能在 Node.js runtime 呼叫（sharp 为原生模组，Edge runtime 一定失败）。
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
