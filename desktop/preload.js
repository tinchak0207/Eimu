// desktop/preload.js
//
// 以 contextBridge 暴露兩組「極窄」能力給 www.eimu.dev 頁面：
//
//   1. window.eimuLocal（W3／W6c）：本機媒體能力（5 個），加上 device bridge
//      的使用者面（authorizedRoots / bridge.{status,enable,disable} / onBridgeStatus）。
//      每個方法各自對應一個固定 eimu-local:* channel，逐一白名單、無通用 invoke。
//      真正的安全判斷（origin / 路徑授權 / denylist / argv 白名單 / 啟停授權）
//      全在主進程 local-worker.js，preload 不是信任邊界。
//
//   2. window.eimuShell（0.3.0）：自繪視窗控制鈕。只暴露三個視窗動作
//      （minimize / toggleMaximize / close）、一個狀態查詢 isMaximized，
//      以及一個狀態訂閱 onMaximizeChange。titleBarOverlay 已移除，三顆鈕
//      由頁面自繪；導航政策仍只允許 eimu.dev（見 main.js），這裡不放寬任何
//      導航或檔案能力。
//
// 安全邊界（兩組共同）：
//   - 只暴露具名方法，各自對應一個固定 ipc channel。
//   - 不暴露 ipcRenderer、exec/spawn/shell、fs、任何通用 invoke。
//   - contextIsolation 保持開啟；本檔在隔離的 preload world 執行。

"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const CHANNELS = {
  capabilities: "eimu-local:capabilities",
  pickFiles: "eimu-local:pick-files",
  probe: "eimu-local:probe",
  extractFrames: "eimu-local:extract-frames",
  transcode: "eimu-local:transcode",
  // W6c：device bridge（本機檔案授權）——四個 invoke + 一個 event，逐一明列。
  authorizedRoots: "eimu-local:authorized-roots",
  bridgeStatus: "eimu-local:bridge-status",
  bridgeEnable: "eimu-local:bridge-enable",
  bridgeDisable: "eimu-local:bridge-disable",
  bridgeSetMode: "eimu-local:bridge-set-mode",
  bridgeEvent: "eimu-local:bridge-state",
};

/**
 * 呼叫主進程，並把結構化信封還原成值或擲出 Error。
 * 主進程成功回 { ok:true, value }，失敗回 { ok:false, code, message }。
 * code 同時編進 message 前綴（contextBridge 穿越時自訂屬性可能被丟棄，
 * 消費端請一律解析 message 前綴，或讀 err.code）。
 */
async function call(channel, ...args) {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (res && res.ok === true) return res.value;
  const code = (res && res.code) || "E_INTERNAL";
  const message = (res && res.message) || "未知錯誤";
  const err = new Error(`${code}: ${message}`);
  err.name = "EimuLocalError";
  err.code = code;
  throw err;
}

