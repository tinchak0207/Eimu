// desktop/scripts/e2e/cases.mjs
//
// run.mjs 讀取的測試清單。每個 case 自己負責啟動／關閉殼（及 dev server），
// 回傳 { observations, artifacts }；斷言失敗就 throw。
//
// 紅線：不修改 ~/.config/Eimu（只複製）；不發送 agent 訊息（避免付費上游）；
//       任何 token/cookie 值不得寫進 observations（只記布林／長度／狀態碼）。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  launchShell,
  startNextDev,
  waitForHttp,
  freePort,
  EIMU_LOCAL_METHODS,
} from "./harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const REAL_PROFILE = path.join(os.homedir(), ".config", "Eimu");

/** 讀取殼內頁面的 preload 契約狀態（不涉及任何憑證）。 */
async function probeShell(shell) {
  await shell.page.waitForLoadState("domcontentloaded").catch(() => {});
  return await shell.evaluate(() => ({
    url: location.href,
    title: document.title,
    eimuLocalType: typeof window.eimuLocal,
    eimuLocalMethods: window.eimuLocal ? Object.keys(window.eimuLocal) : [],
    eimuShellType: typeof window.eimuShell,
    eimuShellPlatform: window.eimuShell ? window.eimuShell.platform : null,
    nodeProcessType: typeof window.process,
    nodeRequireType: typeof window.require,
    // 本地測試模式徽章（Navbar.tsx：LOCAL_TEST_MODE ? "本地测试" : ...）
    hasLocalTestBadge: document.body ? document.body.innerText.includes("本地测试") : false,
    // agent 輸入面（AgentComposer.tsx：textarea + aria-label="发送"）
    composerTextareas: document.querySelectorAll("textarea").length,
    sendButtons: document.querySelectorAll('[aria-label="发送"]').length,
  }));
}

/** 只回傳布林／狀態碼，永不回傳 token 值。 */
async function probeAuth(shell) {
  return await shell.evaluate(async () => {
    const cookieHas = document.cookie.includes("napi_token=");
    const lsHas = !!localStorage.getItem("napi_token");
    const userLsHas = !!localStorage.getItem("napi_user");
    let token = localStorage.getItem("napi_token");
    if (!token && cookieHas) {
      const m = document.cookie.match(/(?:^|;\s*)napi_token=([^;]+)/);
      if (m) token = decodeURIComponent(m[1]);
    }
    const out = { lsHas, cookieHas, userLsHas, hasAnyToken: !!token };
    if (!token) return { ...out, meStatus: null, meOk: false, meHasUser: false };
    try {
      const res = await fetch("/api/auth/me", { headers: { Authorization: "Bearer " + token } });
      let hasUser = false;
      try {
        const j = await res.json();
        hasUser = !!(j && (j.user || (j.success && j.data) || (j.data && j.data.user)));
      } catch {
        /* non-json */
      }
      return { ...out, meStatus: res.status, meOk: res.ok, meHasUser: hasUser };
    } catch (err) {
      return { ...out, meStatus: "error:" + String((err && err.message) || err).slice(0, 40), meOk: false, meHasUser: false };
    }
  });
}

