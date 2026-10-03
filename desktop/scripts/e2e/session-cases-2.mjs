// desktop/scripts/e2e/session-cases-2.mjs
//
// 第二批「複雜會話」E2E（B3/B8/B9/B10/DROP/PASTE）。
//
// 紅線遵守：
//   · 只讀複製 ~/.config/Eimu（seedProfileFrom），絕不修改原始 profile。
//   · 不部署/不 SSH/不連 DB/不呼叫付費上游。只打生產站內附件端點（免費）。
//   · 送給 agent 的訊息總數 ≤ 10，且一律只要求「分析/描述」；若觀察到生成型請求
//     立即記錄並停止後續送訊息。
//   · 輸出到 /tmp（不寫 repo）。
//
// 用法：
//   node desktop/scripts/e2e/session-cases-2.mjs --out /tmp/eimu-e2e2-XXX --assets /tmp/eimu-e2e2-assets \
//        [--only B3,B8,B9,B10,DROP,PASTE]
//
// 產物：outDir/<case>.json、outDir/shell/<case>.png、outDir/summary.json

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { launchShell, stopChild, freePort, DEFAULT_BINARY } from "./harness.mjs";

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

// ─────────────────────── 網路錄製（copy 自 session-cases.mjs，不得改既有檔）
async function attachRecorder(shell) {
  const list = [];
  const byReq = new Map();
  const postByUrl = new Map();
  try {
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
      } catch {
        /* body 已釋放 */
      }
    });
  } catch {
    /* ignore */
  }
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
        ts: Date.now(),
        url: req.url(),
        method: req.method(),
        resourceType: req.resourceType(),
        postBytes: buf ? buf.length : null,
        parts,
        status: null,
        requestBodySize: null,
        responseBodySize: null,
        failed: false,
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
      if (s) {
        e.requestBodySize = s.requestBodySize;
        e.responseBodySize = s.responseBodySize;
      }
    } catch {
      /* ignore */
    }
    try {
      const r = await req.response();
      e.status = r ? r.status() : null;
      if (r && (/\/attachments$/.test(e.url) || /video-upload/.test(e.url))) {
        const t = await r.text();
        try {
          e.responseJson = JSON.parse(t);
        } catch {
          e.responseText = t.slice(0, 2000);
        }
      }
    } catch {
      /* ignore */
    }
    const post = postByUrl.get(e.url);
    if (post) {
      e.cdpPostBytes = post.length;
      const files = [...post.matchAll(/filename="([^"]*)"/g)].map((m) => m[1]);
      const names = [...post.matchAll(/name="([^"]+)"/g)].map((m) => m[1]);
      e.cdpParts = files.length ? files : names;
      if (!e.parts) e.parts = e.cdpParts;
    }
  };
  const onFail = (req) => {
    const e = byReq.get(req);
    if (e) {
      e.failed = true;
      e.failure = (req.failure() && req.failure().errorText) || "unknown";
    }
  };
  const onConsole = (msg) => {
    if (msg.type() === "error") list.push({ ts: Date.now(), console: "error", text: msg.text() });
  };
  shell.page.on("request", onRequest);
  shell.page.on("requestfinished", onDone);
  shell.page.on("requestfailed", onFail);
  shell.page.on("console", onConsole);
  shell.context.on("page", (p) => {
    p.on("request", onRequest);
    p.on("requestfinished", onDone);
    p.on("requestfailed", onFail);
    p.on("console", onConsole);
  });
  return { all: () => list.slice(), since: (ts) => list.filter((e) => e.ts >= ts), mark: () => Date.now() };
}

// ─────────────────────── 頁面探針
async function probeComposer(shell) {
  return await shell.evaluate(() => {
    const ta = document.querySelector("#agent-composer-input");
    const send = document.querySelector('[aria-label="发送"]');
    const stop = document.querySelector('[aria-label="中止助理生成"]');
    const input = document.querySelector('input[type="file"][accept*=".mp4"]');
    const chips = [...document.querySelectorAll('[aria-label^="移除 "]')].map((btn) => {
      const el = btn.closest("span");
      const cls = (el && el.className) || "";
      const txt = (el && el.innerText) || "";
      return { text: txt.trim(), spinning: !!(el && el.querySelector(".animate-spin")), isError: cls.includes("destructive"), extracting: txt.includes("抽帧") };
    });
    const frames = [...document.querySelectorAll('img[alt^="第 "]')].map((i) => i.alt);
    const videos = [...document.querySelectorAll('video[aria-label^="原片："]')].map((v) => v.getAttribute("aria-label"));
    const levelBtn = document.querySelector('[aria-label^="思考级别"]');
    return {
      url: location.href,
      hasTextarea: !!ta,
      hasFileInput: !!input,
      sendDisabled: send ? send.disabled : null,
      sendAriaBusy: send ? send.getAttribute("aria-busy") : null,
      stopVisible: !!stop,
      textareaDisabled: ta ? ta.disabled : null,
      thinkingLevel: levelBtn ? levelBtn.getAttribute("aria-label") : null,
      chips,
      chipCount: chips.length,
      uploadingChips: chips.filter((c) => c.spinning || c.extracting).length,
      errorChips: chips.filter((c) => c.isError).length,
      frameCount: frames.length,
      frameAlts: frames,
      videoPreviews: videos,
      bodyText: document.body ? document.body.innerText.slice(0, 3000) : "",
    };
  });
}