contextBridge.exposeInMainWorld("eimuLocal", {
  // 探測本機 ffmpeg 是否可用。
  capabilities: () => call(CHANNELS.capabilities),

  // 開原生挑檔對話框；只有使用者主動挑選的路徑才會被主進程授權。
  // opts: { kind?: 'files'|'directory', multiple?: boolean, filters?: [{name,extensions}] }
  pickFiles: (opts) => call(CHANNELS.pickFiles, opts && typeof opts === "object" ? opts : {}),

  // 讀取已授權檔案的媒體資訊（ffprobe）。
  probe: (filePath) => call(CHANNELS.probe, String(filePath)),

  // 抽關鍵幀到主進程管理的輸出目錄。
  // plan: { count?: number, timesSec?: number[], maxWidth?: number }
  extractFrames: (filePath, plan) =>
    call(CHANNELS.extractFrames, String(filePath), plan && typeof plan === "object" ? plan : null),

  // 轉碼（本機 ffmpeg），回傳輸出檔絕對路徑。
  // opts: { format?, videoCodec?, preset?, crf?, audioCodec?, audioBitrateKbps?, maxWidth?, maxHeight?, copy?, faststart?, outputPath?, timeoutMs? }
  transcode: (filePath, opts) =>
    call(CHANNELS.transcode, String(filePath), opts && typeof opts === "object" ? opts : {}),

  // W6c：目前已授權的根目錄（絕對路徑 realpath）。由 pickFiles 累積。
  authorizedRoots: () => call(CHANNELS.authorizedRoots),

  // W6c：device bridge（讓雲端 agent 讀本機**已授權**檔案）。具名方法各自對應
  // 一個固定 channel；真正的啟停與授權判斷在主進程 local-worker.js／main.js。
  // 契約：status/enable/disable/setMode 皆回 { enabled, state, roots, deviceId, mode, lastError? }。
  bridge: {
    status: () => call(CHANNELS.bridgeStatus),
    enable: () => call(CHANNELS.bridgeEnable),
    disable: () => call(CHANNELS.bridgeDisable),
    // W6c：設定權限模式（"off"|"ask"|"auto"|"full"）。非法值由主進程回 E_BAD_ARGS。
    setMode: (mode) => call(CHANNELS.bridgeSetMode, typeof mode === "string" ? mode : ""),
  },

  // W6c：訂閱 bridge 狀態變化，回傳取消訂閱函式（比照 eimuShell.onMaximizeChange）。
  onBridgeStatus: (cb) => {
    if (typeof cb !== "function") return () => {};
    const listener = (_event, payload) => cb(payload && typeof payload === "object" ? payload : {});
    ipcRenderer.on(CHANNELS.bridgeEvent, listener);
    return () => ipcRenderer.removeListener(CHANNELS.bridgeEvent, listener);
  },
});

// 0.3.0：自繪視窗控制鈕。只做視窗動作與狀態查詢，不接受任何目標視窗參數
// （目標由主進程以 event.sender 反查，見 window-controls.js）。
const SHELL_CHANNELS = {
  minimize: "eimu-shell:minimize",
  toggleMaximize: "eimu-shell:toggle-maximize",
  close: "eimu-shell:close",
  isMaximized: "eimu-shell:is-maximized",
  state: "eimu-shell:state",
  updateReady: "eimu-shell:update-ready",
  applyUpdate: "eimu-shell:apply-update",
};

contextBridge.exposeInMainWorld("eimuShell", {
  // 讓頁面可依平台微調控制鈕擺位（macOS 左上、其餘右上）。
  platform: process.platform,

  minimize: () => ipcRenderer.send(SHELL_CHANNELS.minimize),
  toggleMaximize: () => ipcRenderer.send(SHELL_CHANNELS.toggleMaximize),
  close: () => ipcRenderer.send(SHELL_CHANNELS.close),
  isMaximized: () => ipcRenderer.invoke(SHELL_CHANNELS.isMaximized),

  // 訂閱最大化狀態變化，回傳取消訂閱函式（供 React effect cleanup 用）。
  onMaximizeChange: (cb) => {
    if (typeof cb !== "function") return () => {};
    const listener = (_event, payload) =>
      cb(Boolean(payload && payload.maximized));
    ipcRenderer.on(SHELL_CHANNELS.state, listener);
    return () => ipcRenderer.removeListener(SHELL_CHANNELS.state, listener);
  },

  // 0.3.2：自動更新。訂閱「更新已下載、待重啟套用」，回傳取消訂閱函式
  // （比照 onMaximizeChange）。payload 為 { version }。
  onUpdateReady: (cb) => {
    if (typeof cb !== "function") return () => {};
    const listener = (_event, payload) =>
      cb(payload && typeof payload === "object" ? payload : {});
    ipcRenderer.on(SHELL_CHANNELS.updateReady, listener);
    return () => ipcRenderer.removeListener(SHELL_CHANNELS.updateReady, listener);
  },

  // 0.3.2：套用已下載的更新並重啟（主進程 updater.js applyUpdate）。
  applyUpdate: () => ipcRenderer.send(SHELL_CHANNELS.applyUpdate),
});
