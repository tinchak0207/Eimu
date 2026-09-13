"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  BadgeCheck,
  BookOpen,
  Copy,
  Sparkles,
  X,
} from "lucide-react";
import type { MapayPaymentType } from "@/lib/mapay";
import {
  ACTIVE_PRICING_PROMO,
  REFERRAL_REWARD_COINS,
  REFEREE_REWARD_COINS,
  customPlanFor,
  formatCoins,
  modelPriceRows,
  PLANS,
  resolvePricingPlan,
  planUnitsForCoins,
} from "@/lib/plans";
import type { ModelPriceRow, PricingPlan, PricingPromo } from "@/lib/plans";
import { IMAGE_MODEL_IDS, VIDEO_MODEL_IDS, generationCoins } from "@/lib/generation-model-catalog";
import { useAuth } from "@/hooks/use-auth";
import { usePricingRevision } from "@/hooks/use-pricing-revision";
import { fetchAffCode, quotaToCoins, redeemTopupCode } from "@/lib/new-api-client";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { isStandalonePwa, createHandoffLogin } from "@/lib/github-login";
import { PwaHandoffPanel } from "@/components/PwaHandoffPanel";
import { PricingPlanCarousel } from "@/components/PricingPlanCarousel";

/**
 * 2026-09-07 方案选择器 carousel 化：三列并排 → AI 助理模板同款环形轮播
 * （PricingPlanCarousel = AgentTemplateCarousel 逐行复制）。新增「自定义」档：
 * Log Scale 滑杆 2,000 → 100 万金币，按 0.045 RMB/金币实时计价。
 * 全部换算数字由计费 catalog 驱动（活数据）：admin 改价 → usePricingRevision
 * 触发重渲 → 展示跟随，永不脱钩。
 */

const CYCLES = [
  { id: "all", label: "全部" },
  { id: "monthly", label: "月度" },
  { id: "quarterly", label: "季度" },
] as const;
type CycleId = (typeof CYCLES)[number]["id"];

function planMatchesCycle(plan: PricingPlan, cycle: CycleId): boolean {
  if (cycle === "all") return true;
  return cycle === "monthly" ? plan.validDays <= 30 : plan.validDays > 30;
}

/** 活动位：有真实活动数据才渲染；endsAt 存在才有倒计时，否则只显示文案。 */
function ActivityBanner({ promo }: { promo: PricingPromo }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!promo.endsAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [promo.endsAt]);
  const endsAt = promo.endsAt ? new Date(promo.endsAt).getTime() : null;
  const remaining = endsAt !== null && endsAt > now ? Math.floor((endsAt - now) / 1000) : null;
  const countdown =
    remaining !== null
      ? `${Math.floor(remaining / 3600)}:${String(Math.floor((remaining % 3600) / 60)).padStart(2, "0")}:${String(remaining % 60).padStart(2, "0")}`
      : null;
  return (
    <div className="lg-float mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-ios-2xl px-4 py-3">
      <Sparkles className="h-4 w-4 shrink-0 text-[#c9a84c]" aria-hidden="true" />
      <p className="min-w-0 flex-1 text-ios-footnote font-medium text-[rgba(0,0,0,0.72)]">
        {promo.title}
        <span className="ml-2 font-normal text-[rgba(0,0,0,0.58)]">{promo.detail}</span>
      </p>
      {countdown && (
        <span className="rounded-full bg-[rgba(201,168,76,0.14)] px-2.5 py-1 font-mono text-ios-caption1 font-semibold text-[#c9a84c]">
          剩余 {countdown}
        </span>
      )}
    </div>
  );
}

/** 表内分辨率的短标签：1k→1K、1080p→1080P，压缩横向宽度。 */
function resolutionShortLabel(resolution: string): string {
  return resolution.toUpperCase();
}

