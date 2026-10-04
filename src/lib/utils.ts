import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

/**
 * iOS Dynamic Type 字級 token（來源：tailwind.config.ts 的 fontSize 區塊）必須手動
 * 註冊進 tailwind-merge 的 `font-size` class group。
 *
 * 根因：tailwind-merge 2.6.0 的 `text-color` 群組用 `fromTheme("colors")`（預設 `[isAny]`）
 * 匹配任意 `text-*`，而 `font-size` 只認 `base` / tshirt size / `[...]` 任意值；因此
 * `text-ios-caption2` 被誤判成 text-COLOR。同一個 cn() 內只要還有任何 `text-<顏色>`，
 * 字級 token 就被整條覆蓋剝除，落到繼承的 body 15px。
 *
 * 註冊後 `text-ios-*`（字級）與 `text-<顏色>` 分屬不同群組，不再互相衝突；
 * `text-ios-red` 等 iOS 系統色仍留在 text-color 群組，顏色仍正確互相覆蓋。
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
