import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { BokehPass } from "three/addons/postprocessing/BokehPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { clamp, lerp, P, ease, spring, hash, wobble, Track, yawPitch, deg } from "./lib/util.js";
import * as UI from "./lib/ui.js";
import { surfaceMaterial, imageMaterial, threadMaterial, FilmShader } from "./lib/shaders.js";

const $ = id => document.getElementById(id);
const W_ = 1920, H_ = 1080, ASPECT = W_ / H_;

/* =====================================================================================
 * 時間軸（秒）
 * ===================================================================================== */
export const DUR = 49.2;
const T = {
  qinClips: [[0.50, 1.72, 16.30], [1.72, 2.86, 10.90], [2.86, 3.92, 26.40], [3.92, 99, 31.15]],
  title0: [4.2, 6.05], lbOut: [6.45, 7.15],
  pull: [6.4, 9.3], light: [6.5, 7.95],
  rewind: [9.3, 11.75],
  prompt: [11.75, 14.65], type: 12.05, typeStep: 0.098, send: 14.15, title1: [13.1, 14.55],
  build: [14.65, 20.45], title2: [15.75, 20.05],
  ming: [20.45, 25.85], title3: [21.9, 25.15],
  film: [25.85, 31.45], alive: 26.45,
  mingClips: [[26.45, 27.9, 5.6], [27.9, 28.8, 25.95], [28.8, 29.62, 28.4], [29.62, 30.5, 38.3], [30.5, 31.45, 56.95]],
  stage: [31.45, 36.45], title4: [32.3, 35.95],
  wall: [36.45, 41.65], title5: [38.25, 41.3],
  end: [41.65, 49.2],
};

const CUES = {
  duration: DUR,
  // [起, 迄, 低音, 和聲, 琶音力度]
  chords: [
    [0, 6.4, 38, [50, 53, 57, 60, 64], 0],        // Dm9：影院冷開
    [6.4, 9.3, 34, [50, 53, 57, 60, 62], 0.3],     // Bbmaj9：光湧入
    [9.3, 11.75, 31, [46, 50, 53, 57], 0.55],      // Gm9：倒帶
    [11.75, 14.65, 41, [57, 60, 64, 67], 0.25],    // Fmaj9：一句話
    [14.65, 20.45, 36, [52, 55, 57, 62], 1.0],     // C6/9：展開
    [20.45, 25.85, 33, [48, 52, 55, 59], 0.85],    // Am9：角色
    [25.85, 31.45, 34, [50, 53, 57, 62], 0],       // Bbmaj9：成片（留給畫面）
    [31.45, 36.45, 38, [53, 57, 60, 64], 0.7],     // Dm9：舞台
    [36.45, 41.65, 36, [52, 55, 59, 62], 0.95],    // Cmaj9：作品牆
    [41.65, 49.2, 29, [48, 57, 64, 67, 72], 0],    // Fmaj9：收
  ],
  pulse: [[14.65, 20.45], [31.45, 41.65]],
  boom: [], whoosh: [], rewind: [], tick: [], pop: [], pluck: [], success: [], shimmer: [], bloom: [], swell: [0.05], chime: [],
};

/* =====================================================================================
 * 渲染器 / 後處理
 * ===================================================================================== */
const renderer = new THREE.WebGLRenderer({ canvas: $("gl"), antialias: false, preserveDrawingBuffer: true, powerPreference: "high-performance" });
renderer.setPixelRatio(1); renderer.setSize(W_, H_, false);
renderer.toneMapping = THREE.NeutralToneMapping; renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const MAX_ANISO = renderer.capabilities.getMaxAnisotropy();

const scene = new THREE.Scene();
const PEARL = new THREE.Color("#eef1f6"), BLACK = new THREE.Color("#000000"), STAGE_BG = new THREE.Color("#0b0d11");
scene.background = PEARL.clone();
const pmrem = new THREE.PMREMGenerator(renderer);
// 自建影棚環境：頂部白色柔光箱 + 左藍右粉燈條，讓玻璃斜邊映出藍粉邊光（Liquid Glass）
function studioEnv() {
  const es = new THREE.Scene();
  const sky = new THREE.Mesh(new THREE.SphereGeometry(30, 64, 32), new THREE.ShaderMaterial({
    side: THREE.BackSide,
    vertexShader: `varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }`,
    fragmentShader: `varying vec3 vP; void main(){ float y = vP.y; vec3 top = vec3(1.05); vec3 hor = vec3(.82,.86,.93); vec3 bot = vec3(.46,.49,.57);
      vec3 c = y > 0. ? mix(hor, top, pow(y, .55)) : mix(hor, bot, pow(-y, .45)); gl_FragColor = vec4(c, 1.); }`,
  }));
  es.add(sky);
  const box = (w, h, pos, col, k) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(col).multiplyScalar(k), side: THREE.DoubleSide })); m.position.set(...pos); m.lookAt(0, 1, 0); es.add(m); };
  box(14, 5, [0, 14, 3], "#ffffff", 7);
  box(3, 12, [-14, 4, 1], "#78a9ff", 4.2);
  box(3, 12, [14, 4, -1], "#ff93c4", 3.6);
  box(10, 2.2, [0, 3, 14], "#ffffff", 2.6);
  box(6, 1.6, [2, 2, -14], "#bfe7ff", 2.2);
  return pmrem.fromScene(es, 0.02).texture;
}
scene.environment = studioEnv();

const camera = new THREE.PerspectiveCamera(32, ASPECT, 0.05, 260);
camera.rotation.order = "YXZ";

const rt = new THREE.WebGLRenderTarget(W_, H_, { type: THREE.HalfFloatType, samples: 4 });
const composer = new EffectComposer(renderer, rt);
composer.setPixelRatio(1); composer.setSize(W_, H_);
composer.addPass(new RenderPass(scene, camera));
const bokeh = new BokehPass(scene, camera, { focus: 6, aperture: 0.002, maxblur: 0.01 });
composer.addPass(bokeh);
const bloom = new UnrealBloomPass(new THREE.Vector2(W_, H_), 0.5, 0.55, 1.0);
composer.addPass(bloom);
composer.addPass(new OutputPass());
const film = new ShaderPass(FilmShader);
composer.addPass(film);

/* 燈光 */
const hemi = new THREE.HemisphereLight(0xffffff, 0xdde4f0, 0.55); scene.add(hemi);
const key = new THREE.DirectionalLight(0xffffff, 1.6);
key.position.set(-8, 16, 10); key.castShadow = true;
key.shadow.mapSize.set(2048, 2048); key.shadow.bias = -0.0004; key.shadow.normalBias = 0.02; key.shadow.radius = 5;
Object.assign(key.shadow.camera, { left: -9, right: 9, top: 9, bottom: -9, near: 1, far: 50 });
scene.add(key, key.target);

/* 無限畫布 */
const surf = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), surfaceMaterial());
surf.rotation.x = -Math.PI / 2; scene.add(surf);
const SU = surf.material.uniforms;

/* =====================================================================================
 * 資產
 * ===================================================================================== */
const texLoader = new THREE.TextureLoader();
const TEX = {};
function loadTex(key, src) {
  return new Promise((res, rej) => texLoader.load(src, t => { t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = MAX_ANISO; TEX[key] = t; t.userData.aspect = t.image.width / t.image.height; res(t); }, undefined, rej));
}
function canvasTex(c, premul = true) {
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = MAX_ANISO;
  t.premultiplyAlpha = premul; t.userData.aspect = c.width / c.height; return t;
}
const VID = {};
// 影片經 2D 畫布中轉上傳（獨顯 PRIME 下 WebGL 直接吃 <video> 會得到黑幀）
function makeVideo(key, src, fps) {
  const v = document.createElement("video"); v.src = src; v.muted = true; v.preload = "auto"; v.playsInline = true;
  const cv = document.createElement("canvas"); const cx = cv.getContext("2d", { alpha: false });
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.anisotropy = MAX_ANISO;
  VID[key] = { v, tex, fps, last: -1, cv, cx };
  return new Promise((res, rej) => {
    v.onloadeddata = () => { cv.width = v.videoWidth; cv.height = v.videoHeight; tex.userData.aspect = v.videoWidth / v.videoHeight; res(); };
    v.onerror = () => rej(new Error("video " + src)); v.load();
  });
}
async function seek(key, time) {
  const o = VID[key]; const f = Math.round(clamp(time, 0, o.v.duration - 0.08) * o.fps);
  if (f === o.last) return; o.last = f;
  await new Promise(r => { o.v.onseeked = () => r(); o.v.currentTime = (f + 0.5) / o.fps; });
  o.cx.drawImage(o.v, 0, 0, o.cv.width, o.cv.height);
  o.tex.needsUpdate = true;
}

/* =====================================================================================
 * 玻璃磚（圓角擠出 + 斜角）+ 貼花 + 影像槽 + 接觸陰影
 * ===================================================================================== */
const geoCache = new Map();
function slabGeo(w, d, r, thick, bev = 0.022) {
  const k = [w, d, r, thick, bev].join("|"); if (geoCache.has(k)) return geoCache.get(k);
  const s = new THREE.Shape(), a = w / 2 - bev, b = d / 2 - bev, rr = Math.max(0.002, Math.min(r - bev, a, b));
  s.moveTo(-a + rr, -b); s.lineTo(a - rr, -b); s.absarc(a - rr, -b + rr, rr, -Math.PI / 2, 0);
  s.lineTo(a, b - rr); s.absarc(a - rr, b - rr, rr, 0, Math.PI / 2);
  s.lineTo(-a + rr, b); s.absarc(-a + rr, b - rr, rr, Math.PI / 2, Math.PI);
  s.lineTo(-a, -b + rr); s.absarc(-a + rr, -b + rr, rr, Math.PI, Math.PI * 1.5);
  const g = new THREE.ExtrudeGeometry(s, { depth: Math.max(0.001, thick - 2 * bev), bevelEnabled: true, bevelThickness: bev, bevelSize: bev, bevelSegments: 6, curveSegments: 18, steps: 1 });
  g.rotateX(-Math.PI / 2); g.translate(0, bev, 0);
  geoCache.set(k, g); return g;
}
function glassMat(o = {}) {
  return new THREE.MeshPhysicalMaterial({
    color: 0xffffff, roughness: 0.16, metalness: 0, transmission: 1, thickness: 0.35, ior: 1.45, dispersion: 0.5,
    clearcoat: 1, clearcoatRoughness: 0.05, specularIntensity: 1, envMapIntensity: 1.3,
    attenuationColor: new THREE.Color("#eef3ff"), attenuationDistance: 2.4, transparent: true, ...o,
  });
}
let SHADOW_TEX = null;
function shadowTex() {
  if (SHADOW_TEX) return SHADOW_TEX;
  const { canvas } = UI.drawShadow(400, 400, 60, 38); SHADOW_TEX = canvasTex(canvas, false); return SHADOW_TEX;
}

