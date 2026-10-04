// SVG 字串 → PNG buffer（走 sharp）。
//
// 为什么要独立一支：dag-renderer.ts 是纯函式（可在 node --test 直接跑、零原生依赖），
// 而 sharp 是「原生模组」——只有需要真的落地 PNG（下载／Blob／写档）时才载入，
// 让不碰图的那一半逻辑不被原生模组拖住。
//
// sharp 在本 repo 的相容性事实：
// - package.json 没有显式宣告 sharp，但 next@15 自带 sharp@0.34.5（libvips 8.17.3）并已安装，
//   因此 import "sharp" 解析得到 Next 自己那份，无需新增依赖、也无版本分叉。
// - Next.js serverless 执行环境（Vercel）内建 sharp 是官方支援路径（next/image 优化器即用同一份），
//   所以本档在 route handler / worker 内可用；但在 Vercel Edge runtime 不可用（原生模组），
//   呼叫端必须放在 Node.js runtime 的 route 或 worker 内。
//
// 必须用 `import type` 取得型别（配合 esModuleInterop 的 default import）：
// sharp 是 CJS 原生模组，`import sharp from "sharp"` 在 tsx/Next 两种载入器下都成立。
import sharp from "sharp";

/**
 * SVG 字串 → PNG buffer（走 sharp）。
 *
 * density 216 = 3 倍基准解析度（SVG 预设 72 DPI）。前一版用 144（2 倍）在
 * 220px 卡片上仍偏糊——缩图要能在历史卡的小尺寸与灯箱的大尺寸下都可读，
 * 3 倍是文字笔画不糊的下限（实测：12.5px 标题在 216 DPI 下笔画完整）。
 * 不做 resize，输出尺寸 = SVG 自身 width/height × 3，呼叫端需要固定尺寸请自行 resize。
 */
export async function renderDagPng(svg: string): Promise<Buffer> {
  if (typeof svg !== "string" || !svg.trim().startsWith("<svg")) {
    throw new Error("renderDagPng: 输入必须是 <svg> 开头的字串");
  }
  return sharp(Buffer.from(svg, "utf8"), { density: 216 }).png({ compressionLevel: 9 }).toBuffer();
}
