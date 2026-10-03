// desktop/scripts/e2e/harness.mjs
//
// Eimu 真桌面殼 E2E 測試台。
//
// 目的：可程式化啟動「真的 Electron 殼」（打包後的 eimu-desktop，或 source 樹的
// electron），用 CDP（playwright-core.chromium.connectOverCDP）接管頁面，
// 截圖、等待、點擊、在頁面內發 fetch、記錄網路請求。
//
// 設計事實（沿用記憶 2026-10-04-built-artifact-vs-tree-drift）：
//   - playwright-core **沒有** top-level connectOverCDP，必須 chromium.connectOverCDP(url)，
//     且不可把方法抽成變數呼叫（會丟 this）。
//   - 啟動參數：--remote-debugging-port=<free> --ozone-platform=x11
//     --user-data-dir=<tmp> --no-sandbox --disable-gpu（＋暫存 HOME）。
//   - 殺程序用 process group（spawn detached，kill(-pid)），避免 pkill -f 匹配 bash 自殺。
//
// 本檔可直接執行做 smoke（見檔尾 main()）。

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_BINARY = path.resolve(
  __dirname,
  "..",
  "..",
  "dist-e2e",
  "linux-unpacked",
  "eimu-desktop",
);
export const DEFAULT_ORIGIN = "https://www.eimu.dev";
export const EIMU_LOCAL_METHODS = [
  "capabilities",
  "pickFiles",
  "probe",
  "extractFrames",
  "transcode",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

export function timestampTag() {
  return new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
}

async function waitForCdp(port, timeoutMs) {
  const url = `http://127.0.0.1:${port}/json/version`;
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch (err) {
      lastErr = err;
    }
    await sleep(200);
  }
  throw new Error(
    `CDP endpoint 未就緒：${url}（${timeoutMs}ms）；last=${lastErr && lastErr.message}`,
  );
}

/**
 * 啟動真殼並回傳控制代碼。
 *
 * opts:
 *   origin            設定 EIMU_APP_ORIGIN（未設＝生產 www.eimu.dev）
 *   binary            打包後的 eimu-desktop（預設 dist-e2e/linux-unpacked）
 *   electronBinary    改走 source 樹：electron 執行檔 + appDir
 *   appDir            傳給 electronBinary 的 app 目錄
 *   homeDir           暫存 HOME（預設 <outDir>/home）
 *   seedProfileFrom   把某 profile 目錄複製到 <homeDir>/.config/Eimu（只讀來源）
 *   userDataDir       預設 <homeDir>/.config/Eimu（由 Electron 自行推導，不強制）
 *   extraEnv          追加環境變數
 *   outDir            預設 /tmp/eimu-e2e-<ts>
 *   deviceScaleFactor 固定截圖 DPR（預設 2）
 *   viewport          固定 {width,height}（預設 1280x800）
 */
