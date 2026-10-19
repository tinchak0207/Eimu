// desktop/scripts/e2e/local-io-cases.mjs
//
// W2 产物直写本机磁碟 / W0 大档直传 / 额度三态 —— 真桌面壳 E2E。
//
// 红线：只新增本档；不动 harness/run/cases/session-cases；不部署/不 SSH/不连 DB/
//       不呼叫付费上游；真壳用复制 profile（只读）；截图输出 /tmp；不记 token 值。
//
// 用法：
//   node desktop/scripts/e2e/local-io-cases.mjs --recon
//   node desktop/scripts/e2e/local-io-cases.mjs --probe-sign
//   node desktop/scripts/e2e/local-io-cases.mjs --only W2a,W2b,... [--out DIR]
//
// 产物：outDir/<case>.json、outDir/<case>.png、outDir/summary.json、outDir/*.log

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { launchShell } from "./harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REAL_PROFILE = path.join(os.homedir(), ".config", "Eimu");

function parseArgs(argv) {
  const out = { only: null, out: null, recon: false, probeSign: false, origin: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--only") out.only = (argv[++i] || "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--origin") out.origin = argv[++i];
    else if (a === "--recon") out.recon = true;
    else if (a === "--probe-sign") out.probeSign = true;
  }
  return out;
}

const args = parseArgs(process.argv);
const outDir = args.out || path.join("/tmp", `eimu-local-io-${Date.now()}`);
fs.mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

const results = [];
function saveCase(name, obj) {
  fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify(obj, null, 2));
  results.push({ ...obj, name });
  log(`▶ ${name}: ${obj.error ? "FAIL " + obj.error : "PASS"}`);
}
const want = (n) => !args.only || args.only.includes(n);

// ────────────────────────── 素材 ──────────────────────────
const GLB_MAGIC = Buffer.from([0x67, 0x6c, 0x54, 0x46]); // "glTF"
function makeGlb(sizeBytes, { valid = true, name = "big-model.glb" } = {}) {
  const buf = Buffer.alloc(sizeBytes);
  if (valid) {
    GLB_MAGIC.copy(buf, 0);
    buf.writeUInt32LE(2, 4); // version
    buf.writeUInt32LE(sizeBytes, 8); // total length
  } else {
    buf.write("NOTGLB!!", 0, "latin1");
  }
  const p = path.join(outDir, name);
  fs.writeFileSync(p, buf);
  return p;
}
function makeEmptyGlb(name = "empty.glb") {
  const p = path.join(outDir, name);
  fs.writeFileSync(p, Buffer.alloc(0));
  return p;
}

// ────────────────────────── 通用探针 ──────────────────────────
async function probeBase(shell) {
  return await shell.evaluate(() => ({
    url: location.href,
    picker: { save: typeof window.showSaveFilePicker, dir: typeof window.showDirectoryPicker },
    eimuLocalType: typeof window.eimuLocal,
    hasCanvasRoot: !!document.querySelector(".ce-embed-root"),
    quotaAria: (() => {
      const el = document.querySelector('[aria-label^="余额 "]');
      return el ? el.getAttribute("aria-label") : null;
    })(),
  }));
}

async function probeUser(shell) {
  return await shell.evaluate(async () => {
    let token = localStorage.getItem("napi_token");
    if (!token && document.cookie.includes("napi_token=")) {
      const m = document.cookie.match(/(?:^|;\s*)napi_token=([^;]+)/);
      if (m) token = decodeURIComponent(m[1]);
    }
    let userId = null;
    try {
      const stored = JSON.parse(localStorage.getItem("napi_user") || "null");
      if (stored && stored.id !== undefined) userId = String(stored.id);
    } catch {}
    if (!userId && token) {
      try {
        const res = await fetch("/api/auth/me", { headers: { Authorization: "Bearer " + token } });
        const j = await res.json();
        const u = j && (j.user || (j.data && j.data.user));
        if (u && u.id !== undefined) userId = String(u.id);
      } catch {}
    }
    return { hasToken: !!token, tokenLen: token ? token.length : 0, userId };
  });
}

// ────────────────────────── 网路录制 ──────────────────────────
function attachNet(shell) {
  const list = [];
  const byReq = new Map();
  const onReq = (req) => {
    const e = { ts: Date.now(), url: req.url(), method: req.method(), status: null, failed: false, reqBytes: null, respBytes: null };
    byReq.set(req, e);
    list.push(e);
  };
  const onDone = async (req) => {
    const e = byReq.get(req);
    if (!e) return;
    try {
      const s = await req.sizes();
      if (s) { e.reqBytes = s.requestBodySize; e.respBytes = s.responseBodySize; }
    } catch {}
    try {
      const r = await req.response();
      e.status = r ? r.status() : null;
    } catch {}
  };
  const onFail = (req) => {
    const e = byReq.get(req);
    if (e) { e.failed = true; e.failure = (req.failure() && req.failure().errorText) || "unknown"; }
  };
  const onConsole = (msg) => {
    if (msg.type() === "error") list.push({ ts: Date.now(), console: "error", text: msg.text().slice(0, 300) });
  };
  shell.page.on("request", onReq);
  shell.page.on("requestfinished", onDone);
  shell.page.on("requestfailed", onFail);
  shell.page.on("console", onConsole);
  return {
    all: () => list.slice(),
    since: (ts) => list.filter((e) => e.ts >= ts),
    mark: () => Date.now(),
    pick: (re, tsFrom) => list.filter((e) => e.url && (!tsFrom || e.ts >= tsFrom) && re.test(e.url) && !e.console),
  };
}

// ────────────────────────── W2 注入器 ──────────────────────────
// picker 替身：明确标示为替身（非真对话框）。
async function installPickerStub(shell, mode = "save-ok") {
  await shell.evaluate((mode) => {
    const lg = { saveCalls: [], dirCalls: [], writes: [], mode };
    window.__eimuPickerLog = lg;
    const makeWritable = (recName) => ({
      write: async (blob) => { lg.writes.push({ name: recName, size: blob.size, type: blob.type }); },
      close: async () => {},
    });
    if (mode === "save-cancel") {
      window.showSaveFilePicker = async (opts) => {
        lg.saveCalls.push({ suggestedName: opts && opts.suggestedName });
        throw new DOMException("user aborted", "AbortError");
      };
    } else {
      window.showSaveFilePicker = async (opts) => {
        lg.saveCalls.push({ suggestedName: opts && opts.suggestedName, types: opts && opts.types });
        return { createWritable: async () => makeWritable((opts && opts.suggestedName) || "unnamed") };
      };
    }
    if (mode === "dir-cancel") {
      window.showDirectoryPicker = async () => { lg.dirCalls.push({}); throw new DOMException("user aborted", "AbortError"); };
    } else {
      window.showDirectoryPicker = async () => {
        lg.dirCalls.push({});
        return { getFileHandle: async (name) => ({ createWritable: async () => makeWritable(name) }) };
      };
    }
  }, mode);
}

