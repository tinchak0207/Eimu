import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  PLANS,
  PLAN_REFERENCE_COINS_PER_IMAGE,
  formatCoins,
  gptImage2EquivalentImages,
  modelPriceRows,
  planDiscountPercent,
  planUnitsForCoins,
} from "../lib/plans.ts";
import { generationCoins } from "../lib/generation-model-catalog.ts";

function read(relPath: string) {
  return readFileSync(join(process.cwd(), relPath), "utf8");
}

/**
 * 充值页与站内共享 UI 的质量下限。
 * 与 history/HistoryQuality.test.ts 同一套约定：把已经修过一次的坑
 * 锁成断言，未来任何改版都不允许悄悄回归。
 */

test("pricing and docs headings use the real largetitle token", () => {
  // 字级表里只有 ios-largetitle；ios-large-title 是不存在的 class，
  // 曾让两页的桌面端大标题静默失效（渲染成 title1 的尺寸）。
  for (const file of ["src/components/PricingClient.tsx", "src/app/docs/page.tsx"]) {
    const source = read(file);
    assert.doesNotMatch(source, /ios-large-title/, `${file} 使用了不存在的 ios-large-title`);
    assert.match(source, /ios-largetitle/);
  }
});

test("pricing/docs/shared-ui text never drops below the AA contrast floor", () => {
  // 0.44 以下的黑字在近白底上连 3:1 都不到——与 /history 已锁定的下限一致。
  const files = [
    "src/components/PricingClient.tsx",
    "src/app/docs/page.tsx",
    "src/components/Navbar.tsx",
    "src/components/WalletBadge.tsx",
    "src/components/ModelPicker.tsx",
    "src/components/PromptInput.tsx",
    // Task 6+9 抽出的面板与 rail 常量：文字随 JSX 迁移，对比度下限继续盯住。
    "src/components/prompt-input/rail-classes.ts",
    "src/components/prompt-input/GenerateControls.tsx",
    "src/components/prompt-input/EditPanel.tsx",
    "src/components/prompt-input/UpscalePanel.tsx",
    "src/components/prompt-input/ActionRow.tsx",
    "src/components/ImageDisplay.tsx",
  ];

  const failingTextColor = /text-\[rgba\(0,0,0,0\.(0[0-9]|[0-3][0-9])\)\]/;

  for (const file of files) {
    const source = read(file);
    assert.doesNotMatch(source, failingTextColor, `${file} 仍有低于对比度下限的文字`);
  }
});

test("pricing page has no 11px caption2 copy at all", () => {
  // 10–11px 的文案被验收方明确判为不可读；充值页信息层级只允许 caption1 起步。
  const source = read("src/components/PricingClient.tsx");
  assert.doesNotMatch(source, /text-ios-caption2/);
});

