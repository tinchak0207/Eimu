// Canvas 2D 绘制的 Liquid Glass UI 贴花（DESIGN.md：lg-card 半透明白、顶缘高光、Lucide 图示、Geist + 思源黑体）
export const F = {
  sans: '"Geist", "Noto Sans CJK SC", sans-serif',
  cjk: '"Noto Sans CJK SC", "Geist", sans-serif',
  mono: '"GeistMono", "Noto Sans Mono CJK SC", monospace',
  serif: '"Noto Serif SC", serif',
};
export const C = {
  ink: "#1b2030", sub: "#667085", faint: "#98a1b0", line: "rgba(27,32,48,.08)",
  blue: "#2f7bff", pink: "#e8488f", gray: "#7b8694", dark: "#2d3142", green: "#2fb457", greenBg: "rgba(52,199,89,.14)",
};

const ICONS = {
  sparkles: ["M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z", "M20 3v4", "M22 5h-4", "M4 17v2", "M5 18H3"],
  arrowUp: ["m5 12 7-7 7 7", "M12 19V5"],
  file: ["M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z", "M14 2v4a2 2 0 0 0 2 2h4", "M10 9H8", "M16 13H8", "M16 17H8"],
  user: ["M18 20a6 6 0 0 0-12 0", "M16 10a4 4 0 1 1-8 0a4 4 0 1 1 8 0"],
  mountain: ["m8 3 4 8 5-5 5 15H2L8 3z", "M4.14 15.08c2.62-1.57 5.24-1.43 7.86.42 2.74 1.94 5.49 2 8.23.19"],
  image: ["M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z", "M11 9a2 2 0 1 1-4 0a2 2 0 1 1 4 0", "m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"],
  clap: ["M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3Z", "m6.2 5.3 3.1 3.9", "m12.4 3.4 3.1 4", "M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"],
  music: ["M9 18V5l12-2v13", "M9 18a3 3 0 1 1-6 0a3 3 0 1 1 6 0", "M21 16a3 3 0 1 1-6 0a3 3 0 1 1 6 0"],
  film: ["M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z", "M7 3v18", "M3 7.5h4", "M3 12h18", "M3 16.5h4", "M17 3v18", "M17 7.5h4", "M17 16.5h4"],
  check: ["M20 6 9 17l-5-5"],
  box: ["M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z", "m3.3 7 8.7 5 8.7-5", "M12 22V12"],
  palette: ["M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8z", "M14 7.5a.5.5 0 1 1-1 0a.5.5 0 1 1 1 0", "M18 11.5a.5.5 0 1 1-1 0a.5.5 0 1 1 1 0", "M8 7.5a.5.5 0 1 1-1 0a.5.5 0 1 1 1 0", "M7 12.5a.5.5 0 1 1-1 0a.5.5 0 1 1 1 0"],
  layout: ["M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z", "M3 9h18", "M9 21V9"],
};

export function icon(x, name, cx, cy, size, color, sw = 2) {
  x.save(); x.translate(cx - size / 2, cy - size / 2); x.scale(size / 24, size / 24);
  x.strokeStyle = color; x.lineWidth = sw; x.lineCap = "round"; x.lineJoin = "round";
  for (const d of ICONS[name]) x.stroke(new Path2D(d));
  x.restore();
}
function playGlyph(x, cx, cy, s, color) {
  x.save(); x.translate(cx - s / 2 + s * 0.06, cy - s / 2); x.scale(s / 24, s / 24); x.fillStyle = color;
  x.fill(new Path2D("M6 3 20 12 6 21 6 3")); x.restore();
}
export function txt(x, s, px, py, { size, weight = 500, family = F.cjk, color = C.ink, align = "left", base = "alphabetic", ls = 0 } = {}) {
  x.font = `${weight} ${size}px ${family}`; x.fillStyle = color; x.textAlign = align; x.textBaseline = base;
  x.letterSpacing = `${ls}px`; x.fillText(s, px, py); x.letterSpacing = "0px";
  return x.measureText(s).width + ls * [...s].length;
}
function rr(x, px, py, w, h, r) { x.beginPath(); x.roundRect(px, py, w, h, r); }
function pill(x, s, px, py, { size, fg, bg, pad = 0.55, h = 1.9, weight = 600, family = F.cjk, stroke, iconName }) {
  x.font = `${weight} ${size}px ${family}`;
  const tw = x.measureText(s).width;
  const ih = size * h, iw = tw + size * pad * 2 + (iconName ? size * 1.25 : 0);
  rr(x, px, py, iw, ih, ih / 2); x.fillStyle = bg; x.fill();
  if (stroke) { x.strokeStyle = stroke; x.lineWidth = size * 0.08; x.stroke(); }
  let tx = px + size * pad;
  if (iconName) { icon(x, iconName, tx + size * 0.5, py + ih / 2, size * 1.0, fg, 2.6); tx += size * 1.25; }
  txt(x, s, tx, py + ih / 2 + size * 0.36, { size, weight, family, color: fg });
  return iw;
}

