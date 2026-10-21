// /mcp 发现面的真行为断言（不是源码字串扫描）：
//   1. well-known route handler 直呼 → 200，JSON 的 resource 指向 /api/mcp，scope 非空；
//   2. /mcp 页用 react-dom/server 真渲染 → 输出含端点 URL 与每个工具名/scope；
//   3. 负向对照：渲染输出与 llms.txt 都不得出现像真密钥的 sk-biz- 值。
//
// 工具名与 scope 清单在测试里独立列出（不从被测模块 import）：
// 页面自己列错、或清单被悄悄改少，都会在这里红。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GET } from "../.well-known/oauth-protected-resource/route";
import McpPage from "./page";
import { getSiteUrlFromEnv } from "@/lib/site-url";

const ORIGIN = getSiteUrlFromEnv();
const ENDPOINT = `${ORIGIN}/api/mcp`;

const EXPECTED_TOOL_NAMES = [
  "list_skills",
  "get_skill",
  "list_models",
  "generate_image",
  "edit_image",
  "generate_video",
  "tts",
  "upscale",
  "get_quota",
  "get_result",
  "list_canvas_projects",
  "canvas_get_state",
  "workflow_read",
  "workflow_history",
  "workflow_write",
  "workflow_rollback",
  "list_agent_sessions",
  "get_agent_session",
  "get_agent_settings",
  "run_agent",
  "abort_agent_session",
  "check_delivery_contract",
  "evaluate_media_quality",
] as const;

// 这份清单是「scope 真值」的漂移探针：/mcp 页与 well-known 发现文件都必须完整宣告它。
// 目前 scope 真源落在 src/app/mcp/page.tsx 的 MCP_TOOLS（tools.ts 只承载工具名，不带 scope）；
// 新增工具带新 scope 而未同步本清单、页面或发现文件，任一处漏掉都会在这里红。
const EXPECTED_SCOPES = [
  "eimu:models:read",
  "eimu:skills:read",
  "eimu:image:write",
  "eimu:video:write",
  "eimu:audio:write",
  "eimu:tasks:read",
  "eimu:quota:read",
  "eimu:canvas:read",
  "eimu:canvas:write",
  "eimu:agent:read",
  "eimu:agent:write",
  "eimu:harness:read",
] as const;

// 像真密钥的值：sk-biz- 或 sk- 后面接一长串 ASCII 键字符。页面只准出现中文件占位（sk-biz-你的密钥）。
const KEY_LIKE_PATTERNS = [/sk-biz-[A-Za-z0-9_-]{8,}/, /sk-[A-Za-z0-9]{24,}/];

function renderPage(): string {
  return renderToStaticMarkup(createElement(McpPage));
}

test("well-known oauth-protected-resource：直呼 GET 回 200，resource 指向 /api/mcp", async () => {
  const response = GET();
  assert.equal(response.status, 200);

  const body = (await response.json()) as {
    resource?: unknown;
    authorization_servers?: unknown;
    scopes_supported?: unknown;
    resource_documentation?: unknown;
  };

  assert.equal(typeof body.resource, "string", "resource 必须是字符串");
  assert.equal(body.resource, ENDPOINT, "resource 必须指向 MCP 端点");
  assert.ok(
    typeof body.resource === "string" && body.resource.endsWith("/api/mcp"),
    "resource 必须落在 /api/mcp",
  );

  assert.ok(Array.isArray(body.authorization_servers), "authorization_servers 必须是数组");
  assert.ok((body.authorization_servers as unknown[]).length > 0, "authorization_servers 不得为空");

  assert.ok(Array.isArray(body.scopes_supported), "scopes_supported 必须是数组");
  const scopes = body.scopes_supported as unknown[];
  assert.ok(scopes.length > 0, "scopes_supported 不得为空");
  for (const scope of scopes) {
    assert.equal(typeof scope, "string", `scope 必须是字符串，实际 ${String(scope)}`);
    assert.ok((scope as string).trim().length > 0, "scope 不得为空串");
  }
  for (const expected of EXPECTED_SCOPES) {
    assert.ok(scopes.includes(expected), `scopes_supported 缺 ${expected}`);
  }

  assert.equal(typeof body.resource_documentation, "string", "resource_documentation 必须是字符串");
  assert.ok(
    typeof body.resource_documentation === "string" && body.resource_documentation.endsWith("/mcp"),
    "resource_documentation 必须指向 /mcp 安装页",
  );
});

