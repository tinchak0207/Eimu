import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

function read(relPath: string) {
  return readFileSync(join(process.cwd(), relPath), "utf8");
}

test("single docs page teaches assistant users and keeps the developer appendix", () => {
  const page = read("src/app/docs/page.tsx");

  // 受眾＝助理聊天用戶：必須把野獸模式、一輪對話里的计划卡／思考链講清楚。
  assert.match(page, /野兽模式/, "必须讲清野兽模式");
  assert.match(page, /计划卡/, "必须提到计划卡");
  assert.match(page, /思考链/, "必须提到思考链");
  // 極限档行為描述三層（導演的口吻，公開文檔禁用「MOE」字眼）。
  assert.match(page, /专家子助理/, "野兽模式要用行为描述专家子助理");
  assert.match(page, /生产泳道/, "野兽模式要画到生产泳道");
  assert.doesNotMatch(page, /MOE|Moe(?![A-Za-z])/, "公开文档禁用 MOE 字眼");
  // 兩態原話逐字不動。
  assert.match(page, /拼尽全力达到最完美的效果，满足追求极限的你/, "开了原话逐字保留");
  assert.match(page, /大部分场合不需要开启，留给真正硬核的点子/, "关着原话逐字保留");

  // 保留 use client：端点目录要靠客户端 fetch 动态渲染。
  assert.match(page, /"use client"/, "单页保留 use client");

  // 开发者 API 附錄并入同一份文档尾部：端点信息必须来自运行 spec，认证与 base URL 齐全。
  assert.match(page, /\/api\/v1\/openapi\.json/, "必须 fetch 真实 openapi spec");
  assert.match(page, /sk-biz-/, "必须说明 B 端密钥认证");
  assert.match(page, /Authorization: Bearer/, "必须给出认证方式");
  assert.match(page, /eimu\.dev\/v1/, "必须给出 base URL");

  // MCP 乾貨并入第五章，不再外链死路子页。
  assert.match(page, /IMAGE_STUDIO_BIZ_KEY/, "第五章必须保留 MCP 密钥配置");
  assert.match(page, /IMAGE_STUDIO_API_BASE/, "第五章必须保留 MCP API base 配置");
  assert.match(page, /generate_image/, "第五章必须列出图像工具");
  assert.match(page, /generate_video/, "第五章必须列出视频工具");
  assert.match(page, /npm run build/, "第五章必须保留构建步骤");
  // 作品报告 PDF 直连保留（不再用页面壳）。
  assert.match(page, /\/docs\/eimu-competition-report\.pdf/, "第五章保留作品报告 PDF 直连");

  // contract-lock：端点路径必须来自运行的 spec，禁止内联手写字面量。
  assert.doesNotMatch(page, /"\/images\/generations"/, "端点路径必须来自 spec，不内联手写");
  assert.doesNotMatch(page, /"\/videos\/generations"/, "端点路径必须来自 spec，不内联手写");
});

test("docs sidebar exposes exactly one entry pointing at /docs", () => {
  const sidebar = read("src/app/docs/DocsSidebar.tsx");
  assert.match(sidebar, /href: "\/docs"/, "sidebar 必须带文档入口");
  assert.match(sidebar, /BookOpen/, "文档入口用 BookOpen 图标");
  assert.match(sidebar, /usePathname/, "sidebar 必须高亮当前章节");
  assert.match(sidebar, /aria-current/, "当前章节必须有 aria-current");
  // 旧子页入口全部移除。
  assert.doesNotMatch(sidebar, /\/docs\/api/, "sidebar 不再单列 API 子页");
  assert.doesNotMatch(sidebar, /\/docs\/mcp/, "sidebar 不再单列 MCP 子页");
  assert.doesNotMatch(sidebar, /\/docs\/harness/, "sidebar 不再单列 Harness 子页");
  assert.doesNotMatch(sidebar, /\/docs\/report/, "sidebar 不再单列报告子页");
  // 只有一项：href: "/docs" 出现且仅一次。
  const docsEntries = sidebar.match(/href: "\/docs"/g) ?? [];
  assert.equal(docsEntries.length, 1, "sidebar 只应有一个 /docs 入口");
});

test("docs layout carries shared shell and single-doc metadata", () => {
  const layout = read("src/app/docs/layout.tsx");
  assert.match(layout, /DocsSidebar/, "docs 必须共享 sidebar layout");
  assert.match(layout, /page-shell/, "docs 内容必须走站内统一 gutter");
  // 面包屑／标题同步：metadata 由 layout 承担（page 是 use client，不能再导出 metadata）。
  assert.match(layout, /metadata/, "layout 必须导出 metadata");
  assert.doesNotMatch(layout, /CDK|兑换/, "CDK 兑换旧文案已移除");
});

test("old docs subpage routes are removed and merged page exists", () => {
  for (const rel of [
    "src/app/docs/api",
    "src/app/docs/mcp",
    "src/app/docs/harness",
    "src/app/docs/report",
  ]) {
    assert.equal(existsSync(join(process.cwd(), rel)), false, `${rel} 路由目录应已删除`);
  }
  // 合并后的单页存在。
  assert.equal(existsSync(join(process.cwd(), "src/app/docs/page.tsx")), true, "/docs 单页必须存在");
});