const TILES = [];
class Tile {
  constructor({ x, y = 0, z, w, d, r = 0.13, thick = 0.07, drawn, images = [], ppu = 640, name }) {
    Object.assign(this, { x, y, z, w, d, thick, name });
    this.root = new THREE.Group(); this.root.position.set(x, y, z); scene.add(this.root);
    this.pivot = new THREE.Group(); this.root.add(this.pivot);
    this.glass = glassMat();
    this.slab = new THREE.Mesh(slabGeo(w, d, r, thick), this.glass); this.pivot.add(this.slab);
    this.decal = null;
    if (drawn && drawn.canvas) {
      const m = imageMaterial({ map: canvasTex(drawn.canvas), w, h: d, radius: 0, transparent: true });
      m.uniforms.uPremul.value = 1; m.uniforms.uClear.value = 1; m.uniforms.uSoft.value = 0.12;
      this.decal = new THREE.Mesh(new THREE.PlaneGeometry(w, d), m);
      this.decal.rotation.x = -Math.PI / 2; this.decal.position.y = thick + 0.0015; this.decal.renderOrder = 2;
      this.pivot.add(this.decal);
    }
    this.imgs = (drawn?.slots || []).map((sl, i) => {
      const src = images[i]; if (!src) return null;
      const m = imageMaterial({ map: src, w: sl.w, h: sl.h, radius: sl.r, transparent: false });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(sl.w, sl.h), m);
      mesh.rotation.x = -Math.PI / 2; mesh.position.set(sl.x, thick + 0.003, sl.z); mesh.renderOrder = 3;
      this.pivot.add(mesh);
      const o = { mesh, m, sl }; this.cover(o, src); return o;
    }).filter(Boolean);
    const sh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: shadowTex(), transparent: true, depthWrite: false, color: 0x141a2d, opacity: 0.2 }));
    sh.rotation.x = -Math.PI / 2; sh.renderOrder = 1; scene.add(sh); this.shadow = sh;
    this.overlay = null;
    TILES.push(this);
  }
  cover(o, tex) {
    const ta = tex.userData.aspect || 1, sa = o.sl.w / o.sl.h;
    o.m.uniforms.uMap.value = tex;
    o.m.uniforms.uUvScale.value.set(sa > ta ? 1 : sa / ta, sa > ta ? ta / sa : 1);
  }
  addOverlay(canvas, size) {
    const s = this.imgs[0].sl;
    const m = imageMaterial({ map: canvasTex(canvas), w: size, h: size, radius: 0, transparent: true }); m.uniforms.uPremul.value = 1;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), m); mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(s.x, this.thick + 0.005, s.z); mesh.renderOrder = 4; this.pivot.add(mesh); this.overlay = { mesh, m };
  }
  // b：建構量 0→1；reveal：影像揭示；o：整體不透明度；lift/quat 由外部設定
  set({ b = 1, reveal = 1, o = 1, t = 0, sweep = -1, dim = 1, shimSeed = 0 } = {}) {
    const vis = b * o > 0.002; this.root.visible = vis;
    const eb = ease.out(clamp(b));
    this.pivot.position.y = -0.07 * (1 - eb);
    this.pivot.scale.setScalar(0.93 + 0.07 * eb);
    this.glass.opacity = clamp(eb * o * 1.2);
    if (this.decal) {
      const u = this.decal.material.uniforms;
      u.uOpacity.value = o * clamp((b - 0.15) / 0.5); u.uReveal.value = clamp((b - 0.2) / 0.75) * 1.15;
      u.uSweep.value = sweep; u.uSweepAmt.value = sweep > -0.5 ? 0.35 : 0; u.uBright.value = dim;
    }
    for (const im of this.imgs) {
      const u = im.m.uniforms;
      u.uOpacity.value = o * clamp((b - 0.35) / 0.5); u.uReveal.value = reveal * 1.12; u.uBright.value = dim;
      u.uShim.value = reveal < 0.999 ? 0.8 : 0; u.uShimPos.value = ((t * 0.9 + shimSeed) % 1.6) - 0.3;
    }
    if (this.overlay) this.overlay.m.uniforms.uOpacity.value = o * clamp((reveal - 0.6) / 0.4);
    // 接觸陰影跟隨世界位置，隨高度變淡變大
    const wp = this.pivot.getWorldPosition(new THREE.Vector3());
    const h = Math.max(0, wp.y - this.root.position.y * 0 - 0);
    const spread = 1 + h * 0.35;
    this.shadow.position.set(wp.x + h * 0.25, 0.004, wp.z + h * 0.18);
    const sc = this.pivot.scale.x * (this.upright || 0);
    this.shadow.scale.set((this.w + 0.55) * spread * (1 - 0.5 * sc), (this.d + 0.55) * spread * (1 - 0.6 * sc) + 0.3 * sc, 1);
    this.shadow.material.opacity = 0.2 * o * eb * dim / (1 + h * 1.4);
    this.shadow.visible = vis;
  }
}

/* 發光連線 */
const THREADS = [];
function thread(p0, p1, color, { c0, c1, radius = 0.0062 } = {}) {
  const a = new THREE.Vector3(...p0), b = new THREE.Vector3(...p1);
  const dx = (b.x - a.x) * 0.5;
  const curve = new THREE.CubicBezierCurve3(a, c0 ? new THREE.Vector3(...c0) : a.clone().add(new THREE.Vector3(dx, 0, 0)), c1 ? new THREE.Vector3(...c1) : b.clone().sub(new THREE.Vector3(dx, 0, 0)), b);
  const len = curve.getLength();
  const mesh = new THREE.Mesh(new THREE.TubeGeometry(curve, Math.max(40, Math.round(len * 40)), radius, 8, false), threadMaterial(color, len));
  mesh.renderOrder = 1; scene.add(mesh);
  const o = { mesh, u: mesh.material.uniforms, len, seed: hash(THREADS.length + 11) }; THREADS.push(o); return o;
}
const BLUE = new THREE.Color("#3b82ff"), PINK = new THREE.Color("#ec4d92");

/* =====================================================================================
 * 秦始皇專案：一句話 → 21 個生成節點
 * ===================================================================================== */
const QIN = {};
const QSHOTS = [["片头", "q-1.5", "金光雪原"], ["出城", "q-6.8", "熊骑破门"], ["大军", "q-12.0", "冰原列阵"], ["冲锋", "q-17.6", "雪原驰骋"], ["并立", "q-22.6", "与熊同行"], ["夜探", "q-27.6", "火把熊影"], ["凯旋", "q-32.6", "金门归来"]];
const LENS = ["航拍", "推镜", "大全景", "跟拍", "仰拍", "特写", "对称"];
const PROMPT = "生成秦始皇骑北极熊的电影";

function buildQin() {
  // 提示輸入框（藥丸形玻璃 + 動態貼花 + 3D 發送鍵）
  const pw = 4.7, pd = 0.74;
  const pad = UI.makePromptPad(pw, pd, 720);
  const pt = new Tile({ x: -13.6, z: 0, w: pw, d: pd, r: pd / 2, thick: 0.08, drawn: { canvas: pad.c, slots: [] }, name: "prompt" });
  pt.pad = pad; pt.padTex = pt.decal.material.uniforms.uMap.value; pt.lastKey = "";
  const btnMat = new THREE.MeshPhysicalMaterial({ color: new THREE.Color("#2d3142"), roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.08, envMapIntensity: 1.1 });
  const btn = new THREE.Mesh(new THREE.CylinderGeometry(0.235, 0.235, 0.07, 64), btnMat);
  btn.position.set(pw / 2 - 0.42, 0.08 + 0.035, 0); pt.pivot.add(btn);
  const arrowM = imageMaterial({ map: canvasTex(UI.drawSendTop()), w: 0.3, h: 0.3, transparent: true }); arrowM.uniforms.uPremul.value = 1;
  const arrow = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.3), arrowM); arrow.rotation.x = -Math.PI / 2; arrow.position.y = 0.036; arrow.renderOrder = 4; btn.add(arrow);
  const ringM = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.25, 0.55, 3.2), transparent: true, depthWrite: false, opacity: 0 });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.24, 0.265, 96), ringM); ring.rotation.x = -Math.PI / 2; ring.position.set(pw / 2 - 0.42, 0.083, 0); pt.pivot.add(ring);
  Object.assign(QIN, { prompt: pt, btn, btnMat, ring, ringM });

  const scr = new Tile({ x: -9.7, z: 0, w: 1.72, d: 2.6, drawn: UI.drawScript(1.72, 2.6, 640, { idx: "01", title: "《始皇帝的北境征途》", meta: "片头 + 6 镜 · 36 秒 · 史诗", lines: QSHOTS.map(s => [s[0], s[2]]) }), name: "script" });
  const ent = [
    new Tile({ x: -7.05, z: -1.72, w: 1.66, d: 1.2, drawn: UI.drawEntity(1.66, 1.2, 640, { head: "角色卡", kind: "角色", name: "始皇帝", sub: "黑金秦甲 · 金冠", tags: ["四视图 ×4"] }), images: [TEX["char-emperor2"]], name: "char" }),
    new Tile({ x: -7.05, z: 0, w: 1.66, d: 1.2, drawn: UI.drawEntity(1.66, 1.2, 640, { head: "角色卡", kind: "角色", name: "北极熊", sub: "战骑 · 金甲鞍", tags: ["四视图 ×4"] }), images: [TEX["char-bear"]], name: "bear" }),
    new Tile({ x: -7.05, z: 1.72, w: 1.66, d: 1.2, drawn: UI.drawScene(1.66, 1.2, 640, { head: "场景卡", name: "北境雪原 · 城门" }), images: [TEX["scene-snow"]], name: "scene" }),
  ];
  const kf = [], vid = [];
  QSHOTS.forEach((s, i) => {
    const z = -3.24 + i * 1.08;
    kf.push(new Tile({ x: -4.5, z, w: 1.46, d: 0.98, drawn: UI.drawShot(1.46, 0.98, 640, { title: `镜头 0${i + 1}`, right: LENS[i] }), images: [TEX[s[1]]], name: "kf" + i }));
    const v = new Tile({ x: -2.5, z, w: 1.46, d: 0.98, drawn: UI.drawShot(1.46, 0.98, 640, { title: `视频 0${i + 1}`, right: "5s", video: true }), images: [TEX[i === 1 ? "q-8.6" : s[1]]], name: "vid" + i });
    v.addOverlay(UI.drawPlay(), 0.26); vid.push(v);
  });
  const music = new Tile({ x: 0.15, z: 1.62, w: 1.5, d: 0.82, drawn: UI.drawMusic(1.5, 0.82, 640, { title: "配乐", right: "0:36", sub: "史诗弦乐 · 低鼓" }), name: "music" });
  const voice = new Tile({ x: 1.8, z: 1.62, w: 1.5, d: 0.82, drawn: UI.drawMusic(1.5, 0.82, 640, { title: "旁白", right: "0:36", sub: "低沉男声 · 自动对轨" }), name: "voice" });
  const fin = new Tile({ x: 0.95, z: -0.52, w: 2.62, d: 1.96, drawn: UI.drawFinal(2.62, 1.96, 560, { title: "成片", right: "0:36", done: true, aspect: 1.75, caption: "始皇帝的北境征途", meta: "1344×768 · 36s" }), images: [VID.qinA.tex], name: "final" });
  Object.assign(QIN, { script: scr, ent, kf, vid, music, voice, final: fin });

  // 連線
  const L = (t, side) => [t.x + (side > 0 ? t.w / 2 : -t.w / 2) - side * 0.01, 0.035, t.z];
  const TH = [];
  const add = (a, b, col, opt) => { const th = thread(L(a, 1), L(b, -1), col, opt); TH.push({ th, a, b }); return th; };
  add(pt, scr, BLUE);
  ent.forEach(e => add(scr, e, PINK));
  const links = { 0: [1, 4], 1: [3, 5], 2: [0, 2] };
  Object.entries(links).forEach(([ei, ks]) => ks.forEach(k => add(ent[ei], kf[k], PINK)));
  kf.forEach((k, i) => add(k, vid[i], BLUE));
  vid.forEach(v => add(v, fin, BLUE));
  // 劇本 → 配樂/旁白：沿底部繞行
  for (const [n, zOff] of [[music, 0], [voice, 0]]) {
    const a = [scr.x, 0.035, scr.z + scr.d / 2 - 0.01], b = [n.x - n.w / 2 + 0.01, 0.035, n.z + zOff];
    const th = thread(a, b, PINK, { c0: [scr.x, 0.035, 4.35], c1: [n.x - n.w / 2 - 1.6, 0.035, n.z + 0.05 + (n === voice ? 2.4 : 2.0)] });
    TH.push({ th, a: scr, b: n });
  }
  [music, voice].forEach(n => { const th = thread([n.x, 0.035, n.z - n.d / 2 + 0.01], [fin.x + (n === music ? -0.5 : 0.5), 0.035, fin.z + fin.d / 2 - 0.01], BLUE, { c0: [n.x, 0.035, n.z - n.d / 2 - 0.25], c1: [fin.x + (n === music ? -0.5 : 0.5), 0.035, fin.z + fin.d / 2 + 0.25] }); TH.push({ th, a: n, b: fin }); });
  QIN.threads = TH;
  QIN.nodes = [pt, scr, ...ent, ...kf, ...vid, music, voice, fin];
}

