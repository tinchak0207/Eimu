// desktop/scripts/e2e/verify-e2e-gate.mjs
//
// 一次性驗證腳本（本輪安全收尾用）：證明 E2E 閘門在「打包產物」的行為兩態。
//
//   狀態 A（預設，不帶 EIMU_E2E=1）：即使設了 EIMU_APP_ORIGIN 與
//     EIMU_E2E_PICK_FILES，兩者都必須被忽略 ——
//       - 殼仍載入生產站（不載入我們指定的 localhost origin）；
//       - shell log 不得出現兩條 audit warn（E2E origin 覆寫生效／E2E 授權閘生效）；
//       - probe(pick 目標) 不得成功（授權閘沒被旁路）。
//   狀態 B（帶 EIMU_E2E=1）：兩閘生效 ——
//       - 殼載入指定 origin；
//       - pickFiles() 直接回傳 override 路徑（未開對話框）；
//       - probe(該路徑) 成功（授權成立）；
//       - shell log 出現兩條 audit warn。
//
// 用真「打包」二進位（app.isPackaged === true）：由呼叫方先備好
// /tmp/e2e-verify/unpacked/eimu-desktop（可用 VERIFY_BINARY 覆寫）。
//
// 可執行：node desktop/scripts/e2e/verify-e2e-gate.mjs
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { launchShell } from "./harness.mjs";

const BINARY =
  process.env.VERIFY_BINARY || "/tmp/e2e-verify/unpacked/eimu-desktop";
const WORK = "/tmp/e2e-verify";
const PICK_TARGET = path.join(WORK, "pick-target.png");
// 1x1 PNG（讓 probe 的 ffprobe 有真檔案可讀，避免用文字檔誤判）。
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const PAGE = "<!doctype html><html><head><title>e2e-verify</title></head><body>e2e-verify</body></html>";

function startServer() {
  const srv = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(PAGE);
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => resolve({ srv, port: srv.address().port }));
  });
}

async function snapshot(shell) {
  const info = await shell.evaluate(() => ({
    url: location.href,
    eimuLocal: typeof window.eimuLocal,
    methods: window.eimuLocal ? Object.keys(window.eimuLocal) : [],
  }));
  return info;
}

const out = { binary: BINARY, pickTarget: PICK_TARGET };

// ---------------- 狀態 A：預設（不帶 EIMU_E2E） ----------------
{
  const { srv, port } = await startServer();
  const origin = `http://127.0.0.1:${port}`;
  fs.writeFileSync(PICK_TARGET, PNG_1x1);
  const shell = await launchShell({
    binary: BINARY,
    outDir: path.join(WORK, "out-a"),
    // 兩個閘門的 env 都設，但**故意不設 EIMU_E2E=1**。
    // 用 extraEnv（而非 opts.origin）以免 harness 依 origin 去做 host 比對。
    extraEnv: { EIMU_APP_ORIGIN: origin, EIMU_E2E_PICK_FILES: PICK_TARGET },
  });
  try {
    const info = await snapshot(shell);
    let probe = null;
    try {
      probe = await shell.evaluate((p) => window.eimuLocal.probe(p), PICK_TARGET);
    } catch (e) {
      probe = { threw: String(e && e.message ? e.message : e).slice(0, 200) };
    }
    const log = fs.readFileSync(shell.logPath, "utf8");
    out.stateA = {
      envHadAppOrigin: true,
      envHadPickFiles: true,
      envHadE2E: false,
      logHasOriginOverrideWarn: log.includes("E2E origin 覆寫生效"),
      logHasPickGateWarn: log.includes("E2E 授權閘生效"),
      // 期望：載入的不是我們指定的 localhost origin
      loadedRequestedLocalOrigin: info.url.includes(`127.0.0.1:${port}`),
      pageUrl: info.url,
      eimuLocalType: info.eimuLocal,
      methods: info.methods,
      probeResult: probe,
    };
  } finally {
    await shell.close();
    srv.close();
  }
}

// ---------------- 狀態 B：顯式 EIMU_E2E=1 ----------------
{
  const { srv, port } = await startServer();
  const origin = `http://127.0.0.1:${port}`;
  const pick2 = path.join(WORK, "pick-target-b.png");
  fs.writeFileSync(pick2, PNG_1x1);
  const shell = await launchShell({
    binary: BINARY,
    origin,
    outDir: path.join(WORK, "out-b"),
    extraEnv: { EIMU_E2E: "1", EIMU_E2E_PICK_FILES: pick2 },
  });
  try {
    const info = await snapshot(shell);
    let pick = null;
    try {
      pick = await shell.evaluate(() => window.eimuLocal.pickFiles());
    } catch (e) {
      pick = { threw: String(e && e.message ? e.message : e).slice(0, 200) };
    }
    let probe = null;
    try {
      probe = await shell.evaluate((p) => window.eimuLocal.probe(p), pick2);
    } catch (e) {
      probe = { threw: String(e && e.message ? e.message : e).slice(0, 200) };
    }
    const log = fs.readFileSync(shell.logPath, "utf8");
    out.stateB = {
      envHadE2E: true,
      logHasOriginOverrideWarn: log.includes("E2E origin 覆寫生效"),
      logHasPickGateWarn: log.includes("E2E 授權閘生效"),
      loadedRequestedLocalOrigin: info.url.includes(`127.0.0.1:${port}`),
      pageUrl: info.url,
      eimuLocalType: info.eimuLocal,
      methods: info.methods,
      pickFilesResult: pick,
      probeResult: probe,
    };
  } finally {
    await shell.close();
    srv.close();
  }
}

console.log(JSON.stringify(out, null, 2));