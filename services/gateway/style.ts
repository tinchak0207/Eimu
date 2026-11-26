// B7（2026-08-31）风格货架 ffmpeg 子集 — REQ-EDIT-08。
// 口径权威 = vendored presets/filterPresets.ts + presets/transitionPresets.ts + editor/subtitleExport.ts
//（预设表逐字内嵌，禁重算；字卡走 toAss，烧录在 B6 导出闸执行）。
// fx 组件 / 运动追踪是 PRD 妥协清单项，catalog 明示 unsupported。
import type { Timeline } from "./timeline"
import { toAss } from "./editor/subtitleExport"

export interface StylePreset {
  id: string
  label: string
  values: { brightness: number; contrast: number; saturation: number; temperature: number }
}

export interface TransitionCatalogEntry {
  id: string
  label: string
  xfade: string
  defaultDuration: number
}

/** FILTER_PRESETS 逐字内嵌（src/vendor-bridges/editor/presets/filterPresets.ts） */
export const STYLE_PRESETS: StylePreset[] = [
  { id: "none", label: "原始", values: { brightness: 0, contrast: 0, saturation: 0, temperature: 0 } },
  { id: "cinematic", label: "电影感", values: { brightness: -5, contrast: 18, saturation: -12, temperature: -10 } },
  { id: "film", label: "胶片", values: { brightness: 4, contrast: 10, saturation: -20, temperature: 12 } },
  { id: "fresh", label: "清新", values: { brightness: 10, contrast: 4, saturation: 10, temperature: -6 } },
  { id: "blackgold", label: "黑金", values: { brightness: -8, contrast: 25, saturation: -30, temperature: 25 } },
  { id: "cyber", label: "赛博", values: { brightness: -4, contrast: 22, saturation: 24, temperature: -25 } },
  { id: "warmsun", label: "暖阳", values: { brightness: 8, contrast: 6, saturation: 12, temperature: 22 } },
  { id: "coldsteel", label: "冷冽", values: { brightness: 0, contrast: 14, saturation: -8, temperature: -22 } },
  { id: "retro", label: "复古", values: { brightness: 2, contrast: -6, saturation: -25, temperature: 16 } },
  { id: "bw", label: "黑白", values: { brightness: 0, contrast: 15, saturation: -100, temperature: 0 } },
  { id: "vivid", label: "浓郁", values: { brightness: 2, contrast: 12, saturation: 28, temperature: 4 } },
  { id: "milkfog", label: "奶雾", values: { brightness: 12, contrast: -12, saturation: -10, temperature: 8 } },
]

/** TRANSITION_PRESETS 逐字内嵌（src/vendor-bridges/editor/presets/transitionPresets.ts；type=xfade 名走既有 set_transition op） */
export const TRANSITION_CATALOG: TransitionCatalogEntry[] = [
  { id: "fade", label: "叠化", xfade: "fade", defaultDuration: 0.5 },
  { id: "fadeblack", label: "闪黑", xfade: "fadeblack", defaultDuration: 0.5 },
  { id: "fadewhite", label: "闪白", xfade: "fadewhite", defaultDuration: 0.4 },
  { id: "wipeleft", label: "左擦除", xfade: "wipeleft", defaultDuration: 0.5 },
  { id: "wiperight", label: "右擦除", xfade: "wiperight", defaultDuration: 0.5 },
  { id: "slideleft", label: "左推移", xfade: "slideleft", defaultDuration: 0.5 },
  { id: "slideright", label: "右推移", xfade: "slideright", defaultDuration: 0.5 },
  { id: "slideup", label: "上推移", xfade: "slideup", defaultDuration: 0.5 },
  { id: "circleopen", label: "圆形展开", xfade: "circleopen", defaultDuration: 0.6 },
  { id: "circleclose", label: "圆形闭合", xfade: "circleclose", defaultDuration: 0.6 },
  { id: "radial", label: "时钟扫描", xfade: "radial", defaultDuration: 0.6 },
  { id: "smoothleft", label: "平滑左移", xfade: "smoothleft", defaultDuration: 0.5 },
  { id: "zoomin", label: "中心放大", xfade: "zoomin", defaultDuration: 0.5 },
  { id: "pixelize", label: "像素化", xfade: "pixelize", defaultDuration: 0.5 },
  { id: "dissolve", label: "噪点溶解", xfade: "dissolve", defaultDuration: 0.6 },
  { id: "distance", label: "景深拉远", xfade: "distance", defaultDuration: 0.6 },
]

export function findStylePreset(id: string): StylePreset | undefined {
  return STYLE_PRESETS.find((p) => p.id === id)
}

export function findTransitionPreset(id: string): TransitionCatalogEntry | undefined {
  return TRANSITION_CATALOG.find((t) => t.id === id)
}

export function styleCatalog(tl: Timeline) {
  return {
    presets: STYLE_PRESETS,
    transitions: TRANSITION_CATALOG,
    per_clip: tl.clips.map((c) => ({ id: c.id, label: c.label, filter: c.filter ?? null, transition: c.transitionAfter ?? null })),
    unsupported: ["fx_components", "motion_tracking"],
    notes: [
      "套用走 POST /agent/v1/timeline/style（presetId 或四滑杆 brightness/contrast/saturation/temperature，transition.presetId 走既有 set_transition op，type=xfade 名）",
      "字卡导出 GET /agent/v1/timeline/style/subtitles.ass（toAss 生成，烧录在 B6 导出闸执行）",
      "fx 组件与运动追踪不支持（PRD 妥协清单）",
    ],
  }
}

export function subtitlesAss(tl: Timeline): string {
  return toAss(tl.subtitles ?? [], tl.aspect)
}