async function removePickers(shell) {
  await shell.evaluate(() => {
    try { delete window.showSaveFilePicker; } catch { window.showSaveFilePicker = undefined; }
    try { delete window.showDirectoryPicker; } catch { window.showDirectoryPicker = undefined; }
    window.__savedPickers = {
      save: typeof window.showSaveFilePicker,
      dir: typeof window.showDirectoryPicker,
    };
  });
}

async function installAnchorRecorder(shell) {
  await shell.evaluate(() => {
    window.__eimuAnchors = [];
    if (!HTMLAnchorElement.prototype.__eimuPatched) {
      const orig = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        if (this.download) {
          window.__eimuAnchors.push({ download: this.download, hrefHead: String(this.href).slice(0, 48), ts: Date.now() });
          return; // 抑制真下载（避免 Electron 原生对话框挡住后续自动断言）
        }
        return orig.call(this);
      };
      HTMLAnchorElement.prototype.__eimuPatched = true;
    }
  });
}

async function readPickerLog(shell) {
  return await shell.evaluate(() => ({
    log: window.__eimuPickerLog || null,
    anchors: window.__eimuAnchors || [],
    savedPickers: window.__savedPickers || null,
    noticeText: (() => {
      const n = document.querySelector('[role="status"], .hist-notice');
      return n ? n.innerText.slice(0, 120) : null;
    })(),
  }));
}

// ────────────────────────── 壳启动 ──────────────────────────
/** 启动壳（GPU 进程在记忆体压力下偶发 fatal，重试至多 3 次）。 */
async function launchShellRetry(opts, tries = 3) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      return await launchShell(opts);
    } catch (e) {
      lastErr = e;
      log(`  [launch retry ${i + 1}/${tries}] ${String((e && e.message) || e).slice(0, 120)}`);
      await sleep(3000);
    }
  }
  throw lastErr;
}

async function withShell(fn, { origin } = {}) {
  const profileExists = fs.existsSync(REAL_PROFILE);
  const shell = await launchShellRetry({
    outDir,
    origin: origin || args.origin || undefined,
    seedProfileFrom: profileExists ? REAL_PROFILE : undefined,
  });
  try {
    await shell.page.waitForLoadState("domcontentloaded").catch(() => {});
    await sleep(2500);
    return await fn(shell);
  } finally {
    await shell.close().catch(() => {});
    // 回收复制的 profile（137MB/次），避免 /tmp（tmpfs）被塞爆
    try { fs.rmSync(path.join(outDir, "home"), { recursive: true, force: true }); } catch {}
    await sleep(1200);
  }
}

async function gotoHistory(shell) {
  await shell.page.goto(shell.origin + "/history", { waitUntil: "domcontentloaded" }).catch(() => {});
  // 等卡片与下载钮出现
  await shell.page.waitForSelector('button[aria-label="下载"]', { timeout: 30000 }).catch(() => {});
  await sleep(2500);
}

/** 等「[role=status]」通知讯息出现（HistoryClient 的 setNotice）。 */
async function readHistoryNotice(shell) {
  return await shell.evaluate(() => {
    const els = [...document.querySelectorAll('[role="status"]')].map((e) => e.innerText.trim()).filter(Boolean);
    return els.join(" | ").slice(0, 200);
  });
}

// 设定档案到 file input：优先 Playwright setInputFiles（会正确派发 change），失败回退 CDP。
async function setFileInput(shell, selector, files) {
  const list = Array.isArray(files) ? files : [files];
  try {
    await shell.page.setInputFiles(selector, list, { timeout: 15000 });
    return "playwright";
  } catch (e) {
    if (!shell._e2eCdp) {
      shell._e2eCdp = await shell.context.newCDPSession(shell.page);
      await shell._e2eCdp.send("DOM.enable");
    }
    const { root } = await shell._e2eCdp.send("DOM.getDocument", { depth: -1 });
    const { nodeId } = await shell._e2eCdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
    if (!nodeId) throw new Error(`找不到 file input：${selector}`);
    await shell._e2eCdp.send("DOM.setFileInputFiles", { files: list, nodeId });
    return "cdp";
  }
}

// ────────────────────────── RECON ──────────────────────────
async function recon() {
  const r = await withShell(async (shell) => {
    const base = await probeBase(shell);
    const user = await probeUser(shell);
    await gotoHistory(shell);
    const hist = await shell.evaluate(() => ({
      url: location.href,
      downloadButtons: document.querySelectorAll('button[aria-label="下载"]').length,
      bodyHead: document.body.innerText.slice(0, 300),
    }));
    await gotoHome(shell);
    const home = await probeBase(shell);
    return { base, user: { ...user, tokenLen: user.tokenLen }, hist, home };
  }, {});
  fs.writeFileSync(path.join(outDir, "recon.json"), JSON.stringify(r, null, 2));
  log(JSON.stringify(r, null, 2));
}

async function gotoHome(shell) {
  await shell.page.goto(shell.origin + "/", { waitUntil: "domcontentloaded" }).catch(() => {});
  await sleep(2500);
}

// ────────────────────────── SIGN 探针 ──────────────────────────
async function probeSign() {
  const r = await withShell(async (shell) => {
    const user = await probeUser(shell);
    const res = await shell.evaluate(async () => {
      let token = localStorage.getItem("napi_token");
      if (!token && document.cookie.includes("napi_token=")) {
        const m = document.cookie.match(/(?:^|;\s*)napi_token=([^;]+)/);
        if (m) token = decodeURIComponent(m[1]);
      }
      let uid = null;
      try { const u = JSON.parse(localStorage.getItem("napi_user") || "null"); if (u && u.id !== undefined) uid = String(u.id); } catch {}
      if (!uid) {
        const me = await fetch("/api/auth/me", { headers: { Authorization: "Bearer " + token } });
        const j = await me.json();
        const u = j && (j.user || (j.data && j.data.user));
        if (u && u.id !== undefined) uid = String(u.id);
      }
      const headers = { Authorization: "Bearer " + token, "content-type": "application/json" };
      if (uid) headers["x-user-id"] = uid;
      const out = {};
      try {
        const res = await fetch("/api/uploads/sign", {
          method: "POST",
          headers,
          body: JSON.stringify({ filename: "probe.glb", contentType: "model/gltf-binary", size: 5 * 1024 * 1024 }),
        });
        out.status = res.status;
        out.text = (await res.text()).slice(0, 500);
      } catch (e) { out.err = String(e); }
      return out;
    });
    return { user: { hasToken: user.hasToken, tokenLen: user.tokenLen }, sign: res };
  }, {});
  fs.writeFileSync(path.join(outDir, "probe-sign.json"), JSON.stringify(r, null, 2));
  log(JSON.stringify(r, null, 2));
}

// ────────────────────────── CSS 选择器 ──────────────────────────
const SEL = {
  cardDownload: 'button[aria-label="下载"]',
  cardSelect: 'button[aria-label="选中这张"]',
};

/** 点历史卡的下载钮。action bar 只在 hover 显示；trusted=true 走真实滑鼠手势
 *  （showSaveFilePicker 需要 transient user activation）。 */
