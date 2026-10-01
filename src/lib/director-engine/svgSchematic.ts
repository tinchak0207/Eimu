/**
 * svgSchematic —— 新膠水，非輪子。
 * 輪子錨：投影數學逐行取自 vendor src/lib/director/shotDescription.ts（NDC pinhole 投影：
 * camDir/right/camUp 基、zDepth、深度三分類前景/中景/背景）；俯視圖運動路徑取 vendor
 * src/lib/director/pathCurve.ts 的 sampleMotionPath。本檔只負責把這些純數學輸出畫成 SVG 字串。
 * 美學：白模線框——深底（#0b0f14 系）白線、等寬字標注、無漸變無動畫。輸出 ≤32KB。
 */
import type {
  DirectorElement,
  DirectorPlan,
  DirectorSequenceShot,
  Vec3,
} from './types';
import { planDuration } from './playback';
import { sampleMotionPath } from './pathCurve';
import { describeShot } from './shotDescription';
import type { ElementSnapshotForDesc } from './types';

const BG = '#0b0f14';
const GRID = '#1a222c';
const LINE = '#e8edf2';
const DIM = '#8b98a5';
const FG_COLOR = '#ff6b6b'; // 前景
const MG_COLOR = '#ffd166'; // 中景
const BG_COLOR = '#4d96ff'; // 背景
const FONT = 'ui-monospace, SFMono-Regular, Menlo, monospace';

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmt(n: number): string {
  return Number(n.toFixed(2)).toString();
}