async function waitComposer(shell, timeout = 40000) {
  await shell.page.waitForSelector("#agent-composer-input", { state: "visible", timeout });
}

async function waitChipsSettled(shell, timeout = 240000) {
  await shell.page.waitForFunction(
    () => {
      const chips = [...document.querySelectorAll('[aria-label^="移除 "]')].map((b) => b.closest("span"));
      if (chips.length === 0) return false;
      return chips.every((el) => {
        if (!el) return false;
        const txt = el.innerText || "";
        return !el.querySelector(".animate-spin") && !txt.includes("抽帧");
      });
    },
    undefined,
    { timeout },
  );
}
async function waitChipsSettledSafe(shell, timeout = 240000) {
  try {
    await waitChipsSettled(shell, timeout);
    return true;
  } catch {
    return false;
  }
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

async function setText(shell, text) {
  const ta = shell.page.locator("#agent-composer-input").first();
  await ta.fill("");
  if (text) await ta.fill(text);
}

const FILE_SEL = 'input[type="file"][accept*=".mp4"]';

async function attachFiles(shell, files) {
  const list = Array.isArray(files) ? files : [files];
  try {
    if (!shell._e2eCdp) {
      shell._e2eCdp = await shell.context.newCDPSession(shell.page);
      await shell._e2eCdp.send("DOM.enable");
    }
    const cdp = shell._e2eCdp;
    const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: FILE_SEL });
    if (!nodeId) throw new Error("file input nodeId 為空");
    await cdp.send("DOM.setFileInputFiles", { files: list, nodeId });
    return "cdp";
  } catch (e) {
    shell._e2eCdp = null;
    await shell.page.evaluate((sel) => {
      const i = document.querySelector(sel);
      if (i) {
        i.style.display = "block";
        i.style.width = "1px";
        i.style.height = "1px";
        i.style.opacity = "0";
        i.style.position = "absolute";
      }
    }, FILE_SEL);
    await shell.page.setInputFiles(FILE_SEL, list);
    await shell.page.evaluate((sel) => {
      const i = document.querySelector(sel);
      if (i) i.style.cssText = "";
    }, FILE_SEL);
    return "setInputFiles";
  }
}

const netLine = (e) => ({
  method: e.method,
  url: e.url,
  status: e.status,
  failed: e.failed,
  failure: e.failure,
  postBytes: e.postBytes,
  cdpPostBytes: e.cdpPostBytes ?? null,
  parts: e.parts || e.cdpParts || null,
  responseJson: e.responseJson ?? null,
  responseText: e.responseText ?? null,
});

const storedParts = (e) => {
  const arr = e.responseJson && Array.isArray(e.responseJson.attachments) ? e.responseJson.attachments : null;
  if (arr) return { names: arr.map((a) => a.name), bytes: arr.reduce((s, a) => s + (typeof a.size === "number" ? a.size : 0), 0), via: "server-response" };
  if (e.responseJson && typeof e.responseJson.size === "number" && e.responseJson.name)
    return { names: [e.responseJson.name], bytes: e.responseJson.size, via: "server-response" };
  if (e.cdpParts) return { names: e.cdpParts, bytes: e.cdpPostBytes || 0, via: "cdp-post-data" };
  return { names: [], bytes: 0, via: "unavailable" };
};

const GEN_HINT = /generate|batch|upscale|generation-jobs|storyboard-voiceover|run-service|canary-service|\/mcp\b|\/media\/|imageedit|video\/generate|music/i;

/** 觀察一段時間內是否出現疑似生成型請求（非 GET，且 URL 命中 GEN_HINT）。 */
function scanGeneration(rec, t0) {
  return rec
    .since(t0)
    .filter((e) => e.url && ["POST", "PUT", "PATCH"].includes(e.method) && GEN_HINT.test(e.url))
    .map(netLine);
}

/** 送出一則純文字訊息；回 {sent, idle, elapsedMs}。 */
async function sendText(shell, text) {
  await setText(shell, text);
  const clicked = await shell.evaluate(() => {
    const btn = document.querySelector('[aria-label="发送"]');
    if (!btn || btn.disabled) return false;
    btn.click();
    return true;
  });
  return clicked;
}

/** 等 agent 回合結束：先給在途窗口，再要求「連續 idle」。 */
async function waitAgentIdle(shell, timeout = 150000) {
  const t0 = Date.now();
  await sleep(1800); // sending 窗口
  let idleStreak = 0;
  while (Date.now() - t0 < timeout) {
    const s = await shell.evaluate(() => {
      const send = document.querySelector('[aria-label="发送"]');
      const stop = document.querySelector('[aria-label="中止助理生成"]');
      const ta = document.querySelector("#agent-composer-input");
      const busy = !!stop || (send && send.getAttribute("aria-busy") === "true") || (ta && ta.disabled);
      return { busy, hasSend: !!send };
    });
    if (!s.busy && s.hasSend) {
      idleStreak += 1;
      if (idleStreak >= 3) return { idle: true, elapsedMs: Date.now() - t0 };
    } else {
      idleStreak = 0;
    }
    await sleep(1200);
  }
  return { idle: false, elapsedMs: Date.now() - t0 };
}

