// /pricing 舞台的裝置分級（2026-10-01）：低端機不跑 WebGL，改顯示預渲染的靜態場景圖。
//
// 實測（Intel UHD 核顯）：3D 舞台滾動 6–9fps、單幀卡 1.3s；即使預熱 shader＋動態解析度，滑鼠一動仍只有
// ~13fps。暴君裁定：低端機寧可沒有靈動感，也不能卡——直接換成同構圖的靜態圖（由真引擎離線渲染，
// 見 public/showcase/pricing3d/）。這裡只做「判斷」，純函式可測；讀瀏覽器資訊在 detectPricingStageMode。

export type PricingStageMode = "3d" | "lite" | "off";

export interface DeviceSignals {
  /** WebGL UNMASKED_RENDERER_WEBGL；拿不到為空字串。null＝WebGL 不可用。 */
  renderer: string | null;
  cores?: number;
  memoryGb?: number;
  saveData?: boolean;
  /** URL 覆寫：?p3d=lite|full（測試與客服排障用）。 */
  override?: string | null;
}

/** 已知跑不動 3D 舞台的 GPU：軟體渲染、Intel 核顯（Arc 獨顯除外）、舊款手機 GPU。 */
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

/** 讀瀏覽器訊號做一次判斷（模組級快取；建一個用完即棄的 WebGL context 取 GPU 名）。 */
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
 * 低端機靜態場景圖：由 3D 引擎離線渲染的透明底 webp（減少動態＝卡堆落定的那一幀）。
 * wide＝桌面構圖（1440×725 舞台；1x／2x），tall＝手機竪屏構圖（390×646 舞台的 2x）。
 * 場景改了要重產：dev server 開 `/pricing?p3d=capture`，逐档呼叫 `window.__p3dSnapshot()`。
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
