/* ╁━ /pricing 3D 家具場景（程序化幾何 + 程序化木紋；不下載任何模型資產）╁━
   四個世界各一套：家具、牆/窗/天光、主光與補光、機位、卡堆落點。
   只在 engine.ts（動態 import 之後）被載入，所以這裡可以直接 import three。 */

import * as THREE from "three";
import type { WorldId } from "./worlds";

/** 作品卡尺寸（世界單位）：寬 1、深 1.32（≈3:4 竪幅）、厚 0.034（玻璃厚度感）。 */
export const CARD_W = 1;
export const CARD_D = 1.32;
export const CARD_T = 0.034;

export interface PileSpec {
  x: number;
  z: number;
  yaw: number;
  /** 分卡權重：權重高的堆長得快（塔高錯落，而不是一排等高柱）。 */
  weight: number;
  /** 堆底離桌面的高度（放在墊台上的塔）。 */
  baseY?: number;
  /** 堆底攤開成扇形的張數（讓更多張作品露臉）。 */
  fan?: number;
}

export interface WorldRig {
  id: WorldId;
  group: THREE.Group;
  camera: { pos: THREE.Vector3; target: THREE.Vector3; fov: number };
  /** 卡堆落點所在的桌面高度。 */
  surfaceY: number;
  piles: PileSpec[];
  /** 卡被撥散後允許滑到的半徑（超出就被摩擦攔住）。 */
  scatterRadius: number;
  exposure: number;
  envIntensity: number;
  fog: THREE.Fog | null;
  /** 玻璃邊緣高光的顏色（跟著主光色走）。 */
  rim: THREE.Color;
  shadowLights: THREE.Light[];
  dispose(): void;
}

interface Tracker {
  geo<T extends THREE.BufferGeometry>(g: T): T;
  mat<T extends THREE.Material>(m: T): T;
  tex<T extends THREE.Texture>(t: T): T;
  dispose(): void;
}

function tracker(): Tracker {
  const items: Array<{ dispose(): void }> = [];
  return {
    geo: (g) => (items.push(g), g),
    mat: (m) => (items.push(m), m),
    tex: (t) => (items.push(t), t),
    dispose: () => {
      for (const item of items) item.dispose();
      items.length = 0;
    },
  };
}