/** 送一則訊息並等回合結束（最多 timeout）。 */
async function sendAndWait(shell, text, timeout = 150000) {
  const t0 = Date.now();
  const sent = await sendText(shell, text);
  if (!sent) return { sent: false, idle: false, elapsedMs: 0 };
  const r = await waitAgentIdle(shell, timeout);
  return { sent: true, idle: r.idle, elapsedMs: Date.now() - t0 };
}

// ─────────────────────── 主流程
const args = parseArgs(process.argv);
const outDir = args.out || path.join("/tmp", `eimu-e2e2-${Date.now()}`);
const assetsDir = args.assets || "/tmp/eimu-e2e2-assets";
fs.mkdirSync(outDir, { recursive: true });
const shellOut = path.join(outDir, "shell");
fs.mkdirSync(shellOut, { recursive: true });

const A = {
  goodA: path.join(assetsDir, "good-a.mp4"),
  goodB: path.join(assetsDir, "good-b.mp4"),
  goodC: path.join(assetsDir, "good-c.mp4"),
  bad: path.join(assetsDir, "bad.mp4"),
  small: path.join(assetsDir, "small.mp4"),
};
for (const [k, p] of Object.entries(A)) {
  if (!fs.existsSync(p)) {
    console.error(`缺少素材 ${k}: ${p}`);
    process.exit(2);
  }
}
const sizeOf = (p) => fs.statSync(p).size;

const results = [];
const log = (...a) => console.log(...a);
function saveCase(name, obj) {
  fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify(obj, null, 2));
  results.push({ ...obj, name });
  log(`▶ ${name}: ${obj.status} ${obj.error || ""}`);
}

let MESSAGES_SENT = 0;
let GENERATION_SEEN = [];
const only = args.only;
const want = (n) => !only || only.includes(n);

