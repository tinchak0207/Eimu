import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function read(relPath: string) {
  return readFileSync(join(process.cwd(), relPath), "utf8");
}

test("admin page requires a dedicated admin session", () => {
  const page = read("src/app/admin/page.tsx");
  const auth = read("src/lib/admin-auth.ts");

  assert.match(page, /getAdminSession/);
  assert.match(page, /AdminLogin/);
  assert.match(page, /AdminPoolManager/);
  assert.match(auth, /httpOnly:\s*true/);
  assert.match(auth, /sameSite:\s*"strict"/);
});

test("admin shell is a sidebar layout with the dashboard as the default view", () => {
  const shell = read("src/components/admin/AdminPoolManager.tsx");

  assert.match(shell, /总览/);
  assert.match(shell, /AdminHome/);
  assert.match(shell, /中转渠道/);
  assert.match(shell, /AdminRelayChannels/);
  assert.match(shell, /B 端密钥/);
  assert.match(shell, /AdminBizKeys/);
  assert.match(shell, /路由调度/);
  assert.match(shell, /AdminRoutingPanel/);
  assert.doesNotMatch(shell, /AdminAccountPool/);
  assert.doesNotMatch(shell, /AdminAdobe2ApiImport/);
  assert.doesNotMatch(shell, /AdminConsoleLinks/);
});

test("relay channel panel keeps the legacy pool CRUD and env channel list", () => {
  const source = read("src/components/admin/AdminRelayChannels.tsx") + read("src/app/api/admin/pools/[id]/test/route.ts");

  assert.match(source, /中转渠道/);
  assert.match(source, /中转 API/);
  assert.match(source, /Base URL/);
  assert.match(source, /API Key/);
  assert.match(source, /支持模型/);
  assert.match(source, /supportedModels/);
  assert.match(source, /\.env 渠道/);
  assert.match(source, /优先级/);
  assert.match(source, /渠道未返回已声明模型/);
  assert.match(source, /测试连接/);
  assert.match(source, /新增渠道/);
  assert.match(source, /maskedApiKey/);
  assert.doesNotMatch(source, /dangerouslySetInnerHTML/);
});

test("admin home dashboard renders the routing treemap on landing", () => {
  const home = read("src/components/admin/AdminHome.tsx");
  const treemap = read("src/components/admin/RoutingTreemap.tsx");
  const squarify = read("src/lib/treemap.ts");

  assert.match(home, /RoutingTreemap/);
  assert.match(home, /结果分布/);
  assert.match(home, /渠道尝试排行/);
  assert.match(home, /modelBreakdown/);
  assert.match(treemap, /squarify/);
  assert.match(treemap, /resolution/);
  assert.match(squarify, /export function squarify/);
});

/**
 * 與 src/app/api/generate-images/route.test.ts 的 readCode 相同：負向斷言只能跑在
 * 去註解後的程式碼上，否則解釋舊 bug 的註解會誤觸守衛；(^|[^:]) 保住 URL 裡的 //。
 */
function readCode(relPath: string) {
  return read(relPath)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("routing panel exposes honest scheduling truth on a fourth admin tab", () => {
  const manager = read("src/components/admin/AdminPoolManager.tsx");
  const panel = read("src/components/admin/AdminRoutingPanel.tsx");

  assert.match(manager, /路由调度/);
  assert.match(manager, /AdminRoutingPanel/);
  assert.match(panel, /路由调度/);
  assert.match(panel, /环境真相/);
  assert.match(panel, /静态顺序/);
  assert.match(panel, /已覆写/);
  assert.match(panel, /本实例冷却中/);
  assert.match(panel, /计费网关兼职生图/);
  assert.match(panel, /ENABLE_MOCK_MODE 开启中：生产当前返回假图，不走任何渠道/);
  assert.match(panel, /expectedVersion/);
  assert.match(panel, /409/);
  assert.match(panel, /配置已被其他会话修改，已刷新/);
  assert.match(panel, /样本窗口/);
  assert.match(panel, /暂无路由事件（部署本版本后产生的生成请求才会记录）/);
  assert.match(panel, /仍需改环境变量并重新部署的操作/);
});

test("routing panel never touches upstream credentials", () => {
  const panelCode = readCode("src/components/admin/AdminRoutingPanel.tsx");

  assert.doesNotMatch(panelCode, /apiKey/);
  assert.doesNotMatch(panelCode, /dangerouslySetInnerHTML/);
});
