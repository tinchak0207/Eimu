// 圆环选择器教学第②步假鼠标拖拽演示的轨迹验收（2026-08-27 返工）。
// 旧 bug：假鼠标飞到站0 后在 t≈1050ms 瞬移到右侧空地（x>900）按住拖拽——
// 每步重新解析 frontSelector + driver.js 高亮期间轮播转卡导致目标漂移。
// 本脚本实测断言：holding 轨迹按序覆盖站0→站1→站2、无 x>900 瞬移、
// 演示结束 .tour-fake-cursor 移除、三步走完写入 localStorage atc-tour-v1。
//
// 用法：node tools/verify-tour-cursor.mjs（dev server 需在 localhost:3000 运行）

import { chromium } from "playwright-core";

const EXECUTABLE = "/home/lenovo/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome";
const BASE = "http://localhost:3000";
const failures = [];

const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

const browser = await chromium.launch({
  executablePath: EXECUTABLE,
  headless: true,
  args: ["--window-size=1440,900"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript(() => {
  localStorage.removeItem("atc-tour-v1");
  // headless 无真鼠标，压制 touch 媒介偏好，保证走桌面假鼠标分支。
  Object.defineProperty(window, "matchMedia", {
    value: (q) => ({
      matches: /pointer:\s*coarse/.test(q) ? false : /max-width:\s*767px/.test(q) ? false : false,
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    }),
    configurable: true,
  });
});

page.on("console", (msg) => {
  if (msg.type() === "error") console.log(`[console.error] ${msg.text()}`);
});
page.on("pageerror", (err) => console.log(`[pageerror] ${err.message}`));

await page.goto(`${BASE}/?agent=1`, { waitUntil: "networkidle", timeout: 60000 });

// 等第①步弹层出现（教学自动开播：selector 挂载后 400ms + data-front 就绪轮询）。
const popover = page.locator(".atc-tour-popover");
await popover.first().waitFor({ state: "visible", timeout: 30000 });
console.log("tour step 1 popover visible");

// 读取实际站点 rect（不硬编码坐标）：点「下一步」进第②步后测。
await page.getByRole("button", { name: "下一步" }).click();

// 等第②步弹层（标题「部分选取：按住拖过」）出现且假鼠标入场。
await page.waitForSelector(".tour-fake-cursor", { timeout: 15000 });
console.log("fake cursor appeared (step 2)");

// 立即读站0/1/2 的实际中心（快照发生在 onHighlightStarted，几乎同时刻）。
const stations = await page.evaluate(() => {
  const front = document.querySelector('.agent-template-carousel .case-slab[data-front="true"]');
  const cards = document.querySelectorAll(".agent-template-carousel .case-slab");
  // 以视口中真实可见的 selector 为准：正面卡的那个。
  const sel = front?.querySelector(".atc-step-selector");
  if (!sel) return null;
  return [0, 1, 2].map((i) => {
    const el = sel.querySelector(`[data-step-index="${i}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
});
if (!stations) {
  console.log("FAIL  station rects unresolvable");
  await browser.close();
  process.exit(1);
}
console.log("stations:", JSON.stringify(stations.map((s) => (s ? `${Math.round(s.x)},${Math.round(s.y)}` : "null"))));

// 采样 4.5s（200ms 间隔）：cursor 位置 + is-holding。
const samples = [];
for (let i = 0; i < 23; i += 1) {
  const s = await page.evaluate(() => {
    const cursor = document.querySelector(".tour-fake-cursor");
    if (!cursor) return null;
    const r = cursor.getBoundingClientRect();
    return {
      x: Math.round(r.left),
      y: Math.round(r.top),
      holding: cursor.classList.contains("is-holding"),
    };
  });
  if (s) samples.push(s);
  await page.waitForTimeout(200);
}
console.log(`samples: ${samples.length}`);
const holding = samples.filter((s) => s.holding);
console.log(`holding samples: ${holding.length}`);
console.log("holding trajectory:", holding.map((s) => `${s.x},${s.y}`).join(" "));

// ── 断言 ①：holding 期间 x 轨迹按序覆盖站0→站1→站2（±60px，y±40）──
const cover = (station) =>
  station && holding.some((s) => Math.abs(s.x - station.x) <= 60 && Math.abs(s.y - station.y) <= 40);
const cover0 = cover(stations[0]);
const cover1 = cover(stations[1]);
// 站2 不存在（模板不足三环节）时跳过站2 断言。
const cover2 = !stations[2] || cover(stations[2]);
check("holding covers station 0", cover0, `station0=${Math.round(stations[0].x)},${Math.round(stations[0].y)}`);
check("holding covers station 1", cover1, `station1=${stations[1] ? `${Math.round(stations[1].x)},${Math.round(stations[1].y)}` : "null"}`);
check("holding covers station 2", cover2);

// 按序：站1 的覆盖采样必须晚于站0 的覆盖采样。
const idx0 = holding.findIndex((s) => stations[0] && Math.abs(s.x - stations[0].x) <= 60);
const idx1 = holding.findIndex((s) => stations[1] && Math.abs(s.x - stations[1].x) <= 60);
check("coverage order station0 → station1", idx0 >= 0 && idx1 > idx0, `idx0=${idx0}, idx1=${idx1}`);

// ── 断言 ②：holding 期间不存在 x>900 的采样点（旧 bug 瞬移特征）──
const teleports = holding.filter((s) => s.x > 900);
check("no teleport beyond x>900 while holding", teleports.length === 0,
  teleports.length ? `teleported: ${teleports.map((s) => s.x).join(",")}` : "");

// ── 断言 ③：演示结束 .tour-fake-cursor 被移除（采样后再等缓冲）──
await page.waitForTimeout(2500);
const cursorGone = await page.evaluate(() => !document.querySelector(".tour-fake-cursor"));
check("fake cursor removed after demo", cursorGone);

// ── 断言 ④：轮播锁已解除（atc-tour-locking 移除）──
const lockGone = await page.evaluate(
  () => !document.querySelector(".agent-template-carousel.atc-tour-locking"),
);
check("carousel lock released after demo", lockGone);

// ── 断言 ⑤：教学走完三步并写入 localStorage atc-tour-v1 ──
// 第②步 → 第③步 → 完成。
await page.getByRole("button", { name: "下一步" }).click();
await page.getByRole("button", { name: "完成" }).click();
await page.waitForTimeout(800);
const stored = await page.evaluate(() => localStorage.getItem("atc-tour-v1"));
check("tour completes all 3 steps and writes localStorage atc-tour-v1", stored === "1", `stored=${stored}`);

await browser.close();

console.log("");
if (failures.length) {
  console.log(`RESULT: FAIL (${failures.join(", ")})`);
  process.exit(1);
}
console.log("RESULT: ALL PASS");
