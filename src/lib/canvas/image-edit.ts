// 畫布圖片編輯核心：裁剪 / 切图 / 抠除 / 旋转 / 角度 的像素操作。
//
// 分層：純數學（computeSplitRects / computeSplitRectsFromLines / findLineSpot /
// clampCropRect / rotatedSize / buildAnglePrompt）可被 node:test 直測；
// 瀏覽器段（loadImageBitmap / *ToDataUrl）依賴 DOM canvas，只在 client 元件裡
// 呼叫。輸出一律 PNG dataURL——編輯結果作為新子節點落回畫布，不改原節點
// （非破壞性）。「角度」模式不產出像素，只組裝生圖指令交由宿主 AI 重繪。
//
// CORS：直接 fetch 失敗（跨域擋掉）時 fallback 到 /api/canvas/image-proxy
// 以同源身份代讀。dataURL 不經網路直接解。

export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 裁剪框最小邊長（px）：小於這個尺寸的裁剪沒有意義且容易誤觸。 */
const MIN_CROP_SIZE = 8;

/**
 * 網格切圖：rows×cols 均分，除不盡的餘數像素全部併給最後一行/列。
 * 保證：所有矩形面積和 = 原圖面積、互不重疊、邊界嚴絲合縫。
 * 輸出順序：先行後列（第 0 行左→右，再第 1 行……）。
 */
export function computeSplitRects(width: number, height: number, rows: number, cols: number): PixelRect[] {
  const r = Math.max(1, Math.floor(rows));
  const c = Math.max(1, Math.floor(cols));
  const cellW = Math.floor(width / c);
  const cellH = Math.floor(height / r);
  const rects: PixelRect[] = [];
  for (let row = 0; row < r; row++) {
    for (let col = 0; col < c; col++) {
      const x = col * cellW;
      const y = row * cellH;
      rects.push({
        x,
        y,
        width: col === c - 1 ? width - x : cellW,
        height: row === r - 1 ? height - y : cellH,
      });
    }
  }
  return rects;
}

/**
 * 線位規整：四捨五入為整數像素 → 過濾出開區間 (0, size) 內的值 → 去重 → 升冪。
 * 兩條小數線捨入撞在同一像素時只留一條，杜絕 0 寬/0 高的切片。
 */