/* 前進建構 / 倒帶拆解時間表 */
function qinSchedule() {
  const s = T.send;
  const tb = new Map();
  tb.set(QIN.prompt, -99);
  tb.set(QIN.script, s + 0.32);
  QIN.ent.forEach((e, i) => tb.set(e, s + 0.72 + i * 0.1));
  QIN.kf.forEach((k, i) => tb.set(k, s + 1.12 + i * 0.075));
  QIN.vid.forEach((k, i) => tb.set(k, s + 1.62 + i * 0.075));
  tb.set(QIN.music, s + 2.05); tb.set(QIN.voice, s + 2.12);
  tb.set(QIN.final, s + 2.4);
  QIN.tb = tb;
  QIN.fill = new Map();
  QIN.ent.forEach((e, i) => QIN.fill.set(e, s + 1.0 + i * 0.12));
  QIN.kf.forEach((k, i) => QIN.fill.set(k, s + 1.55 + i * 0.13));
  QIN.vid.forEach((k, i) => QIN.fill.set(k, s + 2.25 + i * 0.13));
  QIN.fill.set(QIN.final, s + 3.2);
  // 倒帶：相機經過節點時拆解（x 由右至左）
  QIN.tun = new Map();
  const cx = x => { for (let t = T.rewind[0]; t <= T.rewind[1]; t += 0.01) { const st = camState(t); if (st.pos[0] < x + 0.6) return t; } return T.rewind[1]; };
  for (const n of QIN.nodes) if (n !== QIN.prompt) QIN.tun.set(n, cx(n.x));
  CUES.pluck.push(...[...QIN.fill.values()].filter(v => v > 0));
  CUES.success.push(s + 3.25);
}

/* =====================================================================================
 * 大明專案（另一個已完成的專案）：角色卡升空 + 三鏡同臉 → 提燈一鏡活過來
 * ===================================================================================== */
const MING = {};
function buildMing() {
  const proj = new Tile({ x: 9.7, z: -2.05, w: 3.1, d: 1.36, drawn: UI.drawProject(3.1, 1.36, 560, { head: "项目", right: "已出片", title: "《大明最后的十七年》", meta: "小说影视化 · 64 秒 · 9 步产线", steps: ["剧本", "角色卡", "美术卡", "分镜", "预演", "关键帧", "视频", "配音", "成片"], hi: 1 }), name: "mproj" });
  const ch = new Tile({ x: 8.95, z: 0.35, w: 1.76, d: 1.26, drawn: UI.drawEntity(1.76, 1.26, 720, { head: "角色卡", kind: "角色", name: "崇祯", sub: "少年天子 · 龙袍 · 提灯", tags: ["参考图 ×3", "已锁定"] }), images: [TEX["char-chongzhen"]], name: "mchar" });
  const art = new Tile({ x: 10.95, z: 0.35, w: 1.76, d: 1.26, drawn: UI.drawEntity(1.76, 1.26, 640, { head: "美术卡", kind: "风格", name: "冷峻写实", sub: "胶片颗粒 · 宫墙暗红", tags: ["美术圣经"], iconName: "palette" }), images: [TEX["m-20.5"]], name: "mart" });
  const kfSpec = [["镜 01", "早膳", "m-0.8"], ["镜 04", "提灯夜行", "m-5.6"], ["镜 09", "临朝特写", "m-16.4"]];
  const kf = kfSpec.map((k, i) => new Tile({ x: 13.75, z: -1.3 + i * 1.3, w: 1.62, d: 1.15, drawn: UI.drawShot(1.62, 1.15, 720, { title: `关键帧 · ${k[0]}`, right: k[1] }), images: [TEX[k[2]]], name: "mkf" + i }));
  const vids = [["m-7.2"], ["m-26.5"], ["m-38.6"]].map((k, i) => { const t = new Tile({ x: 15.95, z: -1.3 + i * 1.3, w: 1.62, d: 1.15, drawn: UI.drawShot(1.62, 1.15, 640, { title: `视频 0${i + 1}`, right: "5s", video: true }), images: [TEX[k[0]]], name: "mvid" + i }); t.addOverlay(UI.drawPlay(), 0.28); return t; });
  const fin = new Tile({ x: 18.75, z: -0.35, w: 2.4, d: 1.82, drawn: UI.drawFinal(2.4, 1.82, 560, { title: "成片", done: true, aspect: 1.7778, caption: "大明最后的十七年", meta: "1280×720 · 64s" }), images: [TEX["m-57.5"]], name: "mfin" });
  const L = (t, side) => [t.x + (side > 0 ? t.w / 2 : -t.w / 2) - side * 0.01, 0.035, t.z];
  const TH = [];
  kf.forEach(k => { const th = thread(L(art, 1), L(k, -1), PINK); th.lifted = true; TH.push(th); });
  kf.forEach((k, i) => { const th = thread(L(k, 1), L(vids[i], -1), BLUE); th.lifted = true; TH.push(th); });
  vids.forEach(v => TH.push(thread(L(v, 1), L(fin, -1), BLUE)));
  { const th = thread(L(ch, 1), L(art, -1), PINK); th.lifted = true; TH.push(th); }
  { const th = thread([proj.x, 0.035, proj.z + proj.d / 2 - 0.01], [ch.x, 0.035, ch.z - ch.d / 2 + 0.01], PINK, { c0: [proj.x, 0.035, proj.z + 1.2], c1: [ch.x, 0.035, ch.z - 1.2] }); th.lifted = true; TH.push(th); }
  // 空中連線（角色卡 → 三鏡），每幀依位置重建曲線
  const air = [0, 1, 2].map(() => {
    const geo = new THREE.TubeGeometry(new THREE.LineCurve3(new THREE.Vector3(), new THREE.Vector3(0, 0, 1)), 60, 0.012, 8, false);
    const m = threadMaterial(PINK, 3); const mesh = new THREE.Mesh(geo, m); mesh.renderOrder = 5; scene.add(mesh); mesh.visible = false; return { mesh, u: m.uniforms };
  });
  // 實體膠囊
  const capC = UI.drawCapsule(TEX["char-chongzhen"].image, "崇祯", 140);
  const capTex = canvasTex(capC);
  const caps = kf.map(k => {
    const w = 0.52, h = w / capTex.userData.aspect;
    const m = imageMaterial({ map: capTex, w, h, radius: 0, transparent: true }); m.uniforms.uPremul.value = 1;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), m); mesh.rotation.x = -Math.PI / 2;
    const sl = k.imgs[0].sl; mesh.position.set(sl.x - sl.w / 2 + w / 2 + 0.05, k.thick + 0.012, sl.z - sl.h / 2 + h / 2 + 0.05); mesh.renderOrder = 6;
    k.pivot.add(mesh); return { mesh, m };
  });
  Object.assign(MING, { proj, ch, art, kf, vids, fin, TH, air, caps, nodes: [proj, ch, art, ...kf, ...vids, fin] });
}

