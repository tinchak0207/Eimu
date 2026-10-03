// desktop/updater.js
//
// 0.3.2：自動更新接入點（electron-updater + generic provider）。
//
// 為什麼用 electron-updater 而不是自寫更新器：
//   - AppImage 自我替換、NSIS 安裝編排都有現成且經過檢驗的實作；
//   - 產物托管在 Vercel Blob 的固定目錄，透過 electron-builder 產出的
//     app-update.yml（由 build.publish 生成）取得 feed，不硬編 URL。
//
// 差分下載（differential download）在本主機不生效：多段 HTTP Range 請求
// 會被忽略，electron-updater 會自動退回全量下載。這是可接受的；日後若把
// 產物改放自家 nginx（支援多段 Range），差分下載就會自動生效，無需改碼。
//
// 安全邊界：本模組只在 app.isPackaged 為真時才檢查更新；開發模式（electron .）
// 一律 no-op，避免本機開發時打生產 feed。feed 覆寫僅供 E2E 用
// （EIMU_UPDATE_FEED），預設以 app-update.yml 為單一真源。

"use strict";

const { app } = require("electron");
const { autoUpdater } = require("electron-updater");

const FIRST_CHECK_DELAY_MS = 15 * 1000; // 啟動後延遲 15 秒，不阻塞視窗顯示
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 之後每 6 小時再查一次

// 由 initUpdater 注入的取主視窗函式（main.js 的 () => mainWindow）。
let getWindowRef = () => null;
// 冪等：initUpdater 只生效一次，避免重複掛事件 / 重複排程。
let started = false;

function log(...args) {
  console.log("[updater]", ...args);
}

/**
 * 更新下載完成時通知頁面（channel eimu-shell:update-ready）。
 * 視窗不在（已關閉/尚未建立）就只記 log，不視為錯誤。
 */
function notifyUpdateReady(version) {
  const win = typeof getWindowRef === "function" ? getWindowRef() : null;
  if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
    win.webContents.send("eimu-shell:update-ready", { version });
    log(`已通知頁面 update-ready version=${version}`);
    return;
  }
  log(`update-ready version=${version}（視窗不在，僅記錄）`);
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
  // 首次檢查延遲：等視窗顯示、網站載入完成再打 feed，不與首屏爭資源。
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      log("checkForUpdates 失敗:", err && err.message);
    });
  }, FIRST_CHECK_DELAY_MS);

  setInterval(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      log("checkForUpdates 失敗:", err && err.message);
    });
  }, CHECK_INTERVAL_MS);
}

/**
 * 初始化自動更新。由 main.js 在 app.whenReady() 內呼叫一次。
 * options.getWindow：取主視窗的函式（() => mainWindow）。
 */
function initUpdater(options = {}) {
  getWindowRef = typeof options.getWindow === "function" ? options.getWindow : () => null;

  if (!app.isPackaged) {
    // 開發模式（electron .）：不檢查更新。這裡刻意在掛事件/排程之前返回。
    log("未打包（app.isPackaged=false），開發模式略過自動更新檢查");
    return;
  }

  if (started) return;
  started = true;

  // 下載與安裝策略：背景自動下載；下載完成後在退出時自動安裝。
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  // E2E 用的 feed 覆寫；未設時沿用 app-update.yml（build.publish 生成）內建值。
  const feed = process.env.EIMU_UPDATE_FEED;
  if (feed) {
    log(`使用 EIMU_UPDATE_FEED 覆寫 feed: ${feed}`);
    autoUpdater.setFeedURL({ provider: "generic", url: feed });
  } else {
    log("使用 app-update.yml 內建 feed");
  }

  wireEvents();

  // main.js 已在 app ready 後呼叫本函式；再包一層 whenReady 保證排程一定在
  // app 就緒後才開始（重複呼叫安全，已 resolved 的 promise 會立即執行）。
  void app.whenReady().then(() => {
    log(`自動更新已啟動，${FIRST_CHECK_DELAY_MS / 1000}s 後首次檢查，之後每 6 小時一次`);
    scheduleChecks();
  });
}

/**
 * 套用已下載的更新並重啟。
 *   - AppImage：electron-updater 自我替換後重啟；
 *   - Windows：執行新下載的安裝檔。
 * 開發模式 no-op。
 */
function applyUpdate() {
  if (!app.isPackaged) {
    log("未打包（app.isPackaged=false），applyUpdate 略過");
    return;
  }
  log("呼叫 quitAndInstall()");
  try {
    autoUpdater.quitAndInstall();
  } catch (err) {
    log("quitAndInstall 失敗:", err && err.message);
    if (err && err.stack) log(err.stack);
  }
}

module.exports = { initUpdater, applyUpdate };