test("/mcp 页真渲染：含端点 URL、每个工具名、每个 scope", () => {
  const html = renderPage();

  assert.ok(html.includes(ENDPOINT), `渲染输出必须含端点 ${ENDPOINT}`);
  assert.ok(html.includes(`${ORIGIN}/.well-known/oauth-protected-resource`), "必须给出发现文档地址");
  assert.ok(html.includes("tools/list"), "必须说明 tools/list");
  assert.ok(html.includes("Authorization: Bearer"), "必须给出认证方式");
  assert.ok(html.includes("401"), "必须说明未授权会回 401");

  for (const name of EXPECTED_TOOL_NAMES) {
    assert.ok(html.includes(name), `渲染输出缺工具名 ${name}`);
  }
  for (const scope of EXPECTED_SCOPES) {
    assert.ok(html.includes(scope), `渲染输出缺 scope ${scope}`);
  }
});

test("/mcp 页真渲染：五个客户端名与可复制片段在场", () => {
  const html = renderPage();

  for (const label of ["Codex", "Claude Code", "Cursor", "OpenClaw", "通用 MCP 客户端"]) {
    assert.ok(html.includes(label), `渲染输出缺客户端分区 ${label}`);
  }
  // 可复制片段：Claude Code 的注册命令与各客户端的 URL 必须真的出现在 <pre><code> 里
  assert.ok(html.includes("claude mcp add --transport http eimu"), "缺 Claude Code 注册命令");
  assert.ok(html.includes("~/.codex/config.toml"), "缺 Codex 配置路径");
  assert.ok(html.includes("~/.cursor/mcp.json"), "缺 Cursor 配置路径");
  assert.equal(html.split(ENDPOINT).length - 1 >= 5, true, "端点 URL 至少出现在五个客户端片段里");
});

test("漂移探针：/mcp 页与 llms.txt 的工具清单＝src/lib/mcp/tools.ts 的真实工具集", () => {
  // tools.ts 是工具名的单一真源（另一路负责）；发现面列少、列旧就是对外说谎。
  // 这不是能力断言（真实行为由 /api/mcp 的测试负责），是清单一致性守卫。
  // <1000 行重构：工具名实体在 tools/tools-definitions.ts（tools.ts 只剩 re-export）。
  const toolsSrc = readFileSync(
    join(process.cwd(), "src/lib/mcp/tools/tools-definitions.ts"),
    "utf8",
  );
  const parsed = [...toolsSrc.matchAll(/^\s{6}name: "([a-z][a-z0-9_]*)",$/gm)].map((match) => match[1]);
  assert.equal(
    parsed.length,
    EXPECTED_TOOL_NAMES.length,
    `tools.ts 解析出 ${parsed.length} 个工具名，与预期 ${EXPECTED_TOOL_NAMES.length} 个不符（新增工具时本页清单要一起改）`,
  );
  assert.deepEqual([...parsed].sort(), [...EXPECTED_TOOL_NAMES].sort());

  const html = renderPage();
  const llms = readFileSync(join(process.cwd(), "public/llms.txt"), "utf8");
  for (const name of parsed) {
    assert.ok(html.includes(name), `/mcp 页缺 tools.ts 里的工具 ${name}`);
    assert.ok(llms.includes(name), `llms.txt 缺 tools.ts 里的工具 ${name}`);
  }
});