/* 升空隊形：角色卡在左，三鏡斜排在右，全部直立面向鏡頭 */
const CL = { look: new THREE.Vector3(12.1, 2.6, 0.6), camA: new THREE.Vector3(10.4, 2.75, 8.6), camB: new THREE.Vector3(12.9, 2.55, 8.2) };
const FORM = {
  ch: { p: new THREE.Vector3(9.95, 2.2, 0.75), s: 1.26 },
  kf: [{ p: new THREE.Vector3(12.45, 3.08, 0.35), s: 1.08 }, { p: new THREE.Vector3(13.85, 2.02, 1.15), s: 1.14 }, { p: new THREE.Vector3(12.55, 1.02, 1.55), s: 1.02 }],
};
const Q_FLAT = new THREE.Quaternion();
function uprightQuat(p, towards) {
  const yaw = Math.atan2(towards.x - p.x, towards.z - p.z);
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, yaw, 0, "YXZ"));
}

/* =====================================================================================
 * 三維導演台（暗場白模）
 * ===================================================================================== */
const STG = { c: new THREE.Vector3(28, 0, 0), items: [] };
function buildStage() {
  const g = new THREE.Group(); scene.add(g); STG.g = g; const c = STG.c;
  const clay = new THREE.MeshStandardMaterial({ color: "#d9dce3", roughness: 0.78 });
  const lac = new THREE.MeshStandardMaterial({ color: "#6a221d", roughness: 0.5 });
  const stone = new THREE.MeshStandardMaterial({ color: "#8c909a", roughness: 0.9 });
  const add = (mesh, delay, kind = "rise") => { mesh.castShadow = true; mesh.receiveShadow = true; g.add(mesh); STG.items.push({ mesh, delay, kind, base: mesh.scale.clone() }); return mesh; };
  for (const sx of [-1, 1]) for (let i = 0; i < 5; i++) {
    const z = c.z - 4.4 + i * 2.05;
    const pg = new THREE.CylinderGeometry(0.17, 0.19, 3.1, 40); pg.translate(0, 1.55, 0);
    add(new THREE.Mesh(pg, lac), 0.05 * i + (sx > 0 ? 0.03 : 0)).position.set(c.x + sx * 1.85, 0, z);
    const bg = new THREE.CylinderGeometry(0.3, 0.33, 0.2, 40); bg.translate(0, 0.1, 0);
    add(new THREE.Mesh(bg, stone), 0.05 * i).position.set(c.x + sx * 1.85, 0, z);
  }
  const wallG = new THREE.BoxGeometry(6.4, 3.6, 0.25); wallG.translate(0, 1.8, 0);
  add(new THREE.Mesh(wallG, clay), 0.28).position.set(c.x, 0, c.z - 5.6);
  const doorM = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.3, 0.8, 0.42) });
  const door = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 2.3), doorM); door.position.set(c.x, 1.15, c.z - 5.46); g.add(door); STG.door = door; STG.doorM = doorM;
  const rugG = new THREE.PlaneGeometry(1.5, 10.5); rugG.rotateX(-Math.PI / 2);
  const rug = new THREE.Mesh(rugG, new THREE.MeshStandardMaterial({ color: "#4b1614", roughness: 1 })); rug.position.set(c.x, 0.006, c.z - 0.3); rug.receiveShadow = true; g.add(rug); STG.rug = rug;
  const man = (x, z, delay, h = 1, hero = false) => {
    const grp = new THREE.Group(); grp.position.set(x, 0, z);
    const b = new THREE.Mesh(new THREE.CapsuleGeometry(0.2 * h, 0.82 * h, 8, 20), hero ? new THREE.MeshStandardMaterial({ color: "#e8c877", roughness: 0.55 }) : clay); b.position.y = 0.66 * h; b.castShadow = true; grp.add(b);
    const hd = new THREE.Mesh(new THREE.SphereGeometry(0.15 * h, 24, 18), clay); hd.position.y = 1.36 * h; hd.castShadow = true; grp.add(hd);
    g.add(grp); STG.items.push({ mesh: grp, delay, kind: "pop", base: new THREE.Vector3(1, 1, 1) }); return grp;
  };
  STG.hero = man(c.x, c.z + 1.1, 0.35, 1, true);
  const spearM = new THREE.MeshStandardMaterial({ color: "#555a66", roughness: 0.6 });
  [[-0.95, -1.4], [0.95, -1.4], [-0.95, -3.1], [0.95, -3.1]].forEach(([dx, dz], i) => {
    const m = man(c.x + dx, c.z + dz, 0.45 + i * 0.05, 0.98);
    const sp = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 2.3, 8), spearM); sp.position.set(dx > 0 ? -0.26 : 0.26, 1.15, 0.05); sp.castShadow = true; m.add(sp);
  });
  const lan = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.28, 0.2), new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 1.35, 0.6) }));
  lan.position.set(c.x + 0.36, 0.92, c.z + 1.28); g.add(lan); STG.lan = lan;
  const pl = new THREE.PointLight(0xffb866, 0, 7, 1.8); pl.position.copy(lan.position); g.add(pl); STG.pl = pl;
  const rim = new THREE.DirectionalLight(0x9fb8ff, 0); rim.position.set(c.x - 4, 6, c.z - 8); rim.target.position.copy(c); g.add(rim, rim.target); STG.rim = rim;
  const catcher = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.ShadowMaterial({ opacity: 0.55, color: 0x000000 }));
  catcher.rotation.x = -Math.PI / 2; catcher.position.set(c.x, 0.003, c.z); catcher.receiveShadow = true; g.add(catcher); STG.catcher = catcher;
  // 機位路徑 + 關鍵幀點 + 虛擬攝影機（視錐）
  const pts = [new THREE.Vector3(c.x + 3.4, 2.7, c.z + 5.2), new THREE.Vector3(c.x + 2.3, 2.0, c.z + 4.3), new THREE.Vector3(c.x + 1.1, 1.55, c.z + 3.7), new THREE.Vector3(c.x + 0.25, 1.28, c.z + 3.55)];
  STG.curve = new THREE.CatmullRomCurve3(pts, false, "centripetal");
  const pathGeo = new THREE.TubeGeometry(STG.curve, 200, 0.012, 8, false);
  const pathM = threadMaterial(new THREE.Color(1, 1, 1), STG.curve.getLength()); pathM.uniforms.uCore.value = 1.4; pathM.uniforms.uPulseAmt.value = 4;
  STG.path = new THREE.Mesh(pathGeo, pathM); g.add(STG.path);
  STG.dots = [0, 0.33, 0.66, 1].map(u => { const d = new THREE.Mesh(new THREE.SphereGeometry(0.045, 20, 14), new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 2.2, 2.2) })); d.position.copy(STG.curve.getPointAt(u)); g.add(d); return d; });
  const gz = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.19, 0.34), new THREE.MeshStandardMaterial({ color: "#9aa3b2", roughness: 0.35, metalness: 0.2 })); gz.add(body);
  const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.085, 0.14, 24), new THREE.MeshStandardMaterial({ color: "#23262e", roughness: 0.3 })); lens.rotation.x = Math.PI / 2; lens.position.z = -0.22; gz.add(lens);
  const d = 1.3, w = 0.62, h = 0.35;
  const fr = [0, 0, 0, -w, h, -d, 0, 0, 0, w, h, -d, 0, 0, 0, -w, -h, -d, 0, 0, 0, w, -h, -d, -w, h, -d, w, h, -d, w, h, -d, w, -h, -d, w, -h, -d, -w, -h, -d, -w, -h, -d, -w, h, -d];
  const fg = new THREE.BufferGeometry(); fg.setAttribute("position", new THREE.Float32BufferAttribute(fr, 3));
  gz.add(new THREE.LineSegments(fg, new THREE.LineBasicMaterial({ color: new THREE.Color(3.0, 1.5, 0.35), transparent: true })));
  g.add(gz); STG.gizmo = gz;
  g.visible = false;
}

/* =====================================================================================
 * 作品牆（全部 Eimu 自家產出）
 * ===================================================================================== */
const WALL = { tiles: [], labels: [] };
function buildWall() {
  const c = STG.c;
  const items = [
    ["q-12.0", "qinB", "史诗场面", "《始皇帝的北境征途》"], ["showcase1", null, "商品广告", "GPT Image 2 · 官方案例"], ["m-26.5", "mingB", "小说影视化", "《大明最后的十七年》"],
    ["showcase3", null, "双语海报", "中英排版 · 官方案例"], ["q-17.6", "qinA", "一句话成片", "《始皇帝的北境征途》"], ["showcase2", null, "文字渲染", "精酿标签 · 官方案例"],
    ["m-5.6", "mingA", "角色一致", "《大明最后的十七年》"], ["showcase4", null, "复杂空间", "维多利亚火车站 · 官方案例"], ["showcase5", null, "室内趋势", "静谧主义 · 官方案例"],
  ];
  const tw = 2.66, td = 1.56;
  items.forEach(([img, vid, title, sub], i) => {
    const col = i % 3, row = Math.floor(i / 3);
    const x = c.x + (col - 1) * 3.05, z = c.z + (row - 1) * 2.15 - 0.1;
    const slots = [{ x: 0, z: 0, w: tw - 0.1, h: td - 0.1, r: 0.075 }];
    const t = new Tile({ x, z, w: tw, d: td, r: 0.12, thick: 0.06, drawn: { canvas: null, slots }, images: [vid ? VID[vid].tex : TEX[img]], name: "wall" + i });
    t.vid = vid; t.still = TEX[img];
    const lc = UI.drawLabel(title, sub, 2.6, 400);
    const lt = canvasTex(lc);
    const lm = imageMaterial({ map: lt, w: 2.6, h: 0.34, transparent: true }); lm.uniforms.uPremul.value = 1;
    const lab = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 0.34), lm); lab.rotation.x = -Math.PI / 2; lab.position.set(x - tw / 2 + 1.3 + 0.02, 0.004, z + td / 2 + 0.24); lab.renderOrder = 2; scene.add(lab);
    WALL.tiles.push(t); WALL.labels.push({ lab, lm, t });
  });
  // 片尾字標 + 玻璃透鏡
  const wc = UI.drawWordmark("Eimu", 700);
  const wt = canvasTex(wc, true);
  const hh = 1.95, ww = hh * wt.userData.aspect;
  const wm = imageMaterial({ map: wt, w: ww, h: hh, transparent: true, opaque: true }); wm.uniforms.uPremul.value = 1;
  WALL.word = new THREE.Mesh(new THREE.PlaneGeometry(ww, hh), wm); WALL.word.position.set(c.x, 3.55, c.z - 13.5); scene.add(WALL.word); WALL.wm = wm;
  // 背板柔光（不透明，讓透鏡折射到顏色）
  const gc = document.createElement("canvas"); gc.width = 1024; gc.height = 512; const gx = gc.getContext("2d");
  gx.fillStyle = "#eef1f6"; gx.fillRect(0, 0, 1024, 512);
  const blob = (x, y, r, col) => { const g = gx.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, col); g.addColorStop(1, "rgba(238,241,246,0)"); gx.fillStyle = g; gx.fillRect(0, 0, 1024, 512); };
  blob(360, 220, 340, "rgba(170,205,255,.75)"); blob(660, 200, 330, "rgba(244,190,218,.62)"); blob(512, 300, 240, "rgba(196,236,252,.5)");
  const fadeG = gx.createLinearGradient(0, 250, 0, 430); fadeG.addColorStop(0, "rgba(238,241,246,0)"); fadeG.addColorStop(1, "rgba(238,241,246,1)");
  gx.fillStyle = fadeG; gx.fillRect(0, 0, 1024, 512);
  const gt = canvasTex(gc, false);
  const gm = imageMaterial({ map: gt, w: 40, h: 20, transparent: false, opaque: true });
  WALL.glow = new THREE.Mesh(new THREE.PlaneGeometry(40, 20), gm); WALL.glow.position.set(c.x, 4.2, c.z - 19); scene.add(WALL.glow); WALL.gm = gm;
  const s = new THREE.Shape(); const lw = 3.4, lh = 1.55, lr = lh / 2;
  s.moveTo(-lw / 2 + lr, -lh / 2); s.lineTo(lw / 2 - lr, -lh / 2); s.absarc(lw / 2 - lr, 0, lr, -Math.PI / 2, Math.PI / 2); s.lineTo(-lw / 2 + lr, lh / 2); s.absarc(-lw / 2 + lr, 0, lr, Math.PI / 2, Math.PI * 1.5);
  const lg = new THREE.ExtrudeGeometry(s, { depth: 0.26, bevelEnabled: true, bevelThickness: 0.2, bevelSize: 0.2, bevelSegments: 12, curveSegments: 48 });
  lg.translate(0, 0, -0.13);
  WALL.lens = new THREE.Mesh(lg, glassMat({ roughness: 0.015, thickness: 1.0, ior: 1.5, dispersion: 3, attenuationDistance: 10, envMapIntensity: 1.6, transparent: false }));
  WALL.lens.position.set(c.x - 9, 3.55, c.z - 11.9); scene.add(WALL.lens);
}