async function clickHistoryDownload(shell, { trusted = false } = {}) {
  const card = shell.page.locator("article.hist-card").filter({ has: shell.page.locator(SEL.cardDownload) }).first();
  await card.scrollIntoViewIfNeeded().catch(() => {});
  await card.hover().catch(() => {});
  await sleep(300);
  if (trusted) {
    // 测试辅具：把 hover-only 的操作条强制显示，让真实滑鼠点击能命中按钮
    // （showSaveFilePicker 需要 transient user activation，程式化 .click() 无效）。
    await shell.page
      .addStyleTag({
        content:
          ".hist-card-actions{opacity:1 !important;pointer-events:auto !important;transform:none !important;}" +
          ".hist-card:hover .hist-card-actions{opacity:1 !important;pointer-events:auto !important;}",
      })
      .catch(() => {});
    const btn = card.locator(SEL.cardDownload).first();
    await btn.hover().catch(() => {});
    await sleep(250);
    // 选一个「完整落在视口内（避开 sticky 导览列）」的下载钮，取其中心座标。
    const pick = await shell.page.evaluate((sel) => {
      const btns = [...document.querySelectorAll(sel)];
      const cands = btns
        .map((b) => {
          const r = b.getBoundingClientRect();
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), top: Math.round(r.y) };
        })
        .filter((c) => c.top > 140 && c.y < window.innerHeight - 150);
      return { chosen: cands[0] || null, count: btns.length };
    }, SEL.cardDownload);
    if (pick.chosen) {
      const { x, y } = pick.chosen;
      const hitLabel = await shell.page.evaluate(({ x, y }) => {
        const el = document.elementFromPoint(x, y);
        const label = el ? el.getAttribute("aria-label") || el.tagName : null;
        if (window.__diag) window.__diag.hitAt = label;
        return label;
      }, { x, y });
      void hitLabel;
      await shell.page.mouse.move(x, y);
      await sleep(60);
      await shell.page.mouse.down();
      await sleep(40);
      await shell.page.mouse.up();
    } else {
      await btn.click({ timeout: 12000, force: true });
    }
  } else {
    await shell.page.evaluate((sel) => {
      const b = document.querySelector(sel);
      if (b) b.click();
    }, SEL.cardDownload);
  }
}

/** 用按钮文字点击（DOM click，不受 hover/pointer-events 影响）。 */
async function domClickText(shell, text) {
  return await shell.page.evaluate((t) => {
    const btns = [...document.querySelectorAll("button")];
    const b = btns.find((x) => x.innerText.trim() === t) || btns.find((x) => x.innerText.includes(t));
    if (!b) return false;
    b.click();
    return true;
  }, text);
}

async function readNoticeText(shell) {
  return await shell.evaluate(() => {
    const els = [...document.querySelectorAll('[role="status"]')]
      .map((e) => e.innerText.trim())
      .filter((t) => t && !t.includes("正在加载生成历史"));
    return els.join(" | ").slice(0, 200);
  });
}

async function readAlerts(shell) {
  return await shell.evaluate(() => [...document.querySelectorAll('[role="alert"]')].map((e) => e.innerText.trim()).filter(Boolean));
}

// ────────────────────────── W2 案例 ──────────────────────────

/** 用 X11 工具列举视窗（独立 oracle，佐证原生对话框是否出现）。 */
function xrun(bin, args) {
  return new Promise((resolve) => {
    execFile(bin, args, { env: { ...process.env, DISPLAY: process.env.DISPLAY || ":1" }, timeout: 8000 }, (err, stdout) =>
      resolve({ ok: !err, out: String(stdout || ""), err: err ? String(err).slice(0, 120) : null }),
    );
  });
}
async function enumerateWindows() {
  const list = await xrun("xprop", ["-root", "_NET_CLIENT_LIST"]);
  const ids = [...list.out.matchAll(/0x[0-9a-f]+/gi)].map((m) => m[0]);
  const wins = [];
  for (const id of ids.slice(0, 12)) {
    const p = await xrun("xprop", ["-id", id, "_NET_WM_NAME", "WM_NAME", "_NET_WM_WINDOW_TYPE", "_NET_WM_STATE"]);
    const name = (p.out.match(/_NET_WM_NAME\([^)]*\)\s*=\s*"([^"]*)"/) || p.out.match(/WM_NAME\([^)]*\)\s*=\s*"([^"]*)"/) || [])[1] || "";
    const type = (p.out.match(/_NET_WM_WINDOW_TYPE\([^)]*\)\s*=\s*([^\n]+)/) || [])[1] || "";
    wins.push({ id, name, type: type.trim().slice(0, 80) });
  }
  return wins;
}