// 通用面板：半透明白 + 顶缘亮线 + 底缘暗线（lg-card）
function panel(x, W, H, s) {
  const inset = 0.03 * s, r = 0.1 * s;
  rr(x, inset, inset, W - inset * 2, H - inset * 2, r);
  const g = x.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, "rgba(255,255,255,.80)"); g.addColorStop(1, "rgba(255,255,255,.60)");
  x.fillStyle = g; x.fill();
  x.lineWidth = 0.006 * s; x.strokeStyle = "rgba(255,255,255,.95)"; x.stroke();
  // 底缘暗线
  x.save(); rr(x, inset, inset, W - inset * 2, H - inset * 2, r); x.clip();
  x.fillStyle = "rgba(0,0,0,.035)"; x.fillRect(inset, H - inset - 0.004 * s, W, 0.004 * s); x.restore();
}
function header(x, W, s, { iconName, tint, title, right, rightKind = "mono" }) {
  const cy = 0.135 * s, bx = 0.075 * s, bs = 0.11 * s;
  rr(x, bx, cy - bs / 2, bs, bs, bs * 0.3); x.fillStyle = tint; x.fill();
  icon(x, iconName, bx + bs / 2, cy, bs * 0.62, "#fff", 2.4);
  txt(x, title, bx + bs + 0.045 * s, cy + 0.028 * s, { size: 0.074 * s, weight: 700, color: C.ink });
  if (right) {
    if (rightKind === "mono") txt(x, right, W - 0.08 * s, cy + 0.024 * s, { size: 0.056 * s, weight: 500, family: F.mono, color: C.faint, align: "right" });
    else if (rightKind === "done") {
      x.font = `700 ${0.05 * s}px ${F.cjk}`; const w = x.measureText(right).width + 0.15 * s;
      pill(x, right, W - 0.075 * s - w, cy - 0.047 * s, { size: 0.05 * s, fg: C.green, bg: C.greenBg, iconName: "check", pad: 0.5 });
    } else {
      x.font = `600 ${0.05 * s}px ${F.cjk}`; const w = x.measureText(right).width + 0.055 * s;
      pill(x, right, W - 0.075 * s - w, cy - 0.047 * s, { size: 0.05 * s, fg: C.sub, bg: "rgba(27,32,48,.06)", pad: 0.55 });
    }
  }
}

function makePad(wU, hU, ppu) {
  const c = document.createElement("canvas"); c.width = Math.round(wU * ppu); c.height = Math.round(hU * ppu);
  const x = c.getContext("2d"); return { c, x, W: c.width, H: c.height, s: ppu };
}
// 影像槽：回传 tile 局部座标（单位）供影像平面定位
const slot = (pad, px, py, w, h, r) => ({ x: (px + w / 2) / pad.s - pad.W / pad.s / 2, z: (py + h / 2) / pad.s - pad.H / pad.s / 2, w: w / pad.s, h: h / pad.s, r: r / pad.s });

