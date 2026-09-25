/**
 * editorStore 替身（kunpeng 拆片方案片2）— harness 最小注入态。
 *
 * 来源：kunpeng-vendor `src/stores/editorStore.ts` @ pin `872a58b`。
 * 白名单（F-SHARDING.md 片2）：
 *   - 类型块 + `EXPORT_RESOLUTIONS`/`DEFAULT_EXPORT_SETTINGS` 逐行复制（正文一字未改）；
 *   - `EditorAspect` 经 `export type` 从本目录 `../aspect`（vendor 原为 `@/lib/editor/aspect`，import 行改写）；
 *   - 删除：zustand create/persist、localStorage 持久化、UI/工具面（transcript/plan/mediaNotes 等）；
 *   - 注入面：`setHarnessState(patch)` 浅合并进模块级 `state`；
 *     `useEditorStore.getState()` 返回该注入态（主链仅用 getState：composeEngine L183/551/810、renderGraph L59）。
 *   - `clipLength`/`totalDuration` 逐行复制（vendor L1135/L1137-1149），唯一偏差 `get()` → `state`；
 *     `updateTextClip`/`updateFxClip` 保留 vendor 合并+缓存失效语义（updateFxClip 略去 findFxComponent
 *     主题重建分支——该分支属 UI 侧 fxComponents 模块，harness 场景 text/fx 轨恒空，永不可达）。
 */
import type { EditorAspect } from '../aspect';
export type { EditorAspect } from '../aspect';

/** 调色参数（预览 CSS filter 近似，导出 ffmpeg eq 保真）。各值 -100..100，0=原始 */
export interface ClipFilter {
  brightness: number;
  contrast: number;
  saturation: number;
  temperature: number;
  /** 调色预设 id（filterPresets），存档仅作 UI 高亮，导出按四滑杆值 */
  preset?: string;
}

/**
 * 转场类型：'cut' | 'fade' | 任意 ffmpeg xfade transition 名
 * （wipeleft/slideright/circleopen/zoomin…，见 presets/transitionPresets）
 */
export type TransitionType = string;

export interface EditorClip {
  id: string;
  path: string;
  label: string;
  sourceNodeId?: string;
  /** Full media duration (seconds). */
  duration: number;
  /** Trim window. */
  inSec: number;
  outSec: number;
  transitionAfter: { type: TransitionType; duration: number };
  /** 变速 0.1-4，默认 1。时间轴有效时长 = (out-in)/speed */
  speed?: number;
  /** 曲线变速预设 id。约定：曲线只重分配片段内速度，不改变总时长 */
  curvePreset?: string;
  /** 主视频原声音量，0=静音，1=原始，2=放大一倍 */
  volume?: number;
  reversed?: boolean;
  flipH?: boolean;
  rotate?: 0 | 90 | 180 | 270;
  filter?: ClipFilter;
  /** 剪映式“停用片段”：保留时间轴占位，预览/导出不显示原画面。 */
  disabled?: boolean;
}

export type AudioTrackKind = 'bgm' | 'sfx' | 'voice';

export interface AudioTrack {
  id: string;
  kind: AudioTrackKind;
  muted: boolean;
}

export interface AudioClip {
  id: string;
  trackId: string;
  path: string;
  label: string;
  /** Position on the program timeline. */
  startSec: number;
  duration: number;
  inSec: number;
  outSec: number;
  volume: number; // 0..1
  loop?: boolean;
  /** 淡入淡出时长（秒），导出 afade */
  fadeInSec?: number;
  fadeOutSec?: number;
  /** 来源：导入 / 麦克风录音 / TTS 配音 */
  source?: 'import' | 'record' | 'tts';
  disabled?: boolean;
}

export interface SubtitleCue {
  id: string;
  startSec: number;
  endSec: number;
  text: string;
  style?: { fontSize?: number; color?: string; y?: number };
  disabled?: boolean;
}

/** 归一化变换：x/y 为画面比例坐标（0,0=中心，±0.5=半幅边缘），scale 1=等宽 */
export interface OverlayTransform {
  x: number;
  y: number;
  scale: number;
  opacity: number;
  rotation: number; // 度
}

export interface OverlayKeyframe {
  /** 相对片段开始的秒数 */
  t: number;
  x: number;
  y: number;
  scale: number;
  opacity: number;
}

export interface MaskSettings {
  enabled: boolean;
  type: 'rect' | 'circle' | 'linear' | 'mirror';
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  feather: number;
  invert: boolean;
}

/** 画中画片段（trackIndex 0|1 两条叠加轨，0 在上层） */
export interface OverlayClip {
  id: string;
  trackIndex: 0 | 1;
  kind: 'video' | 'image';
  path: string;
  label: string;
  /** Program timeline position. */
  startSec: number;
  duration: number;
  inSec: number;
  outSec: number;
  transform: OverlayTransform;
  /** 关键帧按 t 升序；存在时覆盖 transform 的 x/y/scale/opacity（rotation 不参与插值） */
  keyframes?: OverlayKeyframe[];
  /** 视频画中画音量 */
  volume?: number;
  mask?: MaskSettings;
  disabled?: boolean;
}

/** 花字/文本卡（templateId → presets/textTemplates，HyperFrames 管线渲染） */
export interface TextClip {
  id: string;
  text: string;
  templateId: string;
  startSec: number;
  endSec: number;
  position: 'top' | 'center' | 'bottom' | 'custom';
  /** position='custom' 时的归一化坐标（0,0=中心） */
  customPos?: { x: number; y: number };
  styleOverrides?: { color?: string; accent?: string; fontScale?: number };
  /** 渲染缓存（导出用透明帧序列目录），内容变更时失效 */
  renderCachePath?: string;
  contentHash?: string;
  disabled?: boolean;
}

