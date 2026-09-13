"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, MessageCircle, WalletCards } from "lucide-react";
import type { MapayPaymentType } from "@/lib/mapay";
import {
  FLAGSHIP_COINS_PER_IMAGE,
  CUSTOM_PLAN_MAX_COINS,
  CUSTOM_PLAN_MIN_COINS,
  FLAGSHIP_MODEL_LABEL,
  PLAN_REFERENCE_MODEL_LABEL,
  formatCoins,
  gptImage2EquivalentImages,
  planDiscountPercent,
  pricePerGptImage2Image,
  snapCustomCoins,
} from "@/lib/plans";
import type { PricingPlan } from "@/lib/plans";
import { commitSteps, detent, undetent } from "@/lib/carousel-detent";
import { cn } from "@/lib/utils";
import "./case-showcase.css";
import "./pricing-plan-carousel.css";

/* ╁━ 充值方案环（2026-09-07 暴君裁定：/pricing 三列并排 → AI 助理模板同款 carousel）╁━
   本组件是 canvas-workstation/AgentTemplateCarousel.tsx 的逐行复制（复用=整复制改
   白名单，禁造轮子）。几何/物理/手势/吸附/弹簧全部原样未动；白名单改动仅限：
   ① 数据源 = 套餐档（plans prop）+ 自定义档（isCustom 卡，Log Scale 滑杆）；
   ② 卡面内容渲染 = 充值卡（价格/额度换算/卡内收银台），替换模板卡的封面照与环节 Dock；
   ③ 模板专属件移除：PipelineStepSelector、driver.js 教学、确认弹窗、showcase 影片。
   自定义档计价 = coins × 0.045 RMB（唯一权威在 plans.ts 的 customPlanPrice()）。

   ── 2026-09-11 卡面重做（视觉验收：四档卡面全数不合 DESIGN.md）──
   材料/字级/控件/构图四层一起收口，几何与物理仍未动：
   ① 材料：满版粉彩渐变 → .lg-card 白玻璃 + 方案色低透明度晕染（Design.md §2/§5）；
   ② 字级：calc(卡宽×0.068) 的 44px → Dynamic Type 尺度（title3 / largetitle）；
   ③ 控件：原生 accent-color 蓝滑杆 → 自绘轨道/滑块（pricing-plan-carousel.css）；
      未选中 CTA 的 rgba(0,0,0,0.05) 灰底 → 白玻璃胶囊（灰底读起来像禁用态）；
   ④ 构图：三带（头/中/尾），中带吸收卡高余量，卡面中间不再留 140–200px 空洞。
   卡面比例属于白名单②（卡面渲染）：桌面 0.82（卡高下限 384px）、手机 1.45
   （模板卡 0.75 的横构图是给封面照的，充值卡内容竖排且字级固定，需要的高度不同；
   环半径随卡宽等比缩放，物理不变）。 */

interface PricingPlanCarouselProps {
  /** 静态套餐档（已按周期过滤）；引用必须稳定（滑杆拖动不得重建本数组）。 */
  plans: PricingPlan[];
  /** 是否追加「自定义」档（跟随周期过滤：自定义 30 天有效 → 不进季度档）。 */
  includeCustom: boolean;
  /** 动态自定义档对象（父层由滑杆额度用 customPlanFor() 派生；只进卡面渲染）。 */
  customPlan: PricingPlan;
  selectedPlanId: string;
  referenceCoinsPerImage: number;
  payMethod: MapayPaymentType;
  payOpened: boolean;
  refreshingBalance: boolean;
  onSelect: (planId: string) => void;
  onCustomCoinsChange: (coins: number) => void;
  onMethodChange: (method: MapayPaymentType) => void;
  onPay: () => void;
  onRefreshBalance: () => void;
}

/** 每档卡面的固定视觉参数（案例环 glow 机制同款：前卡主色透出光晕）。
 *  色值一律取设计系统色板（DESIGN.md §3）：coin-gold / ios-blue / ios-purple /
 *  ios-green。方案色在卡面上的落点只有三处：环光、卡面晕染（--ppc-tint）、滑杆。 */
const PLAN_GLOWS: Record<string, string> = {
  starter: "#c9a84c",
  popular: "#007AFF",
  pro: "#AF52DE",
  custom: "#34C759",
};

/** 方案色（CSS 变量 --ppc-tint 的 R G B 三元组，见 pricing-plan-carousel.css）。 */
const PLAN_TINTS: Record<string, string> = {
  starter: "201 168 76",
  popular: "0 122 255",
  pro: "175 82 222",
  custom: "52 199 89",
};

/** 卡面转角相对环角的压缩比。1 = 严格贴合圆周切线，但边卡会侧得几乎只剩一条线；
 *  0.82 是「还能看清是什么图」和「有空间纵深」之间的平衡（coverflow 的经典做法）。*/
const TILT = 0.82;
/** 環半徑放大（模板廊同款，不改任何卡片寬高）。 */
const RADIUS_SCALE = 4;
/** 转角上限。夹住之后没有一张卡面会翻过 90°，所以永远不会出现背面。 */
const TILT_MAX = 80;
/** z 位移的软化系数。纯几何的 R(cosφ−1) 会让后排缩得太小，0.78 收一收。 */
const DEPTH = 0.78;
/** 越远越往上抬，环看起来像朝纵深「拱」起，而不是平铺一排。 */
const LIFT = 26;
/** 整段滚动对应的转角：宽屏一圈，窄屏收敛到 200°（手机上主要靠横滑）。 */
const SWEEP_WIDE = 360;
const SWEEP_COMPACT = 200;
/** 拖一张卡的宽度 ≈ 转过一格。 */
/** 拖过「卡宽 × 这个比例」= 转过一格。0.62 让一次自然的滑动就足够跨过一格。 */
const DRAG_CARD_RATIO = 0.62;
/** 末速度 → 外推格数的增益。commit() 会把结果夹在 1 格以内，所以这里只影响
 *  「多快算一次甩动」，不影响「能翻几张」。 */
const FLICK_GAIN = 0.34;
/** 连续输入停止多久算一段手势结束。太长会让落格显得迟疑，太短会把一次滚动切成两段。 */
const SETTLE_MS = 130;
const PANEL_MS = 120;