function normalizeLines(lines: number[], size: number): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const line of lines) {
    const v = Math.round(line);
    if (v <= 0 || v >= size || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out.sort((a, b) => a - b);
}

/**
 * 由切割線位置算矩形：xs/ys 為 0<坐標<寬/高 的線位置（已排序去重；防禦性地
 * 再做一次規整），輸出 (xs.length+1)*(ys.length+1) 個矩形，覆蓋完整不重疊。
 * 輸出順序與 computeSplitRects 一致：先行後列（第 0 行左→右，再第 1 行……）。
 */
export function computeSplitRectsFromLines(width: number, height: number, xs: number[], ys: number[]): PixelRect[] {
  const xEdges = [0, ...normalizeLines(xs, width), width];
  const yEdges = [0, ...normalizeLines(ys, height), height];
  const rects: PixelRect[] = [];
  for (let row = 0; row < yEdges.length - 1; row++) {
    for (let col = 0; col < xEdges.length - 1; col++) {
      rects.push({
        x: xEdges[col],
        y: yEdges[row],
        width: xEdges[col + 1] - xEdges[col],
        height: yEdges[row + 1] - yEdges[row],
      });
    }
  }
  return rects;
}

/**
 * 在現有線與邊界之間找最大空隙的中點（放新線）；並列最大取靠前者。
 * 全部空隙 < minGap（預設 16px：拖動 clamp 兩側各留 8px 的最小可活動空間）回 null。
 */
export function findLineSpot(size: number, lines: number[], minGap = 16): number | null {
  const cuts = [0, ...normalizeLines(lines, size), size];
  let best = -1;
  let spot: number | null = null;
  for (let i = 0; i < cuts.length - 1; i++) {
    const gap = cuts[i + 1] - cuts[i];
    if (gap > best) {
      best = gap;
      spot = Math.round(cuts[i] + gap / 2);
    }
  }
  return best >= minGap && spot !== null ? spot : null;
}

/** 裁剪框 clamp 到圖片範圍內，寬高至少 MIN_CROP_SIZE（貼邊時往內縮）。 */
export function clampCropRect(rect: PixelRect, imgWidth: number, imgHeight: number): PixelRect {
  const width = Math.min(Math.max(MIN_CROP_SIZE, rect.width), imgWidth);
  const height = Math.min(Math.max(MIN_CROP_SIZE, rect.height), imgHeight);
  const x = Math.min(Math.max(0, rect.x), imgWidth - width);
  const y = Math.min(Math.max(0, rect.y), imgHeight - height);
  return { x, y, width, height };
}

/** 旋轉後尺寸：90/270 交換寬高，0/180 不變。deg 只認 0|90|180|270。 */
export function rotatedSize(width: number, height: number, deg: number): { width: number; height: number } {
  const d = ((Math.round(deg) % 360) + 360) % 360;
  return d === 90 || d === 270 ? { width: height, height: width } : { width, height };
}

/**
 * 「角度」模式的中文生圖指令組裝（純字串，可直測）。
 * yawDeg：正=向右、負=向左；pitchDeg：正=俯視、負=仰視；
 * distance：相機距離倍率（>1 拉遠、<1 拉近、=1 不動）。
 * 三者皆為零位時退化為「保持當前相機角度重繪」。
 */
export function buildAnglePrompt(yawDeg: number, pitchDeg: number, distance: number): string {
  const yaw = Math.round(yawDeg);
  const pitch = Math.round(pitchDeg);
  const parts: string[] = [];
  if (yaw !== 0) parts.push(`水平向${yaw > 0 ? "右" : "左"}旋转 ${Math.abs(yaw)} 度`);
  if (pitch !== 0) parts.push(`${pitch > 0 ? "俯视" : "仰视"} ${Math.abs(pitch)} 度`);
  if (distance > 1.001) parts.push(`拉远视角（约 ${distance.toFixed(1)} 倍距离）`);
  else if (distance < 0.999) parts.push(`拉近视角（约 ${distance.toFixed(1)} 倍距离）`);
  if (parts.length === 0) return "保持当前相机角度重绘此图，保持主体、构图与风格一致";
  return `将镜头${parts.join("、")}，保持主体与风格一致重绘此图`;
}

// ─────────────────────────────────────────── 瀏覽器端（依賴 DOM）

/** 經同源代理的 URL。 */
function proxiedUrl(url: string): string {
  return `/api/canvas/image-proxy?url=${encodeURIComponent(url)}`;
}

async function blobFromUrl(url: string): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`图片获取失败（${res.status}）`);
  return res.blob();
}

/**
 * 載圖：dataURL 直解；https 先直接 fetch（同源或帶 CORS 頭的 CDN 走這條），
 * 跨域被擋（fetch throw TypeError）→ fallback 走 /api/canvas/image-proxy。
 */
export async function loadImageBitmap(url: string): Promise<ImageBitmap> {
  let blob: Blob;
  if (url.startsWith("data:")) {
    const res = await fetch(url);
    blob = await res.blob();
  } else {
    try {
      blob = await blobFromUrl(url);
    } catch (error) {
      // TypeError = CORS/網路層被擋；HTTP 錯誤（上面 throw 的 Error）也再給代理一次機會。
      try {
        blob = await blobFromUrl(proxiedUrl(url));
      } catch {
        throw new Error(
          `图片加载失败：${error instanceof Error ? error.message : "网络错误"}（代理重试也未成功）`,
        );
      }
    }
  }
  try {
    return await createImageBitmap(blob);
  } catch {
    throw new Error("图片解码失败：文件可能已损坏或格式不受支持");
  }
}

