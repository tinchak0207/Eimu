// desktop/scripts/e2e/bug1-regression.mjs
//
// BUG-1 真殼回歸：不可解碼影片附件 → chip 永久卡在 uploading（降級路徑從未執行）。
//
// 新案例檔（不改 harness.mjs / run.mjs / cases.mjs / session-cases.mjs）。
// 真殼 + CDP 啟動配方沿用 harness.mjs；前端跑「本機 dev server 上已修復的 bundle」，
// 後端以 CDP Fetch 攔截 mock（不得部署、不得連 VPS/DB、不得呼叫付費上游）。
//
// 用法：
//   node desktop/scripts/e2e/bug1-regression.mjs \
//     --origin http://127.0.0.1:3996 \
//     --assets /tmp/bug1-e2e/assets \
//     --out /tmp/bug1-e2e/run-<ts>
//
// 產物：outDir/BUG1-A18.json、BUG1-A18.png、BUG1-B7.json、BUG1-B7.png、summary.json

import fs from "node:fs";
import path from "node:path";
import { launchShell } from "./harness.mjs";

function parseArgs(argv) {
  const out = { out: null, assets: null, origin: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") out.out = argv[++i];
    else if (a === "--assets") out.assets = argv[++i];
    else if (a === "--origin") out.origin = argv[++i];
  }
  return out;
}

const FILE_SEL = 'input[type="file"][accept*=".mp4"]';
const SESSION_ID = "e2e-bug1-session";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────── 後端 mock（CDP Fetch 攔截；不觸網）

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
// 網關是跨域（store.tinchak0207.xyz）：mock 回應必須帶 CORS 頭，否則瀏覽器會擋掉
// 回應、把成功的直傳誤判成失敗（生產網關本身有 CORS）。
const jsonHeaders = [
  { name: "content-type", value: "application/json" },
  { name: "access-control-allow-origin", value: "*" },
];

async function installBackendMock(shell) {
  const cdp = await shell.context.newCDPSession(shell.page);
  await cdp.send("Fetch.enable", {
    patterns: [
      { urlPattern: "*/api/agent/sessions*", requestStage: "Request" },
      { urlPattern: "https://store.tinchak0207.xyz/*", requestStage: "Request" },
      { urlPattern: "*/e2e-events*", requestStage: "Request" },
    ],
  });

  const requests = [];
  cdp.on("Fetch.requestPaused", async (p) => {
    const { requestId, request } = p;
    const url = request.url;
    const method = request.method;
    const postData = request.postData || "";
    const parts = [...postData.matchAll(/filename="([^"]*)"/g)].map((m) => m[1]);
    const rec = {
      ts: Date.now(),
      method,
      url: url.replace(/\?.*/, "?…"),
      urlWithQuery: url,
      postBytes: postData.length || null,
      parts: parts.length ? parts : null,
      kind: null,
      responseCode: null,
    };

    const fulfill = async (code, headers, body) => {
      rec.responseCode = code;
      requests.push(rec);
      await cdp.send("Fetch.fulfillRequest", { requestId, responseCode: code, responseHeaders: headers, body: b64(body) });
    };

    try {
      const u = new URL(url);
      // 1) 建会话
      if (u.pathname === "/api/agent/sessions" && method === "POST") {
        rec.kind = "create-session";
        return await fulfill(200, jsonHeaders, JSON.stringify({ session_id: SESSION_ID }));
      }
      if (u.pathname === "/api/agent/sessions" && method === "GET") {
        rec.kind = "list-sessions";
        return await fulfill(200, jsonHeaders, JSON.stringify({ sessions: [] }));
      }
      // 2) SSE 票：回 503 讓 openConnection 快速失敗並退避（1s→2s→…），
      //    避免 mock 事件流瞬間結束造成的重連風暴干擾附件觀察。
      if (/\/api\/agent\/sessions\/[^/]+\/sse-ticket$/.test(u.pathname)) {
        rec.kind = "sse-ticket";
        return await fulfill(503, jsonHeaders, JSON.stringify({ error: "e2e_no_sse" }));
      }
      // 3) 上傳票（原檔直傳降級路徑要先鑄票）
      if (/\/api\/agent\/sessions\/[^/]+\/uploads-ticket$/.test(u.pathname)) {
        rec.kind = "uploads-ticket";
        return await fulfill(200, jsonHeaders, JSON.stringify({ ticket: "e2e-upload-ticket", expires_in_ms: 3600000 }));
      }
      // 4) 附件上傳（衍生檔／抽幀）
      if (/\/api\/agent\/sessions\/[^/]+\/attachments$/.test(u.pathname) && method === "POST") {
        rec.kind = "attachments";
        const names = parts.length ? parts : ["unknown"];
        const attachments = names.map((n) => ({
          name: n,
          path: `uploads/${SESSION_ID}/${n}`,
          size: 1,
          mime: n.endsWith(".jpg") ? "image/jpeg" : n.endsWith(".json") ? "application/json" : "video/mp4",
        }));
        return await fulfill(200, jsonHeaders, JSON.stringify({ attachments }));
      }
      // 5) 原檔直傳網關（降級路徑的觀測點）
      if (/\/agent\/v1\/sessions\/[^/]+\/video-upload$/.test(u.pathname) && method === "POST") {
        rec.kind = "video-upload";
        const fname = parts[0] || "bad.mp4";
        return await fulfill(
          200,
          jsonHeaders,
          JSON.stringify({ ok: true, path: `uploads/${SESSION_ID}/${fname}`, name: fname, size: 1500000, mime: "video/mp4" }),
        );
      }
      // 6) SSE 本體：回空事件流（EventSource 會自行重連，不影響附件流程）
      if (u.pathname === "/e2e-events") {
        rec.kind = "sse-stream";
        return await fulfill(200, [{ name: "content-type", value: "text/event-stream" }], "");
      }
      // 其他 /api/agent/* 一律回空 JSON（best-effort 端點，不擋流程）
      rec.kind = "misc";
      return await fulfill(200, jsonHeaders, JSON.stringify({}));
    } catch (e) {
      rec.kind = rec.kind || "mock-error";
      rec.error = String(e && e.message);
      try {
        await cdp.send("Fetch.continueRequest", { requestId });
      } catch {
        /* ignore */
      }
    }
  });

  return {
    requests: () => requests.slice(),
    since: (ts) => requests.filter((r) => r.ts >= ts),
    mark: () => Date.now(),
  };
}

