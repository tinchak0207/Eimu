// desktop/scripts/e2e/final-a-cases.mjs
//
// 最终验收代理 A（附件／影片上传路径）——对已部署生产 https://eimu.dev，
// 用真桌面壳 + 真实已登入 profile 逐条验设计意图，每条截图。
//
// 用法：
//   node desktop/scripts/e2e/final-a-cases.mjs --out /tmp/final-a-XXX --assets /tmp/bug1-e2e/assets [--only F1,F2]
//
// 红线：不部署/不 SSH/不连 DB/不呼叫付费上游；送给 agent 的讯息一律只要求分析、禁止生成。
// 本档只新增，不改既有 harness 档。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
const outDir = args.out || path.join("/tmp", `final-a-${Date.now()}`);
const assetsDir = args.assets || "/tmp/bug1-e2e/assets";
fs.mkdirSync(outDir, { recursive: true });
const only = args.only;
const want = (n) => !only || only.includes(n);

const A = {
  goodA: path.join(assetsDir, "good-a.mp4"),
  goodB: path.join(assetsDir, "good-b.mp4"),
  bad: path.join(assetsDir, "bad.mp4"),
};
const sizeOf = (p) => (fs.existsSync(p) ? fs.statSync(p).size : -1);

const results = [];
const log = (...a) => console.log(...a);
function saveCase(name, obj) {
  fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify(obj, null, 2));
  results.push({ ...obj, name });
  log(`▶ ${name}: ${obj.status}${obj.error ? " :: " + obj.error : ""}`);
}

const GEN_HINT = /generate|batch|upscale|generation-jobs|storyboard-voiceover|run-service|canary-service|\/mcp\b|\/media\/|imageedit|video\/generate|music/i;
let MESSAGES_SENT = 0;
let GENERATION_SEEN = [];

// ─────────────────────── 网路录制（同 session-cases 契约）
function attachRecorder(shell) {
  const list = [];
  const byReq = new Map();
  const postByUrl = new Map();
  try {
    const cdp = shell._recCdp || (shell._recCdp = null);
    void cdp;
  } catch { /* ignore */ }
  // CDP session（async 建立，透过 promise 暴露）
  const cdpReady = (async () => {
    const cdp = await shell.context.newCDPSession(shell.page);
    await cdp.send("Network.enable");
    const idMap = new Map();
    cdp.on("Network.requestWillBeSent", (p) => {
      idMap.set(p.requestId, { url: p.request.url, method: p.request.method });
    });
    cdp.on("Network.loadingFinished", async (p) => {
      const info = idMap.get(p.requestId);
      if (!info) return;
      if (!/\/attachments$/.test(info.url) && !/video-upload/.test(info.url)) return;
      try {
        const r = await cdp.send("Network.getRequestPostData", { requestId: p.requestId });
        if (r && r.postData) postByUrl.set(info.url, r.postData);
      } catch { /* body 可能已释放 */ }
    });
    return cdp;
  })().catch(() => null);

  const onRequest = (req) => {
    let entry;
    try {
      const buf = req.postDataBuffer ? req.postDataBuffer() : null;
      let parts = null;
      if (buf && buf.length) {
        const s = buf.toString("latin1");
        const files = [...s.matchAll(/filename="([^"]*)"/g)].map((m) => m[1]);
        const names = [...s.matchAll(/name="([^"]+)"/g)].map((m) => m[1]);
        parts = files.length ? files : names;
      }
      entry = {
        ts: Date.now(), url: req.url(), method: req.method(), resourceType: req.resourceType(),
        postBytes: buf ? buf.length : null, parts, status: null, responseBodySize: null, failed: false,
      };
    } catch (e) {
      entry = { ts: Date.now(), url: req.url(), method: req.method(), err: String(e && e.message) };
    }
    byReq.set(req, entry);
    list.push(entry);
  };
  const onDone = async (req) => {
    const e = byReq.get(req);
    if (!e) return;
    try {
      const s = await req.sizes();
      if (s) { e.requestBodySize = s.requestBodySize; e.responseBodySize = s.responseBodySize; }
    } catch { /* ignore */ }
    try {
      const r = await req.response();
      e.status = r ? r.status() : null;
      if (r && (/\/attachments$/.test(e.url) || /video-upload/.test(e.url))) {
        const t = await r.text();
        try { e.responseJson = JSON.parse(t); } catch { e.responseText = t.slice(0, 2000); }
      }
    } catch { /* ignore */ }
    const cdp = await cdpReady;
    if (cdp) {
      const post = postByUrl.get(e.url);
      if (post) {
        e.cdpPostBytes = post.length;
        const files = [...post.matchAll(/filename="([^"]*)"/g)].map((m) => m[1]);
        const names = [...post.matchAll(/name="([^"]+)"/g)].map((m) => m[1]);
        e.cdpParts = files.length ? files : names;
        if (!e.parts) e.parts = e.cdpParts;
      }
    }
  };
  const onFail = (req) => {
    const e = byReq.get(req);
    if (e) { e.failed = true; e.failure = (req.failure() && req.failure().errorText) || "unknown"; }
  };
  const onConsole = (msg) => {
    if (msg.type() === "error") list.push({ ts: Date.now(), console: "error", text: msg.text() });
  };
  shell.page.on("request", onRequest);
  shell.page.on("requestfinished", onDone);
  shell.page.on("requestfailed", onFail);
  shell.page.on("console", onConsole);
  return {
    all: () => list.slice(),
    since: (ts) => list.filter((e) => e.ts >= ts),
    mark: () => Date.now(),
    scanGen: (ts) => list.filter((e) => e.ts >= ts && e.url && ["POST", "PUT", "PATCH"].includes(e.method) && GEN_HINT.test(e.url)).map((e) => e.url),
    scanConsoleErrors: (ts) => list.filter((e) => e.ts >= ts && e.console === "error").map((e) => e.text),
  };
}

