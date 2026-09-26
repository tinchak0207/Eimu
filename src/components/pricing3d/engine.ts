/* ╁━ /pricing 3D 卡堆引擎（手寫 three，無 R3F、無物理引擎）╁━
   只被 PricingStage3D 以 import() 動態載入 —— three 不進首屏包，首屏是靜態卡面 DOM。

   構成：
   - 一個 WebGLRenderer = 全頁唯一 WebGL context（離屏/分頁隱藏暫停，卸載 dispose 全部）；
   - 一個 InstancedMesh 畫所有作品卡（一次 draw call）：每張卡從一張 4×4 貼圖圖集裡
     取自己的裁切窗（aUvRect），所以卡卡不同；
   - 玻璃只在邊緣與光掠過處：卡體是實的（MeshPhysical + clearcoat），側面換成淡玻璃色，
     再在 shader 裡疊 fresnel 邊緣高光與一條可觸發的掠光帶（aGlint）；
   - 動態全是手寫：落下（拋物線 → 指數衰減彈跳）、撥散（慣性 + 摩擦 + 回收彈簧）、
     翻面（角速度 + 就近平躺吸附）、拾起轉一圈（導演曲線）、點擊彈跳（重力 + 反彈）。 */

import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { CARD_D, CARD_T, CARD_W, buildWorld, type WorldRig } from "./scenes";
import type { PricingSound } from "./sound";
import { SHOWCASE_POOL, WORLD_IDS, cardCountForCoins, type WorldId } from "./worlds";

export interface Pricing3DEngine {
  setWorld(id: WorldId, coins: number): void;
  /** 自訂滑桿拖動中：卡堆原地平滑伸縮，不落。 */
  setCoinsLive(coins: number): void;
  /** 鬆手 / 切档：重落一輪。 */
  redrop(): void;
  /** 拖曳撥動：px/ms，正 = 向右。 */
  swipe(velocity: number): void;
  /** 懸停：NDC 座標，null = 離開。 */
  hover(x: number | null, y: number): void;
  /** 點擊：NDC 座標。 */
  tap(x: number, y: number): void;
  resize(width: number, height: number): void;
  setActive(active: boolean): void;
  setReducedMotion(reduced: boolean): void;
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
}

