---
name: Emu — Design System
description: Liquid Glass (Apple iOS 26) design language for the Emu AI image/video studio
colors:
  background: "hsl(210 23% 97%)"
  foreground: "hsl(222 18% 22%)"
  muted-foreground: "hsl(220 10% 49%)"
  primary: "#2d3142"
  primary-deep: "#272b39"
  ring: "hsl(158 17% 44%)"
  destructive: "hsl(2 58% 58%)"
  coin-gold: "#c9a84c"
  coin-gold-light: "#f5e6c0"
  success: "#5b7a5e"
  success-light: "#e7efe9"
  label-eyebrow: "#7b8694"
  ios-blue: "#007AFF"
  ios-green: "#34C759"
  ios-red: "#FF3B30"
  ios-orange: "#FF9500"
  glass-bg-primary: "rgba(255,255,255,0.72)"
  glass-bg-secondary: "rgba(255,255,255,0.56)"
  glass-border-top: "rgba(255,255,255,0.92)"
  glass-border-side: "rgba(255,255,255,0.48)"
  glass-border-bottom: "rgba(0,0,0,0.06)"
typography:
  display:
    fontFamily: "Geist, -apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif"
    fontSize: "1.75rem"
    fontWeight: 600
    lineHeight: "2.125rem"
    letterSpacing: "-0.03em"
  body:
    fontFamily: "Geist, -apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif"
    fontSize: "15px"
    lineHeight: "2rem"
  label:
    fontSize: "11px"
    letterSpacing: "0.18em"
    fontWeight: 500
    color: "{colors.label-eyebrow}"
  body-secondary:
    fontSize: "0.875rem"
    color: "#6e7886"
rounded:
  card: "2.4rem"
  model-card: "2.15rem"
  select: "1.35rem"
  button: "9999px"
  ios-xs: "0.5rem"
  ios-sm: "0.75rem"
  ios-md: "1rem"
  ios-lg: "1.25rem"
  ios-xl: "1.5rem"
  ios-2xl: "2rem"
  ios-3xl: "2.5rem"
  ios-4xl: "3rem"
spacing:
  page-x: "1rem 1.5rem 2rem"
  section: "2rem"
  card-pad: "1.5rem"
blur:
  card: "40px"
  float: "28px"
  bar: "48px"
  sheet: "60px"
motion:
  spring: "cubic-bezier(0.34, 1.56, 0.64, 1)"
  ease: "cubic-bezier(0.4, 0, 0.2, 1)"
  bounce: "cubic-bezier(0.68, -0.55, 0.265, 1.55)"
  appear: "lg-appear 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) both"
  dismiss: "lg-dismiss 0.25s cubic-bezier(0.4, 0, 0.2, 1) both"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "#ffffff"
    rounded: "{rounded.button}"
    padding: "20px 24px"
  button-primary-hover:
    backgroundColor: "{colors.primary-deep}"
  status-badge:
    rounded: "{rounded.button}"
    padding: "8px 16px"
  coin-badge:
    backgroundColor: "{colors.coin-gold-light}"
    textColor: "{colors.coin-gold}"
    rounded: "{rounded.button}"
    padding: "6px 12px"
  glass-card:
    backgroundColor: "{colors.glass-bg-primary}"
    rounded: "{rounded.card}"
  glass-bar:
    backgroundColor: "{colors.glass-bg-secondary}"
    rounded: "{rounded.ios-2xl}"
---

# Design System: Emu — Liquid Glass

## 1. Overview

Emu（AI 圖片/影片生成 SaaS，mobile-first）的視覺語言 = **Apple iOS 26 Liquid Glass**（WWDC25 Session 219）。所有新組件使用 Liquid Glass 材料系統與 `lg-*` class 體系；舊 paper-card / zen-dock / ink-wash 只作 legacy 別名，**不得**用於新組件、不得新增別名。

## 2. The Kit: One Vocabulary For Every Page

- 材料類別（globals.css 定義 CSS 變數 + tailwind 工具類）：`lg-card`（主內容卡，blur 40px / sat 180% / bright 1.08）、`lg-float`（pill/badge/次級面板，blur 28px）、`lg-bar`（navbar/dock/toolbar，blur 48px / sat 200%）、`lg-sheet`（modal/sheet/popover，blur 60px）。
- 色調玻璃：`lg-tint-blue`（#007AFF，主操作/連結）、`lg-tint-green`（#34C759，成功）、`lg-tint-red`（#FF3B30，錯誤/破壞性）、`lg-tint-gold`（#FFB300，錢包/幣）、`lg-fill-active`（選中態）。
- 折射三要素：`backdrop-filter: blur + saturate(180%) + brightness`；頂緣亮邊（rgba(255,255,255,0.92)）、底緣暗邊（rgba(0,0,0,0.06)）。
- 規律：新 UI 一律用 `lg-*` 體系；token 以 tailwind.config.ts 為機器權威，MASTER.md 為總綱。