const netLine = (e) => ({
  ts: e.ts, method: e.method, url: e.url, status: e.status, failed: e.failed, failure: e.failure || null,
  postBytes: e.postBytes ?? null, cdpPostBytes: e.cdpPostBytes ?? null,
  parts: e.parts || e.cdpParts || null, responseJson: e.responseJson ?? null, responseText: e.responseText ?? null,
});

// ─────────────────────── 页面探针
async function probeComposer(shell) {
  return await shell.evaluate(() => {
    const inputs = [...document.querySelectorAll("#agent-composer-input")];
    const ta = inputs.find((i) => i.offsetParent !== null) || inputs[0] || null;
    const send = document.querySelector('[aria-label="发送"]');
    const chips = [...document.querySelectorAll('[aria-label^="移除 "]')].map((btn) => {
      const el = btn.closest("span");
      const cls = (el && el.className) || "";
      const txt = (el && el.innerText) || "";
      return { text: txt.trim(), spinning: !!(el && el.querySelector(".animate-spin")), isError: cls.includes("destructive"), extracting: txt.includes("抽帧") };
    });
    const frames = [...document.querySelectorAll('img[alt^="第 "]')].map((i) => i.alt);
    const videos = [...document.querySelectorAll('video[aria-label^="原片："]')].map((v) => v.getAttribute("aria-label"));
    return {
      url: location.href,
      composerCount: inputs.length,
      hasVisibleComposer: !!(ta && ta.offsetParent !== null),
      sendDisabled: send ? send.disabled : null,
      sendAriaBusy: send ? send.getAttribute("aria-busy") : null,
      chips, chipCount: chips.length,
      uploadingChips: chips.filter((c) => c.spinning || c.extracting).length,
      errorChips: chips.filter((c) => c.isError).length,
      frameCount: frames.length, frameAlts: frames, videoPreviews: videos,
    };
  });
}

async function probeDom(shell) {
  return await shell.evaluate(() => {
    const fileInputs = [...document.querySelectorAll('input[type="file"]')].map((i) => ({
      accept: i.getAttribute("accept"), hidden: i.offsetParent === null,
      mp4: (i.getAttribute("accept") || "").includes(".mp4"),
    }));
    const dropTargets = document.querySelectorAll(".agent-composer").length;
    const labels = [...document.querySelectorAll("[aria-label]")].map((e) => e.getAttribute("aria-label")).filter(Boolean).slice(0, 60);
    const inputs = [...document.querySelectorAll("#agent-composer-input")].map((i) => ({ hidden: i.offsetParent === null, value: i.value }));
    return { fileInputs, dropTargets, labels, composers: inputs };
  });
}

async function waitComposer(shell, timeout = 40000) {
  await shell.page.waitForFunction(
    () => [...document.querySelectorAll("#agent-composer-input")].some((i) => i.offsetParent !== null),
    undefined, { timeout },
  );
}

async function waitChipsSettled(shell, timeout) {
  await shell.page.waitForFunction(
    () => {
      const chips = [...document.querySelectorAll('[aria-label^="移除 "]')].map((b) => b.closest("span"));
      if (chips.length === 0) return false;
      return chips.every((el) => el && !el.querySelector(".animate-spin") && !(el.innerText || "").includes("抽帧"));
    },
    undefined, { timeout },
  );
}