async function main() {
  log(`Eimu 第二批複雜會話 E2E`);
  log(`out=${outDir}`);
  log(`assets: goodA=${sizeOf(A.goodA)}B goodB=${sizeOf(A.goodB)}B goodC=${sizeOf(A.goodC)}B small=${sizeOf(A.small)}B bad=${sizeOf(A.bad)}B`);

  const shell = await launchShell({ outDir: shellOut, seedProfileFrom: REAL_PROFILE });
  const rec = await attachRecorder(shell);

  const countPosts = (t0, t1) => {
    const evs = rec.since(t0).filter((e) => e.url && e.ts <= t1);
    return {
      evs,
      attachments: evs.filter((e) => e.method === "POST" && /\/api\/agent\/sessions\/[^/]+\/attachments$/.test(e.url)),
      videoUpload: evs.filter((e) => e.method === "POST" && /\/agent\/v1\/sessions\/[^/]+\/video-upload/.test(e.url)),
      ticket: evs.filter((e) => e.method === "POST" && /uploads-ticket$/.test(e.url)),
      messages: evs.filter((e) => e.method === "POST" && /\/api\/agent\/sessions\/[^/]+\/messages$/.test(e.url)),
    };
  };

  try {
    await shell.page.waitForLoadState("domcontentloaded").catch(() => {});
    let boot = await probeComposer(shell).catch(() => null);
    if (!boot || !boot.hasTextarea) {
      await shell.page.goto(shell.origin + "/", { waitUntil: "domcontentloaded" }).catch(() => {});
      await shell.page.waitForTimeout(3000);
    }
    await waitComposer(shell).catch(async () => {
      await shell.page.goto(shell.origin + "/", { waitUntil: "domcontentloaded" }).catch(() => {});
      await waitComposer(shell);
    });
    await shell.page.waitForTimeout(2000);
    const bootProbe = await probeComposer(shell);
    log(`boot: ${bootProbe.url} textarea=${bootProbe.hasTextarea} sendDisabled=${bootProbe.sendDisabled} level=${bootProbe.thinkingLevel}`);
    fs.writeFileSync(path.join(outDir, "boot-probe.json"), JSON.stringify(bootProbe, null, 2));
    await shell.screenshot("boot");

    // ───────────── B3：長對話多輪後才上傳 ─────────────
    if (want("B3")) {
      await clearChips(shell);
      await setText(shell, "");
      const t0 = rec.mark();
      const turns = [];
      const prompts = [
        "请只回复「收到」两个字。不要调用任何工具。",
        "请用一句话说明什么是时间复杂度的上界。不要调用任何工具。",
        "请只回复「好的，继续」。不要调用任何工具。",
      ];
      let stopped = false;
      let genSeen = [];
      for (const p of prompts) {
        if (stopped) break;
        if (MESSAGES_SENT >= 10) break;
        const s = await sendAndWait(shell, p, 150000);
        if (s.sent) MESSAGES_SENT += 1;
        const gen = scanGeneration(rec, t0);
        if (gen.length) {
          genSeen = gen;
          GENERATION_SEEN.push(...gen.map((g) => g.url));
          stopped = true;
        }
        turns.push({ prompt: p, sent: s.sent, idle: s.idle, elapsedMs: s.elapsedMs });
        try {
          fs.writeFileSync(path.join(outDir, "B3-partial.json"), JSON.stringify({ turns, genSeen }, null, 2));
        } catch {
          /* ignore */
        }
        await shell.screenshot(`B3-turn-${turns.length}`);
      }
      const beforeUpload = await probeComposer(shell);
      const stateBefore = { thinkingLevel: beforeUpload.thinkingLevel, bodyLen: beforeUpload.bodyText.length };
      const tUp = rec.mark();
      await attachFiles(shell, A.goodA);
      const settled = await waitChipsSettledSafe(shell, 180000);
      await shell.page.waitForTimeout(800);
      const after = await probeComposer(shell);
      const t1 = rec.mark();
      const { attachments, videoUpload, ticket } = countPosts(tUp, t1);
      const shot = await shell.screenshot("B3-after-upload");
      const allParts = attachments.flatMap((e) => storedParts(e).names);
      const derivedOk = allParts.length > 0 && allParts.every((p) => /-(keyframe-\d+\.jpg|poster\.jpg|probe\.json)$/.test(p));
      const ticketOk = ticket.length >= 1 && ticket.every((e) => e.status === 200);
      const pass =
        turns.length >= 1 &&
        turns.every((t) => t.sent) &&
        settled &&
        after.chipCount === 1 &&
        after.errorChips === 0 &&
        attachments.length >= 1 &&
        derivedOk &&
        videoUpload.length === 0 &&
        genSeen.length === 0;
      saveCase("B3", {
        status: pass ? "pass" : "fail",
        title: "長對話多輪（純文字）後才上傳大檔：附件照常、無殘留、ticket 未過期",
        observations: {
          turns,
          messagesSentThisCase: turns.filter((t) => t.sent).length,
          conversationBodyLenBefore: stateBefore.bodyLen,
          generationRequestsSeen: genSeen,
          stoppedEarly: stopped,
          settleAfterUpload: settled,
          afterUpload: { chipCount: after.chipCount, chipStatuses: after.chips, errorChips: after.errorChips, uploadingChips: after.uploadingChips },
          attachmentsRequests: attachments.length,
          derivedParts: allParts,
          ticketRequests: ticket.map((e) => ({ status: e.status, url: e.url })),
          ticketOk,
          videoUploadRequests: videoUpload.length,
          whyComplex: "多輪對話累積上下文/訊息列表，附件管線與會話狀態的交互只在長會話暴露；空會話測不出殘留與 ticket 時序",
        },
        networkEvidence: { attachments: attachments.map(netLine), videoUpload: videoUpload.map(netLine), ticket: ticket.map(netLine) },
        artifacts: { screenshot: shot.path },
        error: pass ? undefined : "B3 判準未全達（見 observations）",
      });
      await clearChips(shell);
    }

    // ───────────── B8：斷網/逾時降級（鏈式降級到明確終態） ─────────────
    if (want("B8")) {
      const cdp = await shell.context.newCDPSession(shell.page);
      await cdp.send("Network.enable");
      const blockedEvents = [];
      cdp.on("Network.loadingFailed", (p) => {
        if (p.blockedReason || /BLOCKED/i.test(p.errorText || "")) {
          blockedEvents.push({ requestId: p.requestId, errorText: p.errorText, blockedReason: p.blockedReason });
        }
      });
      const phases = [];
      const flushB8 = () => {
        try {
          fs.writeFileSync(path.join(outDir, "B8-partial.json"), JSON.stringify({ phases, blockedEvents }, null, 2));
        } catch {
          /* ignore */
        }
      };

      // Phase A0（診斷）：只擋衍生檔上行 /attachments，用「小檔」→ 驗降級鏈本身是否通
      await cdp.send("Network.setBlockedURLs", { urls: ["*/agent/sessions/*/attachments*"] });
      await clearChips(shell);
      await setText(shell, "");
      let tA0 = rec.mark();
      await attachFiles(shell, A.small);
      const settleA0 = await waitChipsSettledSafe(shell, 120000);
      await shell.page.waitForTimeout(600);
      const afterA0 = await probeComposer(shell);
      let tA0b = rec.mark();
      const cA0 = countPosts(tA0, tA0b);
      const shotA0 = await shell.screenshot("B8-A0-block-attachments-small");
      phases.push({
        phase: "A0-block-attachments-only-small",
        expect: "衍生檔上行被擋 → 降級原檔直傳 video-upload（小檔）→ chip ready",
        settled: settleA0,
        chip: afterA0.chips,
        attachments: cA0.attachments.map(netLine),
        videoUpload: cA0.videoUpload.map((e) => ({ ...netLine(e), status: e.status, responseJson: e.responseJson ?? null })),
        ticket: cA0.ticket.map((e) => ({ status: e.status, url: e.url })),
        outcome: afterA0.chips[0] ? (afterA0.chips[0].isError ? "error" : afterA0.chips[0].spinning ? "stuck" : "ready") : "none",
      });
      flushB8();
      await clearChips(shell);

      // Phase A：只擋衍生檔上行 /attachments → 期望降級到原檔直傳 video-upload（大檔 38MB）
      await cdp.send("Network.setBlockedURLs", { urls: ["*/agent/sessions/*/attachments*"] });
      await clearChips(shell);
      await setText(shell, "");
      let ta = rec.mark();
      await attachFiles(shell, A.goodA);
      const settleA = await waitChipsSettledSafe(shell, 150000);
      await shell.page.waitForTimeout(600);
      const afterA = await probeComposer(shell);
      let tb = rec.mark();
      const cA = countPosts(ta, tb);
      const shotA = await shell.screenshot("B8-A-block-attachments");
      phases.push({
        phase: "A-block-attachments-only",
        expect: "衍生檔上行被擋 → 降級原檔直傳 video-upload → chip ready",
        settled: settleA,
        chip: afterA.chips,
        attachments: cA.attachments.map(netLine),
        videoUpload: cA.videoUpload.map((e) => ({ ...netLine(e), status: e.status, responseJson: e.responseJson ?? null })),
        ticket: cA.ticket.map((e) => ({ status: e.status, url: e.url })),
        outcome: afterA.chips[0] ? (afterA.chips[0].isError ? "error" : afterA.chips[0].spinning ? "stuck" : "ready") : "none",
      });
      flushB8();
      await clearChips(shell);

      // Phase B：同時擋 /attachments 與 video-upload → 期望落抽幀，最後因 /attachments 仍被擋進明確終態（error，不得永卡）
      await cdp.send("Network.setBlockedURLs", { urls: ["*/agent/sessions/*/attachments*", "*/video-upload*"] });
      await setText(shell, "");
      let tc = rec.mark();
      await attachFiles(shell, A.goodB);
      const settleB = await waitChipsSettledSafe(shell, 180000);
      await shell.page.waitForTimeout(800);
      const afterB = await probeComposer(shell);
      let td = rec.mark();
      const cB = countPosts(tc, td);
      const shotB = await shell.screenshot("B8-B-block-both");
      const bPending = cB.evs.filter((e) => ["POST", "PUT"].includes(e.method) && e.status == null && !e.failed).map(netLine);
      phases.push({
        phase: "B-block-attachments-and-video-upload",
        expect: "兩條都擋 → 落抽幀 → 抽幀上行也走 /attachments 仍被擋 → chip 進明確終態",
        settled: settleB,
        chip: afterB.chips,
        uploadingChips: afterB.uploadingChips,
        errorChips: afterB.errorChips,
        attachments: cB.attachments.map(netLine),
        videoUpload: cB.videoUpload.map(netLine),
        pendingPosts: bPending,
        outcome: afterB.chips[0] ? (afterB.chips[0].isError ? "error-terminal" : afterB.chips[0].spinning ? "stuck(hang)" : "ready") : "none",
      });
      flushB8();
      await clearChips(shell);

      // Phase C：解除封鎖 → composer 恢復可用（無殘留封鎖）
      await cdp.send("Network.setBlockedURLs", { urls: [] });
      await setText(shell, "");
      let te = rec.mark();
      await attachFiles(shell, A.small);
      const settleC = await waitChipsSettledSafe(shell, 180000);
      await shell.page.waitForTimeout(600);
      const afterC = await probeComposer(shell);
      let tf = rec.mark();
      const cC = countPosts(te, tf);
      const shotC = await shell.screenshot("B8-C-recovered");
      phases.push({
        phase: "C-unblock-recovery",
        expect: "解除封鎖後附件恢復 ready",
        settled: settleC,
        chip: afterC.chips,
        attachments: cC.attachments.map(netLine),
        outcome: afterC.chips[0] ? (afterC.chips[0].isError ? "error" : afterC.chips[0].spinning ? "stuck" : "ready") : "none",
      });
      flushB8();
      await clearChips(shell);
      try {
        await cdp.send("Network.setBlockedURLs", { urls: [] });
      } catch {
        /* ignore */
      }

      const phaseA0 = phases[0];
      const phaseA = phases[1];
      const phaseB = phases[2];
      const phaseC = phases[3];
      const pass =
        phaseA0.settled &&
        phaseA0.outcome === "ready" &&
        phaseA0.videoUpload.length >= 1 &&
        phaseB.settled &&
        phaseB.outcome !== "stuck(hang)" &&
        (phaseB.outcome === "error-terminal" || phaseB.outcome === "ready") &&
        phaseC.settled &&
        phaseC.outcome === "ready";
      saveCase("B8", {
        status: pass ? "pass" : "fail",
        title: "鏈式降級：衍生檔上行失敗→原檔直傳→抽幀；全失敗仍進明確終態（不永卡）",
        observations: {
          phases,
          blockedEvents,
          largeOriginalUploadOutcome: phaseA.outcome,
          largeOriginalUploadNote:
            phaseA.outcome === "ready"
              ? "38MB 原檔直傳在時限內完成（降級鏈在大檔也通）"
              : "38MB 原檔直傳在時限內未完成→chip 停在 uploading（無逾時/無終態）；小檔對照見 A0",
          whyComplex: "降級鏈只在特定請求同時失敗時整條走完；簡單會話正常路徑永遠停在第一階",
        },
        networkEvidence: { phases },
        artifacts: { screenshot: shotB.path, A0: shotA0.path, A: shotA.path, C: shotC.path },
        error: pass ? undefined : "B8 鏈式降級或終態判準未達（見 observations.phases）",
      });
    }

    // ───────────── B10：會話中途切換設定（思考級別）再上傳 ─────────────
    if (want("B10")) {
      await clearChips(shell);
      await setText(shell, "");
      const before = await probeComposer(shell);
      const t0 = rec.mark();
      // 先開始上傳（大檔，ingest 有明顯窗口），立刻切換思考級別，觀察是否打斷進行中的 ingest / 元件樹重建
      await attachFiles(shell, A.goodC);
      await shell.page.waitForTimeout(120);
      const midDuringUpload = await probeComposer(shell);
      let levelSwitch = null;
      try {
        await shell.page.click('[aria-label^="思考级别"]', { timeout: 8000 });
        await shell.page.waitForTimeout(250);
        const opts = shell.page.locator('[role="option"]');
        const n = await opts.count();
        const labels = [];
        for (let i = 0; i < n; i++) labels.push((await opts.nth(i).innerText()).trim());
        // 選「高」= persona thoughtful / cost balanced
        await shell.page.locator('[role="option"]', { hasText: "高" }).first().click({ timeout: 8000 });
        await shell.page.waitForTimeout(400);
        const afterSwitch = await probeComposer(shell);
        levelSwitch = { opened: true, options: labels, levelAfter: afterSwitch.thinkingLevel, midDuringUploadChips: midDuringUpload.chips };
      } catch (e) {
        levelSwitch = { opened: false, error: String(e && e.message) };
      }
      const settled = await waitChipsSettledSafe(shell, 180000);
      await shell.page.waitForTimeout(800);
      const after = await probeComposer(shell);
      const t1 = rec.mark();
      const { attachments, videoUpload } = countPosts(t0, t1);
      const shot = await shell.screenshot("B10-switch-mid-upload");
      const levelChanged = !!(levelSwitch.levelAfter && before.thinkingLevel && levelSwitch.levelAfter !== before.thinkingLevel);
      const pass =
        settled &&
        after.chipCount === 1 &&
        after.errorChips === 0 &&
        after.uploadingChips === 0 &&
        attachments.length >= 1 &&
        videoUpload.length === 0 &&
        levelChanged;
      saveCase("B10", {
        status: pass ? "pass" : "fail",
        title: "上傳途中切換思考級別（設定變更）：不打斷 ingest、附件照常、級別真的變了",
        observations: {
          levelBefore: before.thinkingLevel,
          levelAfter: levelSwitch.levelAfter,
          levelChanged,
          levelSwitch,
          midDuringUploadChips: midDuringUpload.chips,
          settled,
          finalChips: after.chips,
          errorChips: after.errorChips,
          uploadingChips: after.uploadingChips,
          attachmentsRequests: attachments.length,
          videoUploadRequests: videoUpload.length,
          whyComplex: "設定變更觸發 Provider/元件樹重渲染；只在「上傳進行中」同時切換才暴露——靜態上傳完再切測不到競態",
        },
        networkEvidence: { attachments: attachments.map(netLine), videoUpload: videoUpload.map(netLine) },
        artifacts: { screenshot: shot.path },
        error: pass ? undefined : "B10 判準未全達（見 observations）",
      });
      await clearChips(shell);
      // 還原級別為「中」避免殘留設定
      try {
        await shell.page.click('[aria-label^="思考级别"]', { timeout: 6000 });
        await shell.page.waitForTimeout(200);
        await shell.page.locator('[role="option"]', { hasText: "中" }).first().click({ timeout: 6000 });
        await shell.page.waitForTimeout(300);
      } catch {
        /* ignore */
      }
    }

    // ───────────── DROP：真拖放入口 ─────────────
    if (want("DROP")) {
      await clearChips(shell);
      await setText(shell, "");
      const box = await shell.page.locator(".agent-composer").first().boundingBox();
      let mechanism = null;
      let t0 = rec.mark();

      // 入口 1：CDP Input.dispatchDragEvent（帶真檔路徑）
      if (box) {
        try {
          const cdpIn = await shell.context.newCDPSession(shell.page);
          const cx = Math.round(box.x + box.width / 2);
          const cy = Math.round(box.y + box.height / 2);
          const dragData = { items: [{ mimeType: "video/mp4", data: "" }], files: [A.small], dragOperationsMask: 1 };
          await cdpIn.send("Input.dispatchDragEvent", { type: "dragEnter", x: cx, y: cy, data: dragData });
          await cdpIn.send("Input.dispatchDragEvent", { type: "dragOver", x: cx, y: cy, data: dragData });
          await cdpIn.send("Input.dispatchDragEvent", { type: "drop", x: cx, y: cy, data: dragData });
          mechanism = "cdp-Input.dispatchDragEvent";
        } catch (e) {
          mechanism = `cdp-failed:${String(e && e.message)}`;
        }
      }
      let appeared = false;
      try {
        await shell.page.waitForFunction(() => document.querySelectorAll('[aria-label^="移除 "]').length > 0, undefined, { timeout: 6000 });
        appeared = true;
      } catch {
        appeared = false;
      }
      // 入口 2（回落）：合成 DataTransfer 真 drop（真 File 物件）
      if (!appeared) {
        try {
          const b64 = fs.readFileSync(A.small).toString("base64");
          await shell.evaluate(async (b) => {
            const bin = atob(b);
            const arr = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
            const file = new File([arr], "drop-a.mp4", { type: "video/mp4" });
            const dt = new DataTransfer();
            dt.items.add(file);
            const el = document.querySelector(".agent-composer");
            for (const type of ["dragenter", "dragover", "drop"]) {
              el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
            }
          }, b64);
          mechanism = (mechanism ? mechanism + " + " : "") + "synthetic-DataTransfer";
          await shell.page.waitForFunction(() => document.querySelectorAll('[aria-label^="移除 "]').length > 0, undefined, { timeout: 6000 });
          appeared = true;
        } catch (e) {
          mechanism = (mechanism ? mechanism + " + " : "") + `synthetic-failed:${String(e && e.message)}`;
        }
      }
      const settled = appeared ? await waitChipsSettledSafe(shell, 180000) : false;
      await shell.page.waitForTimeout(600);
      const after = await probeComposer(shell);
      const t1 = rec.mark();
      const { attachments, videoUpload } = countPosts(t0, t1);
      const shot = await shell.screenshot("DROP");
      const pass = appeared && settled && after.chipCount >= 1 && after.errorChips === 0 && attachments.length >= 1;
      saveCase("DROP", {
        status: pass ? "pass" : "fail",
        title: "真拖放（drop）入口：與選檔路徑等價，附件照常",
        observations: {
          mechanism,
          appeared,
          settled,
          chipCount: after.chipCount,
          chipStatuses: after.chips,
          attachmentsRequests: attachments.length,
          videoUploadRequests: videoUpload.length,
          whyComplex: "拖放是獨立事件入口（onDragEnter/Over/Leave/Drop）；之前只測 input 選檔，drop 的 dataTransfer.files 讀取與 depth 計數從未被覆蓋",
        },
        networkEvidence: { attachments: attachments.map(netLine), videoUpload: videoUpload.map(netLine) },
        artifacts: { screenshot: shot.path },
        error: pass ? undefined : "DROP 判準未全達（見 observations.mechanism）",
      });
    }

    // ───────────── PASTE：貼上入口 ─────────────
    if (want("PASTE")) {
      await clearChips(shell);
      await setText(shell, "");
      const t0 = rec.mark();
      // 真 Ctrl+V 貼上假檔：OS 剪貼簿無法用 CDP 放入「檔案」項目（只能文字/圖片），
      // 故用合成的 ClipboardEvent（真 DataTransfer + 真 File）驅動 React onPaste 入口。
      // 先嘗試 CDP Input.dispatchKeyEvent 的 paste（無檔案的剪貼簿 → clipboardData.files 為空 → 入口早退），
      // 再以合成事件驗檔案路徑；兩者結果一併記錄。
      let cdpPaste = null;
      try {
        await shell.page.focus("#agent-composer-input");
        const cdpIn = await shell.context.newCDPSession(shell.page);
        await cdpIn.send("Input.dispatchKeyEvent", { type: "keyDown", key: "v", code: "KeyV", modifiers: 2, windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 86 });
        await cdpIn.send("Input.dispatchKeyEvent", { type: "keyUp", key: "v", code: "KeyV", modifiers: 2, windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 86 });
        await shell.page.waitForTimeout(600);
        const afterCdp = await probeComposer(shell);
        cdpPaste = { attempted: true, chipCountAfter: afterCdp.chipCount, note: "OS 剪貼簿無檔案項目 → 預期無 chip" };
      } catch (e) {
        cdpPaste = { attempted: false, error: String(e && e.message) };
      }

      let synthetic = null;
      try {
        const b64 = fs.readFileSync(A.small).toString("base64");
        const res = await shell.evaluate(async (b) => {
          const bin = atob(b);
          const arr = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
          const file = new File([arr], "paste-a.mp4", { type: "video/mp4" });
          const dt = new DataTransfer();
          dt.items.add(file);
          const ta = document.querySelector("#agent-composer-input");
          if (!ta) return { ok: false, reason: "no-textarea" };
          let ctorOk = true;
          let ev;
          try {
            ev = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt });
          } catch (e) {
            ctorOk = false;
            ev = new Event("paste", { bubbles: true, cancelable: true });
            try {
              Object.defineProperty(ev, "clipboardData", { value: dt });
            } catch {
              /* ignore */
            }
          }
          const filesInEv = ev.clipboardData ? ev.clipboardData.files.length : -1;
          ta.dispatchEvent(ev);
          return { ok: true, ctorOk, filesInEv };
        }, b64);
        synthetic = res;
      } catch (e) {
        synthetic = { ok: false, error: String(e && e.message) };
      }
      let appeared = false;
      try {
        await shell.page.waitForFunction(() => document.querySelectorAll('[aria-label^="移除 "]').length > 0, undefined, { timeout: 8000 });
        appeared = true;
      } catch {
        appeared = false;
      }
      const settled = appeared ? await waitChipsSettledSafe(shell, 180000) : false;
      await shell.page.waitForTimeout(600);
      const after = await probeComposer(shell);
      const t1 = rec.mark();
      const { attachments, videoUpload } = countPosts(t0, t1);
      const shot = await shell.screenshot("PASTE");
      const pass = appeared && settled && after.chipCount >= 1 && after.errorChips === 0 && attachments.length >= 1;
      saveCase("PASTE", {
        status: pass ? "pass" : "fail",
        title: "Ctrl+V 貼上入口：帶檔案時走附件管道、與選檔等價",
        observations: {
          cdpPaste,
          syntheticClipboardEvent: synthetic,
          appeared,
          settled,
          chipCount: after.chipCount,
          chipStatuses: after.chips,
          attachmentsRequests: attachments.length,
          videoUploadRequests: videoUpload.length,
          whyComplex: "貼上是獨立事件入口（onPaste + clipboardData.files）；input 選檔測不到此入口",
        },
        networkEvidence: { attachments: attachments.map(netLine), videoUpload: videoUpload.map(netLine) },
        artifacts: { screenshot: shot.path },
        error: pass ? undefined : "PASTE 判準未全達（見 observations）",
      });
    }

    // ───────────── B9：單實例鎖（同 profile vs 不同 profile） ─────────────
    if (want("B9")) {
      const sameProfileDir = shell.userDataDir; // 第一個殼現用的 user-data-dir
      const secondLog = path.join(shellOut, "second-same-profile.log");
      const p2 = await freePort();
      const child2 = spawn(
        DEFAULT_BINARY,
        [
          `--remote-debugging-port=${p2}`,
          "--remote-debugging-address=127.0.0.1",
          "--ozone-platform=x11",
          "--no-sandbox",
          "--disable-gpu",
          "--disable-dev-shm-usage",
          `--user-data-dir=${sameProfileDir}`,
        ],
        {
          env: { ...process.env, HOME: shell.homeDir, DISPLAY: process.env.DISPLAY || ":1", ELECTRON_DISABLE_SECURITY_WARNINGS: "1" },
          cwd: path.dirname(DEFAULT_BINARY),
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const log2 = fs.createWriteStream(secondLog);
      child2.stdout.pipe(log2);
      child2.stderr.pipe(log2);
      // 等最多 15s：預期第二實例自行退出（gotLock=false → app.quit()）
      const sameWaitStart = Date.now();
      while (child2.exitCode === null && Date.now() - sameWaitStart < 15000) await sleep(300);
      const sameExited = child2.exitCode !== null;
      const sameExit = { exitCode: child2.exitCode, signal: child2.signalCode, waitedMs: Date.now() - sameWaitStart };
      // 第一個殼是否仍活著 & 頁數不變
      const firstAlive = await shell.evaluate(() => true).then(() => true).catch(() => false);
      const pagesAfter = shell.context.pages().length;
      await stopChild(child2).catch(() => {});
      log2.end();
      let sameLogTail = "";
      try {
        sameLogTail = fs.readFileSync(secondLog, "utf8").slice(-1500);
      } catch {
        /* ignore */
      }

      // 不同 profile：應能並存
      const home2 = path.join(outDir, "home-b9b");
      fs.mkdirSync(home2, { recursive: true });
      const ud2 = path.join(home2, ".config", "Eimu");
      fs.mkdirSync(ud2, { recursive: true });
      const p3 = await freePort();
      const child3 = spawn(
        DEFAULT_BINARY,
        [
          `--remote-debugging-port=${p3}`,
          "--remote-debugging-address=127.0.0.1",
          "--ozone-platform=x11",
          "--no-sandbox",
          "--disable-gpu",
          "--disable-dev-shm-usage",
          `--user-data-dir=${ud2}`,
        ],
        {
          env: { ...process.env, HOME: home2, DISPLAY: process.env.DISPLAY || ":1", ELECTRON_DISABLE_SECURITY_WARNINGS: "1" },
          cwd: path.dirname(DEFAULT_BINARY),
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const log3 = fs.createWriteStream(path.join(shellOut, "second-diff-profile.log"));
      child3.stdout.pipe(log3);
      child3.stderr.pipe(log3);
      let diffCdpUp = false;
      {
        const deadline = Date.now() + 40000;
        while (Date.now() < deadline) {
          try {
            const r = await fetch(`http://127.0.0.1:${p3}/json/version`);
            if (r.ok) {
              diffCdpUp = true;
              break;
            }
          } catch {
            /* not ready */
          }
          await sleep(400);
        }
      }
      const diffList = diffCdpUp ? await fetch(`http://127.0.0.1:${p3}/json/list`).then((r) => r.json()).catch(() => null) : null;
      const firstStillAlive = await shell.evaluate(() => true).then(() => true).catch(() => false);
      const shot = await shell.screenshot("B9-first-shell");
      await stopChild(child3).catch(() => {});
      log3.end();
      try {
        fs.rmSync(home2, { recursive: true, force: true });
      } catch {
        /* ignore */
      }

      const pass = sameExited && firstAlive && firstStillAlive && pagesAfter === shell.context.pages().length && diffCdpUp && firstStillAlive;
      saveCase("B9", {
        status: pass ? "pass" : "fail",
        title: "單實例鎖：同 profile 第二實例退出並聚焦既有；不同 profile 可並存",
        observations: {
          sameProfile: { exited: sameExited, exit: sameExit, firstAlive, pagesAfter, logTail: sameLogTail },
          diffProfile: { cdpUp: diffCdpUp, listCount: Array.isArray(diffList) ? diffList.length : null, firstStillAlive },
          whyComplex: "單實例鎖的行為只在「第二次啟動」暴露；單次啟動/單視窗測不到第二實例的處置",
        },
        artifacts: { screenshot: shot.path },
        error: pass ? undefined : "B9 判準未全達（見 observations）",
      });
    }

    const summary = {
      outDir,
      assetsDir,
      cases: results.map((r) => ({ name: r.name, status: r.status, error: r.error || null, screenshot: (r.artifacts && (r.artifacts.screenshot || r.artifacts.A)) || null })),
      totalAgentMessagesPosted: MESSAGES_SENT,
      generationRequestsSeen: GENERATION_SEEN,
      pass: results.filter((r) => r.status === "pass").length,
      fail: results.filter((r) => r.status === "fail").length,
    };
    fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
    log(`\n=== ${summary.pass} pass / ${summary.fail} fail · messages=${MESSAGES_SENT} · genSeen=${GENERATION_SEEN.length} ===`);
    for (const r of results) log(`  [${r.status.toUpperCase()}] ${r.name} ${r.error || ""}`);
    log(`out=${outDir}`);
  } finally {
    await shell.close().catch(() => {});
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