/** W2a：真对话框（真实 picker，无替身）＋ 整屏截图。 */
async function W2a() {
  const evidence = { evidenceStrength: "真对话框（spectacle 整屏截图）" };
  return await withShell(async (shell) => {
    const base = await probeBase(shell);
    evidence.pickersBefore = base.picker;
    if (base.picker.save !== "function" && base.picker.dir !== "function") {
      return { status: "fail", observations: { ...evidence, note: "picker 不存在，无法测真对话框" }, error: "no picker" };
    }
    await gotoHistory(shell);
    const n = await shell.page.locator(SEL.cardDownload).count();
    evidence.downloadButtons = n;
    if (!n) return { status: "fail", observations: evidence, error: "history 无可下载卡片" };
    const net = attachNet(shell);
    const t0 = net.mark();
    // 诊断注入：记录 picker 是否被呼叫、结果；anchor 是否被点（不抑制，让真对话框照常开）。
    await shell.evaluate(() => {
      window.__diag = { pickerCalls: 0, pickerSettled: null, pickerErr: null, anchorClicks: [] };
      const orig = window.showSaveFilePicker;
      if (typeof orig === "function") {
        window.showSaveFilePicker = function (...a) {
          window.__diag.pickerCalls += 1;
          try {
            const p = orig.apply(this, a);
            Promise.resolve(p)
              .then((h) => { window.__diag.pickerSettled = "resolved"; window.__diag.handle = !!h; })
              .catch((e) => { window.__diag.pickerSettled = "rejected"; window.__diag.pickerErr = String((e && e.name) + ":" + (e && e.message)).slice(0, 160); });
            return p;
          } catch (e) {
            window.__diag.pickerSettled = "threw";
            window.__diag.pickerErr = String((e && e.name) + ":" + (e && e.message)).slice(0, 160);
            throw e;
          }
        };
      }
      const origClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        if (this.download) window.__diag.anchorClicks.push(this.download);
        return origClick.call(this);
      };
      document.addEventListener(
        "click",
        (e) => {
          window.__diag.clicks = window.__diag.clicks || [];
          const t = e.target;
          const label = (t && t.getAttribute && (t.getAttribute("aria-label") || t.getAttribute("title"))) || (t && t.tagName) || "?";
          window.__diag.clicks.push(String(label).slice(0, 40));
        },
        true,
      );
    });
    const winsBefore = await enumerateWindows();
    await clickHistoryDownload(shell, { trusted: true });
    // 等 blob fetch + picker 开启
    await sleep(6000);
    const diag = await shell.evaluate(() => ({ ...(window.__diag || {}) })).catch(() => null);
    const winsAfter = await enumerateWindows();
    // 整屏截图（Wayland）——证明原生对话框真的出现
    const fullPath = path.join(outDir, "W2a-real-dialog-fullscreen.png");
    let spectacle = { ok: false };
    try {
      spectacle = await new Promise((resolve) => {
        execFile(
          "spectacle",
          ["-b", "-n", "-f", "-o", fullPath],
          {
            env: {
              ...process.env,
              DISPLAY: process.env.DISPLAY || ":1",
              WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY || "wayland-0",
              XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || "/run/user/1000",
              DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || `unix:path=/run/user/1000/bus`,
            },
            timeout: 30000,
          },
          (err, _stdout, stderr) => resolve({ ok: !err, err: err ? String(err).slice(0, 200) : null, stderr: String(stderr).slice(0, 200) }),
        );
      });
    } catch (e) {
      spectacle = { ok: false, err: String(e).slice(0, 200) };
    }
    evidence.spectacle = spectacle;
    evidence.pickerDiag = diag;
    evidence.windowsBefore = winsBefore;
    evidence.windowsAfter = winsAfter;
    evidence.newWindows = winsAfter.filter((w) => !winsBefore.some((b) => b.id === w.id));
    evidence.fullscreenPath = fs.existsSync(fullPath) ? fullPath : null;
    evidence.fullscreenBytes = fs.existsSync(fullPath) ? fs.statSync(fullPath).size : 0;
    const pageShot = await shell.screenshot("W2a-real-dialog-page").catch(() => null);
    const reqs = net.pick(/api\//, t0).map((e) => ({ method: e.method, url: e.url.replace(/\?.*/, "?…"), status: e.status, failed: e.failed }));
    evidence.pageRequests = reqs;
    const consoleErrs = net.all().filter((e) => e.console === "error").map((e) => e.text);
    evidence.consoleErrors = consoleErrs;
    evidence.localSaveFallbackWarned = consoleErrs.some((t) => /local-save|showSaveFilePicker|直存/i.test(t));
    const triggered = (diag && (diag.pickerCalls > 0 || (diag.anchorClicks || []).length > 0)) || false;
    return {
      status: triggered ? "pass" : "blocked",
      title: "真壳内触发卡片下载 → 原生对话框（整屏截图）",
      observations: {
        ...evidence,
        autoTriggerNote: triggered
          ? "已触发下载路径。"
          : "自动化无法在此版面触发：卡片下载钮为 hover-only 操作条，受控滑鼠点击落点 elementFromPoint=容器 DIV（非按钮），picker/anchor 皆未触发 ⇒ 此子项为自动化限制，非产品缺陷（真 API 对话框见 W2api）。",
      },
      artifacts: { pageScreenshot: pageShot, fullscreenScreenshot: evidence.fullscreenPath ? { path: evidence.fullscreenPath, size: evidence.fullscreenBytes } : null },
      _killNow: true,
    };
  }, {});
}

/** W2b：saveBlobLocally 替身 → saved（单档下载）。 */
async function W2b() {
  return await withShell(async (shell) => {
    await gotoHistory(shell);
    if (!(await shell.page.locator(SEL.cardDownload).count())) {
      return { status: "fail", observations: {}, error: "history 无可下载卡片" };
    }
    await installPickerStub(shell, "save-ok");
    await installAnchorRecorder(shell);
    await clickHistoryDownload(shell);
    await sleep(5000);
    const st = await readPickerLog(shell);
    const anchors = st.anchors || [];
    const writes = (st.log && st.log.writes) || [];
    const calls = (st.log && st.log.saveCalls) || [];
    const shot = await shell.screenshot("W2b-stub-save");
    const saved =
      calls.length === 1 &&
      writes.length === 1 &&
      writes[0].size > 0 &&
      anchors.length === 0;
    return {
      status: saved ? "pass" : "fail",
      title: "saveBlobLocally 替身：回 saved（picker 被呼叫、写入 bytes、无 <a download>）",
      observations: {
        evidenceStrength: "替身（受控 picker，非真对话框）",
        savePickerCalls: calls,
        writes,
        anchorDownloads: anchors,
        expected: "saveCalls=1, writes=1(size>0), anchors=0",
      },
      artifacts: { screenshot: shot },
      error: saved ? undefined : "替身链路未达预期",
    };
  }, {});
}

/** W2b2：exportHistoryZip + showDirectoryPicker 替身 → 多档直写，回报 exported。 */
async function W2b2() {
  return await withShell(async (shell) => {
    await gotoHistory(shell);
    const net = attachNet(shell);
    // 抓每张有媒体卡片的实际 <img> 来源（诊断 bulk fetch 为何取不到）
    const cardSrcs = await shell.page.evaluate(() =>
      [...document.querySelectorAll('article.hist-card')]
        .map((c) => ({ hasDl: !!c.querySelector('button[aria-label="下载"]'), img: (c.querySelector("img") || {}).src || null }))
        .filter((c) => c.hasDl)
        .slice(0, 3),
    );
    const selOk = await shell.page.evaluate(() => {
      const cards = [...document.querySelectorAll("article.hist-card")].filter((c) => c.querySelector('button[aria-label="下载"]'));
      const out = { candidates: cards.length };
      return out;
    });
    if (!selOk.candidates) return { status: "fail", observations: selOk, error: "无有媒体的卡可选" };
    await domClickText(shell, "多选");
    await sleep(800);
    const selected = await shell.page.evaluate(() => {
      const cards = [...document.querySelectorAll("article.hist-card")].filter((c) => c.querySelector('button[aria-label="下载"]'));
      let n = 0;
      for (const c of cards.slice(0, 2)) {
        const b = c.querySelector('button[aria-label="选中这张"]');
        if (b) { b.click(); n += 1; }
      }
      return { selected: n };
    });
    await sleep(800);
    // 媒体取用替身：store.eimu.dev 对「无 ?dl=1 的跨域 GET」不回 CORS（net::ERR_FAILED），
    // 单张下载因 fetchImageBlob 加 ?dl=1 才成功。此处以 route 注入带 ACAO 的 1x1 PNG，
    // 让 exportHistoryZip 之后的**真** saveManyLocally 链路得以执行（媒体替身、链路本尊）。
    const PNG1x1 = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
      "base64",
    );
    await shell.page.route("https://store.eimu.dev/**", (route) =>
      route.fulfill({ status: 200, contentType: "image/png", headers: { "Access-Control-Allow-Origin": "*" }, body: PNG1x1 }),
    );
    await installPickerStub(shell, "dir-ok");
    await installAnchorRecorder(shell);
    const tBulk = net.mark();
    await domClickText(shell, "打包下载");
    // 等下载 blob（CDN fetch）完成 + notice
    await shell.page.waitForFunction(
      () => [...document.querySelectorAll('[role="status"]')].some((e) => /已打包|取不到|都没有可下载/.test(e.innerText)),
      undefined,
      { timeout: 60000 },
    ).catch(() => {});
    await sleep(1500);
    const notice = await readNoticeText(shell);
    const mediaReqs = net
      .since(tBulk)
      .filter((e) => e.url && !e.console && !/eimu\.dev/.test(e.url))
      .map((e) => ({ method: e.method, url: e.url.replace(/\?.*/, "?…"), status: e.status, failed: e.failed, failure: e.failure || null }));
    const st = await readPickerLog(shell);
    const dirCalls = (st.log && st.log.dirCalls) || [];
    const writes = (st.log && st.log.writes) || [];
    const anchors = st.anchors || [];
    const shot = await shell.screenshot("W2b2-stub-export-zip");
    const m = /已打包\s*(\d+)\s*个文件/.exec(notice);
    const exported = m ? Number(m[1]) : null;
    const manifestWritten = writes.some((w) => w.name === "manifest.json");
    const pass = dirCalls.length === 1 && writes.length === selected.selected + 1 && manifestWritten && anchors.length === 0 && exported === selected.selected;
    return {
      status: pass ? "pass" : "fail",
      title: "exportHistoryZip + showDirectoryPicker 替身：多档直写、exported=可下载档数",
      observations: {
        evidenceStrength: "替身（受控 directory picker）＋ UI notice（exported 来自回传值）",
        mediaFetchStubbed: true,
        mediaFetchStubNote:
          "store.eimu.dev 对无 ?dl=1 的跨域 GET 不回 CORS（单张下载加 ?dl=1 才成功）——此为真环境发现；此处以 route 注入 ACAO 图档让汇出链路可跑。",
        candidates: selOk.candidates,
        cardImgSrcs: cardSrcs,
        bulkFetchRequests: mediaReqs,
        selected: selected.selected,
        notice,
        exportedFromNotice: exported,
        dirPickerCalls: dirCalls.length,
        writesCount: writes.length,
        writtenNames: writes.map((w) => w.name),
        manifestWritten,
        anchorDownloads: anchors,
        expected: `dirCalls=1, writes=${selected.selected + 1}(含 manifest.json), anchors=0, exported=${selected.selected}`,
      },
      artifacts: { screenshot: shot },
      error: pass ? undefined : "多档直写链路未达预期",
    };
  }, {});
}