async function waitChipsSettledSafe(shell, timeout = 240000) {
  try { await waitChipsSettled(shell, timeout); return true; } catch { return false; }
}

async function clearChips(shell) {
  for (let i = 0; i < 12; i++) {
    const btns = shell.page.locator('[aria-label^="移除 "]');
    const n = await btns.count();
    if (!n) break;
    await btns.first().click({ timeout: 5000 }).catch(() => {});
    await shell.page.waitForTimeout(120);
  }
}

async function reloadFresh(shell) {
  await shell.page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
  await waitComposer(shell, 60000);
  await sleep(2600); // 等 hydration（React onChange 需要）
}

// ─────────────────────── 附件入口
const TARGET_ATTR = "data-final-a-target";

async function pickFileInputNodeId(shell) {
  await shell.page.evaluate((attr) => {
    let inputs = [...document.querySelectorAll('input[type="file"][accept*=".mp4"]')];
    if (!inputs.length) inputs = [...document.querySelectorAll('input[type="file"]')];
    const vis = inputs.find((i) => i.offsetParent !== null) || inputs[0];
    if (!vis) throw new Error("找不到 file input");
    document.querySelectorAll(`[${attr}]`).forEach((e) => e.removeAttribute(attr));
    vis.setAttribute(attr, "1");
  }, TARGET_ATTR);
  if (!shell._e2eCdp) {
    shell._e2eCdp = await shell.context.newCDPSession(shell.page);
    await shell._e2eCdp.send("DOM.enable");
  }
  const { root } = await shell._e2eCdp.send("DOM.getDocument", { depth: -1 });
  const { nodeId } = await shell._e2eCdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: `input[${TARGET_ATTR}="1"]` });
  if (!nodeId) throw new Error("file input nodeId 为空");
  return nodeId;
}

async function attachFiles(shell, files) {
  const list = Array.isArray(files) ? files : [files];
  const nodeId = await pickFileInputNodeId(shell);
  await shell._e2eCdp.send("DOM.setFileInputFiles", { files: list, nodeId });
  await shell.page.evaluate((attr) => document.querySelector(`[${attr}]`)?.removeAttribute(attr), TARGET_ATTR);
}

function fileToBase64(p) { return fs.readFileSync(p).toString("base64"); }

/** 真拖放：在 .agent-composer 上派发 dragenter→dragover→drop（DataTransfer 带 File）。 */
async function dropFile(shell, filePath, mime = "video/mp4") {
  const b64 = fileToBase64(filePath);
  const name = path.basename(filePath);
  return await shell.evaluate(async ({ b64, name, mime }) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bin], name, { type: mime });
    const dt = new DataTransfer();
    dt.items.add(file);
    const target = document.querySelector(".agent-composer");
    if (!target) throw new Error("找不到 .agent-composer 拖放目标");
    const mk = (type) => new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt });
    target.dispatchEvent(mk("dragenter"));
    target.dispatchEvent(mk("dragover"));
    const drop = mk("drop");
    target.dispatchEvent(drop);
    return { targetFound: true, defaultPrevented: drop.defaultPrevented, filesInDt: dt.files.length };
  }, { b64, name, mime });
}

/** 真贴上：在可见 textarea 派发 paste（clipboardData 带 File）。 */
async function pasteFile(shell, filePath, mime = "video/mp4") {
  const b64 = fileToBase64(filePath);
  const name = path.basename(filePath);
  return await shell.evaluate(async ({ b64, name, mime }) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bin], name, { type: mime });
    const dt = new DataTransfer();
    dt.items.add(file);
    const inputs = [...document.querySelectorAll("#agent-composer-input")];
    const ta = inputs.find((i) => i.offsetParent !== null) || inputs[0];
    if (!ta) throw new Error("找不到可见 composer textarea");
    const ev = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt });
    ta.dispatchEvent(ev);
    return { targetFound: true, defaultPrevented: ev.defaultPrevented, filesInClipboard: dt.files.length };
  }, { b64, name, mime });
}

// ─────────────────────── 讯息（只分析、禁生成）
async function setText(shell, text) {
  await shell.evaluate((t) => {
    const inputs = [...document.querySelectorAll("#agent-composer-input")];
    const ta = inputs.find((i) => i.offsetParent !== null) || inputs[0];
    if (!ta) throw new Error("找不到 textarea");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(ta, t);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }, text);
}

async function sendText(shell) {
  const clicked = await shell.evaluate(() => {
    const btn = document.querySelector('[aria-label="发送"]');
    if (!btn || btn.disabled) return false;
    btn.click();
    return true;
  });
  return clicked;
}

