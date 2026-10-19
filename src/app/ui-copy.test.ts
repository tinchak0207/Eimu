import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

function read(relPath: string) {
  return readFileSync(join(root, relPath), "utf8");
}

test("navbar exposes wallet, history and top-up controls on mobile", () => {
  const source = read("src/components/Navbar.tsx");
  assert.match(source, /href="\/history"/);
  assert.match(source, /SplitLoginButton/);
  assert.doesNotMatch(source, /openAuth|openLogin|openRegister/);
  assert.match(source, /mobile-nav-actions/);
  assert.match(source, /mobile-wallet-balance/);
  // 2026-08-27 暴君裁定：余额 + 「+」合体胶囊——充值/签到收进「+」浮层，
  // 导航栏不再有独立充值按钮与 CheckinCalendar 图标。
  assert.match(source, /<WalletBadge showTopUp showCheckin className="mobile-wallet-balance min-w-0 flex-1 sm:flex-none" \/>/);
  assert.doesNotMatch(source, /CheckinCalendar/);
  // 2026-10-04 全站规格对齐：间距 token 收成 gap-1（≥sm 才回 gap-1.5），
  // 窄屏动作簇的「同排 + 靠右 + 不换行」语义不变。
  assert.match(source, /mobile-nav-actions flex min-w-0 flex-1 items-center justify-end gap-1\b/);
  // 极简 header：所有动作（历史/文档）只显图标，文字恒 sr-only。
  assert.match(source, /sr-only/);
  assert.doesNotMatch(source, /sr-only sm:not-sr-only/, "动作文字不得在桌面恢复显示");
  assert.doesNotMatch(source, /flex-col gap-2/);
  assert.doesNotMatch(source, /grid-cols-\[minmax/);
  assert.doesNotMatch(source, /mobile-nav-actions[\s\S]{0,180}overflow-x-auto/);
  assert.doesNotMatch(source, /href="\/history"[\s\S]{0,220}hidden sm:flex/);
  // 「文档」手机端隐藏（≥sm 才显示）；历史与余额保持手机端可见。
  // 2026-09-27 暴君裁定：审查页整页撤除（从未使用），故不再钉它的 aria-label。
  assert.match(source, /hidden[\s\S]{0,320}?sm:flex[\s\S]{0,200}?aria-label="文档"/);
  assert.doesNotMatch(source, /href="\/review"/);
  // 钥匙独立按钮 + 专属 key 菜单（复制/管理，无退出）；名字右侧是退出按钮。
  assert.match(source, /aria-label="API 密钥"/);
  assert.match(source, /copyApiKey/);
  assert.match(source, /密钥管理/);
  assert.match(source, /aria-label="退出登录"/);
  assert.match(source, /onClick=\{\(\) => logout\(\)\}/);
  assert.doesNotMatch(source, /<Ellipsis/);
});

test("wallet badge can be compacted for mobile navigation", () => {
  const source = read("src/components/WalletBadge.tsx");
  assert.match(source, /showCheckin = true/);
  assert.match(source, /max-w-full/);
  // 2026-08-27 暴君裁定：余额 + 「+」合体胶囊；「+」菜单有两项（充值/签到），
  // 签到后不可选并标注冷却；完成态绿勾挂在「+」入口上（header 无签到横幅文字）。
  assert.match(source, /aria-label="余额操作"/);
  assert.match(source, /aria-expanded=\{plusOpen\}/);
  assert.match(source, /role="menu"/);
  assert.match(source, /已签到 · 明日再来/);
  assert.match(source, /disabled=\{!canCheckin \|\| checkinLoading\}/);
  assert.match(source, /aria-disabled=\{!canCheckin \|\| checkinLoading\}/);
  // 2026-09-05 修正：「+」入口图标恒为加号——已签到状态只体现在菜单项里，
  // 不再把「+」换成绿勾（入口被完成态侵占 = 用户以为参考图/功能被移除）。
  assert.match(source, /<Plus className="h-3.5 w-3.5"/);
  assert.doesNotMatch(source, /checkinDone && showCheckin \?/);
  assert.match(source, /<CheckCircle2/);
  assert.doesNotMatch(source, /formatCheckinRewardText/);
  assert.doesNotMatch(source, /今日签到已获得/);
  // 菜单是全站玻璃语言（lg-sheet + specular 顶线 + spring 出场）。
  assert.match(source, /lg-sheet/);
  assert.match(source, /animate-lg-appear/);
  assert.match(source, /from-transparent via-white to-transparent/);
});

test("checkin calendar opens a calendar modal and awards random image credits", () => {
  const source = read("src/components/CheckinCalendar.tsx");

  assert.match(source, /fetchCheckinStatus/);
  assert.match(source, /doCheckin/);
  assert.match(source, /quotaToRewardCount/);
  assert.match(source, /formatCheckinRewardText/);
  assert.match(source, /Array\.from\(\{ length: 7 \}/);
  assert.match(source, /role="dialog"/);
  assert.match(source, /签到领取/);
  assert.match(source, /每日签到可随机获得 1 到 3 张额度/);
  assert.match(source, /今日签到已获得/);
  assert.match(source, /await refresh\(\)/);
  // bg-[#1f2230]/38 曾静默编译成空（/38 不在默认透明度刻度上），遮罩全透明。
  // 必须是 rgba() 任意值形式，且深度与历史灯箱一致（0.74）保证 gauss 模糊有暗底可辨。
  assert.match(source, /bg-\[rgba\(31,34,48,0\.74\)\]/);
  assert.doesNotMatch(source, /bg-\[#1f2230\]\/38/);
  assert.match(source, /backdrop-blur-md/);
  // 弹层材质必须是全站的 lg-sheet 玻璃，不允许回到灰底 + 黑描边的平面卡。
  assert.match(source, /lg-sheet/);
  assert.doesNotMatch(source, /bg-\[#f7f8fb\]/);
  assert.doesNotMatch(source, /border border-\[rgba\(0,0,0,0\.08\)\]/);
  assert.match(source, /max-w-\[440px\]/);
  assert.match(source, /w-\[min\(calc\(100vw-20px\),440px\)\]/);
  assert.doesNotMatch(source, /sm:bg-\[#f4f5f7\]/);
  assert.doesNotMatch(source, /max-w-\[390px\]/);
});

test("mobile pages reserve space for the single-row navbar", () => {
  // 2026-09-05：History 页 navbar 与「生成历史」栏之间 80px 空隙过大，裁定减 60%（pt-20 → pt-8）；
  // pricing 页维持弹窗化紧凑流（py-6）；两页都不允许回到两行 navbar 时代的 pt-32。
  const history = read("src/components/HistoryClient.tsx");
  assert.match(history, /pt-8/);
  assert.doesNotMatch(history, /pt-20|pt-32/);
  const pricing = read("src/components/PricingClient.tsx");
  assert.doesNotMatch(pricing, /pt-32/);
});

/**
 * 首页的间距比其他页小一半，是刻意的。
 *
 * navbar 在 layout.tsx 里是 `<main>` 的兄弟节点，header 本身是 relative（不是
 * fixed），所以它占真实布局空间 —— 这个 pt 纯粹是「header 下面留多少空」，
 * 不是防遮挡的净空。因此改小不会把内容压到 navbar 底下。
 * 上限仍然钉住：pt-32 是两行 navbar 时代的旧值，不许回归。
 */
test("首页工作台与出图框离 header 的距离是其他页的一半", () => {
  const source = read("src/components/ImagePlayground.tsx");
  // 左侧工作台与右侧出图框在同一个 wrapper 里，一个值同时管两边。
  // 2026-09-10 F6：≥xl 改应用式满屏（flex-1 链），底部 padding 收敛到 pb-16
  // （只为 fixed bottom-4 浮动 toast 条留安全空间）；2026-10-01：<xl 由 min-h-screen
  // 改 flex-1（min-h-screen 在 header 之下多撑出 100vh，造成手机端纯空滑），
  // 精确吃满「视口−header」。
  assert.match(source, /flex-1 bg-transparent pb-16 pt-10 xl:flex xl:min-h-0 xl:flex-1 xl:flex-col/);
  assert.doesNotMatch(source, /pt-20/);
  assert.doesNotMatch(source, /pt-32/);
  assert.doesNotMatch(source, /pb-28 pt-10|sm:pb-32/);
});

/** 2026-09-10 F6 首页满屏高度链（≥xl 两栏态）：body(flex/min-h-dvh) → main
 *  (flex-1) → 外层 flex-1 → page-shell flex-1 → grid flex-1+grid-rows-1 →
 *  左栏 wrapper min-h-0+overflow / 右栏 #generation-result min-h-0 →
 *  ImageDisplay xl:h-full 吃满。断言锁链路，防回退成文档流下方大空白。 */
test("首页 xl 满屏高度链完整（body/main/page-shell/grid/左右栏）", () => {
  const layout = read("src/app/layout.tsx");
  const source = read("src/components/ImagePlayground.tsx");
  assert.match(layout, /<body className="[^"]*flex min-h-dvh flex-col/);
  assert.match(layout, /<main className="flex min-h-0 flex-1 flex-col">/);
  assert.match(source, /page-shell xl:flex xl:min-h-0 xl:flex-1 xl:flex-col/);
  assert.match(source, /grid gap-6 xl:min-h-0 xl:flex-1 xl:grid-rows-1 xl:grid-cols-\[minmax\(0,1fr\)_minmax\(380px,460px\)\]/);
  // 09-11 高度自适应战役：该 div 改走 cn()（两栏态附加 playground-column-fill），断言跟随现状。
  assert.match(source, /cn\("min-w-0 xl:min-h-0 xl:overflow-y-auto"/);
  assert.match(source, /"flex min-w-0 flex-col xl:min-h-0", inCanvasWorkstation && "hidden"/);
  // 工作站态零回归：grid 在工作站态仍是 block（高度链类只在两栏分支）。
  assert.match(source, /inCanvasWorkstation \? "block" : "grid/);
});

test("pricing page removes the bottom external store link and uses zh-CN locale", () => {
  const pricing = read("src/components/PricingClient.tsx");
  const layout = read("src/app/layout.tsx");

  assert.doesNotMatch(pricing, /前往充值商店/);
  assert.doesNotMatch(pricing, /href="https:\/\/store\.tinchak0207\.xyz"/);
  assert.match(layout, /<html lang="zh-CN"/);
});

test("pricing copy uses simplified Chinese with a standard close affordance", () => {
  const pricing = read("src/components/PricingClient.tsx");

  // 2026-08-25 弹窗化重构：返回按钮换成右上角标准关闭 X（icon 库 X，非 emoji）。
  assert.match(pricing, /aria-label="关闭"/);
  assert.doesNotMatch(pricing, /返回做图/);
  assert.doesNotMatch(pricing, /返回做图/);
  assert.match(pricing, /兑换码/);
  assert.match(pricing, /兑换成功/);
  // 只做大陆生意：页面不得残留繁体字形。d22fa6ee 的机械转简体把这条否定断言
  // 也转成了简体，导致与上一行自相矛盾；这里用码点还原原意（不写入繁体字形）。
  assert.doesNotMatch(pricing, /\u5151\u63db\u78bc/, "价格页不得出现繁体「兌換碼」");
});

test("pricing page is a focused compact panel with plan carousel", () => {
  const pricing = read("src/components/PricingClient.tsx");

  // 2026-09-07 carousel 化：三列并排 → AI 助理模板同款环形轮播（PricingPlanCarousel）。
  assert.match(pricing, /max-w-6xl/);
  assert.match(pricing, /<PricingPlanCarousel/);
  assert.doesNotMatch(pricing, /fixed inset-x-0 bottom-/);
  assert.doesNotMatch(pricing, /mobile-pricing-/);
  assert.doesNotMatch(pricing, /sm:text-center/);
  assert.doesNotMatch(pricing, /pt-20/);
});

test("pricing plans are selectable carousel cards with in-card checkout closure", () => {
  const pricing = read("src/components/PricingClient.tsx");
  const carousel = read("src/components/PricingPlanCarousel.tsx");

  // App Store 收银架构：点前卡即选，选中卡内展开支付方式分段 + 唯一支付 CTA；
  // 未选中卡只有「选择此方案」。
  assert.match(carousel, /role="radio"/);
  assert.match(carousel, /aria-checked=\{isSelected\(item\)\}/);
  assert.match(pricing, /useState\("popular"\)/);
  assert.match(carousel, /立即支付 ¥\{plan\.price\}/);
  assert.doesNotMatch(carousel, /handleMapayBuy\(plan\.id/);
  // 支付在新窗口完成，卡内必须有「刷新余额」的闭环反馈。
  assert.match(carousel, /支付页已在新窗口打开/);
  assert.match(carousel, /已完成支付，刷新余额/);
});

test("pricing custom plan prices by the single-source 0.045 RMB per coin constant", () => {
  // 2026-09-07 暴君钦定：自定义档 0.045 RMB/金币，价格常量单点定义在 plans.ts，
  // 页面展示与 checkout/notify 服务端计价共用同一解析器，客户端传价不参与计价。
  const plans = read("src/lib/plans.ts");
  const carousel = read("src/components/PricingPlanCarousel.tsx");
  const checkout = read("src/app/api/payments/mapay/checkout/route.ts");
  const notify = read("src/app/api/payments/mapay/notify/route.ts");

  assert.match(plans, /CUSTOM_PLAN_PRICE_PER_COIN = 0\.045/);
  assert.match(plans, /export function customPlanPrice\(/);
  assert.match(plans, /export function resolvePricingPlan\(/);
  assert.match(carousel, /CustomAmountSlider/);
  assert.match(carousel, /aria-label="自定义额度"/);
  assert.match(carousel, /aria-valuetext=/);
  // Log Scale：value = 10^(lerp(log10(2000), log10(1000000), t))。
  assert.match(carousel, /10 \*\* \(LOG_MIN \+ t \* LOG_SPAN\)/);
  // 两个路由都必须走统一解析器（不许出现 PLANS.find 直查）。
  assert.match(checkout, /resolvePricingPlan\(/);
  assert.match(notify, /resolvePricingPlan\(/);
  assert.doesNotMatch(checkout, /PLANS\.find/);
  assert.doesNotMatch(notify, /PLANS\.find/);
});

test("pricing page exposes docs link and redeem anchor for cdk delivery", () => {
  const pricing = read("src/components/PricingClient.tsx");

  assert.match(pricing, /id="redeem"/);
  assert.match(pricing, /href="\/docs"/);
});

test("pricing checkout keeps WeChat first and still routes through mapay", () => {
  const pricing = read("src/components/PricingClient.tsx");
  // 2026-09-07 carousel 化：收银台（支付方式分段）随卡面迁入 PricingPlanCarousel。
  const carousel = read("src/components/PricingPlanCarousel.tsx");

  assert.match(carousel, /微信支付/);
  assert.match(carousel, /支付宝支付/);
  // 支付方式在卡内结账的分段控件里选，支付动作只有一处。
  assert.match(carousel, /role="radiogroup" aria-label="支付方式"/);
  assert.match(pricing, /handleMapayBuy\(selectedPlanId === "custom" \? customPlan\.id : selectedPlan\.id, payMethod\)/);
  assert.match(pricing, /\/api\/payments\/mapay\/checkout\?plan=/);
  assert.match(pricing, /type=\$\{encodeURIComponent\(type\)\}/);
  assert.ok(carousel.indexOf("微信支付") < carousel.indexOf("支付宝支付"));
  assert.doesNotMatch(pricing, /淘宝购买/);
});

test("pricing page pre-fills cdk returned from mapay", () => {
  const pricing = read("src/components/PricingClient.tsx");

  assert.match(pricing, /new URLSearchParams\(window\.location\.search\)\.get\("cdk"\)/);
  assert.match(pricing, /if \(cdk\) setRedeemCode\(cdk\)/);
});

test("pricing redeem refreshes the displayed quota after successful cdk redemption", () => {
  const pricing = read("src/components/PricingClient.tsx");

  assert.match(pricing, /const \{ token, isLoggedIn, refresh \} = useAuth\(\)/);
  assert.match(pricing, /await refresh\(\)/);
  assert.ok(pricing.indexOf("redeemTopupCode") < pricing.indexOf("await refresh()"));
});

test("auth refresh persists the latest quota returned by new-api", () => {
  const auth = read("src/hooks/use-auth.tsx");

  assert.match(auth, /setStoredToken\(validToken, result\.user\)/);
  assert.match(auth, /const validToken = result\.token \?\? storedToken/);
});
