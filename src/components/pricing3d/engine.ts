/* ╁━ /pricing 3D 卡堆引擎（手写 three，无 R3F、无物理引擎）╁━
   只被 PricingStage3D 以 import() 动态载入 —— three 不进首屏包；首屏是 SSR 梦境底图 + 价格玻璃层。

   构成：
   - 一个 WebGLRenderer = 全页唯一 WebGL context（离屏/分页隐藏暂停，卸载 dispose 全部）；
   - 一个 InstancedMesh 画所有作品卡（一次 draw call）：每张卡从一张 4×4 贴图图集里
     取自己的裁切窗（aUvRect），所以卡卡不同；
   - 玻璃只在边缘与光掠过处：卡体是实的（MeshPhysical + clearcoat），侧面换成淡玻璃色，
     再在 shader 里叠 fresnel 边缘高光与一条可触发的掠光带（aGlint）；
   - 动态全是手写：落下（抛物线 → 指数衰减弹跳）、拨散（惯性 + 摩擦 + 回收弹簧）、
     翻面（角速度 + 就近平躺吸附）、拾起转一圈（导演曲线）、点击弹跳（重力 + 反弹）。 */

import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { CARD_D, CARD_T, CARD_W, buildWorld, type WorldRig } from "./scenes";
import type { PricingSound } from "./sound";
import { createFilmAtlas } from "./film-atlas";
import { SHOWCASE_POOL, WORLD_IDS, cardCountForCoins, thumbOf, type WorldId } from "./worlds";

export interface Pricing3DEngine {
  setWorld(id: WorldId, coins: number): void;
  /** 自订滑杆拖动中：卡堆原地平滑伸缩，不落。 */
  setCoinsLive(coins: number): void;
  /** 松手 / 切档：重落一轮。 */
  redrop(): void;
  /** 拖曳拨动：px/ms，正 = 向右。 */
  swipe(velocity: number): void;
  /** 悬停：NDC 座标，null = 离开。 */
  hover(x: number | null, y: number): void;
  /** 点击：NDC 座标。 */
  tap(x: number, y: number): void;
  resize(width: number, height: number): void;
  setActive(active: boolean): void;
  setReducedMotion(reduced: boolean): void;
  /** 以静止解析度画一帧并回传画面（产低端机静态图用；透明底）。 */
  snapshot(type?: string, quality?: number): string;
  dispose(): void;
}

export interface EngineInit {
  canvas: HTMLCanvasElement;
  compact: boolean;
  reducedMotion: boolean;
  world: WorldId;
  coins: number;
  sound: PricingSound | null;
  onFirstFrame(): void;
  onFailure(): void;
  /** 解析度已降到地板仍 < 24fps：宿主可改走静态图（不给就照旧减卡数）。 */
  onSlow?(): void;
}

/* ── 导演参数（快慢在这里调，不在物理里）── */
const FALL_S = 0.42; // 单张从出场到触桌
const DROP_SPAN_S = 1.9; // 整堆出场时间上限（加上落下与沉降 ≈ 2–4 秒；溢出卡最后才滑落）
const SPILL_FALL = 1.7; // 溢出卡从台沿滑落到地面比直落多花的时间倍率
const DROP_STAGGER_MAX = 0.16;
const DROP_STAGGER_MIN = 0.006;
const SETTLE_S = 0.9;
const PICK_S = 1.55; // 悬停拾起：升起 → 在光下转一圈 → 放回
const GATHER_AFTER_S = 1.6; // 拨散后多久开始自己收回
const FRICTION = 3.6; // 滑动摩擦（1/s）
const GRAVITY = 9.8;
/** 卡面本地 uv（与 BoxGeometry 上表面的 uv 同向），边缘内缩半个像素避免取到邻格。 */
const LOCAL_UV_GLSL = `clamp(vec2(position.x / ${CARD_W.toFixed(3)} + 0.5, 0.5 - position.z / ${CARD_D.toFixed(3)}), 0.004, 0.996)`;
const ATLAS_COLS = 5;
const ATLAS_ROWS = 4;

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const nearest = (angle: number, period: number) => Math.round(angle / period) * period;

