// desktop/scripts/e2e/browser-fallback.mjs
//
// 瀏覽器回落 E2E（A25 漸進增強全回落 / A21 無 File System Access API 回落）。
// 用一般 Playwright Chromium（**無** window.eimuLocal、**無** Electron preload）打生產
// https://eimu.dev。
//
// 紅線遵守：
//   · 只打生產唯讀頁與免費附件端點；不部署/不 SSH/不連 DB/不呼叫付費上游。
//   · 為取得「已登入」的瀏覽器上下文，僅在**記憶體內**把真殼 localStorage 的
//     napi_token / napi_user 複製到本 Chromium context；**絕不**寫入 log/檔案/報告。
//   · 輸出到 /tmp。
//
// 用法：node desktop/scripts/e2e/browser-fallback.mjs --out /tmp/eimu-bf-XXX --assets /tmp/eimu-e2e2-assets [--only A25,A21]

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
  const out = { out: null, assets: null, only: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") out.out = argv[++i];
    else if (a === "--assets") out.assets = argv[++i];
    else if (a === "--only") out.only = (argv[++i] || "").split(",").map((s) => s.trim()).filter(Boolean);
  }
  return out;
}

const args = parseArgs(process.argv);
const outDir = args.out || path.join("/tmp", `eimu-bf-${Date.now()}`);
const assetsDir = args.assets || "/tmp/eimu-e2e2-assets";
fs.mkdirSync(outDir, { recursive: true });
const only = args.only;
const want = (n) => !only || only.includes(n);
const results = [];
const log = (...a) => console.log(...a);
const saveCase = (name, obj) => {
  fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify(obj, null, 2));
  results.push({ ...obj, name });
  log(`▶ ${name}: ${obj.status} ${obj.error || ""}`);
};
const netLine = (e) => ({ method: e.method, url: e.url, status: e.status, failed: e.failed, failure: e.failure, parts: e.parts || null, responseJson: e.responseJson ?? null });

// 記錄網路（只留附件/直傳/票；不外洩響應）
function attachNet(page) {
  const list = [];
  const byReq = new Map();
  page.on("request", (req) => {
    const e = { method: req.method(), url: req.url(), status: null, failed: false, parts: null, responseJson: null };
    try {
      const buf = req.postDataBuffer ? req.postDataBuffer() : null;
      if (buf && buf.length) {
        const s = buf.toString("latin1");
        const files = [...s.matchAll(/filename="([^"]*)"/g)].map((m) => m[1]);
        const names = [...s.matchAll(/name="([^"]+)"/g)].map((m) => m[1]);
        e.parts = files.length ? files : names;
      }
    } catch {
      /* ignore */
    }
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
        try {
          e.responseJson = JSON.parse(t);
        } catch {
          e.responseJson = t.slice(0, 500);
        }
      }
    } catch {
      /* ignore */
    }
  });
  page.on("requestfailed", (req) => {
    const e = byReq.get(req);
    if (e) {
      e.failed = true;
      e.failure = (req.failure() && req.failure().errorText) || "unknown";
    }
  });
  return { list: () => list.slice() };
}

const FILE_SEL = 'input[type="file"][accept*=".mp4"]';
async function attachFiles(page, files) {
  const list = Array.isArray(files) ? files : [files];
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable");
  const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: FILE_SEL });
  if (!nodeId) throw new Error("file input nodeId 為空");
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
    const send = document.querySelector('[aria-label="发送"]');
    return {
      url: location.href,
      eimuLocal: typeof window.eimuLocal,
      hasComposer: !!document.querySelector("#agent-composer-input"),
      sendDisabled: send ? send.disabled : null,
      chipCount: chips.length,
      chips,
      uploadingChips: chips.filter((c) => c.spinning || c.extracting).length,
      errorChips: chips.filter((c) => c.isError).length,
    };
  });
}

async function waitChipsSettledSafe(page, timeout = 180000) {
  try {
    await page.waitForFunction(
      () => {
        const chips = [...document.querySelectorAll('[aria-label^="移除 "]')].map((b) => b.closest("span"));
        if (!chips.length) return false;
        return chips.every((el) => el && !el.querySelector(".animate-spin") && !(el.innerText || "").includes("抽帧"));
      },
      undefined,
      { timeout },
    );
    return true;
  } catch {
    return false;
  }
}