/* ── 程序化噪聲（可平鋪：座標按週期取模）── */
function makeNoise(seed: number) {
  const SIZE = 64;
  const table = new Float32Array(SIZE * SIZE);
  let s = seed * 9301 + 49297;
  for (let i = 0; i < table.length; i += 1) {
    s = (s * 9301 + 49297) % 233280;
    table[i] = s / 233280;
  }
  const at = (x: number, y: number) => table[(((y % SIZE) + SIZE) % SIZE) * SIZE + (((x % SIZE) + SIZE) % SIZE)];
  /** 週期 px/py（整數格）內可平鋪的值噪聲。 */
  const noise = (x: number, y: number, px: number, py: number) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    const x0 = ((xi % px) + px) % px;
    const y0 = ((yi % py) + py) % py;
    const x1 = (x0 + 1) % px;
    const y1 = (y0 + 1) % py;
    const a = at(x0, y0);
    const b = at(x1, y0);
    const c = at(x0, y1);
    const d = at(x1, y1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
  return (u: number, v: number, fx: number, fy: number) => {
    let sum = 0;
    let amp = 0.5;
    let norm = 0;
    for (let o = 0; o < 3; o += 1) {
      const m = 1 << o;
      sum += noise(u * fx * m, v * fy * m, fx * m, fy * m) * amp;
      norm += amp;
      amp *= 0.5;
    }
    return sum / norm;
  };
}

type RGB = [number, number, number];

/** 程序化木紋：年輪（正弦條紋被低頻噪聲扭曲）+ 細纖維條 + 可選木板接縫。 */
function woodTexture(t: Tracker, size: number, light: RGB, dark: RGB, opts: { rings?: number; seed?: number; planks?: number; repeat?: number } = {}) {
  const { rings = 9, seed = 1, planks = 0, repeat = 1 } = opts;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const img = ctx.createImageData(size, size);
  const fbm = makeNoise(seed);
  const plankOffset = (row: number) => ((row * 0.618 + seed * 0.37) % 1) * 0.9;
  for (let y = 0; y < size; y += 1) {
    const v = y / size;
    const row = planks > 0 ? Math.floor(v * planks) : 0;
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const pu = planks > 0 ? (u + plankOffset(row)) % 1 : u;
      const warp = fbm(pu, v, 3, 8) * 1.6 + fbm(pu, v, 1, 2) * 0.9;
      const ring = 0.5 + 0.5 * Math.sin((v * rings + warp + row * 0.37) * Math.PI * 2);
      const fiber = fbm(pu, v, 2, 96);
      let k = Math.pow(ring, 2.6) * 0.62 + fiber * 0.32;
      if (planks > 0) {
        const edge = Math.abs((v * planks) % 1 - 0.5) * 2;
        if (edge > 0.965) k = Math.min(1, k + 0.55);
        const tone = ((row * 0.7131 + seed) % 1) * 0.16 - 0.08;
        k = Math.min(1, Math.max(0, k + tone));
      }
      const i = (y * size + x) * 4;
      img.data[i] = light[0] + (dark[0] - light[0]) * k;
      img.data[i + 1] = light[1] + (dark[1] - light[1]) * k;
      img.data[i + 2] = light[2] + (dark[2] - light[2]) * k;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = t.tex(new THREE.CanvasTexture(canvas));
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.anisotropy = 4;
  return tex;
}

/** 窗外天光：竪向漸層 + 可選星點 / 彩虹弧。 */
function skyTexture(t: Tracker, stops: Array<[number, string]>, extra?: "stars" | "rainbow") {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  for (const [at, color] of stops) g.addColorStop(at, color);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  if (extra === "stars") {
    for (let i = 0; i < 70; i += 1) {
      const a = 0.25 + Math.random() * 0.6;
      ctx.fillStyle = `rgba(255,255,255,${a.toFixed(2)})`;
      const r = Math.random() < 0.12 ? 1.4 : 0.8;
      ctx.beginPath();
      ctx.arc(Math.random() * 256, Math.random() * 170, r, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (extra === "rainbow") {
    const colors = ["#ff6b6b", "#ffb86b", "#ffe66b", "#8fe38f", "#6bb8ff", "#9b8cff"];
    ctx.lineWidth = 5;
    colors.forEach((color, i) => {
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.34;
      ctx.beginPath();
      ctx.arc(150, 250, 170 - i * 5, Math.PI * 1.08, Math.PI * 1.92);
      ctx.stroke();
    });
    ctx.globalAlpha = 1;
  }
  const tex = t.tex(new THREE.CanvasTexture(canvas));
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function box(t: Tracker, w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number, opts: { cast?: boolean; receive?: boolean; ry?: number; rz?: number } = {}) {
  const mesh = new THREE.Mesh(t.geo(new THREE.BoxGeometry(w, h, d)), mat);
  mesh.position.set(x, y, z);
  if (opts.ry) mesh.rotation.y = opts.ry;
  if (opts.rz) mesh.rotation.z = opts.rz;
  mesh.castShadow = opts.cast ?? true;
  mesh.receiveShadow = opts.receive ?? true;
  return mesh;
}

function std(t: Tracker, params: THREE.MeshStandardMaterialParameters) {
  return t.mat(new THREE.MeshStandardMaterial(params));
}

function lacquer(t: Tracker, map: THREE.Texture | null, fallback: number, roughness: number, clearcoat = 0.35) {
  return t.mat(
    new THREE.MeshPhysicalMaterial({
      map: map ?? undefined,
      color: map ? 0xffffff : fallback,
      roughness,
      clearcoat,
      clearcoatRoughness: 0.35,
    }),
  );
}

/** 開了一扇窗的牆：四塊牆板圍住洞口 + 白色窗框與十字窗櫺 + 窗外天光面。 */
function windowWall(
  t: Tracker,
  group: THREE.Group,
  o: { z: number; hole: [number, number, number, number]; wallMat: THREE.Material; frameMat: THREE.Material; sky: THREE.Texture | null; skyColor: number; span?: number },
) {
  const [x0, x1, y0, y1] = o.hole;
  const span = o.span ?? 14;
  const thick = 0.2;
  const leftW = span / 2 + x0;
  const rightW = span / 2 - x1;
  group.add(box(t, leftW, 10, thick, o.wallMat, x0 - leftW / 2, 2, o.z, { cast: false }));
  group.add(box(t, rightW, 10, thick, o.wallMat, x1 + rightW / 2, 2, o.z, { cast: false }));
  group.add(box(t, x1 - x0, 7 - y1, thick, o.wallMat, (x0 + x1) / 2, y1 + (7 - y1) / 2, o.z, { cast: false }));
  group.add(box(t, x1 - x0, y0 + 3, thick, o.wallMat, (x0 + x1) / 2, y0 - (y0 + 3) / 2, o.z, { cast: false }));
  const f = 0.07;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const z = o.z + 0.02;
  group.add(box(t, x1 - x0, f, 0.14, o.frameMat, cx, y0 + f / 2, z));
  group.add(box(t, x1 - x0, f, 0.14, o.frameMat, cx, y1 - f / 2, z));
  group.add(box(t, f, y1 - y0, 0.14, o.frameMat, x0 + f / 2, cy, z));
  group.add(box(t, f, y1 - y0, 0.14, o.frameMat, x1 - f / 2, cy, z));
  group.add(box(t, f * 0.7, y1 - y0, 0.1, o.frameMat, cx, cy, z));
  group.add(box(t, x1 - x0, f * 0.7, 0.1, o.frameMat, cx, cy + (y1 - y0) * 0.08, z));
  const sky = new THREE.Mesh(
    t.geo(new THREE.PlaneGeometry((x1 - x0) * 2.4, (y1 - y0) * 2.4)),
    t.mat(new THREE.MeshBasicMaterial({ map: o.sky ?? undefined, color: o.sky ? 0xffffff : o.skyColor, fog: false })),
  );
  sky.position.set(cx, cy, o.z - 2.4);
  group.add(sky);
}

function directional(color: number, intensity: number, pos: [number, number, number], target: [number, number, number], shadow: { size: number; span: number; far?: number } | null) {
  const light = new THREE.DirectionalLight(color, intensity);
  light.position.set(...pos);
  light.target.position.set(...target);
  if (shadow) {
    light.castShadow = true;
    light.shadow.mapSize.set(shadow.size, shadow.size);
    const cam = light.shadow.camera;
    cam.left = -shadow.span;
    cam.right = shadow.span;
    cam.top = shadow.span;
    cam.bottom = -shadow.span;
    cam.near = 0.5;
    cam.far = shadow.far ?? 20;
    light.shadow.bias = -0.0004;
    light.shadow.normalBias = 0.02;
    light.shadow.radius = 3;
  }
  return light;
}

export interface BuildOptions {
  compact: boolean;
  shadows: boolean;
}

/* ── 梦芽：小木托盤 + 晨光窗台 ── */
function buildStarter(o: BuildOptions): WorldRig {
  const t = tracker();
  const g = new THREE.Group();
  const texSize = o.compact ? 256 : 512;
  const oak = woodTexture(t, texSize, [226, 196, 152], [168, 124, 78], { rings: 7, seed: 3 });
  const trayWood = woodTexture(t, texSize, [196, 150, 100], [122, 82, 48], { rings: 11, seed: 7 });

  g.add(box(t, 4.6, 0.16, 2.0, lacquer(t, oak, 0xd8b98c, 0.5), 0, -0.08, 0.15, { cast: false }));
  const wallMat = std(t, { color: 0xefe3cf, roughness: 0.92 });
  const frameMat = std(t, { color: 0xfbf7f0, roughness: 0.55 });
  windowWall(t, g, {
    z: -0.95,
    hole: [-1.45, 1.45, 0.02, 2.7],
    wallMat,
    frameMat,
    sky: skyTexture(t, [[0, "#b9d3ee"], [0.55, "#f6e2c6"], [1, "#ffd3a1"]]),
    skyColor: 0xf6e2c6,
  });

  const trayMat = lacquer(t, trayWood, 0xb88a5a, 0.42, 0.5);
  const TW = 2.2;
  const TD = 2.5;
  g.add(box(t, TW, 0.05, TD, trayMat, 0, 0.025, 0.12));
  g.add(box(t, TW, 0.11, 0.07, trayMat, 0, 0.055, 0.12 - TD / 2));
  g.add(box(t, TW, 0.11, 0.07, trayMat, 0, 0.055, 0.12 + TD / 2));
  g.add(box(t, 0.07, 0.11, TD, trayMat, -TW / 2, 0.055, 0.12));
  g.add(box(t, 0.07, 0.11, TD, trayMat, TW / 2, 0.055, 0.12));

  const pot = new THREE.Mesh(t.geo(new THREE.CylinderGeometry(0.22, 0.16, 0.36, 28)), std(t, { color: 0xc4744f, roughness: 0.85 }));
  pot.position.set(1.72, 0.18, -0.45);
  pot.castShadow = true;
  pot.receiveShadow = true;
  g.add(pot);
  const soil = new THREE.Mesh(t.geo(new THREE.CylinderGeometry(0.2, 0.2, 0.02, 24)), std(t, { color: 0x4a3526, roughness: 1 }));
  soil.position.set(1.72, 0.35, -0.45);
  g.add(soil);
  const leafMat = std(t, { color: 0x7fb069, roughness: 0.6 });
  const stem = new THREE.Mesh(t.geo(new THREE.CylinderGeometry(0.012, 0.014, 0.22, 6)), leafMat);
  stem.position.set(1.72, 0.46, -0.45);
  g.add(stem);
  for (const side of [-1, 1]) {
    const leaf = new THREE.Mesh(t.geo(new THREE.SphereGeometry(0.1, 12, 8)), leafMat);
    leaf.scale.set(1, 0.18, 0.55);
    leaf.position.set(1.72 + side * 0.09, 0.57, -0.45);
    leaf.rotation.z = side * 0.5;
    leaf.castShadow = true;
    g.add(leaf);
  }

  const sun = directional(0xffd29a, 3.4, [-2.8, 3.1, -5.2], [0.3, 0, 0.4], o.shadows ? { size: o.compact ? 512 : 1024, span: 3 } : null);
  g.add(sun, sun.target);
  g.add(new THREE.HemisphereLight(0xdce8ff, 0xb89b72, 0.6));

  return {
    id: "starter",
    group: g,
    camera: { pos: new THREE.Vector3(0.55, 2.4, 3.2), target: new THREE.Vector3(0.05, 0.28, 0.1), fov: 34 },
    surfaceY: 0.05,
    piles: [{ x: -0.05, z: 0.12, yaw: 0.08, weight: 1, fan: 2 }],
    scatterRadius: 0.75,
    exposure: 1.0,
    envIntensity: 0.45,
    fog: null,
    rim: new THREE.Color(0xfff0d8),
    shadowLights: [sun],
    dispose: t.dispose,
  };
}

/* ── 梦影：寫字桌 + 夜燈 ── */
function buildPopular(o: BuildOptions): WorldRig {
  const t = tracker();
  const g = new THREE.Group();
  const texSize = o.compact ? 256 : 512;
  const walnut = woodTexture(t, texSize, [118, 78, 52], [52, 32, 22], { rings: 12, seed: 11 });

  g.add(box(t, 5.4, 0.12, 2.8, lacquer(t, walnut, 0x6b4a33, 0.38, 0.55), 0, -0.06, 0.1, { cast: false }));
  const wall = new THREE.Mesh(t.geo(new THREE.PlaneGeometry(16, 9)), std(t, { color: 0x1c2231, roughness: 0.95 }));
  wall.position.set(0, 2.5, -1.35);
  wall.receiveShadow = true;
  g.add(wall);
  const night = new THREE.Mesh(
    t.geo(new THREE.PlaneGeometry(1.4, 1.8)),
    t.mat(new THREE.MeshBasicMaterial({ map: skyTexture(t, [[0, "#0b1224"], [0.7, "#1d2a4a"], [1, "#34406a"]], "stars") ?? undefined, fog: false })),
  );
  night.position.set(-2.3, 1.75, -1.33);
  g.add(night);
  const frameMat = std(t, { color: 0x2a3144, roughness: 0.6 });
  g.add(box(t, 1.52, 0.06, 0.05, frameMat, -2.3, 2.68, -1.31, { cast: false }));
  g.add(box(t, 1.52, 0.06, 0.05, frameMat, -2.3, 0.82, -1.31, { cast: false }));
  g.add(box(t, 0.06, 1.9, 0.05, frameMat, -3.03, 1.75, -1.31, { cast: false }));
  g.add(box(t, 0.06, 1.9, 0.05, frameMat, -1.57, 1.75, -1.31, { cast: false }));

  /* 檯燈：底座 → 立桿 → 橫臂 → 燈罩（開口錐）→ 燈泡。 */
  const metal = t.mat(new THREE.MeshPhysicalMaterial({ color: 0x2b2b2e, metalness: 0.85, roughness: 0.32 }));
  const brass = t.mat(new THREE.MeshPhysicalMaterial({ color: 0xc9a05a, metalness: 0.9, roughness: 0.28, side: THREE.DoubleSide }));
  const lampBase = new THREE.Mesh(t.geo(new THREE.CylinderGeometry(0.26, 0.3, 0.07, 32)), metal);
  lampBase.position.set(1.75, 0.035, -0.6);
  lampBase.castShadow = true;
  g.add(lampBase);
  const pole = new THREE.Mesh(t.geo(new THREE.CylinderGeometry(0.022, 0.022, 1.45, 10)), metal);
  pole.position.set(1.75, 0.76, -0.6);
  pole.castShadow = true;
  g.add(pole);
  const arm = new THREE.Mesh(t.geo(new THREE.CylinderGeometry(0.02, 0.02, 1.0, 10)), metal);
  arm.position.set(1.35, 1.5, -0.42);
  arm.rotation.z = Math.PI / 2 - 0.28;
  arm.rotation.y = -0.42;
  g.add(arm);
  const shade = new THREE.Mesh(t.geo(new THREE.ConeGeometry(0.3, 0.34, 36, 1, true)), brass);
  shade.position.set(0.9, 1.5, -0.24);
  shade.rotation.z = 0.35;
  shade.castShadow = false;
  g.add(shade);
  const bulbPos = new THREE.Vector3(0.88, 1.36, -0.22);
  const bulb = new THREE.Mesh(t.geo(new THREE.SphereGeometry(0.075, 16, 12)), t.mat(new THREE.MeshBasicMaterial({ color: 0xfff1cf })));
  bulb.position.copy(bulbPos);
  g.add(bulb);

  const lamp = new THREE.SpotLight(0xffc27e, 34, 0, 0.72, 0.65, 2);
  lamp.position.copy(bulbPos);
  lamp.target.position.set(-0.05, 0, 0.2);
  if (o.shadows) {
    lamp.castShadow = true;
    lamp.shadow.mapSize.set(o.compact ? 512 : 1024, o.compact ? 512 : 1024);
    lamp.shadow.bias = -0.0005;
    lamp.shadow.normalBias = 0.02;
    lamp.shadow.radius = 4;
  }
  g.add(lamp, lamp.target);
  const glow = new THREE.PointLight(0xffb870, 1.4, 4, 2);
  glow.position.set(0.9, 1.62, -0.28);
  g.add(glow);
  g.add(new THREE.HemisphereLight(0x3a4a72, 0x0a0b10, 0.4));
  const moon = directional(0x9fb4ff, 0.35, [-3, 3, -2], [0, 0, 0], null);
  g.add(moon, moon.target);

  const paper = std(t, { color: 0xefe8da, roughness: 0.9 });
  g.add(box(t, 0.95, 0.035, 1.25, paper, -1.65, 0.0175, 0.2, { ry: 0.22 }));
  g.add(box(t, 0.92, 0.012, 1.2, std(t, { color: 0xfaf5ea, roughness: 0.9 }), -1.63, 0.041, 0.19, { ry: 0.2 }));
  const pencil = new THREE.Mesh(t.geo(new THREE.CylinderGeometry(0.018, 0.018, 0.9, 6)), std(t, { color: 0xe8b83a, roughness: 0.5 }));
  pencil.rotation.z = Math.PI / 2;
  pencil.rotation.y = 0.5;
  pencil.position.set(-1.05, 0.02, 0.92);
  pencil.castShadow = true;
  g.add(pencil);
  const mug = new THREE.Mesh(t.geo(new THREE.CylinderGeometry(0.19, 0.17, 0.42, 28)), t.mat(new THREE.MeshPhysicalMaterial({ color: 0xe9e4da, roughness: 0.3, clearcoat: 0.6 })));
  mug.position.set(-2.05, 0.21, -0.55);
  mug.castShadow = true;
  g.add(mug);

  return {
    id: "popular",
    group: g,
    camera: { pos: new THREE.Vector3(0.35, 2.5, 3.35), target: new THREE.Vector3(0.05, 0.32, 0.05), fov: 34 },
    surfaceY: 0,
    piles: [{ x: -0.05, z: 0.1, yaw: -0.06, weight: 1, fan: 3 }],
    scatterRadius: 1.2,
    exposure: 1.12,
    envIntensity: 0.12,
    fog: null,
    rim: new THREE.Color(0xffd6a0),
    shadowLights: [lamp],
    dispose: t.dispose,
  };
}

/* ── 梦虹：大工作台（抽屜、參考書）+ 雨後天光 ── */
function buildPro(o: BuildOptions): WorldRig {
  const t = tracker();
  const g = new THREE.Group();
  const texSize = o.compact ? 256 : 512;
  const maple = woodTexture(t, texSize, [232, 206, 166], [186, 146, 100], { rings: 8, seed: 21 });
  const body = woodTexture(t, texSize, [200, 164, 118], [140, 102, 64], { rings: 10, seed: 23 });

  g.add(box(t, 5.6, 0.16, 2.6, lacquer(t, maple, 0xe0c69c, 0.34, 0.6), 0, -0.08, 0.05, { cast: false }));
  const bodyMat = lacquer(t, body, 0xc09a6e, 0.55, 0.2);
  g.add(box(t, 5.2, 1.1, 2.3, bodyMat, 0, -0.71, -0.05, { cast: false }));
  const drawerMat = lacquer(t, maple, 0xd8bb8e, 0.45, 0.4);
  const knobMat = t.mat(new THREE.MeshPhysicalMaterial({ color: 0xc9a05a, metalness: 0.9, roughness: 0.25 }));
  for (const row of [-0.42, -0.9]) {
    for (const col of [-1.65, 0, 1.65]) {
      g.add(box(t, 1.5, 0.4, 0.05, drawerMat, col, row, 1.12, { cast: false }));
      const knob = new THREE.Mesh(t.geo(new THREE.CylinderGeometry(0.045, 0.045, 0.07, 14)), knobMat);
      knob.rotation.x = Math.PI / 2;
      knob.position.set(col, row, 1.18);
      g.add(knob);
    }
  }

  const covers = [0x8b3a3a, 0x2f4f6f, 0xc9a84c, 0x3d6b4f, 0x6a4c8c];
  const pageMat = std(t, { color: 0xf3ecdc, roughness: 0.9 });
  let y = 0;
  [[1.25, 0.16, 0.92], [1.12, 0.12, 0.84], [1.18, 0.2, 0.88]].forEach(([w, h, d], i) => {
    const cover = std(t, { color: covers[i], roughness: 0.62 });
    g.add(box(t, w, h, d, cover, 2.05, y + h / 2, -0.55, { ry: 0.12 - i * 0.1 }));
    g.add(box(t, w - 0.06, h * 0.8, d + 0.012, pageMat, 2.05 + 0.02, y + h / 2, -0.55, { ry: 0.12 - i * 0.1 }));
    y += h;
  });
  g.add(box(t, 0.16, 1.1, 0.8, std(t, { color: covers[3], roughness: 0.6 }), 2.72, 0.55, -0.62, { rz: -0.14 }));
  g.add(box(t, 0.2, 1.0, 0.76, std(t, { color: covers[4], roughness: 0.6 }), 2.9, 0.5, -0.62, { rz: -0.2 }));

  const wallMat = std(t, { color: 0xd8e0e8, roughness: 0.9 });
  const frameMat = std(t, { color: 0xf7f9fb, roughness: 0.5 });
  windowWall(t, g, {
    z: -1.4,
    hole: [-2.7, 0.9, 0.35, 3.2],
    wallMat,
    frameMat,
    sky: skyTexture(t, [[0, "#8fb8e2"], [0.6, "#dce9f4"], [1, "#f4f7f2"]], "rainbow"),
    skyColor: 0xdce9f4,
  });

  const sky = directional(0xeef5ff, 2.6, [-3.2, 4.6, -4.2], [0.2, 0, 0.3], o.shadows ? { size: o.compact ? 512 : 1024, span: 3.6 } : null);
  g.add(sky, sky.target);
  g.add(new THREE.HemisphereLight(0xe3eefc, 0xb9a88f, 0.85));
  const bounce = directional(0xfff4e0, 0.5, [3, 2, 4], [0, 0, 0], null);
  g.add(bounce, bounce.target);

  return {
    id: "pro",
    group: g,
    camera: { pos: new THREE.Vector3(0.45, 2.05, 4.5), target: new THREE.Vector3(0.1, 0.1, 0.15), fov: 36 },
    surfaceY: 0,
    piles: [
      { x: -0.6, z: 0.2, yaw: -0.14, weight: 1, fan: 3 },
      { x: 0.78, z: 0.32, yaw: 0.24, weight: 0.72, fan: 1 },
    ],
    scatterRadius: 1.6,
    exposure: 1.0,
    envIntensity: 0.8,
    fog: null,
    rim: new THREE.Color(0xeaf4ff),
    shadowLights: [sky],
    dispose: t.dispose,
  };
}

/* ── 自訂：天亮後無邊界工作室（地板延伸進霧裡，塔高衝出鏡頭）── */
function buildCustom(o: BuildOptions): WorldRig {
  const t = tracker();
  const g = new THREE.Group();
  const texSize = o.compact ? 256 : 512;
  const floorTex = woodTexture(t, texSize, [236, 222, 200], [196, 172, 140], { rings: 5, seed: 31, planks: 6, repeat: 10 });
  const floor = new THREE.Mesh(t.geo(new THREE.PlaneGeometry(60, 60)), lacquer(t, floorTex, 0xe6d8c2, 0.5, 0.25));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  g.add(floor);

  const plinth = std(t, { color: 0xf6f3ee, roughness: 0.82 });
  g.add(box(t, 1.7, 0.4, 1.9, plinth, -2.0, 0.2, -0.9));
  g.add(box(t, 1.6, 0.62, 1.85, plinth, 2.2, 0.31, -1.5));
  g.add(box(t, 1.5, 0.22, 1.8, plinth, 0.3, 0.11, -3.4));

  const dawn = directional(0xffdcc6, 2.8, [5, 3.4, 3.2], [0, 0.5, -1], o.shadows ? { size: o.compact ? 512 : 1024, span: 6.5, far: 26 } : null);
  g.add(dawn, dawn.target);
  g.add(new THREE.HemisphereLight(0xfff6ee, 0xe6d8c6, 1.0));
  const cool = directional(0xcfe0ff, 0.45, [-4, 5, -3], [0, 0, 0], null);
  g.add(cool, cool.target);

  return {
    id: "custom",
    group: g,
    camera: { pos: new THREE.Vector3(0.3, 2.4, 6.6), target: new THREE.Vector3(0, 1.1, -0.6), fov: 40 },
    surfaceY: 0,
    piles: [
      { x: 0, z: 0.35, yaw: 0.06, weight: 1, fan: 3 },
      { x: -2.0, z: -0.9, yaw: -0.2, weight: 0.78, baseY: 0.4 },
      { x: 2.2, z: -1.5, yaw: 0.28, weight: 0.86, baseY: 0.62 },
      { x: 0.3, z: -3.4, yaw: -0.1, weight: 0.6, baseY: 0.22 },
      { x: -3.6, z: 0.7, yaw: 0.4, weight: 0.42, fan: 2 },
      { x: 3.9, z: 0.1, yaw: -0.35, weight: 0.5, fan: 1 },
      { x: -1.2, z: -4.8, yaw: 0.15, weight: 0.55 },
    ],
    scatterRadius: 2.2,
    exposure: 1.05,
    envIntensity: 1.0,
    fog: new THREE.Fog(0xf3ece4, 8, 26),
    rim: new THREE.Color(0xfff2e6),
    shadowLights: [dawn],
    dispose: t.dispose,
  };
}

export function buildWorld(id: WorldId, options: BuildOptions): WorldRig {
  switch (id) {
    case "starter":
      return buildStarter(options);
    case "pro":
      return buildPro(options);
    case "custom":
      return buildCustom(options);
    default:
      return buildPopular(options);
  }
}
