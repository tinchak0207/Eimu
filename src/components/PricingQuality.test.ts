import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

test("toasts speak the site's liquid-glass material, not stock shadcn", () => {
  const source = read("src/components/ui/toast.tsx");

  // 充值兑换的成功/失败反馈就是这个组件——材质必须与全站玻璃语言同族。
  assert.match(source, /rounded-ios-2xl/);
  assert.match(source, /backdrop-blur-\[28px\]/);
  assert.doesNotMatch(source, /rounded-md border p-4 pr-6 shadow-lg/);
});
