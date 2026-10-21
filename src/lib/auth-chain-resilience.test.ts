import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 登入链韧性（2026-09-05 事故：AI 助理「偶尔跳未登录」+「登录按钮回调没被接收」）。
 * 源码级断言钉住四个根因修复，防回归：
 * ① fetchMe 把 5xx/网路抖动标成 transient，use-auth 只在非 transient 时抹凭证；
 * ② AgentChatSurface 的 isAuthError 覆盖服务端 401 文案，startLoginThenRetry
 *    认 postMessage/storage，不再只轮询 popup.closed；
 * ③ Navbar 读 auth_error：弹窗内转发 opener 并自闭，主页 toast 人话；
 * ④ callback 种 napi_user 必须 encodeURIComponent（裸 JSON 会被严格浏览器丢弃）。
 */

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

test("fetchMe distinguishes transient failures from a real session expiry", () => {
  const source = read("src/lib/auth-client.ts");
  assert.match(source, /transient\?: boolean/);
  // 只有 cookie 与传入 token 都 401 后才清理，避免旧 localStorage 误杀新 cookie。
  assert.match(source, /for \(const candidate of \[\.\.\.new Set\(candidateTokens\)\]\)/);
  assert.match(source, /clearStoredToken\(\);\s*return \{ ok: false, error: "session_expired" \};/);
  assert.match(source, /res\.status >= 500[\s\S]{0,80}transient: true/);
  assert.match(source, /catch \{[\s\S]{0,80}error: "网络错误", transient: true/);
});

test("use-auth keeps the login state on transient fetchMe failures", () => {
  const source = read("src/hooks/use-auth.tsx");
  // refresh() 与 mount 背景校验两处都只在 !transient 时登出。
  const clears = source.match(/else if \(!result\.transient\) \{/g) ?? [];
  assert.equal(clears.length, 2, "refresh 与 mount effect 都要走 transient 分支");
  assert.doesNotMatch(source, /\} else \{\s*clearStoredToken\(\);/);
});

test("agent chat auth errors offer the login button for server-side 401 copy too", () => {
  const source = [
    read("src/components/agent-chat/AgentChatSurface.tsx"),
    read("src/components/agent-chat/AgentChatSurface.helpers.ts"),
    read("src/components/agent-chat/AgentChatSurface.session-actions.ts"),
  ].join("\n");
  assert.match(source, /error\.includes\("请先登录"\)/);
  assert.match(source, /error\.includes\("登录状态已失效"\)/);
});

test("startLoginThenRetry navigates same-window (popup dead-window immune)", () => {
  const source = [
    read("src/components/agent-chat/AgentChatSurface.tsx"),
    read("src/components/agent-chat/AgentChatSurface.helpers.ts"),
    read("src/components/agent-chat/AgentChatSurface.session-actions.ts"),
  ].join("\n");
  // 2026-09-05 死窗事故：popup 在套壳/内嵌 webview 上窗口对象存在但内容
  // 永远 about:blank，三个完成信号全不来。治本 = 登录一律同窗口跳转。
  assert.match(source, /window\.location\.href = "\/api\/auth\/github\/start"/);
  assert.doesNotMatch(source, /window\.open\("\/api\/auth\/github\/start"/);
});

test("Navbar surfaces auth_error instead of swallowing it", () => {
  const source = read("src/components/Navbar.tsx");
  assert.match(source, /function describeAuthError/);
  assert.match(source, /params\.get\("auth_error"\)/);
  // 弹窗内：转发失败给 opener 并自我关闭（主页才等得到结束信号）。
  assert.match(source, /postMessage\(\{ type: "github-auth-error", code: authError \}/);
  assert.match(source, /window\.close\(\)/);
  // 主页：人话 toast + 抹参数。
  assert.match(source, /GitHub 登录未完成/);
  assert.match(source, /params\.delete\("auth_error"\)/);
  // 监听器也要认 github-auth-error（Navbar 自己开的弹窗失败时）。
  assert.match(source, /event\.data\?\.type === "github-auth-error"/);
});

test("github callback stores napi_user cookie URL-encoded", () => {
  const source = read("src/app/api/auth/github/callback/route.ts");
  assert.match(source, /napi_user", encodeURIComponent\(JSON\.stringify\(loginResult\.user\)\)/);
});