/* ── 導演參數（快慢在這裡調，不在物理裡）── */
const FALL_S = 0.42; // 單張從出場到觸桌
const DROP_SPAN_S = 1.5; // 整堆出場時間上限（加上落下與沉降 ≈ 2–3.5 秒）
const DROP_STAGGER_MAX = 0.16;
const DROP_STAGGER_MIN = 0.006;
const SETTLE_S = 0.9;
const PICK_S = 1.55; // 懸停拾起：升起 → 在光下轉一圈 → 放回
const GATHER_AFTER_S = 1.6; // 撥散後多久開始自己收回
const FRICTION = 3.6; // 滑動摩擦（1/s）
const GRAVITY = 9.8;
const VIEW_SHIFT = 0.13; // 主角偏上：下方留給浮在 3D 之上的價格玻璃層
const ATLAS_GRID = 4;

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
  let quality = 0; // 0 全效 / 1 關陰影降解析度 / 2 再減卡數
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
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  let pixelRatio = Math.min(window.devicePixelRatio || 1, compact ? 1 : 1.5);
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

  /* ── 作品卡圖集：先用方案色佔位，圖到一張畫一張（不等圖，首幀就有東西）── */
  const atlasSize = compact ? 1024 : 2048;
  const slotPx = atlasSize / ATLAS_GRID;
  const atlasCanvas = document.createElement("canvas");
  atlasCanvas.width = atlasSize;
  atlasCanvas.height = atlasSize;
  const atlasCtx = atlasCanvas.getContext("2d");
  if (atlasCtx) {
    const tints = ["#e9d6b8", "#c9d6ea", "#dccbe8", "#cfe3d2", "#efd9cf", "#d6dde6"];
    for (let s = 0; s < ATLAS_GRID * ATLAS_GRID; s += 1) {
      const x = (s % ATLAS_GRID) * slotPx;
      const y = Math.floor(s / ATLAS_GRID) * slotPx;
      const g = atlasCtx.createLinearGradient(x, y, x + slotPx, y + slotPx);
      g.addColorStop(0, tints[s % tints.length]);
      g.addColorStop(1, "#f7f4ef");
      atlasCtx.fillStyle = g;
      atlasCtx.fillRect(x, y, slotPx, slotPx);
    }
  }
  const atlas = new THREE.CanvasTexture(atlasCanvas);
  atlas.colorSpace = THREE.SRGBColorSpace;
  atlas.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  let atlasDirty = false;
  let atlasTimer = 0;
  const images: HTMLImageElement[] = [];
  SHOWCASE_POOL.slice(0, ATLAS_GRID * ATLAS_GRID).forEach((src, slot) => {
    const img = new window.Image();
    img.decoding = "async";
    img.onload = () => {
      if (disposed || !atlasCtx) return;
      const x = (slot % ATLAS_GRID) * slotPx;
      const y = Math.floor(slot / ATLAS_GRID) * slotPx;
      const scale = Math.max(slotPx / img.naturalWidth, slotPx / img.naturalHeight);
      const w = img.naturalWidth * scale;
      const h = img.naturalHeight * scale;
      atlasCtx.save();
      atlasCtx.beginPath();
      atlasCtx.rect(x, y, slotPx, slotPx);
      atlasCtx.clip();
      atlasCtx.drawImage(img, x + (slotPx - w) / 2, y + (slotPx - h) / 2, w, h);
      atlasCtx.restore();
      atlasDirty = true;
      if (!atlasTimer) {
        atlasTimer = window.setTimeout(() => {
          atlasTimer = 0;
          if (disposed || !atlasDirty) return;
          atlasDirty = false;
          atlas.needsUpdate = true;
          kick();
        }, 140);
      }
    };
    img.src = src;
    images.push(img);
  });

  /* ── 作品卡：一個 InstancedMesh ── */
  const cardGeo = new THREE.BoxGeometry(CARD_W, CARD_T, CARD_D);
  /* BoxGeometry 面序：+x −x +y −y +z −z，各 4 頂點 → ±y（正反面）是 8..15。 */
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
    roughness: 0.3,
    metalness: 0,
    clearcoat: 1,
    clearcoatRoughness: 0.05,
    ior: 1.5,
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
        "#include <uv_vertex>\nvFace = aFace;\nvLocalUv = uv;\nvGlint = aGlint;\n#ifdef USE_MAP\nvMapUv = aFace > 0.5 ? aUvRect.xy + uv * aUvRect.zw : aUvRect.xy + aUvRect.zw * 0.5;\n#endif",
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform vec3 uRim;\nvarying float vFace;\nvarying vec2 vLocalUv;\nvarying vec2 vGlint;")
      .replace(
        "#include <map_fragment>",
        /* 側面 = 玻璃邊：圖色壓暗再混一口冷白，讀起來是「一塊有厚度的玻璃的切邊」。 */
        "#include <map_fragment>\ndiffuseColor.rgb = mix(diffuseColor.rgb * 0.28 + vec3(0.66, 0.74, 0.76) * 0.58, diffuseColor.rgb, vFace);",
      )
      .replace(
        "#include <opaque_fragment>",
        [
          "float pFres = pow(1.0 - clamp(abs(dot(normal, normalize(vViewPosition))), 0.0, 1.0), 3.0);",
          "float pEdge = max(1.0 - vFace, smoothstep(0.44, 0.5, max(abs(vLocalUv.x - 0.5), abs(vLocalUv.y - 0.5))));",
          "outgoingLight += uRim * (pFres * (0.22 + 0.78 * pEdge) * 0.85 + pEdge * 0.1);",
          "float pBand = exp(-pow((vLocalUv.x * 0.62 + (1.0 - vLocalUv.y) * 0.38) - vGlint.y, 2.0) * 70.0);",
          "outgoingLight += uRim * pBand * vGlint.x * 1.5;",
          "#include <opaque_fragment>",
        ].join("\n"),
      );
  };
  cardMat.customProgramCacheKey = () => "pricing3d-card-v1";

  const cards = new THREE.InstancedMesh(cardGeo, cardMat, CAP);
  cards.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  cards.castShadow = true;
  cards.receiveShadow = true;
  cards.frustumCulled = false;
  scene.add(cards);

  /* ── 每張卡的狀態（定長陣列，零 GC）── */
  const slotX = new Float32Array(CAP);
  const slotY = new Float32Array(CAP);
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
      r = buildWorld(id, { compact, shadows: quality === 0 });
      rigs.set(id, r);
    }
    return r;
  }

  /** 卡位：按「(層 + 0.5) / 堆權重」排序填位 —— 張數變化時每一堆都在長，塔高錯落。 */
  function layoutSlots(r: WorldRig, worldIndex: number) {
    const sumW = r.piles.reduce((sum, p) => sum + p.weight, 0);
    const entries: Array<{ p: number; level: number; cost: number }> = [];
    r.piles.forEach((pile, p) => {
      const levels = Math.ceil((CAP * pile.weight) / sumW) + 6;
      for (let level = 0; level < levels; level += 1) entries.push({ p, level, cost: (level + 0.5) / pile.weight });
    });
    entries.sort((a, b) => a.cost - b.cost || a.p - b.p);
    const rnd = mulberry(97 + worldIndex * 131);
    const perm = SHOWCASE_POOL.map((_, i) => i).sort(() => rnd() - 0.5);
    for (let i = 0; i < CAP; i += 1) {
      const { p, level } = entries[i];
      const pile = r.piles[p];
      const fan = pile.fan ?? 0;
      let x = pile.x + (rnd() - 0.5) * 0.036;
      let z = pile.z + (rnd() - 0.5) * 0.036;
      let yaw = pile.yaw + (rnd() - 0.5) * 0.09;
      if (level < fan) {
        /* 堆底攤成扇形：讓底下幾張作品也露臉。 */
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
      slotYaw[i] = yaw;
      slotLevel[i] = level;
      slotPile[i] = p;
      tableY[i] = r.surfaceY + CARD_T * (0.5 + (i % 3));
      rand[i] = rnd();
      /* 圖集裁切窗：同一張圖在不同卡上取不同的窗 → 卡卡不同。 */
      const img = perm[i % perm.length] % (ATLAS_GRID * ATLAS_GRID);
      const col = img % ATLAS_GRID;
      const row = Math.floor(img / ATLAS_GRID);
      const firstRound = i < perm.length;
      const ch = firstRound ? 0.9 + rnd() * 0.06 : 0.62 + rnd() * 0.3;
      const cw = ch / (CARD_D / CARD_W);
      const ux = 0.02 + rnd() * Math.max(0, 1 - cw - 0.04);
      const uy = 0.02 + rnd() * Math.max(0, 1 - ch - 0.04);
      uvRect.setXYZW(i, (col + ux) / ATLAS_GRID, 1 - (row + uy + ch) / ATLAS_GRID, cw / ATLAS_GRID, ch / ATLAS_GRID);
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
    /* 窄畫面（手機竪屏）把機位沿視線往後拉，讓主角整堆入鏡。 */
    const pull = aspect < 1.7 ? Math.pow(1.7 / aspect, 0.62) : 1;
    camTarget.copy(rig.camera.target);
    camBase.copy(rig.camera.pos).sub(camTarget).multiplyScalar(pull).add(camTarget);
    const shift = Math.round(viewH * VIEW_SHIFT);
    camera.setViewOffset(viewW, viewH, 0, shift, viewW, viewH);
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
    const stagger = Math.min(DROP_STAGGER_MAX, Math.max(DROP_STAGGER_MIN, DROP_SPAN_S / Math.max(1, count)));
    /* 由下往上落：先按層、同層按堆輪流 —— 每一堆都在同時長高。 */
    const order = Array.from({ length: count }, (_, i) => i).sort((a, b) => slotLevel[a] - slotLevel[b] || slotPile[a] - slotPile[b]);
    order.forEach((i, rank) => {
      dropStart[i] = t + 0.08 + rank * stagger;
      dropFrom[i] = 2.3 + rand[i] * 0.9;
      dropYaw[i] = (rand[i] - 0.5) * 2.2;
      dropRoll[i] = (rand[(i + 7) % CAP] - 0.5) * 0.9;
      landed[i] = 0;
    });
    dropEnd = t + 0.08 + count * stagger + FALL_S + SETTLE_S;
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
    fitCamera();
    startDrop();
    kick();
  }

  /* ── 每幀 ── */
  function update(dt: number) {
    const t = now();
    let busy = t < dropEnd;
    const gathering = t - lastSwipe > GATHER_AFTER_S;
    const radius = rig?.scatterRadius ?? 1;

    sway.x += (sway.tx - sway.x) * Math.min(1, dt * 4);
    sway.y += (sway.ty - sway.y) * Math.min(1, dt * 4);
    if (Math.abs(sway.tx - sway.x) + Math.abs(sway.ty - sway.y) > 0.0005) busy = true;
    camera.position.set(camBase.x + sway.x * 0.14, camBase.y + sway.y * 0.07, camBase.z);
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

      /* 撥散：慣性 + 摩擦；閒下來後回收彈簧把卡收回原位、翻回正面。 */
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

        /* 翻面：角速度 + 就近平躺吸附（撥動中可停在背面；回收時翻回正面）。 */
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

        /* 點擊彈跳：重力 + 小反彈（第二下觸桌給一聲輕叮）。 */
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

      /* 落下：拋物線觸桌 → 指數衰減彈跳沉降。 */
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
      if (s < FALL_S) {
        const k = s / FALL_S;
        dy = dropFrom[i] * (1 - k * k);
        dYaw = dropYaw[i] * (1 - easeInOut(k)) * 0.6;
        dRoll = dropRoll[i] * (1 - k);
      } else if (s < FALL_S + SETTLE_S) {
        const a = s - FALL_S;
        if (!landed[i]) {
          landed[i] = 1;
          const loud = count > 60 ? 0.45 : 1;
          if (slotLevel[i] === 0) sound?.knock(0.8 * loud);
          else if (slotLevel[i] === pileTopLevel[slotPile[i]]) sound?.chime(0.7 * loud);
          else sound?.tick(0.8 * loud);
        }
        dy = 0.05 * dropFrom[i] * Math.exp(-7 * a) * Math.abs(Math.sin(12 * a));
        dYaw = dropYaw[i] * 0.05 * Math.exp(-6 * a) * Math.cos(10 * a);
      }

      /* 懸停拾起：升起、朝鏡頭靠一點、繞長軸在光下轉一整圈、放回。 */
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

      const baseY = slotY[i] + (tableY[i] - slotY[i]) * fallMix[i];
      const flipLift = Math.abs(Math.sin(flip[i])) * CARD_W * 0.5;
      dummy.position.set(
        slotX[i] + ox[i],
        baseY + dy + hop[i] + flipLift + lift,
        slotZ[i] + oz[i] + toward,
      );
      euler.set(0, slotYaw[i] + spin[i] + dYaw, flip[i] + dRoll + pickRoll);
      dummy.quaternion.setFromEuler(euler);
      const sc = p < 1 ? 0.35 + 0.65 * p : 1;
      dummy.scale.set(sc, p < 1 ? p : 1, sc);
      dummy.updateMatrix();
      cards.setMatrixAt(i, dummy.matrix);
    }
    cards.instanceMatrix.needsUpdate = true;

    /* 懸停命中測試（每幀最多一次）。 */
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

  function applyQuality(level: number) {
    quality = level;
    if (level >= 1) {
      pixelRatio = 1;
      renderer.setPixelRatio(pixelRatio);
      renderer.setSize(viewW, viewH, false);
      renderer.shadowMap.enabled = false;
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh) return;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of mats) m.needsUpdate = true;
      });
    }
    if (level >= 2) {
      pixelRatio = 0.8;
      renderer.setPixelRatio(pixelRatio);
      renderer.setSize(viewW, viewH, false);
      cap = Math.min(CAP, 120);
      if (count > cap) setCount(cap, false);
    }
  }

  function frame(ts: number) {
    raf = 0;
    if (disposed || !active) return;
    const dt = lastTs ? Math.min(1 / 30, (ts - lastTs) / 1000) : 1 / 60;
    const raw = lastTs ? (ts - lastTs) / 1000 : 0;
    lastTs = ts;
    const busy = update(dt);
    renderer.render(scene, camera);
    if (!firstFrame) {
      firstFrame = true;
      init.onFirstFrame();
      prebuildOthers();
    }
    /* fps 偵測：只量連續動畫幀（切档那一幀的建場景成本不算），連續偏慢就降一級。 */
    if (raw > 0 && raw < 0.25 && busy) {
      frameAcc += raw;
      frameN += 1;
      if (frameN >= 90) {
        const avg = frameAcc / frameN;
        frameAcc = 0;
        frameN = 0;
        if (avg > 1 / 38 && quality < 2) applyQuality(quality + 1);
      }
    }
    if (busy) raf = requestAnimationFrame(frame);
    else lastTs = 0;
  }

  function kick() {
    if (raf || disposed || !active) return;
    raf = requestAnimationFrame(frame);
  }

  /** 其餘世界在閒時預建，切档硬剪接時不卡那一下（手機不預建，省記憶體）。 */
  function prebuildOthers() {
    if (compact) return;
    const queue = WORLD_IDS.filter((id) => !rigs.has(id));
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
    const idle = (cb: () => void) => (w.requestIdleCallback ? w.requestIdleCallback(cb, { timeout: 2500 }) : w.setTimeout(cb, 600));
    const next = () => {
      if (disposed) return;
      const id = queue.shift();
      if (!id) return;
      getRig(id);
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
      if (n === count) return;
      /* 新增的卡原地長出（不落），減少的卡原地縮掉；位置表不變，所以是「伸縮」不是「重排」。 */
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
      for (const img of images) {
        img.onload = null;
        img.src = "";
      }
      for (const r of rigs.values()) {
        scene.remove(r.group);
        r.dispose();
      }
      rigs.clear();
      scene.remove(cards);
      cards.dispose();
      cardGeo.dispose();
      cardMat.dispose();
      atlas.dispose();
      atlasCanvas.width = 0;
      atlasCanvas.height = 0;
      envTarget.dispose();
      pmrem.dispose();
      scene.environment = null;
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
