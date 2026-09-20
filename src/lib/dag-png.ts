// SVG 字串 → PNG buffer（走 sharp）。
//
// 為什麼要獨立一支：dag-renderer.ts 是純函式（可在 node --test 直接跑、零原生依賴），
// 而 sharp 是「原生模組」——只有需要真的落地 PNG（下載／Blob／寫檔）時才載入，
// 讓不碰圖的那一半邏輯不被原生模組拖住。
//
// sharp 在本 repo 的相容性事實：
// - package.json 沒有顯式宣告 sharp，但 next@15 自帶 sharp@0.34.5（libvips 8.17.3）並已安裝，
//   因此 import "sharp" 解析得到 Next 自己那份，無需新增依賴、也無版本分叉。
// - Next.js serverless 執行環境（Vercel）內建 sharp 是官方支援路徑（next/image 優化器即用同一份），
//   所以本檔在 route handler / worker 內可用；但在 Vercel Edge runtime 不可用（原生模組），
//   呼叫端必須放在 Node.js runtime 的 route 或 worker 內。
//
// 必須用 `import type` 取得型別（配合 esModuleInterop 的 default import）：
// sharp 是 CJS 原生模組，`import sharp from "sharp"` 在 tsx/Next 兩種載入器下都成立。
import sharp from "sharp";

/**
 * SVG 字串 → PNG buffer（走 sharp）。
 *
 * density 216 = 3 倍基準解析度（SVG 預設 72 DPI）。前一版用 144（2 倍）在
 * 220px 卡片上仍偏糊——縮圖要能在歷史卡的小尺寸與燈箱的大尺寸下都可讀，
 * 3 倍是文字筆畫不糊的下限（實測：12.5px 標題在 216 DPI 下筆畫完整）。
 * 不做 resize，輸出尺寸 = SVG 自身 width/height × 3，呼叫端需要固定尺寸請自行 resize。
 */
export async function renderDagPng(svg: string): Promise<Buffer> {
  if (typeof svg !== "string" || !svg.trim().startsWith("<svg")) {
    throw new Error("renderDagPng: 輸入必須是 <svg> 開頭的字串");
  }
  return sharp(Buffer.from(svg, "utf8"), { density: 216 }).png({ compressionLevel: 9 }).toBuffer();
}
