// desktop/scripts/e2e/session-cases.mjs
//
// 「真實已登入會話」附件本地化 + 複雜會話 E2E（A17/A18/B1/B2/B4/B5/B7）。
//
// 紅線遵守：
//   · 只讀複製 ~/.config/Eimu（seedProfileFrom），絕不修改原始 profile。
//   · 不部署/不 SSH/不連 DB；只打生產站內附件端點（免費）與網關附件直傳（免費）。
//   · 不觸發付費生成：本腳本「不發送任何 agent 訊息」；B4 只觀察送出鈕在未 ready
//     時是否被鎖，若明顯可送則不點（避免產生 agent 回合）。
//   · 輸出到 /tmp（不寫 repo）。
//
// 用法：
//   node desktop/scripts/e2e/session-cases.mjs --out /tmp/eimu-session-e2e-XXX --assets /tmp/.../assets
//
// 產物：outDir/<case>.json、outDir/<case>.png、outDir/summary.json、outDir/net-<case>.json

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchShell } from "./harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REAL_PROFILE = path.join(os.homedir(), ".config", "Eimu");

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────── 網路錄製（含 request body 大小與 multipart parts）

async function attachRecorder(shell) {
  const list = [];
  const byReq = new Map();
  // CDP：拿 multipart 原始 request body（Playwright postDataBuffer 對 FormData 回 null）。
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
        /* body 可能已被釋放 */
      }
    });
  } catch {
    /* CDP 不可用時其餘錄製照常 */
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
      // 附件/直傳端點：抓伺服器回應（權威：列出實際入庫的檔名與 size）。
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
    // CDP 拿到的 multipart 原始 body → 解析 parts 與位元組。
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
  return {
    all: () => list.slice(),
    since: (ts) => list.filter((e) => e.ts >= ts),
    mark: () => Date.now(),
  };
}

// ─────────────────────── 頁面狀態探針

async function probeComposer(shell) {
  return await shell.evaluate(() => {
    const ta = document.querySelector("#agent-composer-input");
    const send = document.querySelector('[aria-label="发送"]');
    const input = document.querySelector('input[type="file"][accept*=".mp4"]');
    const chips = [...document.querySelectorAll('[aria-label^="移除 "]')].map((btn) => {
      const el = btn.closest("span");
      const cls = (el && el.className) || "";
      const txt = (el && el.innerText) || "";
      return {
        text: txt.trim(),
        spinning: !!(el && el.querySelector(".animate-spin")),
        isError: cls.includes("destructive"),
        extracting: txt.includes("抽帧"),
      };
    });
    const frames = [...document.querySelectorAll('img[alt^="第 "]')].map((i) => i.alt);
    const videos = [...document.querySelectorAll('video[aria-label^="原片："]')].map((v) =>
      v.getAttribute("aria-label"),
    );
    let mem = null;
    try {
      if (performance && performance.memory) {
        mem = { used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize };
      }
    } catch {
      /* ignore */
    }
    return {
      url: location.href,
      hasTextarea: !!ta,
      hasFileInput: !!input,
      sendDisabled: send ? send.disabled : null,
      sendAriaBusy: send ? send.getAttribute("aria-busy") : null,
      textareaValue: ta ? ta.value : null,
      chips,
      chipCount: chips.length,
      uploadingChips: chips.filter((c) => c.spinning || c.extracting).length,
      errorChips: chips.filter((c) => c.isError).length,
      frameCount: frames.length,
      frameAlts: frames,
      videoPreviews: videos,
      bodyText: document.body ? document.body.innerText.slice(0, 2000) : "",
      mem,
    };
  });
}

async function waitComposer(shell, timeout = 40000) {
  await shell.page.waitForSelector("#agent-composer-input", { state: "visible", timeout });
}

/** 等所有 chip 脫離 uploading/extracting（成功或失敗皆算落地）。 */
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