function svgWrap(width: number, height: number, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="${FONT}">${body}</svg>`;
}

/** 元素俯視佔地半徑（米）——粗略線框尺度，僅示意用。 */
function elementFootprint(el: DirectorElement): { w: number; h: number } {
  if (el.kind === 'mannequin') return { w: 0.5, h: 0.5 };
  if (el.kind === 'wall') return { w: Math.max(0.2, el.scale.x), h: Math.max(0.2, el.scale.z) };
  if (el.kind === 'crowd') return { w: el.cols * el.spacing, h: el.rows * el.spacing };
  return { w: Math.max(0.2, el.scale.x), h: Math.max(0.2, el.scale.z) };
}

function elementShape(el: DirectorElement): 'circle' | 'rect' {
  return el.kind === 'mannequin' || el.kind === 'sphere' || el.kind === 'cylinder' ? 'circle' : 'rect';
}

/** 俯視圖：元素位置框 + sampleMotionPath 運動路徑 + 攝影機位置與視野扇形。 */
export function renderTopViewSvg(plan: DirectorPlan, elements: DirectorElement[], shot?: DirectorSequenceShot): string {
  const W = 480;
  const H = 360;
  const MARGIN = 36;
  const active = shot ?? plan.shots[0];

  // 世界包圍盒（元素 + 動作終點 + 攝影機），含 1m padding
  const xs: number[] = [];
  const zs: number[] = [];
  for (const el of elements) {
    xs.push(el.position.x, el.position.x + el.scale.x);
    zs.push(el.position.z, el.position.z + el.scale.z);
  }
  for (const s of plan.shots) {
    for (const a of s.actions) {
      xs.push(a.from.x, a.to.x);
      zs.push(a.from.z, a.to.z);
    }
    xs.push(s.position.x, s.target.x);
    zs.push(s.position.z, s.target.z);
  }
  if (!xs.length) { xs.push(-5, 5); zs.push(-5, 5); }
  const pad = 1;
  const minX = Math.min(...xs) - pad;
  const maxX = Math.max(...xs) + pad;
  const minZ = Math.min(...zs) - pad;
  const maxZ = Math.max(...zs) + pad;
  const scale = Math.min((W - MARGIN * 2) / Math.max(0.5, maxX - minX), (H - MARGIN * 2) / Math.max(0.5, maxZ - minZ));
  const px = (x: number) => MARGIN + (x - minX) * scale;
  const pz = (z: number) => MARGIN + (z - minZ) * scale;

  const body: string[] = [];
  body.push(`<rect width="${W}" height="${H}" fill="${BG}"/>`);
  // 網格（世界 1m 間距，示意）
  for (let gx = Math.ceil(minX); gx <= Math.floor(maxX); gx += 1) {
    body.push(`<line x1="${fmt(px(gx))}" y1="${MARGIN}" x2="${fmt(px(gx))}" y2="${H - MARGIN}" stroke="${GRID}" stroke-width="1"/>`);
  }
  for (let gz = Math.ceil(minZ); gz <= Math.floor(maxZ); gz += 1) {
    body.push(`<line x1="${MARGIN}" y1="${fmt(pz(gz))}" x2="${W - MARGIN}" y2="${fmt(pz(gz))}" stroke="${GRID}" stroke-width="1"/>`);
  }

  // 運動路徑（sampleMotionPath 輪子錨：pathCurve.ts）
  for (const el of elements) {
    const clips = plan.shots.flatMap((s) => s.actions.filter((a) => a.elementId === el.id && a.keyframes && a.keyframes.some((k) => k.position)));
    for (const clip of clips) {
      const points = sampleMotionPath(clip.keyframes ?? [], clip.from);
      const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${fmt(px(p.position.x))},${fmt(pz(p.position.z))}`).join(' ');
      body.push(`<path d="${d}" fill="none" stroke="${DIM}" stroke-width="1.5" stroke-dasharray="4 3"/>`);
    }
    // 動作直線路徑（from → to）
    for (const s of plan.shots) {
      for (const a of s.actions) {
        if (a.elementId !== el.id) continue;
        if (Math.abs(a.from.x - a.to.x) < 0.01 && Math.abs(a.from.z - a.to.z) < 0.01) continue;
        body.push(`<line x1="${fmt(px(a.from.x))}" y1="${fmt(pz(a.from.z))}" x2="${fmt(px(a.to.x))}" y2="${fmt(pz(a.to.z))}" stroke="${DIM}" stroke-width="1" stroke-dasharray="3 3"/>`);
      }
    }
  }

  // 元素框（按類型區分：mannequin/sphere/cylinder=圓，box/wall/billboard/crowd=矩形）
  for (const el of elements) {
    const fp = elementFootprint(el);
    const cx = px(el.position.x);
    const cy = pz(el.position.z);
    const stroke = el.kind === 'mannequin' ? LINE : DIM;
    if (elementShape(el) === 'circle') {
      const r = Math.max(3, (fp.w / 2) * scale);
      body.push(`<circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(r)}" fill="none" stroke="${stroke}" stroke-width="1.5"/>`);
    } else {
      const w = Math.max(4, fp.w * scale);
      const h = Math.max(4, fp.h * scale);
      body.push(`<rect x="${fmt(cx - w / 2)}" y="${fmt(cy - h / 2)}" width="${fmt(w)}" height="${fmt(h)}" fill="none" stroke="${stroke}" stroke-width="1.5"/>`);
    }
    body.push(`<text x="${fmt(cx + 6)}" y="${fmt(cy - 6)}" font-size="9" fill="${DIM}">${esc(el.name)}</text>`);
  }

  // 攝影機位置與視野扇形（活動鏡頭；無活動鏡頭則全部鏡頭起點）
  const cameras = active ? [active] : plan.shots;
  for (const s of cameras) {
    const cx = px(s.position.x);
    const cy = pz(s.position.z);
    const tx = px(s.target.x);
    const ty = pz(s.target.z);
    const halfFov = (s.fov / 2) * (Math.PI / 180);
    const reach = 0.35 * Math.min(W, H); // 扇形半徑（像素）
    const yaw = Math.atan2(ty - cy, tx - cx);
    const a1 = yaw - halfFov;
    const a2 = yaw + halfFov;
    const x1 = cx + Math.cos(a1) * reach;
    const y1 = cy + Math.sin(a1) * reach;
    const x2 = cx + Math.cos(a2) * reach;
    const y2 = cy + Math.sin(a2) * reach;
    const arc = halfFov * 2 > Math.PI ? 1 : 0;
    body.push(`<path d="M${fmt(cx)},${fmt(cy)} L${fmt(x1)},${fmt(y1)} A${fmt(reach)},${fmt(reach)} 0 ${arc} 1 ${fmt(x2)},${fmt(y2)} Z" fill="rgba(232,237,242,0.06)" stroke="none"/>`);
    body.push(`<line x1="${fmt(cx)}" y1="${fmt(cy)}" x2="${fmt(tx)}" y2="${fmt(ty)}" stroke="${LINE}" stroke-width="1"/>`);
    body.push(`<circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="4" fill="${BG}" stroke="${LINE}" stroke-width="1.5"/>`);
    body.push(`<text x="${fmt(cx + 7)}" y="${fmt(cy + 12)}" font-size="9" fill="${LINE}">${esc(s.name)}</text>`);
  }

  // 標題欄
  const dur = planDuration(plan);
  body.push(`<text x="10" y="16" font-size="10" fill="${LINE}">${esc(plan.name)} · ${plan.shots.length} 鏡 · ${fmt(dur)}s</text>`);

  return svgWrap(W, H, body.join(''));
}

