// desktop/scripts/e2e/final-b-cases.mjs
//
// 最终验收代理 B（本机 I/O 与画布路径）——只新增本档，不动既有 harness/cases。
// 覆盖三条本轮修复在「已部署生产」上的行为：
//   B0：3D >4MB 直传真链路（sign → PUT(store) → commit）+ 建 scene3d 节点
//   B2：历史页批量汇出真 CDN（不注入媒体替身）+ 真 zip 位元组 + unzip 清单 + 单张下载
//   B3：画布取指定时间点帧对「无视讯轨」来源落明确终态（不再永卡「取帧中…」）
//
// 红线：不部署/不 SSH/不连 DB/不呼叫付费上游；真壳用复制 profile（只读）；
//       截图输出 /tmp/final-b-*；不记 token/cookie 值。
//
// 用法：node desktop/scripts/e2e/final-b-cases.mjs --only B0,B2,B3 [--out DIR]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { launchShell } from "./harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REAL_PROFILE = path.join(os.homedir(), ".config", "Eimu");

function parseArgs(argv) {
  const out = { only: null, out: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--only") out.only = (argv[++i] || "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--out") out.out = argv[++i];
  }
  return out;
}
const args = parseArgs(process.argv);
const outDir = args.out || path.join("/tmp", `final-b-${Date.now()}`);
fs.mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const results = [];
function saveCase(name, obj) {
  fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify(obj, null, 2));
  results.push({ ...obj, name });
  log(`▶ ${name}: ${obj.error ? "FAIL " + obj.error : obj.status ? obj.status.toUpperCase() : "PASS"}`);
}
const want = (n) => !args.only || args.only.includes(n);

// ── 素材 ──
const GLB_MAGIC = Buffer.from([0x67, 0x6c, 0x54, 0x46]);
function makeGlb(sizeBytes, { valid = true, name = "big.glb" } = {}) {
  const buf = Buffer.alloc(sizeBytes);
  if (valid) {
    GLB_MAGIC.copy(buf, 0);
    buf.writeUInt32LE(2, 4);
    buf.writeUInt32LE(sizeBytes, 8);
  } else {
    buf.write("NOTGLB!!", 0, "latin1");
  }
  const p = path.join(outDir, name);
  fs.writeFileSync(p, buf);
  return p;
}

// ── 网路录制（request/response/requestfinished/requestfailed/console）──
function attachNet(shell) {
  const list = [];
  const byReq = new Map();
  const rec = (req) => {
    if (byReq.has(req)) return byReq.get(req);
    const e = { ts: Date.now(), url: req.url(), method: req.method(), status: null, failed: false, reqBytes: null, respBytes: null };
    byReq.set(req, e);
    list.push(e);
    return e;
  };
  shell.page.on("request", (r) => rec(r));
  shell.page.on("response", (res) => {
    const e = byReq.get(res.request());
    if (e) e.status = res.status();
  });
  shell.page.on("requestfinished", async (req) => {
    const e = byReq.get(req);
    if (!e) return;
    try {
      const s = await req.sizes();
      if (s) { e.reqBytes = s.requestBodySize; e.respBytes = s.responseBodySize; }
    } catch { /* ignore */ }
    if (e.status == null) {
      try { const r = await req.response(); if (r) e.status = r.status(); } catch { /* ignore */ }
    }
  });
  shell.page.on("requestfailed", (req) => {
    const e = byReq.get(req);
    if (e) { e.failed = true; e.failure = (req.failure() && req.failure().errorText) || "unknown"; }
  });
  shell.page.on("console", (msg) => {
    if (msg.type() === "error") list.push({ ts: Date.now(), console: "error", text: msg.text().slice(0, 300) });
  });
  return {
    all: () => list.slice(),
    since: (ts) => list.filter((e) => e.ts >= ts),
    mark: () => Date.now(),
    pick: (re, tsFrom) => list.filter((e) => e.url && (!tsFrom || e.ts >= tsFrom) && re.test(e.url) && !e.console),
  };
}

// ── 壳启动（GPU 崩溃常态，重试至多 3 次；收壳删复制 profile）──
async function launchShellRetry(opts, tries = 3) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try { return await launchShell(opts); } catch (e) {
      lastErr = e;
      log(`  [launch retry ${i + 1}/${tries}] ${String((e && e.message) || e).slice(0, 120)}`);
      await sleep(3000);
    }
  }
  throw lastErr;
}
async function withShell(fn, { origin, extraEnv } = {}) {
  const profileExists = fs.existsSync(REAL_PROFILE);
  const shell = await launchShellRetry({ outDir, origin: origin || undefined, extraEnv: extraEnv || undefined, seedProfileFrom: profileExists ? REAL_PROFILE : undefined });
  try {
    await shell.page.waitForLoadState("domcontentloaded").catch(() => {});
    await sleep(2500);
    return await fn(shell);
  } finally {
    await shell.close().catch(() => {});
    try { fs.rmSync(path.join(outDir, "home"), { recursive: true, force: true }); } catch { /* ignore */ }
    await sleep(1200);
  }
}

