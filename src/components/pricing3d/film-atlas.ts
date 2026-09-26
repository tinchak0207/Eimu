/* ╁━ 作品卡圖集：每一格是一件「裝著作品的影像載體」，六種混裝 ╁━
   2026-09-26 暴君：「圖片像掉色的老照片」「容器缺乏膠片感」→ 第二輪：「單一膠片太單調，缺乏多樣性」。
   六種載體（輪流排，任何一段連續的卡都是混裝）：
   - film     35mm 負片：黑片基 + 兩側鏤空齒孔 + 琥珀邊碼；
   - polaroid 拍立得：奶白相框、下緣加寬、手寫編號；
   - slide    幻燈片：方形塑膠片框 + 橫幅窗口 + 片框小字；
   - instax   迷你拍立得：窄長白框；
   - print    光面相片：細白邊、圓角；
   - glass    玻璃相片：滿版、圓角、一圈虹彩邊。
   輪廓不同靠 alpha（格內載體以外全透明，卡面 shader 的 alphaTest 打穿，側面也跟著輪廓裁）。
   鮮：畫進圖集時加飽和與對比（canvas filter），3D 端卡面再以近乎自發光呈現。
   先畫縮圖（~9KB/張）、原圖到了再覆蓋；rank 防止慢到的縮圖蓋掉原圖。純 canvas，不依賴 three。 */

export interface FilmAtlas {
  canvas: HTMLCanvasElement;
  slots: number;
  /** 某格在紋理上的 uv 窗（x, y, w, h；flipY 後 v 向上）。 */
  uv(slot: number): [number, number, number, number];
  dispose(): void;
}

interface FilmAtlasInit {
  cols: number;
  rows: number;
  slotW: number;
  /** 格高 / 格寬（= 卡片深 / 寬）。 */
  aspect: number;
  sources: Array<{ thumb: string; full: string }>;
  /** 有新圖畫進圖集（呼叫端節流後上傳紋理）。 */
  onPaint(): void;
}

type Carrier = "film" | "polaroid" | "slide" | "instax" | "print" | "glass";
const CARRIERS: Carrier[] = ["film", "polaroid", "print", "slide", "glass", "instax", "polaroid", "film", "glass", "print"];

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
}

const PLACEHOLDER_TINTS = [
  ["#ffb3d9", "#9f8cff"],
  ["#8fd3ff", "#c6a8ff"],
  ["#ffd29a", "#ff8fc0"],
  ["#a8f0d8", "#7fb2ff"],
];

