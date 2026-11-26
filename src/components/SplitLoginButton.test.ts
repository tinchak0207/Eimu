import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * SplitLoginButton 契约测试（2026-11-26 按 55a867597 改版后重写）。
 * 现形态：单颗渐变「登录」胶囊 + 下拉三种方式（微信 → Google → GitHub）；
 * 旧的「三段斜切」形态已废。组件是 client component，单测只做源码级断言（变更探针，非行为 oracle），
 * 与 Navbar.auth-ui.test.ts 同一风格。
 */
const source = readFileSync(join(process.cwd(), "src/components/SplitLoginButton.tsx"), "utf8");

test("trigger is one 登录 pill and the menu lists 微信 → Google → GitHub in order", () => {
  assert.match(source, /aria-label="登录"/);
  assert.equal((source.match(/<DropdownMenuItem /g) ?? []).length, 3, "下拉里恰好三种登录方式");
  const wechat = source.indexOf("微信登录");
  const google = source.indexOf("Google 登录");
  const github = source.indexOf("GitHub 登录");
  assert.ok(wechat !== -1 && google !== -1 && github !== -1, "三种方式文案都必须在");
  assert.ok(wechat < google && google < github, "顺序必须是 微信 → Google → GitHub");
});

test("SplitLoginButton exposes onGoogle / onGithub / onWechat and keeps githubBusy", () => {
  assert.match(source, /onGoogle: \(\) => void;/);
  assert.match(source, /onGithub: \(\) => void;/);
  assert.match(source, /onWechat: \(\) => void;/);
  assert.match(source, /githubBusy\?: string \| null;/);
  assert.match(source, /onSelect=\{onGoogle\}/);
  assert.match(source, /onSelect=\{onGithub\}/);
  assert.match(source, /onSelect=\{onWechat\}/);
  // 「连接中…」只在 GitHub 项出现。
  assert.match(source, /githubBusy \? "连接中…" : "GitHub 登录"/);
  const busyMentions = source.match(/连接中…/g) ?? [];
  assert.equal(busyMentions.length, 1, "连接中… 只允许出现在 GitHub 项");
});

test("provider marks are inlined: WechatLogo kept, Google uses the official 4-color G", () => {
  assert.match(source, /function WechatLogo/);
  assert.match(source, /<WechatLogo className="h-2\.5 w-2\.5" \/>/);
  assert.match(source, /<Github className="h-4 w-4 shrink-0 text-\[#1f2328\]" aria-hidden="true" \/>/);

  const google = source.slice(source.indexOf("function GoogleLogo"), source.indexOf("export function SplitLoginButton"));
  assert.match(google, /viewBox="0 0 24 24"/);
  assert.match(google, /aria-hidden="true"/);
  for (const hex of ["#4285F4", "#34A853", "#FBBC05", "#EA4335"]) {
    assert.ok(google.includes(hex), `Google 四色标记缺少 ${hex}`);
  }
});

test("menu keeps brand colors only on the icons (wechat green badge, flat trigger)", () => {
  assert.match(source, /bg-\[#07c160\]/);
  assert.match(source, /bg-\[linear-gradient\(135deg,#e9f2ff_0%,#f2eaff_100%\)\]/);
  assert.doesNotMatch(source, /clipPath|polygon\(/, "旧三段斜切几何不得回流");
});