// ============ 节点 ============
export function drawScript(wU, hU, ppu, d) {
  const p = makePad(wU, hU, ppu), { x, W, H, s } = p;
  panel(x, W, H, s);
  header(x, W, s, { iconName: "file", tint: C.gray, title: "剧本", right: d.idx });
  txt(x, d.title, 0.085 * s, 0.37 * s, { size: 0.082 * s, weight: 700 });
  txt(x, d.meta, 0.085 * s, 0.47 * s, { size: 0.05 * s, weight: 400, color: C.sub });
  x.fillStyle = C.line; x.fillRect(0.085 * s, 0.53 * s, W - 0.17 * s, 0.004 * s);
  d.lines.forEach((l, i) => {
    const y = 0.64 * s + i * 0.118 * s;
    txt(x, String(i + 1).padStart(2, "0"), 0.085 * s, y, { size: 0.046 * s, family: F.mono, color: C.faint });
    txt(x, l[0], 0.19 * s, y, { size: 0.052 * s, weight: 600, color: C.ink });
    txt(x, l[1], 0.19 * s + 0.18 * s, y, { size: 0.048 * s, weight: 400, color: C.sub });
  });
  const y0 = 0.64 * s + d.lines.length * 0.118 * s + 0.02 * s;
  for (let i = 0; i < 3; i++) { rr(x, 0.085 * s, y0 + i * 0.075 * s, (W - 0.17 * s) * [0.92, 0.74, 0.85][i], 0.03 * s, 0.015 * s); x.fillStyle = "rgba(27,32,48,.07)"; x.fill(); }
  return { canvas: p.c, slots: [] };
}

export function drawEntity(wU, hU, ppu, d) {
  const p = makePad(wU, hU, ppu), { x, W, H, s } = p;
  panel(x, W, H, s);
  header(x, W, s, { iconName: d.iconName || "user", tint: C.pink, title: d.head, right: d.kind, rightKind: "tag" });
  const iy = 0.26 * s, isz = H - iy - 0.085 * s;
  const im = slot(p, 0.085 * s, iy, isz, isz, 0.07 * s);
  const tx = 0.085 * s + isz + 0.07 * s;
  txt(x, d.name, tx, iy + 0.13 * s, { size: 0.105 * s, weight: 700 });
  txt(x, d.sub, tx, iy + 0.23 * s, { size: 0.048 * s, weight: 400, color: C.sub });
  let py = iy + 0.3 * s;
  for (const t of d.tags || []) { pill(x, t, tx, py, { size: 0.044 * s, fg: "#b8326f", bg: "rgba(232,72,143,.10)", pad: 0.6 }); py += 0.105 * s; }
  return { canvas: p.c, slots: [im] };
}

export function drawScene(wU, hU, ppu, d) {
  const p = makePad(wU, hU, ppu), { x, W, H, s } = p;
  panel(x, W, H, s);
  header(x, W, s, { iconName: "mountain", tint: C.pink, title: d.head, right: "场景", rightKind: "tag" });
  const iy = 0.25 * s, ih = H - iy - 0.2 * s;
  const im = slot(p, 0.075 * s, iy, W - 0.15 * s, ih, 0.06 * s);
  txt(x, d.name, 0.085 * s, H - 0.085 * s, { size: 0.058 * s, weight: 600 });
  return { canvas: p.c, slots: [im] };
}

export function drawShot(wU, hU, ppu, d) {
  const p = makePad(wU, hU, ppu), { x, W, H, s } = p;
  panel(x, W, H, s);
  header(x, W, s, { iconName: d.video ? "clap" : "image", tint: C.blue, title: d.title, right: d.right, rightKind: d.video ? "mono" : "tag" });
  const iy = 0.245 * s;
  const im = slot(p, 0.065 * s, iy, W - 0.13 * s, H - iy - 0.065 * s, 0.055 * s);
  return { canvas: p.c, slots: [im] };
}

export function drawMusic(wU, hU, ppu, d) {
  const p = makePad(wU, hU, ppu), { x, W, H, s } = p;
  panel(x, W, H, s);
  header(x, W, s, { iconName: "music", tint: C.pink, title: d.title, right: d.right });
  const n = 46, x0 = 0.085 * s, x1 = W - 0.085 * s, cy = 0.44 * s, bw = (x1 - x0) / n;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(Math.sin(i * 0.53) * Math.sin(i * 0.17 + 1.3)) * 0.8 + 0.12 * ((i * 7919) % 13) / 13;
    const h = (0.04 + a * 0.19) * s;
    rr(x, x0 + i * bw + bw * 0.22, cy - h / 2, bw * 0.56, h, bw * 0.28);
    x.fillStyle = i < n * 0.62 ? C.pink : "rgba(232,72,143,.35)"; x.fill();
  }
  txt(x, d.sub, 0.085 * s, H - 0.085 * s, { size: 0.048 * s, weight: 400, color: C.sub });
  return { canvas: p.c, slots: [] };
}

