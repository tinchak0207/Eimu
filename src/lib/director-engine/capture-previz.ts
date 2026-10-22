/**
 * 预演关键帧截取（S4）：按镜取首/中/尾（或自定义相对时刻）→ 现有 captureShot。
 * 不产出 MP4（MediaRecorder/ccapture 完整接入仅留接口注释，见 capturePlanVideo stub）。
 */
import { evaluateDirectorFrame } from "./playback";
import type { DirectorEngine } from "./engine";
import type { AspectId, DirectorElement, DirectorPlan, DirectorSequenceShot } from "./types";

export type CapturePlanKeyframesOpts = {
  /** 只截这些 shot；缺省 = plan 全部镜头 */
  shotIds?: string[];
  /**
   * 每镜相对时刻（0..1）。缺省 [0, 0.5, 1] = 首/中/尾。
   * 1.0 会略微内收，避免落在下一镜边界。
   */
  times?: number[];
  width?: number;
  aspect?: AspectId;
};

export type CapturedPlanKeyframe = {
  shotId: string;
  shotName: string;
  /** start | mid | end | t<frac> */
  label: string;
  /** 方案绝对时间（秒） */
  timeSec: number;
  dataUrl: string;
};

function labelForFrac(frac: number, index: number, total: number): string {
  if (total === 3 && index === 0) return "start";
  if (total === 3 && index === 1) return "mid";
  if (total === 3 && index === 2) return "end";
  if (Math.abs(frac) < 1e-6) return "start";
  if (Math.abs(frac - 0.5) < 1e-6) return "mid";
  if (Math.abs(frac - 1) < 1e-6) return "end";
  return `t${frac.toFixed(2)}`;
}

/** 计算一镜内要截的绝对时刻列表。 */
export function keyframeTimesForShot(
  shot: DirectorSequenceShot,
  times: number[] = [0, 0.5, 1],
): { frac: number; timeSec: number; label: string }[] {
  const dur = Math.max(0.001, shot.durationSec);
  const eps = Math.min(1 / 24, dur * 0.02);
  return times.map((raw, index) => {
    const frac = Math.min(1, Math.max(0, raw));
    const local = frac >= 1 ? Math.max(0, dur - eps) : frac * dur;
    return {
      frac,
      timeSec: shot.startSec + local,
      label: labelForFrac(frac, index, times.length),
    };
  });
}

/**
 * 按 plan 逐镜截预演关键帧。调用方须已把元素/机位交给同一 engine 实例。
 * 每帧：evaluateDirectorFrame → syncElements → applyCameraPose → captureShot。
 */
export function capturePlanKeyframes(
  engine: DirectorEngine,
  plan: DirectorPlan,
  elements: DirectorElement[],
  opts: CapturePlanKeyframesOpts = {},
): CapturedPlanKeyframe[] {
  const fracs = opts.times?.length ? opts.times : [0, 0.5, 1];
  const width = opts.width ?? 1280;
  const allow = opts.shotIds?.length ? new Set(opts.shotIds) : null;
  const out: CapturedPlanKeyframe[] = [];

  for (const shot of plan.shots) {
    if (allow && !allow.has(shot.id)) continue;
    for (const slot of keyframeTimesForShot(shot, fracs)) {
      const frame = evaluateDirectorFrame(plan, elements, slot.timeSec, {
        hasMixer: () => engine.hasGltfMixer,
        driveMixer: (req) => {
          engine.playClip(req.clipName, {
            timeSec: req.timeSec,
            loop: req.loop,
            clampWhenFinished: !req.loop,
          });
        },
      });
      if (!frame) continue;
      engine.syncElements(frame.elements);
      engine.applyCameraPose(frame.camera);
      const aspect = opts.aspect ?? frame.shot.aspect ?? shot.aspect ?? "16:9";
      const dataUrl = engine.captureShot(aspect, width);
      out.push({
        shotId: shot.id,
        shotName: shot.name,
        label: slot.label,
        timeSec: slot.timeSec,
        dataUrl,
      });
    }
  }
  return out;
}

/**
 * MP4 整段录制入口（未接入）。
 * MediaRecorder / ccapture 完整接线可后续叠在此；S4 只保证关键帧 PNG/URL。
 */
export async function capturePlanVideo(
  _engine: DirectorEngine,
  _plan: DirectorPlan,
  _elements: DirectorElement[],
  _opts?: { fps?: number; width?: number },
): Promise<{ ok: false; reason: "mp4_not_implemented" }> {
  return { ok: false, reason: "mp4_not_implemented" };
}
