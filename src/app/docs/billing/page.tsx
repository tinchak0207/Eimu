import type { Metadata } from "next";
import { getSiteUrlFromEnv } from "@/lib/site-url";
import { AlertTriangle, CircleDollarSign, Coins, ShieldCheck, Wallet } from "lucide-react";
import { InlineCode, KeyCard, SectionTitle, Specular, Step } from "../DocsShell";

const SITE_URL = getSiteUrlFromEnv();

export const metadata: Metadata = {
  title: "充值与计费 | 文档中心 | Eimu",
  alternates: { canonical: `${SITE_URL}/docs/billing` },
};

// ---- 充值方案（现场逐字：与 /pricing 四档文案一致）----

const PLAN_ROWS: Array<{ name: string; price: string; coins: string }> = [
  { name: "梦芽 · 轻度尝鲜包", price: "¥9.9", coins: "100 金币" },
  { name: "梦影 · 主力月度会员", price: "¥29.9", coins: "500 金币" },
  { name: "梦虹 · 季度高频创作包", price: "¥69", coins: "1500 金币" },
  { name: "自定义 · 自由额度", price: "2,000～100 万金币滑杆", coins: "按 0.045 元/金币计价" },
];

export default function DocsBillingPage() {
  return (
    <div className="flex flex-col gap-6">
      <a
        href="/docs"
        className="text-ios-footnote text-[rgba(0,0,0,0.48)] lg-transition hover:text-[#007AFF]"
      >
        ← 文档中心
      </a>

      {/* ================= 充值与计费 ================= */}
      <section id="billing" className="scroll-mt-28">
        <SectionTitle icon={CircleDollarSign}>充值与计费</SectionTitle>
        <div className="mt-4 flex items-center gap-2">
          <Wallet className="h-4 w-4 shrink-0 text-[#007AFF]" />
          <p className="text-ios-callout font-semibold text-[rgba(0,0,0,0.85)]">充值三步</p>
        </div>
        <div className="mt-3 lg-card overflow-hidden rounded-ios-3xl sm:rounded-ios-4xl">
          <Specular />
          <div className="divide-y divide-[rgba(0,0,0,0.06)]">
            <Step
              n="1"
              title="入口就在顶栏"
              note={
                <>
                  余额胶囊实时显示金币余额，点「＋」就有两项：
                  <strong className="font-semibold text-[rgba(0,0,0,0.72)]">「充值」</strong>
                  进入方案页（<InlineCode>/pricing</InlineCode>），
                  <strong className="font-semibold text-[rgba(0,0,0,0.72)]">「每日签到」</strong>
                  就地领币——签过之后显示「已签到 · 明日再来」。
                </>
              }
            />
            <Step
              n="2"
              title="四档方案，微信/支付宝"
              note={
                <>
                  支付方式支持「微信支付」「支付宝支付」：点「立即支付 ¥X」会新开窗口收银台，完成后回到本页点「已完成支付，刷新余额」。
                </>
              }
            />
            <div className="grid gap-3 px-5 pb-5 sm:grid-cols-2 sm:px-7 sm:pb-7">
              {PLAN_ROWS.map((plan) => (
                <div key={plan.name} className="rounded-ios-2xl bg-[rgba(0,122,255,0.06)] p-4">
                  <p className="text-ios-footnote font-semibold text-[rgba(0,0,0,0.85)]">{plan.name}</p>
                  <p className="mt-1 text-ios-caption1 font-semibold text-[#007AFF]">{plan.price}</p>
                  <p className="mt-1 text-ios-caption1 leading-relaxed text-[rgba(0,0,0,0.52)]">{plan.coins}</p>
                </div>
              ))}
            </div>
            <Step
              n="3"
              title="到账与兑换码"
              note={
                <>
                  正常即时到账；有兑换码在 <InlineCode>/pricing</InlineCode> 输入，「金币会立即到账」；若有延迟联系客服，通常 5 分钟内解决。邀请奖励：好友首次充值双方都得金币，「以金币发放、不能提现」。
                </>
              }
            />
          </div>
        </div>
        <p className="mt-4 text-ios-footnote font-semibold text-[rgba(0,0,0,0.72)]">钱进来了，怎么花得放心：</p>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <KeyCard icon={Coins} title="一本账，跨模型可比价">
            所有模型用统一币制计价，不同模型之间可以直接比价。单价看定价页{" "}
            <a href="/pricing" className="font-semibold text-[#007AFF] lg-transition hover:underline">
              /pricing
            </a>
            ，每一单的结算在历史里可查。
          </KeyCard>
          <KeyCard icon={ShieldCheck} title="失败自动退回">
            预扣 → 成功结算 → 失败退款是同一本账：开工前先把钱扣住，成功才结算，
            <strong className="font-semibold text-[rgba(0,0,0,0.72)]">失败自动退回</strong>
            ，不会白花钱、不重复扣费。
          </KeyCard>
          <KeyCard icon={AlertTriangle} title="不会静默扣到负">
            余额不足时会直接拒绝并提示，绝不会静默扣成负数。至于它什么时候开口问你钱，由
            <a
              href="/docs/assistant"
              className="font-semibold text-[#007AFF] lg-transition hover:underline"
            >
              互动模式
            </a>
            决定：协作逐项问、自动不再问。
          </KeyCard>
        </div>
      </section>
    </div>
  );
}