/** 鏡頭框圖：shotDescription.ts 投影數學逐行取用——NDC 投影 + 深度三分類 + 畫家算法 zDepth 降冪。 */
export function renderCameraViewSvg(shot: DirectorSequenceShot, elements: DirectorElement[]): string {
  const W = 480;
  const H = 270;
  const body: string[] = [];

  // ── 輪子錨：vendor shotDescription.ts 的投影數學（逐行取用） ──
  function sub(a: Vec3, b: Vec3): Vec3 { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
  function len(v: Vec3): number { return Math.hypot(v.x, v.y, v.z); }
  function norm(v: Vec3): Vec3 { const l = len(v) || 1; return { x: v.x / l, y: v.y / l, z: v.z / l }; }
  function dot(a: Vec3, b: Vec3): number { return a.x * b.x + a.y * b.y + a.z * b.z; }
  function cross(a: Vec3, b: Vec3): Vec3 {
    return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
  }

  const camDir = norm(sub(shot.target, shot.position));
  const up = { x: 0, y: 1, z: 0 };
  const right = norm(cross(camDir, up));
  const camUp = cross(right, camDir);
  const tanHalf = Math.tan((shot.fov / 2) * Math.PI / 180);
  const aspectRatio = shot.aspect === '9:16' ? 9 / 16 : shot.aspect === '4:3' ? 4 / 3 : shot.aspect === '1:1' ? 1 : 16 / 9;

  const visible = elements.filter((e) => e.visible);
  const projected = visible.map((e) => {
    const worldPos = shot.elementStates[e.id]?.position ?? e.position;
    const rel = sub(worldPos, shot.position);
    const zDepth = dot(rel, camDir);
    if (zDepth <= 0.05) return { e, off: true, ndcX: 0, ndcY: 0, depth: Infinity, behind: true };
    const ndcX = dot(rel, right) / (zDepth * tanHalf * aspectRatio);
    const ndcY = dot(rel, camUp) / (zDepth * tanHalf);
    return { e, off: Math.abs(ndcX) > 1.15 || Math.abs(ndcY) > 1.15, ndcX, ndcY, depth: zDepth, behind: false };
  });

  const inFrame = projected.filter((p) => !p.off);
  const depths = inFrame.map((p) => p.depth).sort((a, b) => a - b);
  const t1 = depths[Math.floor(depths.length / 3)] ?? Infinity;
  const t2 = depths[Math.floor((depths.length * 2) / 3)] ?? Infinity;
  // ── 輪子錨結束 ──

  body.push(`<rect width="${W}" height="${H}" fill="${BG}"/>`);
  // 畫框安全區（NDC ±1 → 畫布，留 16px 邊）
  const frameL = 16;
  const frameT = 16;
  const frameW = W - frameL * 2;
  const frameH = H - frameT * 2;
  body.push(`<rect x="${frameL}" y="${frameT}" width="${frameW}" height="${frameH}" fill="none" stroke="${GRID}" stroke-width="1"/>`);
  // 三分線（九宮格）
  for (let i = 1; i <= 2; i += 1) {
    body.push(`<line x1="${fmt(frameL + (frameW * i) / 3)}" y1="${frameT}" x2="${fmt(frameL + (frameW * i) / 3)}" y2="${frameT + frameH}" stroke="${GRID}" stroke-width="1"/>`);
    body.push(`<line x1="${frameL}" y1="${fmt(frameT + (frameH * i) / 3)}" x2="${frameL + frameW}" y2="${fmt(frameT + (frameH * i) / 3)}" stroke="${GRID}" stroke-width="1"/>`);
  }

  // 畫家算法：zDepth 降冪（遠→近）繪製
  const painterOrder = [...inFrame].sort((a, b) => b.depth - a.depth);
  for (const p of painterOrder) {
    const color = p.depth <= t1 ? FG_COLOR : p.depth <= t2 ? MG_COLOR : BG_COLOR;
    const depthLabel = p.depth <= t1 ? '前景' : p.depth <= t2 ? '中景' : '背景';
    const cx = frameL + (p.ndcX * 0.5 + 0.5) * frameW;
    const cy = frameT + (0.5 - p.ndcY * 0.5) * frameH;
    // 示意尺寸：越近越大（zDepth 反比，鉗制）
    const size = Math.max(8, Math.min(60, 260 / Math.max(1, p.depth)));
    const shape = elementShape(p.e);
    if (shape === 'circle') {
      body.push(`<circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(size / 2)}" fill="none" stroke="${color}" stroke-width="1.5"/>`);
    } else {
      body.push(`<rect x="${fmt(cx - size / 2)}" y="${fmt(cy - size / 2)}" width="${fmt(size)}" height="${fmt(size)}" fill="none" stroke="${color}" stroke-width="1.5"/>`);
    }
    body.push(`<text x="${fmt(cx + size / 2 + 3)}" y="${fmt(cy + 3)}" font-size="9" fill="${color}">${esc(p.e.name)}·${depthLabel}</text>`);
  }

  // 畫外元素（含攝影機身後）
  const offNames = projected.filter((p) => p.off).map((p) => `${p.e.name}${p.behind ? '(鏡後)' : ''}`);
  if (offNames.length > 0) {
    body.push(`<text x="${frameL}" y="${H - 22}" font-size="9" fill="${DIM}">畫外：${esc(offNames.join('、'))}</text>`);
  }
  // 標題欄（畫框描述文字取輪子 describeShot 輸出，逐行原樣）
  const descSnapshots: ElementSnapshotForDesc[] = elements.map((e) => {
    const state = shot.elementStates[e.id];
    const worldPos = state?.position ?? e.position;
    const yawDeg = state?.rotationDeg.y ?? e.rotationDeg.y;
    const yawRad = (yawDeg * Math.PI) / 180;
    return {
      id: e.id,
      name: e.name,
      kind: e.kind,
      worldPos,
      forwardDir: { x: Math.sin(yawRad), y: 0, z: Math.cos(yawRad) },
      visible: state?.visible ?? e.visible,
    };
  });
  const description = describeShot(shot, descSnapshots);
  body.push(`<text x="10" y="12" font-size="10" fill="${LINE}">${esc(description.split('\n')[0] ?? '')}</text>`);

  return svgWrap(W, H, body.join(''));
}