export async function launchShell(opts = {}) {
  const outDir =
    opts.outDir || path.join("/tmp", `eimu-e2e-${timestampTag()}-${process.pid}`);
  fs.mkdirSync(outDir, { recursive: true });

  const homeDir = opts.homeDir || path.join(outDir, "home");
  fs.mkdirSync(homeDir, { recursive: true });

  // 只讀複製暴君的真實 profile（紅線：絕不修改 ~/.config/Eimu）。
  if (opts.seedProfileFrom) {
    const dest = path.join(homeDir, ".config", "Eimu");
    if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(opts.seedProfileFrom, dest, { recursive: true });
  }

  const debugPort = opts.debugPort || (await freePort());
  const userDataDir = opts.userDataDir || path.join(homeDir, ".config", "Eimu");
  fs.mkdirSync(userDataDir, { recursive: true });

  const chromiumFlags = [
    `--remote-debugging-port=${debugPort}`,
    "--remote-debugging-address=127.0.0.1",
    "--ozone-platform=x11",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    `--user-data-dir=${userDataDir}`,
  ];

  let execPath;
  let args;
  if (opts.electronBinary) {
    execPath = opts.electronBinary;
    args = [opts.appDir || path.resolve(__dirname, "..", ".."), ...chromiumFlags];
  } else {
    execPath = opts.binary || DEFAULT_BINARY;
    args = [...chromiumFlags];
  }

  const env = {
    ...process.env,
    HOME: homeDir,
    DISPLAY: process.env.DISPLAY || ":1",
    ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
    ...opts.extraEnv,
  };
  if (opts.origin) env.EIMU_APP_ORIGIN = opts.origin;

  const logPath = path.join(outDir, `shell-${path.basename(execPath)}.log`);
  const logStream = fs.createWriteStream(logPath, { flags: "a" });
  logStream.write(`\n=== launch ${new Date().toISOString()} ===\n`);
  logStream.write(`exec=${execPath}\nargs=${args.join(" ")}\n`);
  logStream.write(`origin=${opts.origin || "(default production)"}\n`);

  const child = spawn(execPath, args, {
    env,
    cwd: opts.cwd || path.dirname(execPath),
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);
  child.on("error", (err) => logStream.write(`spawn error: ${err.message}\n`));

  const version = await waitForCdp(debugPort, opts.launchTimeoutMs || 45000);

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);

  // 找主視窗頁面（排除 devtools://）。
  const context = browser.contexts()[0];
  const deadline = Date.now() + (opts.pageTimeoutMs || 30000);
  let page = null;
  while (Date.now() < deadline) {
    const pages = context.pages().filter((p) => {
      const u = p.url();
      return /^https?:/.test(u) && !u.startsWith("devtools://");
    });
    if (opts.origin) {
      const host = new URL(opts.origin).host;
      page = pages.find((p) => {
        try {
          return new URL(p.url()).host === host;
        } catch {
          return false;
        }
      });
    }
    page = page || pages[0] || null;
    if (page) break;
    await sleep(200);
  }
  if (!page) throw new Error("找不到可用的主視窗頁面");

  // 網路記錄（requestfinished 才拿得到 responseBodySize；供「原檔未上傳」類斷言）。
  const net = [];
  const attach = (p) => {
    p.on("requestfinished", async (req) => {
      try {
        const resp = await req.response();
        let responseBodySize = null;
        try {
          const sizes = await req.sizes();
          responseBodySize = sizes.responseBodySize;
        } catch {
          /* 部分請求拿不到大小 */
        }
        net.push({
          ts: Date.now(),
          url: req.url(),
          method: req.method(),
          resourceType: req.resourceType(),
          status: resp ? resp.status() : null,
          responseBodySize,
          failed: false,
        });
      } catch {
        /* ignore */
      }
    });
    p.on("requestfailed", (req) => {
      net.push({
        ts: Date.now(),
        url: req.url(),
        method: req.method(),
        resourceType: req.resourceType(),
        status: null,
        responseBodySize: null,
        failed: true,
        failure: (req.failure() && req.failure().errorText) || "unknown",
      });
    });
    p.on("console", (msg) => {
      if (msg.type() === "error") net.push({ ts: Date.now(), console: "error", text: msg.text() });
    });
  };
  attach(page);
  context.on("page", (p) => attach(p));

  const handle = {
    outDir,
    homeDir,
    userDataDir,
    logPath,
    debugPort,
    cdpVersion: version,
    origin: opts.origin || DEFAULT_ORIGIN,
    pid: child.pid,
    browser,
    context,
    page,
    _cdp: null,

    log(...a) {
      console.log(...a);
    },

    async setFixedViewport(width = 1280, height = 800, dsf = 2) {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: dsf,
        mobile: false,
      });
      handle._cdp = cdp;
      return { width, height, deviceScaleFactor: dsf };
    },

    async clearViewport() {
      if (handle._cdp) {
        try {
          await handle._cdp.send("Emulation.clearDeviceMetricsOverride");
        } catch {
          /* ignore */
        }
      }
    },

    /** 截圖到 outDir/<name>.png；固定 viewport 與 DPR。回傳 {path,size}。 */
    async screenshot(name, { fixed = true, fullPage = false } = {}) {
      if (fixed) {
        await handle.setFixedViewport(
          opts.viewport && opts.viewport.width ? opts.viewport.width : 1280,
          opts.viewport && opts.viewport.height ? opts.viewport.height : 800,
          opts.deviceScaleFactor || 2,
        );
      }
      const file = path.join(outDir, `${name}.png`);
      await page.screenshot({ path: file, fullPage });
      const size = fs.statSync(file).size;
      return { path: file, size };
    },

    /** waitFor(selector) 或 waitFor(predicateFn, arg)。 */
    async waitFor(target, { timeout = 30000, arg } = {}) {
      if (typeof target === "string") {
        return await page.waitForSelector(target, { timeout });
      }
      return await page.waitForFunction(target, arg, { timeout });
    },

    /** 依可見文字點擊（預設找可點元素）。 */
    async clickByText(text, { selector = "button, a, [role=button], summary", timeout = 15000 } = {}) {
      const loc = page.locator(selector, { hasText: text }).first();
      await loc.click({ timeout });
    },

    async evaluate(fn, arg) {
      return await page.evaluate(fn, arg);
    },

    /** 在頁面內對相對路徑發 fetch，回 {status, ok, json, textHead}。 */
    async fetchInPage(pathname, fetchOpts = {}) {
      return await page.evaluate(
        async ({ pathname, fetchOpts }) => {
          const res = await fetch(pathname, fetchOpts);
          let text = "";
          try {
            text = await res.text();
          } catch {
            /* ignore */
          }
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* not json */
          }
          return { status: res.status, ok: res.ok, json, textHead: text.slice(0, 4000) };
        },
        { pathname, fetchOpts },
      );
    },

    networkLog() {
      return net.slice();
    },

    networkSummary() {
      const byHost = {};
      for (const e of net) {
        if (!e.url) continue;
        let host = "?";
        try {
          host = new URL(e.url).host;
        } catch {
          /* ignore */
        }
        byHost[host] = (byHost[host] || 0) + 1;
      }
      const uploads = net.filter(
        (e) => ["POST", "PUT", "PATCH"].includes(e.method) && e.url && !e.console,
      );
      return {
        total: net.filter((e) => e.url).length,
        byHost,
        nonGet: uploads.map((e) => ({ method: e.method, url: e.url, status: e.status, size: e.responseBodySize })),
      };
    },

    async close() {
      try {
        await browser.close();
      } catch {
        /* ignore */
      }
      await stopChild(child);
      logStream.end();
    },
  };

  return handle;
}

