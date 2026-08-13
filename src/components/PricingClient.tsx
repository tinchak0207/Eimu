"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  BadgeCheck,
  BookOpen,
  Check,
  Copy,
  MessageCircle,
  WalletCards,
} from "lucide-react";
import type { MapayPaymentType } from "@/lib/mapay";
import {
  PLAN_REFERENCE_COINS_PER_IMAGE,
  PLAN_REFERENCE_MODEL_LABEL,
  PLANS,
  gptImage2EquivalentImages,
  pricePerGptImage2Image,
} from "@/lib/plans";
import { IMAGE_MODEL_IDS, VIDEO_MODEL_IDS, generationCoins } from "@/lib/generation-model-catalog";
import { useAuth } from "@/hooks/use-auth";
import { usePricingRevision } from "@/hooks/use-pricing-revision";
import { fetchAffCode, quotaToCoins, redeemTopupCode } from "@/lib/new-api-client";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

/**
 * 充值页走 App Store 收银架构：先选方案（radio 卡片），再在唯一的
 * 结账栏里选支付方式、点唯一的支付按钮。之前是每张卡塞两个支付按钮，
 * 首屏六个 CTA 互相打架——Apple 从不这么做。
 */

const PAY_METHODS: { id: MapayPaymentType; label: string; short: string; icon: typeof MessageCircle; tint: string }[] = [
  { id: "wxpay", label: "微信支付", short: "微信", icon: MessageCircle, tint: "text-[#16a05d]" },
  { id: "alipay", label: "支付宝支付", short: "支付宝", icon: WalletCards, tint: "text-[#1677ff]" },
];

