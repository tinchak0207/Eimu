/* 滚轮分档状态机（/pricing 方案环，2026-10-01 第二版）。
 *
 * 暴君实机（Linux 触控板、高灵敏）回报：第一版「事件间隔 > 180ms 才算新手势」——
 *   1. 滑几次就失效：触控板 delta 抖动，单一尖峰被当成新手势，一滑换两档；
 *   2. 往回滑完全无效：页面滚回顶端时用户还在连续滑，事件流永远没有 180ms 空档，
 *      于是「从未接管」，而页面已在顶端滚不动 → 什么都不发生。
 *
 * 第二版规则（纯函式，可单测）：
 *   - 换档后锁 LOCK_MS，期间同方向的惯性尾巴全吃掉；
 *   - 下一档需要「重新武装」：静默 GAP_MS、反向、或明确再加速（近 3 笔中位数 > 前 3 笔中位数 × ACCEL_RATIO
 *     且 ≥ ACCEL_MIN，单笔尖峰推不动中位数）；按著不放只换一档（「按著自动连换」实测与抖动的惯性尾巴无法区分，
 *     两版都误判再跳档，已移除——要再换就停一下或再滑一次）；
 *   - 能不能接管由呼叫端每个事件判断（舞台在视野内＋这方向还有下一档），不再只看手势开头；
 *   - 到头（没有下一档）：刚换完那一手势的同向尾巴照样吃掉，不让它把页面卷走；之后才放行。
 */

export interface WheelStepperOptions {
  gapMs?: number;
  lockMs?: number;
  stepPx?: number;
  accelRatio?: number;
  strokeMin?: number;
}

export type WheelDecision = "pass" | "consume" | { step: 1 | -1 };

export interface WheelSample {
  /** 事件时间戳（ms）。 */
  t: number;
  /** 已换算成像素的纵向位移（正＝往下）。 */
  delta: number;
}

export function createWheelStepper(options: WheelStepperOptions = {}) {
  const GAP_MS = options.gapMs ?? 140;
  const LOCK_MS = options.lockMs ?? 700;
  const STEP_PX = options.stepPx ?? 36;
  const ACCEL_RATIO = options.accelRatio ?? 1.8;
  /** 再加速的绝对下限：新的一滑头几笔中位数轻易过 25px；抖动的惯性尾巴（多在 20 以下）过不了。 */
  const ACCEL_MIN = 25;
  /** 重新武装后要「真的又滑了一下」：至少一笔 ≥ STROKE_MIN。主线程忙（3D 渲染）时惯性尾巴里会冒出 > GAP_MS 的空档，
   *  只靠「静默」会把尾巴的小 delta 当成新手势再跳一档（实测）。 */
  const STROKE_MIN = options.strokeMin ?? 20;

  let lastEventAt = -Infinity;
  let lastStepAt = -Infinity;
  let lastStepDir = 0;
  let armed = true;
  let sawQuiet = false;
  /** 这一手势是在卷页面（曾放行过）：滑进舞台后只停住、吃掉尾巴，不在同一手势里换档。 */
  let pageGesture = false;
  let acc = 0;
  let armPeak = 0;
  let lastDir = 0;
  let recent: number[] = [];

  /** 三笔中位数：单笔尖峰（触控板抖动）推不动它，持续的再加速才推得动。 */
  const median3 = (xs: number[]) => [...xs].sort((a, b) => a - b)[1] ?? 0;

  function feed(sample: WheelSample, canStep: (dir: 1 | -1) => boolean): WheelDecision {
    const { t, delta } = sample;
    if (delta === 0) return "pass";
    const dir: 1 | -1 = delta > 0 ? 1 : -1;
    const magnitude = Math.abs(delta);
    const quiet = t - lastEventAt > GAP_MS;
    lastEventAt = t;
    if (quiet) sawQuiet = true;
    if (quiet || (lastDir !== 0 && dir !== lastDir)) pageGesture = false;
    lastDir = dir;

    /* 只看「上次换档之后」的样本（换档时清空），反向前的旧尾巴不会被误读成再加速。 */
    recent = quiet ? [magnitude] : [...recent.slice(-5), magnitude];
    const locked = t - lastStepAt < LOCK_MS;
    if (!armed && !locked) {
      const now3 = recent.length >= 6 ? median3(recent.slice(3)) : 0;
      const before3 = recent.length >= 6 ? median3(recent.slice(0, 3)) : 0;
      const accelerating = recent.length >= 6 && now3 > Math.max(ACCEL_MIN, before3 * ACCEL_RATIO);
      if (sawQuiet || dir !== lastStepDir || accelerating) {
        armed = true;
        acc = 0;
        armPeak = 0;
      }
    }

    if (!canStep(dir)) {
      /* 到头：换档那一手势的同向尾巴（还没重新武装）吃掉；其余放行给页面。 */
      if (!armed && dir === lastStepDir) return "consume";
      acc = 0;
      pageGesture = true;
      recent = [magnitude];
      return "pass";
    }

    /* 从页面滚进舞台的那一滑：页面停在这里、尾巴吃掉；明确再加速（用户又滑了一次）才解除。 */
    if (pageGesture) {
      const now3 = recent.length >= 6 ? median3(recent.slice(3)) : 0;
      const before3 = recent.length >= 6 ? median3(recent.slice(0, 3)) : 0;
      if (recent.length >= 6 && now3 > Math.max(ACCEL_MIN, before3 * ACCEL_RATIO)) pageGesture = false;
      else {
        acc = 0;
        return "consume";
      }
    }

    if (!armed || locked) {
      acc = 0;
      return "consume";
    }
    if (acc !== 0 && Math.sign(acc) !== dir) acc = 0;
    acc += delta;
    armPeak = Math.max(armPeak, magnitude);
    if (Math.abs(acc) < STEP_PX || (lastStepAt > -Infinity && armPeak < STROKE_MIN)) return "consume";
    acc = 0;
    armPeak = 0;
    armed = false;
    sawQuiet = false;
    recent = [];
    lastStepAt = t;
    lastStepDir = dir;
    return { step: dir };
  }

  return { feed };
}
