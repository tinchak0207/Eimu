// 纯函数工具：缓动、弹簧、Hermite 相机轨道。所有动画都由时间 t 决定，任意帧可独立重算。
export const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
export const lerp = (a, b, p) => a + (b - a) * p;
export const P = (t, a, b) => clamp((t - a) / (b - a));
export const smooth = (a, b, x) => { const u = clamp((x - a) / (b - a)); return u * u * (3 - 2 * u); };

export function cubicBezier(x1, y1, x2, y2) {
  const bz = (u, a, b) => 3 * a * u * (1 - u) ** 2 + 3 * b * u * u * (1 - u) + u ** 3;
  const dz = (u, a, b) => 3 * a * (1 - u) ** 2 + 6 * (b - a) * u * (1 - u) + 3 * (1 - b) * u * u;
  return p => {
    if (p <= 0) return 0; if (p >= 1) return 1;
    let u = p;
    for (let i = 0; i < 12; i++) { const d = dz(u, x1, x2); if (Math.abs(d) < 1e-7) break; u = clamp(u - (bz(u, x1, x2) - p) / d); }
    return bz(u, y1, y2);
  };
}
export const ease = {
  inOut: cubicBezier(0.65, 0, 0.35, 1),      // 相机推拉
  inOutSoft: cubicBezier(0.45, 0, 0.25, 1),
  out: cubicBezier(0.16, 1, 0.3, 1),         // 文字/物件落定
  outQuint: cubicBezier(0.22, 1, 0.36, 1),
  in: cubicBezier(0.55, 0, 1, 0.45),
  inCubic: cubicBezier(0.32, 0, 0.67, 0),
  ios: cubicBezier(0.4, 0, 0.2, 1),          // DESIGN.md ease
};

// 阻尼弹簧（仅用于 UI 按压等小互动）
export function spring(t, t0, k = 170, c = 19) {
  const x = t - t0; if (x <= 0) return 0;
  const w = Math.sqrt(k), z = c / (2 * w);
  if (z < 1) { const wd = w * Math.sqrt(1 - z * z); return 1 - Math.exp(-z * w * x) * (Math.cos(wd * x) + (z * w / wd) * Math.sin(wd * x)); }
  return 1 - Math.exp(-w * x) * (1 + w * x);
}

export const hash = i => { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };

// 低频手持感：不可公度频率的正弦和，确定性
export function wobble(t, seed = 0) {
  return Math.sin(t * 0.71 + seed * 3.1) * 0.5 + Math.sin(t * 1.37 + seed * 1.7) * 0.3 + Math.sin(t * 2.13 + seed * 5.3) * 0.2;
}

// Hermite 轨道：keys = [{t, v:[...], stop?:bool}]；Catmull-Rom 切线（按时间间隔），stop 关键帧切线为 0（缓停）
export class Track {
  constructor(keys) {
    this.k = keys.slice().sort((a, b) => a.t - b.t);
    const n = this.k.length;
    this.m = this.k.map((key, i) => {
      if (key.stop || i === 0 || i === n - 1) return key.v.map(() => 0);
      const a = this.k[i - 1], b = this.k[i + 1];
      return key.v.map((_, j) => (b.v[j] - a.v[j]) / (b.t - a.t));
    });
  }
  at(t) {
    const k = this.k, n = k.length;
    if (t <= k[0].t) return k[0].v.slice();
    if (t >= k[n - 1].t) return k[n - 1].v.slice();
    let i = 0; while (i < n - 2 && t >= k[i + 1].t) i++;
    const a = k[i], b = k[i + 1], h = b.t - a.t, u = (t - a.t) / h;
    const u2 = u * u, u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
    return a.v.map((_, j) => h00 * a.v[j] + h10 * h * this.m[i][j] + h01 * b.v[j] + h11 * h * this.m[i + 1][j]);
  }
}

// 由 pos/look 求 yaw/pitch（three 相机预设看 -z；YXZ 欧拉）
export function yawPitch(pos, look) {
  const dx = look[0] - pos[0], dy = look[1] - pos[1], dz = look[2] - pos[2];
  const yaw = Math.atan2(-dx, -dz);
  const pitch = Math.atan2(dy, Math.hypot(dx, dz));
  return [yaw, pitch];
}
export const deg = d => (d * Math.PI) / 180;
