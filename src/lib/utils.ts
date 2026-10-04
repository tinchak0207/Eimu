import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

/**
 * iOS Dynamic Type 字级 token（来源：tailwind.config.ts 的 fontSize 区块）必须手动
 * 注册进 tailwind-merge 的 `font-size` class group。
 *
 * 根因：tailwind-merge 2.6.0 的 `text-color` 群组用 `fromTheme("colors")`（预设 `[isAny]`）
 * 匹配任意 `text-*`，而 `font-size` 只认 `base` / tshirt size / `[...]` 任意值；因此
 * `text-ios-caption2` 被误判成 text-COLOR。同一个 cn() 内只要还有任何 `text-<颜色>`，
 * 字级 token 就被整条覆盖剥除，落到继承的 body 15px。
 *
 * 注册后 `text-ios-*`（字级）与 `text-<颜色>` 分属不同群组，不再互相冲突；
 * `text-ios-red` 等 iOS 系统色仍留在 text-color 群组，颜色仍正确互相覆盖。
 */
const iosFontSizeTokens = [
  "ios-caption2",
  "ios-caption1",
  "ios-footnote",
  "ios-subhead",
  "ios-callout",
  "ios-body",
  "ios-headline",
  "ios-title3",
  "ios-title2",
  "ios-title1",
  "ios-largetitle",
] as const

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: [...iosFontSizeTokens] }],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
