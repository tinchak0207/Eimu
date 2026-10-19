// desktop/scripts/e2e/final-a-browser.mjs
//
// 最终验收代理 A —— 设计意图 9：非桌面浏览器（无 window.eimuLocal）渐进增强。
//
// 用一般 Playwright Chromium（**无** Electron preload / window.eimuLocal）打生产
// https://eimu.dev。为取得已登入上下文，仅在**记忆体内**把真桌面壳 localStorage 的
// napi_token / napi_user 复制进本 Chromium context；**绝不**写入 log/档案/报告。
//
// 判准（任务口径，非旧 A25）：可用、零 console error、不上传原档；浏览器也走
// 「本机 canvas 抽帧 → 只上传衍生档」是**刻意设计**，不是 bug。
//
// 用法：node desktop/scripts/e2e/final-a-browser.mjs --out /tmp/final-a-bf-XXX --assets /tmp/bug1-e2e/assets

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { launchShell } from "./harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REAL_PROFILE = path.join(os.homedir(), ".config", "Eimu");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const out = { out: null, assets: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") out.out = argv[++i];
    else if (a === "--assets") out.assets = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv);
const outDir = args.out || path.join("/tmp", `final-a-bf-${Date.now()}`);
const assetsDir = args.assets || "/tmp/bug1-e2e/assets";
fs.mkdirSync(outDir, { recursive: true });
const goodA = path.join(assetsDir, "good-a.mp4");
const sizeOf = (p) => fs.statSync(p).size;
const log = (...a) => console.log(...a);

function attachNet(page) {
  const list = [];
  const byReq = new Map();
  page.on("request", (req) => {
    const e = { ts: Date.now(), method: req.method(), url: req.url(), status: null, failed: false, parts: null, responseJson: null };
    try {
      const buf = req.postDataBuffer ? req.postDataBuffer() : null;
      if (buf && buf.length) {
        const s = buf.toString("latin1");
        const files = [...s.matchAll(/filename="([^"]*)"/g)].map((m) => m[1]);
        const names = [...s.matchAll(/name="([^"]+)"/g)].map((m) => m[1]);
        e.parts = files.length ? files : names;
      }
    } catch { /* ignore */ }
    byReq.set(req, e);
    if (/attachments|video-upload|uploads-ticket/.test(req.url())) list.push(e);
  });
  page.on("requestfinished", async (req) => {
    const e = byReq.get(req);
    if (!e) return;
    try {
      const r = await req.response();
      e.status = r ? r.status() : null;
      if (r && /attachments|video-upload/.test(e.url)) {
        const t = await r.text();
        try { e.responseJson = JSON.parse(t); } catch { /* not json */ }
      }
    } catch { /* ignore */ }
  });
  page.on("requestfailed", (req) => {
    const e = byReq.get(req);
    if (e) { e.failed = true; e.failure = (req.failure() && req.failure().errorText) || "unknown"; }
  });
  return { list: () => list.slice() };
}

const FILE_SEL = 'input[type="file"]';
async function attachFiles(page, files) {
  const list = Array.isArray(files) ? files : [files];
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable");
  const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: FILE_SEL });
  if (!nodeId) throw new Error("file input nodeId 为空");
  await cdp.send("DOM.setFileInputFiles", { files: list, nodeId });
}

async function probeComposer(page) {
  return await page.evaluate(() => {
    const chips = [...document.querySelectorAll('[aria-label^="移除 "]')].map((btn) => {
      const el = btn.closest("span");
      const cls = (el && el.className) || "";
      const txt = (el && el.innerText) || "";
      return { text: txt.trim(), spinning: !!(el && el.querySelector(".animate-spin")), isError: cls.includes("destructive"), extracting: txt.includes("抽帧") };
    });
    const inputs = [...document.querySelectorAll("#agent-composer-input")];
    const ta = inputs.find((i) => i.offsetParent !== null) || inputs[0] || null;
    return {
      url: location.href,
      eimuLocal: typeof window.eimuLocal,
      eimuShell: typeof window.eimuShell,
      hasComposer: !!ta && ta.offsetParent !== null,
      composerCount: inputs.length,
      chipCount: chips.length, chips,
      uploadingChips: chips.filter((c) => c.spinning || c.extracting).length,
      errorChips: chips.filter((c) => c.isError).length,
      frameCount: [...document.querySelectorAll('img[alt^="第 "]')].length,
      videoPreviews: [...document.querySelectorAll('video[aria-label^="原片："]')].map((v) => v.getAttribute("aria-label")),
    };
  });
}

async function waitChipsSettledSafe(page, timeout) {
  try {
    await page.waitForFunction(() => {
      const chips = [...document.querySelectorAll('[aria-label^="移除 "]')].map((b) => b.closest("span"));
      if (!chips.length) return false;
      return chips.every((el) => el && !el.querySelector(".animate-spin") && !(el.innerText || "").includes("抽帧"));
    }, undefined, { timeout });
    return true;
  } catch { return false; }
}