export function drawFinal(wU, hU, ppu, d) {
  const p = makePad(wU, hU, ppu), { x, W, H, s } = p;
  panel(x, W, H, s);
  header(x, W, s, { iconName: "film", tint: C.dark, title: d.title, right: d.done ? "已出片" : d.right, rightKind: d.done ? "done" : "mono" });
  const iy = 0.25 * s;
  const iw = W - 0.13 * s, ih = iw / d.aspect;
  const im = slot(p, 0.065 * s, iy, iw, ih, 0.06 * s);
  txt(x, d.caption, 0.085 * s, iy + ih + 0.1 * s, { size: 0.056 * s, weight: 600 });
  txt(x, d.meta, W - 0.085 * s, iy + ih + 0.1 * s, { size: 0.048 * s, family: F.mono, weight: 500, color: C.faint, align: "right" });
  return { canvas: p.c, slots: [im] };
}

export function drawProject(wU, hU, ppu, d) {
  const p = makePad(wU, hU, ppu), { x, W, H, s } = p;
  panel(x, W, H, s);
  header(x, W, s, { iconName: "layout", tint: C.dark, title: d.head, right: d.right });
  txt(x, d.title, 0.085 * s, 0.4 * s, { size: 0.1 * s, weight: 700 });
  txt(x, d.meta, 0.085 * s, 0.51 * s, { size: 0.05 * s, weight: 400, color: C.sub });
  let px = 0.085 * s, py = 0.6 * s;
  d.steps.forEach((st, i) => {
    x.font = `600 ${0.046 * s}px ${F.cjk}`;
    const w = x.measureText(st).width + 0.1 * s;
    if (px + w > W - 0.08 * s) { px = 0.085 * s; py += 0.11 * s; }
    pill(x, st, px, py, { size: 0.046 * s, fg: i === d.hi ? "#b8326f" : C.sub, bg: i === d.hi ? "rgba(232,72,143,.12)" : "rgba(27,32,48,.055)", pad: 0.55 });
    px += w + 0.03 * s;
  });
  return { canvas: p.c, slots: [] };
}

// 播放键覆盖层（雾面圆 + 三角）
export function drawPlay(sizePx = 256) {
  const c = document.createElement("canvas"); c.width = c.height = sizePx; const x = c.getContext("2d");
  const r = sizePx * 0.46;
  x.beginPath(); x.arc(sizePx / 2, sizePx / 2, r, 0, Math.PI * 2);
  x.fillStyle = "rgba(255,255,255,.26)"; x.fill(); x.lineWidth = sizePx * 0.025; x.strokeStyle = "rgba(255,255,255,.85)"; x.stroke();
  playGlyph(x, sizePx / 2, sizePx / 2, sizePx * 0.42, "#fff");
  return c;
}

// 实体胶囊（对齐 50f7e436：左带微缩图）：@崇祯
export function drawCapsule(img, name, h = 120) {
  const c = document.createElement("canvas"); const x = c.getContext("2d");
  x.font = `700 ${h * 0.42}px ${F.cjk}`; const tw = x.measureText(name).width;
  c.width = Math.ceil(h * 0.12 + h * 0.84 + h * 0.22 + tw + h * 0.34); c.height = h;
  x.font = `700 ${h * 0.42}px ${F.cjk}`;
  rr(x, 1, 1, c.width - 2, h - 2, (h - 2) / 2);
  x.fillStyle = "rgba(255,255,255,.93)"; x.fill(); x.lineWidth = h * 0.03; x.strokeStyle = "rgba(232,72,143,.35)"; x.stroke();
  const ar = h * 0.42, acx = h * 0.08 + ar, acy = h / 2;
  x.save(); x.beginPath(); x.arc(acx, acy, ar, 0, Math.PI * 2); x.clip();
  const sz = Math.min(img.width, img.height);
  x.drawImage(img, (img.width - sz) / 2, (img.height - sz) / 2, sz, sz, acx - ar, acy - ar, ar * 2, ar * 2); x.restore();
  txt(x, name, acx + ar + h * 0.18, h / 2 + h * 0.15, { size: h * 0.42, weight: 700, color: "#c23778" });
  return c;
}
export function drawRawToken(s, h = 120) {
  const c = document.createElement("canvas"); const x = c.getContext("2d");
  x.font = `500 ${h * 0.4}px ${F.mono}`; const tw = x.measureText(s).width;
  c.width = Math.ceil(tw + h * 0.5); c.height = h;
  rr(x, 1, 1, c.width - 2, h - 2, (h - 2) / 2); x.fillStyle = "rgba(255,255,255,.88)"; x.fill();
  x.lineWidth = h * 0.025; x.strokeStyle = "rgba(27,32,48,.12)"; x.stroke();
  txt(x, s, h * 0.25, h / 2 + h * 0.14, { size: h * 0.4, weight: 500, family: F.mono, color: "#6b7385" });
  return c;
}

