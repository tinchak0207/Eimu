import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

function read(relPath: string) {
  return readFileSync(join(process.cwd(), relPath), "utf8");
}

const SUBPAGES = [
  "/docs/assistant",
  "/docs/workflow",
  "/docs/history",
  "/docs/billing",
  "/docs/mcp",
  "/docs/api",
] as const;

function listTsxFiles(dirAbs: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dirAbs, { withFileTypes: true })) {
    const full = join(dirAbs, entry.name);
    if (entry.isDirectory()) out.push(...listTsxFiles(full));
    else if (entry.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

test("hub 总览：快速上手两章齐全、链向全部六篇子页、已是服务端组件", () => {
  const page = read("src/app/docs/page.tsx");

  assert.match(page, /怎么开始对话/, "hub 缺第一篇教学（怎么开始对话）");
  assert.match(page, /一轮对话里会发生什么/, "hub 缺第二篇教学（一轮对话里会发生什么）");
  assert.match(page, /计划卡/, "hub 必须提到计划卡");
  assert.match(page, /思考链/, "hub 必须提到思考链");

  for (const href of SUBPAGES) {
    assert.ok(page.includes(`"${href}"`), `hub 缺子页链接 ${href}`);
  }

  assert.doesNotMatch(page, /"use client"/, "hub 已改回服务端组件，不该再有 use client");
});

test("assistant 分篇：野兽模式原话与行为描述逐字保留、锚点在", () => {
  const assistant = read("src/app/docs/assistant/page.tsx");

  assert.match(assistant, /拼尽全力达到最完美的效果，满足追求极限的你/, "开了原话逐字保留");
  assert.match(assistant, /大部分场合不需要开启，留给真正硬核的点子/, "关着原话逐字保留");
  assert.match(assistant, /专家子助理/, "野兽模式要用行为描述专家子助理");
  assert.match(assistant, /生产泳道/, "野兽模式要画到生产泳道");
  assert.match(assistant, /id="beast-mode"/, "野兽模式锚点必须保留（跨篇深链依赖）");
});

test("docs 全目录禁字：公开文档不出现 MOE 字眼", () => {
  const files = listTsxFiles(join(process.cwd(), "src/app/docs"));
  assert.ok(files.length >= 9, `docs 目录 .tsx 文件数异常，只找到 ${files.length} 个`);
  const all = files.map((f) => readFileSync(f, "utf8")).join("\n");
  assert.doesNotMatch(all, /MOE|Moe(?![A-Za-z])/, "公开文档禁用 MOE 字眼");
});

test("workflow 分篇：模板转盘、画布手势与配方模板文案逐字", () => {
  const workflow = read("src/app/docs/workflow/page.tsx");

  assert.match(workflow, /小说影视化/, "缺模板转盘卡面（小说影视化）");
  assert.match(workflow, /实心 = 执行，描边 = 跳过/, "缺环节 chip 操作口径");
  assert.match(workflow, /按住一路拖过去批量开\/关/, "缺环节 chip 批量手势口径");
  assert.match(workflow, /配方模板/, "缺配方模板小节");
  assert.match(workflow, /六槽配方/, "缺六槽配方官方口径");
});

test("history 分篇：复用姿势与余额预检提示逐字", () => {
  const history = read("src/app/docs/history/page.tsx");

  assert.match(history, /再来 N 组/, "缺复用姿势文案");
  assert.match(history, /微调变体/, "缺微调变体文案");
  assert.match(history, /用这套参数继续做图/, "缺整套载入文案");
  assert.match(history, /衍生自任务/, "缺溯源徽章文案");
  assert.match(history, /余额不足，请先充值再重跑/, "缺余额预检提示");
});

test("billing 分篇：充值三步与四档方案、失败退回逐字", () => {
  const billing = read("src/app/docs/billing/page.tsx");

  assert.match(billing, /梦芽/, "缺充值方案文案");
  assert.match(billing, /自定义 · 自由额度/, "缺自定义档文案");
  assert.match(billing, /已完成支付，刷新余额/, "缺支付回流文案");
  assert.match(billing, /每日签到/, "缺签到文案");
  assert.match(billing, /失败自动退回/, "缺失败退回口径");
});

test("mcp 分篇：接入干货保留、作品报告 PDF 死档已清理", () => {
  const mcp = read("src/app/docs/mcp/page.tsx");

  assert.match(mcp, /IMAGE_STUDIO_BIZ_KEY/, "必须保留 MCP 密钥配置");
  assert.match(mcp, /IMAGE_STUDIO_API_BASE/, "必须保留 MCP API base 配置");
  assert.match(mcp, /generate_image/, "必须列出图像工具");
  assert.match(mcp, /generate_video/, "必须列出视频工具");
  assert.match(mcp, /npm run build/, "必须保留构建步骤");
  // 2026-10-06 5e46b701：作品报告 PDF（public/docs/eimu-competition-report.pdf）
  // 与 mcp 页的链接一并刻意删除（该 commit 的目标是让分支与生产实况一致），
  // 故断言改为「不得回链死档」＋「保留页尾现有对外入口」。
  assert.doesNotMatch(
    mcp,
    /\/docs\/eimu-competition-report\.pdf/,
    "作品报告 PDF 已删除，页面不得再链死档",
  );
  assert.match(mcp, /https:\/\/github\.com\/deepseek-ai\/deepseek-harness/, "必须保留 GitHub 入口");
  assert.match(mcp, /href="\/status"/, "必须保留状态页入口");
});

test("api 分篇：客户端动态渲染与认证口径齐全（metadata 由服务端 page 导出）", () => {
  const apiPage = read("src/app/docs/api/page.tsx");
  const appendix = read("src/app/docs/api/DevAppendix.tsx");
  const api = apiPage + appendix;

  // Next.js 限制：metadata 导出只支持 Server Component——
  // page.tsx 保持服务端并 export metadata，动态端点目录移入 DevAppendix.tsx（"use client" 仍在本分篇）。
  assert.match(appendix, /"use client"/, "端点目录靠客户端 fetch 动态渲染，use client 必须在本分篇");
  assert.doesNotMatch(apiPage, /"use client"/, "api page 必须是服务端组件才能 export metadata");
  assert.match(apiPage, /export const metadata/, "api 分篇 metadata 由服务端 page 导出");

  assert.match(api, /fetch\("\/api\/v1\/openapi\.json"\)/, "必须 fetch 真实 openapi spec");
  assert.match(api, /sk-biz-/, "必须说明 B 端密钥认证");
  assert.match(api, /Authorization: Bearer/, "必须给出认证方式");
  assert.match(api, /eimu\.dev\/v1/, "必须给出 base URL");

  // contract-lock：端点路径必须来自运行的 spec，禁止内联手写字面量。
  assert.doesNotMatch(api, /"\/images\/generations"/, "端点路径必须来自 spec，不内联手写");
  assert.doesNotMatch(api, /"\/videos\/generations"/, "端点路径必须来自 spec，不内联手写");
});

test("docs sidebar 七个条目各恰好出现一次并高亮当前篇", () => {
  const sidebar = read("src/app/docs/DocsSidebar.tsx");

  assert.match(sidebar, /BookOpen/, "快速上手入口用 BookOpen 图标");
  assert.match(sidebar, /usePathname/, "sidebar 必须高亮当前篇章");
  assert.match(sidebar, /aria-current/, "当前篇章必须有 aria-current");

  for (const href of ["/docs", ...SUBPAGES]) {
    const matches = sidebar.match(new RegExp(`href: "${href}"`, "g")) ?? [];
    assert.equal(matches.length, 1, `sidebar ${href} 应恰好出现一次，实际 ${matches.length} 次`);
  }
});

test("docs layout carries shared shell and per-chapter metadata", () => {
  const layout = read("src/app/docs/layout.tsx");
  assert.match(layout, /DocsSidebar/, "docs 必须共享 sidebar layout");
  assert.match(layout, /page-shell/, "docs 内容必须走站内统一 gutter");
  assert.match(layout, /metadata/, "layout 必须导出 metadata");
  assert.doesNotMatch(layout, /CDK|兑换/, "CDK 兑换旧文案已移除");
});

test("分篇路由全部存在（hub＋六篇）", () => {
  for (const rel of [
    "src/app/docs/page.tsx",
    "src/app/docs/assistant/page.tsx",
    "src/app/docs/workflow/page.tsx",
    "src/app/docs/history/page.tsx",
    "src/app/docs/billing/page.tsx",
    "src/app/docs/mcp/page.tsx",
    "src/app/docs/api/page.tsx",
  ]) {
    assert.equal(existsSync(join(process.cwd(), rel)), true, `${rel} 分篇路由必须存在`);
  }
});
