// /pricing 舞台的装置分级（2026-10-01）：低端机不跑 WebGL，改显示预渲染的静态场景图。
//
// 实测（Intel UHD 核显）：3D 舞台滚动 6–9fps、单帧卡 1.3s；即使预热 shader＋动态解析度，滑鼠一动仍只有
// ~13fps。暴君裁定：低端机宁可没有灵动感，也不能卡——直接换成同构图的静态图（由真引擎离线渲染，
// 见 public/showcase/pricing3d/）。这里只做「判断」，纯函式可测；读浏览器资讯在 detectPricingStageMode。

export type PricingStageMode = "3d" | "lite" | "off";

export interface DeviceSignals {
  /** WebGL UNMASKED_RENDERER_WEBGL；拿不到为空字串。null＝WebGL 不可用。 */
  renderer: string | null;
  cores?: number;
  memoryGb?: number;
  saveData?: boolean;
  /** URL 覆写：?p3d=lite|full（测试与客服排障用）。 */
  override?: string | null;
}

/** 已知跑不动 3D 舞台的 GPU：软体渲染、Intel 核显（Arc 独显除外）、旧款手机 GPU。 */
const LOW_END_GPU = /swiftshader|llvmpipe|softpipe|software|basic render|mali-(?:[2-7]\d\d|t\d+|g[1-5]\d)\b|adreno(?: \(tm\))? [2-5]\d\d\b|powervr|videocore/i;
const isIntelIntegrated = (renderer: string) => /intel/i.test(renderer) && !/\barc\b/i.test(renderer);

export function classifyPricingStage(signals: DeviceSignals): PricingStageMode {
  if (signals.override === "full") return signals.renderer === null ? "off" : "3d";
  if (signals.override === "lite") return "lite";
  if (signals.renderer === null) return "off";
  if (signals.saveData) return "lite";
  if (typeof signals.memoryGb === "number" && signals.memoryGb <= 4) return "lite";
  if (typeof signals.cores === "number" && signals.cores > 0 && signals.cores <= 4) return "lite";
  if (LOW_END_GPU.test(signals.renderer) || isIntelIntegrated(signals.renderer)) return "lite";
  return "3d";
}

let cached: PricingStageMode | null = null;

/** 读浏览器讯号做一次判断（模组级快取；建一个用完即弃的 WebGL context 取 GPU 名）。 */
export function detectPricingStageMode(): PricingStageMode {
  if (cached) return cached;
  if (typeof window === "undefined") return "3d";
  const nav = navigator as Navigator & { connection?: { saveData?: boolean }; deviceMemory?: number };
  let renderer: string | null = null;
  try {
    const probe = document.createElement("canvas");
    const gl = (probe.getContext("webgl2") ?? probe.getContext("webgl")) as WebGLRenderingContext | null;
    if (gl) {
      const info = gl.getExtension("WEBGL_debug_renderer_info");
      renderer = String((info && gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || "");
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  } catch {
    renderer = null;
  }
  const override = new URLSearchParams(window.location.search).get("p3d");
  cached = classifyPricingStage({
    renderer,
    cores: nav.hardwareConcurrency,
    memoryGb: nav.deviceMemory,
    saveData: nav.connection?.saveData === true,
    override,
  });
  return cached;
}

/**
 * 低端机静态场景图：由 3D 引擎离线渲染的透明底 webp（减少动态＝卡堆落定的那一帧）。
 * wide＝桌面构图（1440×725 舞台；1x／2x），tall＝手机竖屏构图（390×646 舞台的 2x）。
 * 场景改了要重产：dev server 开 `/pricing?p3d=capture`，逐档呼叫 `window.__p3dSnapshot()`。
 */
const still = (world: string) => ({
  wide: `/showcase/pricing3d/${world}-wide.webp`,
  wide2x: `/showcase/pricing3d/${world}-wide@2x.webp`,
  tall: `/showcase/pricing3d/${world}-tall.webp`,
});
export const LITE_STAGE_IMAGES = {
  starter: still("starter"),
  popular: still("popular"),
  pro: still("pro"),
  custom: still("custom"),
} as const;