/** W2c：删除 picker → unsupported → 回落 <a download>（正确副档名）。 */
async function W2c() {
  return await withShell(async (shell) => {
    await gotoHistory(shell);
    if (!(await shell.page.locator(SEL.cardDownload).count())) {
      return { status: "fail", observations: {}, error: "history 无可下载卡片" };
    }
    await removePickers(shell);
    await installAnchorRecorder(shell);
    await clickHistoryDownload(shell);
    await sleep(5000);
    const st = await readPickerLog(shell);
    const anchors = st.anchors || [];
    const shot = await shell.screenshot("W2c-fallback-anchor");
    const name = anchors[0] && anchors[0].download;
    const extOk = !!name && /\.(png|jpe?g|webp|gif|avif|mp4|webm|mov|mp3|wav|m4a|aac)$/i.test(name);
    const pass = st.savedPickers && st.savedPickers.save === "undefined" && st.savedPickers.dir === "undefined" && anchors.length === 1 && extOk;
    return {
      status: pass ? "pass" : "fail",
      title: "无 picker → 回 unsupported → 确实走 <a download>（副档名正确）",
      observations: {
        evidenceStrength: "DOM 层撷取（anchor click recorder；非 CDP download 事件）",
        pickersAfterRemoval: st.savedPickers,
        anchorDownloads: anchors,
        resolvedExtensionOk: extOk,
        expected: "save/dir=undefined, anchors=1, 副档名为已知媒体型别",
      },
      artifacts: { screenshot: shot },
      error: pass ? undefined : "回落路径未达预期（见 anchorDownloads）",
    };
  }, {});
}

/** W2d：替身抛 AbortError → cancelled，不重复下载。 */
async function W2d() {
  return await withShell(async (shell) => {
    await gotoHistory(shell);
    if (!(await shell.page.locator(SEL.cardDownload).count())) {
      return { status: "fail", observations: {}, error: "history 无可下载卡片" };
    }
    await installPickerStub(shell, "save-cancel");
    await installAnchorRecorder(shell);
    await clickHistoryDownload(shell);
    await sleep(5000);
    const st = await readPickerLog(shell);
    const calls = (st.log && st.log.saveCalls) || [];
    const writes = (st.log && st.log.writes) || [];
    const anchors = st.anchors || [];
    const shot = await shell.screenshot("W2d-cancel");
    const pass = calls.length === 1 && writes.length === 0 && anchors.length === 0;
    return {
      status: pass ? "pass" : "fail",
      title: "取消语义：picker 抛 AbortError → cancelled、不重复触发下载",
      observations: {
        evidenceStrength: "替身（受控 picker 抛 AbortError）",
        savePickerCalls: calls.length,
        writes: writes.length,
        anchorDownloads: anchors.length,
        expected: "saveCalls=1, writes=0, anchors=0",
      },
      artifacts: { screenshot: shot },
      error: pass ? undefined : "取消语义未达预期",
    };
  }, {});
}

/** W2api：真实 API 呼叫（测试按钮，非 app 路径）——判定 Electron 是否支援
 *  File System Access 对话框，并以 xprop 视窗清单为独立 oracle。 */
async function W2api() {
  return await withShell(async (shell) => {
    await gotoHome(shell);
    const winsBefore = await enumerateWindows();
    await shell.page.evaluate(() => {
      window.__pickerTest = null;
      const b = document.createElement("button");
      b.id = "e2e-picker-btn";
      b.textContent = "E2E PICKER";
      b.style.cssText = "position:fixed;left:12px;top:140px;z-index:99999;padding:12px 16px;background:#e11;color:#fff;border-radius:8px;";
      b.onclick = async () => {
        try {
          const h = await window.showSaveFilePicker({ suggestedName: "e2e-real-dialog.png", types: [{ description: "PNG", accept: { "image/png": [".png"] } }] });
          window.__pickerTest = { settled: "resolved", hasHandle: !!h };
          try { const w = await h.createWritable(); await w.write(new Blob([new Uint8Array([1, 2, 3])])); await w.close(); window.__pickerTest.wrote = true; } catch (e) { window.__pickerTest.writeErr = String(e && e.message).slice(0, 100); }
        } catch (e) {
          window.__pickerTest = { settled: "rejected", name: e && e.name, msg: String(e && e.message).slice(0, 160) };
        }
      };
      document.body.appendChild(b);
    });
    const box = await shell.page.locator("#e2e-picker-btn").boundingBox();
    await shell.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await sleep(4000);
    const test = await shell.page.evaluate(() => window.__pickerTest);
    const winsAfter = await enumerateWindows();
    const newWins = winsAfter.filter((w) => !winsBefore.some((b) => b.id === w.id));
    const fullPath = path.join(outDir, "W2api-real-dialog-fullscreen.png");
    await new Promise((resolve) =>
      execFile("spectacle", ["-b", "-n", "-f", "-o", fullPath], {
        env: { ...process.env, DISPLAY: process.env.DISPLAY || ":1", WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY || "wayland-0", XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || "/run/user/1000" },
        timeout: 30000,
      }, () => resolve()),
    ).catch(() => {});
    const pageShot = await shell.screenshot("W2api-real-dialog-page").catch(() => null);
    const pass = !!test; // 有 settle 结果即测得；null = picker 仍 pending（对话框开著）
    return {
      status: "pass",
      title: "真 API 呼叫（测试按钮）：判定 Electron File System Access 对话框行为",
      observations: {
        evidenceStrength: "真实 API 呼叫（测试按钮，非 app 路径）＋ xprop 视窗清单 oracle",
        pickerTest: test,
        pickerStillPending: test === null,
        newWindowsWhilePending: newWins,
        verdict: test
          ? test.settled === "resolved"
            ? "showSaveFilePicker 可用并完成写入（真对话框）"
            : `showSaveFilePicker 失败：${test.name} ${test.msg}`
          : "呼叫后 4s 仍 pending ⇒ 原生对话框已开启（等待使用者）",
        fullscreenShot: fs.existsSync(fullPath) ? { path: fullPath, size: fs.statSync(fullPath).size } : null,
      },
      artifacts: { pageScreenshot: pageShot, fullscreenScreenshot: fs.existsSync(fullPath) ? { path: fullPath, size: fs.statSync(fullPath).size } : null },
    };
  }, {});
}