/** 同上但逾時不拋，回傳是否落地（讓案例能捕捉「卡住」狀態並繼續）。 */
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
  // 輸入框 display:none（Tailwind hidden），Playwright setInputFiles 的可見性檢查會
  // 間歇逾時 → 直接用 CDP DOM.setFileInputFiles（與 Playwright 同機制，但不做 actionability）。
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
    return;
  } catch (e) {
    shell._e2eCdp = null;
    // 退路：暫時露出再 setInputFiles。
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
  }
}

// ─────────────────────── 主流程

const args = parseArgs(process.argv);
const outDir = args.out || path.join("/tmp", `eimu-session-e2e-${Date.now()}`);
const assetsDir = args.assets;
fs.mkdirSync(outDir, { recursive: true });

if (!assetsDir || !fs.existsSync(path.join(assetsDir, "good-a.mp4"))) {
  console.error("缺少素材：--assets 需含 good-a/b/c.mp4 與 bad.mp4");
  process.exit(2);
}
const A = {
  goodA: path.join(assetsDir, "good-a.mp4"),
  goodB: path.join(assetsDir, "good-b.mp4"),
  goodC: path.join(assetsDir, "good-c.mp4"),
  bad: path.join(assetsDir, "bad.mp4"),
};
const sizeOf = (p) => fs.statSync(p).size;

const results = [];
const log = (...a) => console.log(...a);

function saveCase(name, obj) {
  fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify(obj, null, 2));
  results.push({ ...obj, name });
  const line = obj.error ? `FAIL ${obj.error}` : "PASS";
  log(`▶ ${name}: ${line}`);
}

const only = args.only;
const want = (n) => !only || only.includes(n);

