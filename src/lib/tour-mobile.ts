import type { Config, Driver, State } from "driver.js";

/**
 * 引导的移动端适配工具。
 *
 * 背景：driver.js 的定位完全依赖 `getBoundingClientRect()` 与 window 的
 * scroll/resize 事件。专业模式在 <1024px 时是「一次只显示一个工作面」的
 * 布局：左栏 tab 条、顶栏生成按钮、中央视图切换段控件都是 `display:none`
 * 或干脆不渲染，非当前面板整块被隐藏。于是：
 *
 * 1. 锚点元素隐藏 → rect 全 0 → driver.js 认为四个方向都放不下弹层，
 *    退化成「stage 铺满整屏 + 弹层贴在屏幕底部且没有箭头」，也就是
 *    用户看到的「完全没适配 / 严重移位」。
 * 2. 手机端真正的滚动容器是 `.pro-studio-body`（overflow-y:auto），
 *    容器内滚动不冒泡到 window，driver.js 的 refresh 收不到，
 *    高亮框会留在原地和内容错位。
 * 3. 软键盘弹出会改变 visualViewport 而不触发 window resize，
 *    弹层同样会错位。
 *
 * 这里提供的三件事分别对应上面三点：可见锚点解析、容器滚动/视口同步、
 * 移动端安全的弹层方位。
 */

export const MOBILE_TOUR_QUERY = "(max-width: 1023px)";

export function isMobileTourViewport(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia(MOBILE_TOUR_QUERY).matches;
}

/** 触摸设备上不播放假鼠标演示：没有指针可言，且 hover 事件不会产生预期效果。 */
export function prefersTouchTour(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(hover: none), (pointer: coarse)").matches;
}

/**
 * 元素是否真的能被高亮：existing + 没被 display:none 折叠 + 有实际面积。
 * `offsetParent === null` 覆盖父级隐藏的情况（position:fixed 除外，这里
 * 用 rect 面积兜底）。
 */
export function isHighlightable(element: Element | null | undefined): element is Element {
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 1 && rect.height > 1;
}

/**
 * 按顺序返回第一个「真的可见」的锚点。
 *
 * 与旧的 `document.querySelector(...) ?? document.body` 相比关键差别是
 * 跳过隐藏元素——命中隐藏元素比命中 body 更糟：body 至少还是「无锚点居中」，
 * 隐藏元素会得到一个 0×0 的高亮框钉在左上角。
 */
export function firstVisibleAnchor(...selectors: string[]): () => Element {
  return () => {
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (isHighlightable(element)) return element;
    }
    return document.body;
  };
}

/* ── F1-2 零锚点防退化门禁 ──────────────────────────────────────────────
   锚点 rect 为零时 driver.js 会退化成「stage 罩满全屏 + 弹层定位失效」，
   用户看到的就是「整页变灰、没有弹层、按钮点不到」。三个引导实例
   （atc 教学 / 工作站两场 / ModelPicker LoRA）每步都要过这道门。 */

/** 锚点是否真的可用：存在 + 宽高 > 0 + 与视口有交集。 */
export function anchorHasRect(element: Element | null | undefined): element is Element {
  if (!element) return false;
  if (typeof window === "undefined") return false;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  return rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
}

type AnchorGateOpts = {
  config: Pick<Config, "steps">;
  state: Pick<State, "activeIndex">;
  driver: Driver;
};

/** 锚点失效时跳到下一步（末步则整场收尾），绝不留在「全屏灰且无弹层」状态。 */
function skipOrFinishFrom(tour: Driver, index: number): void {
  const total = tour.getConfig().steps?.length ?? 0;
  if (index >= total - 1) tour.destroy();
  else tour.moveTo(index + 1);
}

/** onHighlightStarted 即时门禁：锚点此刻没有真实 rect → 跳步/收场。
 *  适用于锚点在 highlight 时就已解析定型的引导（atc 教学 / ModelPicker）。 */
export function skipStepOnMissingAnchor(element: Element | undefined, opts: AnchorGateOpts): boolean {
  if (anchorHasRect(element)) return false;
  skipOrFinishFrom(opts.driver, opts.state.activeIndex ?? 0);
  return true;
}

/**
 * 弹层方位：手机端一律走垂直方向。
 *
 * 手机上锚点基本是整行宽（左右都塞不进 300px 的弹层），driver.js 会依次
 * 尝试 left → right → top → bottom，四个都放不下时退化成「铺满屏幕」。
 * 直接给 top/bottom 就绕开了这条退化路径。
 */
export function tourSide(
  desktopSide: "left" | "right" | "top" | "bottom",
  mobile: boolean,
  mobileSide: "top" | "bottom" = "bottom",
): "left" | "right" | "top" | "bottom" {
  return mobile ? mobileSide : desktopSide;
}

/**
 * 把内部滚动容器的滚动、以及软键盘引起的 visualViewport 变化，接到
 * driver.js 的 refresh 上。返回解绑函数。
 */
export function bindTourViewportSync(tour: Pick<Driver, "refresh">): () => void {
  if (typeof window === "undefined") return () => {};

  let frame = 0;
  const refresh = () => {
    if (frame) return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      tour.refresh();
    });
  };

  // capture 阶段才能收到内部容器的 scroll（scroll 事件不冒泡）
  document.addEventListener("scroll", refresh, true);
  window.visualViewport?.addEventListener("resize", refresh);
  window.visualViewport?.addEventListener("scroll", refresh);
  window.addEventListener("orientationchange", refresh);

  return () => {
    if (frame) window.cancelAnimationFrame(frame);
    document.removeEventListener("scroll", refresh, true);
    window.visualViewport?.removeEventListener("resize", refresh);
    window.visualViewport?.removeEventListener("scroll", refresh);
    window.removeEventListener("orientationchange", refresh);
  };
}

/**
 * 切面板 → 等 React 渲染 → 重算高亮。
 *
 * 手机端每一步都可能需要先把对应工作面切出来，而 setState 是异步的：
 * 不等渲染就 refresh，driver.js 量到的还是上一帧（往往是隐藏态）的 rect。
 */
type TourRefreshTarget = Pick<Driver, "refresh"> | null | undefined;

export function refreshTourAfterLayout(
  tour: TourRefreshTarget | (() => TourRefreshTarget),
  delays: number[] = [80, 260],
): void {
  if (typeof window === "undefined") return;
  const resolve = typeof tour === "function" ? tour : () => tour;
  for (const delay of delays) {
    window.setTimeout(() => resolve()?.refresh(), delay);
  }
}

/** 把锚点滚进视野：手机端锚点常在 `.pro-studio-body` 的滚动区里。 */
export function scrollAnchorIntoView(selector: string): void {
  if (typeof document === "undefined") return;
  const element = document.querySelector(selector);
  if (!isHighlightable(element)) return;
  element.scrollIntoView({ block: "center", inline: "nearest" });
}