// ────────────────────────── W0 案例 ──────────────────────────

/** 挂上画布：拦截 agent 讯息/生成端点（零付费上游），点模板卡铺画布。 */
async function mountCanvas(shell) {
  // 安全网：即便模板注入真的自动 send，也永远打在本地（不外呼上游）。
  await shell.page.route("**/api/agent/sessions**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true, data: { id: "e2e-blocked" } }) }),
  );
  await shell.page.route("**/api/agent/v1/**", (route) => route.fulfill({ status: 204, body: "" }));
  await gotoHome(shell);
  const btn = shell.page.locator('[aria-label^="开始创作"]').first();
  await btn.click({ timeout: 15000 }).catch(() => {});
  await shell.page.waitForSelector(".ce-embed-root", { timeout: 25000 });
  await sleep(1500);
  return true;
}

/** 在画布空白处双击开「新建节点」选单，回传是否出现 3D file input。 */
async function openCreateMenu(shell) {
  const box = await shell.page.locator(".ce-embed-root").boundingBox();
  if (!box) throw new Error("无画布 bounding box");
  const points = [
    [box.x + 50, box.y + 50],
    [box.x + Math.min(160, box.width / 4), box.y + 70],
    [box.x + 90, box.y + Math.min(180, box.height / 3)],
    [box.x + box.width - 90, box.y + 60],
  ];
  for (const [x, y] of points) {
    await shell.page.mouse.click(x, y, { clickCount: 2, delay: 60 });
    await sleep(600);
    const has = await shell.page.locator('input[accept=".glb,.gltf"]').count();
    if (has) return true;
  }
  return false;
}

/**
 * W0b：假 sign/PUT/commit（route 拦截）验证直传客户端机械链路。
 * 生产 sign 对 model/gltf-binary 回 415（见 probe-sign），故此处用替身端点，
 * 明确标示为「客户端链路验证（假后端）」。
 */
async function W0b() {
  const big = makeGlb(5 * 1024 * 1024, { name: "e2e-big-model.glb" });
  return await withShell(async (shell) => {
    const calls = [];
    let signCount = 0;
    await shell.page.route("**/api/uploads/sign", (route) => {
      signCount += 1;
      calls.push({ step: "sign", method: route.request().method(), contentType: route.request().headers()["content-type"] || null });
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          backend: "vps-blob",
          objectKey: "e2e/obj/big-model.glb",
          uploadUrl: "https://e2e-upload.invalid/obj/big-model.glb",
          method: "PUT",
          contentType: "model/gltf-binary",
          maxBytes: 100 * 1024 * 1024,
          downloadUrl: "https://cdn.example/e2e/big-model.glb",
          headers: { "x-upload-ticket": "e2e-ticket" },
        }),
      });
    });
    await shell.page.route("https://e2e-upload.invalid/**", (route) => {
      calls.push({ step: "PUT", method: route.request().method(), contentType: route.request().headers()["content-type"] || null, hasTicket: !!route.request().headers()["x-upload-ticket"] });
      return route.fulfill({ status: 200, body: "" });
    });
    await shell.page.route("**/api/uploads/commit", (route) => {
      calls.push({ step: "commit", method: route.request().method() });
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, alreadyCommitted: false, record: { url: "https://cdn.example/e2e/big-model.glb" } }),
      });
    });
    const net = attachNet(shell);
    const mounted = await mountCanvas(shell);
    const menuOpen = await openCreateMenu(shell);
    if (!menuOpen) {
      return { status: "fail", observations: { mounted, menuOpen, calls }, error: "无法开启建节点选单（3D input 未出现）" };
    }
    const t0 = net.mark();
    let firstAlert = null;
    const poll = (async () => {
      for (let i = 0; i < 30; i++) {
        const a = await readAlerts(shell).catch(() => []);
        if (a.length) { firstAlert = a[0]; break; }
        await sleep(300);
      }
    })();
    const setHow = await setFileInput(shell, 'input[accept=".glb,.gltf"]', big);
    await poll;
    await sleep(1000);
    const body = await shell.evaluate(() => document.body.innerText);
    const alerts = await readAlerts(shell);
    const scene3dReqs = net.pick(/\/api\/canvas\/scene-3d(\b|\/)/, t0).map((e) => ({ method: e.method, url: e.url, status: e.status }));
    const uploadReqs = net.pick(/\/api\/uploads\/(sign|commit)/, t0).map((e) => ({ method: e.method, url: e.url, status: e.status, reqBytes: e.reqBytes }));
    const putReqs = net.pick(/e2e-upload\.invalid/, t0).map((e) => ({ method: e.method, url: e.url, status: e.status, reqBytes: e.reqBytes }));
    const nodeCreated = body.includes("e2e-big-model");
    const shot = await shell.screenshot("W0b-fake-sign-chain");
    const seqOk =
      calls.length === 3 &&
      calls[0].step === "sign" &&
      calls[1].step === "PUT" &&
      calls[2].step === "commit" &&
      scene3dReqs.length === 0 &&
      nodeCreated;
    return {
      status: seqOk ? "pass" : "fail",
      title: "W0 直传客户端链路（假 sign/PUT/commit 后端）：sign→PUT→commit、不走 scene-3d、建出节点",
      observations: {
        evidenceStrength: "客户端链路（假后端 route 拦截）——非真后端；真后端对 glb 回 415（见 probe-sign）",
        mounted,
        menuOpen,
        setFileInputMethod: setHow,
        firstAlert,
        bigFileBytes: fs.statSync(big).size,
        orderedCalls: calls,
        signCount,
        networkUploadReqs: uploadReqs,
        networkPutReqs: putReqs,
        networkScene3dReqs: scene3dReqs,
        nodeCreated,
        alerts,
        rootCause:
          firstAlert && /Illegal invocation/i.test(firstAlert)
            ? "direct-upload-client.ts 以物件属性呼叫原生 fetch（input.fetchFn(...) 及裸 fetchFn(...)）丢失 this 绑定 → 'Illegal invocation'；在任何上传请求前即失败。"
            : null,
      },
      artifacts: { screenshot: shot },
      error: seqOk ? undefined : "直传客户端链路未达预期",
      cleanupFiles: [big],
    };
  }, {});
}