/* =====================================================================================
 * 相機：分段 Hermite 軌道
 * ===================================================================================== */
const SEG = [];
function keysToTrack(keys) {
  let lastYaw = null;
  const ks = keys.map(k => {
    let yaw = k.yaw, pitch = k.pitch;
    if (k.look) [yaw, pitch] = yawPitch(k.pos, k.look);
    if (lastYaw !== null) { while (yaw - lastYaw > Math.PI) yaw -= Math.PI * 2; while (yaw - lastYaw < -Math.PI) yaw += Math.PI * 2; }
    lastYaw = yaw;
    const f = k.fp || k.look || [k.pos[0], 0, k.pos[2]];
    return { t: k.t, stop: k.stop, v: [...k.pos, yaw, pitch, k.roll || 0, k.fov || 32, ...f, k.ap ?? 0.0025, k.mb ?? 0.01] };
  });
  return new Track(ks);
}
function seg(a, b, fn) { SEG.push({ a, b, fn }); }
function camState(t) {
  let s = SEG[0]; for (const x of SEG) if (t >= x.a) s = x;
  return s.fn(t);
}
const unpack = v => ({ pos: [v[0], v[1], v[2]], yaw: v[3], pitch: v[4], roll: v[5], fov: v[6], fp: [v[7], v[8], v[9]], ap: v[10], mb: v[11] });

function fillDist(h, fov) { return (h / 2) / Math.tan(deg(fov) / 2); }
function setupCamera() {
  const fin = QIN.final, sl = fin.imgs[0].sl;
  const fc = [fin.x + sl.x, fin.thick + 0.003, fin.z + sl.z];
  const fov0 = 30, dFill = fillDist(sl.w / ASPECT, fov0) * 0.995;
  QIN.fc = fc;
  // 影院冷開：正上方俯視成片磚，逐鏡緩推
  T.qinClips.forEach(([a, b], i) => {
    const b2 = i === 3 ? T.pull[0] : b;
    seg(a === 0.5 && i === 0 ? 0 : a, b2, t => {
      const u = P(t, a, b2);
      const m = lerp(1.0, i === 3 ? 0.9 : 0.94, ease.inOutSoft(u));
      return { pos: [fc[0], fc[1] + dFill * m, fc[2]], yaw: 0, pitch: -Math.PI / 2, roll: 0, fov: fov0, fp: fc, ap: 0, mb: 0 };
    });
  });
  const endCold = [fc[0], fc[1] + dFill * 0.9, fc[2]];
  const trA = keysToTrack([
    { t: T.pull[0], pos: endCold, yaw: 0, pitch: -Math.PI / 2, fov: fov0, fp: fc, ap: 0, mb: 0 },
    { t: 7.45, pos: [fc[0] - 0.35, 3.3, fc[2] + 0.9], yaw: 0.04, pitch: deg(-80), fov: 31, fp: fc, ap: 0.0012, mb: 0.006 },
    { t: 8.55, pos: [fc[0] - 2.4, 6.2, fc[2] + 4.4], yaw: 0.2, pitch: deg(-58), fov: 33, fp: fc, ap: 0.0022, mb: 0.009 },
    { t: T.pull[1], pos: [fc[0] - 3.6, 6.9, fc[2] + 5.9], yaw: 0.27, pitch: deg(-50), fov: 34, fp: [-1.5, 0, 0], ap: 0.0022, mb: 0.009 },
    { t: 10.05, pos: [-4.2, 6.1, 5.6], yaw: 0.16, pitch: deg(-50), fov: 34, fp: [-4.5, 0, 0.3], ap: 0.0026, mb: 0.011 },
    { t: 10.85, pos: [-8.6, 5.0, 4.9], yaw: 0.06, pitch: deg(-52), fov: 33, fp: [-8.6, 0, 0], ap: 0.003, mb: 0.012 },
    { t: 11.35, pos: [-12.2, 4.6, 4.6], yaw: 0.02, pitch: deg(-49), fov: 31, fp: [-12.8, 0, 0], ap: 0.003, mb: 0.012 },
    { t: T.rewind[1], pos: [-13.62, 4.35, 3.95], yaw: 0.0, pitch: deg(-47.5), fov: 30, fp: [-13.6, 0.08, 0], ap: 0.0034, mb: 0.013, stop: true },
    { t: 14.05, pos: [-13.6, 4.05, 3.66], yaw: 0.0, pitch: deg(-47.5), fov: 30, fp: [-13.6, 0.08, 0], ap: 0.0036, mb: 0.013, stop: true },
    { t: 14.7, pos: [-12.4, 4.6, 4.4], yaw: 0.0, pitch: deg(-50), fov: 31, fp: [-12.0, 0.05, 0], ap: 0.0032, mb: 0.012 },
    { t: 15.4, pos: [-10.6, 5.6, 5.6], yaw: 0.08, pitch: deg(-50), fov: 33, fp: [-9.7, 0, 0], ap: 0.0028, mb: 0.011 },
    { t: 16.35, pos: [-6.6, 5.9, 6.3], yaw: 0.07, pitch: deg(-49), fov: 34, fp: [-6.4, 0, 0], ap: 0.0028, mb: 0.011 },
    { t: 17.45, pos: [-3.2, 6.3, 9.4], yaw: 0.0, pitch: deg(-40), fov: 34, fp: [-3.0, 0, 0.5], ap: 0.0022, mb: 0.01 },
    { t: 18.9, pos: [-4.4, 8.4, 12.6], yaw: 0.02, pitch: deg(-39), fov: 34, fp: [-4.0, 0, 0.5], ap: 0.0016, mb: 0.008 },
    { t: T.build[1], pos: [-0.6, 9.2, 13.0], yaw: -0.06, pitch: deg(-40), fov: 34, fp: [-2.0, 0, 0.5], ap: 0.0016, mb: 0.008 },
    { t: 21.05, pos: [6.6, 7.4, 9.0], yaw: -0.14, pitch: deg(-38), fov: 34, fp: [9.5, 0.5, 0.5], ap: 0.002, mb: 0.009 },
    { t: 22.45, pos: CL.camA.toArray(), look: CL.look.toArray(), fov: 34, fp: FORM.ch.p.toArray(), ap: 0.0028, mb: 0.011 },
    { t: 24.1, pos: [11.7, 2.62, 8.45], look: [12.35, 2.5, 0.7], fov: 33, fp: FORM.ch.p.toArray(), ap: 0.003, mb: 0.011 },
    { t: 25.0, pos: CL.camB.toArray(), look: [12.9, 2.35, 0.75], fov: 33, fp: FORM.kf[1].p.toArray(), ap: 0.003, mb: 0.011 },
  ]);
  seg(T.pull[0], T.film[0], t => unpack(trA.at(t)));
  // 推進提燈一鏡：直到畫面填滿（之後維持正視 + 緩推）
  const f1 = FORM.kf[1], yawF = Math.atan2(CL.camB.x - f1.p.x, CL.camB.z - f1.p.z);
  const kfSl = MING.kf[1].imgs[0].sl;
  const n = new THREE.Vector3(Math.sin(yawF), 0, Math.cos(yawF));
  const slotH = kfSl.h * f1.s, slotW = kfSl.w * f1.s;
  const dF = Math.min(fillDist(slotH, 30), fillDist(slotW / ASPECT, 30)) * 0.995;
  // 影像槽中心的世界座標（直立後：局部 z → 世界 -y）
  const slotCenter = f1.p.clone().add(new THREE.Vector3(kfSl.x * f1.s * Math.cos(yawF), -kfSl.z * f1.s + MING.kf[1].thick * 0, -kfSl.x * f1.s * Math.sin(yawF))).add(n.clone().multiplyScalar(MING.kf[1].thick * f1.s + 0.004));
  MING.slotCenter = slotCenter; MING.yawF = yawF; MING.n = n;
  const posFill = k => slotCenter.clone().add(n.clone().multiplyScalar(dF * k)).toArray();
  const trB = keysToTrack([
    { t: T.film[0], pos: CL.camB.toArray(), look: [12.9, 2.35, 0.75], fov: 33, fp: slotCenter.toArray(), ap: 0.003, mb: 0.011 },
    { t: T.alive, pos: posFill(1.0), yaw: yawF, pitch: 0, fov: 30, fp: slotCenter.toArray(), ap: 0.0008, mb: 0.004, stop: true },
    { t: T.film[1], pos: posFill(0.9), yaw: yawF, pitch: 0, fov: 30, fp: slotCenter.toArray(), ap: 0, mb: 0, stop: true },
  ]);
  seg(T.film[0], T.stage[0], t => unpack(trB.at(t)));
  // 舞台 → 作品牆 → 片尾（連續）
  const c = STG.c; const vEnd = STG.curve.getPointAt(1);
  const trC = keysToTrack([
    { t: T.stage[0], pos: [c.x + 6.8, 3.5, c.z + 8.4], look: [c.x + 0.2, 1.0, c.z - 0.6], fov: 32, fp: [c.x, 1, c.z + 0.5], ap: 0.0022, mb: 0.01 },
    { t: 33.1, pos: [c.x + 4.4, 3.0, c.z + 9.1], look: [c.x + 0.1, 1.1, c.z - 0.2], fov: 32, fp: [c.x, 1, c.z + 1], ap: 0.0026, mb: 0.011 },
    { t: 34.7, pos: [c.x - 2.6, 2.7, c.z + 8.6], look: [c.x + 0.3, 1.1, c.z + 0.2], fov: 32, fp: [c.x, 1, c.z + 1.1], ap: 0.0028, mb: 0.011 },
    { t: 35.75, pos: [vEnd.x, vEnd.y, vEnd.z], look: [c.x + 0.05, 1.12, c.z + 1.0], fov: 34, fp: [c.x, 1.1, c.z + 1.1], ap: 0.0034, mb: 0.012, stop: true },
    { t: T.stage[1], pos: [vEnd.x - 0.05, vEnd.y + 0.02, vEnd.z - 0.25], look: [c.x + 0.05, 1.12, c.z + 1.0], fov: 34, fp: [c.x, 1.1, c.z + 1.1], ap: 0.0034, mb: 0.012, stop: true },
  ]);
  seg(T.stage[0], T.wall[0], t => unpack(trC.at(t)));
  const trD = keysToTrack([
    { t: T.wall[0], pos: [c.x - 2.6, 4.1, c.z + 6.4], pitch: deg(-34), yaw: 0.1, fov: 33, fp: [c.x - 0.6, 0, c.z + 1.2], ap: 0.0026, mb: 0.01 },
    { t: 37.6, pos: [c.x - 3.2, 5.9, c.z + 7.9], pitch: deg(-40), yaw: 0.06, fov: 33, fp: [c.x, 0, c.z + 0.6], ap: 0.002, mb: 0.009 },
    { t: 39.1, pos: [c.x - 4.4, 9.3, c.z + 8.6], pitch: deg(-48), yaw: 0.02, fov: 33, fp: [c.x, 0, c.z], ap: 0.0013, mb: 0.007 },
    { t: T.wall[1], pos: [c.x - 4.6, 10.1, c.z + 7.2], pitch: deg(-54), yaw: 0.0, fov: 33, fp: [c.x, 0, c.z], ap: 0.0013, mb: 0.007 },
    { t: 43.0, pos: [c.x, 8.2, c.z + 1.2], pitch: deg(-26), yaw: 0, fov: 33, fp: [c.x, 2, c.z - 8], ap: 0.0012, mb: 0.007 },
    { t: 44.2, pos: [c.x, 3.55, c.z - 2.4], pitch: deg(-4.5), yaw: 0, fov: 33, fp: [c.x, 3.55, c.z - 13.5], ap: 0.0012, mb: 0.007, stop: true },
    { t: DUR, pos: [c.x, 3.52, c.z - 3.3], pitch: deg(-4.2), yaw: 0, fov: 33, fp: [c.x, 3.55, c.z - 13.5], ap: 0.0012, mb: 0.007, stop: true },
  ]);
  seg(T.wall[0], DUR + 1, t => unpack(trD.at(t)));
}

