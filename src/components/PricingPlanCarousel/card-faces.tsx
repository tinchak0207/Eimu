import { MessageCircle, WalletCards } from "lucide-react";
import type { MapayPaymentType } from "@/lib/mapay";
import { FLAGSHIP_COINS_PER_IMAGE, FLAGSHIP_MODEL_LABEL, PLAN_REFERENCE_MODEL_LABEL, formatCoins, gptImage2EquivalentImages, snapCustomCoins } from "@/lib/plans";
import type { PricingPlan } from "@/lib/plans";
import { cn } from "@/lib/utils";
import { TIER_COPY, isWorldId, type WorldId } from "@/components/pricing3d/worlds";
import { SLIDER_MAX, coinsForSliderValue, formatCustomCoins, sliderValueForCoins } from "./slider-math";

/** 每档卡面的固定视觉参数（案例环 glow 机制同款：前卡主色透出光晕）。
 *  色值一律取设计系统色板（DESIGN.md §3）：coin-gold / ios-blue / ios-purple /
 *  ios-green。方案色在卡面上的落点只有三处：环光、卡面晕染（--ppc-tint）、滑杆。 */
export const PLAN_GLOWS: Record<string, string> = {
  starter: "#c9a84c",
  popular: "#007AFF",
  pro: "#AF52DE",
  custom: "#34C759",
};

/** 方案色（CSS 变量 --ppc-tint 的 R G B 三元组，见 pricing-plan-carousel.css）。 */
export const PLAN_TINTS: Record<string, string> = {
  starter: "201 168 76",
  popular: "0 122 255",
  pro: "175 82 222",
  custom: "52 199 89",
};
/* ── 支付方式（PricingClient 原样迁入：卡内收银台唯一数据源）── */
const PAY_METHODS: { id: MapayPaymentType; label: string; short: string; icon: typeof MessageCircle; tint: string }[] = [
  { id: "wxpay", label: "微信支付", short: "微信", icon: MessageCircle, tint: "text-[#16a05d]" },
  { id: "alipay", label: "支付宝支付", short: "支付宝", icon: WalletCards, tint: "text-[#1677ff]" },
];
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
          <div role="radiogroup" aria-label="支付方式" className="flex items-center gap-0.5 rounded-full bg-[rgba(58,80,160,0.08)] p-1 shadow-[inset_0_1px_2px_rgba(58,80,160,0.08)]">
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
                      ? "bg-white text-[color:var(--t-ink)] shadow-[0_2px_8px_rgba(58,80,160,0.18)]"
                      : "text-[color:var(--t-ink-2)] hover:text-[color:var(--t-ink)]",
                  )}
                >
                  <Icon className={cn("h-3.5 w-3.5", active && method.tint)} aria-hidden="true" />
                  <span className="min-[420px]:hidden">{method.short}</span>
                  <span className="hidden min-[420px]:inline">{method.label}</span>
                </button>
              );
            })}
          </div>
          {/* 卡内主 CTA：珍珠白票面上唯一的深墨蓝液态玻璃（掠光 + 粉蓝柔光，hover 抬 1px）。 */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onPay();
            }}
            className="ppc-cta text-ios-subhead font-semibold"
          >
            立即支付 ¥{plan.price}
          </button>
          {payOpened && (
            <div className="flex items-center justify-between gap-2">
              <p className="min-w-0 flex-1 truncate text-ios-footnote text-[color:var(--t-ink-2)]" role="status" aria-live="polite">
                支付页已在新窗口打开，完成后回来刷新余额
              </p>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onRefreshBalance();
                }}
                disabled={refreshingBalance}
                className="shrink-0 cursor-pointer rounded-full bg-[rgba(59,130,255,0.12)] px-3 py-1.5 text-ios-footnote font-semibold text-[#2f6fe8] transition-colors hover:bg-[rgba(59,130,255,0.2)] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {refreshingBalance ? "刷新中…" : "已完成支付，刷新余额"}
              </button>
            </div>
          )}
        </div>
      ) : (
        /* 未选中 CTA：珍珠白票面上的描边胶囊（墨字 + 细边），读起来是可按的按钮而非禁用灰条。 */
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onSelect(plan.id);
          }}
          className="w-full cursor-pointer rounded-full bg-white/80 py-3 text-ios-subhead font-semibold text-[color:var(--t-ink)] shadow-[0_4px_14px_rgba(58,80,160,0.14)] ring-1 ring-inset ring-[rgba(58,80,160,0.18)] transition-all duration-200 hover:-translate-y-[1px] hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          选择此方案
        </button>
      )}
    </div>
  );
}

/* ── 票面：一眼看懂「给谁的、能画多少、每张多少钱」（2026-09-26 暴君：/pricing 的第一性原理
   = 让人马上心动、一眼知道自己适合哪档、能充多少额度）。所有数字 catalog 现算，不写死。 */

export function worldOf(id: string): WorldId {
  return isWorldId(id) ? id : "popular";
}

/** 每张约多少元（按套餐基准模型折算）。 */
function perImageYuan(plan: PricingPlan, coinsPerImage: number): string {
  const images = gptImage2EquivalentImages(plan, coinsPerImage);
  if (images <= 0) return "—";
  const v = plan.price / images;
  return v >= 1 ? v.toFixed(2) : String(Number(v.toFixed(3)));
}

