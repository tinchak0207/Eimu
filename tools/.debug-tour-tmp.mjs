import { chromium } from "playwright-core";
const browser = await chromium.launch({ executablePath: "/home/lenovo/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome", headless: true, args: ["--window-size=1440,900"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript(() => { localStorage.removeItem("atc-tour-v1"); });
await page.goto("http://localhost:3000/?agent=1", { waitUntil: "networkidle", timeout: 60000 });
await page.waitForSelector(".atc-tour-popover", { timeout: 30000 });
console.log("step1 visible");
await page.evaluate(() => {
  window.__probe = [];
  const tick = () => {
    const slabs = [...document.querySelectorAll(".agent-template-carousel .case-slab")];
    const front = slabs.findIndex((s) => s.dataset.front === "true");
    const card0 = slabs[0];
    const m = card0?.style.transform.match(/translate3d\((-?[\d.]+)px/);
    const c = document.querySelector(".tour-fake-cursor");
    const cr = c?.getBoundingClientRect();
    const title = document.querySelector(".atc-tour-popover .driver-popover-title");
    window.__probe.push({
      t: Math.round(performance.now()),
      card0x: m ? Math.round(Number(m[1])) : null,
      frontIdx: front,
      scrollY: Math.round(window.scrollY),
      cursor: cr ? `${Math.round(cr.left)},${Math.round(cr.top)}` : null,
      hold: c ? c.classList.contains("is-holding") : false,
      title: title?.textContent ?? null,
    });
    if (window.__probe.length < 150) setTimeout(tick, 100);
  };
  tick();
});
await page.getByRole("button", { name: "下一步" }).click();
await page.waitForTimeout(15000);
const probe = await page.evaluate(() => window.__probe);
console.log(probe.map((p) => `${p.t} card0x=${p.card0x} front=${p.frontIdx} scrollY=${p.scrollY} cursor=${p.cursor}${p.hold ? " HOLD" : ""} title=${p.title}`).join("\n"));
await browser.close();