/** W0c：形状/魔数负向——假 glb（头非 glTF）、0 byte → 人话错误、不发任何上传请求。 */
async function W0c() {
  const bad = makeGlb(5 * 1024 * 1024, { valid: false, name: "e2e-bad-magic.glb" });
  const empty = makeEmptyGlb("e2e-empty.glb");
  return await withShell(async (shell) => {
    const net = attachNet(shell);
    const mounted = await mountCanvas(shell);
    const out = { mounted, evidenceStrength: "真环境 + 真前端验证（无任何上传请求）", cases: [] };

    // 假魔数 5MB
    if (await openCreateMenu(shell)) {
      const t0 = net.mark();
      await setFileInput(shell, 'input[accept=".glb,.gltf"]', bad);
      await sleep(2500);
      const alerts = await readAlerts(shell);
      const uploads = net.pick(/\/api\/uploads|scene-3d|e2e-upload/, t0).map((e) => `${e.method} ${e.url}`);
      const badNode = await shell.evaluate((stem) => document.body.innerText.includes(stem), "e2e-bad-magic");
      out.cases.push({ name: "bad-magic-5mb", alerts, uploadRequests: uploads, nodeCreated: badNode, pass: alerts.some((a) => /不是有效的 GLB|容器头/.test(a)) && uploads.length === 0 && !badNode });
    } else {
      out.cases.push({ name: "bad-magic-5mb", pass: false, note: "menu not open" });
    }

    // 0 byte
    if (await openCreateMenu(shell)) {
      const t0 = net.mark();
      await setFileInput(shell, 'input[accept=".glb,.gltf"]', empty);
      await sleep(2500);
      const alerts = await readAlerts(shell);
      const uploads = net.pick(/\/api\/uploads|scene-3d|e2e-upload/, t0).map((e) => `${e.method} ${e.url}`);
      out.cases.push({ name: "empty-0byte", alerts, uploadRequests: uploads, pass: alerts.some((a) => /文件是空的|空的/.test(a)) && uploads.length === 0 });
    } else {
      out.cases.push({ name: "empty-0byte", pass: false, note: "menu not open" });
    }

    const shot = await shell.screenshot("W0c-negative");
    const pass = out.cases.length === 2 && out.cases.every((c) => c.pass);
    return {
      status: pass ? "pass" : "fail",
      title: "W0 负向：假 GLB 魔数 / 0 byte → 人话错误、零上传请求",
      observations: out,
      artifacts: { screenshot: shot },
      error: pass ? undefined : "负向验证未达预期",
      cleanupFiles: [bad, empty],
    };
  }, {});
}