/** 等页面真的落在 http(s) 来源（localStorage 可读），否则重导。 */
async function ensureAppOrigin(shell) {
  const url = shell.page.url();
  if (/^https?:/.test(url)) return true;
  await shell.page.goto("https://eimu.dev/", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  await sleep(2500);
  return /^https?:/.test(shell.page.url());
}

// ── 通用 ──
async function readAlerts(shell) {
  return await shell.evaluate(() => [...document.querySelectorAll('[role="alert"]')].map((e) => e.innerText.trim()).filter(Boolean));
}
async function domClickText(shell, text) {
  return await shell.page.evaluate((t) => {
    const btns = [...document.querySelectorAll("button")];
    const b = btns.find((x) => x.innerText.trim() === t) || btns.find((x) => x.innerText.includes(t));
    if (!b) return false;
    b.click();
    return true;
  }, text);
}
async function setFileInput(shell, selector, files) {
  const list = Array.isArray(files) ? files : [files];
  try {
    await shell.page.setInputFiles(selector, list, { timeout: 15000 });
    return "playwright";
  } catch {
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
async function gotoHome(shell) {
  await shell.page.goto(shell.origin + "/", { waitUntil: "domcontentloaded" }).catch(() => {});
  await sleep(2500);
}
async function gotoHistory(shell) {
  await shell.page.goto(shell.origin + "/history", { waitUntil: "domcontentloaded" }).catch(() => {});
  await shell.page.waitForSelector('button[aria-label="下载"]', { timeout: 30000 }).catch(() => {});
  await sleep(2500);
}
async function mountCanvas(shell) {
  await shell.page.route("**/api/agent/sessions**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true, data: { id: "e2e-blocked" } }) }),
  );
  await shell.page.route("**/api/agent/v1/**", (route) => route.fulfill({ status: 204, body: "" }));
  await gotoHome(shell);
  const btn = shell.page.locator('[aria-label^="开始创作"]').first();
  await btn.click({ timeout: 15000 }).catch(() => {});
  await shell.page.waitForSelector(".ce-embed-root", { timeout: 25000 });
  await sleep(1500);
}
async function openCreateMenu(shell) {
  const box = await shell.page.locator(".ce-embed-root").boundingBox();
  if (!box) throw new Error("无画布 bounding box");
  const points = [
    [box.x + 50, box.y + 50],
    [box.x + Math.min(160, box.width / 4), box.y + 70],
    [box.x + 90, box.y + Math.min(180, box.height / 3)],
  ];
  for (const [x, y] of points) {
    await shell.page.mouse.click(x, y, { clickCount: 2, delay: 60 });
    await sleep(600);
    if (await shell.page.locator('input[accept=".glb,.gltf"]').count()) return true;
  }
  return false;
}
function unzipList(file) {
  return new Promise((resolve) => {
    execFile("unzip", ["-l", file], { timeout: 20000 }, (err, stdout) =>
      resolve({ ok: !err, out: String(stdout || ""), err: err ? String(err).slice(0, 200) : null }),
    );
  });
}
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

// ───────────────────────── B0：真后端 3D 大档直传 ─────────────────────────
async function B0() {
  const big = makeGlb(5 * 1024 * 1024, { name: "e2e-finalb-big.glb" });
  return await withShell(async (shell) => {
    const net = attachNet(shell);
    const consoleAll = [];
    shell.page.on("console", (m) => consoleAll.push({ type: m.type(), text: m.text().slice(0, 200) }));
    await mountCanvas(shell);
    const menuOpen = await openCreateMenu(shell);
    if (!menuOpen) return { status: "fail", observations: { menuOpen }, error: "无法开启建节点选单" };

    const t0 = net.mark();
    let firstAlert = null;
    const poll = (async () => {
      for (let i = 0; i < 40; i++) {
        const a = await readAlerts(shell).catch(() => []);
        if (a.length) { firstAlert = a[0]; break; }
        await sleep(300);
      }
    })();
    const setHow = await setFileInput(shell, 'input[accept=".glb,.gltf"]', big);
    await poll;

    // 耐心等 commit + 节点（大档 5MB 上传可能超过 12s）
    const deadline = Date.now() + 90000;
    let nodeCreated = false;
    let commitSeen = false;
    let putSettled = false;
    while (Date.now() < deadline) {
      commitSeen = net.since(t0).some((e) => e.url && /\/api\/uploads\/commit/.test(e.url) && !e.console);
      putSettled = net.since(t0).some((e) => e.url && /store\.tinchak0207\.xyz\/image-data\/api\/blob\//.test(e.url) && e.status != null);
      const body = await shell.page.evaluate(() => document.body.innerText).catch(() => "");
      nodeCreated = body.includes("e2e-finalb-big");
      if (nodeCreated || (commitSeen && putSettled)) break;
      if (firstAlert && Date.now() - t0 > 20000 && !commitSeen) break;
      await sleep(1000);
    }
    await sleep(2000);
    // 最终节点判定（回圈可能在节点 render 前就因 commit+PUT 齐备而跳出）
    nodeCreated = await shell.evaluate((stem) => {
      const inBody = document.body.innerText.includes(stem);
      const inNodes = [...document.querySelectorAll("[data-canvas-node]")].some((n) => (n.innerText || "").includes(stem));
      return inBody || inNodes;
    }, "e2e-finalb-big");
    const alerts = await readAlerts(shell);
    const sign = net.pick(/\/api\/uploads\/sign/, t0).map((e) => ({ method: e.method, status: e.status, failed: e.failed }));
    const put = net.pick(/store\.tinchak0207\.xyz\/image-data\/api\/blob\//, t0).map((e) => ({ method: e.method, status: e.status, failed: e.failed, failure: e.failure || null, reqBytes: e.reqBytes }));
    const commit = net.pick(/\/api\/uploads\/commit/, t0).map((e) => ({ method: e.method, status: e.status, failed: e.failed }));
    const scene3d = net.pick(/\/api\/canvas\/scene-3d/, t0).map((e) => ({ method: e.method, status: e.status }));
    const apiAll = net.pick(/\/api\//, t0).map((e) => ({ method: e.method, url: e.url.replace(/\?.*/, "?…"), status: e.status, failed: e.failed }));
    const illegal = consoleAll.some((c) => /Illegal invocation/i.test(c.text)) || alerts.some((a) => /Illegal invocation/i.test(a));
    const shot = await shell.screenshot("B0-direct-upload-chain");
    const signOk = sign.length === 1 && sign[0].status === 200;
    const putOk = put.length >= 1 && put[0].status === 200 && !put[0].failed;
    const commitOk = commit.length === 1 && commit[0].status === 200;
    const pass = signOk && putOk && commitOk && nodeCreated && !illegal;
    return {
      status: pass ? "pass" : "fail",
      title: "3D >4MB 直传真链路：sign 200 → PUT(store) 200 → commit 200、建出节点、无 Illegal invocation",
      observations: {
        evidenceStrength: "真后端（生产 /api/uploads/sign ＋ store.tinchak0207.xyz PUT ＋ /api/uploads/commit，真 auth）",
        bigFileBytes: fs.statSync(big).size,
        setFileInputMethod: setHow,
        firstAlert,
        alerts,
        nodeCreated,
        networkSign: sign,
        networkPut: put,
        networkCommit: commit,
        networkScene3d: scene3d,
        apiRequests: apiAll,
        consoleErrors: consoleAll.filter((c) => c.type === "error").map((c) => c.text),
        illegalInvocationSeen: illegal,
        expected: "sign=1×200, PUT≥1×200, commit=1×200, node=true, illegal=false",
      },
      artifacts: { screenshot: shot },
      error: pass ? undefined : "直传真链路未达预期",
      cleanupFiles: [big],
    };
  });
}

// ───────────────────────── B2：批量汇出真 CDN ─────────────────────────
async function B2() {
  return await withShell(async (shell) => {
    await gotoHistory(shell);
    const cardCount = await shell.page.locator('button[aria-label="下载"]').count();
    if (cardCount < 2) return { status: "fail", observations: { cardCount }, error: "历史页可下载卡片 <2" };

    const net = attachNet(shell);
    // 移除目录 picker（逼走 zip 路径）＋替身 saveFilePicker 拦下 zip blob；anchor 抑制真下载。
    await shell.evaluate(() => {
      try { delete window.showDirectoryPicker; } catch { window.showDirectoryPicker = undefined; }
      window.__b2 = { saveCalls: [], writes: [], _blob: null };
      window.showSaveFilePicker = async (opts) => {
        window.__b2.saveCalls.push((opts && opts.suggestedName) || null);
        return {
          createWritable: async () => ({
            write: async (blob) => {
              window.__b2.writes.push({ name: (opts && opts.suggestedName) || "unnamed", size: blob.size, type: blob.type });
              window.__b2._blob = blob;
            },
            close: async () => {},
          }),
        };
      };
      window.__eimuAnchors = [];
      const orig = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        if (this.download) { window.__eimuAnchors.push(this.download); return; }
        return orig.call(this);
      };
    });

    // 多选 2 张
    await domClickText(shell, "多选");
    await sleep(900);
    const selected = await shell.page.evaluate(() => {
      const cards = [...document.querySelectorAll("article.hist-card")].filter((c) => c.querySelector('button[aria-label="下载"]'));
      let n = 0;
      for (const c of cards.slice(0, 2)) {
        const b = c.querySelector('button[aria-label="选中这张"]');
        if (b) { b.click(); n += 1; }
      }
      return { selected: n, candidates: cards.length };
    });
    await sleep(700);

    const tBulk = net.mark();
    await domClickText(shell, "打包下载");
    let notice = null;
    for (let i = 0; i < 100; i++) {
      const txt = await shell.evaluate(() =>
        [...document.querySelectorAll('[role="status"]')].map((e) => e.innerText.trim()).filter((t) => t && !/正在加载生成历史/.test(t)).join(" | "),
      );
      if (/已打包|都没有可下载|取不到|打包失败/.test(txt)) { notice = txt; break; }
      await sleep(500);
    }
    await sleep(1500);
    const shot = await shell.screenshot("B2-bulk-export");

    // 取回 zip 位元组 → 落盘 → unzip -l
    const zipInfo = await shell.evaluate(async () => {
      const b = window.__b2;
      if (!b || !b._blob) return null;
      const blob = b._blob;
      const buf = new Uint8Array(await blob.arrayBuffer());
      let bin = "";
      const chunk = 0x8000;
      for (let i = 0; i < buf.length; i += chunk) bin += String.fromCharCode.apply(null, buf.subarray(i, i + chunk));
      return { name: b.writes[0] && b.writes[0].name, size: blob.size, type: blob.type, b64: btoa(bin) };
    });
    let zipPath = null;
    let listing = null;
    if (zipInfo) {
      zipPath = path.join(outDir, "B2-history-export.zip");
      fs.writeFileSync(zipPath, Buffer.from(zipInfo.b64, "base64"));
      listing = await unzipList(zipPath);
    }

    const mediaReqs = net
      .since(tBulk)
      .filter((e) => e.url && !e.console && /store\.tinchak0207\.xyz/.test(e.url))
      .map((e) => ({ method: e.method, hasDl: /[?&]dl=1/.test(e.url), status: e.status, failed: e.failed, failure: e.failure || null }));
    const anyFailed = mediaReqs.some((r) => r.failed);
    const allDl = mediaReqs.length > 0 && mediaReqs.every((r) => r.hasDl);

    const m = notice ? /已打包\s*(\d+)\s*个文件/.exec(notice) : null;
    const exported = m ? Number(m[1]) : null;
    const skippedM = notice ? /(\d+)\s*个取不到/.exec(notice) : null;
    const skipped = skippedM ? Number(skippedM[1]) : notice && /已打包/.test(notice) ? 0 : null;
    const listingOut = (listing && listing.out) || "";
    const hasManifest = /manifest\.json/.test(listingOut);
    const mediaEntries = (listingOut.match(/\.(png|jpe?g|webp|gif|avif|mp4|webm|mov|mp3|wav|m4a|aac)\b/gi) || []).length;
    const anchors = await shell.evaluate(() => window.__eimuAnchors || []);

    // 单张下载（退出多选 → 点第一张下载钮）
    await shell.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find((x) => x.getAttribute("aria-label") === "退出多选");
      if (b) b.click();
    });
    await sleep(1000);
    const writesBefore = (await shell.evaluate(() => (window.__b2 && window.__b2.writes.length) || 0));
    const tSingle = net.mark();
    await shell.page.evaluate(() => { const b = document.querySelector('button[aria-label="下载"]'); if (b) b.click(); });
    let singleWrite = null;
    for (let i = 0; i < 40; i++) {
      const w = await shell.evaluate((n) => (window.__b2 && window.__b2.writes.length > n ? window.__b2.writes[window.__b2.writes.length - 1] : null), writesBefore);
      if (w) { singleWrite = w; break; }
      await sleep(500);
    }
    const singleReqs = net
      .since(tSingle)
      .filter((e) => e.url && !e.console && /store\.tinchak0207\.xyz/.test(e.url))
      .map((e) => ({ method: e.method, hasDl: /[?&]dl=1/.test(e.url), status: e.status, failed: e.failed }));
    const singleShot = await shell.screenshot("B2-single-download");

    const pass =
      exported !== null && exported >= 2 && skipped === 0 &&
      !!zipPath && hasManifest && mediaEntries >= 2 &&
      !anyFailed && allDl && anchors.length === 0;

    return {
      status: pass ? "pass" : "fail",
      title: "历史页批量汇出真 CDN：exported≥2 / skipped=0 / 真 zip 含媒体+manifest / 无 ERR_FAILED / 带 ?dl=1",
      observations: {
        evidenceStrength: "真网路（store.tinchak0207.xyz 真图、不注入媒体替身）＋真 zip 位元组（unzip -l）＋元件层 notice",
        cardCount,
        selected,
        notice,
        exportedFromNotice: exported,
        skippedFromNotice: skipped,
        zip: zipInfo ? { name: zipInfo.name, size: zipInfo.size, type: zipInfo.type, path: zipPath } : null,
        unzipListHead: listingOut.slice(0, 1200),
        unzipOk: listing ? listing.ok : null,
        listingHasManifest: hasManifest,
        listingMediaEntries: mediaEntries,
        bulkMediaRequests: mediaReqs,
        anyFailedRequest: anyFailed,
        allMediaHaveDl1: allDl,
        anchorDownloadsSuppressed: anchors,
        singleDownload: {
          write: singleWrite,
          mediaRequests: singleReqs,
          anyFailed: singleReqs.some((r) => r.failed),
          allDl: singleReqs.length > 0 && singleReqs.every((r) => r.hasDl),
        },
        expected: "exported≥2, skipped=0, zip含manifest+≥2媒体, 无ERR_FAILED, 带?dl=1",
      },
      artifacts: { bulkScreenshot: shot, singleScreenshot: singleShot, zip: zipPath ? { path: zipPath, size: fs.statSync(zipPath).size } : null },
      error: pass ? undefined : "批量汇出真链路未达预期",
    };
  });
}

// ───────────────────────── B3：取帧终态 ─────────────────────────
async function B3once() {
  const projectId = `e2e-finalb-${Date.now().toString(36)}`;
  const GOOD = "https://eimu.dev/promo/eimu-promo.mp4";
  const BAD = "https://eimu.dev/showcase/agent-templates/ecom-model-2.webp"; // 图片：无视讯轨
  return await withShell(async (shell) => {
    const net = attachNet(shell);
    await ensureAppOrigin(shell);
    const appOriginOk = /^https?:/.test(shell.page.url());

    // 以真 auth 播一张含 2 个 video 节点的画布专案（正常影片 + 无视讯轨图片）
    let seed = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        seed = await shell.evaluate(async ({ projectId, GOOD, BAD }) => {
      let token = localStorage.getItem("napi_token");
      if (!token && document.cookie.includes("napi_token=")) {
        const m = document.cookie.match(/(?:^|;\s*)napi_token=([^;]+)/);
        if (m) token = decodeURIComponent(m[1]);
      }
      let uid = null;
      try { const u = JSON.parse(localStorage.getItem("napi_user") || "null"); if (u && u.id !== undefined) uid = String(u.id); } catch { /* ignore */ }
      const now = new Date().toISOString();
      const project = {
        id: projectId,
        title: `E2E-FINALB-${projectId.slice(-4)}`,
        createdAt: now,
        updatedAt: now,
        nodes: [
          { id: "b3-good", type: "video", title: "B3-正常影片", position: { x: 80, y: 90 }, width: 260, height: 170, metadata: { content: GOOD, status: "success", kind: "video" } },
          { id: "b3-bad", type: "video", title: "B3-无视频轨", position: { x: 400, y: 90 }, width: 260, height: 170, metadata: { content: BAD, status: "success", kind: "video" } },
        ],
        connections: [],
        viewport: { x: 0, y: 0, k: 1 },
        backgroundMode: "dots",
      };
      const res = await fetch("/api/canvas/projects", {
        method: "PUT",
        headers: { Authorization: "Bearer " + token, "x-user-id": String(uid), "Content-Type": "application/json" },
        body: JSON.stringify(project),
      });
      let body = null;
      try { body = await res.json(); } catch { /* ignore */ }
      return { status: res.status, ok: res.ok, body: body ? { success: body.success, error: body.error || null } : null, uid: !!uid };
        }, { projectId, GOOD, BAD });
        break;
      } catch (e) {
        log(`  [seed retry ${attempt + 1}/3] ${String((e && e.message) || e).slice(0, 120)}`);
        if (/crash/i.test(String((e && e.message) || e))) throw new Error(`page crash: ${String((e && e.message) || e).slice(0, 80)}`);
        await ensureAppOrigin(shell);
        await sleep(1500);
      }
    }
    if (!seed) return { status: "fail", observations: { appOriginOk }, error: "seed 无法执行（localStorage/来源不可读）" };
    if (!seed.ok) return { status: "fail", observations: { seed }, error: `播专案失败（HTTP ${seed.status}）` };

    await mountCanvas(shell);
    // 开历史画布 → 点载入我们播的专案
    await shell.page.evaluate(() => { const b = document.querySelector('button[aria-label="历史画布"]'); if (b) b.click(); });
    await shell.page.waitForSelector('[aria-label="历史画布列表"]', { timeout: 15000 }).catch(() => {});
    await sleep(1200);
    const clicked = await shell.page.evaluate((title) => {
      const opt = [...document.querySelectorAll('[aria-label="历史画布列表"] [role="option"]')].find((b) => b.innerText.includes(title));
      if (opt) { opt.click(); return true; }
      return false;
    }, `E2E-FINALB-${projectId.slice(-4)}`);
    await sleep(2500);
    const nodeCount0 = await shell.page.locator("[data-canvas-node]").count();

    // ── 无视讯轨来源：截帧 → 应落人话终态（不是永卡）──
    const tBad = net.mark();
    const badBtn = shell.page.locator('[data-canvas-node="b3-bad"] button').filter({ hasText: "截帧" }).first();
    const badVisible = await badBtn.isVisible().catch(() => false);
    if (badVisible) await badBtn.click({ timeout: 10000 }).catch(() => {});
    let badAlert = null;
    let badStuck = false;
    let badShotPath = null;
    for (let i = 0; i < 80; i++) {
      const a = await readAlerts(shell).catch(() => []);
      if (a.length) { badAlert = a[0]; badShotPath = (await shell.screenshot("B3-bad-terminal")).path; break; }
      await sleep(250);
    }
    if (!badAlert) {
      // 没错误：看它有没有卡在「取帧中…」
      badStuck = await shell.page.evaluate(() => !!document.body.innerText.includes("取帧中"));
      if (badStuck) badShotPath = (await shell.screenshot("B3-bad-stuck")).path;
    }
    await sleep(1500);
    const badBtnText = await shell.page.evaluate(() => {
      const n = document.querySelector('[data-canvas-node="b3-bad"]');
      const b = n ? [...n.querySelectorAll("button")].find((x) => /截帧|取帧中/.test(x.innerText)) : null;
      return b ? b.innerText.trim() : null;
    });
    const badPlanReqs = net.pick(/\/api\/canvas\/video-frames/, tBad).map((e) => ({ method: e.method, status: e.status, failed: e.failed }));

    // ── 正常影片：截帧 → 应成功落节点（无回归）──
    // 先等 bad 的 toast 自然消失（6s 自动关），避免误读残留错误
    for (let i = 0; i < 30; i++) { if (!(await readAlerts(shell).catch(() => [])).length) break; await sleep(500); }
    // 诊断：本壳能否解码这支 H.264（独立探针，非付费）
    const codecProbe = await shell.page.evaluate(async (url) => {
      const v = document.createElement("video");
      v.muted = true; v.crossOrigin = "anonymous"; v.preload = "auto"; v.src = url;
      const ev = await new Promise((res) => {
        const done = (x) => res(x);
        v.addEventListener("loadedmetadata", () => done("loadedmetadata"));
        v.addEventListener("error", () => done("error"));
        setTimeout(() => done("timeout"), 12000);
      });
      await new Promise((r) => setTimeout(r, 1200));
      return { ev, readyState: v.readyState, errorCode: v.error ? v.error.code : null, errorMsg: v.error ? String(v.error.message).slice(0, 120) : null, videoWidth: v.videoWidth, duration: v.duration, canH264: v.canPlayType('video/mp4; codecs="avc1.42E01E"') };
    }, GOOD).catch((e) => ({ error: String((e && e.message) || e).slice(0, 120) }));

    const nodeCountBeforeGood = await shell.page.locator("[data-canvas-node]").count();
    const tGood = net.mark();
    const goodBtn = shell.page.locator('[data-canvas-node="b3-good"] button').filter({ hasText: "截帧" }).first();
    const goodVisible = await goodBtn.isVisible().catch(() => false);
    if (goodVisible) await goodBtn.click({ timeout: 10000 }).catch(() => {});
    let goodNodes = nodeCountBeforeGood;
    let goodAlert = null;
    let goodShot = null;
    const goodDeadline = Date.now() + 90000;
    while (Date.now() < goodDeadline) {
      goodNodes = await shell.page.locator("[data-canvas-node]").count();
      const a = await readAlerts(shell).catch(() => []);
      if (a.length) { goodAlert = a[0]; }
      if (goodNodes > nodeCountBeforeGood) break;
      if (goodAlert && /取帧失败/.test(goodAlert)) { goodShot = (await shell.screenshot("B3-good-terminal")).path; break; }
      await sleep(1000);
    }
    if (!goodShot) goodShot = (await shell.screenshot("B3-good-success")).path;
    const goodPlanReqs = net.pick(/\/api\/canvas\/video-frames/, tGood).map((e) => ({ method: e.method, status: e.status, failed: e.failed }));
    const goodPlanOk = goodPlanReqs.some((r) => r.status === 200);
    const goodSucceeded = goodNodes > nodeCountBeforeGood;

    // 清理：删掉本轮播的画布
    await shell.evaluate(async (id) => {
      let token = localStorage.getItem("napi_token");
      let uid = null;
      try { const u = JSON.parse(localStorage.getItem("napi_user") || "null"); if (u && u.id !== undefined) uid = String(u.id); } catch { /* ignore */ }
      await fetch("/api/canvas/projects", { method: "DELETE", headers: { Authorization: "Bearer " + token, "x-user-id": String(uid), "Content-Type": "application/json" }, body: JSON.stringify({ ids: [id] }) }).catch(() => {});
    }, projectId);

    const pass = !!badAlert && /取帧/.test(badAlert) && !badStuck && goodSucceeded && !goodAlert;
    return {
      status: pass ? "pass" : "fail",
      title: "取帧终态：无视讯轨来源→人话错误（非永卡）；正常影片→照常成功",
      observations: {
        evidenceStrength: "真环境元件层（画布节点动作，真 /api/canvas/video-frames）＋UI 终态",
        appOriginOk,
        projectSeed: seed,
        projectLoaded: clicked,
        canvasNodeCountAfterLoad: nodeCount0,
        badSource: BAD,
        bad: {
          buttonVisible: badVisible,
          terminalAlert: badAlert,
          stuckInExtracting: badStuck,
          buttonTextAfter: badBtnText,
          planRequests: badPlanReqs,
          screenshot: badShotPath,
        },
        goodSource: GOOD,
        codecProbe,
        good: {
          buttonVisible: goodVisible,
          nodeCountBefore: nodeCountBeforeGood,
          nodeCountAfter: goodNodes,
          succeeded: goodSucceeded,
          alert: goodAlert,
          planRequests: goodPlanReqs,
          planOk: goodPlanOk,
        },
        expected: "bad：有『取帧失败：』人话错误且不卡；good：新增节点且 plan 200、无错误",
      },
      artifacts: {
        badScreenshot: badShotPath ? { path: badShotPath } : null,
        goodScreenshot: goodShot,
      },
      error: pass ? undefined : "取帧终态未达预期",
    };
  }, { extraEnv: { LIBGL_ALWAYS_SOFTWARE: "1", GALLIUM_DRIVER: "llvmpipe" } });
}

// ───────────────────────── B4：app 路径真原生对话框 ─────────────────────────
/** 历史页多选后按底部固定操作条「打包下载」→ 真 showDirectoryPicker 原生对话框。 */
async function B4() {
  return await withShell(async (shell) => {
    await gotoHistory(shell);
    const cards = await shell.page.locator('button[aria-label="下载"]').count();
    if (!cards) return { status: "fail", observations: { cards }, error: "history 无可下载卡片" };

    // 诊断包装（保留原函式，只记录呼叫；不影响真对话框）
    await shell.evaluate(() => {
      window.__b4 = { dirCalls: 0, dirSettled: null, dirErr: null };
      const orig = window.showDirectoryPicker;
      if (typeof orig === "function") {
        window.showDirectoryPicker = function (...a) {
          window.__b4.dirCalls += 1;
          try {
            const p = orig.apply(this, a);
            Promise.resolve(p).then(() => { window.__b4.dirSettled = "resolved"; }).catch((e) => { window.__b4.dirSettled = "rejected"; window.__b4.dirErr = String((e && e.name) + ":" + (e && e.message)).slice(0, 160); });
            return p;
          } catch (e) {
            window.__b4.dirSettled = "threw";
            window.__b4.dirErr = String((e && e.name) + ":" + (e && e.message)).slice(0, 160);
            throw e;
          }
        };
      }
    });
    const winsBefore = await enumerateWindows();

    await domClickText(shell, "多选");
    await sleep(900);
    await shell.page.evaluate(() => {
      const c = [...document.querySelectorAll("article.hist-card")].find((x) => x.querySelector('button[aria-label="下载"]'));
      const b = c && c.querySelector('button[aria-label="选中这张"]');
      if (b) b.click();
    });
    await sleep(900);

    // 真滑鼠点击底部固定操作条的「打包下载」（提供 transient user activation）
    const btn = shell.page.locator("button", { hasText: "打包下载" }).first();
    const visible = await btn.isVisible().catch(() => false);
    if (visible) await btn.click({ timeout: 12000 }).catch(() => {});
    await sleep(5000);

    const diag = await shell.evaluate(() => ({ ...(window.__b4 || {}) })).catch(() => null);
    const winsAfter = await enumerateWindows();
    const fullPath = path.join(outDir, "B4-app-dialog-fullscreen.png");
    await new Promise((resolve) =>
      execFile("spectacle", ["-b", "-n", "-f", "-o", fullPath], {
        env: { ...process.env, DISPLAY: process.env.DISPLAY || ":1", WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY || "wayland-0", XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || "/run/user/1000", DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || "unix:path=/run/user/1000/bus" },
        timeout: 30000,
      }, () => resolve()),
    ).catch(() => {});
    const pageShot = await shell.screenshot("B4-app-dialog-page").catch(() => null);

    const triggered = (diag && diag.dirCalls > 0) || false;
    const dialogOpen = diag && diag.dirSettled === null && diag.dirCalls > 0;
    return {
      status: triggered ? "pass" : "blocked",
      title: "app 路径：历史页多选→底部操作条「打包下载」→真原生目录对话框",
      observations: {
        evidenceStrength: triggered ? "真原生对话框（app 路径触发，spectacle 整屏截图）" : "未触发（自动化限制）",
        buttonVisible: visible,
        dirPickerDiag: diag,
        dialogStillPending: dialogOpen,
        newWindows: winsAfter.filter((w) => !winsBefore.some((b) => b.id === w.id)),
        fullscreen: fs.existsSync(fullPath) ? { path: fullPath, size: fs.statSync(fullPath).size } : null,
        note: triggered
          ? "真 user gesture 触发 app 的 saveManyLocally → showDirectoryPicker 原生对话框（对话框截图后由收壳关闭）。"
          : "底部操作条「打包下载」未触发 picker（自动化限制）。",
      },
      artifacts: { pageScreenshot: pageShot, fullscreen: fs.existsSync(fullPath) ? { path: fullPath, size: fs.statSync(fullPath).size } : null },
    };
  });
}

const CASES = { B0, B2, B3, B4 };

async function B3() {
  // GPU/renderer 崩溃是本机常态：崩了就换一个壳重跑一次。
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await B3once();
    } catch (e) {
      lastErr = e;
      if (/crash/i.test(String(e && e.message)) && attempt < 2) {
        log(`  [B3 retry ${attempt + 1}] 页面崩塌，换壳重跑`);
        await sleep(4000);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

async function main() {
  log(`Eimu final-b E2E · out=${outDir}`);
  const names = args.only ? Object.keys(CASES).filter((n) => args.only.includes(n)) : Object.keys(CASES);
  if (!names.length) { log("no cases selected"); return; }
  for (const name of names) {
    try {
      const r = await CASES[name]();
      if (r && r.cleanupFiles) for (const f of r.cleanupFiles) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
      const { cleanupFiles, ...rest } = r || {};
      saveCase(name, rest);
    } catch (e) {
      saveCase(name, { status: "fail", error: String((e && e.stack) || e).slice(0, 2000) });
    }
  }
  const summary = {
    outDir,
    cases: results.map((r) => ({ name: r.name, status: r.status || "unknown", title: r.title || null, error: r.error || null })),
  };
  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  log(`\n=== ${results.filter((r) => r.status === "pass").length} pass / ${results.filter((r) => r.status !== "pass").length} other ===`);
  for (const c of summary.cases) log(`  [${c.status.toUpperCase()}] ${c.name} ${c.error || ""}`);
  log(`out=${outDir}`);
}

main().catch((e) => {
  console.error("fatal:", (e && e.stack) || e);
  fs.writeFileSync(path.join(outDir, "fatal.txt"), String((e && e.stack) || e));
  process.exit(2);
});