async function waitAgentIdle(shell, timeout = 150000) {
  const t0 = Date.now();
  await sleep(1800);
  let idleStreak = 0;
  while (Date.now() - t0 < timeout) {
    const s = await shell.evaluate(() => {
      const send = document.querySelector('[aria-label="发送"]');
      const stop = document.querySelector('[aria-label="中止助理生成"]');
      const inputs = [...document.querySelectorAll("#agent-composer-input")];
      const ta = inputs.find((i) => i.offsetParent !== null) || inputs[0];
      const busy = !!stop || (send && send.getAttribute("aria-busy") === "true") || (ta && ta.disabled);
      return { busy, hasSend: !!send };
    });
    if (!s.busy && s.hasSend) { idleStreak += 1; if (idleStreak >= 3) return { idle: true, elapsedMs: Date.now() - t0 }; }
    else idleStreak = 0;
    await sleep(1200);
  }
  return { idle: false, elapsedMs: Date.now() - t0 };
}

async function sendAndWait(shell, text, timeout = 150000) {
  await setText(shell, text);
  const sent = await sendText(shell);
  if (!sent) return { sent: false, idle: false, elapsedMs: 0 };
  MESSAGES_SENT += 1;
  const r = await waitAgentIdle(shell, timeout);
  return { sent: true, idle: r.idle, elapsedMs: r.elapsedMs };
}

// ─────────────────────── 主流程
let shell, rec;

/** 统一的附件观测计算。 */
function analyze(rec, t0, origNames = []) {
  const since = rec.since(t0);
  const att = since.filter((e) => e.method === "POST" && /\/attachments$/.test(e.url || ""));
  const vid = since.filter((e) => e.method === "POST" && /video-upload/.test(e.url || ""));
  const tick = since.filter((e) => e.method === "POST" && /uploads-ticket/.test(e.url || ""));
  const derivedNames = att.flatMap((e) => {
    const arr = e.responseJson && Array.isArray(e.responseJson.attachments) ? e.responseJson.attachments : null;
    return arr ? arr.map((a) => a.name) : (e.parts || []);
  });
  const allParts = since.flatMap((e) => e.parts || e.cdpParts || []);
  const origSeenInParts = origNames.filter((n) => allParts.some((p) => p === n));
  const derivedPattern = /-(keyframe-\d+\.jpg|poster\.jpg|probe\.json)$/;
  const derivedSeen = derivedNames.some((n) => derivedPattern.test(n));
  const vidParts = vid.flatMap((e) => e.parts || e.cdpParts || []);
  const origInVideoUpload = origNames.filter((n) => vidParts.some((p) => p === n));
  // 伺服器回应是权威来源（multipart 的 CDP postData 对跨域请求可能拿不到）。
  const vidRespNames = vid.map((e) => e.responseJson && e.responseJson.name).filter(Boolean);
  const vidRespSizes = vid.map((e) => e.responseJson && e.responseJson.size).filter((s) => typeof s === "number");
  const originalUploadedViaVideoUpload = [...new Set([
    ...origInVideoUpload,
    ...origNames.filter((n) => vidRespNames.includes(n)),
  ])];
  return {
    attachmentsRequests: att.length, attachmentURLs: att.map((e) => e.url),
    videoUploadRequests: vid.length, videoUploadURLs: vid.map((e) => e.url),
    ticketRequests: tick.length,
    derivedNames, derivedSeen,
    videoUploadRespNames: vidRespNames, videoUploadRespSizes: vidRespSizes,
    originalUploadedViaVideoUpload,
    originalSeenInAnyParts: origSeenInParts,
    anyPostBytes: since.filter((e) => ["POST", "PUT", "PATCH"].includes(e.method) && e.url).map((e) => ({ ts: e.ts, m: e.method, u: e.url, bytes: e.cdpPostBytes ?? e.postBytes, status: e.status })),
    net: att.map(netLine).concat(vid.map(netLine)),
  };
}