test("负向对照：渲染输出与 llms.txt 都不得出现像真密钥的值", () => {
  const html = renderPage();
  for (const pattern of KEY_LIKE_PATTERNS) {
    assert.doesNotMatch(html, pattern, `页面渲染输出命中密钥样 ${pattern}`);
  }

  const llms = readFileSync(join(process.cwd(), "public/llms.txt"), "utf8");
  for (const pattern of KEY_LIKE_PATTERNS) {
    assert.doesNotMatch(llms, pattern, `llms.txt 命中密钥样 ${pattern}`);
  }
});

test("llms.txt 只加节：MCP 端点、认证、工具名与新页链接都在，旧 API 段落仍在", () => {
  const llms = readFileSync(join(process.cwd(), "public/llms.txt"), "utf8");

  assert.ok(llms.includes("POST https://eimu.dev/api/mcp"), "llms.txt 缺 MCP 端点");
  assert.ok(llms.includes("Authorization: Bearer"), "llms.txt 缺认证方式");
  assert.ok(llms.includes("https://eimu.dev/mcp"), "llms.txt 缺 /mcp 安装页链接");
  assert.ok(
    llms.includes("https://eimu.dev/.well-known/oauth-protected-resource"),
    "llms.txt 缺发现文档链接",
  );
  for (const name of EXPECTED_TOOL_NAMES) {
    assert.ok(llms.includes(name), `llms.txt 缺工具名 ${name}`);
  }

  // 既有节不得被重写：旧 B 端 API 段落仍在
  assert.ok(llms.includes("## For developers & agents（B 端 API）"), "既有 API 段落被动了");
  assert.ok(llms.includes("Base URL: https://eimu.dev/v1"), "既有 API base URL 被动了");
  assert.ok(llms.includes("## Eimu 是什么（给回答引擎的事实，2026-09-27 核对）"), "既有产品段落被动了");
});

// AGENT_INSTALL_PROMPT 是 template literal，最容易交坏货的地方在转义：
// 写错一处 \${…} 就会被模板吞成空、curl 续行 \\ 写成 \ 会吃掉换行。
// 这里对「渲染输出」断言骨架行（不是源码字串扫描），掉了就红。
// renderToStaticMarkup 会把文本节点的 ' 转义成 &#x27;、" 转义成 &quot;、
// > 转义成 &gt;、< 转义成 &lt;、& 转义成 &amp;；断言前先还原这些实体，
// 测的是「这行字在不在」，而不是 React 的转义表。&amp; 必须最后还原。
test("/mcp 页真渲染：一键安装指令的承载体行与锚点都在", () => {
  const html = renderPage();
  const text = html
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");

  assert.ok(html.includes("agent-prompt"), "缺新区块锚点 #agent-prompt");
  assert.ok(
    text.includes("Bearer ${EIMU_BIZ_KEY}"),
    "缺字面 ${EIMU_BIZ_KEY}——同时是模板转义（\\${）正确的 oracle",
  );
  assert.ok(
    text.includes("claude mcp add --transport http --scope user eimu"),
    "缺 Claude Code 一键注册命令",
  );
  assert.ok(
    text.includes("grep -v '^export EIMU_BIZ_KEY='"),
    "缺写进 shell 启动文件、清旧行的持久/可重跑那行",
  );
  assert.ok(
    text.includes('[ "${#EIMU_BIZ_KEY}" -gt 20 ]'),
    "缺长度自查断言 [ ${#EIMU_BIZ_KEY} -gt 20 ]",
  );
  assert.ok(
    text.includes("grep -c '^export EIMU_BIZ_KEY=' \"$RC\""),
    "缺「文件里真有那行」的持久性自查断言 grep -c '^export EIMU_BIZ_KEY=' \"$RC\"",
  );
  assert.ok(text.includes("balance_coins"), "缺 get_quota 成功判准 balance_coins");
  assert.ok(text.includes("--header 'Authorization: Bearer"), "缺 --header 'Authorization: Bearer 交付行");
  assert.ok(text.includes("不要看退出码"), "缺「不要看退出码」判据");
  assert.ok(text.includes("✔ Connected"), "缺健康状态判据 ✔ Connected");
});
