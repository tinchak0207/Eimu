import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const profileDir = process.env.FIREFLY_PROFILE_DIR ?? join(homedir(), ".aicoach-firefly-relay");
const browserPath = process.env.FIREFLY_BROWSER_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PROMPT_MODE = process.argv.includes("--prompt");
const GENERATE_MODE = process.argv.includes("--generate");
const context = await chromium.launchPersistentContext(profileDir, {
  executablePath: browserPath,
  headless: true,
  viewport: { width: 1440, height: 1024 },
});
const page = context.pages()[0] ?? await context.newPage();
await page.goto("https://gemini.google.com/app", { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.waitForTimeout(8_000);
const picker = page.getByLabel("Open mode picker, currently Flash");
if (await picker.isVisible().catch(() => false)) {
  await picker.click();
  await page.waitForTimeout(500);
}
if (PROMPT_MODE || GENERATE_MODE) {
  await page.keyboard.press("Escape");
  const input = page.getByRole("textbox", { name: "Enter a prompt for Gemini" });
  await input.fill("Generate an image of a white ceramic cup on a pale blue studio background.");
  await page.waitForTimeout(300);
  if (GENERATE_MODE) {
    const before = await page.locator("img").evaluateAll((images) => images
      .filter((image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth >= 256 && image.naturalHeight >= 256)
      .map((image) => image.currentSrc || image.src),
    );
    await page.getByLabel("Send message").click();
    await page.waitForFunction((known) => Array.from(document.images).some((image) =>
      image.complete && image.naturalWidth >= 256 && image.naturalHeight >= 256 && !known.includes(image.currentSrc || image.src)
    ), before, { timeout: 180_000 });
  }
}
const screenshotPath = join(process.env.TEMP ?? ".", "gemini-relay-inspect.png");
await page.screenshot({ path: screenshotPath, fullPage: true });
const controls = await page.locator("input, textarea, [contenteditable=true], button, [role=button]").evaluateAll((elements) =>
  elements
    .filter((element) => element instanceof HTMLElement && element.offsetParent)
    .slice(0, 160)
    .map((element) => ({
      tag: element.tagName,
      text: (element.textContent ?? "").replace(/[\s\u200b]+/g, " ").trim().slice(0, 160),
      ariaLabel: element.getAttribute("aria-label"),
      placeholder: element.getAttribute("placeholder"),
      role: element.getAttribute("role"),
    })),
);
console.log(JSON.stringify({ url: page.url(), title: await page.title(), screenshotPath, promptMode: PROMPT_MODE, generateMode: GENERATE_MODE, controls }, null, 2));
await context.close();