async function main() {
  log(`Eimu 瀏覽器回落 E2E（一般 Chromium，無 eimuLocal）`);
  log(`out=${outDir}`);

  // ── 取已登入 localStorage（僅記憶體，不落盤、不列印） ──
  let authJson = null;
  try {
    const shell = await launchShell({ outDir: path.join(outDir, "auth-shell"), seedProfileFrom: REAL_PROFILE });
    try {
      await shell.page.waitForLoadState("domcontentloaded").catch(() => {});
      await sleep(1500);
      authJson = await shell.evaluate(() =>
        JSON.stringify({
          t: localStorage.getItem("napi_token") || "",
          u: localStorage.getItem("napi_user") || "",
        }),
      );
    } finally {
      await shell.close().catch(() => {});
    }
  } catch (e) {
    log(`取 auth 失敗：${e && e.message}`);
  }
  let hasAuth = false;
  try {
    if (authJson) {
      const p = JSON.parse(authJson);
      hasAuth = Boolean(p.t) && Boolean(p.u);
    }
  } catch {
    hasAuth = false;
  }
  log(`auth available=${hasAuth}`);

  // playwright-core 1.62 期望 chromium rev 1234，但本機只裝了 1223（repo 的 connectOverCDP
  // 不需要本地瀏覽器，故一直沒觸發）。顯式指到已安裝的 chrome 二進位。
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
    } catch {
      /* ignore */
    }
  };

  try {
    // ───────────── A25：漸進增強全回落 ─────────────
    if (want("A25")) {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const consoleErrors = [];
      const pageErrors = [];
      if (hasAuth) await ctx.addInitScript(initScript, authJson);
      else await ctx.addInitScript(initScript, null);
      const page = await ctx.newPage();
      const net = attachNet(page);
      page.on("console", (m) => {
        if (m.type() === "error") consoleErrors.push(m.text());
      });
      page.on("pageerror", (e) => pageErrors.push(String(e && e.message)));

      let shot = null;
      let boot = null;
      try {
        await page.goto("https://eimu.dev/", { waitUntil: "domcontentloaded", timeout: 60000 });
        await page.waitForSelector("#agent-composer-input", { state: "visible", timeout: 40000 }).catch(() => {});
        await sleep(2500);
        boot = await probeComposer(page);
        shot = path.join(outDir, "A25-boot.png");
        await page.screenshot({ path: shot, fullPage: false });

        const t0 = net.list().length;
        let settled = null;
        let after = null;
        let uploadErr = null;
        if (boot.hasComposer) {
          try {
            await attachFiles(page, path.join(assetsDir, "good-a.mp4"));
            settled = await waitChipsSettledSafe(page, 180000);
            await sleep(700);
          } catch (e) {
            uploadErr = String(e && e.message);
          }
          after = await probeComposer(page);
        }
        const since = net.list().slice(t0);
        const attachments = since.filter((e) => e.method === "POST" && /\/attachments$/.test(e.url));
        const videoUpload = since.filter((e) => e.method === "POST" && /video-upload/.test(e.url));
        const derivedParts = attachments.flatMap((e) => {
          const arr = e.responseJson && Array.isArray(e.responseJson.attachments) ? e.responseJson.attachments : null;
          if (arr) return arr.map((a) => a.name);
          return e.parts || [];
        });
        const derivedSeen = derivedParts.some((p) => /-(keyframe-\d+\.jpg|poster\.jpg|probe\.json)$/.test(p));
        const originalSeen = videoUpload.length > 0;
        const uploadShot = path.join(outDir, "A25-after-upload.png");
        await page.screenshot({ path: uploadShot, fullPage: false }).catch(() => {});

        const noExceptions = consoleErrors.length === 0 && pageErrors.length === 0;
        const eimuLocalUndefined = boot.eimuLocal === "undefined";
        // 期望（任務口徑）：走舊行為 → 不出現本機衍生檔。實測為準。
        const fallbackHonored = eimuLocalUndefined && !derivedSeen;
        const pass = eimuLocalUndefined && noExceptions && derivedSeen === false;
        saveCase("A25", {
          status: pass ? "pass" : "fail",
          title: "一般 Chromium（無 window.eimuLocal）打生產：全回落舊行為、無 JS 例外",
          observations: {
            eimuLocalType: boot.eimuLocal,
            composerPresent: boot.hasComposer,
            authUsed: hasAuth,
            uploadError: uploadErr,
            settled,
            finalChips: after ? after.chips : null,
            attachmentsRequests: attachments.length,
            attachmentURLs: attachments.map((e) => e.url),
            derivedParts,
            derivedSeen,
            videoUploadRequests: videoUpload.length,
            videoUploadURLs: videoUpload.map((e) => e.url),
            originalUploadSeen: originalSeen,
            fallbackHonoredExpectedOldBehavior: fallbackHonored,
            consoleErrors,
            pageErrors,
            note: derivedSeen
              ? "生產在一般瀏覽器仍走『本機抽取衍生檔』（W1 未以 window.eimuLocal 閘門）⇒ 與『漸進增強全回落』口徑不符"
              : "未見衍生檔，符合舊行為回落",
            whyComplex: "此路徑（非桌面殼）與殼內共用同一 production bundle；差異只在 preload 注入與否，簡單本地案例不會走這條",
          },
          networkEvidence: { attachments: attachments.map(netLine), videoUpload: videoUpload.map(netLine) },
          artifacts: { screenshot: shot, afterUpload: uploadShot },
          error: pass ? undefined : "A25 判準未達（見 observations：derivedSeen / consoleErrors）",
        });
      } finally {
        await ctx.close().catch(() => {});
      }
    }

    // ───────────── A21：無 File System Access API 回落 ─────────────
    if (want("A21")) {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const consoleErrors = [];
      const pageErrors = [];
      await ctx.addInitScript(() => {
        try {
          localStorage.setItem("eimu-promo-seen-v1", "1");
          // 刪掉 File System Access API，逼 local-save 回 <a download>
          delete globalThis.showSaveFilePicker;
          delete globalThis.showDirectoryPicker;
          Object.defineProperty(globalThis, "showSaveFilePicker", { value: undefined, configurable: true, writable: true });
          Object.defineProperty(globalThis, "showDirectoryPicker", { value: undefined, configurable: true, writable: true });
        } catch {
          /* ignore */
        }
      });
      if (hasAuth) await ctx.addInitScript(initScript, authJson);
      const page = await ctx.newPage();
      page.on("console", (m) => {
        if (m.type() === "error") consoleErrors.push(m.text());
      });
      page.on("pageerror", (e) => pageErrors.push(String(e && e.message)));

      try {
        await page.goto("https://eimu.dev/history", { waitUntil: "domcontentloaded", timeout: 60000 });
        await sleep(4000);
        const apiCheck = await page.evaluate(() => ({
          showSaveFilePicker: typeof globalThis.showSaveFilePicker,
          showDirectoryPicker: typeof globalThis.showDirectoryPicker,
        }));
        // 找下載鈕
        const dl = page.locator('[aria-label="下载"]');
        const dlCount = await dl.count();
        let downloadResult = null;
        let shot = path.join(outDir, "A21-history.png");
        await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
        if (dlCount > 0) {
          try {
            const [download] = await Promise.all([
              page.waitForEvent("download", { timeout: 45000 }),
              dl.first().click({ timeout: 15000 }),
            ]);
            const name = download.suggestedFilename();
            const dlPath = path.join(outDir, `A21-download-${name}`.replace(/[/\\]/g, "_"));
            await download.saveAs(dlPath).catch(() => {});
            downloadResult = {
              fired: true,
              suggestedFilename: name,
              extension: path.extname(name),
              savedBytes: fs.existsSync(dlPath) ? fs.statSync(dlPath).size : null,
            };
          } catch (e) {
            downloadResult = { fired: false, error: String(e && e.message) };
          }
        }
        const noExceptions = consoleErrors.length === 0 && pageErrors.length === 0;
        const fsApiGone = apiCheck.showSaveFilePicker === "undefined" && apiCheck.showDirectoryPicker === "undefined";
        const pass =
          fsApiGone &&
          dlCount > 0 &&
          downloadResult &&
          downloadResult.fired === true &&
          !!downloadResult.extension &&
          downloadResult.extension.length >= 2;
        saveCase("A21", {
          status: pass ? "pass" : "fail",
          title: "刪除 File System Access API 後：下載走 <a download> blob 回退、副檔名正確",
          observations: {
            apiCheck,
            fsApiGone,
            authUsed: hasAuth,
            downloadButtonsFound: dlCount,
            downloadResult,
            consoleErrors,
            pageErrors,
            note:
              dlCount === 0
                ? "歷史頁無可下載卡片（可能未登入或無記錄）→ 無法觸發 local-save 回退，此項未測"
                : downloadResult && downloadResult.fired
                  ? "Playwright download 事件＝<a download>/blob 回退實際觸發"
                  : "已找到下載鈕但未觸發 download 事件（可能 fetch 圖片失敗或走了其他路徑）",
            whyComplex: "FS Access API 有無只在『非桌面殼』或『瀏覽器不支援』時才走回退；殼內與支援的 Chrome 都走 direct-write，測不到回退分支",
          },
          artifacts: { screenshot: shot },
          error: pass ? undefined : "A21 判準未達（見 observations）",
        });
      } finally {
        await ctx.close().catch(() => {});
      }
    }

    const summary = {
      outDir,
      cases: results.map((r) => ({ name: r.name, status: r.status, error: r.error || null })),
      pass: results.filter((r) => r.status === "pass").length,
      fail: results.filter((r) => r.status === "fail").length,
    };
    fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
    log(`\n=== ${summary.pass} pass / ${summary.fail} fail ===`);
    for (const r of results) log(`  [${r.status.toUpperCase()}] ${r.name} ${r.error || ""}`);
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((e) => {
  console.error("fatal:", e && (e.stack || e.message));
  try {
    fs.writeFileSync(path.join(outDir, "fatal.txt"), String((e && (e.stack || e.message)) || e));
  } catch {
    /* ignore */
  }
  process.exit(2);
});