## 3. Colors

- 語意：`--background` hsl(210 23% 97%)、`--foreground` hsl(222 18% 22%)、`--muted-foreground` hsl(220 10% 49%)、`--primary` #2d3142（CTA/主按鈕）、`--ring` hsl(158 17% 44%)（focus ring/accent）、`--destructive` hsl(2 58% 58%)。
- 財務：`--coin-gold` #c9a84c、`--coin-gold-light` #f5e6c0（錢包/幣 badge）。
- 狀態：`--success` #5b7a5e、`--success-light` #e7efe9。
- iOS 26 系統色（tailwind `ios.*`）：blue #007AFF、green #34C759、red #FF3B30、orange #FF9500、yellow #FFCC00、purple #AF52DE、teal #5AC8FA、indigo #5856D6、gray 六級、label 四級透明度。
- 規則：不引入設計系統外的色板；金/綠/紅只做語意點綴，不喧賓奪主。

## 4. Typography

- 字體：Geist（保留）+ iOS 系統字體棧（-apple-system / SF Pro Display / SF Pro Text）；mono 用 Geist Mono / SF Mono。
- 層級：eyebrow/label = 11px tracking 0.18em #7b8694；次級正文 = text-sm #6e7886；正文 = 15px leading-8；標題 = text-lg font-semibold text-foreground。
- Dynamic Type 尺度（tailwind `ios-*`，caption2 → largetitle）供精細控制。
- 規則：正文不小於 13px、不因版面緊縮行高/字距；數字/價格用等寬感。

## 5. Elevation and Material

- 三層材料階層：card → float → bar（透明 + blur 程度遞進）；`lg-sheet` 為最高層（modal）。
- 每個 card/sheet 需要頂緣 specular 亮線：`<div className="pointer-events-none absolute inset-x-0 top-0 h-px rounded-t-[inherit] bg-gradient-to-r from-transparent via-white to-transparent opacity-80" />`。
- 陰影語彙：主 CTA `shadow-[0_18px_36px_rgba(45,49,66,0.12)]`；卡面以玻璃折射為主，陰影為輔。

## 6. Components

- 主 CTA 按鈕：`bg-[#2d3142] text-white rounded-full px-5 py-3.5 text-sm font-medium shadow-[0_18px_36px_rgba(45,49,66,0.12)] hover:-translate-y-[1px] hover:bg-[#272b39] transition-all duration-200`。
- 狀態 badge：`inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium` + 狀態色。
- 幣值 badge：`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium text-[#c9a84c] bg-[#f5e6c0]/60`。
- 卡片半徑：大卡 `rounded-[2.4rem]`、模型卡 `rounded-[2.15rem]`、select `rounded-[1.35rem]`。
- 圖示：Lucide（已依賴），不用 emoji。

## 7. Interaction and Motion

- Spring 物理：`cubic-bezier(0.34, 1.56, 0.64, 1)` 用於一切互動過渡。
- 進入/退出：`animate-lg-appear` / `animate-lg-dismiss`（scale 0.94→1 + translateY，tailwind 已定義）。
- Hover lift：`hover:-translate-y-[1px]` + `transition-all duration-200`；禁止 hover 造成 layout shift。
- 載入：骨架 pulse 或 Lucide `LoaderCircle` spin；禁用態 `disabled:bg-[#bcc2ca] disabled:cursor-not-allowed`。
- Focus：一律用 `--ring` token，常駐可見。

## 8. Anti-patterns（絕對禁止）

- 不用 emoji 當圖示；不用舊 paper-card / zen-dock / ink-wash 於新組件。
- 不預設 dark mode；不用 `bg-white/10` 於淺色模式（過度透明）。
- 不讓 hover 造成 layout shift；不縮小可讀性換「零滾動」。
- 不暴露服務端金鑰到瀏覽器；客戶端不直連 new-api（走 server proxy）。
- 不把裝飾性百分比當真實控制；UI 宣稱必須有生成證據。