async function main() {
  log(`Eimu 真實會話附件本地化 E2E`);
  log(`out=${outDir}`);
  log(`assets=${assetsDir} good=${sizeOf(A.goodA)}B bad=${sizeOf(A.bad)}B`);
  try {
    fs.rmSync(path.join(outDir, "fatal.txt"), { force: true });
  } catch {
    /* ignore */
  }

  const shell = await launchShell({ outDir: path.join(outDir, "shell"), seedProfileFrom: REAL_PROFILE });
  const rec = await attachRecorder(shell);
  const counts = { messages: 0, attachments: 0, videoUpload: 0 };

  const countCase = (tsFrom, tsTo) => {
    const evs = rec.since(tsFrom).filter((e) => e.url && e.ts <= tsTo);
    const attachments = evs.filter(
      (e) => e.method === "POST" && /\/api\/agent\/sessions\/[^/]+\/attachments$/.test(e.url),
    );
    const videoUpload = evs.filter((e) => e.method === "POST" && /\/agent\/v1\/sessions\/[^/]+\/video-upload/.test(e.url));
    const messages = evs.filter(
      (e) => e.method === "POST" && /\/api\/agent\/sessions\/[^/]+\/messages$/.test(e.url),
    );
    counts.messages += messages.length;
    counts.attachments += attachments.length;
    counts.videoUpload += videoUpload.length;
    return { evs, attachments, videoUpload, messages };
  };

  const netLine = (e) => ({
    method: e.method,
    url: e.url.replace(/\?.*/, "?…"),
    status: e.status,
    failed: e.failed,
    postBytes: e.postBytes,
    cdpPostBytes: e.cdpPostBytes ?? null,
    requestBodySize: e.requestBodySize,
    responseBodySize: e.responseBodySize,
    parts: e.parts || e.cdpParts || null,
    responseJson: e.responseJson ?? null,
    responseText: e.responseText ?? null,
  });

  /** 從伺服器回應或 CDP body 取「實際入庫的檔名清單 + 位元組總和」。 */
  const storedParts = (e) => {
    const arr = e.responseJson && Array.isArray(e.responseJson.attachments) ? e.responseJson.attachments : null;
    if (arr) {
      return {
        names: arr.map((a) => a.name),
        bytes: arr.reduce((s, a) => s + (typeof a.size === "number" ? a.size : 0), 0),
        via: "server-response",
      };
    }
    if (e.responseJson && typeof e.responseJson.size === "number" && e.responseJson.name) {
      return { names: [e.responseJson.name], bytes: e.responseJson.size, via: "server-response" };
    }
    if (e.cdpParts) {
      return { names: e.cdpParts, bytes: e.cdpPostBytes || 0, via: "cdp-post-data" };
    }
    return { names: [], bytes: 0, via: "unavailable" };
  };

  try {
    await shell.page.waitForLoadState("domcontentloaded").catch(() => {});
    // 若不在工作台，導回首頁。
    let boot = await probeComposer(shell).catch(() => null);
    if (!boot || !boot.hasTextarea) {
      await shell.page.goto(shell.origin + "/", { waitUntil: "domcontentloaded" }).catch(() => {});
      await shell.page.waitForTimeout(3000);
    }
    await waitComposer(shell).catch(async () => {
      await shell.page.goto(shell.origin + "/", { waitUntil: "domcontentloaded" }).catch(() => {});
      await waitComposer(shell);
    });
    await shell.page.waitForTimeout(2500);
    const bootProbe = await probeComposer(shell);
    log(`boot: ${bootProbe.url} textarea=${bootProbe.hasTextarea} sendDisabled=${bootProbe.sendDisabled}`);
    fs.writeFileSync(path.join(outDir, "boot-probe.json"), JSON.stringify(bootProbe, null, 2));
    const bootShot = await shell.screenshot("boot");
    log(`bootScreenshot=${bootShot.path}`);

    // ───────────── A17：只上行衍生檔 ─────────────
    if (want("A17")) {
      const t0 = rec.mark();
      await clearChips(shell);
      await setText(shell, "");
      const beforeBytes = sizeOf(A.goodA);
      await attachFiles(shell, A.goodA);
      // 立刻截「上傳中」態
      await shell.page.waitForTimeout(200);
      const mid = await probeComposer(shell);
      const midShot = await shell.screenshot("A17-uploading");
      const settledOk = await waitChipsSettledSafe(shell);
      await shell.page.waitForTimeout(800);
      const after = await probeComposer(shell);
      const shot = await shell.screenshot("A17-attachment-ready");
      const t1 = rec.mark();
      const { attachments, videoUpload } = countCase(t0, t1);
      const storedPerReq = attachments.map((e) => ({ url: e.url, ...storedParts(e) }));
      const storedNames = storedPerReq.flatMap((s) => s.names);
      const allParts = storedNames.length ? storedNames : attachments.flatMap((e) => e.parts || []);
      const derivedOk = allParts.length > 0 && allParts.every((p) => /-(keyframe-\d+\.jpg|poster\.jpg|probe\.json)$/.test(p));
      const keyframes = allParts.filter((p) => /-keyframe-\d+\.jpg$/.test(p));
      const posters = allParts.filter((p) => /-poster\.jpg$/.test(p));
      const probes = allParts.filter((p) => /-probe\.json$/.test(p));
      const serverBytes = storedPerReq.reduce((s, e) => s + (e.bytes || 0), 0);
      const cdpBytes = attachments.reduce((s, e) => s + (e.cdpPostBytes || 0), 0);
      const totalUp = serverBytes || cdpBytes;
      const pass =
        settledOk && attachments.length >= 1 && derivedOk && keyframes.length >= 1 && posters.length === 1 && probes.length === 1 && videoUpload.length === 0 && totalUp > 0 && totalUp <= 4 * 1024 * 1024;
      saveCase("A17", {
        status: pass ? "pass" : "fail",
        title: "影片附件只上行衍生檔，原檔不上行",
        observations: {
          sourceBytes: beforeBytes,
          chipCount: after.chipCount,
          chipStatuses: after.chips,
          frameCount: after.frameCount,
          videoPreviews: after.videoPreviews,
          midUploadingChips: mid.uploadingChips,
          settled: settledOk,
          attachmentsRequests: attachments.length,
          attachmentURLs: attachments.map((e) => e.url),
          derivedParts: allParts,
          keyframeParts: keyframes,
          posterParts: posters,
          probeParts: probes,
          storedPerReq,
          serverBytes,
          cdpBytes,
          videoUploadRequests: videoUpload.length,
          videoUploadURLs: videoUpload.map((e) => e.url),
          totalUpstreamBytes: totalUp,
          note: `原檔 ${beforeBytes}B 對比上行 ${totalUp}B（前後差 ${beforeBytes - totalUp}B 未上行）`,
        },
        networkEvidence: { attachments: attachments.map(netLine), videoUpload: videoUpload.map(netLine) },
        artifacts: { screenshot: shot.path, mid: midShot.path },
        error: pass ? undefined : "A17 判準未全達（見 observations）",
      });
      await clearChips(shell);
    }

    // ───────────── B4：chip 未 ready 時立即按送出 ─────────────
    if (want("B4")) {
      const t0 = rec.mark();
      await clearChips(shell);
      await setText(shell, "请只列出附件的文件名与类型，不要生成任何内容。");
      await attachFiles(shell, A.goodB);
      // 等 chip 真的出現且仍在 uploading（CDP 設定檔案後 change 事件非同步），
      // 這一刻就是「尚未 ready」的窗口；在此立刻檢查送出鈕並嘗試點擊。
      let chipAppeared = true;
      try {
        await shell.page.waitForFunction(
          () => {
            const btn = document.querySelector('[aria-label^="移除 "]');
            const el = btn && btn.closest("span");
            return !!el && !!el.querySelector(".animate-spin");
          },
          undefined,
          { timeout: 15000 },
        );
      } catch {
        chipAppeared = false;
      }
      const immediate = await probeComposer(shell);
      const clickedDisabled = await shell.evaluate(() => {
        const btn = document.querySelector('[aria-label="发送"]');
        if (!btn) return { found: false };
        const wasDisabled = btn.disabled;
        if (!wasDisabled) return { found: true, wasDisabled: false, clicked: false, reason: "send-not-disabled-safe-skip" };
        btn.click(); // disabled button：no-op
        return { found: true, wasDisabled: true, clicked: true };
      });
      const midShot = await shell.screenshot("B4-immediate");
      await shell.page.waitForTimeout(2500);
      const t1 = rec.mark();
      const { messages } = countCase(t0, t1);
      const midState = await probeComposer(shell);
      const settledOkB4 = await waitChipsSettledSafe(shell);
      const settled = await probeComposer(shell);
      // 清理，不真的送出
      await clearChips(shell);
      await setText(shell, "");
      const sawUploadWindow = chipAppeared && immediate.uploadingChips >= 1;
      const pass = sawUploadWindow && immediate.sendDisabled === true && messages.length === 0 && clickedDisabled.wasDisabled === true;
      saveCase("B4", {
        status: pass ? "pass" : "fail",
        title: "附件未 ready 時按送出：被鎖住、不送半成品",
        observations: {
          sawUploadWindow,
          immediatelyAfterAttach: {
            sendDisabled: immediate.sendDisabled,
            sendAriaBusy: immediate.sendAriaBusy,
            uploadingChips: immediate.uploadingChips,
            chipStatuses: immediate.chips,
          },
          clickResult: clickedDisabled,
          messagesRequestsDuringWindow: messages.length,
          settled: settledOkB4,
          settledChipStatuses: settled.chips,
          whyComplex: "簡單會話送出前通常已 ready；此競態只在『選檔後同幀送出』這種複雜交互出現",
        },
        networkEvidence: { messages: messages.map(netLine) },
        artifacts: { screenshot: midShot.path },
        error: pass ? undefined : "B4 判準未全達（見 observations）",
      });
    }

    // ───────────── B5：同檔重複上傳 ─────────────
    if (want("B5")) {
      await clearChips(shell);
      await setText(shell, "");
      const t0 = rec.mark();
      await attachFiles(shell, A.goodC);
      const settled1 = await waitChipsSettledSafe(shell);
      const afterFirst = await probeComposer(shell);
      await attachFiles(shell, A.goodC); // 同一路徑第二次
      const settled2 = await waitChipsSettledSafe(shell);
      await shell.page.waitForTimeout(600);
      const afterSecond = await probeComposer(shell);
      const t1 = rec.mark();
      const { attachments } = countCase(t0, t1);
      const shot = await shell.screenshot("B5-duplicate");
      const pass = settled1 && settled2 && afterSecond.chipCount >= 2 && afterSecond.errorChips === 0 && attachments.length >= 2;
      saveCase("B5", {
        status: pass ? "pass" : "fail",
        title: "同一檔連續上傳兩次：是否去重/覆寫",
        observations: {
          afterFirstChips: afterFirst.chips,
          afterSecondChips: afterSecond.chips,
          afterSecondChipCount: afterSecond.chipCount,
          afterSecondFrameCount: afterSecond.frameCount,
          deduped: afterSecond.chipCount < 2,
          settled: [settled1, settled2],
          attachmentsRequests: attachments.length,
          totalUpstreamBytes: attachments.reduce((s, e) => s + storedParts(e).bytes, 0),
          whyComplex: "去重只在同會話連續操作同一檔時暴露；單檔會話無從觀察",
        },
        networkEvidence: { attachments: attachments.map(netLine) },
        artifacts: { screenshot: shot.path },
        error: pass ? undefined : "B5 判準未全達",
      });
      await clearChips(shell);
    }

    // ───────────── B7：一次入隊 3 檔（部分壞檔） ─────────────
    if (want("B7")) {
      await clearChips(shell);
      await setText(shell, "");
      const t0 = rec.mark();
      await attachFiles(shell, [A.goodA, A.goodB, A.bad]);
      const settled = await waitChipsSettledSafe(shell, 120000);
      await shell.page.waitForTimeout(1000);
      const after = await probeComposer(shell);
      const t1 = rec.mark();
      const { attachments, videoUpload, evs } = countCase(t0, t1);
      const shot = await shell.screenshot("B7-partial-fail");
      // 若未落地：捕捉卡住的請求與 chip
      const pendingPosts = evs
        .filter((e) => ["POST", "PUT"].includes(e.method) && e.status == null && !e.failed)
        .map(netLine);
      const failedReqs = evs.filter((e) => e.failed).map(netLine);
      const goodOk = after.chips.filter((c) => !c.isError).length >= 2;
      const noStuck = after.uploadingChips === 0;
      const badChip = after.chips.find((c) => /bad\.mp4/.test(c.text));
      const pass = settled && goodOk && noStuck && !!badChip;
      saveCase("B7", {
        status: pass ? "pass" : "fail",
        title: "一次入隊多檔、部分壞檔：其餘照常、壞檔有明確結局",
        observations: {
          settled,
          chipStatuses: after.chips,
          chipCount: after.chipCount,
          errorChips: after.errorChips,
          uploadingChips: after.uploadingChips,
          stuckChips: after.chips.filter((c) => c.spinning || c.extracting),
          badFileChip: badChip || null,
          badFileExplicitOutcome: badChip ? (badChip.isError ? "error-chip" : "ready-via-fallback") : "missing",
          attachmentsRequests: attachments.length,
          videoUploadRequests: videoUpload.length,
          pendingPosts,
          failedReqs,
          note: "壞檔路徑：ingest 失敗 → 原檔直傳網關（若接受則 chip ready，非靜默丟棄）",
          whyComplex: "一次多檔才暴露逐檔獨立成敗與批次管線；單檔測不出隔離性",
        },
        networkEvidence: { attachments: attachments.map(netLine), videoUpload: videoUpload.map(netLine) },
        artifacts: { screenshot: shot.path },
        error: pass ? undefined : "B7 判準未全達（見 observations.stuckChips / pendingPosts）",
      });
      await clearChips(shell);
    }

    // ───────────── B1：連續多個大檔 ─────────────
    if (want("B1")) {
      await clearChips(shell);
      await setText(shell, "");
      const memBefore = (await probeComposer(shell)).mem;
      const t0 = rec.mark();
      const perFile = [];
      let allSettled = true;
      for (const [name, p] of [["good-a", A.goodA], ["good-b", A.goodB], ["good-c", A.goodC]]) {
        const m0 = rec.mark();
        await attachFiles(shell, p);
        const settledOne = await waitChipsSettledSafe(shell, 180000);
        allSettled = allSettled && settledOne;
        await shell.page.waitForTimeout(400);
        const m1 = rec.mark();
        const { attachments } = countCase(m0, m1);
        const st = await probeComposer(shell);
        perFile.push({
          file: name,
          sourceBytes: sizeOf(p),
          attachmentsRequests: attachments.length,
          upstreamBytes: attachments.reduce((s, e) => s + storedParts(e).bytes, 0),
          settled: settledOne,
          chipCountSoFar: st.chipCount,
          errorChips: st.errorChips,
          frameCount: st.frameCount,
          stuckChips: st.uploadingChips,
        });
      }
      const t1 = rec.mark();
      const { attachments, videoUpload } = countCase(t0, t1);
      const after = await probeComposer(shell);
      // UI 可用性：在輸入框打字再清掉
      let uiOk = false;
      try {
        await setText(shell, "ui-usable-check");
        const v = await shell.evaluate(() => (document.querySelector("#agent-composer-input") || {}).value);
        uiOk = v === "ui-usable-check";
        await setText(shell, "");
      } catch {
        uiOk = false;
      }
      const shot = await shell.screenshot("B1-multi-large");
      const totalUp = attachments.reduce((s, e) => s + storedParts(e).bytes, 0);
      const pass = allSettled && after.chipCount >= 3 && after.errorChips === 0 && attachments.length >= 3 && videoUpload.length === 0 && totalUp > 0 && totalUp <= 4 * 1024 * 1024 && uiOk;
      saveCase("B1", {
        status: pass ? "pass" : "fail",
        title: "同會話連續上傳 3 個大檔：全成功、上行小、UI 仍可用",
        observations: {
          perFile,
          allSettled,
          finalChipCount: after.chipCount,
          finalErrorChips: after.errorChips,
          finalFrameCount: after.frameCount,
          finalStuckChips: after.uploadingChips,
          attachmentsRequests: attachments.length,
          videoUploadRequests: videoUpload.length,
          totalUpstreamBytes: totalUp,
          uiStillUsable: uiOk,
          memBefore,
          memAfter: after.mem,
          authorizedRootsObservable: false,
          authorizedRootsNote: "authorizedRoots 屬桌面 pickFiles 授權根，瀏覽器附件上傳不經它，頁面無法觀測 → 未驗",
          whyComplex: "累積狀態/記憶體/授權根累積只在同會話連續操作時暴露",
        },
        networkEvidence: { attachments: attachments.map(netLine), videoUpload: videoUpload.map(netLine) },
        artifacts: { screenshot: shot.path },
        error: pass ? undefined : "B1 判準未全達",
      });
      await clearChips(shell);
    }

    // ───────────── B2：ingest 途中重整 ─────────────
    if (want("B2")) {
      await clearChips(shell);
      await setText(shell, "");
      const errCountBefore = rec.all().filter((e) => e.console === "error").length;
      await attachFiles(shell, A.goodA);
      await shell.page.waitForTimeout(350); // 上傳/抽幀途中
      const during = await probeComposer(shell);
      const midShot = await shell.screenshot("B2-mid-ingest");
      const t0 = rec.mark();
      await shell.page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
      await waitComposer(shell, 60000).catch(() => {});
      await shell.page.waitForTimeout(4000);
      const afterReload = await probeComposer(shell);
      const t1 = rec.mark();
      const evs = rec.since(t0).filter((e) => e.url && e.ts <= t1);
      const aborted = evs.filter((e) => e.failed);
      const errCountAfter = rec.all().filter((e) => e.console === "error").length;
      // 重整後仍可用：導回首頁 + 輸入框可打字
      let uiOk = false;
      try {
        await setText(shell, "reload-usable");
        const v = await shell.evaluate(() => (document.querySelector("#agent-composer-input") || {}).value);
        uiOk = v === "reload-usable";
        await setText(shell, "");
      } catch {
        uiOk = false;
      }
      const shot = await shell.screenshot("B2-after-reload");
      const pass = afterReload.chipCount === 0 && afterReload.hasTextarea && uiOk;
      saveCase("B2", {
        status: pass ? "pass" : "fail",
        title: "ingest 途中重整：無殘留/狀態錯亂",
        observations: {
          duringChipStatuses: during.chips,
          duringUploadingChips: during.uploadingChips,
          afterReloadChipCount: afterReload.chipCount,
          afterReloadHasComposer: afterReload.hasTextarea,
          afterReloadUrl: afterReload.url,
          abortedRequestsDuringReload: aborted.length,
          abortedSamples: aborted.slice(0, 6).map(netLine),
          consoleErrorsBefore: errCountBefore,
          consoleErrorsAfter: errCountAfter,
          uiUsableAfterReload: uiOk,
          whyComplex: "只在『上傳途中』重整才暴露殘留/競態；靜止狀態重整無此風險",
        },
        artifacts: { screenshot: shot.path, mid: midShot.path },
        error: pass ? undefined : "B2 判準未全達",
      });
    }

    // ───────────── A18：不可解碼假 mp4 → 降級原檔 ─────────────
    if (want("A18")) {
      await clearChips(shell);
      await setText(shell, "");
      const t0 = rec.mark();
      await attachFiles(shell, A.bad);
      const settled = await waitChipsSettledSafe(shell, 120000);
      await shell.page.waitForTimeout(800);
      const after = await probeComposer(shell);
      const t1 = rec.mark();
      const { attachments, videoUpload, evs } = countCase(t0, t1);
      const shot = await shell.screenshot("A18-bad-mp4");
      const chip = after.chips[0] || null;
      const notStuck = after.uploadingChips === 0;
      const hasOutcome = !!chip;
      const pendingPosts = evs
        .filter((e) => ["POST", "PUT"].includes(e.method) && e.status == null && !e.failed)
        .map(netLine);
      const pass = settled && notStuck && hasOutcome;
      saveCase("A18", {
        status: pass ? "pass" : "fail",
        title: "不可解碼假 mp4：ingest 失敗 → 落原檔直傳，chip 有終態不卡 uploading",
        observations: {
          settled,
          chipStatuses: after.chips,
          chipCount: after.chipCount,
          uploadingChips: after.uploadingChips,
          stuckChips: after.chips.filter((c) => c.spinning || c.extracting),
          finalOutcome: chip ? (chip.isError ? "error" : "ready") : "none",
          attachmentsRequests: attachments.length,
          videoUploadRequests: videoUpload.length,
          videoUploadURLs: videoUpload.map((e) => e.url),
          videoUploadStatus: videoUpload.map((e) => e.status),
          pendingPosts,
          note:
            videoUpload.length > 0
              ? "已觀察到 video-upload 原檔直傳（降級路徑生效）"
              : "未見 video-upload：可能直傳失敗落抽幀路徑 → 結果見 chip 狀態",
          whyComplex: "壞檔只在真實檔案輸入時暴露；此為降級路徑唯一觀測點",
        },
        networkEvidence: { attachments: attachments.map(netLine), videoUpload: videoUpload.map(netLine) },
        artifacts: { screenshot: shot.path },
        error: pass ? undefined : "A18 chip 卡在 uploading 或無終態（見 stuckChips/pendingPosts）",
      });
      await clearChips(shell);
    }

    // ───────────── 收尾 ─────────────
    const summary = {
      outDir,
      assetsDir,
      cases: results.map((r) => ({
        name: r.name,
        status: r.status,
        error: r.error || null,
        screenshot: (r.artifacts && r.artifacts.screenshot) || null,
      })),
      totalAgentMessagesPosted: counts.messages,
      generationTools: null,
      pass: results.filter((r) => r.status === "pass").length,
      fail: results.filter((r) => r.status === "fail").length,
    };
    fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
    log(`\n=== ${summary.pass} pass / ${summary.fail} fail · agentMessages=${counts.messages} ===`);
    for (const r of results) log(`  [${r.status.toUpperCase()}] ${r.name} ${r.error || ""}`);
    log(`out=${outDir}`);
  } finally {
    await shell.close().catch(() => {});
  }
}

main().catch((e) => {
  console.error("fatal:", e && (e.stack || e.message));
  fs.writeFileSync(path.join(outDir, "fatal.txt"), String((e && (e.stack || e.message)) || e));
  process.exit(2);
});