export const cases = [
  {
    name: "shell-boot-eimulocal",
    timeoutMs: 90000,
    async run({ outDir }) {
      const shell = await launchShell({ outDir, origin: undefined });
      try {
        const probe = await probeShell(shell);
        if (probe.eimuLocalType !== "object") {
          throw new Error(`window.eimuLocal typeof=${probe.eimuLocalType}，期望 object`);
        }
        const missing = EIMU_LOCAL_METHODS.filter((m) => !probe.eimuLocalMethods.includes(m));
        if (missing.length) throw new Error(`eimuLocal 缺方法：${missing.join(",")}`);
        if (probe.nodeProcessType !== "undefined" || probe.nodeRequireType !== "undefined") {
          throw new Error(`Node 物件洩漏：process=${probe.nodeProcessType} require=${probe.nodeRequireType}`);
        }
        const shot = await shell.screenshot("shell-boot-eimulocal");
        return {
          observations: {
            probe,
            shellPid: shell.pid,
            debugPort: shell.debugPort,
            network: shell.networkSummary(),
          },
          artifacts: { screenshot: shot },
        };
      } finally {
        await shell.close();
      }
    },
  },

  {
    name: "login-a-prod-profile",
    timeoutMs: 120000,
    async run({ outDir }) {
      const profileExists = fs.existsSync(REAL_PROFILE);
      const shell = await launchShell({
        outDir,
        origin: undefined,
        seedProfileFrom: profileExists ? REAL_PROFILE : undefined,
      });
      try {
        const probe = await probeShell(shell);
        const auth = await probeAuth(shell);
        const shot = await shell.screenshot("login-a-prod-profile");
        return {
          observations: {
            profileExists,
            profileCopiedOnly: profileExists,
            probe,
            auth,
            loggedIn: !!(auth.meOk && auth.meHasUser),
            network: shell.networkSummary(),
          },
          artifacts: { screenshot: shot },
        };
      } finally {
        await shell.close();
      }
    },
  },

  {
    name: "login-b-local-testmode",
    timeoutMs: 300000,
    async run({ outDir }) {
      const port = await freePort();
      const dev = startNextDev({
        port,
        cwd: REPO_ROOT,
        outDir,
        env: { NEXT_PUBLIC_LOCAL_TEST_MODE: "true" },
      });
      let shell = null;
      try {
        const ready = await waitForHttp(`http://127.0.0.1:${port}/`, { timeout: 240000 });
        if (!ready.ok) {
          throw new Error(`next dev (port ${port}) 未就緒：${JSON.stringify(ready)}；log=${dev.logPath}`);
        }
        shell = await launchShell({ outDir, origin: `http://localhost:${port}` });
        const probe = await probeShell(shell);
        if (probe.eimuLocalType !== "object") {
          throw new Error(`本地測試模式：window.eimuLocal typeof=${probe.eimuLocalType}`);
        }
        // 等 React 水合後再截（test mode 徽章在 Navbar）
        await shell.page.waitForFunction(
          () => document.body && document.body.innerText.length > 0,
          undefined,
          { timeout: 30000 },
        ).catch(() => {});
        const probe2 = await probeShell(shell);
        const shot = await shell.screenshot("login-b-local-testmode");
        return {
          observations: {
            devPort: port,
            devLog: dev.logPath,
            devReadyStatus: ready.status,
            shellOrigin: `http://localhost:${port}`,
            probe: probe2,
            testModeBypassLikely: probe2.hasLocalTestBadge,
            network: shell.networkSummary(),
          },
          artifacts: { screenshot: shot },
        };
      } finally {
        if (shell) await shell.close();
        await dev.close();
      }
    },
  },

  {
    name: "agent-surface-reachable",
    timeoutMs: 150000,
    async run({ outDir }) {
      const profileExists = fs.existsSync(REAL_PROFILE);
      const shell = await launchShell({
        outDir,
        origin: undefined,
        seedProfileFrom: profileExists ? REAL_PROFILE : undefined,
      });
      try {
        // 導覽到 agent 頁（同源、非 /api/auth，殼的導航政策放行）。
        await shell.page.goto(`${shell.origin}/agent`, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
        await shell.page.waitForTimeout(5000);
        const probe = await probeShell(shell);
        const shot = await shell.screenshot("agent-surface-reachable");
        return {
          observations: {
            profileExists,
            probe,
            composerReachable: probe.composerTextareas > 0,
            // 明確不送出（避免觸發付費上游）；僅回報輸入面是否可達。
            sentAgentMessage: false,
            note: "未點擊發送：紅線禁止呼叫付費上游，僅驗輸入面可達性。",
            network: shell.networkSummary(),
          },
          artifacts: { screenshot: shot },
        };
      } finally {
        await shell.close();
      }
    },
  },
];

export default cases;