export function PricingClient() {
  // 訂閱定價覆寫：管理員改價後本頁報價立即重算。
  usePricingRevision();
  const { token, isLoggedIn, refresh } = useAuth();
  const { toast } = useToast();
  const [affCode, setAffCode] = useState<string | null>(null);
  const [affLoading, setAffLoading] = useState(false);
  const [redeemCode, setRedeemCode] = useState("");
  const [redeemLoading, setRedeemLoading] = useState(false);
  const [redeemedCoins, setRedeemedCoins] = useState<number | null>(null);
  // 默认选中主力方案：想买默认档的人仍然只需一次点击。
  const [selectedPlanId, setSelectedPlanId] = useState("popular");
  const [payMethod, setPayMethod] = useState<MapayPaymentType>("wxpay");
  const [payOpened, setPayOpened] = useState(false);
  const [refreshingBalance, setRefreshingBalance] = useState(false);

  const selectedPlan = PLANS.find((plan) => plan.id === selectedPlanId) ?? PLANS[0];

  useEffect(() => {
    const cdk = new URLSearchParams(window.location.search).get("cdk");
    if (cdk) setRedeemCode(cdk);
  }, []);

  const handleMapayBuy = (planId: string, type: MapayPaymentType) => {
    window.open(`/api/payments/mapay/checkout?plan=${encodeURIComponent(planId)}&type=${encodeURIComponent(type)}`, "_blank");
  };

  const handlePay = () => {
    handleMapayBuy(selectedPlan.id, payMethod);
    // 支付在新窗口完成，本页必须给出「然后呢」——状态行 + 刷新余额闭环。
    setPayOpened(true);
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
    if (!token) { window.location.href = "/api/auth/github/start"; return; }
    setAffLoading(true);
    try {
      const res = await fetchAffCode(token);
      if (res.success && res.data) setAffCode(res.data);
      else toast({ title: "获取失败", description: res.message ?? "请稍后再试", variant: "destructive" });
    } catch {
      toast({ title: "网络错误", variant: "destructive" });
    } finally { setAffLoading(false); }
  };

  const handleCopyAff = () => {
    if (!affCode) return;
    const url = `${window.location.origin}?ref=${affCode}`;
    navigator.clipboard.writeText(url).then(() =>
      toast({ title: "已复制邀请链接" })
    );
  };

  const handleRedeem = async () => {
    if (!token) { window.location.href = "/api/auth/github/start"; return; }
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
    } finally { setRedeemLoading(false); }
  };

  return (
    <>
      <div className="mobile-pricing-compact min-h-screen bg-transparent px-4 pb-44 pt-20 sm:px-6 sm:pb-48 lg:px-8">
        <div className="mx-auto w-full max-w-5xl">

          {/* Back nav — 与 /history、/docs 同一颗玻璃胶囊 */}
          <Link
            href="/"
            className="lg-float mb-5 inline-flex items-center gap-2 rounded-full px-3.5 py-2 text-ios-footnote font-medium text-[rgba(0,0,0,0.56)] lg-transition hover:text-[rgba(0,0,0,0.82)] cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(0,122,255,0.30)] sm:mb-8 sm:px-4 sm:py-2.5"
            aria-label="返回做图"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            返回做图
          </Link>

          {/* Header — 全站统一的 iOS 大标题版式：左对齐，标题 + 一句副标 */}
          <div className="mb-6 sm:mb-10">
            <h1 className="text-ios-title1 font-bold tracking-tight text-[rgba(0,0,0,0.85)] sm:text-ios-largetitle">
              选择你的方案
            </h1>
            <p className="mt-2 max-w-[36rem] text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)] sm:text-ios-body">
              金币全模型通用；套餐张数按 GPT Image 2（1K）折算，其他模型按实时标价扣费。
            </p>
          </div>

          {/* Plan cards — radio 选择，不直接付款 */}
          <div role="radiogroup" aria-label="充值方案" className="mobile-pricing-plans grid gap-3 sm:grid-cols-3 sm:gap-4">
            {PLANS.map((plan) => {
              const selected = plan.id === selectedPlanId;
              const referenceImages = gptImage2EquivalentImages(plan);
              return (
                <button
                  key={plan.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => {
                    setSelectedPlanId(plan.id);
                    // 换了方案，上一次「支付页已打开」的状态行就不再成立。
                    setPayOpened(false);
                  }}
                  className={cn(
                    // 手机是横向一行（名称/规格 ←→ 价格），桌面是竖排卡片。
                    "lg-card relative flex w-full cursor-pointer items-center justify-between gap-3 overflow-hidden rounded-ios-3xl p-4 pr-12 text-left transition-all duration-200 sm:block sm:rounded-ios-4xl sm:p-6",
                    "focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(0,122,255,0.45)] focus-visible:ring-offset-2",
                    selected
                      ? "ring-2 ring-[#007AFF] shadow-[0_20px_60px_rgba(0,122,255,0.16),0_4px_16px_rgba(0,0,0,0.06)]"
                      : "ring-1 ring-transparent hover:ring-[rgba(0,122,255,0.22)]",
                    plan.highlight && "sm:scale-[1.02]",
                  )}
                >
                  <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white to-transparent opacity-80" />

                  {/* 选中指示 — 与历史页多选勾选圈同一套语言 */}
                  <span
                    aria-hidden="true"
                    className={cn(
                      "absolute right-4 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full transition-all duration-200 sm:right-5 sm:top-5 sm:translate-y-0",
                      selected
                        ? "bg-[#007AFF] text-white shadow-[0_4px_12px_rgba(0,122,255,0.32)]"
                        : "border border-[rgba(0,0,0,0.14)] bg-[rgba(255,255,255,0.72)] text-transparent",
                    )}
                  >
                    <Check className="h-3.5 w-3.5" strokeWidth={3} />
                  </span>

                  <div className="min-w-0">
                    {plan.badge && (
                      <span
                        className={cn(
                          "mb-2 hidden w-fit items-center rounded-full px-2.5 py-0.5 text-ios-caption1 font-semibold sm:inline-flex",
                          plan.highlight ? "bg-[#007AFF] text-white" : "bg-[rgba(0,122,255,0.10)] text-[#0066DD]",
                        )}
                      >
                        {plan.badge}
                      </span>
                    )}
                    <h2 className="text-ios-headline font-bold text-[rgba(0,0,0,0.85)] sm:text-ios-title2">{plan.name}</h2>
                    <p className="mt-0.5 text-ios-caption1 text-[rgba(0,0,0,0.58)] sm:mt-1 sm:text-ios-footnote">
                      约 {referenceImages} 张 {PLAN_REFERENCE_MODEL_LABEL}
                    </p>
                    <p className="mt-0.5 text-ios-caption1 text-[rgba(0,0,0,0.46)]">
                      {plan.coins} 金币 · {plan.validDays} 天有效
                    </p>
                  </div>

                  <div className="shrink-0 text-right sm:mt-4 sm:text-left">
                    <div className="flex items-baseline justify-end gap-1.5 sm:justify-start sm:gap-2">
                      <span className="text-[1.4rem] font-bold leading-none tracking-tight text-[rgba(0,0,0,0.85)] sm:text-[2rem]">
                        ¥{plan.price}
                      </span>
                      <span className="text-ios-caption1 text-[rgba(0,0,0,0.44)] line-through sm:text-ios-footnote">
                        ¥{plan.anchorPrice}
                      </span>
                    </div>
                    <p className="mt-0.5 text-ios-caption1 text-[rgba(0,0,0,0.58)] sm:mt-1">
                      GPT 1K 单张约 ¥{pricePerGptImage2Image(plan)}
                    </p>
                    {plan.couponNote && (
                      <p className="mt-0.5 hidden text-ios-caption1 font-medium text-[#0066DD] sm:mt-1 sm:block">
                        {plan.couponNote}
                      </p>
                    )}
                  </div>
                </button>
              );
            })}
          </div>

          {/* 共同权益一条线说完 — 不再在每张卡里重复一遍 features */}
          <p className="mt-4 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-ios-caption1 text-[rgba(0,0,0,0.58)] sm:mt-5 sm:justify-center sm:text-ios-footnote">
            <BadgeCheck className="h-3.5 w-3.5 shrink-0 text-[#34C759]" aria-hidden="true" />
            全部方案通用：{PLAN_REFERENCE_MODEL_LABEL} = {PLAN_REFERENCE_COINS_PER_IMAGE} 金币/张 · 其他图像和视频按选择器实时标价
          </p>

          {/* Redeem code + Invite — two-col on desktop */}
          <div className="mobile-pricing-tools mt-6 grid gap-3 sm:mt-10 sm:grid-cols-2 sm:gap-4">

            {/* Redeem code */}
            <section id="redeem" className="lg-card relative overflow-hidden rounded-ios-3xl p-4 sm:rounded-ios-4xl sm:p-6">
              <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white to-transparent opacity-80" />
              <div className="mb-3 flex items-center justify-between gap-3 sm:mb-4">
                <h3 className="text-ios-subhead font-semibold text-[rgba(0,0,0,0.85)]">兑换码</h3>
                <Link
                  href="/docs"
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-[rgba(0,0,0,0.04)] px-2.5 py-1 text-ios-caption1 font-medium text-[rgba(0,0,0,0.56)] transition-colors hover:text-[rgba(0,0,0,0.82)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(0,122,255,0.30)]"
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
                  className="rounded-ios-xl bg-[#007AFF] px-4 py-2.5 text-ios-footnote font-semibold text-white shadow-[0_4px_16px_rgba(0,122,255,0.30)] transition-all hover:bg-[#0066DD] disabled:bg-[rgba(0,0,0,0.16)] disabled:shadow-none cursor-pointer disabled:cursor-default focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(0,122,255,0.45)] focus-visible:ring-offset-2"
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

            {/* Invite / referral */}
            <section className="hidden sm:block lg-card relative overflow-hidden rounded-ios-4xl p-6">
              <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white to-transparent opacity-80" />
              <h3 className="mb-4 text-ios-subhead font-semibold text-[rgba(0,0,0,0.85)]">邀请好友</h3>
              <p className="mb-4 text-ios-footnote text-[rgba(0,0,0,0.58)]">
                好友首次充值后，你获得 <span className="font-semibold text-[rgba(0,0,0,0.72)]">100 金币</span>，好友获得 <span className="font-semibold text-[rgba(0,0,0,0.72)]">50 金币</span>。奖励以金币形式发放，不能提现。
              </p>
              {affCode ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 rounded-ios-xl bg-[rgba(0,0,0,0.04)] px-4 py-2">
                    {/* 展示的链接必须和「复制」按钮写进剪贴板的完全一致（?ref=，不是 /ref=），
                        否则用户手抄屏幕上的那条会发现打不开。 */}
                    <span className="flex-1 truncate font-mono text-ios-footnote text-[rgba(0,0,0,0.72)]">
                      {`${typeof window !== "undefined" ? window.location.origin : ""}?ref=${affCode}`}
                    </span>
                    <button
                      type="button"
                      onClick={handleCopyAff}
                      aria-label="复制邀请链接"
                      title="复制邀请链接"
                      className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-[rgba(0,122,255,0.80)] transition-colors hover:bg-[rgba(0,122,255,0.08)] hover:text-[#007AFF] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(0,122,255,0.30)]"
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <p className="text-ios-caption1 text-[rgba(0,0,0,0.58)]">你的邀请码：{affCode}</p>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={handleFetchAff}
                  disabled={affLoading}
                  className="w-full rounded-ios-xl bg-[rgba(0,0,0,0.05)] py-2.5 text-ios-footnote font-medium text-[rgba(0,0,0,0.62)] transition-all hover:bg-[rgba(0,0,0,0.08)] hover:text-[rgba(0,0,0,0.85)] disabled:opacity-50 cursor-pointer disabled:cursor-default focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(0,122,255,0.30)]"
                >
                  {affLoading ? "加载中…" : isLoggedIn ? "查看我的邀请链接" : "登录后查看"}
                </button>
              )}
            </section>
          </div>

          {/* FAQ strip */}
          <div className="hidden sm:block mt-8 lg-card relative overflow-hidden rounded-ios-4xl p-6">
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
      </div>

      {/* 结账栏 — 唯一的支付入口，固定悬浮，与历史页多选栏同族材质。 */}
      <div className="fixed inset-x-0 bottom-4 z-40 flex justify-center px-4 sm:bottom-6">
        <div className="lg-bar relative w-full max-w-[34rem] overflow-hidden rounded-ios-3xl px-3 py-2.5 shadow-[0_20px_60px_rgba(0,0,0,0.12)] md:w-auto md:max-w-none">
          <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white to-transparent opacity-70" />

          <div className="flex items-center justify-between gap-2 md:gap-4">
            {/* 当前选择摘要（手机上省略——选中的卡片就在正上方打着勾） */}
            <div className="hidden min-w-0 md:block md:pl-2">
              <p className="truncate text-ios-footnote font-semibold text-[rgba(0,0,0,0.85)]">{selectedPlan.name}</p>
              <p className="truncate text-ios-caption1 text-[rgba(0,0,0,0.58)]">
                约 {gptImage2EquivalentImages(selectedPlan)} 张 {PLAN_REFERENCE_MODEL_LABEL} · {selectedPlan.coins} 金币 · {selectedPlan.validDays} 天
              </p>
            </div>

            {/* 支付方式 — iOS 分段控件 */}
            <div role="radiogroup" aria-label="支付方式" className="flex shrink-0 items-center gap-0.5 rounded-full bg-[rgba(0,0,0,0.05)] p-1">
              {PAY_METHODS.map((method) => {
                const active = payMethod === method.id;
                const Icon = method.icon;
                return (
                  <button
                    key={method.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => setPayMethod(method.id)}
                    className={cn(
                      "flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1.5 text-ios-caption1 font-medium transition-all duration-200 sm:px-3 sm:text-ios-footnote",
                      "focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(0,122,255,0.30)]",
                      active
                        ? "bg-white text-[rgba(0,0,0,0.85)] shadow-[0_1px_4px_rgba(0,0,0,0.10)]"
                        : "text-[rgba(0,0,0,0.56)] hover:text-[rgba(0,0,0,0.85)]",
                    )}
                  >
                    <Icon className={cn("h-3.5 w-3.5", active && method.tint)} aria-hidden="true" />
                    {/* 320px 窄屏放不下两个全称 + 支付按钮，用短称兜底 */}
                    <span className="min-[420px]:hidden">{method.short}</span>
                    <span className="hidden min-[420px]:inline">{method.label}</span>
                  </button>
                );
              })}
            </div>

            {/* 唯一的支付 CTA */}
            <button
              type="button"
              onClick={handlePay}
              className="shrink-0 cursor-pointer whitespace-nowrap rounded-full bg-[#007AFF] px-4 py-2.5 text-ios-footnote font-semibold text-white shadow-[0_4px_16px_rgba(0,122,255,0.30)] transition-all duration-200 hover:bg-[#0066DD] active:scale-[0.98] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(0,122,255,0.45)] focus-visible:ring-offset-2 sm:px-5"
            >
              立即支付 ¥{selectedPlan.price}
            </button>
          </div>

          {/* 支付发起后的闭环：告诉用户接下来做什么 */}
          {payOpened && (
            <div className="mt-2.5 flex items-center justify-between gap-2 px-1">
              <p className="min-w-0 truncate text-ios-caption1 text-[rgba(0,0,0,0.58)]" role="status" aria-live="polite">
                支付页已在新窗口打开，完成后回来刷新余额
              </p>
              <button
                type="button"
                onClick={handleRefreshBalance}
                disabled={refreshingBalance}
                className="shrink-0 cursor-pointer rounded-full bg-[rgba(0,122,255,0.10)] px-3 py-1.5 text-ios-caption1 font-semibold text-[#0066DD] transition-colors hover:bg-[rgba(0,122,255,0.16)] disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(0,122,255,0.30)]"
              >
                {refreshingBalance ? "刷新中…" : "已完成支付，刷新余额"}
              </button>
            </div>
          )}
        </div>
      </div>
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