/* =====================================================================================
 * DOM 疊字
 * ===================================================================================== */
function lines(el, t, tin, tout, { step = 0.09, dur = 0.9, out = 0.45, dy = 110 } = {}) {
  const spans = el.querySelectorAll(".ln > span");
  let any = false;
  spans.forEach((s, i) => {
    const a = ease.outQuint(P(t, tin + i * step, tin + i * step + dur));
    const q = ease.inCubic(P(t, tout + i * 0.04, tout + i * 0.04 + out));
    s.style.transform = `translate3d(0, ${((1 - a) * dy - q * dy * 0.35).toFixed(2)}%, 0)`;
    s.style.opacity = (Math.min(1, a * 1.4) * (1 - q)).toFixed(3);
    if (a * (1 - q) > 0.001) any = true;
  });
  const cap = el.querySelector(".cap");
  if (cap) { const a = ease.out(P(t, tin + 0.35, tin + 1.2)), q = P(t, tout, tout + out * 0.8); cap.style.opacity = (a * (1 - q)).toFixed(3); cap.style.transform = `translate3d(0, ${((1 - a) * 14).toFixed(1)}px, 0)`; if (a * (1 - q) > 0.001) any = true; }
  el.style.visibility = any ? "visible" : "hidden";
}
function cine(el, t, tin, tout) {
  const spans = el.querySelectorAll(".ln");
  let any = false;
  spans.forEach((s, i) => {
    const a = ease.out(P(t, tin + i * 0.7, tin + i * 0.7 + 1.1)), q = ease.inCubic(P(t, tout, tout + 0.45));
    s.style.opacity = (a * (1 - q)).toFixed(3);
    s.style.letterSpacing = `${(0.1 + 0.06 * P(t, tin, tout + 0.4)).toFixed(4)}em`;
    s.style.filter = `blur(${((1 - a) * 6 + q * 4).toFixed(2)}px)`;
    if (a * (1 - q) > 0.001) any = true;
  });
  el.style.visibility = any ? "visible" : "hidden";
}

/* =====================================================================================
 * 每幀狀態
 * ===================================================================================== */
const tmpV = new THREE.Vector3();
function worldLight(t) {
  // 0=影院黑，1=珍珠白；舞台另計
  if (t < T.pull[0]) return 0;
  if (t < T.light[1]) return ease.inOutSoft(P(t, T.light[0], T.light[1]));
  return 1;
}
function stageMix(t) {
  return t >= T.stage[0] && t < T.wall[0] ? 1 : 0;
}

function qinBuildAmt(n, t) {
  if (n === QIN.prompt) return 1;
  if (t < T.rewind[0]) return 1;
  if (t < T.prompt[0]) { const tu = QIN.tun.get(n); return 1 - ease.inCubic(P(t, tu - 0.05, tu + 0.3)); }
  const tb = QIN.tb.get(n); return P(t, tb, tb + 0.55);
}
function qinReveal(n, t) {
  const f = QIN.fill.get(n); if (f === undefined) return 1;
  if (t < T.rewind[0]) return 1;
  if (t < T.prompt[0]) { const tu = QIN.tun.get(n); return 1 - P(t, tu - 0.22, tu + 0.05); }
  return ease.inOutSoft(P(t, f, f + 0.55));
}

function updateQin(t, light, visible) {
  for (const n of QIN.nodes) {
    if (!visible) { n.set({ b: 0, o: 0 }); continue; }
    const b = qinBuildAmt(n, t);
    const tb = QIN.tb.get(n);
    const sweep = t > T.prompt[0] && tb > 0 ? lerp(-0.3, 1.5, P(t, tb + 0.1, tb + 0.8)) : -1;
    n.set({ b, reveal: qinReveal(n, t), t, sweep: sweep > 1.45 ? -1 : sweep, dim: light, shimSeed: hash(n.x * 3 + n.z) });
  }
  // 成片磚：影院段落保持全亮（不受世界光影響）
  const fu = QIN.final.imgs[0].m.uniforms; fu.uBright.value = 1;
  // 連線
  for (const { th, a, b } of QIN.threads) {
    const u = th.u; let draw = 1, back = 0;
    if (!visible) { th.mesh.visible = false; continue; }
    if (t < T.rewind[0]) draw = 1;
    else if (t < T.prompt[0]) { const tu = QIN.tun.get(b), ta = a === QIN.prompt ? T.rewind[1] - 0.2 : QIN.tun.get(a); draw = 1 - P(t, tu - 0.15, Math.max(tu + 0.1, ta)); }
    else { const t0 = (a === QIN.prompt ? T.send + 0.02 : QIN.tb.get(a) + 0.18), t1 = QIN.tb.get(b) + 0.05; draw = ease.inOutSoft(P(t, t0, t1)); }
    th.mesh.visible = draw > 0.001;
    u.uDraw.value = draw * 1.001; u.uBack.value = back;
    u.uCore.value = 0.85 * light; u.uHead.value = 5 * light; u.uOpacity.value = 0.85 * light + 0.001;
    const run = (t * 0.42 + th.seed) % 1, run2 = (t * 0.42 + th.seed + 0.5) % 1;
    const flowing = draw >= 1 ? 1 : 0;
    const rev = t > T.rewind[0] && t < T.prompt[0];
    u.uPulse.value.set(flowing ? (rev ? 1 - run : run) : -9, flowing ? (rev ? 1 - run2 : run2) : -9, -9);
    u.uPulseAmt.value = (rev ? 9 : 5) * light;
  }
  // 提示框：打字 + 游標 + 發送
  const pt = QIN.prompt, L = [...PROMPT].length;
  let n;
  if (t < 11.0) n = L;
  else if (t < T.prompt[0]) n = Math.round(L * (1 - P(t, 11.0, 11.55)));
  else n = t < T.type ? 0 : clamp(Math.floor((t - T.type) / T.typeStep) + 1, 0, L);
  const typing = (t >= T.type && t < T.type + T.typeStep * L + 0.08) || (t >= 11.0 && t < 11.6);
  const caret = t >= 11.0 && t < T.send + 0.05 && (typing || Math.floor(t * 1.9) % 2 === 0);
  const shown = [...PROMPT].slice(0, n).join("");
  const k = shown + "|" + caret;
  if (k !== pt.lastKey) { pt.pad.draw(shown, caret, "描述你的想法……", shown ? 0 : 1); pt.padTex.needsUpdate = true; pt.lastKey = k; }
  QIN.btnMat.color.set(n > 0 ? "#2d3142" : "#bcc2ca");
  const press = t < T.send ? P(t, T.send - 0.08, T.send) : 1 - spring(t, T.send, 320, 14);
  QIN.btn.position.y = 0.08 + 0.035 - 0.022 * clamp(press, -0.5, 1.2);
  const rp = P(t, T.send, T.send + 0.7);
  QIN.ring.scale.setScalar(1 + ease.out(rp) * 2.2); QIN.ringM.opacity = t > T.send ? (1 - ease.out(rp)) * 0.55 : 0; QIN.ring.visible = t > T.send && rp < 1;
}