test("the invite link shown on screen is exactly what the copy button writes", () => {
  const source = read("src/components/PricingClient.tsx");

  // 复制的是 ?ref=，展示的曾是 /ref= —— 手抄屏幕上那条会打不开。
  assert.match(source, /\$\{window\.location\.origin\}\?ref=\$\{affCode\}/);
  assert.match(source, /\?ref=\$\{affCode\}`\}/);
  assert.doesNotMatch(source, /\/ref=\$\{affCode\}/);
});

test("no user-facing surface uses a dead non-multiple-of-5 opacity modifier", () => {
  // Tailwind 默认透明度刻度只有 5 的倍数，/38、/74 这类修饰符会静默编译成
  // 空规则——签到弹窗和图片放大层的深色遮罩都曾因此完全透明。
  const files = [
    "src/components/PricingClient.tsx",
    "src/app/docs/page.tsx",
    "src/components/Navbar.tsx",
    "src/components/WalletBadge.tsx",
    "src/components/CheckinCalendar.tsx",
    "src/components/ImageDisplay.tsx",
    "src/components/ui/toast.tsx",
  ];

  const modifierPattern = /(?:white|black|#[0-9a-fA-F]{3,8})\/(\d{1,3})\b/g;

  for (const file of files) {
    const source = read(file);
    const offenders: string[] = [];
    for (const match of source.matchAll(modifierPattern)) {
      const value = Number(match[1]);
      if (value % 5 !== 0) offenders.push(match[0]);
    }
    assert.deepEqual(offenders, [], `${file} 有死透明度修饰符: ${offenders.join(", ")}`);
  }
});

test("the image zoom overlay backdrop is a real arbitrary color", () => {
  const source = read("src/components/ImageDisplay.tsx");
  assert.match(source, /bg-\[rgba\(31,34,48,0\.74\)\]/);
  assert.doesNotMatch(source, /bg-\[#1f2230\]\/74/);
});

test("model price table is derived from the billing catalog, never hand-written", () => {
  // 换算展示的护身符：表里每一个数字都必须等于计费配置（catalog + 运行时覆写）
  // 计算值。手写静态表一旦与实收脱钩，比价页就变成虚假宣传。
  const rows = modelPriceRows();
  assert.ok(rows.length >= 35, "模型单价表应覆盖全部上架模型（图像+视频），当前只有 " + rows.length + " 行");

  const ids = new Set(rows.map((row) => row.id));
  assert.equal(ids.size, rows.length, "模型单价表不允许重复行");

  for (const row of rows) {
    assert.equal(row.kind === "video", row.unit === "秒", row.id + " 的计价单位应与模型类型一致");
    assert.ok(row.cells.length > 0, row.id + " 至少要有一个分辨率档位");
    for (const cell of row.cells) {
      const expected = generationCoins(
        row.id,
        row.kind === "video"
          ? { resolution: cell.resolution, durationSeconds: 1 }
          : { resolution: cell.resolution },
      );
      assert.equal(
        cell.coins,
        expected,
        row.id + " " + cell.resolution + " 的展示单价必须等于计费配置计算值",
      );
      assert.ok(cell.coins > 0, row.id + " " + cell.resolution + " 单价必须为正数");
    }
  }

  // 套餐换算基准与表格口径必须同源：gpt-image-2 1K 行 = 模块基准价。
  const gptRow = rows.find((row) => row.id === "gpt-image-2");
  assert.ok(gptRow, "单价表应包含套餐基准模型 gpt-image-2");
  assert.equal(
    gptRow.cells.find((cell) => cell.resolution === "1k")?.coins,
    PLAN_REFERENCE_COINS_PER_IMAGE,
  );
});

test("plan equivalent-image conversion equals the config-computed value", () => {
  // 每档套餐「X 金币 ≈ Y 张 1024px 标准图」必须可由配置复算：
  // Y = floor(coins / generationCoins("gpt-image-2", 1k))，且基准价被覆写时跟随。
  const perImage = generationCoins("gpt-image-2", { resolution: "1k" });
  for (const plan of PLANS) {
    assert.equal(gptImage2EquivalentImages(plan), Math.floor(plan.coins / perImage));
    assert.equal(gptImage2EquivalentImages(plan, 2), Math.floor(plan.coins / 2));
    assert.ok(gptImage2EquivalentImages(plan) >= 1);
  }
  assert.equal(formatCoins(1), "1");
  assert.equal(formatCoins(0.5), "0.5");
  assert.equal(formatCoins(2.5), "2.5");
  assert.equal(formatCoins(0.1), "0.1");
  assert.equal(formatCoins(100), "100");
});

test("pricing page renders the live model price table, not stale copy", () => {
  const source = read("src/components/PricingClient.tsx");
  // 单价表数据来自 modelPriceRows()（渲染期求值 = 活数据）。
  assert.match(source, /modelPriceRows\(\)/);
  // 套餐换算基准价在渲染期从有效 catalog 取值，admin 改价后立即跟随。
  assert.match(source, /generationCoins\("gpt-image-2", \{ resolution: "1k" \}\)/);
  // 金币数字使用 coin-gold，不与普通正文混色。
  assert.match(source, /#c9a84c/);
  // 每档套餐明示 1024px 标准图口径。
  assert.match(source, /1024px 标准图/);
  // 长表允许滚动，不硬塞一屏。
  assert.match(source, /max-h-\[30rem\] overflow-y-auto/);
  // 卡内第二换算口径（旗舰高清）同为 catalog 活数据。
  assert.match(source, /张旗舰高清 · \{FLAGSHIP_MODEL_LABEL\}/);
  // 对照表各套餐列 = planUnitsForCoins(plan, cell.coins)，不允许手写张数。
  assert.match(source, /planUnitsForCoins\(plan, cell\.coins\)/);
  // 活动位组件存在但无数据时不渲染（不放假倒计时）。
  assert.match(source, /ACTIVE_PRICING_PROMO && <ActivityBanner/);
});

test("in-card conversions and table columns all trace back to catalog prices", () => {
  // 卡内第二口径（旗舰高清）与对照表各套餐列的取值函数都必须可由计费配置复算。
  const flagship = generationCoins("gemini-3-image", { resolution: "1k" });
  assert.ok(flagship > PLAN_REFERENCE_COINS_PER_IMAGE, "旗舰档单价应高于标准档");
  for (const plan of PLANS) {
    assert.equal(gptImage2EquivalentImages(plan, flagship), Math.floor(plan.coins / flagship));
    assert.equal(planUnitsForCoins(plan, flagship), Math.floor(plan.coins / flagship));
    assert.equal(planUnitsForCoins(plan, 0), 0);
  }
  // 折扣标只挂真实 anchorPrice 差价，且幅度在合理区间。
  for (const plan of PLANS) {
    const pct = planDiscountPercent(plan);
    if (pct !== null) {
      assert.ok(plan.anchorPrice > plan.price, plan.id + " 的折扣标要求原价高于现价");
      assert.ok(pct >= 5 && pct <= 95, plan.id + " 的折扣百分比超出合理区间: " + pct);
    }
  }
});

test("toasts speak the site's liquid-glass material, not stock shadcn", () => {
  const source = read("src/components/ui/toast.tsx");

  // 充值兑换的成功/失败反馈就是这个组件——材质必须与全站玻璃语言同族。
  assert.match(source, /rounded-ios-2xl/);
  assert.match(source, /backdrop-blur-\[28px\]/);
  assert.doesNotMatch(source, /rounded-md border p-4 pr-6 shadow-lg/);
});