async function main() {
  log(`最终验收 A · 设计意图 9（一般 Chromium，无 eimuLocal）`);
  log(`out=${outDir} good-a=${sizeOf(goodA)}B`);

  // ── 取已登入 localStorage（仅记忆体）；启动失败重试 ≤3（GPU/资源偶发） ──
  let authJson = null;
  for (let attempt = 1; attempt <= 3 && !authJson; attempt++) {
    try {
      const shell = await launchShell({ outDir: path.join(outDir, `auth-shell-${attempt}`), seedProfileFrom: REAL_PROFILE });
      try {
        await shell.page.waitForLoadState("domcontentloaded").catch(() => {});
        await sleep(2500);
        authJson = await shell.evaluate(() => JSON.stringify({
          t: localStorage.getItem("napi_token") || "",
          u: localStorage.getItem("napi_user") || "",
        }));
      } finally { await shell.close().catch(() => {}); }
    } catch (e) { log(`取 auth 第 ${attempt} 次失败：${e && e.message}`); await sleep(3000); }
  }
  let hasAuth = false;
  try { const p = authJson && JSON.parse(authJson); hasAuth = Boolean(p && p.t) && Boolean(p.u); } catch { hasAuth = false; }
  log(`auth available=${hasAuth}`);

  const CHROME = path.join(os.homedir(), ".cache", "ms-playwright", "chromium-1223", "chrome-linux64", "chrome");
  const browser = await chromium.launch({
    headless: true,
    executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });

  const initScript = (payload) => {
    try {
      localStorage.setItem("eimu-promo-seen-v1", "1");
      if (payload) {
        const a = JSON.parse(payload);
        if (a.t) localStorage.setItem("napi_token", a.t);
        if (a.u) localStorage.setItem("napi_user", a.u);
      }
    } catch { /* ignore */ }
  };

  const result = { status: "fail" };
  const consoleErrors = [];
  const pageErrors = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
    if (hasAuth) await ctx.addInitScript(initScript, authJson);
    else await ctx.addInitScript(initScript, null);
    const page = await ctx.newPage();
    const net = attachNet(page);
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
    page.on("pageerror", (e) => pageErrors.push(String(e && e.message)));

    let bootShot = null, uploadShot = null, boot = null, after = null, uploadErr = null, settled = null;
    try {
      await page.goto("https://eimu.dev/", { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForSelector("#agent-composer-input", { state: "visible", timeout: 40000 }).catch(() => {});
      await sleep(2600);
      boot = await probeComposer(page);
      bootShot = path.join(outDir, "BF9-boot.png");
      await page.screenshot({ path: bootShot });

      const t0 = net.list().length;
      if (boot.hasComposer) {
        try {
          await attachFiles(page, goodA);
          settled = await waitChipsSettledSafe(page, 180000);
          await sleep(1000);
        } catch (e) { uploadErr = String(e && e.message); }
        after = await probeComposer(page);
        uploadShot = path.join(outDir, "BF9-after-upload.png");
        await page.screenshot({ path: uploadShot }).catch(() => {});
      }
      const since = net.list().slice(t0);
      const att = since.filter((e) => e.method === "POST" && /\/attachments$/.test(e.url));
      const vid = since.filter((e) => e.method === "POST" && /video-upload/.test(e.url));
      const derivedNames = att.flatMap((e) => {
        const arr = e.responseJson && Array.isArray(e.responseJson.attachments) ? e.responseJson.attachments : null;
        return arr ? arr.map((a) => a.name) : (e.parts || []);
      });
      const derivedSeen = derivedNames.some((n) => /-(keyframe-\d+\.jpg|poster\.jpg|probe\.json)$/.test(n));
      const originalInAnyParts = since.flatMap((e) => e.parts || []).some((p) => p === "good-a.mp4");
      const noExceptions = consoleErrors.length === 0 && pageErrors.length === 0;
      const eimuLocalUndefined = boot.eimuLocal === "undefined" && boot.eimuShell === "undefined";
      const originalNotUploaded = !originalInAnyParts && vid.length === 0;
      const usable = !!after && after.chipCount >= 1 && after.uploadingChips === 0 && after.errorChips === 0;
      const pass = eimuLocalUndefined && noExceptions && usable && derivedSeen && originalNotUploaded;
      result.status = pass ? "pass" : "fail";
      result.intent = "非桌面浏览器（无 window.eimuLocal）→ 渐进增强：本机 canvas 抽帧可用、零 console error、不上传原档";
      result.observations = {
        eimuLocalType: boot.eimuLocal, eimuShellType: boot.eimuShell, authUsed: hasAuth,
        composerPresent: boot.hasComposer, uploadError: uploadErr, settled,
        chips: after ? after.chips : null, chipCount: after ? after.chipCount : null,
        uploadingChips: after ? after.uploadingChips : null, errorChips: after ? after.errorChips : null,
        frameCount: after ? after.frameCount : null, videoPreviews: after ? after.videoPreviews : null,
        attachmentsRequests: att.length, attachmentURLs: att.map((e) => e.url),
        derivedNames, derivedSeen, videoUploadRequests: vid.length,
        originalInAnyParts, originalNotUploaded,
        consoleErrors, pageErrors,
        note: "浏览器走『本机 canvas 抽帧→只上传衍生档』符合任务口径（刻意设计，非 bug）",
      };
      result.networkEvidence = since.map((e) => ({ method: e.method, url: e.url, status: e.status, parts: e.parts, responseJson: e.responseJson }));
      result.artifacts = { boot: bootShot, afterUpload: uploadShot };
      result.error = pass ? undefined : "判准未达（见 observations）";
    } finally {
      await ctx.close().catch(() => {});
    }
  } finally {
    await browser.close().catch(() => {});
  }

  fs.writeFileSync(path.join(outDir, "BF9.json"), JSON.stringify(result, null, 2));
  log(`▶ BF9: ${result.status}${result.error ? " :: " + result.error : ""}`);
  log(`messages=0 · 结果目录：${outDir}`);
}

main().catch((e) => { console.error("fatal:", (e && e.stack) || e); process.exit(2); });