function updateMing(t, light, visible) {
  const M = MING;
  const liftU = i => ease.inOutSoft(P(t, 21.3 + i * 0.2, 22.75 + i * 0.2));
  for (const n of M.nodes) n.root.visible = visible;
  if (!visible) { M.nodes.forEach(n => n.set({ b: 0, o: 0 })); M.TH.forEach(th => th.mesh.visible = false); M.air.forEach(a => a.mesh.visible = false); return; }
  const others = 1 - 0.5 * ease.inOutSoft(P(t, 21.4, 22.6));
  for (const n of M.nodes) {
    n.set({ b: 1, reveal: 1, t, dim: light * (n === M.ch || M.kf.includes(n) ? 1 : others) });
  }
  const cut = 1 - P(t, 21.2, 21.6);
  M.TH.forEach(th => { const k = th.lifted ? cut : 1; th.mesh.visible = k > 0.001; th.u.uDraw.value = 1.001; th.u.uCore.value = 1.0 * light * others; th.u.uOpacity.value = 0.85 * others * k; const r = (t * 0.4 + th.seed) % 1; th.u.uPulse.value.set(r, -9, -9); th.u.uPulseAmt.value = 4 * others * k; });
  // 角色卡與三鏡升空
  const lifts = [[M.ch, FORM.ch, 0], ...M.kf.map((k, i) => [k, FORM.kf[i], i + 1])];
  for (const [tile, f, i] of lifts) {
    const u = liftU(i);
    const from = new THREE.Vector3(tile.x, 0, tile.z);
    const to = f.p.clone().sub(new THREE.Vector3(0, 0, 0));
    const mid = from.clone().lerp(to, 0.5); mid.y += 0.9;
    const p = new THREE.Vector3().copy(from).multiplyScalar((1 - u) * (1 - u)).add(mid.clone().multiplyScalar(2 * u * (1 - u))).add(to.clone().multiplyScalar(u * u));
    // 懸停微擺
    p.y += Math.sin(t * 1.2 + i * 1.7) * 0.03 * u * (1 - P(t, 25.3, 25.85));
    tile.root.position.copy(p);
    const q = Q_FLAT.clone().slerp(uprightQuat(f.p, CL.camB.clone().lerp(CL.camA, 0.5)), ease.inOutSoft(P(t, 21.45 + i * 0.2, 22.85 + i * 0.2)));
    if (tile === M.kf[1]) q.copy(Q_FLAT.clone().slerp(new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, MING.yawF, 0, "YXZ")), ease.inOutSoft(P(t, 21.45 + i * 0.2, 22.85 + i * 0.2))));
    tile.root.quaternion.copy(q);
    tile.root.scale.setScalar(lerp(1, f.s, u));
    tile.upright = u;
  }
  // 空中連線：角色卡右緣 → 各鏡左緣
  const chR = new THREE.Vector3(M.ch.w / 2 - 0.03, M.ch.thick, 0).applyQuaternion(M.ch.root.quaternion).multiplyScalar(M.ch.root.scale.x).add(M.ch.root.position);
  M.air.forEach((a, i) => {
    const k = M.kf[i]; const kl = new THREE.Vector3(-k.w / 2 + 0.03, k.thick, 0).applyQuaternion(k.root.quaternion).multiplyScalar(k.root.scale.x).add(k.root.position);
    const drawU = ease.inOutSoft(P(t, 22.75 + i * 0.12, 23.45 + i * 0.12));
    a.mesh.visible = drawU > 0.001 && t < T.film[0] + 0.5;
    if (!a.mesh.visible) return;
    const c0 = chR.clone().add(new THREE.Vector3(0.7, 0.1, 0.25)), c1 = kl.clone().add(new THREE.Vector3(-0.7, 0, 0.25));
    const curve = new THREE.CubicBezierCurve3(chR, c0, c1, kl);
    a.mesh.geometry.dispose(); a.mesh.geometry = new THREE.TubeGeometry(curve, 60, 0.011, 8, false);
    a.u.uLen.value = curve.getLength(); a.u.uDraw.value = drawU * 1.001;
    const r = (t * 0.5 + i * 0.33) % 1; a.u.uPulse.value.set(drawU >= 1 ? r : -9, -9, -9); a.u.uPulseAmt.value = 6; a.u.uCore.value = 1.3; a.u.uOpacity.value = 1 - P(t, T.film[0], T.film[0] + 0.5);
  });
  // 膠囊
  M.caps.forEach((c, i) => { const a = ease.out(P(t, 23.05 + i * 0.14, 23.5 + i * 0.14)) * (1 - P(t, 25.75, 26.1)); c.m.uniforms.uOpacity.value = a; c.mesh.visible = a > 0.002; c.mesh.scale.setScalar(lerp(0.6, 1, spring(t, 23.05 + i * 0.14, 260, 15))); });
  // 提燈一鏡：靜幀 → 活過來（切換為影片紋理）
  const lanternImg = M.kf[1].imgs[0];
  const alive = t >= T.alive;
  const want = alive ? VID.mingA.tex : TEX["m-5.6"];
  if (lanternImg.m.uniforms.uMap.value !== want) M.kf[1].cover(lanternImg, want);
}

function updateStage(t) {
  const on = t >= T.stage[0] && t < T.wall[0];
  STG.g.visible = on; if (!on) { STG.pl.intensity = 0; STG.rim.intensity = 0; return; }
  const t0 = T.stage[0];
  const sink = 0; STG.g.position.y = 0;
  for (const it of STG.items) {
    const u = ease.outQuint(P(t, t0 + 0.05 + it.delay, t0 + 0.75 + it.delay));
    const s = Math.max(0.0001, u);
    if (it.kind === "rise") it.mesh.scale.set(1, s, 1);
    else it.mesh.scale.setScalar(Math.max(0.0001, lerp(0.001, 1, spring(t, t0 + 0.2 + it.delay, 200, 16))));
  }
  const lanU = ease.out(P(t, t0 + 0.6, t0 + 1.4)) * (1 - sink);
  STG.lan.scale.setScalar(Math.max(0.0001, lanU)); STG.pl.intensity = 2.6 * lanU;
  STG.rim.intensity = 1.8 * (1 - sink) * P(t, t0, t0 + 0.6);
  STG.doorM.color.setRGB(1.3 * (1 - sink), 0.8 * (1 - sink), 0.42 * (1 - sink));
  STG.door.visible = sink < 0.99;
  STG.rug.visible = sink < 0.99;
  // 路徑繪製 + 虛擬攝影機
  const pu = ease.inOutSoft(P(t, t0 + 0.9, t0 + 1.9));
  STG.path.visible = pu > 0.001 && sink < 0.999;
  const pm = STG.path.material.uniforms; pm.uDraw.value = pu * 1.001; pm.uOpacity.value = (1 - sink) * (1 - P(t, 35.3, 35.75));
  const run = (t * 0.6) % 1; pm.uPulse.value.set(pu >= 1 ? run : -9, -9, -9);
  STG.dots.forEach((d, i) => { const a = spring(t, t0 + 1.0 + i * 0.22, 260, 13); d.scale.setScalar(Math.max(0.0001, a * (1 - sink) * (1 - P(t, 35.3, 35.75)))); });
  const vu = ease.inOutSoft(P(t, 33.0, 35.6));
  const vp = STG.curve.getPointAt(vu);
  STG.gizmo.position.copy(vp); STG.gizmo.lookAt(STG.c.x + 0.05, 1.12, STG.c.z + 1.0);
  const gA = ease.out(P(t, t0 + 1.4, t0 + 2.0)) * (1 - P(t, 35.25, 35.6)) * (1 - sink);
  STG.gizmo.scale.setScalar(Math.max(0.0001, gA));
  STG.catcher.material.opacity = 0.55 * (1 - sink); STG.catcher.position.y = 0.003 + 3.8 * sink;
  SU.uWarmPos.value.set(STG.lan.position.x, STG.lan.position.z); SU.uWarmAmt.value = lanU;
}

function updateWall(t, light) {
  const on = t > T.wall[0] - 0.01;
  WALL.tiles.forEach((tile, i) => {
    if (!on) { tile.set({ b: 0, o: 0 }); return; }
    const col = i % 3, row = Math.floor(i / 3);
    const dly = (Math.abs(col - 1) + Math.abs(row - 1)) * 0.12;
    const b = P(t, T.wall[0] - 0.75 + dly * 0.6, T.wall[0] + 0.3 + dly * 0.6);
    tile.set({ b, reveal: 1, t, dim: 1 });
  });
  WALL.labels.forEach(({ lm, t: tile }, i) => { const col = i % 3, row = Math.floor(i / 3); const dly = (Math.abs(col - 1) + Math.abs(row - 1)) * 0.12; lm.uniforms.uOpacity.value = on ? ease.out(P(t, T.wall[0] + 0.6 + dly, T.wall[0] + 1.2 + dly)) : 0; lm.uniforms.uReveal.value = 1.2; });
  WALL.word.visible = t > 41.0; WALL.lens.visible = t > 41.0; WALL.glow.visible = t > 41.0;
  WALL.gm.uniforms.uOpacity.value = 1; WALL.gm.uniforms.uBright.value = 1;
  // 玻璃膠囊滑入，微彈停在字標正中 → 最終品牌鎖定
  const lu = spring(t, 44.1, 9, 4.5);
  WALL.lens.position.x = STG.c.x - 10 * (1 - lu);
  WALL.lens.rotation.y = -0.3 * (1 - lu); WALL.lens.rotation.z = 0.06 * (1 - lu);
  WALL.lens.position.y = 3.55 + 0.012 * Math.sin(t * 1.3) * P(t, 46.5, 47.5);
}

/* =====================================================================================
 * renderFrame
 * ===================================================================================== */