async function main() {
  if (!fs.existsSync(A.goodA) || !fs.existsSync(A.bad)) {
    console.error(`缺少素材：${A.goodA} / ${A.bad}`); process.exit(2);
  }
  log(`最终验收 A（附件／影片上传路径）`);
  log(`out=${outDir}`);
  log(`good-a=${sizeOf(A.goodA)}B bad=${sizeOf(A.bad)}B`);

  shell = await launchShell({ outDir, seedProfileFrom: REAL_PROFILE, viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  rec = attachRecorder(shell);
  try {
    await waitComposer(shell, 60000).catch(() => {});
    await sleep(2600);
    const dom = await probeDom(shell);
    fs.writeFileSync(path.join(outDir, "F0-dom.json"), JSON.stringify(dom, null, 2));
    log(`F0 dom: composers=${dom.composers.length} mp4Inputs=${dom.fileInputs.filter((f) => f.mp4).length} dropTargets=${dom.dropTargets}`);

    // ───────── F1：好影片 → 只上传衍生档 ─────────
    if (want("F1")) {
      await reloadFresh(shell);
      const t0 = rec.mark();
      const before = await probeComposer(shell);
      await attachFiles(shell, A.goodA);
      const settled = await waitChipsSettledSafe(shell, 180000);
      await sleep(1200);
      const after = await probeComposer(shell);
      const an = analyze(rec, t0, ["good-a.mp4"]);
      const shot = await shell.screenshot("F1-good-derived");
      const pass = settled && after.chipCount >= 1 && after.uploadingChips === 0 && after.errorChips === 0
        && an.attachmentsRequests >= 1 && an.videoUploadRequests === 0 && an.derivedSeen
        && an.originalUploadedViaVideoUpload.length === 0;
      saveCase("F1", {
        status: pass ? "pass" : "fail",
        intent: "好影片附件 → 本机探测／抽帧／海报，只上传衍生档，不上传原档",
        observations: { settled, beforeChips: before.chipCount, chipCount: after.chipCount, uploadingChips: after.uploadingChips, errorChips: after.errorChips, frameCount: after.frameCount, frameAlts: after.frameAlts.slice(0, 6), videoPreviews: after.videoPreviews, chips: after.chips, ...an },
        artifacts: { screenshot: shot },
        error: pass ? undefined : "判准未达（见 observations）",
      });
    }

    // ───────── F2：不可解码影片 → 降级执行（video-upload）＋终态 ─────────
    if (want("F2")) {
      await reloadFresh(shell);
      const t0 = rec.mark();
      const attachT0 = Date.now();
      await attachFiles(shell, A.bad);
      // ingest 上限 30s + 直传 180s 上限 → 宽松 260s
      const settled = await waitChipsSettledSafe(shell, 260000);
      const settleMs = Date.now() - attachT0;
      await sleep(1500);
      const after = await probeComposer(shell);
      const an = analyze(rec, t0, ["bad.mp4"]);
      const shot = await shell.screenshot("F2-bad-fallback");
      const stuck = after.chips.filter((c) => c.spinning || c.extracting);
      const hasTerminal = after.chipCount >= 1 && stuck.length === 0;
      const pass = settled && hasTerminal && an.videoUploadRequests >= 1 && an.originalUploadedViaVideoUpload.length >= 1;
      saveCase("F2", {
        status: pass ? "pass" : "fail",
        intent: "不可解码影片 → 不永卡、降级真的执行（video-upload）、有终态",
        observations: { settleMs, settled, chipCount: after.chipCount, uploadingChips: after.uploadingChips, errorChips: after.errorChips, stuckChips: stuck, chips: after.chips, ...an },
        artifacts: { screenshot: shot },
        error: pass ? undefined : "判准未达（见 observations）",
      });
    }

    // ───────── F3：多档混批（好＋坏）─────────
    if (want("F3")) {
      await reloadFresh(shell);
      const t0 = rec.mark();
      await attachFiles(shell, [A.goodA, A.bad]);
      const settled = await waitChipsSettledSafe(shell, 260000);
      await sleep(1500);
      const after = await probeComposer(shell);
      const an = analyze(rec, t0, ["good-a.mp4", "bad.mp4"]);
      const shot = await shell.screenshot("F3-mixed-batch");
      const stuck = after.chips.filter((c) => c.spinning || c.extracting);
      const goodChip = after.chips.find((c) => /good-a/.test(c.text));
      const badChip = after.chips.find((c) => /bad/.test(c.text));
      const pass = settled && after.chipCount >= 2 && stuck.length === 0 && !!goodChip && !goodChip.isError && !!badChip;
      saveCase("F3", {
        status: pass ? "pass" : "fail",
        intent: "多档混批（好＋坏）→ 坏档不影响好档，全部 chip 落终态",
        observations: { settled, chipCount: after.chipCount, uploadingChips: after.uploadingChips, errorChips: after.errorChips, stuckChips: stuck, goodChip: goodChip || null, badChip: badChip || null, chips: after.chips, ...an },
        artifacts: { screenshot: shot },
        error: pass ? undefined : "判准未达（见 observations）",
      });
    }

    // ───────── F4：链式降级 ─────────
    // attachments 失败 → video-upload（由 F2 的 ingest-degraded 自然路径证明）；
    // 两者都失败 → 明确 error 终态，需故障注入（不可为之），此处只记录设计与可观测部分。
    if (want("F4")) {
      await reloadFresh(shell);
      // 走「本机 ingest 失败→原档直传」这条（F2 的坏档）作为 attachments 段不可用的替代证据。
      const t0 = rec.mark();
      await attachFiles(shell, A.bad);
      const settled = await waitChipsSettledSafe(shell, 260000);
      await sleep(1200);
      const after = await probeComposer(shell);
      const an = analyze(rec, t0, ["bad.mp4"]);
      const shot = await shell.screenshot("F4-chain-degrade");
      const observed = {
        chainTriggersVideoUpload: an.videoUploadRequests >= 1,
        terminalNoStuck: after.chipCount >= 1 && after.chips.every((c) => !c.spinning && !c.extracting),
        errorTerminalSeen: after.errorChips >= 1,
      };
      saveCase("F4", {
        status: "partial",
        intent: "链式降级：attachments 失败 → video-upload；两者都失败 → 明确 error 终态",
        observations: { settled, ...observed, chips: after.chips, ...an,
          limitation: "「两者都失败→error 终态」需故障注入（人工断网/改端点），红线禁连 VPS/改网，故只验到第一段降级；error 终态由 F2 逾时分支与既有 harness A18 覆盖" },
        artifacts: { screenshot: shot },
      });
      saveCase("F4-note", { status: "info", note: "第二段（attachments 与 video-upload 皆失败）本轮无法在不故障注入下观测。" });
    }

    // ───────── F4a：链式降级第一段（attachments 失败 → video-upload）─────────
    // 本机 CDP 阻挡 attachments 端点（请求根本没送出，非改网/不碰 VPS）：
    // 好档 ingest 成功 → 衍生档上行被挡 → 落回原档直传 video-upload（成功）。
    if (want("F4a")) {
      await reloadFresh(shell);
      const cdp = await shell.context.newCDPSession(shell.page);
      await cdp.send("Network.enable");
      await cdp.send("Network.setBlockedURLs", { urls: ["*attachments*"] });
      const t0 = rec.mark();
      await attachFiles(shell, A.goodA);
      const settled = await waitChipsSettledSafe(shell, 200000);
      await sleep(1200);
      const after = await probeComposer(shell);
      const an = analyze(rec, t0, ["good-a.mp4"]);
      const shot = await shell.screenshot("F4a-attachments-fail-to-video-upload");
      await cdp.send("Network.setBlockedURLs", { urls: [] }).catch(() => {});
      const stuck = after.chips.filter((c) => c.spinning || c.extracting);
      const pass = settled && after.chipCount >= 1 && stuck.length === 0 && an.videoUploadRequests >= 1
        && an.videoUploadRespNames.includes("good-a.mp4");
      saveCase("F4a", {
        status: pass ? "pass" : "fail",
        intent: "链式降级第一段：attachments 失败 → video-upload（原档直传成功）",
        observations: { settled, chipCount: after.chipCount, uploadingChips: after.uploadingChips, errorChips: after.errorChips, stuckChips: stuck, chips: after.chips, blockedAttachments: true, ...an },
        artifacts: { screenshot: shot },
        error: pass ? undefined : "判准未达（见 observations）",
      });
    }

    // ───────── F4b：链式降级第二段（两者皆失败 → 明确 error 终态，非永卡）─────────
    if (want("F4b")) {
      await reloadFresh(shell);
      const cdp = await shell.context.newCDPSession(shell.page);
      await cdp.send("Network.enable");
      await cdp.send("Network.setBlockedURLs", { urls: ["*attachments*", "*video-upload*"] });
      const t0 = rec.mark();
      await attachFiles(shell, A.goodA);
      const settled = await waitChipsSettledSafe(shell, 200000);
      await sleep(1200);
      const after = await probeComposer(shell);
      const an = analyze(rec, t0, ["good-a.mp4"]);
      const shot = await shell.screenshot("F4b-both-fail-error-terminal");
      await cdp.send("Network.setBlockedURLs", { urls: [] }).catch(() => {});
      const stuck = after.chips.filter((c) => c.spinning || c.extracting);
      const pass = settled && after.chipCount >= 1 && stuck.length === 0 && after.errorChips >= 1;
      saveCase("F4b", {
        status: pass ? "pass" : "fail",
        intent: "链式降级第二段：attachments 与 video-upload 皆失败 → 明确 error 终态（非永卡）",
        observations: { settled, chipCount: after.chipCount, uploadingChips: after.uploadingChips, errorChips: after.errorChips, stuckChips: stuck, chips: after.chips, blockedAttachmentsAndVideoUpload: true, ...an },
        artifacts: { screenshot: shot },
        error: pass ? undefined : "判准未达（见 observations）",
      });
    }

    // ───────── F5：上传中并发互动（切思考级别／模式）─────────
    if (want("F5")) {
      await reloadFresh(shell);
      // 坏档修复后 ~2s 就落地，没有「上传中」窗口 → 用 CDP 限流把上行压到 40KB/s
      // （1.5MB ≈ 37s），制造真实 in-flight 窗口再切设定。
      const cdp = await shell.context.newCDPSession(shell.page);
      await cdp.send("Network.enable");
      let throttled = false;
      try {
        await cdp.send("Network.emulateNetworkConditions", {
          offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: 40 * 1024,
        });
        throttled = true;
      } catch { /* 限流失败则退回无窗口版本 */ }
      const t0 = rec.mark();
      await attachFiles(shell, A.bad);
      // 等「video-upload 已在途」（entry 存在且 status 仍 null）＝真 in-flight。
      let inFlight = false;
      const waitStart = Date.now();
      while (Date.now() - waitStart < 30000) {
        const e = rec.since(t0).find((x) => /video-upload/.test(x.url || "") && x.status === null && !x.failed);
        if (e) { inFlight = true; break; }
        await sleep(300);
      }
      const duringProbe = await probeComposer(shell);
      const inFlightShot = await shell.screenshot("F5-in-flight");
      // 真设定互动：开思考级别下拉、选另一级
      let switchResult = null;
      try {
        const btn = shell.page.locator('[aria-label^="思考级别："]').first();
        await btn.click({ timeout: 8000 });
        await sleep(500);
        const openShot = await shell.screenshot("F5-during-upload-dropdown-open");
        const opts = shell.page.locator('[role="listbox"][aria-label="思考级别"] [role="option"]');
        const optCount = await opts.count();
        await opts.first().click({ timeout: 8000 });
        await sleep(500);
        const label = await shell.evaluate(() => {
          const b = document.querySelector('[aria-label^="思考级别："]');
          return b ? b.getAttribute("aria-label") : null;
        });
        switchResult = { opened: true, optCount, labelAfter: label, openShot };
      } catch (e) {
        switchResult = { opened: false, err: String(e && e.message) };
      }
      // 切完设定：确认附件仍在（未被互动打断）
      const afterInteract = await probeComposer(shell);
      const stillUploadingOrSettled = afterInteract.chipCount >= 1;
      // 解除限流，等落地
      if (throttled) {
        await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }).catch(() => {});
      }
      const settled = await waitChipsSettledSafe(shell, 260000);
      await sleep(1200);
      const after = await probeComposer(shell);
      const an = analyze(rec, t0, ["bad.mp4"]);
      const shot = await shell.screenshot("F5-after-switch");
      const pass = inFlight && switchResult && switchResult.opened && stillUploadingOrSettled && settled
        && after.chipCount >= 1 && after.uploadingChips === 0 && an.videoUploadRequests >= 1
        && an.videoUploadRespNames.includes("bad.mp4");
      saveCase("F5", {
        status: pass ? "pass" : "fail",
        intent: "上传中的并发互动（切设定／切模式）不打断附件",
        observations: { throttled, inFlight, duringProbeChips: duringProbe.chips, afterInteractChips: afterInteract.chips, stillUploadingOrSettled, switchResult, settled, chipCount: after.chipCount, uploadingChips: after.uploadingChips, errorChips: after.errorChips, chips: after.chips, ...an },
        artifacts: { screenshot: shot, inFlightShot, duringOpen: switchResult && switchResult.openShot },
        error: pass ? undefined : "判准未达（见 observations）",
      });
    }

    // ───────── F6：真拖放入口 ─────────
    if (want("F6")) {
      await reloadFresh(shell);
      const t0 = rec.mark();
      const dropR = await dropFile(shell, A.goodA);
      const appeared = await shell.page.waitForFunction(
        () => document.querySelectorAll('[aria-label^="移除 "]').length > 0,
        undefined, { timeout: 20000 },
      ).then(() => true).catch(() => false);
      const settled = await waitChipsSettledSafe(shell, 180000);
      await sleep(1200);
      const after = await probeComposer(shell);
      const an = analyze(rec, t0, ["good-a.mp4"]);
      const shot = await shell.screenshot("F6-drag-drop");
      const pass = dropR.defaultPrevented && appeared && settled && after.chipCount >= 1 && after.uploadingChips === 0 && an.derivedSeen && an.videoUploadRequests === 0;
      saveCase("F6", {
        status: pass ? "pass" : "fail",
        intent: "真拖放（drag-drop）入口与 input 选档等价",
        observations: { dropResult: dropR, chipAppeared: appeared, settled, chipCount: after.chipCount, uploadingChips: after.uploadingChips, chips: after.chips, ...an },
        artifacts: { screenshot: shot },
        error: pass ? undefined : "判准未达（见 observations）",
      });
    }

    // ───────── F7：贴上入口 ─────────
    if (want("F7")) {
      await reloadFresh(shell);
      const t0 = rec.mark();
      const pasteR = await pasteFile(shell, A.goodA);
      const appeared = await shell.page.waitForFunction(
        () => document.querySelectorAll('[aria-label^="移除 "]').length > 0,
        undefined, { timeout: 20000 },
      ).then(() => true).catch(() => false);
      const settled = await waitChipsSettledSafe(shell, 180000);
      await sleep(1200);
      const after = await probeComposer(shell);
      const an = analyze(rec, t0, ["good-a.mp4"]);
      const shot = await shell.screenshot("F7-paste");
      const pass = pasteR.defaultPrevented && appeared && settled && after.chipCount >= 1 && after.uploadingChips === 0 && an.derivedSeen && an.videoUploadRequests === 0;
      saveCase("F7", {
        status: pass ? "pass" : "fail",
        intent: "贴上（paste）入口与 input 选档等价",
        observations: { pasteResult: pasteR, chipAppeared: appeared, settled, chipCount: after.chipCount, uploadingChips: after.uploadingChips, chips: after.chips, ...an },
        artifacts: { screenshot: shot },
        error: pass ? undefined : "判准未达（见 observations）",
      });
    }

    // ───────── F8：长对话多轮后再上传 ─────────
    if (want("F8")) {
      await reloadFresh(shell);
      const msgs = [
        "请用一句话说明你作为影像工作台助理的核心职责，只做文字说明，不要调用任何生成类工具。",
        "记住数字 42，只回复“已记住”。",
        "刚才让你记住的数字是多少？只回复该数字。",
      ];
      const turns = [];
      const tMsg0 = rec.mark();
      for (const m of msgs) {
        const r = await sendAndWait(shell, m, 150000);
        turns.push(r);
        if (!r.sent) break;
      }
      const genDuringChat = rec.scanGen(tMsg0);
      GENERATION_SEEN.push(...genDuringChat);
      const chatShot = await shell.screenshot("F8-long-chat");
      const t0 = rec.mark();
      await attachFiles(shell, A.goodA);
      const settled = await waitChipsSettledSafe(shell, 180000);
      await sleep(1200);
      const after = await probeComposer(shell);
      const an = analyze(rec, t0, ["good-a.mp4"]);
      const shot = await shell.screenshot("F8-upload-after-long-chat");
      const pass = settled && after.chipCount >= 1 && after.uploadingChips === 0 && an.derivedSeen && an.videoUploadRequests === 0 && genDuringChat.length === 0;
      saveCase("F8", {
        status: pass ? "pass" : "fail",
        intent: "长对话多轮后再上传 → 照常、无残留",
        observations: { turns, messagesSentThisCase: turns.filter((t) => t.sent).length, generationDuringChat: genDuringChat, settled, chipCount: after.chipCount, uploadingChips: after.uploadingChips, errorChips: after.errorChips, chips: after.chips, ...an },
        artifacts: { screenshot: shot, chatScreenshot: chatShot },
        error: pass ? undefined : "判准未达（见 observations）",
      });
    }
  } finally {
    await shell.close().catch(() => {});
  }

  const summary = {
    outDir,
    total: results.length,
    pass: results.filter((r) => r.status === "pass").length,
    fail: results.filter((r) => r.status === "fail").length,
    partial: results.filter((r) => r.status === "partial").length,
    messagesSent: MESSAGES_SENT,
    generationSeen: GENERATION_SEEN,
    results: results.map((r) => ({ name: r.name, status: r.status, error: r.error || null })),
  };
  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  log(`\n=== ${summary.pass} pass / ${summary.fail} fail / ${summary.partial} partial · messages=${MESSAGES_SENT} · genSeen=${GENERATION_SEEN.length} ===`);
  log(`结果目录：${outDir}`);
}

main().catch((e) => { console.error("fatal:", (e && e.stack) || e); process.exit(2); });