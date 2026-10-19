/**
 * fxRenderStub — fxRender.ts 边界替身（F-SHARDING 片3）。
 *
 * 来源：/home/user/Desktop/kunpeng-vendor src/lib/editor/fxRender.ts @ 872a58b。
 * 逐行抽取：hashContent（vendor L42-46）+ 类型块（FxDoc L29-32、FxLayerResult
 * L464-468、FxSegmentLayerResult L471-475、FxTimelineLayerItem L477-484、
 * FxTimelineProgress L486-494）。
 * build* 及 render* 共 4 函数保留 vendor 同签名，函数体诚实抛错——全方案唯一非逐行
 * 偏差（F-SHARDING §6 风险2）：Chromium worker 特效渲染层未随轮进 harness，
 * 目标场景（纯拼接）零触发。
 * vendor fxRender L17 的 Vite `?raw` 语法（MOTION_RUNTIME_SRC）隔离在替身之外，
 * 不进 Bun 解析器。
 */
import type { TextClip, FxClip } from './editorStore';

export interface FxDoc {
  html: string;
  css: string;
}

export function hashContent(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export interface FxLayerResult {
  framesDir: string;
  /** 透明模式为 alpha.mov；黑底普通视频模式为 layer.mp4。 */
  alphaMovPath: string;
  renderer: 'chromium-worker' | 'html2canvas-fallback';
}

export interface FxSegmentLayerResult extends FxLayerResult {
  id: string;
  startSec: number;
  durationSec: number;
}

export interface FxTimelineLayerItem {
  id: string;
  startSec: number;
  durationSec: number;
  doc: FxDoc;
}

export interface FxTimelineProgress {
  stage: 'cache' | 'browser' | 'load' | 'frames' | 'encode' | 'segment' | 'concat' | 'done';
  done?: number;
  total?: number;
  segmentIndex?: number;
  segmentCount?: number;
  detail?: string;
  elapsedSec?: number;
}

const FX_STUB_ERROR =
  '特效/花字渲染层未接入：纯拼接场景不需要；带字幕烧录需 Chromium worker 农场另立项（fx 渲染需 Chromium，harness 场景不支援）';

/** TextClip → 完整舞台文档（vendor fxRender.ts:51 同签名） */
export function buildTextClipDoc(t: TextClip, themeId?: string): FxDoc {
  throw new Error(FX_STUB_ERROR);
}

/** FxClip → 完整舞台文档（vendor fxRender.ts:74 同签名） */
export function buildFxClipDoc(f: FxClip): FxDoc {
  throw new Error(FX_STUB_ERROR);
}

export async function renderFxTimelineLayer(
  items: FxTimelineLayerItem[],
  exportWidth: number,
  fps: number,
  durationSec: number,
  signal?: AbortSignal,
  onProgress?: (p: FxTimelineProgress) => void,
  opaqueBackground = false,
): Promise<FxLayerResult | null> {
  throw new Error(FX_STUB_ERROR);
}

export async function renderFxTimelineOpaqueSegments(
  items: FxTimelineLayerItem[],
  exportWidth: number,
  fps: number,
  signal?: AbortSignal,
  onProgress?: (p: FxTimelineProgress) => void,
): Promise<FxSegmentLayerResult[] | null> {
  throw new Error(FX_STUB_ERROR);
}
