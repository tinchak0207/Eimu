import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function read(relPath: string) {
  return readFileSync(join(process.cwd(), relPath), "utf8");
}

test("docs home links into api and mcp sections with stable copy", () => {
  const source = read("src/app/docs/page.tsx");

  assert.match(source, /href: "\/docs\/api"/, "首页必须带 API 文档入口");
  assert.match(source, /href: "\/docs\/mcp"/, "首页必须带 MCP 接入入口");
  assert.match(source, /API 文档/, "入口必须写清 API 文档");
  assert.match(source, /MCP 接入/, "入口必须写清 MCP 接入");
  assert.match(source, /eimu\.dev/, "必须提及站点");
  // CDK 兑换教学已下架：首页不再出现兑换引导，也不引用 redeem 锚点。
  assert.doesNotMatch(source, /CDK/, "CDK 兑换教学已移除");
  assert.doesNotMatch(source, /href="\/pricing#redeem"/, "兑换锚点已移除");
  assert.doesNotMatch(source, /兑换/, "兑换教学已移除");
});

test("docs has a shared sidebar layout with a stable table of contents", () => {
  const layout = read("src/app/docs/layout.tsx");
  assert.match(layout, /DocsSidebar/, "docs 必须共享 sidebar layout");
  assert.match(layout, /page-shell/, "docs 内容必须走站内统一 gutter");

  const sidebar = read("src/app/docs/DocsSidebar.tsx");
  assert.match(sidebar, /href: "\/docs"/, "sidebar 必须带概览入口");
  assert.match(sidebar, /href: "\/docs\/api"/, "sidebar 必须带 API 文档入口");
  assert.match(sidebar, /href: "\/docs\/mcp"/, "sidebar 必须带 MCP 接入入口");
  assert.match(sidebar, /usePathname/, "sidebar 必须高亮当前章节");
  assert.match(sidebar, /aria-current/, "当前章节必须有 aria-current");
});

test("api docs renders live from the openapi spec instead of hand-written copies", () => {
  const apiPage = read("src/app/docs/api/page.tsx");
  assert.match(apiPage, /\/api\/v1\/openapi\.json/, "必须 fetch 真实 openapi spec");
  assert.match(apiPage, /sk-biz-/, "必须说明 B 端密钥认证");
  assert.match(apiPage, /Authorization: Bearer/, "必须给出认证方式");
  assert.match(apiPage, /eimu\.dev\/v1/, "必须给出 base URL");

  // docs 不得抄 openapi：端点信息必须来自 fetch 后遍历 spec.paths，不允许内联手写。
  assert.doesNotMatch(apiPage, /"\/images\/generations"/, "端点路径必须来自运行的 spec，不内联手写");
  assert.doesNotMatch(apiPage, /"\/videos\/generations"/, "端点路径必须来自运行的 spec，不内联手写");
});

test("mcp docs teaches how to wire the server into MCP clients", () => {
  const mcpPage = read("src/app/docs/mcp/page.tsx");
  assert.match(mcpPage, /IMAGE_STUDIO_BIZ_KEY/, "必须说明如何注入密钥");
  assert.match(mcpPage, /IMAGE_STUDIO_API_BASE/, "必须说明 API base 配置");
  assert.match(mcpPage, /mcpServers/, "必须给出 MCP 配置 JSON 形状");
  assert.match(mcpPage, /generate_image/, "必须列出可用工具");
  assert.match(mcpPage, /generate_video/, "必须列出视频工具");
  assert.match(mcpPage, /npm run build/, "必须说明构建步骤");
});