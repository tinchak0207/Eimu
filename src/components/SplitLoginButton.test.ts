import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * SplitLoginButton 三段斜切（Google → GitHub → 微信）契约测试。
 * 组件是 client component（JSX + useState），单测只做源码级断言，
 * 与 Navbar.auth-ui.test.ts 同一风格。
 */
const source = readFileSync(join(process.cwd(), "src/components/SplitLoginButton.tsx"), "utf8");

/** 取某个 aria-label 所属的 <button> 片段（到下一个 <button 为止）。 */
function segment(label: string): string {
  const start = source.indexOf(`aria-label="${label}"`);
  assert.notEqual(start, -1, `缺少按钮 aria-label="${label}"`);
  const end = source.indexOf("<button", start);
  return end === -1 ? source.slice(start) : source.slice(start, end);
}

const DIAGONAL_PX = "${DIAGONAL}px";

test("three segments are ordered Google → GitHub → 微信 with their own clip-path", () => {
  const google = segment("使用 Google 登录");
  const github = segment("使用 GitHub 登录");
  const wechat = segment("使用微信登录");

  // 斜切几何：DIAGONAL = 12，斜線自上而下向左傾（與原 2 段同向）。
  assert.match(source, /const DIAGONAL = 12;/);
  // 段 0（最左）：左邊界貼齊容器左緣，右邊界斜切。
  assert.ok(
    google.includes(`polygon(0 0, calc(100% + ${DIAGONAL_PX}) 0, calc(100% - ${DIAGONAL_PX}) 100%, 0 100%)`),
    "段 0 clipPath 必須是左緣垂直、右緣斜切",
  );
  // 段 1（中）：左右兩條斜邊都與鄰段公共邊重合。
  assert.ok(
    github.includes(
      `polygon(${DIAGONAL_PX} 0, calc(100% + ${DIAGONAL_PX}) 0, calc(100% - ${DIAGONAL_PX}) 100%, -${DIAGONAL_PX} 100%)`,
    ),
    "段 1 clipPath 必須兩側斜切",
  );
  // 段 2（最右）：左邊界必須是「底 -12px」——與段 1 右邊界的「底 100%-12px」
  // 在容器座標重合；寫成 12px（垂直左緣）會在交界底部留 24px 透明楔形缺口。
  assert.ok(
    wechat.includes(`polygon(${DIAGONAL_PX} 0, 100% 0, 100% 100%, -${DIAGONAL_PX} 100%)`),
    "段 2 clipPath 左邊界必須與段 1 右邊界共線（斜切，非垂直）",
  );

  // 疊序沿用「右壓左」：z-0 / z-10 / z-20，且三段各佔 1/3、逐段右移。
  assert.ok(google.includes("absolute inset-y-0 left-0 z-0 flex w-[33.333%]"));
  assert.ok(github.includes("absolute inset-y-0 left-[33.333%] z-10 flex w-[33.333%]"));
  assert.ok(wechat.includes("absolute inset-y-0 left-[66.667%] z-20 flex w-[33.333%]"));
  assert.match(source, /h-10 w-\[196px\] overflow-hidden rounded-full shadow-\[0_4px_14px_rgba\(0,0,0,0\.16\)\] sm:w-\[330px\]/);
});

test("SplitLoginButton exposes onGoogle / onGithub / onWechat and keeps githubBusy", () => {
  assert.match(source, /onGoogle: \(\) => void;/);
  assert.match(source, /onGithub: \(\) => void;/);
  assert.match(source, /onWechat: \(\) => void;/);
  assert.match(source, /githubBusy\?: string \| null;/);
  assert.match(source, /onClick=\{onGoogle\}/);
  assert.match(source, /onClick=\{onGithub\}/);
  assert.match(source, /onClick=\{onWechat\}/);
  // 「连接中…」只在 GitHub 段出现。
  assert.match(source, /githubBusy \? "连接中…" : "GitHub"/);
  const busyMentions = source.match(/连接中…/g) ?? [];
  assert.equal(busyMentions.length, 1, "连接中… 只允许出现在 GitHub 段");
});

test("segment labels hide below sm (icon-only on phones)", () => {
  const labels = source.match(/className="hidden sm:inline"/g) ?? [];
  assert.equal(labels.length, 3, "三段文字都必须带 hidden sm:inline");
  assert.match(source, /<span className="hidden sm:inline">Google<\/span>/);
  assert.match(source, /<span className="hidden sm:inline">微信<\/span>/);
});

test("provider marks are inlined: WechatLogo kept, Google uses the official 4-color G", () => {
  assert.match(source, /function WechatLogo/);
  assert.match(source, /<WechatLogo className="h-4 w-4 shrink-0" \/>/);
  assert.match(source, /<Github className="h-4 w-4 shrink-0" aria-hidden="true" \/>/);

  const google = source.slice(source.indexOf("function GoogleLogo"), source.indexOf("const DIAGONAL"));
  assert.match(google, /viewBox="0 0 24 24"/);
  assert.match(google, /aria-hidden="true"/);
  for (const hex of ["#4285F4", "#34A853", "#FBBC05", "#EA4335"]) {
    assert.ok(google.includes(hex), `Google 四色標記缺少 ${hex}`);
  }
});

test("hover swap keeps the existing per-segment palette", () => {
  assert.match(source, /hover === "google" \? "bg-\[#3367D6\]" : "bg-\[#4285F4\]"/);
  assert.match(source, /hover === "github" \? "bg-\[#16181c\]" : "bg-\[#1f2328\]"/);
  assert.match(source, /hover === "wechat" \? "bg-\[#06ad56\]" : "bg-\[#07c160\]"/);
  assert.match(source, /onMouseLeave=\{\(\) => setHover\(null\)\}/);
  const rings = source.match(/focus-visible:ring-2 focus-visible:ring-white\/70 focus-visible:ring-inset/g) ?? [];
  assert.equal(rings.length, 3, "三段都要保留 focus-visible ring");
});