/* ── 弹簧（模板廊原样）── */
/** 输入进行中（滚动）：硬弹簧，几乎贴着手走。 */
const SPRING_TRACK = { k: 340, ratio: 0.9 };
/** 放手后落格：软一档、阻尼比 0.74 → ~4% 的极轻 overshoot（「吻上去」的手感）。 */
const SPRING_SETTLE = { k: 168, ratio: 0.74 };
/** 单帧最大积分步长。切标签页回来时 dt 可能是几百毫秒，直接积分会炸。 */
const MAX_DT = 1 / 30;

/* ── 光照（模板廊原样）── */
const LIGHT_DEG = -13;
/** 玻璃厚度相对卡宽的比例，和 CSS 的 --case-bevel-w 必须同值。 */
const GLASS = 0.062;

/** 把角度收进 (−180, 180]，让 φ 始终表示「离正面多远」。 */
function wrap(deg: number) {
  return ((((deg + 180) % 360) + 360) % 360) - 180;
}

/** 转到第 index 格时，选与当前值同侧最近的那个等价角 —— 永远走近路，不倒着绕一圈。 */
function nearestAngleFor(index: number, current: number, step: number) {
  const base = index * step;
  return base + Math.round((current - base) / 360) * 360;
}

/** GLSL 的 smoothstep：兩端導數為 0，所以是「平台 → 斷崖 → 平台」而不是單調衰減。 */
function smoothstep(edge0: number, edge1: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** 一张卡在环角 φ 处的完整位姿与光照（模板廊原样，一字未动）。 */
function computeFrame(phi: number) {
  const rad = (phi * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const depth = (cos + 1) / 2; // 1 = 正对镜头，0 = 环的背面
  const tilt = Math.max(-TILT_MAX, Math.min(TILT_MAX, phi * TILT));
  const tiltRad = (tilt * Math.PI) / 180;

  /* 镜面对齐度：卡面法线与「视线⊕光源」的半角向量的夹角余弦。
     三次方是收窄高光的经典做法（Phong 的 shininess）；0.22 是环境光底噪。 */
  const align = Math.max(0, Math.cos(tiltRad - (LIGHT_DEG * Math.PI) / 180));
  const sheen = 0.22 + 0.78 * Math.pow(align, 3);

  /* ── 側壁寬度：為什麼是 tan 而不是 sin ──
     一塊厚 T 的板轉 θ 之後，投影輪廓寬 = W·cosθ + T·sinθ。 */
  const wall = Math.min(Math.abs(Math.tan(tiltRad)), 1.5) * GLASS;

  return {
    /** ×R */ xF: sin,
    /** ×R */ zF: DEPTH * (cos - 1),
    lift: (-LIFT * (1 - cos)) / 2,
    tilt,
    depth,
    /* smoothstep 給的是**平台加斷崖**：0~30° 幾乎不掉，45° 才開始讓位，60° 準時交棒。 */
    opacity: 0.07 + 0.93 * smoothstep(0.34, 1, Math.max(0, 2 * depth - 1)),
    /* 模糊量化到 0.5px：filter 每次变化都要重新栅格化这一层。 */
    blur: Math.round((1 - depth) * 8) / 2,
    zIndex: Math.round(depth * 1000),
    sheen,
    /** ×卡宽：高光带随倾角横向扫过 */
    sheenXF: (tilt / TILT_MAX) * 0.55,
    /** ×卡宽：側壁在卡面座標裡的寬度。 */
    sideLF: tilt > 0 ? wall : 0,
    sideRF: tilt < 0 ? wall : 0,
    /* 迎光侧的棱线。 */
    rimL: tilt > 0 ? 0.20 + 0.42 * Math.abs(Math.sin(tiltRad)) : 0.12 * (1 - Math.abs(Math.sin(tiltRad))),
    rimR: tilt < 0 ? 0.14 + 0.28 * Math.abs(Math.sin(tiltRad)) : 0.07 * (1 - Math.abs(Math.sin(tiltRad))),
    /* ×卡宽：照片沉在玻璃背面，侧看时反向错开。 */
    parallaxF: -Math.sin(tiltRad) * GLASS * 0.25,
  };
}

/** θ=0 时第 index 张卡的位姿，用于首帧和无 JS 状态。 */
function staticFrame(index: number, step: number) {
  const f = computeFrame(wrap(index * step));
  return {
    transform: `translate3d(calc(var(--case-radius) * ${f.xF.toFixed(4)}), ${f.lift.toFixed(2)}px, calc(var(--case-radius) * ${f.zF.toFixed(4)})) rotateY(${f.tilt.toFixed(2)}deg)`,
    opacity: f.opacity.toFixed(3),
    zIndex: f.zIndex,
    "--case-depth": f.depth.toFixed(3),
    "--case-blur": `${f.blur}px`,
    "--case-sheen": f.sheen.toFixed(3),
    "--case-sheen-x": `calc(var(--case-card-w) * ${f.sheenXF.toFixed(4)})`,
    "--case-side-l": `calc(var(--case-card-w) * ${f.sideLF.toFixed(4)})`,
    "--case-side-r": `calc(var(--case-card-w) * ${f.sideRF.toFixed(4)})`,
    "--case-rim-l": f.rimL.toFixed(3),
    "--case-rim-r": f.rimR.toFixed(3),
    "--case-parallax": `calc(var(--case-card-w) * ${f.parallaxF.toFixed(4)})`,
  } as React.CSSProperties;
}

function rgbTriple(hex: string) {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  return `${(value >> 16) & 255} ${(value >> 8) & 255} ${value & 255}`;
}

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/* ── 支付方式（PricingClient 原样迁入：卡内收银台唯一数据源）── */
const PAY_METHODS: { id: MapayPaymentType; label: string; short: string; icon: typeof MessageCircle; tint: string }[] = [
  { id: "wxpay", label: "微信支付", short: "微信", icon: MessageCircle, tint: "text-[#16a05d]" },
  { id: "alipay", label: "支付宝支付", short: "支付宝", icon: WalletCards, tint: "text-[#1677ff]" },
];

/* ── 自定义档 Log Scale 滑杆数学 ──
   t∈[0,1] 线性 → coins = 10^(lerp(log10(2000), log10(1000000), t))，
   显示与计费额度吸附到美观档位（CUSTOM_PLAN_TIERS，对数空间最近邻）。 */
const SLIDER_MAX = 1000;

const LOG_MIN = Math.log10(CUSTOM_PLAN_MIN_COINS);
const LOG_SPAN = Math.log10(CUSTOM_PLAN_MAX_COINS) - LOG_MIN;

function coinsForSliderValue(value: number): number {
  const t = Math.min(1, Math.max(0, value / SLIDER_MAX));
  return 10 ** (LOG_MIN + t * LOG_SPAN);
}

function sliderValueForCoins(coins: number): number {
  const t = (Math.log10(Math.max(1, coins)) - LOG_MIN) / LOG_SPAN;
  return Math.round(Math.min(1, Math.max(0, t)) * SLIDER_MAX);
}

/** 额度展示：≥1 万 → 「X 万」，否则千分位（2,000 / 5,000）。 */
function formatCustomCoins(coins: number): string {
  if (coins >= 10_000) {
    const w = coins / 10_000;
    return `${Number.isInteger(w) ? w : w.toFixed(1)} 万`;
  }
  return coins.toLocaleString("en-US");
}

/** Log Scale 滑杆（自定义档卡面）。
 *  监听器规范（模板廊 Dock 同款血泪，不许砍）：
 *  - onPointerDown stopPropagation：不许把按下滑杆的手势交给 stage 转卡；
 *  - onKeyDown stopPropagation（方向键）：滑杆微调不许同时转环；
 *  - onDragStart preventDefault：防原生拖拽触发 pointercancel 杀手势。
 *  已填充比例由 --ppc-fill 传给 CSS（WebKit 伪元素读得到源元素的自定义属性），
 *  轨道/滑块的画法在 pricing-plan-carousel.css 里，这里只给数值。 */
function CustomAmountSlider({
  coins,
  onChange,
}: {
  coins: number;
  onChange: (coins: number) => void;
}) {
  const sliderValue = sliderValueForCoins(coins);
  return (
    <div
      data-pricing-control
      onPointerDown={(event) => event.stopPropagation()}
      onDragStart={(event) => event.preventDefault()}
    >
      <input
        type="range"
        min={0}
        max={SLIDER_MAX}
        step={1}
        value={sliderValue}
        aria-label="自定义额度"
        aria-valuetext={`${formatCustomCoins(coins)} 金币`}
        onChange={(event) => onChange(snapCustomCoins(coinsForSliderValue(Number(event.target.value))))}
        onKeyDown={(event) => event.stopPropagation()}
        className="ppc-slider"
        style={{ "--ppc-fill": `${((sliderValue / SLIDER_MAX) * 100).toFixed(2)}%` } as React.CSSProperties}
        draggable={false}
      />
      <div className="ppc-ticks mt-1.5 text-ios-footnote text-[rgba(0,0,0,0.56)]" aria-hidden="true">
        <span>2,000</span>
        <span>100 万</span>
      </div>
    </div>
  );
}

/** 卡内收银台（PlanCard 原样迁入：支付方式分段 + 唯一支付 CTA + 刷新闭环）。 */
function CardCheckout({
  plan,
  selected,
  payMethod,
  payOpened,
  refreshingBalance,
  onSelect,
  onMethodChange,
  onPay,
  onRefreshBalance,
}: {
  plan: PricingPlan;
  selected: boolean;
  payMethod: MapayPaymentType;
  payOpened: boolean;
  refreshingBalance: boolean;
  onSelect: (planId: string) => void;
  onMethodChange: (method: MapayPaymentType) => void;
  onPay: () => void;
  onRefreshBalance: () => void;
}) {
  return (
    /* data-pricing-control：按下不进转卡手势（模板廊 data-atc-control 同款约定）。 */
    <div data-pricing-control onPointerDown={(event) => event.stopPropagation()}>
      {selected ? (
        <div className="space-y-3">
          <div role="radiogroup" aria-label="支付方式" className="flex items-center gap-0.5 rounded-full bg-[rgba(0,0,0,0.05)] p-1">
            {PAY_METHODS.map((method) => {
              const active = payMethod === method.id;
              const Icon = method.icon;
              return (
                <button
                  key={method.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={(e) => {
                    e.stopPropagation();
                    onMethodChange(method.id);
                  }}
                  className={cn(
                    "flex flex-1 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-2 text-ios-footnote font-medium transition-all duration-200",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    active
                      ? "bg-white text-[rgba(0,0,0,0.85)] shadow-[0_1px_4px_rgba(0,0,0,0.10)]"
                      : "text-[rgba(0,0,0,0.56)] hover:text-[rgba(0,0,0,0.85)]",
                  )}
                >
                  <Icon className={cn("h-3.5 w-3.5", active && method.tint)} aria-hidden="true" />
                  <span className="min-[420px]:hidden">{method.short}</span>
                  <span className="hidden min-[420px]:inline">{method.label}</span>
                </button>
              );
            })}
          </div>
          {/* 卡内主 CTA：设计系统主按钮（#2d3142 + 玻璃投影 + hover 抬 1px）。 */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onPay();
            }}
            className="w-full cursor-pointer rounded-full bg-[#2d3142] px-5 py-3 text-ios-subhead font-semibold text-white shadow-[0_18px_36px_rgba(45,49,66,0.12)] transition-all duration-200 hover:-translate-y-[1px] hover:bg-[#272b39] active:translate-y-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            立即支付 ¥{plan.price}
          </button>
          {payOpened && (
            <div className="flex items-center justify-between gap-2">
              <p className="min-w-0 flex-1 truncate text-ios-footnote text-[rgba(0,0,0,0.58)]" role="status" aria-live="polite">
                支付页已在新窗口打开，完成后回来刷新余额
              </p>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onRefreshBalance();
                }}
                disabled={refreshingBalance}
                className="shrink-0 cursor-pointer rounded-full bg-[rgba(0,122,255,0.10)] px-3 py-1.5 text-ios-footnote font-semibold text-[#0066DD] transition-colors hover:bg-[rgba(0,122,255,0.16)] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {refreshingBalance ? "刷新中…" : "已完成支付，刷新余额"}
              </button>
            </div>
          )}
        </div>
      ) : (
        /* 未选中 CTA：白玻璃胶囊。旧版是 rgba(0,0,0,0.05) 灰底 —— 在彩色卡面上
           读起来就是一条禁用态的灰条，而不是一个可以按的按钮。 */
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onSelect(plan.id);
          }}
          className="w-full cursor-pointer rounded-full bg-white/70 py-3 text-ios-subhead font-semibold text-[rgba(0,0,0,0.72)] shadow-[0_2px_10px_rgba(0,0,0,0.06)] ring-1 ring-inset ring-[rgba(0,0,0,0.06)] transition-all duration-200 hover:-translate-y-[1px] hover:bg-white/85 hover:text-[rgba(0,0,0,0.85)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          选择此方案
        </button>
      )}
    </div>
  );
}

