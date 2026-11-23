import { chromium } from "/home/lenovo/Documents/image-app/node_modules/playwright/index.mjs";
const URL = "http://localhost:3999/zz-tmp-beast-settings";
const OUT = "/home/lenovo/Documents/image-app/docs/evidence/beast-settings-fix-20261031";
const browser = await chromium.launch();
async function ctx(initLocal, server, flags) {
  const c = await browser.newContext({ viewport: { width: 520, height: 560 }, deviceScaleFactor: 2 });
  if (initLocal) await c.addInitScript((kv) => { if (!sessionStorage.getItem("seeded")) { for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v); sessionStorage.setItem("seeded", "1"); } }, initLocal);
  const posts = [];
  await c.route("**/api/agent/settings", async (route) => {
    const req = route.request();
    if (req.method() === "GET") {
      if (flags.getFail) return route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: { message: "gateway down" } }) });
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(server) });
    }
    const body = JSON.parse(req.postData() || "{}");
    posts.push(body);
    if (flags.postFail) return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { message: "boom" } }) });
    Object.assign(server, body); // 模拟修复后网关：部分合并
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(server) });
  });
  const p = await c.newPage();
  p.on("console", (m) => { if (m.type() === "error") console.log("  console.error:", m.text().slice(0, 160)); });
  await p.goto(URL); await p.waitForTimeout(1500);
  return { c, p, posts };
}
const thinkBtn = (p) => p.locator('button[aria-haspopup="listbox"]');
const medium = { interrupt_mode: "queue", persona: "efficient", cost_mode: "balanced", interaction_mode: "preset", beast_mode: false, hide_reasoning: false };

// A: GET 失败
{
  const flags = { getFail: true }; const server = { ...medium };
  const { c, p, posts } = await ctx(null, server, flags);
  await p.getByLabel("助理设定").click(); await p.waitForTimeout(600);
  console.log("A slider disabled:", await p.getByLabel("互动模式").isDisabled(), "| 失败文案:", await p.getByText("设置读取失败，暂不能修改").count());
  await p.screenshot({ path: `${OUT}/01-popover-get-failed.png` });
  await p.keyboard.press("Escape"); await p.mouse.click(5, 500); await p.waitForTimeout(300);
  await thinkBtn(p).click(); await p.waitForTimeout(600);
  console.log("A menu notice:", await p.locator('[role="status"]').allTextContents(), "posts:", posts.length);
  await p.screenshot({ path: `${OUT}/02-thinking-menu-get-failed.png` });
  // 重试成功
  flags.getFail = false; await p.getByRole("button", { name: "重试" }).first().click(); await p.waitForTimeout(800);
  console.log("A after retry notice:", await p.locator('[role="status"]').count(), "label:", await thinkBtn(p).getAttribute("aria-label"));
  await p.screenshot({ path: `${OUT}/03-thinking-menu-retry-ok.png` });
  await c.close();
}
// B: 保存单字段（互动模式）
{
  const flags = {}; const server = { ...medium, persona: "thoughtful", cost_mode: "premium", beast_mode: true };
  const { c, p, posts } = await ctx(null, server, flags);
  await p.getByLabel("助理设定").click(); await p.waitForTimeout(800);
  const s = p.getByLabel("互动模式");
  console.log("B slider disabled:", await s.isDisabled());
  await s.focus(); await p.keyboard.press("ArrowRight"); await p.waitForTimeout(800);
  console.log("B POST bodies:", JSON.stringify(posts), "| server after:", JSON.stringify(server));
  await p.screenshot({ path: `${OUT}/04-popover-single-field-saved.png` });
  await c.close();
}
// C: 本地极限 / 服务端中
{
  const flags = {}; const server = { ...medium };
  const { c, p, posts } = await ctx({ "agent-thinking-level-v1": "extreme" }, server, flags);
  console.log("C label (collapsed):", await thinkBtn(p).getAttribute("aria-label"));
  await p.screenshot({ path: `${OUT}/05-local-extreme-server-medium-collapsed.png` });
  await thinkBtn(p).click(); await p.waitForTimeout(700);
  console.log("C notice:", await p.locator('[role="status"]').allTextContents(), "local:", await p.evaluate(() => localStorage.getItem("agent-thinking-level-v1")), "posts:", posts.length);
  await p.screenshot({ path: `${OUT}/06-local-extreme-server-medium-notice.png` });
  // 用户重选极限 → POST 一次 patch
  await p.getByRole("option", { name: /极限/ }).first().click().catch(async () => { await p.getByText("极限", { exact: true }).first().click(); });
  await p.waitForTimeout(800);
  console.log("C repick POST:", JSON.stringify(posts), "server beast:", server.beast_mode, "label:", await thinkBtn(p).getAttribute("aria-label"));
  await c.close();
}
// D: POST 失败回滚
{
  const flags = { postFail: true }; const server = { ...medium };
  const { c, p, posts } = await ctx(null, server, flags);
  await thinkBtn(p).click(); await p.waitForTimeout(600);
  await p.getByText("高", { exact: true }).first().click(); await p.waitForTimeout(900);
  console.log("D notice:", await p.locator('[role="status"]').allTextContents(), "label:", await thinkBtn(p).getAttribute("aria-label"), "local:", await p.evaluate(() => localStorage.getItem("agent-thinking-level-v1")), "posts:", JSON.stringify(posts));
  await p.screenshot({ path: `${OUT}/07-thinking-save-failed-rollback.png` });
  await p.keyboard.press("Escape"); await p.mouse.click(5, 500); await p.waitForTimeout(300);
  await p.getByLabel("助理设定").click(); await p.waitForTimeout(700);
  await p.getByLabel("互动模式").focus(); await p.keyboard.press("ArrowRight"); await p.waitForTimeout(900);
  console.log("D popover saveError:", await p.getByText("保存失败，未生效").count(), "valuetext:", await p.getByLabel("互动模式").getAttribute("aria-valuetext"), "cache:", await p.evaluate(() => localStorage.getItem("agent-settings-v1")));
  await p.screenshot({ path: `${OUT}/08-popover-save-failed-rollback.png` });
  await c.close();
}
await browser.close();
