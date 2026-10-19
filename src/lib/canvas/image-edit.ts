// 画布图片编辑核心：裁剪 / 切图 / 抠除 / 旋转 / 角度 的像素操作。
//
// 分层：纯数学（computeSplitRects / computeSplitRectsFromLines / findLineSpot /
// clampCropRect / rotatedSize / buildAnglePrompt）可被 node:test 直测；
// 浏览器段（loadImageBitmap / *ToDataUrl）依赖 DOM canvas，只在 client 元件里
// 呼叫。输出一律 PNG dataURL——编辑结果作为新子节点落回画布，不改原节点
// （非破坏性）。「角度」模式不产出像素，只组装生图指令交由宿主 AI 重绘。
//
// CORS：直接 fetch 失败（跨域挡掉）时 fallback 到 /api/canvas/image-proxy
// 以同源身份代读。dataURL 不经网路直接解。

export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 裁剪框最小边长（px）：小于这个尺寸的裁剪没有意义且容易误触。 */
const MIN_CROP_SIZE = 8;

/**
 * 网格切图：rows×cols 均分，除不尽的余数像素全部并给最后一行/列。
 * 保证：所有矩形面积和 = 原图面积、互不重叠、边界严丝合缝。
 * 输出顺序：先行后列（第 0 行左→右，再第 1 行……）。
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
 * 线位规整：四舍五入为整数像素 → 过滤出开区间 (0, size) 内的值 → 去重 → 升幂。
 * 两条小数线舍入撞在同一像素时只留一条，杜绝 0 宽/0 高的切片。
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
 * 由切割线位置算矩形：xs/ys 为 0<坐标<宽/高 的线位置（已排序去重；防御性地
 * 再做一次规整），输出 (xs.length+1)*(ys.length+1) 个矩形，覆盖完整不重叠。
 * 输出顺序与 computeSplitRects 一致：先行后列（第 0 行左→右，再第 1 行……）。
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
 * 在现有线与边界之间找最大空隙的中点（放新线）；并列最大取靠前者。
 * 全部空隙 < minGap（预设 16px：拖动 clamp 两侧各留 8px 的最小可活动空间）回 null。
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

/** 裁剪框 clamp 到图片范围内，宽高至少 MIN_CROP_SIZE（贴边时往内缩）。 */
export function clampCropRect(rect: PixelRect, imgWidth: number, imgHeight: number): PixelRect {
  const width = Math.min(Math.max(MIN_CROP_SIZE, rect.width), imgWidth);
  const height = Math.min(Math.max(MIN_CROP_SIZE, rect.height), imgHeight);
  const x = Math.min(Math.max(0, rect.x), imgWidth - width);
  const y = Math.min(Math.max(0, rect.y), imgHeight - height);
  return { x, y, width, height };
}

/** 旋转后尺寸：90/270 交换宽高，0/180 不变。deg 只认 0|90|180|270。 */
export function rotatedSize(width: number, height: number, deg: number): { width: number; height: number } {
  const d = ((Math.round(deg) % 360) + 360) % 360;
  return d === 90 || d === 270 ? { width: height, height: width } : { width, height };
}

/**
 * 「角度」模式的中文生图指令组装（纯字串，可直测）。
 * yawDeg：正=向右、负=向左；pitchDeg：正=俯视、负=仰视；
 * distance：相机距离倍率（>1 拉远、<1 拉近、=1 不动）。
 * 三者皆为零位时退化为「保持当前相机角度重绘」。
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

// ─────────────────────────────────────────── 浏览器端（依赖 DOM）

/** 经同源代理的 URL。 */
function proxiedUrl(url: string): string {
  return `/api/canvas/image-proxy?url=${encodeURIComponent(url)}`;
}

async function blobFromUrl(url: string): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`图片获取失败（${res.status}）`);
  return res.blob();
}

/**
 * 载图：dataURL 直解；https 先直接 fetch（同源或带 CORS 头的 CDN 走这条），
 * 跨域被挡（fetch throw TypeError）→ fallback 走 /api/canvas/image-proxy。
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
      // TypeError = CORS/网路层被挡；HTTP 错误（上面 throw 的 Error）也再给代理一次机会。
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

/** 裁剪 → PNG dataURL。rect 以原图像素座标计。 */
export function cropToDataUrl(bmp: ImageBitmap, rect: PixelRect): string {
  const r = clampCropRect(rect, bmp.width, bmp.height);
  const { canvas, ctx } = makeCanvas(r.width, r.height);
  ctx.drawImage(bmp, r.x, r.y, r.width, r.height, 0, 0, r.width, r.height);
  return canvas.toDataURL("image/png");
}

/** 网格切图 → N 张 PNG dataURL（附各自的原图矩形）。 */
export function splitToDataUrls(bmp: ImageBitmap, rows: number, cols: number): { dataUrl: string; rect: PixelRect }[] {
  return splitRectsToDataUrls(bmp, computeSplitRects(bmp.width, bmp.height, rows, cols));
}

/** 自定义矩形切图：把任意矩形集（如 computeSplitRectsFromLines 的输出）各切成一张 PNG dataURL。 */
export function splitRectsToDataUrls(bmp: ImageBitmap, rects: PixelRect[]): { dataUrl: string; rect: PixelRect }[] {
  return rects.map((rect) => {
    const { canvas, ctx } = makeCanvas(rect.width, rect.height);
    ctx.drawImage(bmp, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
    return { dataUrl: canvas.toDataURL("image/png"), rect };
  });
}

/** 旋转（0/90/180/270）+ 翻转（水平/垂直）→ PNG dataURL。 */
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
 * 抠除：maskCanvas（与原图同尺寸、被涂区 alpha>0）指定的像素变透明。
 * destination-out：mask 不透明处把底图挖掉，输出带透明通道的 PNG。
 */
export function eraseMaskToDataUrl(bmp: ImageBitmap, maskCanvas: HTMLCanvasElement): string {
  const { canvas, ctx } = makeCanvas(bmp.width, bmp.height);
  ctx.drawImage(bmp, 0, 0);
  ctx.globalCompositeOperation = "destination-out";
  ctx.drawImage(maskCanvas, 0, 0, maskCanvas.width, maskCanvas.height, 0, 0, bmp.width, bmp.height);
  return canvas.toDataURL("image/png");
}

/**
 * 涂抹 mask → AI 重绘用的遮罩 PNG：与原图同尺寸（width×height），
 * 涂抹过的像素（alpha>0，含半透明笔刷与抗锯齿边缘）二值化为纯白不透明，
 * 其余完全透明。输出交由宿主的 inpaint 生成链路。
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