/** 静态档卡面（原 PlanCard 内容 → 卡面白名单迁移；换算口径全部 catalog 活数据）。 */
function PlanFace({
  plan,
  selected,
  referenceCoinsPerImage,
  payMethod,
  payOpened,
  refreshingBalance,
  onSelect,
  onMethodChange,
  onPay,
  onRefreshBalance,
}: {
  plan: PricingPlan;
  selected: boolean;
  referenceCoinsPerImage: number;
  payMethod: MapayPaymentType;
  payOpened: boolean;
  refreshingBalance: boolean;
  onSelect: (planId: string) => void;
  onMethodChange: (method: MapayPaymentType) => void;
  onPay: () => void;
  onRefreshBalance: () => void;
}) {
  const referenceImages = gptImage2EquivalentImages(plan, referenceCoinsPerImage);
  const flagshipImages = gptImage2EquivalentImages(plan, FLAGSHIP_COINS_PER_IMAGE);
  const discount = planDiscountPercent(plan);
  return (
    <div className="ppc-card">
      {/* 頭帶：檔位徽章 / 折扣 / 已選 → 方案名 → 價格 → 額度口徑 */}
      <div className="ppc-band-top">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {plan.badge && (
            <span
              className={cn(
                "inline-flex w-fit items-center rounded-full px-2.5 py-1 text-ios-caption1 font-semibold",
                plan.highlight
                  ? "bg-[rgba(0,122,255,0.12)] text-[#0066DD]"
                  : "bg-[rgba(0,0,0,0.06)] text-[rgba(0,0,0,0.62)]",
              )}
            >
              {plan.badge}
            </span>
          )}
          {discount !== null && (
            <span className="rounded-full bg-[rgba(201,168,76,0.14)] px-2 py-1 text-ios-caption1 font-semibold text-[#c9a84c]">
              省 {discount}%
            </span>
          )}
          {selected && (
            <span className="inline-flex items-center gap-1 text-ios-caption1 font-semibold text-[#0066DD]">
              <Check className="h-3.5 w-3.5" strokeWidth={3} aria-hidden="true" />
              已选
            </span>
          )}
        </div>

        <h2 className="mt-3 text-ios-title3 font-bold tracking-tight text-[rgba(0,0,0,0.85)]">{plan.name}</h2>

        <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-ios-largetitle font-bold tracking-tight tabular-nums text-[rgba(0,0,0,0.85)]">
            ¥{plan.price}
          </span>
          <span className="text-ios-caption1 text-[rgba(0,0,0,0.44)] line-through">¥{plan.anchorPrice}</span>
        </div>

        <p className="mt-1 text-ios-footnote text-[rgba(0,0,0,0.58)]">
          <span className="font-semibold text-[#c9a84c]">{formatCoins(plan.coins)}</span> 金币 · {plan.validDays} 天有效
        </p>
      </div>

      {/* 中帶：算力具象化（金币 → 张数，两个口径都是 catalog 活数据）。
          手机端只留标准图口径一行，卡面留给收银台。 */}
      <div className="ppc-band-mid">
        <div className="ppc-convert">
          <p className="text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.72)]">
            约 <span className="font-semibold">{referenceImages}</span> 张 1024px 标准图 · {PLAN_REFERENCE_MODEL_LABEL}
          </p>
          <p className="mt-1 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.72)] max-md:hidden">
            约 <span className="font-semibold">{flagshipImages}</span> 张旗舰高清 · {FLAGSHIP_MODEL_LABEL}
          </p>
          <p className="mt-1 text-ios-footnote text-[rgba(0,0,0,0.58)] max-md:hidden">
            折合 ¥{pricePerGptImage2Image(plan, referenceCoinsPerImage)}/张（1K）
          </p>
        </div>
      </div>

      {/* 尾帶：卡內收銀台 */}
      <div className="ppc-band-bot">
        <CardCheckout
          plan={plan}
          selected={selected}
          payMethod={payMethod}
          payOpened={payOpened}
          refreshingBalance={refreshingBalance}
          onSelect={onSelect}
          onMethodChange={onMethodChange}
          onPay={onPay}
          onRefreshBalance={onRefreshBalance}
        />
      </div>
    </div>
  );
}

