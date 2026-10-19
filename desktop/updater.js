// desktop/updater.js
//
// 0.3.2：自动更新接入点（electron-updater + generic provider）。
//
// 为什么用 electron-updater 而不是自写更新器：
//   - AppImage 自我替换、NSIS 安装编排都有现成且经过检验的实作；
//   - 产物托管在自家 nginx 的固定目录（`${build.publish.url}`，2026-10-05 前是
//     Vercel Blob，该 store 被平台封锁后迁到 store.eimu.dev/downloads/desktop），
//     透过 electron-builder 产出的 app-update.yml（由 build.publish 生成）取得 feed，
//     不硬编 URL。
//
// 平台能力（2026-10-11 现况）：
//   - Windows（NSIS）：installer 自带 app-update.yml 的 feed，全链路可用。
//   - Linux：发行范式**必须**是 AppImage。0.3.3 曾把范式换成 tar.gz（「解压即可跑」），
//     而 electron-updater 在 Linux 只认 AppImage（吃 process.env.APPIMAGE）／deb／rpm，
//     **没有 tar.gz updater**——无 APPIMAGE 时 AppImageUpdater 直接略过检查 ⇒ Linux
//     自动更新静默失效（2026-10-05→10-11 实际发生了八天，每一轮壳层修复都送不到使用者
//     机器）。要换发行范式，先确认更新器跟得上。
//
// 差分下载（differential download）：feed 的 blockMapSize 指的是**嵌在 AppImage 档尾**
// 的 blockmap（electron-builder 的 embedded block map），因此不存在独立的
// `.blockmap` 档，更新器用 Range 读档尾即可——不要因为 `.blockmap` 404 就判定差分坏了。
// 启不启用看服务端支不支援多段 Range：自家 nginx 支援（2026-10-11 实测 0.3.3→0.3.4
// 只下载 242,243 B），Vercel Blob 不支援（多段 Range 被忽略、回整档）时自动退回全量。
//
// 安全边界：本模组只在 app.isPackaged 为真时才检查更新；开发模式（electron .）
// 一律 no-op，避免本机开发时打生产 feed。feed 覆写仅供 E2E 用
// （EIMU_UPDATE_FEED），预设以 app-update.yml 为单一真源。

"use strict";

const { app } = require("electron");
const { autoUpdater } = require("electron-updater");

const FIRST_CHECK_DELAY_MS = 15 * 1000; // 启动后延迟 15 秒，不阻塞视窗显示
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 之后每 6 小时再查一次

// 由 initUpdater 注入的取主视窗函式（main.js 的 () => mainWindow）。
let getWindowRef = () => null;
// 幂等：initUpdater 只生效一次，避免重复挂事件 / 重复排程。
let started = false;

function log(...args) {
  console.log("[updater]", ...args);
}

/**
 * 更新下载完成时通知页面（channel eimu-shell:update-ready）。
 * 视窗不在（已关闭/尚未建立）就只记 log，不视为错误。
 */
function notifyUpdateReady(version) {
  const win = typeof getWindowRef === "function" ? getWindowRef() : null;
  if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
    win.webContents.send("eimu-shell:update-ready", { version });
    log(`已通知页面 update-ready version=${version}`);
    return;
  }
  log(`update-ready version=${version}（视窗不在，仅记录）`);
}

function wireEvents() {
  autoUpdater.on("checking-for-update", () => {
    log("checking-for-update");
  });

  autoUpdater.on("update-available", (info) => {
    log(`update-available version=${info && info.version}`);
  });

  autoUpdater.on("update-not-available", (info) => {
    log(`update-not-available version=${info && info.version}`);
  });

  autoUpdater.on("download-progress", (progress) => {
    const percent = progress && typeof progress.percent === "number" ? progress.percent.toFixed(1) : "?";
    log(
      `download-progress ${percent}% (${progress && progress.transferred}/${progress && progress.total} bytes)`,
    );
  });

  autoUpdater.on("update-downloaded", (info) => {
    log(`update-downloaded version=${info && info.version}`);
    notifyUpdateReady(info && info.version);
  });

  autoUpdater.on("error", (err) => {
    log("error:", err && err.message);
    if (err && err.stack) log(err.stack);
  });
}

function scheduleChecks() {
  // 首次检查延迟：等视窗显示、网站载入完成再打 feed，不与首屏争资源。
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      log("checkForUpdates 失败:", err && err.message);
    });
  }, FIRST_CHECK_DELAY_MS);

  setInterval(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      log("checkForUpdates 失败:", err && err.message);
    });
  }, CHECK_INTERVAL_MS);
}

/**
 * 初始化自动更新。由 main.js 在 app.whenReady() 内呼叫一次。
 * options.getWindow：取主视窗的函式（() => mainWindow）。
 */
function initUpdater(options = {}) {
  getWindowRef = typeof options.getWindow === "function" ? options.getWindow : () => null;

  if (!app.isPackaged) {
    // 开发模式（electron .）：不检查更新。这里刻意在挂事件/排程之前返回。
    log("未打包（app.isPackaged=false），开发模式略过自动更新检查");
    return;
  }

  if (started) return;
  started = true;

  // 下载与安装策略：背景自动下载；下载完成后在退出时自动安装。
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  // E2E 用的 feed 覆写；未设时沿用 app-update.yml（build.publish 生成）内建值。
  const feed = process.env.EIMU_UPDATE_FEED;
  if (feed) {
    log(`使用 EIMU_UPDATE_FEED 覆写 feed: ${feed}`);
    autoUpdater.setFeedURL({ provider: "generic", url: feed });
  } else {
    log("使用 app-update.yml 内建 feed");
  }

  wireEvents();

  // main.js 已在 app ready 后呼叫本函式；再包一层 whenReady 保证排程一定在
  // app 就绪后才开始（重复呼叫安全，已 resolved 的 promise 会立即执行）。
  void app.whenReady().then(() => {
    log(`自动更新已启动，${FIRST_CHECK_DELAY_MS / 1000}s 后首次检查，之后每 6 小时一次`);
    scheduleChecks();
  });
}

/**
 * 套用已下载的更新并重启。
 *   - Windows：执行新下载的安装档。
 *   - Linux（tar.gz 发行）：不会走到这里——无 APPIMAGE 环境变数时 electron-updater
 *     不下载任何东西，也就不会发 update-ready；万一被呼叫，quitAndInstall 会抛错，
 *     下面已捕获并只记 log。
 * 开发模式 no-op。
 */
function applyUpdate() {
  if (!app.isPackaged) {
    log("未打包（app.isPackaged=false），applyUpdate 略过");
    return;
  }
  log("呼叫 quitAndInstall()");
  try {
    autoUpdater.quitAndInstall();
  } catch (err) {
    log("quitAndInstall 失败:", err && err.message);
    if (err && err.stack) log(err.stack);
  }
}

module.exports = { initUpdater, applyUpdate };