export function createFilmAtlas(init: FilmAtlasInit): FilmAtlas {
  const { cols, rows, slotW: W, aspect, sources, onPaint } = init;
  const H = Math.round(W * aspect);
  const canvas = document.createElement("canvas");
  canvas.width = cols * W;
  canvas.height = rows * H;
  const ctx = canvas.getContext("2d");
  const slots = cols * rows;
  const rank = new Int8Array(slots);
  const photos: Rect[] = [];
  const images: HTMLImageElement[] = [];
  let disposed = false;

  const origin = (slot: number) => [(slot % cols) * W, Math.floor(slot / cols) * H] as const;

  function rr(c: CanvasRenderingContext2D, r: Rect) {
    c.beginPath();
    c.roundRect(r.x, r.y, r.w, r.h, r.r);
  }

  function label(c: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, color: string, rotate = 0, font = '700 SIZEpx "Helvetica Neue", Arial, sans-serif') {
    c.save();
    c.translate(x, y);
    c.rotate(rotate);
    c.fillStyle = color;
    c.font = font.replace("SIZE", String(Math.round(size)));
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillText(text, 0, 0);
    c.restore();
  }

  /** 畫載體（相框 / 片基 / 片框），回傳作品該放的窗口。 */
  function drawCarrier(slot: number): Rect {
    const c = ctx as CanvasRenderingContext2D;
    const [ox, oy] = origin(slot);
    const kind = CARRIERS[slot % CARRIERS.length];
    const n = String(slot + 1).padStart(2, "0");
    c.save();
    c.clearRect(ox, oy, W, H);

    if (kind === "film") {
      const band = W * 0.12;
      const g = c.createLinearGradient(ox, oy, ox + W, oy + H);
      g.addColorStop(0, "#1c1317");
      g.addColorStop(0.5, "#0c090b");
      g.addColorStop(1, "#150e19");
      c.fillStyle = g;
      c.fillRect(ox, oy, W, H);
      label(c, `EMU 400  ${n}`, ox + band * 0.5, oy + H * 0.5, W * 0.036, "#f2a93b", -Math.PI / 2);
      label(c, `▸ ${slot + 12}A    DREAM`, ox + W - band * 0.5, oy + H * 0.5, W * 0.036, "#f2a93b", Math.PI / 2);
      c.globalCompositeOperation = "destination-out";
      const hw = W * 0.056;
      const hh = H * 0.034;
      for (let hy = oy + H * 0.03; hy + hh < oy + H * 0.98; hy += H * 0.072) {
        for (const hx of [ox + band * 0.14, ox + W - band * 0.14 - hw]) {
          c.beginPath();
          c.roundRect(hx, hy, hw, hh, hw * 0.22);
          c.fill();
        }
      }
      c.restore();
      return { x: ox + band + W * 0.018, y: oy + H * 0.045, w: W - 2 * band - W * 0.036, h: H * 0.91, r: W * 0.01 };
    }

    if (kind === "polaroid" || kind === "instax") {
      const ratio = kind === "polaroid" ? 0.83 : 0.64;
      const fw = W * (kind === "polaroid" ? 0.94 : 0.8);
      const fh = Math.min(H * 0.96, fw / ratio);
      const frame: Rect = { x: ox + (W - fw) / 2, y: oy + (H - fh) / 2, w: fw, h: fh, r: W * 0.018 };
      const g = c.createLinearGradient(frame.x, frame.y, frame.x + frame.w, frame.y + frame.h);
      g.addColorStop(0, "#fdfbf6");
      g.addColorStop(1, "#ece6dc");
      c.fillStyle = g;
      rr(c, frame);
      c.fill();
      const m = fw * (kind === "polaroid" ? 0.065 : 0.075);
      const pw = fw - 2 * m;
      const ph = kind === "polaroid" ? pw * 1.02 : fh * 0.74;
      label(c, kind === "polaroid" ? `dream no.${n}` : `♡ ${n}`, frame.x + fw / 2, frame.y + m + ph + (fh - m - ph) / 2, W * 0.05, "rgba(60, 52, 90, 0.72)", -0.03, 'italic 500 SIZEpx "Snell Roundhand", "Brush Script MT", cursive');
      c.restore();
      return { x: frame.x + m, y: frame.y + m, w: pw, h: ph, r: W * 0.004 };
    }

    if (kind === "slide") {
      const s = W * 0.96;
      const frame: Rect = { x: ox + (W - s) / 2, y: oy + (H - s) / 2, w: s, h: s, r: W * 0.07 };
      const g = c.createLinearGradient(frame.x, frame.y, frame.x, frame.y + s);
      g.addColorStop(0, "#f4f1ec");
      g.addColorStop(1, "#d9d3ca");
      c.fillStyle = g;
      rr(c, frame);
      c.fill();
      const win: Rect = { x: frame.x + s * 0.13, y: frame.y + s * 0.24, w: s * 0.74, h: s * 0.52, r: W * 0.012 };
      c.strokeStyle = "rgba(0, 0, 0, 0.12)";
      c.lineWidth = W * 0.012;
      rr(c, { ...win, x: win.x - W * 0.012, y: win.y - W * 0.012, w: win.w + W * 0.024, h: win.h + W * 0.024 });
      c.stroke();
      label(c, "EMU · CHROME", frame.x + s / 2, frame.y + s * 0.12, W * 0.05, "rgba(40, 40, 60, 0.62)");
      label(c, `${n}  ◆  35`, frame.x + s / 2, frame.y + s * 0.88, W * 0.042, "rgba(200, 60, 90, 0.7)");
      c.restore();
      return win;
    }

    if (kind === "print") {
      const frame: Rect = { x: ox + W * 0.01, y: oy + H * 0.01, w: W * 0.98, h: H * 0.98, r: W * 0.02 };
      c.fillStyle = "#fbfaf7";
      rr(c, frame);
      c.fill();
      c.restore();
      const b = W * 0.035;
      return { x: frame.x + b, y: frame.y + b, w: frame.w - 2 * b, h: frame.h - 2 * b, r: W * 0.008 };
    }

    /* glass：滿版圓角作品 + 一圈虹彩邊（邊在 drawPhoto 後補畫）。 */
    c.restore();
    return { x: ox + W * 0.02, y: oy + H * 0.015, w: W * 0.96, h: H * 0.97, r: W * 0.06 };
  }

  function drawPhoto(slot: number, img: HTMLImageElement | null) {
    const c = ctx as CanvasRenderingContext2D;
    const p = photos[slot];
    c.save();
    rr(c, p);
    c.clip();
    if (img) {
      const scale = Math.max(p.w / img.naturalWidth, p.h / img.naturalHeight);
      const w = img.naturalWidth * scale;
      const h = img.naturalHeight * scale;
      c.filter = "saturate(1.3) contrast(1.1) brightness(1.04)";
      c.drawImage(img, p.x + (p.w - w) / 2, p.y + (p.h - h) / 2, w, h);
      c.filter = "none";
    } else {
      const [a, b] = PLACEHOLDER_TINTS[slot % PLACEHOLDER_TINTS.length];
      const g = c.createLinearGradient(p.x, p.y, p.x + p.w, p.y + p.h);
      g.addColorStop(0, a);
      g.addColorStop(1, b);
      c.fillStyle = g;
      c.fillRect(p.x, p.y, p.w, p.h);
    }
    c.restore();
    c.save();
    rr(c, p);
    if (CARRIERS[slot % CARRIERS.length] === "glass") {
      const g = c.createLinearGradient(p.x, p.y, p.x + p.w, p.y + p.h);
      g.addColorStop(0, "rgba(255, 190, 235, 0.95)");
      g.addColorStop(0.35, "rgba(255, 255, 255, 0.9)");
      g.addColorStop(0.65, "rgba(150, 225, 255, 0.95)");
      g.addColorStop(1, "rgba(200, 170, 255, 0.95)");
      c.strokeStyle = g;
      c.lineWidth = W * 0.014;
    } else {
      c.strokeStyle = "rgba(255, 255, 255, 0.16)";
      c.lineWidth = Math.max(1, W * 0.004);
    }
    c.stroke();
    c.restore();
  }

  if (ctx) {
    for (let s = 0; s < slots; s += 1) {
      photos[s] = drawCarrier(s);
      drawPhoto(s, null);
    }
  }

  const load = (slot: number, src: string, level: number) => {
    const img = new window.Image();
    img.decoding = "async";
    img.onload = () => {
      if (disposed || !ctx || rank[slot] > level) return;
      rank[slot] = level;
      drawPhoto(slot, img);
      onPaint();
    };
    img.src = src;
    images.push(img);
  };
  for (let s = 0; s < slots; s += 1) load(s, sources[s % sources.length].thumb, 1);
  for (let s = 0; s < slots; s += 1) load(s, sources[s % sources.length].full, 2);

  return {
    canvas,
    slots,
    uv(slot) {
      const col = slot % cols;
      const row = Math.floor(slot / cols);
      return [col / cols, 1 - (row + 1) / rows, 1 / cols, 1 / rows];
    },
    dispose() {
      disposed = true;
      for (const img of images) {
        img.onload = null;
        img.src = "";
      }
      images.length = 0;
      canvas.width = 0;
      canvas.height = 0;
    },
  };
}
