/* 环形轮播的「磁力」数学。
 *
 * 拆出来单独一个文件是因为它是纯函数、且是手感的全部来源 —— 组件里只剩接线，
 * 这些规则可以被真的单元测试钉住，而不是靠正则去匹配源码字符串。
 *
 * 手感由两件事组成，缺一个都会变成「不够 sticky」：
 *   1. detent()      —— 输入过程中把角度往最近一格拧，让环在卡位附近发黏、格间快速掠过。
 *   2. commitSteps() —— 手势结束时按「从起点走了几格」决定落哪一格，而不是 round 到最近的。
 */

/** 形变指数。1 = 线性（完全没有磁力），越大越黏。
 *  1.35 是刻意保守的：磁力太强会重新变成「跟手延迟」，那是上一轮刚修掉的病。
 *  这里要的是「能感觉到卡位的阻力」，不是「手指拖不动」。 */
const DETENT_EXP = 1.35;

/** 手势结束时，走过多少格才算「用户想换一张」。0.18 格 ≈ 一张卡宽的 18%。
 *  传统做法是 0.5（过半才算），那正是「滑了半张又弹回去」的来源 ——
 *  用户手指动了一大截，画面却回到原点，读起来就是「没有磁力」。 */
const COMMIT_MIN = 0.18;

/** flick 最多能额外带走的格数。必须 < 1：
 *  甩动只该表达「方向 + 我确实想翻」，不该表达「翻三张」。
 *  上一版这里是 2，于是 0.6 格的快甩 = 0.6 + 2 = 2.6 → 落 3 格，就是「跳过一张」。 */
const FLICK_MAX_STEPS = 0.9;

/* 这里刻意没有「一次手势最多翻 N 格」的上限。
   曾经写过 3，是错的：连续滚过整段、或一口气拖过 5 张时，落格会从当前位置
   **倒退**回 origin+3 —— 用户看到的是一次莫名的回弹。
   真实位移推出的 ceiling（见下）已经是唯一正确的限制。 */

/**
 * 把原始角度往最近的卡位拧。
 *
 * 在整数格上是恒等的（`detent(n·step) === n·step`），这条性质很重要：
 * 正好拖过一张卡宽，落点就正好是一张卡，手指与画面不会累积漂移。
 */
export function detent(raw: number, step: number, exponent = DETENT_EXP) {
  if (step <= 0) return raw;
  const cell = raw / step;
  const index = Math.round(cell);
  const frac = cell - index; // ∈ [−0.5, 0.5]
  const warped = Math.sign(frac) * 0.5 * Math.abs(frac * 2) ** exponent;
  return (index + warped) * step;
}

/**
 * detent() 的逆运算。
 *
 * 需要它是因为拖曳会中途接手一个正在飞的弹簧：此刻屏幕上显示的是「已经拧过」的角度，
 * 而拖曳累加的是原始角度。不换算回去，手指一按就会跳一下。
 */
export function undetent(warped: number, step: number, exponent = DETENT_EXP) {
  if (step <= 0) return warped;
  const cell = warped / step;
  const index = Math.round(cell);
  const frac = cell - index;
  const raw = Math.sign(frac) * 0.5 * Math.abs(frac * 2) ** (1 / exponent);
  return (index + raw) * step;
}

/**
 * 决定一次手势落在哪一格（返回相对手势起点的格数，整数）。
 *
 * @param travelSteps 手指/滚动真实走过的格数（带符号，未经 detent 形变）
 * @param flickSteps  由末速度外推出的格数（带符号），离散输入传 0
 *
 * 规则：
 *   · 意图 = 真实位移 + 夹住的 flick；
 *   · 只要意图越过 COMMIT_MIN，就至少进一格 —— 永远不会「动了一下又弹回原位」；
 *   · 之外按 round 取整，所以刻意拖两张就是两张；
 *   · 但落点不会超过「真实位移向外取整」+ 1 格 —— flick 不能凭空多翻。
 */
export function commitSteps(travelSteps: number, flickSteps: number) {
  const dir = Math.sign(travelSteps || flickSteps);
  if (dir === 0) return 0;

  const flick = Math.max(-FLICK_MAX_STEPS, Math.min(FLICK_MAX_STEPS, flickSteps));
  const intent = Math.abs(travelSteps + flick);
  if (intent < COMMIT_MIN) return 0;

  // 真实位移决定上限：整数部分是「已经拖到了的格数」，flick 最多再把你送进下一格。
  // 拖 0.6 格 → 上限 1；拖 1.6 格 → 上限 2。甩得再猛也不会凭空多翻一张。
  const ceiling = Math.floor(Math.abs(travelSteps)) + 1;
  const magnitude = Math.min(Math.max(1, Math.round(intent)), ceiling);
  return dir * magnitude;
}

export const DETENT_TUNING = { DETENT_EXP, COMMIT_MIN, FLICK_MAX_STEPS };
