/* 滾輪分檔狀態機（/pricing 方案環，2026-10-01 第二版）。
 *
 * 暴君實機（Linux 觸控板、高靈敏）回報：第一版「事件間隔 > 180ms 才算新手勢」——
 *   1. 滑幾次就失效：觸控板 delta 抖動，單一尖峰被當成新手勢，一滑換兩檔；
 *   2. 往回滑完全無效：頁面滾回頂端時用戶還在連續滑，事件流永遠沒有 180ms 空檔，
 *      於是「從未接管」，而頁面已在頂端滾不動 → 什麼都不發生。
 *
 * 第二版規則（純函式，可單測）：
 *   - 換檔後鎖 LOCK_MS，期間同方向的慣性尾巴全吃掉；
 *   - 下一檔需要「重新武裝」：靜默 GAP_MS、反向、或明確再加速（近 3 筆中位數 > 前 3 筆中位數 × ACCEL_RATIO
 *     且 ≥ ACCEL_MIN，單筆尖峰推不動中位數）；按著不放只換一檔（「按著自動連換」實測與抖動的慣性尾巴無法區分，
 *     兩版都誤判再跳檔，已移除——要再換就停一下或再滑一次）；
 *   - 能不能接管由呼叫端每個事件判斷（舞台在視野內＋這方向還有下一檔），不再只看手勢開頭；
 *   - 到頭（沒有下一檔）：剛換完那一手勢的同向尾巴照樣吃掉，不讓它把頁面捲走；之後才放行。
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
  /** 事件時間戳（ms）。 */
  t: number;
  /** 已換算成像素的縱向位移（正＝往下）。 */
  delta: number;
}

export function createWheelStepper(options: WheelStepperOptions = {}) {
  const GAP_MS = options.gapMs ?? 140;
  const LOCK_MS = options.lockMs ?? 700;
  const STEP_PX = options.stepPx ?? 36;
  const ACCEL_RATIO = options.accelRatio ?? 1.8;
  /** 再加速的絕對下限：新的一滑頭幾筆中位數輕易過 25px；抖動的慣性尾巴（多在 20 以下）過不了。 */
  const ACCEL_MIN = 25;
  /** 重新武裝後要「真的又滑了一下」：至少一筆 ≥ STROKE_MIN。主線程忙（3D 渲染）時慣性尾巴裡會冒出 > GAP_MS 的空檔，
   *  只靠「靜默」會把尾巴的小 delta 當成新手勢再跳一檔（實測）。 */
  const STROKE_MIN = options.strokeMin ?? 20;

  let lastEventAt = -Infinity;
  let lastStepAt = -Infinity;
  let lastStepDir = 0;
  let armed = true;
  let sawQuiet = false;
  /** 這一手勢是在捲頁面（曾放行過）：滑進舞台後只停住、吃掉尾巴，不在同一手勢裡換檔。 */
  let pageGesture = false;
  let acc = 0;
  let armPeak = 0;
  let lastDir = 0;
  let recent: number[] = [];

  /** 三筆中位數：單筆尖峰（觸控板抖動）推不動它，持續的再加速才推得動。 */
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

    /* 只看「上次換檔之後」的樣本（換檔時清空），反向前的舊尾巴不會被誤讀成再加速。 */
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
      /* 到頭：換檔那一手勢的同向尾巴（還沒重新武裝）吃掉；其餘放行給頁面。 */
      if (!armed && dir === lastStepDir) return "consume";
      acc = 0;
      pageGesture = true;
      recent = [magnitude];
      return "pass";
    }

    /* 從頁面滾進舞台的那一滑：頁面停在這裡、尾巴吃掉；明確再加速（用戶又滑了一次）才解除。 */
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