// ─────────────────────── 頁面探針 / 操作

async function probeComposer(shell) {
  return await shell.evaluate(() => {
    const ta = document.querySelector("#agent-composer-input");
    const chips = [...document.querySelectorAll('[aria-label^="移除 "]')].map((btn) => {
      const el = btn.closest("span");
      const cls = (el && el.className) || "";
      const txt = (el && el.innerText) || "";
      const r = el ? el.getBoundingClientRect() : null;
      return {
        text: txt.trim(),
        spinning: !!(el && el.querySelector(".animate-spin")),
        isError: cls.includes("destructive"),
        extracting: txt.includes("抽帧"),
        rect: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null,
      };
    });
    const taRect = ta ? ta.getBoundingClientRect() : null;
    const frames = [...document.querySelectorAll('img[alt^="第 "]')].map((i) => i.alt);
    return {
      url: location.href,
      hasTextarea: !!ta,
      composerRect: taRect ? { x: Math.round(taRect.x), y: Math.round(taRect.y), w: Math.round(taRect.width), h: Math.round(taRect.height) } : null,
      chips,
      chipCount: chips.length,
      uploadingChips: chips.filter((c) => c.spinning || c.extracting).length,
      errorChips: chips.filter((c) => c.isError).length,
      frameCount: frames.length,
      frameAlts: frames,
    };
  });
}

async function waitComposer(shell, timeout = 60000) {
  await shell.page.waitForSelector("#agent-composer-input", { state: "visible", timeout });
}

/** 關掉進站宣傳片浮層（未登入新訪客會蓋在首頁上；會擋住後續點擊與截圖）。
 * 「跳过」→ 片尾卡 →「先逛逛」才是真正 onDismiss 關閉浮層。 */
async function dismissPromo(shell, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let clicked = false;
  const tryClick = async (text) => {
    const loc = shell.page.locator("button", { hasText: text }).first();
    const n = await loc.count().catch(() => 0);
    if (n && (await loc.isVisible().catch(() => false))) {
      await loc.click({ timeout: 3000, force: true }).catch(() => {});
      clicked = true;
      await shell.page.waitForTimeout(600);
      return true;
    }
    return false;
  };
  let goneFor = 0;
  while (Date.now() < deadline) {
    const skip = await tryClick("跳过");
    const browse = await tryClick("先逛逛");
    if (!skip && !browse) {
      // 兩個按鈕都不在 → 浮層已關；連續兩拍確認（避免片尾卡延遲出現）。
      if (++goneFor >= 2) break;
      await shell.page.waitForTimeout(700);
    } else {
      goneFor = 0;
    }
  }
  return clicked;
}