// opts（封面模式）：cam={pos, look|yaw/pitch, fov, fp, ap, mb} 覆蓋機位；qinVid 指定成片磚畫面；noOverlay 隱藏疊字；grain/vig 覆蓋調色
async function renderFrame(t, opts = {}) {
  let cs = camState(t);
  if (opts.cam) {
    const c = opts.cam; let yaw = c.yaw, pitch = c.pitch;
    if (c.look) [yaw, pitch] = yawPitch(c.pos, c.look);
    cs = { pos: c.pos, yaw, pitch, roll: c.roll || 0, fov: c.fov || 32, fp: c.fp || c.look, ap: c.ap ?? 0.002, mb: c.mb ?? 0.01 };
  }
  const hw = t > T.pull[1] && t < T.film[0] - 0.4 || (t > T.stage[0] && t < DUR) ? 1 : 0;
  camera.position.set(cs.pos[0], cs.pos[1], cs.pos[2]);
  camera.rotation.set(cs.pitch + hw * 0.0022 * wobble(t, 2), cs.yaw + hw * 0.003 * wobble(t, 1), cs.roll + hw * 0.0015 * wobble(t, 3));
  camera.fov = cs.fov; camera.updateProjectionMatrix();
  const light = worldLight(t), sm = stageMix(t);

  // 世界氛圍
  const cinemaQin = t < T.pull[0] + 0.02;
  const cinemaMing = t >= T.alive + 0.2 && t < T.stage[0];
  scene.background.copy(BLACK).lerp(PEARL, light).lerp(STAGE_BG, sm);
  SU.uLight.value = Math.max(0.0, light); SU.uStageMix.value = sm; SU.uTime.value = t;
  SU.uCam.value.copy(camera.position);
  SU.uFog.value.copy(PEARL).lerp(STAGE_BG, sm);
  SU.uFogNear.value = lerp(16, 12, sm); SU.uFogFar.value = lerp(48, 30, sm);
  SU.uPoolShift.value.set(Math.sin(t * 0.05) * 1.5, Math.cos(t * 0.04) * 1.2);
  SU.uDots.value = 1 - P(t, 42.6, 44.2);
  scene.environmentIntensity = lerp(1, 0.28, sm) * (0.25 + 0.75 * light);
  hemi.intensity = 0.55 * light * (1 - sm * 0.85);
  key.intensity = 1.6 * light * (1 - sm * 0.65);
  key.position.set(STG.c.x - 6, 12, STG.c.z + 7); key.target.position.copy(STG.c);

  const qinVisible = t < T.stage[0];
  updateQin(t, light, qinVisible);
  updateMing(t, light, t > T.pull[0] + 0.5 && t < T.stage[0]);
  updateStage(t);
  updateWall(t, light);

  // 影片取幀
  const jobs = [];
  if (t < T.rewind[1]) {
    let cl = T.qinClips[0]; for (const c of T.qinClips) if (t >= c[0]) cl = c;
    jobs.push(seek("qinA", cl[2] + Math.max(0, t - cl[0])));
  } else if (t >= T.build[0] && t < T.stage[0]) {
    jobs.push(seek("qinA", opts.qinVid ?? (0.6 + Math.max(0, t - (T.send + 3.1)))));
  }
  if (t >= T.alive - 0.05 && t < T.stage[0]) {
    let cl = T.mingClips[0]; for (const c of T.mingClips) if (t >= c[0]) cl = c;
    jobs.push(seek("mingA", cl[2] + Math.max(0, t - cl[0])));
  }
  if (t >= T.wall[0]) {
    const lt = t - T.wall[0];
    jobs.push(seek("qinA", 15.7 + lt), seek("qinB", 10.45 + lt), seek("mingA", 5.1 + lt), seek("mingB", 25.95 + lt * 0.35));
  }
  await Promise.all(jobs);

  // 景深
  const fd = camera.position.distanceTo(tmpV.set(cs.fp[0], cs.fp[1], cs.fp[2]));
  bokeh.uniforms.focus.value = fd; bokeh.uniforms.aperture.value = cs.ap; bokeh.uniforms.maxblur.value = cs.mb;
  bloom.strength = cinemaQin || cinemaMing ? 0.28 : lerp(0.5, 0.32, sm);
  bloom.threshold = cinemaQin || cinemaMing ? 0.92 : lerp(1.0, 0.95, sm);

  // 調色
  const fu = film.uniforms;
  fu.uSeed.value = Math.round(t * 30);
  const cineAmt = cinemaQin || cinemaMing ? 1 : 0;
  fu.uGrain.value = lerp(0.022, 0.05, cineAmt) + sm * 0.015;
  fu.uVig.value = (lerp(0.22, 0.6, cineAmt) + sm * 0.25) * (1 - 0.6 * P(t, 42.6, 44.4));
  fu.uCA.value = lerp(0.22, 0.6, cineAmt);
  fu.uContrast.value = lerp(1.0, 1.06, cineAmt); fu.uSat.value = 1.0;
  const fadeIn = 1 - P(t, 0.0, 0.5);
  const fadeOut = ease.inOutSoft(P(t, DUR - 0.6, DUR));
  fu.uFade.value = Math.max(fadeIn, fadeOut);
  if (fadeIn > fadeOut) fu.uFadeCol.value.setRGB(0, 0, 0, THREE.LinearSRGBColorSpace); else fu.uFadeCol.value.setRGB(0.933, 0.945, 0.965, THREE.LinearSRGBColorSpace);

  if (opts.grain !== undefined) fu.uGrain.value = opts.grain;
  if (opts.vig !== undefined) fu.uVig.value = opts.vig;
  if (opts.cam) camera.rotation.set(cs.pitch, cs.yaw, cs.roll);
  composer.render();
  if (opts.noOverlay) { $("ov").style.display = "none"; return; }
  $("ov").style.display = "";
  overlays(t);
}

function overlays(t) {
  // 遮幅
  let lb = 0;
  if (t < T.lbOut[1]) lb = 1 - ease.inOutSoft(P(t, T.lbOut[0], T.lbOut[1]));
  else if (t >= T.film[0]) lb = ease.inOutSoft(P(t, T.alive - 0.35, T.alive + 0.25)) * (1 - P(t, T.stage[0] - 0.001, T.stage[0]));
  const bh = 138 * lb;
  $("lb-top").style.height = bh.toFixed(1) + "px"; $("lb-bot").style.height = bh.toFixed(1) + "px";
  $("cr-qin").style.opacity = (lb > 0.9 && t < T.pull[0] ? ease.out(P(t, 1.2, 2.2)) * (1 - P(t, 5.9, 6.3)) : 0).toFixed(3);
  $("cr-ming").style.opacity = (t > T.alive && t < T.stage[0] ? ease.out(P(t, T.alive + 0.6, T.alive + 1.4)) * (1 - P(t, 31.0, 31.4)) : 0).toFixed(3);
  cine($("t0"), t, T.title0[0], T.title0[1]);
  lines($("t1"), t, T.title1[0], T.title1[1]);
  lines($("t2"), t, T.title2[0], T.title2[1]);
  lines($("t3"), t, T.title3[0], T.title3[1]);
  lines($("t4"), t, T.title4[0], T.title4[1]);
  lines($("t5"), t, T.title5[0], T.title5[1]);
  const e = $("end");
  const a = ease.out(P(t, 46.1, 47.05)), b = ease.out(P(t, 46.6, 47.55));
  e.querySelector(".tag").style.opacity = a.toFixed(3); e.querySelector(".tag").style.transform = `translate3d(0,${((1 - a) * 16).toFixed(1)}px,0)`;
  e.querySelector(".url").style.opacity = b.toFixed(3); e.querySelector(".url").style.letterSpacing = `${(0.34 + 0.08 * P(t, 46.05, DUR)).toFixed(3)}em`;
  e.style.visibility = a > 0.001 ? "visible" : "hidden";
}

/* =====================================================================================
 * 啟動
 * ===================================================================================== */
function cues() {
  CUES.boom.push(0.5, 1.72, 2.86, 3.92, T.alive, 27.9, 28.8, 29.62, 30.5, T.stage[0], T.wall[0]);
  CUES.whoosh.push(6.45, 9.35, 14.25, 20.55, 25.95, 41.8, 44.1);
  CUES.rewind.push(T.rewind[0]);
  const n = [...PROMPT].length; for (let i = 0; i < n; i++) CUES.tick.push(T.type + i * T.typeStep);
  CUES.pop.push(T.send, 23.05, 23.19, 23.33);
  CUES.pluck.push(...[0, 1, 2, 3].map(i => T.stage[0] + 1.0 + i * 0.22));
  CUES.shimmer.push(T.alive - 0.05, 45.2);
  CUES.bloom.push(46.1);
  CUES.chime.push(T.wall[0] + 0.6);
}

window.ready = (async () => {
  await document.fonts.load('650 100px "Geist"'); await document.fonts.load('500 20px "GeistMono"');
  await document.fonts.load('700 80px "Noto Sans CJK SC"'); await document.fonts.load('400 80px "Noto Sans CJK SC"'); await document.fonts.load('600 60px "Noto Serif SC"');
  await document.fonts.ready;
  const imgs = ["char-emperor2", "char-bear", "scene-snow", "char-chongzhen", "q-1.5", "q-6.8", "q-8.6", "q-12.0", "q-17.6", "q-22.6", "q-27.6", "q-32.6", "m-0.8", "m-5.6", "m-7.2", "m-16.4", "m-20.5", "m-26.5", "m-38.6", "m-57.5"];
  await Promise.all([
    ...imgs.map(k => loadTex(k, `assets/${k}.jpg`)),
    ...[1, 2, 3, 4, 5].map(i => loadTex(`showcase${i}`, `assets/showcase${i}.webp`)),
    makeVideo("qinA", "../eval-qinshihuang-polarbear/final-36s-stitched.mp4", 24),
    makeVideo("qinB", "../eval-qinshihuang-polarbear/final-36s-stitched.mp4", 24),
    makeVideo("mingA", "../public/showcase/agent-templates/novel-film-3.mp4", 24),
    makeVideo("mingB", "../public/showcase/agent-templates/novel-film-3.mp4", 24),
  ]);
  buildQin(); buildMing(); buildStage(); buildWall();
  setupCamera(); qinSchedule(); cues();
  window.__dbg = { scene, camera, renderer, QIN, MING, STG, WALL, T };
  // 硬切點：動態模糊子幀不得跨越
  CUES.cuts = [0.5, 1.72, 2.86, 3.92, ...T.mingClips.slice(1).map(c => c[0]), T.stage[0], T.wall[0]];
  window.__camTrace = (dt = 0.01) => { const out = []; let prev = null; for (let t = 0; t <= DUR; t += dt) { const c = camState(t); if (prev) { const v = Math.hypot(c.pos[0] - prev.pos[0], c.pos[1] - prev.pos[1], c.pos[2] - prev.pos[2]) / dt; const w = Math.hypot(c.yaw - prev.yaw, c.pitch - prev.pitch) / dt; out.push([+t.toFixed(2), +v.toFixed(3), +w.toFixed(3), +c.fov.toFixed(2)]); } prev = c; } return out; };
  await renderFrame(0);
  return CUES;
})();
window.renderFrame = renderFrame;
