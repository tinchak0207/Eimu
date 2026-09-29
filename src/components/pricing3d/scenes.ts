/* ╁━ /pricing 3D 夢境場景（2026-09-26 暴君：整體主題改成虹彩液態玻璃的夢幻空間）╁━
   畫布透明，疊在 SSR 就到位的夢境底圖（PricingAtmosphere）上：這裡只畫「前景實物」——
   卡堆落腳的液態玻璃台、水面漣漪、虹彩晶簇、氣泡、有方向的主光與陰影。
   四個世界 = 同一座夢境的四種天光（晨 → 夜 → 雨後虹 → 天亮），台子隨量級放大：
   梦芽一片小玻璃睡蓮 → 梦影一座浮台 → 梦虹三層階台 → 自訂一望無際的玻璃水面。
   玻璃只活在邊緣與光掠過處：台面實心（薄膜虹彩 iridescence + clearcoat），
   邊緣一圈亮環；不用 transmission（多一趟全屏渲染）。
   只在 engine.ts（動態 import 之後）被載入，所以這裡可以直接 import three。 */

import * as THREE from "three";
import type { WorldId } from "./worlds";

/** 作品卡尺寸（世界單位）：寬 1、深 1.32（≈3:4 竪幅）、厚 0.024（薄玻璃片：堆高是量級，但不能高成一疊紙磚）。 */
export const CARD_W = 1;
export const CARD_D = 1.32;
export const CARD_T = 0.024;

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

