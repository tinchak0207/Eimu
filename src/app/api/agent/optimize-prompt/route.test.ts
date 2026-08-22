// optimize-prompt 免费层路由的不变量测试。
// 免费公开端点：不读鉴权头、不把服务端 key 泄露进响应、校验与限流分支齐全。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(
  join(process.cwd(), "src/app/api/agent/optimize-prompt/route.ts"),
  "utf8",
);

/** 去掉註解後再斷言，避免註解裡引用的反例把測試帶跑。 */
function code(): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

test("免费层路由不得读取任何授权头", () => {
  const c = code();
  assert.doesNotMatch(c, /authorization/i);
  assert.doesNotMatch(c, /Bearer/);
  assert.doesNotMatch(c, /x-user-id/);
});

test("服务端 key 不得出现在路由源码（无泄露路径）", () => {
  const c = code();
  assert.doesNotMatch(c, /AGENT_OPTIMIZE_KEY/);
  assert.doesNotMatch(c, /process\.env/);
  // 响应构造里不得引用任何 key 类变量
  assert.doesNotMatch(c, /data:\s*\{[^}]*key/);
});

test("校验分支：空 prompt / 非 string / 超长", () => {
  const c = code();
  assert.match(c, /typeof rawPrompt !== "string"/);
  assert.match(c, /!rawPrompt\.trim\(\)/);
  assert.match(c, /MAX_PROMPT_LENGTH/);
  assert.match(c, /4000/);
  assert.match(c, /"invalid_prompt"/);
  assert.match(c, /"prompt_too_long"/);
  assert.match(c, /400/);
});

test("限流：每 IP 每 10 分钟 20 次，内存 Map 尽力而为", () => {
  const c = code();
  assert.match(c, /RATE_LIMIT\s*=\s*20/);
  assert.match(c, /RATE_WINDOW_MS\s*=\s*10 \* 60 \* 1000/);
  assert.match(c, /new Map<string, number\[\]>\(\)/);
  assert.match(c, /x-forwarded-for/);
  assert.match(c, /429/);
  assert.match(c, /"rate_limited"/);
  // 语义注释：serverless 下非精确
  assert.match(source, /尽力而为/);
  assert.match(source, /serverless/);
});

test("Agent 层优先、规则层兜底、都失败才 502", () => {
  const c = code();
  assert.match(c, /optimizeVideoPromptWithAgent\(prompt\)/);
  assert.match(c, /usedAgent: true/);
  assert.match(c, /directVideoPrompt\(prompt\)/);
  assert.match(c, /ruled !== prompt/);
  assert.match(c, /usedAgent: false/);
  assert.match(c, /502/);
  assert.match(c, /"optimize_failed"/);
});

test("optimize-prompt 是 nodejs 路由且固定区域", () => {
  assert.match(source, /export const runtime = "nodejs"/);
  assert.match(source, /export const dynamic = "force-dynamic"/);
  assert.match(source, /export const preferredRegion = "sfo1"/);
});
