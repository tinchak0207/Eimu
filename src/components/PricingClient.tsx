"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { BadgeCheck, BookOpen, ChevronDown, Copy, Gift, Sparkles, Ticket, X } from "lucide-react";
import type { MapayPaymentType } from "@/lib/mapay";
import {
  ACTIVE_PRICING_PROMO,
  FIRST_CHARGE_PLAN,
  FIRST_CHARGE_PLAN_ID,
  MAX_REWARDED_INVITES,
  REFERRAL_REWARD_COINS,
  REFEREE_REWARD_COINS,
  customPlanFor,
  formatCoins,
  gptImage2EquivalentImages,
  modelPriceRows,
  PLANS,
  resolvePricingPlan,
  planUnitsForCoins,
} from "@/lib/plans";
import type { ModelPriceRow, PricingPromo } from "@/lib/plans";
import { IMAGE_MODEL_IDS, VIDEO_MODEL_IDS, generationCoins } from "@/lib/generation-model-catalog";
import { useAuth } from "@/hooks/use-auth";
import { usePricingRevision } from "@/hooks/use-pricing-revision";
import { fetchInviteLink, quotaToCoins, redeemTopupCode } from "@/lib/new-api-client";
import { useToast } from "@/hooks/use-toast";
import { isStandalonePwa, createHandoffLogin } from "@/lib/github-login";
import { PwaHandoffPanel } from "@/components/PwaHandoffPanel";
import { PricingPlanCarousel } from "@/components/PricingPlanCarousel";
import { PricingAtmosphere } from "@/components/pricing3d/PricingAtmosphere";

/**
 * 2026-09-07 方案选择器 carousel 化：三列并排 → AI 助理模板同款环形轮播
 * （PricingPlanCarousel = AgentTemplateCarousel 逐行复制）。新增「自定义」档：
 * Log Scale 滑杆 2,000 → 100 万金币，按 0.045 RMB/金币实时计价。
 * 全部换算数字由计费 catalog 驱动（活数据）：admin 改价 → usePricingRevision
 * 触发重渲 → 展示跟随，永不脱钩。
 */

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

/**
 * 首充专享卡（一次性、限一帐号一次）：只在「已登录且控面确认还有资格」时出现，
 * 且永远排在三档正价之前（这是转化率最高的一张牌）。
 *
 * 资格是服务端权威（/api/payments/first-charge/eligibility → 控面帐本判准），
 * 前端只是显示闸门；真正的执法在 checkout 403 与入帐时按正价折算（见 src/lib/first-charge.ts）。
 * 没资格或未登录整卡不渲染；未登录时卡上按钮先走登录（登录后回来才会重新判资格）。
 */
function FirstChargeOffer({
  plan,
  coinsPerImage,
  paying,
  onPay,
}: {
  plan: typeof FIRST_CHARGE_PLAN;
  coinsPerImage: number;
  paying: boolean;
  onPay: () => void;
}) {
  return (
    <section
      id="first-charge"
      aria-labelledby="first-charge-heading"
      className="p3d-panel relative mt-4 scroll-mt-6 overflow-hidden p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <div className="min-w-0 flex-1">
          <p className="p3d-eyebrow flex items-center gap-1.5">
            <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
            {plan.badge}
          </p>
          <h2 id="first-charge-heading" className="mt-1.5 text-ios-title3 font-bold text-[color:var(--p3d-ink)]">
            ¥{plan.price} 得 <span className="p3d-hl">{formatCoins(plan.coins)} 币</span>
            <span className="ml-2 text-ios-footnote font-medium text-[color:var(--p3d-ink-3)]">
              约 {gptImage2EquivalentImages(plan, coinsPerImage)} 张 GPT Image 2
            </span>
          </h2>
          <p className="mt-1 text-ios-footnote text-[color:var(--p3d-ink-3)]">
            每个账号限一次，仅限从未充值过的账号；{plan.validDays} 天内有效，全模型通用。
          </p>
        </div>
        <button
          type="button"
          onClick={onPay}
          disabled={paying}
          className="p3d-btn-light shrink-0 disabled:opacity-60"
        >
          {paying ? "正在打开支付页…" : `立即支付 ¥${plan.price}`}
        </button>
      </div>
    </section>
  );
}