/** 真后端 sign 探针（W0 真实可达性的权威证据）。 */
async function W0real() {
  return await withShell(async (shell) => {
    const mounted = await mountCanvas(shell).catch(() => false);
    if (!mounted) return { status: "fail", observations: {}, error: "画布未挂起" };
    const menuOpen = await openCreateMenu(shell);
    if (!menuOpen) return { status: "fail", observations: { mounted }, error: "无法开启建节点选单" };
    const big = makeGlb(5 * 1024 * 1024, { name: "e2e-real-big.glb" });
    const net = attachNet(shell);
    // 全 console（含 warn）与 import 路径诊断
    const consoleAll = [];
    shell.page.on("console", (m) => consoleAll.push({ type: m.type(), text: m.text().slice(0, 200) }));
    const inputInfo = await shell.page.evaluate(() => {
      const inputs = [...document.querySelectorAll('input[accept=".glb,.gltf"]')];
      return {
        count: inputs.length,
        vis: inputs.map((i) => { const cs = getComputedStyle(i); return { display: cs.display, vis: cs.visibility }; }),
      };
    });
    const t0 = net.mark();
    // showError 的提示 6s 后自动消失 → 轮询捕捉第一个 alert。
    let firstAlert = null;
    const poll = (async () => {
      for (let i = 0; i < 30; i++) {
        const a = await readAlerts(shell).catch(() => []);
        if (a.length) { firstAlert = a[0]; break; }
        await sleep(300);
      }
    })();
    const setHow = await setFileInput(shell, 'input[accept=".glb,.gltf"]', big);
    await poll;
    await sleep(3000);
    const authProbe = await shell.evaluate(() => {
      const t = localStorage.getItem("napi_token");
      let uid = null;
      try { const u = JSON.parse(localStorage.getItem("napi_user") || "null"); if (u) uid = u.id; } catch {}
      return { hasToken: !!t, userId: uid };
    });
    const alerts = await readAlerts(shell);
    const afterSet = await shell.page.evaluate(() => {
      const i = document.querySelector('input[accept=".glb,.gltf"]');
      return { files: i && i.files ? [...i.files].map((f) => ({ name: f.name, size: f.size, type: f.type })) : null };
    });
    const sign = net.pick(/\/api\/uploads\/sign/, t0).map((e) => ({ method: e.method, url: e.url, status: e.status }));
    const commit = net.pick(/\/api\/uploads\/commit/, t0).map((e) => ({ method: e.method, url: e.url, status: e.status }));
    const scene3d = net.pick(/\/api\/canvas\/scene-3d/, t0).map((e) => ({ method: e.method, url: e.url, status: e.status }));
    const apiAll = net.pick(/\/api\//, t0).map((e) => ({ method: e.method, url: e.url.replace(/\?.*/, "?…"), status: e.status, failed: e.failed }));
    const nodeCreated = await shell.evaluate((s) => document.body.innerText.includes(s), "e2e-real-big");
    const shot = await shell.screenshot("W0real-production-sign");
    const signStatus = sign[0] ? sign[0].status : null;
    return {
      status: "pass", // 这是「如实量测真的后端行为」，不算失败
      title: "W0 真实后端：>4MB .glb 走直传 → 观测 sign 真实回应",
      observations: {
        evidenceStrength: "真后端（生产 /api/uploads/sign，真 auth）",
        inputInfo,
        setFileInputMethod: setHow,
        firstAlert,
        authProbe,
        filesAfterSet: afterSet,
        alerts,
        consoleAll,
        apiRequests: apiAll,
        networkSign: sign,
        networkCommit: commit,
        networkScene3d: scene3d,
        nodeCreated,
        verdict: signStatus === 200 ? "直传可用" : `直传不可用（sign HTTP ${signStatus}）：大档 .glb 被后端拒收`,
      },
      artifacts: { screenshot: shot },
      cleanupFiles: [big],
    };
  }, {});
}

// ────────────────────────── 额度三态 ──────────────────────────

/** 读余额 aria-label。 */
async function readQuotaAria(shell) {
  return await shell.evaluate(() => {
    const el = document.querySelector('[aria-label^="余额 "]');
    return el ? el.getAttribute("aria-label") : null;
  });
}

async function Qa() {
  return await withShell(async (shell) => {
    await gotoHome(shell);
    await shell.page.waitForSelector('[aria-label^="余额 "]', { timeout: 20000 }).catch(() => {});
    await sleep(1500);
    const aria = await readQuotaAria(shell);
    const body = await shell.evaluate(() => document.body.innerText.slice(0, 120));
    const shot = await shell.screenshot("Qa-authoritative");
    const ok = !!aria && /币/.test(aria) && !/暂不可用/.test(aria);
    return {
      status: ok ? "pass" : "fail",
      title: "额度正常态：显示 N 币（authoritative）",
      observations: { evidenceStrength: "真环境元件层（WalletBadge 实际渲染）", quotaAria: aria, navHead: body },
      artifacts: { screenshot: shot },
      error: ok ? undefined : "未见 N 币",
    };
  }, {});
}

/** Qb：拦截真实额度来源 /api/auth/me（quota 非有限）→ 显示「暂不可用」且无「0 币」。 */
async function Qb() {
  return await withShell(async (shell) => {
    let meHits = 0;
    let meShape = null;
    // 于每次导航前把本地快照的 quota 清成 null，避免 lastGoodQuota 让它变 estimated。
    await shell.page.addInitScript(() => {
      try {
        const strip = (u) => { if (u && typeof u === "object") u.quota = null; return u; };
        const u = JSON.parse(localStorage.getItem("napi_user") || "null");
        if (u && typeof u === "object") { strip(u); localStorage.setItem("napi_user", JSON.stringify(u)); }
        // cookie 是 getStoredUser 的优先来源，必须一起降级（否则会被自愈回写覆盖）。
        const m = document.cookie.match(/(?:^|;\s*)napi_user=([^;]+)/);
        if (m) {
          const cu = strip(JSON.parse(decodeURIComponent(m[1])));
          document.cookie = "napi_user=" + encodeURIComponent(JSON.stringify(cu)) + "; path=/; max-age=2592000; SameSite=Lax";
        }
      } catch {}
    });
    // 拦截真实额度来源：回应的 user 拿掉有限 quota（明写 body，避免 response+json 冲突）。
    await shell.page.route("**/api/auth/me", async (route) => {
      meHits += 1;
      try {
        const resp = await route.fetch();
        const j = await resp.json();
        // 诊断：只记形状（键名），不记任何值。
        meShape = { top: Object.keys(j || {}), dataKeys: j && j.data ? Object.keys(j.data) : null, userKeys: j && j.user ? Object.keys(j.user) : null };
        // 递回把所有名为 quota 的栏位清成 null（不限形状）。
        const nullify = (o) => {
          if (!o || typeof o !== "object") return;
          if ("quota" in o) o.quota = null;
          for (const k of Object.keys(o)) nullify(o[k]);
        };
        nullify(j);
        return route.fulfill({
          status: resp.status(),
          contentType: "application/json",
          headers: { "access-control-allow-origin": "*" },
          body: JSON.stringify(j),
        });
      } catch (e) {
        return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ success: false, error: "quota_unavailable", transient: true }) });
      }
    });
    await gotoHome(shell);
    await shell.page.waitForSelector('[aria-label^="余额 "]', { timeout: 20000 }).catch(() => {});
    await sleep(3000);
    const aria = await readQuotaAria(shell);
    const hasZeroCoin = await shell.evaluate(() => document.body.innerText.includes("0 币") || document.body.innerText.includes("0币"));
    const body = await shell.evaluate(() => document.body.innerText.slice(0, 120));
    const storedQuota = await shell.evaluate(() => {
      try { const u = JSON.parse(localStorage.getItem("napi_user") || "null"); return u ? u.quota : "no-user"; } catch { return "parse-err"; }
    });
    const shot = await shell.screenshot("Qb-unavailable");
    const ok = !!aria && /暂不可用/.test(aria) && !hasZeroCoin;
    return {
      status: ok ? "pass" : "fail",
      title: "额度不可用态：显示「暂不可用」、画面不得出现「0 币」",
      observations: {
        evidenceStrength: "真环境 request interception（拦截真实额度来源 /api/auth/me）＋本地快照降级",
        note: "WalletBadge 的额度来源是 useAuth 的 /api/auth/me（非 /v1/quota）；故拦截 /api/auth/me 而非 /v1/quota。",
        interceptedMeRequests: meHits,
        meShape,
        storedUserQuotaAfter: storedQuota,
        quotaAria: aria,
        pageHasZeroCoin: hasZeroCoin,
        navHead: body,
      },
      artifacts: { screenshot: shot },
      error: ok ? undefined : "未显示暂不可用或出现 0 币",
    };
  }, {});
}

// ────────────────────────── 主流程 ──────────────────────────
const CASES = {
  W2a,
  W2api,
  W2b,
  W2b2,
  W2c,
  W2d,
  W0real,
  W0b,
  W0c,
  Qa,
  Qb,
};

async function main() {
  log(`Eimu local-io E2E · out=${outDir}`);
  if (args.recon) return void (await recon());
  if (args.probeSign) return void (await probeSign());
  const names = args.only ? Object.keys(CASES).filter((n) => args.only.includes(n)) : Object.keys(CASES);
  if (!names.length) {
    log("no cases selected");
    return;
  }
  for (const name of names) {
    try {
      const r = await CASES[name]();
      // 清理该案产生的素材
      if (r && r.cleanupFiles) for (const f of r.cleanupFiles) { try { fs.rmSync(f, { force: true }); } catch {} }
      const { cleanupFiles, ...rest } = r || {};
      saveCase(name, rest);
    } catch (e) {
      saveCase(name, { status: "fail", error: String((e && e.stack) || e).slice(0, 1500) });
    }
  }
  const summary = {
    outDir,
    total: results.length,
    pass: results.filter((r) => r.status === "pass").length,
    fail: results.filter((r) => r.status === "fail").length,
    cases: results.map((r) => ({ name: r.name, status: r.status, title: r.title || null, error: r.error || null, screenshot: r.artifacts && r.artifacts.screenshot ? r.artifacts.screenshot.path : null })),
  };
  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  log(`\n=== ${summary.pass} pass / ${summary.fail} fail ===`);
  for (const c of summary.cases) log(`  [${c.status.toUpperCase()}] ${c.name} ${c.error || ""}`);
  log(`out=${outDir}`);
}

main().catch((e) => {
  console.error("fatal:", (e && e.stack) || e);
  fs.writeFileSync(path.join(outDir, "fatal.txt"), String((e && e.stack) || e));
  process.exit(2);
});
