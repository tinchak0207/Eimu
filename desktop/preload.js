// desktop/preload.js
//
// 以 contextBridge 暴露两组「极窄」能力给 www.eimu.dev 页面：
//
//   1. window.eimuLocal（W3／W6c）：本机媒体能力（5 个），加上 device bridge
//      的使用者面（authorizedRoots / bridge.{status,enable,disable} / onBridgeStatus）。
//      每个方法各自对应一个固定 eimu-local:* channel，逐一白名单、无通用 invoke。
//      真正的安全判断（origin / 路径授权 / denylist / argv 白名单 / 启停授权）
//      全在主进程 local-worker.js，preload 不是信任边界。
//
//   2. window.eimuShell（0.3.0）：自绘视窗控制钮。只暴露三个视窗动作
//      （minimize / toggleMaximize / close）、一个状态查询 isMaximized，
//      以及一个状态订阅 onMaximizeChange。titleBarOverlay 已移除，三颗钮
//      由页面自绘；导航政策仍只允许 eimu.dev（见 main.js），这里不放宽任何
//      导航或档案能力。
//
// 安全边界（两组共同）：
//   - 只暴露具名方法，各自对应一个固定 ipc channel。
//   - 不暴露 ipcRenderer、exec/spawn/shell、fs、任何通用 invoke。
//   - contextIsolation 保持开启；本档在隔离的 preload world 执行。

"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const CHANNELS = {
  capabilities: "eimu-local:capabilities",
  pickFiles: "eimu-local:pick-files",
  probe: "eimu-local:probe",
  extractFrames: "eimu-local:extract-frames",
  transcode: "eimu-local:transcode",
  // W6c：device bridge（本机档案授权）——四个 invoke + 一个 event，逐一明列。
  authorizedRoots: "eimu-local:authorized-roots",
  bridgeStatus: "eimu-local:bridge-status",
  bridgeEnable: "eimu-local:bridge-enable",
  bridgeDisable: "eimu-local:bridge-disable",
  bridgeSetMode: "eimu-local:bridge-set-mode",
  bridgeEvent: "eimu-local:bridge-state",
};

/**
 * 呼叫主进程，并把结构化信封还原成值或掷出 Error。
 * 主进程成功回 { ok:true, value }，失败回 { ok:false, code, message }。
 * code 同时编进 message 前缀（contextBridge 穿越时自订属性可能被丢弃，
 * 消费端请一律解析 message 前缀，或读 err.code）。
 */
async function call(channel, ...args) {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (res && res.ok === true) return res.value;
  const code = (res && res.code) || "E_INTERNAL";
  const message = (res && res.message) || "未知错误";
  const err = new Error(`${code}: ${message}`);
  err.name = "EimuLocalError";
  err.code = code;
  throw err;
}

contextBridge.exposeInMainWorld("eimuLocal", {
  // 探测本机 ffmpeg 是否可用。
  capabilities: () => call(CHANNELS.capabilities),

  // 开原生挑档对话框；只有使用者主动挑选的路径才会被主进程授权。
  // opts: { kind?: 'files'|'directory', multiple?: boolean, filters?: [{name,extensions}] }
  pickFiles: (opts) => call(CHANNELS.pickFiles, opts && typeof opts === "object" ? opts : {}),

  // 读取已授权档案的媒体资讯（ffprobe）。
  probe: (filePath) => call(CHANNELS.probe, String(filePath)),

  // 抽关键帧到主进程管理的输出目录。
  // plan: { count?: number, timesSec?: number[], maxWidth?: number }
  extractFrames: (filePath, plan) =>
    call(CHANNELS.extractFrames, String(filePath), plan && typeof plan === "object" ? plan : null),

  // 转码（本机 ffmpeg），回传输出档绝对路径。
  // opts: { format?, videoCodec?, preset?, crf?, audioCodec?, audioBitrateKbps?, maxWidth?, maxHeight?, copy?, faststart?, outputPath?, timeoutMs? }
  transcode: (filePath, opts) =>
    call(CHANNELS.transcode, String(filePath), opts && typeof opts === "object" ? opts : {}),

  // W6c：目前已授权的根目录（绝对路径 realpath）。由 pickFiles 累积。
  authorizedRoots: () => call(CHANNELS.authorizedRoots),

  // W6c：device bridge（让云端 agent 读本机**已授权**档案）。具名方法各自对应
  // 一个固定 channel；真正的启停与授权判断在主进程 local-worker.js／main.js。
  // 契约：status/enable/disable/setMode 皆回 { enabled, state, roots, deviceId, mode, lastError? }。
  bridge: {
    status: () => call(CHANNELS.bridgeStatus),
    enable: () => call(CHANNELS.bridgeEnable),
    disable: () => call(CHANNELS.bridgeDisable),
    // W6c：设定权限模式（"off"|"ask"|"auto"|"full"）。非法值由主进程回 E_BAD_ARGS。
    setMode: (mode) => call(CHANNELS.bridgeSetMode, typeof mode === "string" ? mode : ""),
  },

  // W6c：订阅 bridge 状态变化，回传取消订阅函式（比照 eimuShell.onMaximizeChange）。
  onBridgeStatus: (cb) => {
    if (typeof cb !== "function") return () => {};
    const listener = (_event, payload) => cb(payload && typeof payload === "object" ? payload : {});
    ipcRenderer.on(CHANNELS.bridgeEvent, listener);
    return () => ipcRenderer.removeListener(CHANNELS.bridgeEvent, listener);
  },
});

// 0.3.0：自绘视窗控制钮。只做视窗动作与状态查询，不接受任何目标视窗参数
// （目标由主进程以 event.sender 反查，见 window-controls.js）。
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
  // 让页面可依平台微调控制钮摆位（macOS 左上、其余右上）。
  platform: process.platform,

  minimize: () => ipcRenderer.send(SHELL_CHANNELS.minimize),
  toggleMaximize: () => ipcRenderer.send(SHELL_CHANNELS.toggleMaximize),
  close: () => ipcRenderer.send(SHELL_CHANNELS.close),
  isMaximized: () => ipcRenderer.invoke(SHELL_CHANNELS.isMaximized),

  // 订阅最大化状态变化，回传取消订阅函式（供 React effect cleanup 用）。
  onMaximizeChange: (cb) => {
    if (typeof cb !== "function") return () => {};
    const listener = (_event, payload) =>
      cb(Boolean(payload && payload.maximized));
    ipcRenderer.on(SHELL_CHANNELS.state, listener);
    return () => ipcRenderer.removeListener(SHELL_CHANNELS.state, listener);
  },

  // 0.3.2：自动更新。订阅「更新已下载、待重启套用」，回传取消订阅函式
  // （比照 onMaximizeChange）。payload 为 { version }。
  onUpdateReady: (cb) => {
    if (typeof cb !== "function") return () => {};
    const listener = (_event, payload) =>
      cb(payload && typeof payload === "object" ? payload : {});
    ipcRenderer.on(SHELL_CHANNELS.updateReady, listener);
    return () => ipcRenderer.removeListener(SHELL_CHANNELS.updateReady, listener);
  },

  // 0.3.2：套用已下载的更新并重启（主进程 updater.js applyUpdate）。
  applyUpdate: () => ipcRenderer.send(SHELL_CHANNELS.applyUpdate),
});