export function PricingClient() {
  // 订阅定价覆写：管理员改价后本页报价立即重算。
  usePricingRevision();
  const { token, isLoggedIn, refresh } = useAuth();
  const { toast } = useToast();
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
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
  // 自定义档额度（金币）。滑杆拖动只更新这个值；checkout 走 custom:<coins> id。
  const [customCoins, setCustomCoins] = useState<number>(20_000);
  // 环正面档 = 当前「世界」：整页氛围（背景/光/滚动节奏）跟着它走，与 3D 卡堆同属一个空间。
  const [frontWorld, setFrontWorld] = useState("popular");

  const selectedPlan = resolvePricingPlan(selectedPlanId) ?? PLANS[0];

  // 基准单价每次渲染都从有效 catalog（含 admin 覆写）取值——改价后
  // usePricingRevision 触发重渲，套餐换算与单价表全部跟随，无需重新部署。
  const referenceCoinsPerImage = generationCoins("gpt-image-2", { resolution: "1k" });
  const priceRows = modelPriceRows();
  const imageRows = priceRows.filter((row) => row.kind === "image");
  const videoRows = priceRows.filter((row) => row.kind === "video");
  // 2026-09-26 版面收口：月度/季度筛选拿掉——四档在档位梯上并排、票面写明有效天数，
  // 筛选只是多一个要看的东西。PLANS 是模块常量，引用天然稳定（滑杆拖动不重建环）。
  const plansForCarousel = PLANS;
  const includeCustom = true;
  const customPlan = useMemo(() => customPlanFor(customCoins), [customCoins]);
  /* 首屏以下的额度换算跟随首屏正面档（自定义档用滑杆当前额度）。 */
  const [quotaKind, setQuotaKind] = useState<"image" | "video">("image");
  const quotaPlan = frontWorld === "custom" ? customPlan : (PLANS.find((plan) => plan.id === frontWorld) ?? selectedPlan);
  const quotaLabel = frontWorld === "custom" ? "自定义" : (quotaPlan.badge ?? quotaPlan.name);
  const featuredRows = (quotaKind === "image" ? imageRows : videoRows).slice(0, 8);

  // 支付回跳带 ?cdk=：已登录就自动兑换（付了就到账，不让用户再点一次），
  // 兑换后从 URL 拿掉 cdk，刷新不会重兑；未登录则只预填，登录后手动兑换。
  const autoRedeemTried = useRef(false);
  useEffect(() => {
    const cdk = new URLSearchParams(window.location.search).get("cdk");
    if (cdk) setRedeemCode(cdk);
  }, []);
  useEffect(() => {
    if (autoRedeemTried.current || !token) return;
    const cdk = new URLSearchParams(window.location.search).get("cdk")?.trim();
    if (!cdk) return;
    autoRedeemTried.current = true;
    void (async () => {
      setRedeemLoading(true);
      try {
        const res = await redeemTopupCode(token, cdk);
        if (res.success) {
          await refresh();
          const coins = res.data?.quota ? quotaToCoins(res.data.quota) : null;
          setRedeemedCoins(coins);
          setRedeemCode("");
          toast({ title: "支付成功，已到账", description: coins ? `${coins} 金币已加到你的账户` : "金币已加到你的账户" });
          const url = new URL(window.location.href);
          url.searchParams.delete("cdk");
          window.history.replaceState(null, "", url.toString());
        }
        // 失败（已兑换过等）保留预填，由用户看到输入框里的码自行处理，不弹错吓人。
      } finally {
        setRedeemLoading(false);
      }
    })();
  }, [token, refresh, toast]);

  // 支付回跳带 ?mapay=credited：这笔单已由服务端直接入帐（notify／回跳直达加额，
  // 见 src/lib/mapay-credit.ts），**不触发兑换**，只提示到账并刷新余额；
  // 随后从 URL 拿掉参数，刷新不会重复提示。
  const mapayNoticeTried = useRef(false);
  useEffect(() => {
    if (mapayNoticeTried.current) return;
    const status = new URLSearchParams(window.location.search).get("mapay");
    if (!status) return;
    mapayNoticeTried.current = true;
    const notice: Record<string, { title: string; description?: string }> = {
      credited: { title: "支付成功，已到账", description: "金币已加到你的账户" },
      pending: { title: "支付处理中", description: "到账后余额会自动更新，稍后刷新即可" },
      invalid: { title: "支付结果校验失败", description: "如已扣款，请联系客服核对" },
      mismatch: { title: "支付金额校验失败", description: "如已扣款，请联系客服核对" },
      cdk_failed: { title: "兑换码生成失败", description: "如已扣款，请联系客服核对" },
    };
    const text = notice[status];
    if (text) toast(text);
    const url = new URL(window.location.href);
    url.searchParams.delete("mapay");
    window.history.replaceState(null, "", url.toString());
    if (status === "credited") void refresh();
  }, [refresh, toast]);

  const handleMapayBuy = (planId: string, type: MapayPaymentType) => {
    window.open(`/api/payments/mapay/checkout?plan=${encodeURIComponent(planId)}&type=${encodeURIComponent(type)}`, "_blank");
  };

  const handlePay = () => {
    // 自定义档的 selectedPlanId 是 "custom"，resolvePricingPlan 解不出会退回 PLANS[0]；必须传 custom:<coins>。
    handleMapayBuy(selectedPlanId === "custom" ? customPlan.id : selectedPlan.id, payMethod);
    // 支付在新窗口完成，卡片内必须给出「然后呢」——状态行 + 刷新余额闭环。
    setPayOpened(true);
  };

  const handleSelectPlan = (planId: string) => {
    setSelectedPlanId(planId);
    // 换了方案，上一次「支付页已打开」的状态行就不再成立。
    setPayOpened(false);
  };

  /* ── 首充专享卡 ──
     是否显示由服务端资格说了算（见 FirstChargeOffer 注释）：已登录才去问，
     未登录 / 没资格整卡不渲染。答不出（通道挂）也当没资格——这卡是 4 倍划算的
     一次性优惠，多显示一次就是多一次滥用入口。 */
  const [firstChargeEligible, setFirstChargeEligible] = useState(false);
  const [firstChargePaying, setFirstChargePaying] = useState(false);

  useEffect(() => {
    if (!isLoggedIn) {
      setFirstChargeEligible(false);
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const res = await fetch("/api/payments/first-charge/eligibility", { cache: "no-store" });
        const data = (await res.json().catch(() => null)) as { eligible?: unknown } | null;
        if (alive) setFirstChargeEligible(data?.eligible === true);
      } catch {
        if (alive) setFirstChargeEligible(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [isLoggedIn, token]);

  /* ?plan=first-charge（余额不足提示的「去充值」带过来的）：滚到首充卡。
     资格还没查完时延后一拍——卡可能要等资格回来才出现，落空会滚到页尾。 */
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("plan") !== FIRST_CHARGE_PLAN_ID) return;
    const target = document.getElementById("first-charge");
    const anchor = target ?? document.getElementById("pricing-plans") ?? document.body;
    anchor.scrollIntoView({ behavior: "smooth", block: "start" });
    if (!isLoggedIn) {
      // 未登录：卡不渲染，但用户意图明确——直接进入登录，回来才判资格。
      startGithubLogin();
    }
    // 只认首帧的 URL 参数；isLoggedIn 变化不再重滚（避免登录回来又跳一次）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleFirstChargePay = async () => {
    if (!isLoggedIn) {
      startGithubLogin();
      return;
    }
    setFirstChargePaying(true);
    try {
      // 与正价档同一条收单链路（服务端另有资格闸：没资格 403、绝不发出支付页）。
      await refresh();
      handleMapayBuy(FIRST_CHARGE_PLAN_ID, payMethod);
      toast({ title: "支付页已打开", description: "完成后金币自动到账，余额到此刷新" });
    } finally {
      setFirstChargePaying(false);
    }
  };

  /* 环停在哪档就选中哪档：正面票面的主按钮永远是「立即支付」，想买的人少点一次。
     引用必须稳定（环的 effect 依赖它，每次渲染换引用会反复重置「支付页已打开」）。 */
  const handleFrontChange = useCallback((planId: string) => {
    setFrontWorld(planId);
    setSelectedPlanId(planId);
    setPayOpened(false);
  }, []);

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
      const res = await fetchInviteLink(token);
      if (res.success && res.data) setInviteUrl(res.data.url);
      else toast({ title: "获取失败", description: res.message ?? "请稍后再试", variant: "destructive" });
    } catch {
      toast({ title: "网络错误", variant: "destructive" });
    } finally {
      setAffLoading(false);
    }
  };

  const handleCopyAff = () => {
    if (!inviteUrl) return;
    navigator.clipboard.writeText(inviteUrl).then(() =>
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
    <div className="p3d-page relative isolate min-h-screen overflow-x-clip bg-transparent px-4 py-5 pb-10 sm:px-6 sm:py-6 lg:px-8" data-world={frontWorld}>
      <PricingAtmosphere world={frontWorld} />
      <div className="relative mx-auto w-full max-w-6xl">

        {/* Header — 只留一句标题（居中，与档位梯、舞台同一条视线）+ 右上角关闭 X。
            版面主次：档位梯（选哪档）→ 3D 卡堆（多少）→ 票面（多少钱、付款）；标题不抢戏。 */}
        <div className="relative z-10 flex items-start justify-center">
          <div className="text-center">
            <p className="p3d-eyebrow-top">EMU · 充值方案</p>
            <h1 className="p3d-ink mt-1 text-ios-title1 font-bold tracking-tight sm:text-ios-largetitle">
              选一档，把<span className="p3d-hl">灵感</span>画出来
            </h1>
          </div>
          <Link
            href="/"
            aria-label="关闭"
            title="关闭"
            className="p3d-roundbtn absolute right-0 top-0 flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="h-4 w-4" />
          </Link>
        </div>

        {/* 活动位 — 只有真实活动数据才渲染；无数据整条隐藏 */}
        {ACTIVE_PRICING_PROMO && <ActivityBanner promo={ACTIVE_PRICING_PROMO} />}

        {/* 首充专享 — 有资格才渲染（服务端判准）；永远在正价档之前 */}
        {firstChargeEligible && (
          <FirstChargeOffer
            plan={FIRST_CHARGE_PLAN}
            coinsPerImage={referenceCoinsPerImage}
            paying={firstChargePaying}
            onPay={() => void handleFirstChargePay()}
          />
        )}

        {/* 套餐环（carousel）— AI 助理模板同款轮子：点前卡即选，收银台在卡内；
            末位自定义档带 Log Scale 滑杆（2,000 → 100 万金币，0.045 元/金币）。 */}
        <div
          id="pricing-plans"
          className="relative ml-[calc(50%-50vw)] mt-2 w-screen scroll-mt-6 sm:mt-3"
        >
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
            onFrontChange={handleFrontChange}
          />
        </div>

        {/* ═══ 首屏以下：同一座梦境往下沉（深靛夜色），三块只回答三个问题 ═══
            ① 我这档的金币到底能画多少（跟随首屏选中的档位实时换算）；
            ② 还有没有别的方式拿金币（邀请 / 兑换码）；③ 常见疑虑。 */}

        {/* ① 额度换算：选中档 × 主力模型 = 能出多少张/秒；完整价目表折叠在下面。 */}
        <section aria-labelledby="quota-heading" className="p3d-panel mt-10 p-5 sm:mt-14 sm:p-7">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="min-w-0">
              <p className="p3d-eyebrow">你的额度能画什么</p>
              <h2 id="quota-heading" className="mt-1.5 text-ios-title2 font-bold tracking-tight text-[color:var(--p3d-ink)]">
                {quotaLabel} · {formatCoins(quotaPlan.coins)} 金币，可以换成
              </h2>
            </div>
            <div role="tablist" aria-label="模型类型" className="p3d-seg">
              {(["image", "video"] as const).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  role="tab"
                  aria-selected={quotaKind === kind}
                  onClick={() => setQuotaKind(kind)}
                  className="p3d-seg-btn"
                >
                  {kind === "image" ? "图像" : "视频"}
                </button>
              ))}
            </div>
          </div>
          <ul className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {featuredRows.map((row) => {
              const cell = row.cells[0];
              return (
                <li key={row.id} className="p3d-tile">
                  <p className="truncate text-ios-footnote font-semibold text-[color:var(--p3d-ink)]">{row.name}</p>
                  <p className="mt-2 flex items-baseline gap-1">
                    <span className="p3d-tile-num">{planUnitsForCoins(quotaPlan, cell.coins).toLocaleString("en-US")}</span>
                    <span className="text-ios-footnote font-semibold text-[color:var(--p3d-ink)]">{row.unit}</span>
                  </p>
                  <p className="mt-1 text-ios-footnote text-[color:var(--p3d-ink-3)]">
                    {resolutionShortLabel(cell.resolution)} · <span className="font-semibold text-[#e0457f]">{formatCoins(cell.coins)}</span> 币/{row.unit}
                  </p>
                </li>
              );
            })}
          </ul>

          {/* 完整价目表：默认折叠（46 个模型的长表不该一上来就砸脸），展开即是计费配置活数据。 */}
          <details className="p3d-details mt-5">
            <summary className="p3d-summary">
              查看全部 {priceRows.length} 个模型的完整价目 · 各档可出张数
              <ChevronDown className="h-4 w-4" aria-hidden="true" />
            </summary>
            <p className="mt-3 text-ios-footnote leading-relaxed text-[color:var(--p3d-ink-3)]">
              下表就是实际扣费单价：图像按「币/张」、视频按「币/秒」，右侧各列为各档套餐额度可出的张数（视频为秒数）。由计费配置实时计算，改价即生效。
            </p>
            <div className="mt-3 max-h-[30rem] overflow-y-auto overscroll-contain rounded-ios-2xl bg-white/70 ring-1 ring-inset ring-[rgba(58,80,160,0.14)]">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[40rem] border-collapse text-ios-footnote">
                  <thead className="sticky top-0 z-10">
                    <tr className="bg-[rgba(240,244,255,0.97)] text-left text-[color:var(--p3d-ink-3)]">
                      <th scope="col" className="px-4 py-2.5 font-semibold">模型</th>
                      <th scope="col" className="px-3 py-2.5 font-semibold">分辨率</th>
                      <th scope="col" className="px-3 py-2.5 font-semibold">单价</th>
                      {PLANS.map((plan) => (
                        <th key={plan.id} scope="col" className="px-3 py-2.5 text-right font-semibold">
                          <span className="block text-[color:var(--p3d-ink)]">{plan.badge}</span>
                          <span className="block font-normal text-[color:var(--p3d-ink-3)]">{plan.coins} 币</span>
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
            <p className="mt-3 text-ios-footnote leading-relaxed text-[color:var(--p3d-ink-3)]">
              视频实际消耗 = 单价 × 时长（生成音频的档位另计）；全部单价以生成页选择器实时标价为准。
            </p>
          </details>
        </section>

        {/* ② 另外两种拿金币的方式：邀请 / 兑换码，并排两张。 */}
        <div className="mt-5 grid gap-5 md:grid-cols-2">
          <section aria-labelledby="invite-heading" className="p3d-panel p-5 sm:p-6">
            <p className="p3d-eyebrow flex items-center gap-1.5">
              <Gift className="h-3.5 w-3.5" aria-hidden="true" />
              邀请好友
            </p>
            <h3 id="invite-heading" className="mt-1.5 text-ios-title3 font-bold text-[color:var(--p3d-ink)]">
              好友出第一张图，你得 <span className="text-[#e0457f]">{REFERRAL_REWARD_COINS} 金币</span>
            </h3>
            <p className="mt-1 text-ios-footnote text-[color:var(--p3d-ink-3)]">
              好友也多得 <span className="font-semibold text-[#c9a84c]">{REFEREE_REWARD_COINS} 金币</span>；你分享出去的作品链接同样算邀请。
            </p>
            <div className="mt-4">
              {inviteUrl ? (
                <div className="flex min-w-0 items-center gap-2 rounded-full bg-white/80 py-1.5 pl-4 pr-1.5 ring-1 ring-inset ring-[rgba(58,80,160,0.14)]">
                  {/* 展示的链接必须和「复制」按钮写进剪贴板的完全一致。 */}
                  <span className="min-w-0 flex-1 truncate font-mono text-ios-footnote text-[color:var(--p3d-ink-2)]">
                    {inviteUrl}
                  </span>
                  <button type="button" onClick={handleCopyAff} aria-label="复制邀请链接" title="复制邀请链接" className="p3d-btn-light shrink-0">
                    <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                    复制
                  </button>
                </div>
              ) : (
                <button type="button" onClick={handleFetchAff} disabled={affLoading} className="p3d-btn-light">
                  {affLoading ? "加载中…" : isLoggedIn ? "查看我的邀请链接" : "登录后查看"}
                </button>
              )}
            </div>
          </section>

          <section id="redeem" aria-labelledby="redeem-heading" className="p3d-panel p-5 sm:p-6">
            <div className="flex items-center justify-between gap-3">
              <p className="p3d-eyebrow flex items-center gap-1.5">
                <Ticket className="h-3.5 w-3.5" aria-hidden="true" />
                兑换码
              </p>
              <Link href="/docs" className="inline-flex items-center gap-1 text-ios-footnote font-medium text-[color:var(--p3d-ink-3)] transition-colors hover:text-[color:var(--p3d-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <BookOpen className="h-3.5 w-3.5" aria-hidden="true" />
                教程
              </Link>
            </div>
            <h3 id="redeem-heading" className="mt-1.5 text-ios-title3 font-bold text-[color:var(--p3d-ink)]">有兑换码？金币立即到账</h3>
            <div className="mt-4 grid grid-cols-[minmax(0,1fr)_auto] gap-2">
              <input
                type="text"
                value={redeemCode}
                onChange={(e) => setRedeemCode(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleRedeem()}
                placeholder="输入兑换码"
                className="min-w-0 rounded-full border-0 bg-white/80 px-4 py-2.5 text-ios-footnote text-[color:var(--p3d-ink)] ring-1 ring-inset ring-[rgba(58,80,160,0.14)] placeholder:text-[color:var(--p3d-ink-3)] focus:outline-none focus:ring-2 focus:ring-ring/45 [background-image:none]"
              />
              <button type="button" onClick={handleRedeem} disabled={redeemLoading || !redeemCode.trim()} className="p3d-btn-light disabled:opacity-50">
                {redeemLoading ? "兑换中" : "兑换"}
              </button>
            </div>
            {/* 兑换成功的反馈留在原地，不只闪一条 toast */}
            {redeemedCoins !== null && (
              <p role="status" className="mt-2.5 flex items-center gap-1.5 text-ios-footnote text-[#12935f]">
                <BadgeCheck className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                已到账 {redeemedCoins} 金币，余额已更新
              </p>
            )}
          </section>
        </div>

        {/* ③ 常见问题：手风琴（默认只看问题，点开看答案）。 */}
        <section aria-labelledby="faq-heading" className="p3d-panel mt-5 p-5 sm:p-7">
          <h2 id="faq-heading" className="text-ios-title3 font-bold text-[color:var(--p3d-ink)]">常见问题</h2>
          <div className="mt-3 grid gap-x-8 md:grid-cols-2">
            {FAQ.map((item) => (
              <details key={item.q} className="p3d-faq">
                <summary className="p3d-faq-q">
                  {item.q}
                  <ChevronDown className="h-4 w-4 shrink-0" aria-hidden="true" />
                </summary>
                <p className="pb-3 text-ios-footnote leading-relaxed text-[color:var(--p3d-ink-3)]">{item.a}</p>
              </details>
            ))}
          </div>
        </section>

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
      <tr className="bg-[rgba(90,120,220,0.06)]">
        <td colSpan={3 + PLANS.length} className="px-4 py-1.5 text-ios-footnote font-semibold text-[color:var(--p3d-ink-3)]">
          {label}
        </td>
      </tr>
      {rows.map((row) =>
        row.cells.map((cell, index) => (
          <tr key={row.id + ":" + cell.resolution} className="border-t border-[rgba(58,80,160,0.08)]">
            {index === 0 ? (
              <td rowSpan={row.cells.length} className="align-top px-4 py-2.5 font-medium text-[color:var(--p3d-ink)]">
                {row.name}
              </td>
            ) : null}
            <td className="px-3 py-2.5 text-[color:var(--p3d-ink-3)]">{resolutionShortLabel(cell.resolution)}</td>
            <td className="px-3 py-2.5">
              <span className="font-semibold text-[#e0457f]">{formatCoins(cell.coins)}</span>
              <span className="ml-1 text-[color:var(--p3d-ink-3)]">币/{row.unit}</span>
            </td>
            {PLANS.map((plan) => (
              <td key={plan.id} className="px-3 py-2.5 text-right font-medium text-[color:var(--p3d-ink-2)]">
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
    a: `不是。好友经你的邀请链接（或你分享的作品链接）注册、并出了第一张图后，双方金币自动到账，通常几分钟内；每人最多累计 ${MAX_REWARDED_INVITES} 次邀请奖励。金币不能提现，也不能转让。`,
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