export async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
  const deadline = Date.now() + 6000;
  while (child.exitCode === null && Date.now() < deadline) await sleep(150);
  if (child.exitCode === null) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
  }
}

/** 啟動本地 next dev（給 EIMU_APP_ORIGIN=http://localhost:<port> 用）。 */
export function startNextDev({ port, cwd, env = {}, outDir }) {
  const logPath = path.join(outDir, `next-dev-${port}.log`);
  const logStream = fs.createWriteStream(logPath, { flags: "a" });
  const child = spawn("npx", ["--yes", "next", "dev", "-p", String(port)], {
    cwd,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);
  child.on("error", (err) => logStream.write(`spawn error: ${err.message}\n`));
  return { child, logPath, close: async () => { await stopChild(child); logStream.end(); } };
}

export async function waitForHttp(url, { timeout = 180000, interval = 1500 } = {}) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      last = res.status;
      if (res.status < 500) return { ok: true, status: res.status };
    } catch (err) {
      last = err.message;
    }
    await sleep(interval);
  }
  return { ok: false, last };
}

// ---- smoke（可選）：node harness.mjs [--origin URL] [--out DIR] ----
function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) out[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
  }
  return out;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = parseArgs(process.argv);
  const shell = await launchShell({
    origin: args.origin || undefined,
    outDir: args.out || undefined,
    seedProfileFrom: args.seedProfile || undefined,
  });
  try {
    await shell.page.waitForLoadState("domcontentloaded").catch(() => {});
    const probe = await shell.evaluate(() => ({
      url: location.href,
      title: document.title,
      eimuLocalType: typeof window.eimuLocal,
      eimuLocalMethods: window.eimuLocal ? Object.keys(window.eimuLocal) : [],
      eimuShellType: typeof window.eimuShell,
      eimuShellPlatform: window.eimuShell ? window.eimuShell.platform : null,
    }));
    const shot = await shell.screenshot("boot");
    console.log(JSON.stringify({ origin: shell.origin, probe, screenshot: shot, outDir: shell.outDir, logPath: shell.logPath }, null, 2));
  } finally {
    await shell.close();
  }
}