async function waitChipsSettledSafe(shell, timeout = 30000) {
  try {
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
    return true;
  } catch {
    return false;
  }
}

async function clearChips(shell) {
  for (let i = 0; i < 12; i++) {
    const btns = shell.page.locator('[aria-label^="移除 "]');
    const n = await btns.count().catch(() => 0);
    if (!n) break;
    await btns.first().click({ timeout: 5000, force: true }).catch(() => {});
    await shell.page.waitForTimeout(120);
  }
}

/** 附件 chip 的元素截圖（比整頁更能看清終態；失敗回 null）。 */
async function shotChipRow(shell, name) {
  const chip = shell.page.locator('[aria-label^="移除 "]').first();
  try {
    if (!(await chip.count())) return null;
    await chip.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    const file = path.join(shell.outDir, `${name}-chip.png`);
    await chip.screenshot({ path: file, timeout: 5000 });
    return file;
  } catch {
    return null;
  }
}

async function attachFiles(shell, files) {
  const list = Array.isArray(files) ? files : [files];
  if (!shell._e2eCdp) {
    shell._e2eCdp = await shell.context.newCDPSession(shell.page);
    await shell._e2eCdp.send("DOM.enable");
  }
  const cdp = shell._e2eCdp;
  const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: FILE_SEL });
  if (!nodeId) throw new Error("file input nodeId 為空");
  await cdp.send("DOM.setFileInputFiles", { files: list, nodeId });
}

// ─────────────────────── 主流程

const args = parseArgs(process.argv);
const outDir = args.out || path.join("/tmp", `eimu-bug1-e2e-${Date.now()}`);
const assetsDir = args.assets;
const origin = args.origin || "http://127.0.0.1:3996";
fs.mkdirSync(outDir, { recursive: true });

if (!assetsDir || !fs.existsSync(path.join(assetsDir, "bad.mp4"))) {
  console.error("缺少素材：--assets 需含 good-a.mp4/good-b.mp4/bad.mp4");
  process.exit(2);
}
const A = {
  goodA: path.join(assetsDir, "good-a.mp4"),
  goodB: path.join(assetsDir, "good-b.mp4"),
  bad: path.join(assetsDir, "bad.mp4"),
};

const results = [];
const log = (...a) => console.log(...a);
function saveCase(name, obj) {
  fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify(obj, null, 2));
  results.push({ ...obj, name });
  log(`▶ ${name}: ${obj.error ? "FAIL " + obj.error : "PASS"}`);
}