/** 自定义档卡面：Log Scale 滑杆 + 实时价格（拖动即时更新，计价走 customPlanPrice）。 */
function CustomFace({
  plan,
  selected,
  referenceCoinsPerImage,
  payMethod,
  payOpened,
  refreshingBalance,
  onSelect,
  onCustomCoinsChange,
  onMethodChange,
  onPay,
  onRefreshBalance,
}: {
  plan: PricingPlan;
  selected: boolean;
  referenceCoinsPerImage: number;
  payMethod: MapayPaymentType;
  payOpened: boolean;
  refreshingBalance: boolean;
  onSelect: (planId: string) => void;
  onCustomCoinsChange: (coins: number) => void;
  onMethodChange: (method: MapayPaymentType) => void;
  onPay: () => void;
  onRefreshBalance: () => void;
}) {
  const referenceImages = gptImage2EquivalentImages(plan, referenceCoinsPerImage);
  return (
    <div className="ppc-card">
      {/* 頭帶：檔位徽章 → 方案名 → 額度大字 → Log Scale 滑桿 */}
      <div className="ppc-band-top">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {/* 自定义档用 success 语意色（DESIGN.md §3：--success / --success-light）。 */}
          <span className="inline-flex w-fit items-center rounded-full bg-[#e7efe9] px-2.5 py-1 text-ios-caption1 font-semibold text-[#5b7a5e]">
            自定义
          </span>
          {selected && (
            <span className="inline-flex items-center gap-1 text-ios-caption1 font-semibold text-[#0066DD]">
              <Check className="h-3.5 w-3.5" strokeWidth={3} aria-hidden="true" />
              已选
            </span>
          )}
        </div>

        <h2 className="mt-3 text-ios-title3 font-bold tracking-tight text-[rgba(0,0,0,0.85)]">自定义 · 自由额度</h2>

        <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-ios-largetitle font-bold tracking-tight tabular-nums text-[rgba(0,0,0,0.85)]">
            {formatCustomCoins(plan.coins)}
          </span>
          <span className="text-ios-footnote text-[rgba(0,0,0,0.58)]">金币</span>
          <span className="text-ios-footnote text-[rgba(0,0,0,0.58)]">¥{plan.price} · 0.045 元/金币</span>
        </div>

        <div className="mt-3">
          <CustomAmountSlider coins={plan.coins} onChange={onCustomCoinsChange} />
        </div>
      </div>

      {/* 中帶：換算口徑（手机端只留标准图一行）。 */}
      <div className="ppc-band-mid">
        <div className="ppc-convert">
          <p className="text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.72)]">
            约 <span className="font-semibold">{referenceImages}</span> 张 1024px 标准图 · {PLAN_REFERENCE_MODEL_LABEL}
          </p>
          <p className="mt-1 text-ios-footnote text-[rgba(0,0,0,0.58)] max-md:hidden">30 天有效 · 全模型通用</p>
        </div>
      </div>

      {/* 尾帶：卡內收銀台 */}
      <div className="ppc-band-bot">
        <CardCheckout
          plan={plan}
          selected={selected}
          payMethod={payMethod}
          payOpened={payOpened}
          refreshingBalance={refreshingBalance}
          onSelect={onSelect}
          onMethodChange={onMethodChange}
          onPay={onPay}
          onRefreshBalance={onRefreshBalance}
        />
      </div>
    </div>
  );
}