export interface SpillSpec {
  /** 台心。 */
  x: number;
  z: number;
  /** 落地環帶內外半徑。 */
  rIn: number;
  rOut: number;
  /** 地面高度。 */
  y: number;
  /** 以鏡頭方向（+z）為中心的散落半角（弧度）。 */
  arc: number;
  /** 溢出多少張時鋪到最外圈。 */
  full: number;
  /** 最多溢出幾張（其餘繼續在台上長高）。 */
  max: number;
  /** 滑落起點：台沿半徑與高度。 */
  edge: number;
  edgeY: number;
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
  /** 台面裝得下的卡數；超過的從台沿滑落、鋪到地上（額度裝不下的滿足感）。 */
  capacity: number;
  spill: SpillSpec;
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


/* ── 材質 ── */

/** 液態玻璃：實心、薄膜虹彩，只在光掠過處泛彩（產品攝影質感）。 */
function iriGlass(t: Tracker, color: number, opts: { opacity?: number; roughness?: number; emissive?: number; env?: number; clearcoat?: number } = {}) {
  return t.mat(
    new THREE.MeshPhysicalMaterial({
      color,
      roughness: opts.roughness ?? 0.1,
      metalness: 0,
      clearcoat: opts.clearcoat ?? 1,
      clearcoatRoughness: 0.04,
      iridescence: 1,
      iridescenceIOR: 1.32,
      iridescenceThicknessRange: [140, 520],
      sheen: 0.6,
      sheenColor: new THREE.Color(0xf3e8ff),
      transparent: (opts.opacity ?? 1) < 1,
      opacity: opts.opacity ?? 1,
      emissive: opts.emissive ?? 0x000000,
      envMapIntensity: opts.env ?? 0.55,
    }),
  );
}

/** 邊緣淡出的圓形 alpha（水面盤、陰影承接面用）。 */
function radialAlpha(t: Tracker, inner: number) {
  const size = 256;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d");
  if (ctx) {
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, "#fff");
    g.addColorStop(inner, "#fff");
    g.addColorStop(1, "#000");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  return t.tex(new THREE.CanvasTexture(c));
}

/** 柔光暈：加色混合的徑向漸層精靈（燈、日、魔法光點的「暈」，夢境感的主要來源）。 */
function glowTexture(t: Tracker) {
  const size = 128;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d");
  if (ctx) {
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.18, "rgba(255,255,255,0.55)");
    g.addColorStop(0.5, "rgba(255,255,255,0.12)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  return t.tex(new THREE.CanvasTexture(c));
}

function glow(t: Tracker, g: THREE.Group, tex: THREE.Texture, x: number, y: number, z: number, size: number, color: number, opacity: number) {
  const m = new THREE.Sprite(
    t.mat(new THREE.SpriteMaterial({ map: tex, color, opacity, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false })),
  );
  m.position.set(x, y, z);
  m.scale.setScalar(size);
  g.add(m);
}

/** 浮在卡堆周圍的魔法光點（加色小點，決定性分佈）。 */
function sparkles(t: Tracker, g: THREE.Group, tex: THREE.Texture, n: number, radius: number, height: number, color: number, seed: number) {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i += 1) {
    const a = rnd() * Math.PI * 2;
    /* 光點只在卡堆外圍飄（混進卡堆裡的加色光點近看像一團眩光）。 */
    const r = radius * (0.72 + 0.28 * Math.sqrt(rnd()));
    pos[i * 3] = Math.sin(a) * r;
    pos[i * 3 + 1] = 0.15 + rnd() * height;
    pos[i * 3 + 2] = Math.cos(a) * r - 0.4;
  }
  const geo = t.geo(new THREE.BufferGeometry());
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const pts = new THREE.Points(
    geo,
    t.mat(new THREE.PointsMaterial({ map: tex, color, size: 0.05, sizeAttenuation: true, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false })),
  );
  g.add(pts);
}

/** 逆光輪廓：從卡堆正後上方打一盞主光色的燈，堆的邊緣亮成一圈（電影的 rim light）。 */
function backlight(g: THREE.Group, color: number, intensity: number) {
  /* 強度打五五折：逆光只負責台子與晶簇的輪廓光，卡片的邊光交給卡面 shader 的 fresnel。 */
  const light = new THREE.DirectionalLight(color, intensity * 0.55);
  light.position.set(0.4, 3.2, -5.5);
  light.target.position.set(0, 0.3, 0);
  g.add(light, light.target);
}

/* ── 構件 ── */

/** 液態玻璃台：實心圓台 + 頂緣亮環 + 台面陰影承接（卡堆的真陰影落在這裡）。 */
function pedestal(t: Tracker, g: THREE.Group, o: { x: number; z: number; r: number; h: number; color: number; rim: number }) {
  const body = new THREE.Mesh(t.geo(new THREE.CylinderGeometry(o.r, o.r * 0.94, o.h, 96)), iriGlass(t, o.color, { roughness: 0.42, opacity: 0.86, env: 0.12, clearcoat: 0.25 }));
  body.position.set(o.x, o.h / 2, o.z);
  body.receiveShadow = true;
  g.add(body);
  const ring = new THREE.Mesh(
    t.geo(new THREE.TorusGeometry(o.r, Math.min(0.045, o.h * 0.4), 16, 128)),
    iriGlass(t, 0xffffff, { roughness: 0.06, emissive: o.rim, env: 0.7 }),
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.set(o.x, o.h, o.z);
  g.add(ring);
  const catcher = new THREE.Mesh(t.geo(new THREE.CircleGeometry(o.r * 0.98, 64)), t.mat(new THREE.ShadowMaterial({ color: 0x3a4f9a, opacity: 0.26 })));
  catcher.rotation.x = -Math.PI / 2;
  catcher.position.set(o.x, o.h + 0.002, o.z);
  catcher.receiveShadow = true;
  g.add(catcher);
}

/** 虹彩水面：一張邊緣淡出的玻璃盤 + 幾圈漣漪，把底圖的水「接」到卡堆腳下。 */
function waterDisc(t: Tracker, g: THREE.Group, radius: number, opacity: number) {
  const mat = iriGlass(t, 0xeef4ff, { opacity, roughness: 0.18 });
  mat.alphaMap = radialAlpha(t, 0.55);
  mat.depthWrite = false;
  const disc = new THREE.Mesh(t.geo(new THREE.CircleGeometry(radius, 96)), mat);
  disc.rotation.x = -Math.PI / 2;
  disc.position.y = -0.004;
  disc.receiveShadow = true;
  g.add(disc);
  const rippleMat = t.mat(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.22, depthWrite: false }));
  for (let i = 1; i <= 4; i += 1) {
    const r = radius * (0.24 + i * 0.13);
    const ripple = new THREE.Mesh(t.geo(new THREE.RingGeometry(r, r + 0.012 + i * 0.004, 128)), rippleMat);
    ripple.rotation.x = -Math.PI / 2;
    ripple.position.y = -0.002;
    g.add(ripple);
  }
}