// 提示输入框（动态重绘：打字 + 游标）
export function makePromptPad(wU, hU, ppu) {
  const p = makePad(wU, hU, ppu);
  p.draw = (text, caretOn, placeholder, phAlpha) => {
    const { x, W, H, s } = p;
    x.clearRect(0, 0, W, H);
    const inset = 0.035 * s;
    rr(x, inset, inset, W - inset * 2, H - inset * 2, (H - inset * 2) / 2);
    const g = x.createLinearGradient(0, 0, 0, H); g.addColorStop(0, "rgba(255,255,255,.82)"); g.addColorStop(1, "rgba(255,255,255,.64)");
    x.fillStyle = g; x.fill(); x.lineWidth = 0.008 * s; x.strokeStyle = "rgba(255,255,255,.95)"; x.stroke();
    const cy = H / 2;
    icon(x, "sparkles", 0.3 * s, cy, 0.2 * s, C.blue, 2.1);
    const fs = 0.19 * s, tx = 0.5 * s;
    if (!text && phAlpha > 0) { x.globalAlpha = phAlpha; txt(x, placeholder, tx, cy + fs * 0.36, { size: fs, weight: 400, color: "#a3abb8" }); x.globalAlpha = 1; }
    const w = text ? txt(x, text, tx, cy + fs * 0.36, { size: fs, weight: 500, color: C.ink }) : 0;
    if (caretOn) { rr(x, tx + w + 0.02 * s, cy - fs * 0.62, 0.014 * s, fs * 1.24, 0.007 * s); x.fillStyle = C.blue; x.fill(); }
  };
  return p;
}

// 发送键顶面（深色圆 + 白箭头）
export function drawSendTop(sizePx = 512) {
  const c = document.createElement("canvas"); c.width = c.height = sizePx; const x = c.getContext("2d");
  icon(x, "arrowUp", sizePx / 2, sizePx / 2, sizePx * 0.46, "#fff", 2.6);
  return c;
}

// 墙面标签
export function drawLabel(title, sub, wU, ppu, dark = false) {
  const p = makePad(wU, 0.34, ppu), { x, W, s } = p;
  txt(x, title, 0.02 * s, 0.14 * s, { size: 0.11 * s, weight: 700, color: dark ? "#fff" : C.ink });
  if (sub) txt(x, sub, 0.02 * s, 0.28 * s, { size: 0.075 * s, weight: 500, family: F.cjk, color: dark ? "rgba(255,255,255,.7)" : C.sub });
  return p.c;
}

// 片名字标（alpha-test 不透明，让玻璃透镜折射得到）
export function drawWordmark(text, hPx = 900) {
  const c = document.createElement("canvas"); const x = c.getContext("2d");
  x.font = `650 ${hPx}px ${F.sans}`; x.letterSpacing = `${-hPx * 0.05}px`;
  const tw = x.measureText(text).width;
  c.width = Math.ceil(tw + hPx * 0.2); c.height = Math.ceil(hPx * 1.25);
  x.font = `650 ${hPx}px ${F.sans}`; x.letterSpacing = `${-hPx * 0.05}px`;
  x.fillStyle = "#161a26"; x.textBaseline = "alphabetic"; x.fillText(text, hPx * 0.1, hPx * 0.98);
  return c;
}

// 软阴影贴图（圆角矩形高斯模糊）
export function drawShadow(wPx, hPx, rPx, blurPx) {
  const pad = blurPx * 2.2;
  const c = document.createElement("canvas"); c.width = Math.ceil(wPx + pad * 2); c.height = Math.ceil(hPx + pad * 2);
  const x = c.getContext("2d"); x.filter = `blur(${blurPx}px)`;
  rr(x, pad, pad, wPx, hPx, rPx); x.fillStyle = "rgba(20,26,45,1)"; x.fill();
  return { canvas: c, pad };
}