interface CarouselItem {
  id: string;
  plan: PricingPlan;
  isCustom: boolean;
  glow: string;
}

export function PricingPlanCarousel({
  plans,
  includeCustom,
  customPlan,
  selectedPlanId,
  referenceCoinsPerImage,
  payMethod,
  payOpened,
  refreshingBalance,
  onSelect,
  onCustomCoinsChange,
  onMethodChange,
  onPay,
  onRefreshBalance,
}: PricingPlanCarouselProps) {
  /* 环数据：静态套餐 + 追加自定义档。items 引用必须稳定——滑杆拖动只更新
     customPlan 的内容，不重建本数组（否则每帧触发环回位 reset）。 */
  const items = useMemo<CarouselItem[]>(() => {
    const list: CarouselItem[] = plans.map((plan) => ({
      id: plan.id,
      plan,
      isCustom: false,
      glow: PLAN_GLOWS[plan.id] ?? "#007AFF",
    }));
    if (includeCustom) {
      list.push({
        id: "custom",
        plan: customPlanForPlaceholder(),
        isCustom: true,
        glow: PLAN_GLOWS.custom,
      });
    }
    return list;
    // customPlanForPlaceholder 只占位（卡面渲染用 props.customPlan），故不入依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plans, includeCustom]);
  const cases = items;
  const COUNT = cases.length;
  const STEP = 360 / COUNT;
  /* 静态帧（首帧/无 JS）：cases 不变时引用稳定，React 的 style diff 直接跳过
     ——paint() 每帧写的 transform/opacity 因此不会被 React 覆盖回静态位姿。
     方案色（--ppc-tint，供卡面晕染与滑杆着色）挂在这里：它只随档位变化，
     不参与逐帧计算，放静态帧里正好。 */
  const STATIC_FRAMES = useMemo(
    () =>
      cases.map(
        (item, index) =>
          ({
            ...staticFrame(index, STEP),
            "--ppc-tint": PLAN_TINTS[item.id] ?? "0 122 255",
          }) as React.CSSProperties,
      ),
    [cases, STEP],
  );

  const sectionRef = useRef<HTMLElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const glowRef = useRef<HTMLDivElement | null>(null);
  const cardRefs = useRef<Array<HTMLDivElement | null>>([]);

  /* 每張卡的 GL draw() 佔位（模板廊原樣：GL 層未掛載時為 null，paint 跳過）。 */
  const glDrawRefs = useRef<Array<((tiltDeg: number) => void) | null>>([]);
  const glTiltRefs = useRef<number[]>([]);

  /* 环角只活在 ref 里 —— 每帧 setState 会把卡的 React 树重算 60 次/秒。 */
  const targetRef = useRef(0);
  const angleRef = useRef(0);
  const paintedRef = useRef(Number.NaN);
  const rafRef = useRef(0);
  const frontRef = useRef(0);
  const prevCountRef = useRef(COUNT);

  /* 磁力三角度（模板廊原样）：rawRef 原始累加、angleRef 屏幕角度、originRef 手势起点卡位。 */
  const rawRef = useRef(0);
  const originRef = useRef(0);

  /* 二阶弹簧状态（模板廊原样）。 */
  const velRef = useRef(0);
  const springRef = useRef(SPRING_SETTLE);
  const lastTsRef = useRef(0);

  const engagedRef = useRef(false);
  const lastScrollRef = useRef(0);
  const degPerPxRef = useRef(0.3);
  const radiusRef = useRef(812);
  const cardWRef = useRef(520);
  const dragDegPerPxRef = useRef(0.14);
  const reduceRef = useRef(false);

  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panelTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draggingRef = useRef(false);
  const movedRef = useRef(false);
  const dragXRef = useRef(0);
  const velocityRef = useRef(0);
  const lastMoveAtRef = useRef(0);

  const [front, setFront] = useState(0);
  const [panel, setPanel] = useState(0);

  /** 卡片尺寸、环半径、滚动灵敏度全从舞台实测宽度推出来，写成 CSS 变量。（模板廊原样）
   *  卡宽/卡高与模板廊不同：模板卡是封面照（1.75 倍放大、4:3 横构图），充值卡是
   *  竖排信息的 UI 卡。卡面文字已回到设计系统字级（不随卡宽放大），所以卡高要有
   *  下限：卡面内容堆叠约 330px，低于 384px 就没有留白了。
   *  环半径 = 卡宽 × 0.78 × RADIUS_SCALE，随卡宽等比缩放，物理量一个没动。 */
  const measure = useCallback(() => {
    const stage = stageRef.current;
    const section = sectionRef.current;
    if (!stage) return;

    const stageWidth = stage.clientWidth || 1024;
    const compact = window.matchMedia("(max-width: 767px)").matches;
    const cardW = compact
      ? Math.min(stageWidth * 0.78, 340)
      : Math.min(Math.max(stageWidth * 0.52, 320), 620);
    const cardH = compact
      ? Math.round(cardW * 1.45)
      : Math.max(Math.round(cardW * 0.82), 384);
    const radius = cardW * (compact ? 0.84 : 0.78) * RADIUS_SCALE;

    radiusRef.current = radius;
    cardWRef.current = cardW;
    dragDegPerPxRef.current = STEP / (cardW * DRAG_CARD_RATIO);

    stage.style.setProperty("--case-card-w", `${Math.round(cardW)}px`);
    stage.style.setProperty("--case-card-h", `${cardH}px`);
    stage.style.setProperty("--case-radius", `${Math.round(radius)}px`);
    stage.style.height = `${Math.round(cardH * 1.2)}px`;

    const travel = (section?.offsetHeight ?? 640) + window.innerHeight;
    degPerPxRef.current = (compact ? SWEEP_COMPACT : SWEEP_WIDE) / Math.max(travel, 1);
  }, [STEP]);

  /** 每帧唯一的写 DOM 处。React 不参与：它只在「正面换人」时 render 一次。（模板廊原样） */
  const paint = useCallback((angle: number) => {
    if (angle === paintedRef.current) return;
    paintedRef.current = angle;

    const radius = radiusRef.current;
    const cardW = cardWRef.current;
    let frontIndex = 0;
    let frontDepth = -1;

    for (let i = 0; i < COUNT; i += 1) {
      const node = cardRefs.current[i];
      if (!node) continue;

      const f = computeFrame(wrap(i * STEP - angle));
      const s = node.style;

      s.transform = `translate3d(${(radius * f.xF).toFixed(2)}px, ${f.lift.toFixed(2)}px, ${(radius * f.zF).toFixed(2)}px) rotateY(${f.tilt.toFixed(2)}deg)`;
      s.opacity = f.opacity.toFixed(3);
      s.zIndex = String(f.zIndex);
      s.pointerEvents = f.depth > 0.4 ? "auto" : "none";
      s.setProperty("--case-depth", f.depth.toFixed(3));
      s.setProperty("--case-blur", `${f.blur}px`);
      s.setProperty("--case-sheen", f.sheen.toFixed(3));
      s.setProperty("--case-sheen-x", `${(cardW * f.sheenXF).toFixed(2)}px`);
      s.setProperty("--case-side-l", `${(cardW * f.sideLF).toFixed(2)}px`);
      s.setProperty("--case-side-r", `${(cardW * f.sideRF).toFixed(2)}px`);
      s.setProperty("--case-rim-l", f.rimL.toFixed(3));
      s.setProperty("--case-rim-r", f.rimR.toFixed(3));
      s.setProperty("--case-parallax", `${(cardW * f.parallaxF).toFixed(2)}px`);

      const glDraw = glDrawRefs.current[i];
      if (glDraw && f.depth > 0.5 && Math.abs(f.tilt - (glTiltRefs.current[i] ?? 999)) > 0.4) {
        glTiltRefs.current[i] = f.tilt;
        glDraw(f.tilt);
      }

      if (f.depth > frontDepth) {
        frontDepth = f.depth;
        frontIndex = i;
      }
    }

    for (let i = 0; i < COUNT; i += 1) {
      const node = cardRefs.current[i];
      const flag = i === frontIndex ? "true" : "false";
      if (node && node.dataset.front !== flag) node.dataset.front = flag;
    }

    if (frontIndex !== frontRef.current) {
      frontRef.current = frontIndex;
      setFront(frontIndex);
      glowRef.current?.style.setProperty("--case-glow-rgb", rgbTriple(cases[frontIndex].glow));
      if (panelTimerRef.current) clearTimeout(panelTimerRef.current);
      panelTimerRef.current = setTimeout(() => setPanel(frontIndex), PANEL_MS);
    }
  }, [cases]);

  /* ── 弹簧积分器（模板廊原样：dt 积分，与刷新率解耦）── */
  const tick = useCallback(() => {
    rafRef.current = 0;

    if (reduceRef.current) {
      angleRef.current = targetRef.current;
      velRef.current = 0;
      paint(targetRef.current);
      return;
    }

    const now = performance.now();
    const dt = Math.min((now - lastTsRef.current) / 1000, MAX_DT);
    lastTsRef.current = now;

    const { k, ratio } = springRef.current;
    const c = 2 * ratio * Math.sqrt(k);
    const target = targetRef.current;
    let angle = angleRef.current;
    let vel = velRef.current;

    if (Math.abs(target - angle) > 360) angle = target - Math.sign(target - angle) * 360;

    vel += (-k * (angle - target) - c * vel) * dt;
    angle += vel * dt;

    if (Math.abs(target - angle) < 0.02 && Math.abs(vel) < 0.6) {
      angleRef.current = target;
      velRef.current = 0;
      paint(target);
      return;
    }

    angleRef.current = angle;
    velRef.current = vel;
    paint(angle);
    rafRef.current = requestAnimationFrame(tick);
  }, [paint]);

  const schedule = useCallback(() => {
    if (rafRef.current) return;
    lastTsRef.current = performance.now();
    rafRef.current = requestAnimationFrame(tick);
  }, [tick]);

  /** 落格：按「从手势起点走了几格」决定。（模板廊原样） */
  const commit = useCallback((flickSteps: number) => {
    const travel = (rawRef.current - originRef.current) / STEP;
    const steps = commitSteps(travel, flickSteps);
    const landing = originRef.current + steps * STEP;
    rawRef.current = landing;
    targetRef.current = landing;
    springRef.current = SPRING_SETTLE;
    schedule();
  }, [schedule, STEP]);

  /** 连续输入（滚动 / 触控板横扫）：接收增量 + 磁力 + SETTLE 落格。（模板廊原样） */
  const drive = useCallback((deltaDeg: number) => {
    if (!settleTimerRef.current) {
      originRef.current = Math.round(rawRef.current / STEP) * STEP;
    }
    rawRef.current += deltaDeg;
    targetRef.current = detent(rawRef.current, STEP);
    springRef.current = SPRING_TRACK;
    schedule();
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    settleTimerRef.current = setTimeout(() => {
      settleTimerRef.current = null;
      commit(0);
    }, SETTLE_MS);
  }, [schedule, commit, STEP]);

  /** 离散跳转（箭头 / 圆点 / 键盘）：软弹簧落格。（模板廊原样） */
  const snap = useCallback((value: number) => {
    if (settleTimerRef.current) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
    rawRef.current = value;
    originRef.current = Math.round(value / STEP) * STEP;
    targetRef.current = value;
    springRef.current = SPRING_SETTLE;
    schedule();
  }, [schedule, STEP]);

  /** 拖曳期间手指就是位置本身：不过弹簧、不排 rAF，直接写角度立刻画。（模板廊原样） */
  const dragBy = useCallback((deltaDeg: number) => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
    velRef.current = 0;
    rawRef.current += deltaDeg;
    const warped = detent(rawRef.current, STEP);
    angleRef.current = warped;
    targetRef.current = warped;
    paint(warped);
  }, [paint, STEP]);

  const goTo = useCallback((index: number) => {
    snap(nearestAngleFor(index, targetRef.current, STEP));
  }, [snap]);

  const step = useCallback((dir: number) => {
    snap(Math.round(targetRef.current / STEP) * STEP + dir * STEP);
  }, [snap, STEP]);

  useIsoLayoutEffect(() => {
    measure();
    glowRef.current?.style.setProperty("--case-glow-rgb", rgbTriple(cases[0].glow));
    paintedRef.current = Number.NaN;
    paint(angleRef.current);

    const stage = stageRef.current;
    const observer = new ResizeObserver(() => {
      measure();
      paintedRef.current = Number.NaN;
      paint(angleRef.current);
    });
    if (stage) observer.observe(stage);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure, paint]);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => {
      reduceRef.current = query.matches;
    };
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  /* 档数变化（周期切换）后每格角度改变：环回到第一张，避免旧角度错位落格。（模板廊原样） */
  useEffect(() => {
    if (COUNT === prevCountRef.current) return;
    prevCountRef.current = COUNT;
    targetRef.current = 0;
    angleRef.current = 0;
    rawRef.current = 0;
    originRef.current = 0;
    velRef.current = 0;
    paintedRef.current = Number.NaN;
    if (frontRef.current !== 0) {
      frontRef.current = 0;
      setFront(0);
      setPanel(0);
    }
    glowRef.current?.style.setProperty("--case-glow-rgb", rgbTriple(cases[0].glow));
    paint(0);
  }, [cases, paint]);

  /* 只在这一段进入视野时累计滚动量；离开视野后滚动与它无关。（模板廊原样） */
  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        engagedRef.current = entry.isIntersecting;
        if (entry.isIntersecting) lastScrollRef.current = window.scrollY;
      },
      { rootMargin: "-12% 0px -12% 0px" },
    );
    observer.observe(section);
    return () => observer.disconnect();
  }, []);

  /* 滚动驱动旋转 —— passive 监听、纯读取 scrollY 增量，全程不 preventDefault。（模板廊原样） */
  useEffect(() => {
    const onScroll = () => {
      const y = window.scrollY;
      const delta = y - lastScrollRef.current;
      lastScrollRef.current = y;
      if (!engagedRef.current || draggingRef.current || reduceRef.current) return;
      drive(delta * degPerPxRef.current);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [drive]);

  /* 触控板横扫 / Shift+滚轮。React 的 onWheel 是 passive 注册，preventDefault
     会被忽略，所以必须手动挂 { passive: false }。且只有横向分量占优时才接管，
     纵向一律放行。 */
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
      event.preventDefault();
      drive(event.deltaX * dragDegPerPxRef.current);
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [drive]);

  useEffect(() => () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    if (panelTimerRef.current) clearTimeout(panelTimerRef.current);
  }, []);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    draggingRef.current = true;
    movedRef.current = false;
    dragXRef.current = event.clientX;
    velocityRef.current = 0;
    lastMoveAtRef.current = event.timeStamp;

    if (settleTimerRef.current) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
    /* 半空中接手：屏幕上是 detent() 拧过的角度，拖曳累加的是原始角度。（模板廊原样） */
    rawRef.current = undetent(angleRef.current, STEP);
    originRef.current = Math.round(rawRef.current / STEP) * STEP;

    stageRef.current?.setAttribute("data-dragging", "true");
    stageRef.current?.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    const dx = event.clientX - dragXRef.current;
    if (Math.abs(dx) < 1) return;
    if (Math.abs(dx) > 3) movedRef.current = true;
    dragXRef.current = event.clientX;

    const dt = Math.max(event.timeStamp - lastMoveAtRef.current, 1);
    lastMoveAtRef.current = event.timeStamp;
    velocityRef.current = dx / dt;

    dragBy(-dx * dragDegPerPxRef.current);
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    stageRef.current?.removeAttribute("data-dragging");
    if (stageRef.current?.hasPointerCapture(event.pointerId)) {
      stageRef.current.releasePointerCapture(event.pointerId);
    }

    /* 点击收口（模板廊原样）：setPointerCapture 会把衍生 click 重定向到舞台，
       改成 pointerup 命中测试——没动过 = 一次点击，前卡 = 选中该方案。 */
    if (!movedRef.current) {
      const hit = document.elementFromPoint(event.clientX, event.clientY);
      const slab = hit instanceof Element ? hit.closest(".case-slab") : null;
      const index = slab ? cardRefs.current.indexOf(slab as HTMLDivElement) : -1;
      if (index >= 0) {
        movedRef.current = true;
        if (index === front) {
          const item = cases[front];
          onSelect(item.isCustom ? "custom" : item.id);
        } else {
          goTo(index);
        }
      }
    }

    /* 末速度换算成「格/秒」再乘增益，commit() 夹在 1 格以内。（模板廊原样） */
    const idle = event.timeStamp - lastMoveAtRef.current > 90;
    const flickSteps = idle
      ? 0
      : (-velocityRef.current * 1000 * dragDegPerPxRef.current * FLICK_GAIN) / STEP;
    commit(flickSteps);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      step(1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      step(-1);
    } else if (event.key === "Home") {
      event.preventDefault();
      goTo(0);
    } else if (event.key === "End") {
      event.preventDefault();
      goTo(COUNT - 1);
    }
  };

  /* 点边卡 = 把它转到正面；前卡 onClick 兜底（键盘路径），pointerup 收口为主路径。 */
  const onCardClick = (index: number) => {
    if (movedRef.current) return;
    if (index === front) {
      const item = cases[front];
      onSelect(item.isCustom ? "custom" : item.id);
      return;
    }
    goTo(index);
  };

  const isSelected = (item: CarouselItem) => (item.isCustom ? selectedPlanId === "custom" : selectedPlanId === item.id);

  return (
    <section className="case-viewport pricing-plan-carousel pb-12" aria-label="充值方案" ref={sectionRef}>
      <div
        ref={stageRef}
        className="case-stage"
        role="group"
        aria-roledescription="轮播"
        aria-label={`充值方案，共 ${COUNT} 档`}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
      >
        <div ref={glowRef} className="case-glow" aria-hidden="true" />
        {cases.map((item, index) => (
          <div
            key={item.id}
            ref={(node) => {
              cardRefs.current[index] = node;
            }}
            className="case-slab focus-visible:ring-2 focus-visible:ring-ring"
            style={STATIC_FRAMES[index]}
            data-plan={item.id}
            role="radio"
            aria-checked={isSelected(item)}
            aria-label={item.isCustom ? `自定义方案，当前 ${formatCustomCoins(customPlan.coins)} 金币，${customPlan.price} 元` : `${item.plan.name}，${formatCoins(item.plan.coins)} 金币 ${item.plan.price} 元`}
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelect(item.isCustom ? "custom" : item.id);
              }
            }}
            onClick={() => onCardClick(index)}
          >
            {/* ── 側壁：厚度的唯一真證據（模板廊原样，必須是 .case-face 的兄弟）── */}
            <div className="case-side case-side-l" aria-hidden="true" />
            <div className="case-side case-side-r" aria-hidden="true" />

            <div className="case-face">
              <div className="case-media">
                <div className="case-photo">
                  {/* 卡面材料 = 设计系统 .lg-card（白玻璃 + blur 40 + 顶缘亮边）；
                      方案色由 .ppc-face::before 低透明度晕染，选中环由 ::after 给。 */}
                  <div className="ppc-face lg-card">
                    {item.isCustom ? (
                      <CustomFace
                        plan={customPlan}
                        selected={isSelected(item)}
                        referenceCoinsPerImage={referenceCoinsPerImage}
                        payMethod={payMethod}
                        payOpened={payOpened}
                        refreshingBalance={refreshingBalance}
                        onSelect={onSelect}
                        onCustomCoinsChange={onCustomCoinsChange}
                        onMethodChange={onMethodChange}
                        onPay={onPay}
                        onRefreshBalance={onRefreshBalance}
                      />
                    ) : (
                      <PlanFace
                        plan={item.plan}
                        selected={isSelected(item)}
                        referenceCoinsPerImage={referenceCoinsPerImage}
                        payMethod={payMethod}
                        payOpened={payOpened}
                        refreshingBalance={refreshingBalance}
                        onSelect={onSelect}
                        onMethodChange={onMethodChange}
                        onPay={onPay}
                        onRefreshBalance={onRefreshBalance}
                      />
                    )}
                  </div>
                </div>
              </div>
              {/* 最外緣那條掠射亮線（模板廊原样）。 */}
              <div className="case-edge" aria-hidden="true" />
              <div className="case-surface" aria-hidden="true">
                <div className="case-sheen" />
                <div className="case-rim case-rim-l" />
                <div className="case-rim case-rim-r" />
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* sr-only 播报（模板廊原样，文案换方案语义）。 */}
      <p className="sr-only" aria-live="polite">{`第 ${panel + 1} 档，共 ${COUNT} 档：${cases[panel] ? (cases[panel].isCustom ? "自定义 · 自由额度" : cases[panel].plan.name) : ""}`}</p>

      <div className="mt-4 flex items-center justify-center gap-3 max-md:gap-1.5">
        <button type="button" className="case-arrow lg-float max-md:hidden" onClick={() => step(-1)} aria-label="上一个方案">
          <ChevronLeft className="h-5 w-5" aria-hidden="true" />
        </button>
        <div
          role="tablist"
          aria-label={`方案进度：第 ${front + 1} 档，共 ${COUNT} 档`}
          className="max-md:rounded-full max-md:bg-black/[0.35] max-md:px-3 max-md:py-1.5 max-md:text-[11px] max-md:font-semibold max-md:text-white/85 max-md:[text-shadow:0_1px_2px_rgba(0,0,0,0.6)] flex items-center gap-1"
        >
          {cases.map((item, index) => (
            <button
              key={item.id}
              type="button"
              className={`case-dot ${index !== front ? "max-md:hidden" : ""}`}
              aria-current={index === front}
              aria-label={`第 ${index + 1} 档：${item.isCustom ? "自定义 · 自由额度" : item.plan.name}`}
              onClick={() => goTo(index)}
            >
              {index === front && <span className="max-md:inline hidden">{front + 1}/{COUNT}</span>}
            </button>
          ))}
        </div>
        <button type="button" className="case-arrow lg-float max-md:hidden" onClick={() => step(1)} aria-label="下一个方案">
          <ChevronRight className="h-5 w-5" aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}

/** items 构建期的自定义档占位对象：卡面渲染一律用 props.customPlan（滑杆实时值），
 *  这里只保证 item.plan 类型完整（防止误用静态假数据渲染价格）。 */
function customPlanForPlaceholder(): PricingPlan {
  return {
    id: "custom",
    name: "自定义 · 自由额度",
    tagline: "",
    price: 0,
    anchorPrice: 0,
    coins: 0,
    validDays: 30,
    purchaseUrl: "",
    features: [],
  };
}