export function createPricing3DEngine(init: EngineInit): Pricing3DEngine {
  const { canvas, compact, sound } = init;
  let reduced = init.reducedMotion;
  let quality = 0; // 0 全效 / 1 减卡数（解析度走动态解析度，阴影不再降）
  const CAP = compact ? 140 : 420;
  let cap = CAP;

  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: !compact,
    powerPreference: "high-performance",
    preserveDrawingBuffer: false,
  });
  renderer.setClearColor(0x000000, 0);
  /* 生产不查 shader 编译日志（2026-10-01 效能）：three 预设在 program 首次使用时呼叫 getShaderInfoLog／
     getProgramInfoLog，Intel/Mesa 这类不支援平行编译的驱动会在这里同步等编译完——实测滚动切档时主线程卡
     1.2s。开发环境保留检查，著色器写错照样看得到报错。 */
  renderer.debug.checkShaderErrors = process.env.NODE_ENV !== "production";
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  /* Neutral（Khronos PBR Neutral）：不像 ACES 那样把饱和色压灰——作品要鲜，不要老照片。 */
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  /* 精度（2026-09-27 暴君「不要渲染成 GTA3 级古董贴图」）：
     dpr=1 的机器原本 ratio 1.0 = 零超取样，边缘全是阶梯；这里给一个超取样地板，
     弱机也至少 1.75 倍渲染再降采样；dpr 高的机器最多 2（再上去是白烧 fill rate）。 */
  const ratioFloor = compact ? 1.25 : 1.75;
  const basePixelRatio = Math.min(2, Math.max(window.devicePixelRatio || 1, ratioFloor));
  let pixelRatio = basePixelRatio;
  renderer.setPixelRatio(pixelRatio);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const roomEnv = new RoomEnvironment();
  const envTarget = pmrem.fromScene(roomEnv, 0.04);
  roomEnv.dispose();
  scene.environment = envTarget.texture;

  const camera = new THREE.PerspectiveCamera(34, 2, 0.1, 80);
  const camBase = new THREE.Vector3();
  const camTarget = new THREE.Vector3();
  const sway = { x: 0, y: 0, tx: 0, ty: 0 };
  let viewW = 2;
  let viewH = 1;

  /* ── 作品卡图集：每格一张底片（片基 + 镂空齿孔 + 边码 + 鲜艳作品），见 film-atlas.ts ── */
  let atlasTimer = 0;
  const film = createFilmAtlas({
    cols: ATLAS_COLS,
    rows: ATLAS_ROWS,
    slotW: compact ? 320 : 640,
    aspect: CARD_D / CARD_W,
    sources: SHOWCASE_POOL.slice(0, ATLAS_COLS * ATLAS_ROWS).map((full) => ({ thumb: thumbOf(full), full })),
    onPaint: () => {
      if (atlasTimer || disposed) return;
      atlasTimer = window.setTimeout(() => {
        atlasTimer = 0;
        if (disposed) return;
        atlas.needsUpdate = true;
        kick();
      }, 140);
    },
  });
  const atlas = new THREE.CanvasTexture(film.canvas);
  atlas.colorSpace = THREE.SRGBColorSpace;
  atlas.anisotropy = renderer.capabilities.getMaxAnisotropy();

  /* ── 作品卡：一个 InstancedMesh ── */
  const cardGeo = new THREE.BoxGeometry(CARD_W, CARD_T, CARD_D);
  /* BoxGeometry 面序：+x −x +y −y +z −z，各 4 顶点 → ±y（正反面）是 8..15。 */
  const faceAttr = new Float32Array(24);
  for (let i = 8; i < 16; i += 1) faceAttr[i] = 1;
  cardGeo.setAttribute("aFace", new THREE.BufferAttribute(faceAttr, 1));
  const uvRect = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 4), 4);
  const glintAttr = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 2), 2);
  glintAttr.setUsage(THREE.DynamicDrawUsage);
  cardGeo.setAttribute("aUvRect", uvRect);
  cardGeo.setAttribute("aGlint", glintAttr);

  const rimUniform = { value: new THREE.Color(0xffffff) };
  const cardMat = new THREE.MeshPhysicalMaterial({
    map: atlas,
    roughness: 0.42,
    metalness: 0,
    clearcoat: 0.3,
    clearcoatRoughness: 0.26,
    /* 2026-09-27：逆光（台后的天光）掠过近水平的卡面，粗糙度 0.42 的镜面瓣会把整片卡洗成一团白雾
       （逐物件隐藏实测：关掉逆光，雾消失）。卡面基底镜面压到三成，只留 clearcoat 那道窄高光。 */
    specularIntensity: 0.3,
    ior: 1.5,
    alphaTest: 0.5, // 底片齿孔真镂空
  });
  cardMat.onBeforeCompile = (shader) => {
    shader.uniforms.uRim = rimUniform;
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nattribute vec4 aUvRect;\nattribute float aFace;\nattribute vec2 aGlint;\nvarying float vFace;\nvarying vec2 vLocalUv;\nvarying vec2 vGlint;",
      )
      .replace(
        "#include <uv_vertex>",
        /* 贴图座标一律由本地位置算（上下面与四个侧面同一套）：侧面取到的是载体边缘的颜色与 alpha，
           拍立得的白边、底片的黑边自然延伸成厚度；载体轮廓外（alpha 0）侧面一起被裁掉。 */
        `#include <uv_vertex>\nvFace = aFace;\nvLocalUv = ${LOCAL_UV_GLSL};\nvGlint = aGlint;\n#ifdef USE_MAP\nvMapUv = aUvRect.xy + vLocalUv * aUvRect.zw;\n#endif`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform vec3 uRim;\nvarying float vFace;\nvarying vec2 vLocalUv;\nvarying vec2 vGlint;")
      .replace(
        "#include <map_fragment>",
        /* 侧面 = 玻璃边：图色压暗再混一口冷白，读起来是「一块有厚度的玻璃的切边」。 */
        "#include <map_fragment>\ndiffuseColor.rgb = mix(diffuseColor.rgb * 0.72, diffuseColor.rgb, vFace);",
      )
      .replace(
        "#include <opaque_fragment>",
        [
          /* 卡面像灯箱上的正片：62% 直接取作品原色（不被打光压暗、不被环境反射洗白），
             38% 保留受光明暗，堆里的层次还在。 */
          "outgoingLight = mix(outgoingLight, diffuseColor.rgb * 1.08, vFace * 0.62);",
          "float pFres = pow(1.0 - clamp(abs(dot(normal, normalize(vViewPosition))), 0.0, 1.0), 3.0);",
          "float pEdge = max((1.0 - vFace) * 0.3, smoothstep(0.44, 0.5, max(abs(vLocalUv.x - 0.5), abs(vLocalUv.y - 0.5))));",
          "outgoingLight += uRim * (pFres * (0.22 + 0.78 * pEdge) * 0.5 + pEdge * 0.06);",
          "float pBand = exp(-pow((vLocalUv.x * 0.62 + (1.0 - vLocalUv.y) * 0.38) - vGlint.y, 2.0) * 70.0);",
          "outgoingLight += uRim * pBand * vGlint.x * 1.5;",
          "#include <opaque_fragment>",
        ].join("\n"),
      );
  };
  cardMat.customProgramCacheKey = () => "pricing3d-card-v3";

  /* 阴影也照载体轮廓投（拍立得、幻灯片的影子不是一整块长方形）。 */
  const depthMat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: atlas, alphaTest: 0.5 });
  depthMat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute vec4 aUvRect;")
      .replace("#include <uv_vertex>", `#include <uv_vertex>\n#ifdef USE_MAP\nvMapUv = aUvRect.xy + (${LOCAL_UV_GLSL}) * aUvRect.zw;\n#endif`);
  };
  depthMat.customProgramCacheKey = () => "pricing3d-card-depth-v1";

  const cards = new THREE.InstancedMesh(cardGeo, cardMat, CAP);
  cards.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  cards.castShadow = true;
  cards.customDepthMaterial = depthMat;
  cards.receiveShadow = true;
  cards.frustumCulled = false;
  scene.add(cards);

  /* ── 每张卡的状态（定长阵列，零 GC）── */
  const slotX = new Float32Array(CAP);
  const slotY = new Float32Array(CAP);
  const slotFloor = new Float32Array(CAP);
  const slotPitch = new Float32Array(CAP);
  /* 溢出卡：台子装不下，从台沿滑落、掉到地上（起点 = 台沿最近点）。 */
  const spillFrom = new Float32Array(CAP * 3);
  let spillPile = -1;
  const slotZ = new Float32Array(CAP);
  const slotYaw = new Float32Array(CAP);
  const slotLevel = new Int32Array(CAP);
  const slotPile = new Int32Array(CAP);
  const tableY = new Float32Array(CAP);
  const ox = new Float32Array(CAP);
  const oz = new Float32Array(CAP);
  const vx = new Float32Array(CAP);
  const vz = new Float32Array(CAP);
  const fallMix = new Float32Array(CAP);
  const flip = new Float32Array(CAP);
  const vflip = new Float32Array(CAP);
  const spin = new Float32Array(CAP);
  const vspin = new Float32Array(CAP);
  const hop = new Float32Array(CAP);
  const vhop = new Float32Array(CAP);
  const glint = new Float32Array(CAP);
  const glintPos = new Float32Array(CAP);
  const presence = new Float32Array(CAP);
  const presenceTarget = new Float32Array(CAP);
  const dropStart = new Float32Array(CAP);
  const dropFrom = new Float32Array(CAP);
  const dropYaw = new Float32Array(CAP);
  const dropRoll = new Float32Array(CAP);
  const landed = new Uint8Array(CAP);
  const rand = new Float32Array(CAP);
  const pileTopLevel: number[] = [];

  /* 额度超出设备卡数上限时，塔不再加卡、改为拉高（2 万 → 100 万金币仍一眼更满，
     一路冲出镜头上缘）；滑杆拖动时平滑伸缩。 */
  let stretch = 1;
  /* 进场运镜：落卡时镜头从高处远处缓缓推进（电影开场的 push-in），落定时刚好到位。 */
  let introStart = -10;
  const INTRO_S = 3.2;
  let stretchTarget = 1;
  const stretchFor = (coins: number) => Math.min(4, Math.max(1, Math.pow(cardCountForCoins(coins) / Math.max(1, cap), 0.45)));

  const rigs = new Map<WorldId, WorldRig>();
  let rig: WorldRig | null = null;
  let count = 0;
  let dropEnd = 0;
  let lastSwipe = -10;
  let pickIndex = -1;
  let pickStart = 0;
  let hoverIndex = -1;
  let hoverNdc: THREE.Vector2 | null = null;
  const raycaster = new THREE.Raycaster();

  let raf = 0;
  let active = true;
  let disposed = false;
  let firstFrame = false;
  let lastTs = 0;
  let frameAcc = 0;
  let frameN = 0;

  const now = () => performance.now() / 1000;
  const dummy = new THREE.Object3D();
  const euler = new THREE.Euler(0, 0, 0, "YZX");

  function getRig(id: WorldId) {
    let r = rigs.get(id);
    if (!r) {
      r = buildWorld(id, { compact, shadows: true });
      rigs.set(id, r);
    }
    return r;
  }

  /** 卡位：按「(层 + 0.5) / 堆权重」排序填位 —— 张数变化时每一堆都在长，塔高错落。 */
  function layoutSlots(r: WorldRig, worldIndex: number) {
    const onPiles = Math.min(CAP, r.capacity);
    spillPile = r.piles.length;
    const sumW = r.piles.reduce((sum, p) => sum + p.weight, 0);
    const entries: Array<{ p: number; level: number; cost: number }> = [];
    r.piles.forEach((pile, p) => {
      const levels = Math.ceil((CAP * pile.weight) / sumW) + 6;
      for (let level = 0; level < levels; level += 1) entries.push({ p, level, cost: (level + 0.5) / pile.weight });
    });
    entries.sort((a, b) => a.cost - b.cost || a.p - b.p);
    const rnd = mulberry(97 + worldIndex * 131);
    const perm = SHOWCASE_POOL.map((_, i) => i).sort(() => rnd() - 0.5);
    const floorCells = new Map<string, number>();
    for (let i = 0; i < CAP; i += 1) {
      rand[i] = rnd();
      const [u0, v0, uw, vh] = film.uv(perm[i % perm.length] % film.slots);
      uvRect.setXYZW(i, u0, v0, uw, vh);
      slotPitch[i] = 0;
      if (i >= onPiles && i < onPiles + r.spill.max) {
        /* ── 溢出：台面满了，多出来的作品从台沿掉到地上，越多铺得越远（前方为主，镜头看得到）──
           地上重叠处往上叠（粗网格计数），少数斜倚著台边。 */
        const k = i - onPiles;
        const sp = r.spill;
        const theta = (rnd() * 2 - 1) * sp.arc * (0.55 + 0.45 * rnd());
        const reach = Math.min(1, Math.sqrt((k + 1) / sp.full)) * (0.55 + 0.45 * rnd());
        const rr = sp.rIn + (sp.rOut - sp.rIn) * reach;
        const x = sp.x + Math.sin(theta) * rr;
        const z = sp.z + Math.cos(theta) * rr;
        const key = `${Math.round(x / 0.55)}:${Math.round(z / 0.55)}`;
        const stacked = floorCells.get(key) ?? 0;
        floorCells.set(key, stacked + 1);
        slotX[i] = x;
        slotZ[i] = z;
        slotY[i] = sp.y + CARD_T * (0.5 + stacked);
        slotFloor[i] = slotY[i];
        slotYaw[i] = rnd() * Math.PI * 2;
        slotPitch[i] = rr < sp.rIn + 0.35 && rnd() < 0.35 ? 0.28 + rnd() * 0.3 : (rnd() - 0.5) * 0.1;
        slotLevel[i] = 1000 + k;
        slotPile[i] = spillPile;
        tableY[i] = slotY[i];
        spillFrom[i * 3] = sp.x + Math.sin(theta) * sp.edge;
        spillFrom[i * 3 + 1] = sp.edgeY + 0.1;
        spillFrom[i * 3 + 2] = sp.z + Math.cos(theta) * sp.edge;
        continue;
      }
      /* 溢出名额用完之后的卡回到台上继续长高（溢出是点睛，不是山洪）。 */
      const { p, level } = entries[i < onPiles ? i : i - r.spill.max];
      const pile = r.piles[p];
      const fan = pile.fan ?? 0;
      /* 乱堆而不是一叠杂志：逐张错位 + 转角，边缘露出底下每一张作品。 */
      let x = pile.x + (rnd() - 0.5) * 0.2;
      let z = pile.z + (rnd() - 0.5) * 0.2;
      let yaw = pile.yaw + (rnd() - 0.5) * 0.9;
      if (level < fan) {
        /* 堆底摊成扇形：让底下几张作品也露脸。 */
        const side = level % 2 === 0 ? 1 : -1;
        const reach = 0.26 + 0.12 * level;
        x += side * reach * Math.cos(pile.yaw);
        z += 0.1 * (level + 1) - side * reach * 0.25;
        yaw += side * (0.32 + 0.1 * level);
      }
      const baseY = r.surfaceY + (pile.baseY ?? 0);
      slotX[i] = x;
      slotZ[i] = z;
      slotY[i] = baseY + level * CARD_T + CARD_T / 2;
      slotFloor[i] = baseY;
      slotYaw[i] = yaw;
      slotLevel[i] = level;
      slotPile[i] = p;
      tableY[i] = r.surfaceY + CARD_T * (0.5 + (i % 3));
    }
    uvRect.needsUpdate = true;
  }

  function recountPiles() {
    pileTopLevel.length = 0;
    for (let i = 0; i < count; i += 1) {
      const p = slotPile[i];
      pileTopLevel[p] = Math.max(pileTopLevel[p] ?? 0, slotLevel[i]);
    }
  }

  function resetDynamics() {
    ox.fill(0);
    oz.fill(0);
    vx.fill(0);
    vz.fill(0);
    fallMix.fill(0);
    flip.fill(0);
    vflip.fill(0);
    spin.fill(0);
    vspin.fill(0);
    hop.fill(0);
    vhop.fill(0);
    glint.fill(0);
    pickIndex = -1;
    hoverIndex = -1;
  }

  function fitCamera() {
    if (!rig) return;
    const aspect = viewW / Math.max(1, viewH);
    camera.aspect = aspect;
    camera.fov = rig.camera.fov;
    /* 窄画面（手机竖屏）把机位沿视线往后拉，让主角整堆入镜。 */
    const pull = aspect < 1.7 ? Math.pow(1.7 / aspect, 0.42) : 1;
    camTarget.copy(rig.camera.target);
    camBase.copy(rig.camera.pos).sub(camTarget).multiplyScalar(pull).add(camTarget);
    /* 竖屏：价格玻璃层占了卡面下半，卡堆再往上让（不被价格层盖住）。 */
    const shift = Math.round(viewH * (aspect < 1 ? 0.26 : 0.05));
    /* 宽屏构图：卡堆再往左让，票面（DOM 玻璃层）往右推后两者不重叠（与 pricing-plan-carousel.css
       的 .ppc-glass translateX 0.46 配对）。位移按卡宽算（--case-card-w 由环写在舞台上）。
       竖屏置中、卡堆上移让出下半给票面。 */
    const cardW = Number.parseFloat(getComputedStyle(canvas).getPropertyValue("--case-card-w")) || 520;
    const shiftX = aspect > 1.3 ? Math.round(cardW * 0.42) : 0;
    camera.setViewOffset(viewW, viewH, shiftX, shift, viewW, viewH);
    camera.updateProjectionMatrix();
  }

  function applyRigLook(r: WorldRig) {
    renderer.toneMappingExposure = r.exposure;
    scene.environmentIntensity = r.envIntensity;
    scene.fog = r.fog;
    rimUniform.value.copy(r.rim);
  }

  function startDrop() {
    const t = now();
    if (reduced) {
      for (let i = 0; i < count; i += 1) {
        dropStart[i] = -1e6;
        landed[i] = 1;
      }
      dropEnd = t;
      return;
    }
    introStart = t;
    const stagger = Math.min(DROP_STAGGER_MAX, Math.max(DROP_STAGGER_MIN, DROP_SPAN_S / Math.max(1, count)));
    /* 由下往上落：先按层、同层按堆轮流 —— 每一堆都在同时长高。 */
    const order = Array.from({ length: count }, (_, i) => i).sort((a, b) => slotLevel[a] - slotLevel[b] || slotPile[a] - slotPile[b]);
    order.forEach((i, rank) => {
      dropStart[i] = t + 0.08 + rank * stagger;
      dropFrom[i] = 2.3 + rand[i] * 0.9;
      dropYaw[i] = (rand[i] - 0.5) * 2.2;
      dropRoll[i] = (rand[(i + 7) % CAP] - 0.5) * 0.9;
      landed[i] = 0;
    });
    dropEnd = t + 0.08 + count * stagger + FALL_S * SPILL_FALL + SETTLE_S;
  }

  function setCount(n: number, immediate: boolean) {
    count = Math.min(cap, Math.max(1, n));
    for (let i = 0; i < CAP; i += 1) {
      presenceTarget[i] = i < count ? 1 : 0;
      if (immediate) presence[i] = presenceTarget[i];
    }
    recountPiles();
  }

  function setWorld(id: WorldId, coins: number) {
    const next = getRig(id);
    if (rig && rig !== next) scene.remove(rig.group);
    if (rig !== next) scene.add(next.group);
    rig = next;
    applyRigLook(next);
    layoutSlots(next, WORLD_IDS.indexOf(id));
    resetDynamics();
    setCount(cardCountForCoins(coins), true);
    stretchTarget = stretchFor(coins);
    stretch = stretchTarget;
    fitCamera();
    startDrop();
    kick();
  }

  /* ── 每帧 ── */
  function update(dt: number) {
    const t = now();
    let busy = t < dropEnd;
    const gathering = t - lastSwipe > GATHER_AFTER_S;
    const radius = rig?.scatterRadius ?? 1;

    if (Math.abs(stretchTarget - stretch) > 0.001) {
      stretch += (stretchTarget - stretch) * Math.min(1, dt * 6);
      busy = true;
    }

    sway.x += (sway.tx - sway.x) * Math.min(1, dt * 4);
    sway.y += (sway.ty - sway.y) * Math.min(1, dt * 4);
    if (Math.abs(sway.tx - sway.x) + Math.abs(sway.ty - sway.y) > 0.0005) busy = true;
    /* 额度越过卡数上限：镜头往卡堆推近（塔更大、前景卡盖掉一部分视线 = 溢出镜头）。 */
    const introK = reduced ? 1 : Math.min(1, (t - introStart) / INTRO_S);
    if (introK < 1) busy = true;
    const push = 1 - (1 - introK) * (1 - introK) * (1 - introK);
    const dolly = Math.max(0.58, 1 - (stretch - 1) * 0.2) * (1 + 0.28 * (1 - push));
    camera.position.set(
      camTarget.x + (camBase.x - camTarget.x) * dolly + sway.x * 0.14,
      camTarget.y + (camBase.y - camTarget.y) * dolly + sway.y * 0.07 + 0.6 * (1 - push),
      camTarget.z + (camBase.z - camTarget.z) * dolly,
    );
    camera.lookAt(camTarget);

    for (let i = 0; i < CAP; i += 1) {
      const pt = presenceTarget[i];
      if (presence[i] !== pt) {
        const step = dt * 5;
        presence[i] = Math.abs(pt - presence[i]) <= step ? pt : presence[i] + Math.sign(pt - presence[i]) * step;
        busy = true;
      }
      const p = presence[i];
      if (p <= 0.001) {
        dummy.position.set(0, -50, 0);
        dummy.scale.setScalar(0);
        dummy.rotation.set(0, 0, 0);
        dummy.updateMatrix();
        cards.setMatrixAt(i, dummy.matrix);
        continue;
      }

      /* 拨散：惯性 + 摩擦；闲下来后回收弹簧把卡收回原位、翻回正面。 */
      if (!reduced) {
        if (gathering) {
          const k = 12;
          const c = 2 * Math.sqrt(k) * 0.95;
          vx[i] += (-k * ox[i] - c * vx[i]) * dt;
          vz[i] += (-k * oz[i] - c * vz[i]) * dt;
        } else {
          const f = Math.exp(-FRICTION * dt);
          vx[i] *= f;
          vz[i] *= f;
        }
        ox[i] += vx[i] * dt;
        oz[i] += vz[i] * dt;
        const r = Math.hypot(ox[i], oz[i]);
        if (r > radius) {
          ox[i] *= radius / r;
          oz[i] *= radius / r;
          vx[i] *= 0.3;
          vz[i] *= 0.3;
        }
        const fallTarget = smooth(0.42, 0.85, r / CARD_W);
        fallMix[i] += (fallTarget - fallMix[i]) * Math.min(1, dt * 7);

        /* 翻面：角速度 + 就近平躺吸附（拨动中可停在背面；回收时翻回正面）。 */
        const airborne = hop[i] > 0.002 || vhop[i] > 0;
        if (!airborne) {
          const period = gathering ? Math.PI * 2 : Math.PI;
          const k = 38;
          vflip[i] += (-k * (flip[i] - nearest(flip[i], period)) - 2 * Math.sqrt(k) * 0.8 * vflip[i]) * dt;
        } else {
          vflip[i] *= Math.exp(-0.6 * dt);
        }
        flip[i] += vflip[i] * dt;

        vspin[i] *= Math.exp(-2.4 * dt);
        if (gathering) vspin[i] += -spin[i] * 8 * dt;
        spin[i] += vspin[i] * dt;

        /* 点击弹跳：重力 + 小反弹（第二下触桌给一声轻叮）。 */
        if (hop[i] > 0 || vhop[i] !== 0) {
          vhop[i] -= GRAVITY * dt;
          hop[i] += vhop[i] * dt;
          if (hop[i] <= 0) {
            hop[i] = 0;
            if (vhop[i] < -0.9) {
              vhop[i] = -vhop[i] * 0.32;
              sound?.tick(Math.min(1, -vhop[i] / 2));
            } else {
              vhop[i] = 0;
            }
          }
        }

        if (
          Math.abs(vx[i]) + Math.abs(vz[i]) > 0.002 ||
          Math.abs(ox[i]) + Math.abs(oz[i]) > 0.002 ||
          Math.abs(vflip[i]) > 0.01 ||
          Math.abs(vspin[i]) > 0.01 ||
          Math.abs(spin[i]) > 0.002 ||
          hop[i] > 0 ||
          Math.abs(fallTarget - fallMix[i]) > 0.002
        ) {
          busy = true;
        }
      }

      if (glint[i] > 0.002) {
        glint[i] *= Math.exp(-2.2 * dt);
        glintPos[i] += dt * 2.1;
        glintAttr.setXY(i, glint[i], glintPos[i] - 0.3);
        glintAttr.needsUpdate = true;
        busy = true;
      } else if (glint[i] !== 0) {
        glint[i] = 0;
        glintAttr.setXY(i, 0, -2);
        glintAttr.needsUpdate = true;
      }

      /* 落下：抛物线触桌 → 指数衰减弹跳沉降。 */
      let dy = 0;
      let dYaw = 0;
      let dRoll = 0;
      const s = t - dropStart[i];
      if (s < 0) {
        dummy.position.set(0, -50, 0);
        dummy.scale.setScalar(0);
        dummy.rotation.set(0, 0, 0);
        dummy.updateMatrix();
        cards.setMatrixAt(i, dummy.matrix);
        continue;
      }
      const spilled = slotPile[i] === spillPile;
      const fallS = spilled ? FALL_S * SPILL_FALL : FALL_S;
      /* 溢出卡的滑落轨迹：从台沿（稍高）出发，先被挤出去、再抛物线掉到地上。 */
      let sx = 0;
      let sy = 0;
      let sz = 0;
      if (s < fallS) {
        const k = s / fallS;
        if (spilled) {
          const e = 1 - (1 - k) * (1 - k);
          sx = (spillFrom[i * 3] - slotX[i]) * (1 - e);
          sz = (spillFrom[i * 3 + 2] - slotZ[i]) * (1 - e);
          sy = (spillFrom[i * 3 + 1] - slotY[i]) * (1 - k * k) + 0.32 * Math.sin(Math.PI * Math.min(1, k * 1.4)) * (1 - k);
          dYaw = dropYaw[i] * (1 - e) * 0.8;
          dRoll = dropRoll[i] * 1.6 * (1 - k);
        } else {
          dy = dropFrom[i] * (1 - k * k);
          dYaw = dropYaw[i] * (1 - easeInOut(k)) * 0.6;
          dRoll = dropRoll[i] * (1 - k);
        }
      } else if (s < fallS + SETTLE_S) {
        const a = s - fallS;
        if (!landed[i]) {
          landed[i] = 1;
          const loud = count > 60 ? 0.45 : 1;
          if (spilled || slotLevel[i] === 0) sound?.knock((spilled ? 0.55 : 0.8) * loud);
          else if (slotLevel[i] === pileTopLevel[slotPile[i]]) sound?.chime(0.7 * loud);
          else sound?.tick(0.8 * loud);
        }
        const bounce = spilled ? 0.5 : dropFrom[i];
        dy = 0.05 * bounce * Math.exp(-7 * a) * Math.abs(Math.sin(12 * a));
        dYaw = dropYaw[i] * 0.05 * Math.exp(-6 * a) * Math.cos(10 * a);
      }

      /* 悬停拾起：升起、朝镜头靠一点、绕长轴在光下转一整圈、放回。 */
      let lift = 0;
      let toward = 0;
      let pickRoll = 0;
      if (i === pickIndex) {
        const ps = t - pickStart;
        if (ps >= PICK_S) {
          pickIndex = -1;
        } else {
          const env = smooth(0, 0.28, ps) * (1 - smooth(PICK_S - 0.3, PICK_S, ps));
          lift = 0.62 * env;
          toward = 0.28 * env;
          pickRoll = Math.PI * 2 * easeInOut(Math.min(1, Math.max(0, (ps - 0.16) / 1.05)));
          busy = true;
        }
      }

      const stackY = slotFloor[i] + (slotY[i] - slotFloor[i]) * stretch;
      const baseY = stackY + (tableY[i] - stackY) * fallMix[i];
      const flipLift = Math.abs(Math.sin(flip[i])) * CARD_W * 0.5;
      dummy.position.set(
        slotX[i] + ox[i] + sx,
        baseY + dy + sy + hop[i] + flipLift + lift,
        slotZ[i] + oz[i] + toward + sz,
      );
      euler.set(slotPitch[i] * (1 - Math.min(1, lift * 2)), slotYaw[i] + spin[i] + dYaw, flip[i] + dRoll + pickRoll);
      dummy.quaternion.setFromEuler(euler);
      const sc = p < 1 ? 0.35 + 0.65 * p : 1;
      dummy.scale.set(sc, p < 1 ? p : 1, sc);
      dummy.updateMatrix();
      cards.setMatrixAt(i, dummy.matrix);
    }
    cards.instanceMatrix.needsUpdate = true;

    /* 悬停命中测试（每帧最多一次）。 */
    if (hoverNdc && !reduced) {
      cards.boundingSphere = null;
      raycaster.setFromCamera(hoverNdc, camera);
      const hit = raycaster.intersectObject(cards, false)[0];
      const id = hit?.instanceId ?? -1;
      if (id !== hoverIndex) {
        hoverIndex = id;
        if (id >= 0 && pickIndex < 0 && t >= dropEnd - SETTLE_S) {
          pickIndex = id;
          pickStart = t;
          glint[id] = 0.9;
          glintPos[id] = -0.2;
          sound?.chime(0.45);
          busy = true;
        }
      }
    }
    return busy;
  }

  /* 品质阶梯（2026-10-01 改）：不再关阴影——实测对核显几乎没帮助，却会让全场 shader 在互动中途重编（核显上
     最大的一次卡顿）。解析度交给下方「动态解析度」；只有降到地板仍 < 24fps 才砍卡数。 */
  function applyQuality(level: number) {
    quality = level;
    if (level >= 1) {
      cap = Math.min(CAP, 260);
      if (count > cap) setCount(cap, false);
    }
  }

  /* 动态解析度（2026-10-01）：超取样地板只在「动」的时候让步——动画中按实测帧时一格 0.25 往下降（最低到装置
     dpr，不低于 1），快了再升回去；一静下来最后一帧补回满解析度，静止画面永远是 1.75× 超取样的清晰度。
     改 pixelRatio 只是换画布尺寸，不触发 shader 重编。 */
  const motionFloor = Math.max(1, Math.min(basePixelRatio, window.devicePixelRatio || 1));
  let motionRatio = basePixelRatio;
  let motionAcc = 0;
  let motionN = 0;
  function applyPixelRatio(next: number) {
    if (next === pixelRatio) return;
    pixelRatio = next;
    renderer.setPixelRatio(next);
  }
  function tuneMotionRatio(raw: number) {
    motionAcc += raw;
    motionN += 1;
    if (motionN < 12) return;
    const avg = motionAcc / motionN;
    motionAcc = 0;
    motionN = 0;
    if (avg > 1 / 45 && motionRatio > motionFloor) motionRatio = Math.max(motionFloor, motionRatio - 0.25);
    else if (avg < 1 / 75 && motionRatio < basePixelRatio) motionRatio = Math.min(basePixelRatio, motionRatio + 0.25);
  }

  function frame(ts: number) {
    raf = 0;
    if (disposed || !active) return;
    const dt = lastTs ? Math.min(1 / 30, (ts - lastTs) / 1000) : 1 / 60;
    const raw = lastTs ? (ts - lastTs) / 1000 : 0;
    lastTs = ts;
    const busy = update(dt);
    applyPixelRatio(busy ? motionRatio : basePixelRatio);
    renderer.render(scene, camera);
    if (!firstFrame) {
      firstFrame = true;
      init.onFirstFrame();
      prebuildOthers();
    }
    /* fps 侦测：只量连续动画帧（切档那一帧的建场景成本不算），连续偏慢就降一级。 */
    if (raw > 0 && raw < 0.25 && busy) {
      tuneMotionRatio(raw);
      frameAcc += raw;
      frameN += 1;
      if (frameN >= 90) {
        const avg = frameAcc / frameN;
        frameAcc = 0;
        frameN = 0;
        /* 先让动态解析度降到地板，仍然真的卡（< 24fps）才砍量——量就是额度，砍到比梦虹还少 =
           把「越大越失控」画反。 */
        if (quality === 0 && motionRatio <= motionFloor && avg > 1 / 24) {
          if (init.onSlow) {
            quality = 1;
            init.onSlow();
          } else applyQuality(1);
        }
      }
    }
    if (busy) raf = requestAnimationFrame(frame);
    else lastTs = 0;
  }

  function kick() {
    if (raf || disposed || !active) return;
    raf = requestAnimationFrame(frame);
  }


  /**
   * 预热一个世界（2026-10-01 效能）：只预建物件不够——shader 在「第一次被画」时才在主线程编译
   * （实测滚动切档时 getProgramInfoLog 卡住主线程、单帧 733ms），贴图也是第一次画才上传。
   * 这里把它暂时挂进场景、以切过去后的同一组灯光呼叫 compileAsync：program 的建立是同步的，
   * 驱动端编译走 KHR_parallel_shader_compile 在背景完成，不再阻塞；随即摘下，下一帧照旧只画当前世界。
   */
  function warmRig(r: WorldRig) {
    if (r === rig || disposed) return;
    const prev = rig;
    const prevFog = scene.fog;
    if (prev) scene.remove(prev.group);
    scene.add(r.group);
    /* 雾也决定 shader 变体（USE_FOG／雾型）：用该世界的雾编，否则预热的是错的变体、切过去照样现编。 */
    scene.fog = r.fog;
    renderer.compileAsync(scene, camera).catch(() => {
      /* 预热失败＝退回「第一次画时编译」，不影响正确性。 */
    });
    scene.fog = prevFog;
    scene.remove(r.group);
    if (prev) scene.add(prev.group);
    r.group.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        for (const value of Object.values(m)) {
          if ((value as THREE.Texture | null)?.isTexture) renderer.initTexture(value as THREE.Texture);
        }
      }
    });
  }

  /** 其余世界在闲时预建＋预热（shader／贴图），切档硬剪接时不卡那一下（手机不预建，省记忆体）。 */
  function prebuildOthers() {
    if (compact) return;
    const queue = WORLD_IDS.filter((id) => !rigs.has(id));
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
    const idle = (cb: () => void) => (w.requestIdleCallback ? w.requestIdleCallback(cb, { timeout: 2500 }) : w.setTimeout(cb, 600));
    const next = () => {
      if (disposed) return;
      const id = queue.shift();
      if (!id) return;
      warmRig(getRig(id));
      idle(next);
    };
    idle(next);
  }

  const onLost = (event: Event) => {
    event.preventDefault();
    if (!disposed) init.onFailure();
  };
  canvas.addEventListener("webglcontextlost", onLost, false);

  setWorld(init.world, init.coins);

  return {
    setWorld,
    setCoinsLive(coins) {
      if (!rig) return;
      const n = Math.min(cap, cardCountForCoins(coins));
      stretchTarget = stretchFor(coins);
      if (n === count) {
        kick();
        return;
      }
      /* 新增的卡原地长出（不落），减少的卡原地缩掉；位置表不变，所以是「伸缩」不是「重排」。 */
      for (let i = count; i < n; i += 1) {
        dropStart[i] = -1e6;
        landed[i] = 1;
      }
      setCount(n, false);
      kick();
    },
    redrop() {
      if (!rig) return;
      resetDynamics();
      startDrop();
      kick();
    },
    swipe(velocity) {
      if (reduced || !rig || count === 0) return;
      const v = Math.max(-3, Math.min(3, velocity));
      const mag = Math.abs(v);
      if (mag < 0.05) return;
      lastSwipe = now();
      for (let i = 0; i < count; i += 1) {
        const top = pileTopLevel[slotPile[i]] ?? 0;
        const w = Math.pow((slotLevel[i] + 1) / (top + 1), 1.4) * (0.55 + rand[i]);
        vx[i] += v * 1.25 * w * (0.7 + rand[(i + 3) % CAP] * 0.6);
        vz[i] += (rand[(i + 11) % CAP] - 0.5) * mag * 0.9 * w;
        vspin[i] += v * 1.6 * w * (rand[(i + 5) % CAP] - 0.35);
        if (mag > 1.0 && rand[(i + 13) % CAP] < 0.22 * w) vflip[i] += Math.sign(v) * (8 + rand[i] * 5);
      }
      if (mag > 0.6) sound?.chime(Math.min(1, mag / 2.5));
      else sound?.tick(0.6);
      kick();
    },
    hover(x, y) {
      if (x === null) {
        hoverNdc = null;
        hoverIndex = -1;
        sway.tx = 0;
        sway.ty = 0;
      } else {
        hoverNdc = (hoverNdc ?? new THREE.Vector2()).set(x, y);
        if (!reduced) {
          sway.tx = x;
          sway.ty = y;
        }
      }
      kick();
    },
    tap(x, y) {
      if (!rig) return;
      cards.boundingSphere = null;
      raycaster.setFromCamera(new THREE.Vector2(x, y), camera);
      const hit = raycaster.intersectObject(cards, false)[0];
      const id = hit?.instanceId ?? -1;
      if (id >= 0) {
        glint[id] = 1;
        glintPos[id] = -0.2;
        if (!reduced) {
          vhop[id] = 3.3;
          hop[id] = 0.001;
          vflip[id] += Math.PI * 2 / 0.62;
          for (let i = 0; i < count; i += 1) {
            if (i !== id && slotPile[i] === slotPile[id] && Math.abs(slotLevel[i] - slotLevel[id]) <= 2) {
              vhop[i] = Math.max(vhop[i], 0.9);
              hop[i] = Math.max(hop[i], 0.001);
            }
          }
        }
        sound?.chime(1);
      } else if (!reduced) {
        for (let i = 0; i < count; i += 1) {
          const top = pileTopLevel[slotPile[i]] ?? 0;
          if (top - slotLevel[i] <= 3) {
            vhop[i] = 0.8 + rand[i] * 0.6;
            hop[i] = 0.001;
          }
        }
        sound?.knock(0.6);
      }
      kick();
    },
    snapshot(type = "image/webp", quality = 0.9) {
      applyPixelRatio(basePixelRatio);
      renderer.render(scene, camera);
      return canvas.toDataURL(type, quality);
    },
    resize(width, height) {
      viewW = Math.max(2, Math.round(width));
      viewH = Math.max(2, Math.round(height));
      renderer.setSize(viewW, viewH, false);
      fitCamera();
      kick();
    },
    setActive(next) {
      active = next;
      if (!next && raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      lastTs = 0;
      if (next) kick();
    },
    setReducedMotion(next) {
      reduced = next;
      if (next) {
        resetDynamics();
        for (let i = 0; i < count; i += 1) {
          dropStart[i] = -1e6;
          landed[i] = 1;
        }
        dropEnd = 0;
      }
      kick();
    },
    dispose() {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      if (atlasTimer) window.clearTimeout(atlasTimer);
      canvas.removeEventListener("webglcontextlost", onLost);
      for (const r of rigs.values()) {
        scene.remove(r.group);
        r.dispose();
      }
      rigs.clear();
      scene.remove(cards);
      cards.dispose();
      cardGeo.dispose();
      cardMat.dispose();
      depthMat.dispose();
      atlas.dispose();
      film.dispose();
      envTarget.dispose();
      pmrem.dispose();
      scene.environment = null;
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
