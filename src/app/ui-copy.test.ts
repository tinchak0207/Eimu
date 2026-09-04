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
  assert.match(source, /mobile-nav-actions flex min-w-0 flex-1 items-center justify-end gap-1\.5/);
  // 极简 header：所有动作（历史/文档）只显图标，文字恒 sr-only。
  assert.match(source, /sr-only/);
  assert.doesNotMatch(source, /sr-only sm:not-sr-only/, "动作文字不得在桌面恢复显示");
  assert.doesNotMatch(source, /flex-col gap-2/);
  assert.doesNotMatch(source, /grid-cols-\[minmax/);
  assert.doesNotMatch(source, /mobile-nav-actions[\s\S]{0,180}overflow-x-auto/);
  assert.doesNotMatch(source, /href="\/history"[\s\S]{0,220}hidden sm:flex/);
  // 「文档」「审查页」手机端隐藏（≥sm 才显示）；历史与余额保持手机端可见。
  assert.match(source, /hidden[\s\S]{0,320}?sm:flex[\s\S]{0,200}?aria-label="审查页"/);
  assert.match(source, /hidden[\s\S]{0,320}?sm:flex[\s\S]{0,200}?aria-label="文档"/);
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
  // 完成态长在「+」入口上：签到后加号位换成绿勾，不再渲染「今日签到已获得 X 张」。
  assert.match(source, /checkinDone && showCheckin \? \(/);
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
  // 2026-08-25：pricing 页改为聚焦弹窗化紧凑流（py-6 起，砍掉无意义大 Padding），
  // 只有 History 页保留 pt-20 的页面节奏；两页都不允许回到两行 navbar 时代的 pt-32。
  const history = read("src/components/HistoryClient.tsx");
  assert.match(history, /pt-20/);
  assert.doesNotMatch(history, /pt-32/);
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
  assert.match(source, /min-h-screen bg-transparent pb-28 pt-10 sm:pb-32/);
  assert.doesNotMatch(source, /pt-20/);
  assert.doesNotMatch(source, /pt-32/);
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
  assert.doesNotMatch(pricing, /返回做圖/);
  assert.match(pricing, /兑换码/);
  assert.match(pricing, /兑换成功/);
  assert.doesNotMatch(pricing, /兌換碼/);
});

test("pricing page is a focused compact panel with in-card checkout", () => {
  const pricing = read("src/components/PricingClient.tsx");

  // 2026-08-25 重构：聚焦卡片布局——首屏无滚动看全周期切换 + 三档卡片；
  // 底部悬浮结账栏移除，收银台收进选中卡片内部。
  assert.match(pricing, /max-w-6xl/);
  assert.match(pricing, /sm:grid-cols-3/);
  assert.doesNotMatch(pricing, /fixed inset-x-0 bottom-/);
  assert.doesNotMatch(pricing, /mobile-pricing-/);
  assert.doesNotMatch(pricing, /sm:text-center/);
  assert.doesNotMatch(pricing, /pt-20/);
});

test("pricing plans are selectable cards with in-card checkout closure", () => {
  const pricing = read("src/components/PricingClient.tsx");

  // App Store 收银架构（2026-08-25 收进卡片）：点卡即选，选中卡内展开
  // 支付方式分段 + 唯一支付 CTA；未选中卡只有「选择此方案」。
  assert.match(pricing, /role="radiogroup" aria-label="充值方案"/);
  assert.match(pricing, /aria-checked=\{selected\}/);
  assert.match(pricing, /useState\("popular"\)/);
  assert.match(pricing, /立即支付 ¥\{plan\.price\}/);
  assert.doesNotMatch(pricing, /handleMapayBuy\(plan\.id/);
  // 支付在新窗口完成，卡内必须有「刷新余额」的闭环反馈。
  assert.match(pricing, /支付页已在新窗口打开/);
  assert.match(pricing, /已完成支付，刷新余额/);
});

test("pricing page exposes docs link and redeem anchor for cdk delivery", () => {
  const pricing = read("src/components/PricingClient.tsx");

  assert.match(pricing, /id="redeem"/);
  assert.match(pricing, /href="\/docs"/);
});

test("pricing checkout keeps WeChat first and still routes through mapay", () => {
  const pricing = read("src/components/PricingClient.tsx");

  assert.match(pricing, /微信支付/);
  assert.match(pricing, /支付宝支付/);
  // 支付方式在结账栏的分段控件里选，支付动作只有一处。
  assert.match(pricing, /role="radiogroup" aria-label="支付方式"/);
  assert.match(pricing, /handleMapayBuy\(selectedPlan\.id, payMethod\)/);
  assert.match(pricing, /\/api\/payments\/mapay\/checkout\?plan=/);
  assert.match(pricing, /type=\$\{encodeURIComponent\(type\)\}/);
  assert.ok(pricing.indexOf("微信支付") < pricing.indexOf("支付宝支付"));
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

  assert.match(auth, /setStoredToken\(t, result\.user\)/);
  assert.match(auth, /setStoredToken\(storedToken, result\.user\)/);
});