/** HyperFrames 自由特效（html/css 由组件库实例化或 agent 撰写） */
export interface FxClip {
  id: string;
  label: string;
  html: string;
  css: string;
  /** component 模式溯源（fxComponents 实例化参数，便于再编辑） */
  componentId?: string;
  params?: Record<string, unknown>;
  theme?: string;
  startSec: number;
  duration: number;
  /** 画面内整体变换：像剪映贴纸/特效层一样可拖动、缩放、透明、旋转 */
  transform?: OverlayTransform;
  renderCachePath?: string;
  contentHash?: string;
  disabled?: boolean;
}

export interface ExportSettings {
  resolution: '720p' | '1080p' | '2k' | '4k';
  fps: 24 | 30 | 60;
  bitrate: 'low' | 'medium' | 'high';
  loudnorm: boolean;
  denoise: boolean;
  format?: 'mp4' | 'mov_alpha';
  encoder?: 'auto' | 'h264' | 'hevc';
  background?: 'black' | 'transparent';
}

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  resolution: '1080p', fps: 30, bitrate: 'medium', loudnorm: false, denoise: false,
};

export const EXPORT_RESOLUTIONS: Record<ExportSettings['resolution'], { w: number; h: number }> = {
  '720p': { w: 1280, h: 720 },
  '1080p': { w: 1920, h: 1080 },
  '2k': { w: 2560, h: 1440 },
  '4k': { w: 3840, h: 2160 },
};

/**
 * 注入态（vendor `EditorState` 的主链读取面最小子集）：
 * composeEngine/renderGraph 经 `getState()` 读的字段与调用的方法（grep 实测）：
 *   数据：clips/aspect/audioTracks/audioClips/subtitles/overlayClips/textClips/fxClips/exportSettings
 *   方法：clipLength/totalDuration/updateTextClip/updateFxClip
 */
export interface EditorState {
  clips: EditorClip[];
  aspect: EditorAspect;
  audioTracks: AudioTrack[];
  audioClips: AudioClip[];
  subtitles: SubtitleCue[];
  overlayClips: OverlayClip[];
  textClips: TextClip[];
  fxClips: FxClip[];
  exportSettings: ExportSettings;
  clipLength: (c: EditorClip) => number;
  totalDuration: () => number;
  updateTextClip: (id: string, patch: Partial<TextClip>) => void;
  updateFxClip: (id: string, patch: Partial<FxClip>) => void;
}

// 时间轴有效时长 = 裁剪区间 / 变速（曲线变速约定不改总时长）
function clipLength(c: EditorClip): number {
  return Math.max(0.1, (c.outSec - c.inSec) / (c.speed && c.speed > 0 ? c.speed : 1));
}

function totalDuration(): number {
  const { clips, overlayClips, textClips, fxClips, audioClips, subtitles, clipLength } = state;
  const main = clips.reduce((sum, c) => sum + clipLength(c), 0);
  const tails = [
    ...overlayClips.map((o) => o.startSec + Math.max(0.1, o.outSec - o.inSec || o.duration || 0)),
    ...textClips.map((t) => t.endSec),
    ...fxClips.map((f) => f.startSec + f.duration),
    ...audioClips.map((a) => a.startSec + Math.max(0.1, a.outSec - a.inSec || a.duration || 0)),
    ...subtitles.map((c) => c.endSec),
  ];
  // 超出主轨的部分导出时由 composeEngine 补黑场（tpad）
  return Math.max(main, ...tails, 0);
}

function updateTextClip(id: string, patch: Partial<TextClip>): void {
  state = {
    ...state,
    // 文案/模板/样式变更 → 渲染缓存失效
    textClips: state.textClips.map((t) => (t.id === id
      ? { ...t, ...patch, ...(patch.text !== undefined || patch.templateId !== undefined || patch.styleOverrides !== undefined ? { renderCachePath: undefined, contentHash: undefined } : {}) }
      : t)),
  };
}

function updateFxClip(id: string, patch: Partial<FxClip>): void {
  state = {
    ...state,
    fxClips: state.fxClips.map((f) => {
      if (f.id !== id) return f;
      let merged = { ...f, ...patch };
      if (
        patch.html !== undefined
        || patch.css !== undefined
        || patch.params !== undefined
        || patch.theme !== undefined
        || patch.duration !== undefined
        || patch.transform !== undefined
      ) {
        merged.renderCachePath = undefined;
        merged.contentHash = undefined;
      }
      return merged;
    }),
  };
}

let state: EditorState = {
  clips: [],
  aspect: '16:9',
  audioTracks: [],
  audioClips: [],
  subtitles: [],
  overlayClips: [],
  textClips: [],
  fxClips: [],
  exportSettings: DEFAULT_EXPORT_SETTINGS,
  clipLength,
  totalDuration,
  updateTextClip,
  updateFxClip,
};

/** harness 注入点：浅合并 patch 进模块级 state（片6 film 分支的唯一写入口）。 */
export function setHarnessState(patch: Partial<EditorState>): void {
  state = { ...state, ...patch };
}

/** vendor zustand store 的主链替身：主链只用 getState()。 */
export const useEditorStore = {
  getState: (): EditorState => state,
};