async function main() {
  log(`BUG-1 真殼回歸（本機已修復前端 + mocked 後端）`);
  log(`origin=${origin}\nout=${outDir}\nassets=${assetsDir}`);

  const shell = await launchShell({ outDir: path.join(outDir, "shell"), origin });
  try {
    const mock = await installBackendMock(shell);
    await shell.page.waitForLoadState("domcontentloaded").catch(() => {});
    await shell.page.goto(`${origin}/`, { waitUntil: "domcontentloaded" }).catch(() => {});
    await waitComposer(shell, 90000);
    await shell.page.waitForTimeout(1500);
    const dismissedPromo = await dismissPromo(shell);
    await shell.page.waitForTimeout(1000);
    const boot = await probeComposer(shell);
    log(`boot: ${boot.url} textarea=${boot.hasTextarea} promoDismissed=${dismissedPromo}`);
    await shell.screenshot("boot");

    // ───────── BUG1-A18：單一不可解碼 mp4 ─────────
    {
      await clearChips(shell);
      const t0 = mock.mark();
      await attachFiles(shell, A.bad);
      const settled = await waitChipsSettledSafe(shell, 30000);
      await shell.page.waitForTimeout(500);
      const after = await probeComposer(shell);
      const t1 = mock.mark();
      const evs = mock.since(t0).filter((r) => r.ts <= t1);
      const videoUpload = evs.filter((r) => r.kind === "video-upload");
      const uploadsTicket = evs.filter((r) => r.kind === "uploads-ticket");
      const attachments = evs.filter((r) => r.kind === "attachments");
      const shot = await shell.screenshot("BUG1-A18");
      const chipShot = await shotChipRow(shell, "BUG1-A18");
      const badChip = after.chips[0] || null;
      const notStuck = after.uploadingChips === 0;
      const pass = settled && notStuck && !!videoUpload.length;
      saveCase("BUG1-A18", {
        status: pass ? "pass" : "fail",
        title: "不可解碼假 mp4 → 立即降級原檔直傳，chip 有終態不卡 uploading",
        observations: {
          settled,
          chipStatuses: after.chips,
          uploadingChips: after.uploadingChips,
          finalOutcome: badChip ? (badChip.isError ? "error" : badChip.spinning ? "uploading" : "ready") : "none",
          uploadsTicketRequests: uploadsTicket.length,
          videoUploadRequests: videoUpload.length,
          videoUploadURLs: videoUpload.map((r) => r.url),
          videoUploadResponseCodes: videoUpload.map((r) => r.responseCode),
          attachmentsRequests: attachments.length,
        },
        networkEvidence: evs.map((r) => ({ method: r.method, url: r.url, kind: r.kind, code: r.responseCode, postBytes: r.postBytes, parts: r.parts })),
        artifacts: { screenshot: shot.path, chipScreenshot: chipShot },
        error: pass ? undefined : "A18 未達：chip 未進入終態或未見 video-upload 降級請求",
      });
      await clearChips(shell);
    }

    // ───────── BUG1-B7：多檔含壞檔 ─────────
    {
      await clearChips(shell);
      const t0 = mock.mark();
      await attachFiles(shell, [A.goodA, A.goodB, A.bad]);
      const settled = await waitChipsSettledSafe(shell, 60000);
      await shell.page.waitForTimeout(800);
      const after = await probeComposer(shell);
      const t1 = mock.mark();
      const evs = mock.since(t0).filter((r) => r.ts <= t1);
      const videoUpload = evs.filter((r) => r.kind === "video-upload");
      const attachments = evs.filter((r) => r.kind === "attachments");
      const shot = await shell.screenshot("BUG1-B7");
      const chipShot = await shotChipRow(shell, "BUG1-B7");
      const goodChips = after.chips.filter((c) => !c.isError && !/bad\.mp4/.test(c.text));
      const badChip = after.chips.find((c) => /bad\.mp4/.test(c.text)) || null;
      const noStuck = after.uploadingChips === 0;
      // 好檔 2 個各走 attachments 一次（衍生檔）；壞檔 1 次 video-upload
      const pass = settled && noStuck && goodChips.length >= 2 && attachments.length >= 2 && videoUpload.length >= 1 && !!badChip;
      saveCase("BUG1-B7", {
        status: pass ? "pass" : "fail",
        title: "一次入隊 good-a/good-b/bad：好檔照常、壞檔降級直傳、無 chip 卡住",
        observations: {
          settled,
          chipStatuses: after.chips,
          uploadingChips: after.uploadingChips,
          errorChips: after.errorChips,
          goodChips: goodChips.length,
          badFileChip: badChip,
          badFileExplicitOutcome: badChip ? (badChip.isError ? "error-chip" : badChip.spinning ? "still-spinning" : "ready-via-fallback") : "missing",
          attachmentsRequests: attachments.length,
          videoUploadRequests: videoUpload.length,
          videoUploadURLs: videoUpload.map((r) => r.url),
        },
        networkEvidence: evs.map((r) => ({ method: r.method, url: r.url, kind: r.kind, code: r.responseCode, postBytes: r.postBytes, parts: r.parts })),
        artifacts: { screenshot: shot.path, chipScreenshot: chipShot },
        error: pass ? undefined : "B7 判準未全達（好檔未成功 / 壞檔未降級 / 仍有 chip 卡住）",
      });
      await clearChips(shell);
    }

    const summary = {
      outDir,
      origin,
      cases: results.map((r) => ({
        name: r.name,
        status: r.status,
        error: r.error || null,
        screenshot: (r.artifacts && r.artifacts.screenshot) || null,
      })),
      pass: results.filter((r) => r.status === "pass").length,
      fail: results.filter((r) => r.status === "fail").length,
    };
    fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
    log(`\n=== ${summary.pass} pass / ${summary.fail} fail ===`);
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
