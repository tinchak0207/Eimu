/**
 * 窄框用的短 placeholder（2026-09-30 手机截图实锤）：390px 手机上 textarea 只有
 * ~190px，长句折成两行、第二行被一行高的空框裁掉一半（「／资产图拖进来」只剩上半截）。
 * 手机也拖不了档，「拖进来」那半句对它本来就是废话。
 */
export const DEFAULT_PLACEHOLDER = "描述你想做的，或把剧本／资产图拖进来";
export const COMPACT_PLACEHOLDER = "描述你想做的画面或影片";
/**
 * 触控装置（coarse pointer）用的长 placeholder（2026-10-03 手机端）：手机拖不了档，
 * 「拖进来」对它是做不到的动作，换「传上来」。DEFAULT_PLACEHOLDER 原值不动
 * （桌面继续用，且 agent-chat-ui.test.ts 源码钉死了它）。
 */
const TOUCH_PLACEHOLDER = "描述你想做的，或把剧本／资产图传上来";

/**
 * 基础 placeholder 决策（纯函数，可直测）：内建长句＋触控装置 → 「传上来」版；
 * 其余（桌面、呼叫端自订 placeholder）原样通过。后续 placeholderFits 量字与
 * COMPACT fallback 都对这份被选中的基础句做，逻辑不变。
 */
export function resolveBasePlaceholder(placeholder: string, coarsePointer: boolean): string {
  return coarsePointer && placeholder === DEFAULT_PLACEHOLDER ? TOUCH_PLACEHOLDER : placeholder;
}

/**
 * placeholder 量测的临界安全边际（px）。canvas 量字与实际排版间会有一两 px 的
 * 舍入差，量到「刚好等于框宽」时浏览器仍会把 nowrap 的尾巴裁掉（2026-10-03
 * 390px 实锤：长句量到 288px、clientWidth 284px）。留 8px 让临界值一律回落
 * COMPACT_PLACEHOLDER，不再赌 0px 边界。
 */
export const PLACEHOLDER_SAFETY_PX = 8;

/**
 * 纯函数决策（可直测，无须 DOM）：量得的字宽加安全边际后是否放得进 clientWidth。
 * clientWidth ≤ 0 时无从判量，回 true（沿用原行为：量不到就不误切短句）。
 */
export function placeholderFitsWidth(measured: number, clientWidth: number): boolean {
  return clientWidth <= 0 || measured + PLACEHOLDER_SAFETY_PX <= clientWidth;
}

/**
 * canvas 量字用的字串。getComputedStyle(el).font 在部分浏览器对 textarea 会回
 * 空字串（2026-10-03 Chromium 手机实锤：回 ""），此时 ctx.font 落回预设 10px，
 * 量到 180px → 永远「放得下」→ 长 placeholder 被 nowrap 裁尾（真凶）。
 * shorthand 非空时沿用；空时用长度属性拼出可靠字串（桌面宽框仍量得出长句、不切短）。
 */
function resolveMeasureFont(style: CSSStyleDeclaration): string {
  if (style.font) return style.font;
  const stylePart = style.fontStyle && style.fontStyle !== "normal" ? `${style.fontStyle} ` : "";
  const weightPart = style.fontWeight ? `${style.fontWeight} ` : "";
  const sizePart = style.fontSize || "16px";
  const family = style.fontFamily || "sans-serif";
  return `${stylePart}${weightPart}${sizePart} ${family}`;
}

/** placeholder 在这个框宽下放不放得下一行（canvas 量字，与框同字型）。 */
export function placeholderFits(el: HTMLTextAreaElement, text: string): boolean {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return true;
  ctx.font = resolveMeasureFont(window.getComputedStyle(el));
  return placeholderFitsWidth(ctx.measureText(text).width, el.clientWidth);
}
