// desktop/scripts/e2e/verify-e2e-gate.mjs
//
// 一次性验证脚本（本轮安全收尾用）：证明 E2E 闸门在「打包产物」的行为两态。
//
//   状态 A（预设，不带 EIMU_E2E=1）：即使设了 EIMU_APP_ORIGIN 与
//     EIMU_E2E_PICK_FILES，两者都必须被忽略 ——
//       - 壳仍载入生产站（不载入我们指定的 localhost origin）；
//       - shell log 不得出现两条 audit warn（E2E origin 覆写生效／E2E 授权闸生效）；
//       - probe(pick 目标) 不得成功（授权闸没被旁路）。
//   状态 B（带 EIMU_E2E=1）：两闸生效 ——
//       - 壳载入指定 origin；
//       - pickFiles() 直接回传 override 路径（未开对话框）；
//       - probe(该路径) 成功（授权成立）；
//       - shell log 出现两条 audit warn。
//
// 用真「打包」二进位（app.isPackaged === true）：由呼叫方先备好
// /tmp/e2e-verify/unpacked/eimu-desktop（可用 VERIFY_BINARY 覆写）。
//
// 可执行：node desktop/scripts/e2e/verify-e2e-gate.mjs
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { launchShell } from "./harness.mjs";

const BINARY =
  process.env.VERIFY_BINARY || "/tmp/e2e-verify/unpacked/eimu-desktop";
const WORK = "/tmp/e2e-verify";
const PICK_TARGET = path.join(WORK, "pick-target.png");
// 1x1 PNG（让 probe 的 ffprobe 有真档案可读，避免用文字档误判）。
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

// ---------------- 状态 A：预设（不带 EIMU_E2E） ----------------
{
  const { srv, port } = await startServer();
  const origin = `http://127.0.0.1:${port}`;
  fs.writeFileSync(PICK_TARGET, PNG_1x1);
  const shell = await launchShell({
    binary: BINARY,
    outDir: path.join(WORK, "out-a"),
    // 两个闸门的 env 都设，但**故意不设 EIMU_E2E=1**。
    // 用 extraEnv（而非 opts.origin）以免 harness 依 origin 去做 host 比对。
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
      logHasOriginOverrideWarn: log.includes("E2E origin 覆写生效"),
      logHasPickGateWarn: log.includes("E2E 授权闸生效"),
      // 期望：载入的不是我们指定的 localhost origin
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

// ---------------- 状态 B：显式 EIMU_E2E=1 ----------------
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
      logHasOriginOverrideWarn: log.includes("E2E origin 覆写生效"),
      logHasPickGateWarn: log.includes("E2E 授权闸生效"),
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