export function PricingClient() {
  // 訂閱定價覆寫：管理員改價後本頁報價立即重算。
  usePricingRevision();
  const { token, isLoggedIn, refresh } = useAuth();
  const { toast } = useToast();
  const [affCode, setAffCode] = useState<string | null>(null);
  const [affLoading, setAffLoading] = useState(false);
  const [redeemCode, setRedeemCode] = useState("");
  const [redeemLoading, setRedeemLoading] = useState(false);
  // PWA 登录交接面板（standalone 内 GitHub 授权走跨浏览器 handoff）。
  const [pwaHandoffUrl, setPwaHandoffUrl] = useState<string | null>(null);

  // PWA standalone：GitHub 登录态带不进来，改走跨浏览器交接面板。
  const startGithubLogin = () => {
    if (isStandalonePwa()) {
      void createHandoffLogin().then((handoff) => {
        if (handoff) {
          setPwaHandoffUrl(handoff.loginUrl);
          return;
        }
        window.location.href = "/api/auth/github/start";
      });
      return;
    }
    window.location.href = "/api/auth/github/start";
  };
  const [redeemedCoins, setRedeemedCoins] = useState<number | null>(null);
  // 默认选中主力方案：想买默认档的人仍然只需一次点击。
  const [selectedPlanId, setSelectedPlanId] = useState("popular");
  const [payMethod, setPayMethod] = useState<MapayPaymentType>("wxpay");
  const [payOpened, setPayOpened] = useState(false);
  const [refreshingBalance, setRefreshingBalance] = useState(false);
  const [cycle, setCycle] = useState<CycleId>("all");
  // 自定义档额度（金币）。滑杆拖动只更新这个值；checkout 走 custom:<coins> id。
  const [customCoins, setCustomCoins] = useState<number>(20_000);

  const selectedPlan = resolvePricingPlan(selectedPlanId) ?? PLANS[0];

  // 基准单价每次渲染都从有效 catalog（含 admin 覆写）取值——改价后
  // usePricingRevision 触发重渲，套餐换算与单价表全部跟随，无需重新部署。
  const referenceCoinsPerImage = generationCoins("gpt-image-2", { resolution: "1k" });
  const priceRows = modelPriceRows();
  const imageRows = priceRows.filter((row) => row.kind === "image");
  const videoRows = priceRows.filter((row) => row.kind === "video");
  const visiblePlans = PLANS.filter((plan) => planMatchesCycle(plan, cycle));
  // 自定义档 = 30 天有效 → 只进「全部/月度」视图。
  const includeCustom = cycle !== "quarterly";
  // items 引用必须稳定（滑杆拖动不得重建套餐数组，否则环回位）。
  const plansForCarousel = useMemo(() => visiblePlans, [visiblePlans]);
  const customPlan = useMemo(() => customPlanFor(customCoins), [customCoins]);

  useEffect(() => {
    const cdk = new URLSearchParams(window.location.search).get("cdk");
    if (cdk) setRedeemCode(cdk);
  }, []);

  const handleMapayBuy = (planId: string, type: MapayPaymentType) => {
    window.open(`/api/payments/mapay/checkout?plan=${encodeURIComponent(planId)}&type=${encodeURIComponent(type)}`, "_blank");
  };

  const handlePay = () => {
    handleMapayBuy(selectedPlan.id, payMethod);
    // 支付在新窗口完成，卡片内必须给出「然后呢」——状态行 + 刷新余额闭环。
    setPayOpened(true);
  };

  const handleSelectPlan = (planId: string) => {
    setSelectedPlanId(planId);
    // 换了方案，上一次「支付页已打开」的状态行就不再成立。
    setPayOpened(false);
  };

  const handleCustomCoinsChange = (coins: number) => {
    setCustomCoins(coins);
    // 滑杆拖动即视为选中自定义档：价格实时跟随，支付动作立即可用。
    setSelectedPlanId((prev) => (prev === "custom" ? prev : "custom"));
    setPayOpened(false);
  };

  const handleRefreshBalance = async () => {
    setRefreshingBalance(true);
    try {
      await refresh();
      toast({ title: "余额已更新" });
      setPayOpened(false);
    } finally {
      setRefreshingBalance(false);
    }
  };

  const handleFetchAff = async () => {
    if (!token) { startGithubLogin(); return; }
    setAffLoading(true);
    try {
      const res = await fetchAffCode(token);
      if (res.success && res.data) setAffCode(res.data);
      else toast({ title: "获取失败", description: res.message ?? "请稍后再试", variant: "destructive" });
    } catch {
      toast({ title: "网络错误", variant: "destructive" });
    } finally {
      setAffLoading(false);
    }
  };

  const handleCopyAff = () => {
    if (!affCode) return;
    const url = `${window.location.origin}?ref=${affCode}`;
    navigator.clipboard.writeText(url).then(() =>
      toast({ title: "已复制邀请链接" })
    );
  };

  const handleRedeem = async () => {
    if (!token) { startGithubLogin(); return; }
    if (!redeemCode.trim()) return;
    setRedeemLoading(true);
    setRedeemedCoins(null);
    try {
      const res = await redeemTopupCode(token, redeemCode.trim());
      if (res.success) {
        await refresh();
        // 上游返回 quota 单位（500000 = 1 金币），换算后再展示。
        const coins = res.data?.quota ? quotaToCoins(res.data.quota) : null;
        setRedeemedCoins(coins);
        toast({ title: "兑换成功", description: coins ? `已到账 ${coins} 金币` : "金币已到账" });
        setRedeemCode("");
      } else {
        toast({ title: "兑换失败", description: res.message ?? "兑换码无效或已使用", variant: "destructive" });
      }
    } catch {
      toast({ title: "网络错误", variant: "destructive" });
    } finally {
      setRedeemLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-transparent px-4 py-6 pb-10 sm:px-6 sm:py-8 lg:px-8">
      <div className="mx-auto w-full max-w-6xl">

        {/* Header — 标题 + 右上角标准关闭 X（弹窗化：释放垂直高度） */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold tracking-[0.18em] text-[#7b8694]">EMU · 充值方案</p>
            <h1 className="mt-1 text-ios-title1 font-bold tracking-tight text-[rgba(0,0,0,0.85)] sm:text-ios-largetitle">
              选择你的方案
            </h1>
            <p className="mt-1.5 max-w-[36rem] text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">
              金币全模型通用；套餐张数按 GPT Image 2（1K）折算，其他模型按选择器实时标价扣费。
            </p>
          </div>
          <Link
            href="/"
            aria-label="关闭"
            title="关闭"
            className="lg-float flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full text-[rgba(0,0,0,0.56)] transition-colors hover:text-[rgba(0,0,0,0.85)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="h-4 w-4" />
          </Link>
        </div>

        {/* 活动位 — 只有真实活动数据才渲染；无数据整条隐藏 */}
        {ACTIVE_PRICING_PROMO && <ActivityBanner promo={ACTIVE_PRICING_PROMO} />}

        {/* 计费周期切换 — 按套餐 validDays 真实数据过滤 */}
        <div role="tablist" aria-label="计费周期" className="mt-4 flex w-fit items-center gap-0.5 rounded-full bg-[rgba(0,0,0,0.05)] p-1">
          {CYCLES.map((item) => {
            const active = cycle === item.id;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setCycle(item.id)}
                className={cn(
                  "cursor-pointer rounded-full px-3.5 py-1.5 text-ios-footnote font-medium transition-all duration-200",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active
                    ? "bg-white text-[rgba(0,0,0,0.85)] shadow-[0_1px_4px_rgba(0,0,0,0.10)]"
                    : "text-[rgba(0,0,0,0.56)] hover:text-[rgba(0,0,0,0.85)]",
                )}
              >
                {item.label}
              </button>
            );
          })}
        </div>

        {/* 套餐环（carousel）— AI 助理模板同款轮子：点前卡即选，收银台在卡内；
            末位自定义档带 Log Scale 滑杆（2,000 → 100 万金币，0.045 元/金币）。 */}
        <div className="mt-4 sm:mt-5">
          <PricingPlanCarousel
            plans={plansForCarousel}
            includeCustom={includeCustom}
            customPlan={customPlan}
            selectedPlanId={selectedPlanId}
            referenceCoinsPerImage={referenceCoinsPerImage}
            payMethod={payMethod}
            payOpened={payOpened}
            refreshingBalance={refreshingBalance}
            onSelect={handleSelectPlan}
            onCustomCoinsChange={handleCustomCoinsChange}
            onMethodChange={setPayMethod}
            onPay={handlePay}
            onRefreshBalance={handleRefreshBalance}
          />
        </div>

        {/* 附加赠送 — 真实配置（邀请奖励口径）才渲染的浅玻璃条 */}
        <section className="lg-float mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-ios-2xl px-4 py-3 sm:mt-4 sm:px-5">
          <Sparkles className="h-4 w-4 shrink-0 text-[#c9a84c]" aria-hidden="true" />
          <p className="min-w-0 flex-1 text-ios-footnote text-[rgba(0,0,0,0.58)]">
            额外赠送：好友首次充值后你得
            <span className="mx-1 font-semibold text-[#c9a84c]">{REFERRAL_REWARD_COINS} 金币</span>，好友得
            <span className="mx-1 font-semibold text-[#c9a84c]">{REFEREE_REWARD_COINS} 金币</span>，以金币发放、不能提现。
          </p>
          {affCode ? (
            <div className="flex min-w-0 items-center gap-2 rounded-full bg-[rgba(0,0,0,0.04)] px-3 py-1.5">
              {/* 展示的链接必须和「复制」按钮写进剪贴板的完全一致（?ref=，不是 /ref=）。 */}
              <span className="max-w-[16rem] truncate font-mono text-ios-caption1 text-[rgba(0,0,0,0.72)]">
                {`${typeof window !== "undefined" ? window.location.origin : ""}?ref=${affCode}`}
              </span>
              <button
                type="button"
                onClick={handleCopyAff}
                aria-label="复制邀请链接"
                title="复制邀请链接"
                className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-[rgba(0,122,255,0.80)] transition-colors hover:bg-[rgba(0,122,255,0.08)] hover:text-[#007AFF] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Copy className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={handleFetchAff}
              disabled={affLoading}
              className="shrink-0 cursor-pointer rounded-full bg-[rgba(0,0,0,0.05)] px-3.5 py-1.5 text-ios-footnote font-medium text-[rgba(0,0,0,0.62)] transition-all hover:bg-[rgba(0,0,0,0.08)] hover:text-[rgba(0,0,0,0.85)] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {affLoading ? "加载中…" : isLoggedIn ? "查看我的邀请链接" : "登录后查看"}
            </button>
          )}
        </section>

        {/* 模型额度换算明细表 — 计费配置驱动的活数据：行=模型×分辨率单价，列=各档套餐可出张数。 */}
        <section
          aria-labelledby="model-price-heading"
          className="mt-6 lg-card relative overflow-hidden rounded-ios-3xl p-4 sm:mt-10 sm:rounded-ios-4xl sm:p-6"
        >
          <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white to-transparent opacity-80" />
          <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <h3 id="model-price-heading" className="text-ios-subhead font-semibold text-[rgba(0,0,0,0.85)]">
              模型额度换算明细
            </h3>
            <p className="text-ios-caption1 text-[rgba(0,0,0,0.58)]">由计费配置实时计算，改价即生效</p>
          </div>
          <p className="mb-4 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">
            下表就是实际扣费单价：图像按「币/张」、视频按「币/秒」，右侧三列为各档套餐额度具体可出的张数（视频为秒数）。
          </p>

          {/* 长表允许滚动（纵向 max-h + 横向兜底），不硬塞一屏。 */}
          <div className="max-h-[30rem] overflow-y-auto overscroll-contain rounded-ios-2xl bg-[rgba(255,255,255,0.55)] ring-1 ring-inset ring-[rgba(0,0,0,0.06)]">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[40rem] border-collapse text-ios-footnote">
                <thead className="sticky top-0 z-10">
                  <tr className="bg-[rgba(255,255,255,0.94)] text-left text-ios-caption1 text-[rgba(0,0,0,0.58)] backdrop-blur-[20px]">
                    <th scope="col" className="px-4 py-2.5 font-semibold">模型</th>
                    <th scope="col" className="px-3 py-2.5 font-semibold">分辨率</th>
                    <th scope="col" className="px-3 py-2.5 font-semibold">单价</th>
                    {PLANS.map((plan) => (
                      <th key={plan.id} scope="col" className="px-3 py-2.5 text-right font-semibold">
                        <span className="block">{plan.badge}</span>
                        <span className="block font-normal text-[rgba(0,0,0,0.58)]">{plan.coins} 币</span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[
                    { label: "图像 · 币/张", rows: imageRows },
                    { label: "视频 · 币/秒", rows: videoRows },
                  ].map((group) => (
                    <ModelPriceGroup key={group.label} label={group.label} rows={group.rows} />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <p className="mt-3 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">
            视频实际消耗 = 单价 × 时长（生成音频的档位另计）；全部单价以生成页选择器实时标价为准。
          </p>
        </section>

        {/* Redeem code */}
        <section id="redeem" className="mt-6 lg-card relative overflow-hidden rounded-ios-3xl p-4 sm:mt-10 sm:rounded-ios-4xl sm:p-6">
          <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white to-transparent opacity-80" />
          <div className="mb-3 flex items-center justify-between gap-3 sm:mb-4">
            <h3 className="text-ios-subhead font-semibold text-[rgba(0,0,0,0.85)]">兑换码</h3>
            <Link
              href="/docs"
              className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-[rgba(0,0,0,0.04)] px-2.5 py-1 text-ios-caption1 font-medium text-[rgba(0,0,0,0.56)] transition-colors hover:text-[rgba(0,0,0,0.82)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <BookOpen className="h-3.5 w-3.5" />
              教程
            </Link>
          </div>
          <p className="mb-3 text-ios-footnote text-[rgba(0,0,0,0.58)] sm:mb-4">
            输入兑换码，金币会立即到账。
          </p>
          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
            <input
              type="text"
              value={redeemCode}
              onChange={(e) => setRedeemCode(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleRedeem()}
              placeholder="输入兑换码"
              className="min-w-0 rounded-ios-xl border-0 bg-[rgba(0,0,0,0.04)] px-4 py-2.5 text-ios-footnote text-[rgba(0,0,0,0.85)] placeholder:text-[rgba(0,0,0,0.46)] focus:outline-none focus:ring-2 focus:ring-[rgba(0,122,255,0.20)] [background-image:none]"
            />
            <button
              type="button"
              onClick={handleRedeem}
              disabled={redeemLoading || !redeemCode.trim()}
              className="rounded-ios-xl bg-[#007AFF] px-4 py-2.5 text-ios-footnote font-semibold text-white shadow-[0_4px_16px_rgba(0,122,255,0.30)] transition-all hover:bg-[#0066DD] disabled:bg-[rgba(0,0,0,0.16)] disabled:shadow-none cursor-pointer disabled:cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {redeemLoading ? "兑换中" : "兑换"}
            </button>
          </div>
          {/* 兑换成功的反馈留在原地，不只闪一条 toast */}
          {redeemedCoins !== null && (
            <p role="status" className="mt-2.5 flex items-center gap-1.5 text-ios-footnote text-[#248A3D]">
              <BadgeCheck className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              已到账 {redeemedCoins} 金币，余额已更新
            </p>
          )}
        </section>

        {/* FAQ strip */}
        <div className="mt-6 lg-card relative overflow-hidden rounded-ios-3xl p-4 sm:mt-10 sm:rounded-ios-4xl sm:p-6">
          <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white to-transparent opacity-80" />
          <h3 className="mb-4 text-ios-subhead font-semibold text-[rgba(0,0,0,0.85)]">常见问题</h3>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FAQ.map((item) => (
              <div key={item.q}>
                <p className="text-ios-footnote font-semibold text-[rgba(0,0,0,0.72)]">{item.q}</p>
                {/* 答案是成句正文，13px + 0.58 是本站正文可读性的下限。 */}
                <p className="mt-1 text-ios-footnote text-[rgba(0,0,0,0.58)] leading-relaxed">{item.a}</p>
              </div>
            ))}
          </div>
        </div>

      </div>

      {pwaHandoffUrl && (
        <PwaHandoffPanel
          loginUrl={pwaHandoffUrl}
          onSuccess={() => {
            setPwaHandoffUrl(null);
            refresh().catch(() => {});
          }}
          onClose={() => setPwaHandoffUrl(null)}
        />
      )}
    </div>
  );
}

/** 表格分组：组标题行 + 每个模型×分辨率一行，右侧各档套餐可出件数。 */
function ModelPriceGroup({ label, rows }: { label: string; rows: ModelPriceRow[] }) {
  if (rows.length === 0) return null;
  return (
    <>
      <tr className="bg-[rgba(0,0,0,0.03)]">
        <td colSpan={3 + PLANS.length} className="px-4 py-1.5 text-ios-caption1 font-semibold text-[rgba(0,0,0,0.58)]">
          {label}
        </td>
      </tr>
      {rows.map((row) =>
        row.cells.map((cell, index) => (
          <tr key={row.id + ":" + cell.resolution} className="border-t border-[rgba(0,0,0,0.05)]">
            {index === 0 ? (
              <td rowSpan={row.cells.length} className="align-top px-4 py-2.5 font-medium text-[rgba(0,0,0,0.85)]">
                {row.name}
              </td>
            ) : null}
            <td className="px-3 py-2.5 text-[rgba(0,0,0,0.58)]">{resolutionShortLabel(cell.resolution)}</td>
            <td className="px-3 py-2.5">
              <span className="font-semibold text-[#c9a84c]">{formatCoins(cell.coins)}</span>
              <span className="ml-1 text-[rgba(0,0,0,0.58)]">币/{row.unit}</span>
            </td>
            {PLANS.map((plan) => (
              <td key={plan.id} className="px-3 py-2.5 text-right font-medium text-[rgba(0,0,0,0.72)]">
                {planUnitsForCoins(plan, cell.coins)} {row.unit}
              </td>
            ))}
          </tr>
        )),
      )}
    </>
  );
}

const FAQ = [
  {
    q: "金币到期了怎么办？",
    a: "到期前 3 天会提醒。过期后如果还有没用完的金币，我们会退一张等值折扣券，有效期 72 小时。",
  },
  {
    q: "邀请奖励是现金吗？",
    a: "不是。奖励会以金币形式发放，不能提现，也不能转让。",
  },
  {
    q: "支持哪些模型？",
    a: `当前已上架 ${IMAGE_MODEL_IDS.length} 个图像模型和 ${VIDEO_MODEL_IDS.length} 个视频模型，覆盖 GPT Image、Nano Banana、Firefly、FLUX、Runway、Veo、Kling、Seedance、Luma 等系列；以生成页实时列表为准。`,
  },
  {
    q: "可以退款吗？",
    a: "虚拟商品一经发放就不支持退款。如果因为平台故障导致无法使用，会按比例补偿金币。",
  },
  {
    q: "图片怎么扣金币？",
    a: `按模型和分辨率计费。GPT Image 2 为 1K ${generationCoins("gpt-image-2", { resolution: "1k" })} 金币/张、2K ${generationCoins("gpt-image-2", { resolution: "2k" })} 金币/张、4K ${generationCoins("gpt-image-2", { resolution: "4k" })} 金币/张；其他模型以选择器实时标价为准。`,
  },
  {
    q: "视频怎么扣金币？",
    a: "视频按模型、分辨率、时长和音频选项计费，生成前会显示本次预计消耗的金币总数。",
  },
  {
    q: "充值后多久到账？",
    a: "通过兑换码充值会立即到账。如果有延迟，请联系客服，通常 5 分钟内可以解决。",
  },
];