/** 相对入门档（金币最少的那档）的每金币单价省了多少（%，四舍五入；不省则 0）。 */
function savingPercent(plan: PricingPlan, baseline: PricingPlan | null): number {
  if (!baseline || baseline.coins <= 0 || plan.coins <= 0 || plan.id === baseline.id) return 0;
  const r = 1 - plan.price / plan.coins / (baseline.price / baseline.coins);
  return r > 0.005 ? Math.round(r * 100) : 0;
}

/** 档位梯的额度条：对数刻度（100 → 17%、500 → 41%、1500 → 57%、2 万 → 94%）。 */
export function ladderFill(coins: number): number {
  const f = Math.log10(Math.max(coins, 30) / 30) / Math.log10(30_000 / 30);
  return Math.min(1, Math.max(0.08, f));
}

function TicketHead({ world, images, meta }: { world: WorldId; images: number; meta: string }) {
  return (
    <>
      <p className="text-ios-footnote text-[color:var(--t-ink-2)]">
        <span className="ppc-tier-dot" data-world={world} aria-hidden="true" />
        <span className="font-semibold text-[color:var(--t-ink)]">{TIER_COPY[world].short}</span>
        <span className="mx-1.5 text-[color:var(--t-ink-3)]">·</span>
        {TIER_COPY[world].persona}
      </p>
      <div className="mt-1.5 flex items-baseline gap-1.5">
        <span className="text-ios-subhead font-semibold text-[color:var(--t-ink-2)]">约</span>
        <span className="ppc-quota text-ios-largetitle font-bold tracking-tight tabular-nums">{images.toLocaleString("en-US")}</span>
        <span className="text-ios-subhead font-semibold text-[color:var(--t-ink)]">张图</span>
      </div>
      <p className="mt-0.5 text-ios-footnote text-[color:var(--t-ink-3)]">{meta}</p>
    </>
  );
}

function PriceRow({ price, anchor, unit, saving }: { price: number; anchor: string | null; unit: string; saving: number }) {
  return (
    <div className="mt-3 flex flex-wrap items-end justify-between gap-x-3 gap-y-1">
      <div className="flex items-baseline gap-2">
        <span className="text-ios-title1 font-bold tracking-tight tabular-nums text-[color:var(--t-ink)]">¥{price}</span>
        {anchor && <span className="text-ios-footnote text-[color:var(--t-ink-3)] line-through">{anchor}</span>}
      </div>
      <span className="text-ios-footnote text-[color:var(--t-ink-2)]">
        每张约 ¥{unit}
        {saving > 0 && <span className="ppc-save">省 {saving}%</span>}
      </span>
    </div>
  );
}

/** 静态档卡面（原 PlanCard 内容 → 卡面白名单迁移；换算口径全部 catalog 活数据）。 */
export function PlanFace({
  plan,
  baseline,
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
  baseline: PricingPlan | null;
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
  const world = worldOf(plan.id);
  return (
    <div className="ppc-card">
      {/* 换算口径全文（读屏）；票面上是精简版。 */}
      <div className="sr-only">
        <p>{plan.name} · {formatCoins(plan.coins)} 金币 · {plan.validDays} 天有效</p>
        <p>
          约 <span className="font-semibold">{referenceImages}</span> 张 1024px 标准图 · {PLAN_REFERENCE_MODEL_LABEL}
        </p>
        <p>
          约 <span className="font-semibold">{flagshipImages}</span> 张旗舰高清 · {FLAGSHIP_MODEL_LABEL}
        </p>
      </div>

      {/* 浮在 3D 之上的票面：给谁的 → 能画多少张 → 多少钱、每张多少 → 支付。 */}
      <div className="ppc-glass">
        <TicketHead world={world} images={referenceImages} meta={`${formatCoins(plan.coins)} 金币 · ${plan.validDays} 天有效 · 按 GPT Image 2（1K）折算`} />
        <PriceRow
          price={plan.price}
          anchor={plan.anchorPrice > plan.price ? `¥${plan.anchorPrice}` : null}
          unit={perImageYuan(plan, referenceCoinsPerImage)}
          saving={savingPercent(plan, baseline)}
        />
        <div className="mt-3">
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
    </div>
  );
}

/** 自定义档卡面：Log Scale 滑杆 + 实时价格（拖动即时更新，计价走 customPlanPrice）。 */
export function CustomFace({
  plan,
  baseline,
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
  baseline: PricingPlan | null;
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
      <div className="sr-only">
        <p>自定义 · 自由额度 · {formatCustomCoins(plan.coins)} 金币 · 30 天有效</p>
        <p>
          约 <span className="font-semibold">{referenceImages}</span> 张 1024px 标准图 · {PLAN_REFERENCE_MODEL_LABEL}
        </p>
      </div>

      {/* 票面：给谁的 → 能画多少张（随滑杆实时变）→ 滑杆（拖动 = 3D 卡堆原地伸缩，松手 = 落一轮）→ 价格 → 支付。 */}
      <div className="ppc-glass">
        <TicketHead world="custom" images={referenceImages} meta={`${formatCustomCoins(plan.coins)} 金币 · 30 天有效 · 按 GPT Image 2（1K）折算`} />
        <div className="mt-2.5">
          <CustomAmountSlider coins={plan.coins} onChange={onCustomCoinsChange} />
        </div>
        <PriceRow price={plan.price} anchor={null} unit={perImageYuan(plan, referenceCoinsPerImage)} saving={savingPercent(plan, baseline)} />
        <div className="mt-2.5">
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
    </div>
  );
}