/** 虹彩晶簇：幾根拉長的八面體（平直切面才有寶石的閃）。 */
function crystals(t: Tracker, g: THREE.Group, x: number, z: number, scale: number, seed: number) {
  const mat = iriGlass(t, 0xffcfe6, { roughness: 0.05, opacity: 0.86, env: 0.8 });
  mat.flatShading = true;
  const geo = t.geo(new THREE.OctahedronGeometry(0.5, 0));
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 5; i += 1) {
    const m = new THREE.Mesh(geo, mat);
    const h = (0.5 + rnd() * 0.9) * scale;
    m.scale.set(0.22 * scale, h, 0.22 * scale);
    m.position.set(x + (rnd() - 0.5) * 0.5 * scale, h * 0.36, z + (rnd() - 0.5) * 0.5 * scale);
    m.rotation.set((rnd() - 0.5) * 0.5, rnd() * Math.PI, (rnd() - 0.5) * 0.6);
    m.castShadow = true;
    g.add(m);
  }
}

/** 氣泡：薄膜虹彩的透明球。 */
function bubble(t: Tracker, g: THREE.Group, x: number, y: number, z: number, r: number) {
  const m = new THREE.Mesh(t.geo(new THREE.SphereGeometry(r, 40, 24)), iriGlass(t, 0xffffff, { opacity: 0.32, roughness: 0.02 }));
  m.position.set(x, y, z);
  g.add(m);
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

const shadowOf = (o: BuildOptions, span: number, far = 20) => (o.shadows ? { size: o.compact ? 512 : 1024, span, far } : null);

/* ── 四档的「遞進」：同一套舞台語言，一档比一档大 ──
   台子半徑 0.95 → 1.3 → 1.75 → 2.2（再加兩座副台），機位只退 3.3 → 3.75 → 4.3 → 5.1：
   場景長得比鏡頭退得快，所以切档時一眼看到「變多了、變大了」。
   主光方向四档一致（左前上方），只換色溫講「夜的故事」；溢出是點睛（0 → 6 → 30 → 60 張），不是山洪。 */

function floor(t: Tracker, g: THREE.Group, radius: number, discOpacity: number) {
  waterDisc(t, g, radius, discOpacity);
  /* 地面陰影承接：掉到地上的作品要有落地的影子，不然像浮在畫上。 */
  const catcher = new THREE.Mesh(t.geo(new THREE.CircleGeometry(radius * 0.8, 64)), t.mat(new THREE.ShadowMaterial({ color: 0x3a4f9a, opacity: 0.24 })));
  catcher.rotation.x = -Math.PI / 2;
  catcher.position.y = 0.001;
  catcher.receiveShadow = true;
  g.add(catcher);
}

function keyLight(g: THREE.Group, o: BuildOptions, color: number, intensity: number, span: number) {
  const key = directional(color, intensity, [-2.6, 4.4, 2.6], [0, 0.4, 0], shadowOf(o, span));
  g.add(key, key.target);
  return key;
}

const PED_H = 0.42;

/* ── 梦芽 · 晨光：一座小玻璃台，一小疊作品，桌面還看得見 ── */
function buildStarter(o: BuildOptions): WorldRig {
  const t = tracker();
  const g = new THREE.Group();
  const glowTex = glowTexture(t);
  floor(t, g, 3.2, 0.45);
  pedestal(t, g, { x: 0, z: 0.05, r: 0.95, h: PED_H, color: 0xffc9df, rim: 0x3a1a2c });
  crystals(t, g, 1.55, -0.6, 0.55, 11);
  bubble(t, g, -1.45, 1.05, -0.5, 0.2);
  glow(t, g, glowTex, -2.8, 1.5, -3.2, 4.5, 0xfbd6de, 0.45);
  sparkles(t, g, glowTex, 30, 1.8, 1.4, 0xfde0e6, 11);
  backlight(g, 0xffd6e8, 1.08);
  const key = keyLight(g, o, 0xfff0f6, 3.2, 2.4);
  g.add(new THREE.HemisphereLight(0xfff0f7, 0xa8b8f0, 0.62));
  return {
    id: "starter",
    group: g,
    camera: { pos: new THREE.Vector3(0.35, 2.55, 4.1), target: new THREE.Vector3(0, 0.5, 0.05), fov: 34 },
    surfaceY: PED_H,
    piles: [{ x: 0, z: 0.08, yaw: 0.08, weight: 1, fan: 2 }],
    scatterRadius: 0.75,
    capacity: 999,
    spill: { x: 0, z: 0.05, rIn: 1.1, rOut: 1.8, y: 0, arc: 1.4, full: 8, max: 0, edge: 0.9, edgeY: PED_H },
    exposure: 1.0,
    envIntensity: 0.4,
    fog: null,
    rim: new THREE.Color(0xffd6ea),
    shadowLights: [key],
    dispose: t.dispose,
  };
}

/* ── 梦影 · 晴藍：台子大一圈，兩疊作品，堆滿了、有幾張滑到地上 ── */
function buildPopular(o: BuildOptions): WorldRig {
  const t = tracker();
  const g = new THREE.Group();
  const glowTex = glowTexture(t);
  floor(t, g, 3.8, 0.38);
  pedestal(t, g, { x: 0, z: 0.05, r: 1.3, h: PED_H, color: 0xb4d0ff, rim: 0x14284a });
  crystals(t, g, -1.95, -0.9, 0.85, 23);
  crystals(t, g, 2.05, -1.2, 0.65, 37);
  /* 晴藍：天光從後上方灑下（逆光），左後一團粉、右後一團藍的天色暈在台後。 */
  glow(t, g, glowTex, -2.6, 1.8, -3.4, 3.4, 0xfad0d9, 0.32);
  glow(t, g, glowTex, 2.8, 2.0, -3.2, 3.4, 0xbfe8fd, 0.36);
  bubble(t, g, -1.5, 1.5, -1.2, 0.18);
  sparkles(t, g, glowTex, 50, 2.4, 1.9, 0xdff3fe, 23);
  backlight(g, 0xd0e2ff, 1.32);
  const key = keyLight(g, o, 0xf2f6ff, 3.0, 2.8);
  g.add(new THREE.HemisphereLight(0xe6efff, 0x9aa8e0, 0.6));
  return {
    id: "popular",
    group: g,
    camera: { pos: new THREE.Vector3(0.35, 2.7, 4.4), target: new THREE.Vector3(0, 0.55, 0.05), fov: 34 },
    surfaceY: PED_H,
    piles: [
      { x: -0.3, z: 0.12, yaw: -0.08, weight: 1, fan: 3 },
      { x: 0.55, z: -0.18, yaw: 0.42, weight: 0.55, fan: 2 },
    ],
    scatterRadius: 1.05,
    capacity: 46,
    spill: { x: 0, z: 0.05, rIn: 1.4, rOut: 1.9, y: 0, arc: 1.35, full: 8, max: 8, edge: 1.25, edgeY: PED_H },
    exposure: 1.02,
    envIntensity: 0.32,
    fog: null,
    rim: new THREE.Color(0xd6e6ff),
    shadowLights: [key],
    dispose: t.dispose,
  };
}

/* ── 梦虹 · 雨後：大台三疊，作品滿到從台沿瀉下一圈，虹色輪廓光 ── */
function buildPro(o: BuildOptions): WorldRig {
  const t = tracker();
  const g = new THREE.Group();
  const glowTex = glowTexture(t);
  floor(t, g, 4.6, 0.4);
  pedestal(t, g, { x: 0, z: 0.05, r: 1.75, h: PED_H, color: 0x9ccaff, rim: 0x14304a });
  crystals(t, g, -2.55, -1.1, 1.05, 51);
  crystals(t, g, 2.6, -1.35, 0.95, 67);
  crystals(t, g, 1.7, -2.3, 0.55, 71);
  bubble(t, g, -2.1, 1.7, -1.5, 0.26);
  bubble(t, g, 2.3, 1.3, -0.7, 0.14);
  sparkles(t, g, glowTex, 80, 3.1, 2.4, 0xe3f5fe, 51);
  glow(t, g, glowTex, -2.5, 2.4, -3.2, 3.6, 0xf8c2cd, 0.38);
  glow(t, g, glowTex, 2.7, 2.2, -3.0, 3.6, 0xaee4fd, 0.38);
  const magenta = directional(0xff9fd8, 1.0, [-4.5, 1.2, 0.5], [0, 0.4, 0], null);
  const cyan = directional(0x8fe6ff, 1.0, [4.5, 1.2, 0.8], [0, 0.4, 0], null);
  g.add(magenta, magenta.target, cyan, cyan.target);
  backlight(g, 0xe6f6ff, 1.44);
  const key = keyLight(g, o, 0xeef7ff, 3.0, 3.4);
  g.add(new THREE.HemisphereLight(0xe6f4ff, 0xa4b4e8, 0.62));
  return {
    id: "pro",
    group: g,
    camera: { pos: new THREE.Vector3(0.4, 2.95, 4.9), target: new THREE.Vector3(0.05, 0.6, 0.1), fov: 36 },
    surfaceY: PED_H,
    piles: [
      { x: -0.5, z: 0.25, yaw: -0.14, weight: 1, fan: 3 },
      { x: 0.7, z: 0.3, yaw: 0.3, weight: 0.8, fan: 2 },
      { x: 0.05, z: -0.75, yaw: 0.08, weight: 0.7, fan: 2 },
    ],
    scatterRadius: 1.45,
    capacity: 128,
    spill: { x: 0, z: 0.05, rIn: 1.9, rOut: 3.1, y: 0, arc: 1.75, full: 30, max: 30, edge: 1.7, edgeY: PED_H },
    exposure: 1.0,
    envIntensity: 0.4,
    fog: null,
    rim: new THREE.Color(0xe6f6ff),
    shadowLights: [key],
    dispose: t.dispose,
  };
}

/* ── 自訂 · 天亮之後：主台 + 兩座副台，額度越大塔越高、鏡頭越推近 ── */
function buildCustom(o: BuildOptions): WorldRig {
  const t = tracker();
  const g = new THREE.Group();
  const glowTex = glowTexture(t);
  floor(t, g, 9, 0.3);
  pedestal(t, g, { x: 0, z: 0.1, r: 2.2, h: PED_H, color: 0xf4f7ff, rim: 0x202a48 });
  pedestal(t, g, { x: -3.1, z: -2.0, r: 1.05, h: 0.7, color: 0xffc6e0, rim: 0x3a1a2c });
  pedestal(t, g, { x: 3.2, z: -2.3, r: 1.05, h: 0.95, color: 0xa8d0ff, rim: 0x14304a });
  crystals(t, g, -4.6, -3.2, 1.3, 83);
  crystals(t, g, 4.9, -3.6, 1.15, 97);
  bubble(t, g, -2.6, 2.6, -3.4, 0.36);
  bubble(t, g, 3.2, 3.1, -4.2, 0.26);
  sparkles(t, g, glowTex, 110, 4.6, 3.2, 0xffffff, 97);
  glow(t, g, glowTex, 5.5, 4.6, -5.5, 8, 0xf5fbff, 0.55);
  backlight(g, 0xf6f4ff, 1.32);
  const key = keyLight(g, o, 0xffffff, 3.1, 5.5);
  g.add(new THREE.HemisphereLight(0xffffff, 0xb4c2ec, 0.8));
  return {
    id: "custom",
    group: g,
    camera: { pos: new THREE.Vector3(0.3, 3.4, 6.2), target: new THREE.Vector3(0, 0.75, -0.4), fov: 38 },
    surfaceY: PED_H,
    piles: [
      { x: -0.8, z: 0.45, yaw: 0.06, weight: 1, fan: 3 },
      { x: 0.8, z: 0.4, yaw: -0.3, weight: 0.95, fan: 2 },
      { x: 0, z: -0.75, yaw: 0.12, weight: 0.9, fan: 2 },
      { x: -1.35, z: -0.45, yaw: 0.5, weight: 0.7, fan: 1 },
      { x: 1.35, z: -0.5, yaw: -0.45, weight: 0.7, fan: 1 },
      { x: -3.1, z: -2.0, yaw: -0.2, weight: 0.6, baseY: 0.7 - PED_H },
      { x: 3.2, z: -2.3, yaw: 0.28, weight: 0.65, baseY: 0.95 - PED_H },
    ],
    scatterRadius: 1.8,
    capacity: 300,
    spill: { x: 0, z: 0.1, rIn: 2.35, rOut: 3.9, y: 0, arc: 1.85, full: 60, max: 60, edge: 2.15, edgeY: PED_H },
    exposure: 1.02,
    envIntensity: 0.45,
    fog: new THREE.Fog(0xf0f8ff, 12, 34),
    rim: new THREE.Color(0xf2f4ff),
    shadowLights: [key],
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