function makeCanvas(width: number, height: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("浏览器不支持 canvas 2d");
  return { canvas, ctx };
}

/** 裁剪 → PNG dataURL。rect 以原圖像素座標計。 */
export function cropToDataUrl(bmp: ImageBitmap, rect: PixelRect): string {
  const r = clampCropRect(rect, bmp.width, bmp.height);
  const { canvas, ctx } = makeCanvas(r.width, r.height);
  ctx.drawImage(bmp, r.x, r.y, r.width, r.height, 0, 0, r.width, r.height);
  return canvas.toDataURL("image/png");
}

/** 網格切圖 → N 張 PNG dataURL（附各自的原圖矩形）。 */
export function splitToDataUrls(bmp: ImageBitmap, rows: number, cols: number): { dataUrl: string; rect: PixelRect }[] {
  return splitRectsToDataUrls(bmp, computeSplitRects(bmp.width, bmp.height, rows, cols));
}

/** 自定義矩形切圖：把任意矩形集（如 computeSplitRectsFromLines 的輸出）各切成一張 PNG dataURL。 */
export function splitRectsToDataUrls(bmp: ImageBitmap, rects: PixelRect[]): { dataUrl: string; rect: PixelRect }[] {
  return rects.map((rect) => {
    const { canvas, ctx } = makeCanvas(rect.width, rect.height);
    ctx.drawImage(bmp, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
    return { dataUrl: canvas.toDataURL("image/png"), rect };
  });
}

/** 旋轉（0/90/180/270）+ 翻轉（水平/垂直）→ PNG dataURL。 */
export function rotateFlipToDataUrl(bmp: ImageBitmap, deg: number, flipH: boolean, flipV: boolean): string {
  const d = ((Math.round(deg) % 360) + 360) % 360;
  const size = rotatedSize(bmp.width, bmp.height, d);
  const { canvas, ctx } = makeCanvas(size.width, size.height);
  ctx.translate(size.width / 2, size.height / 2);
  ctx.rotate((d * Math.PI) / 180);
  ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
  ctx.drawImage(bmp, -bmp.width / 2, -bmp.height / 2);
  return canvas.toDataURL("image/png");
}

/**
 * 抠除：maskCanvas（與原圖同尺寸、被塗區 alpha>0）指定的像素變透明。
 * destination-out：mask 不透明處把底圖挖掉，輸出帶透明通道的 PNG。
 */
export function eraseMaskToDataUrl(bmp: ImageBitmap, maskCanvas: HTMLCanvasElement): string {
  const { canvas, ctx } = makeCanvas(bmp.width, bmp.height);
  ctx.drawImage(bmp, 0, 0);
  ctx.globalCompositeOperation = "destination-out";
  ctx.drawImage(maskCanvas, 0, 0, maskCanvas.width, maskCanvas.height, 0, 0, bmp.width, bmp.height);
  return canvas.toDataURL("image/png");
}

/**
 * 塗抹 mask → AI 重繪用的遮罩 PNG：與原圖同尺寸（width×height），
 * 塗抹過的像素（alpha>0，含半透明筆刷與抗鋸齒邊緣）二值化為純白不透明，
 * 其餘完全透明。輸出交由宿主的 inpaint 生成鏈路。
 */
export function maskToDataUrl(maskCanvas: HTMLCanvasElement, width: number, height: number): string {
  const { canvas, ctx } = makeCanvas(width, height);
  ctx.drawImage(maskCanvas, 0, 0, maskCanvas.width, maskCanvas.height, 0, 0, canvas.width, canvas.height);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const painted = d[i + 3] > 0;
    d[i] = painted ? 255 : 0;
    d[i + 1] = painted ? 255 : 0;
    d[i + 2] = painted ? 255 : 0;
    d[i + 3] = painted ? 255 : 0;
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL("image/png");
}
