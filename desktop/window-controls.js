// desktop/window-controls.js
//
// 0.3.0：自繪視窗控制鈕的殼側端點。
//
// 背景：KDE 深色原生標題列與淺色頁面衝突（吃掉一整條高度）且系統畫的
// titleBarOverlay 按鈕形狀無法自訂，所以 0.3.0 移除 titleBarOverlay，改由
// 遠端頁面自己畫「最小化／最大化／關閉」三顆鈕。本模組是殼提供給網頁的
// 唯一視窗操作面，只做「動視窗」，不含業務邏輯。
//
// 抽成獨立模組的原因：main.js 與驗證 harness 共用同一份實作，讓「網頁按下
// 去真的改變了視窗狀態」可以用真行為斷言（不是字串比對）。
//
// 一律以 BrowserWindow.fromWebContents(event.sender) 取得目標視窗，不用全域
// mainWindow：子視窗（微信登入彈窗）也載同一份 preload，動作必須落在發出
// 請求的那個視窗上，否則子視窗的按鈕會去動主視窗。
//
// 安全：僅登記四個固定 channel，參數一概忽略（不接受任何來自頁面的目標視窗
// 或座標）。頁面無法藉此取得任何主進程能力。

"use strict";

const { BrowserWindow } = require("electron");

const CHANNELS = {
  minimize: "eimu-shell:minimize",
  toggleMaximize: "eimu-shell:toggle-maximize",
  close: "eimu-shell:close",
  isMaximized: "eimu-shell:is-maximized",
  state: "eimu-shell:state",
};

function windowFor(event) {
  return BrowserWindow.fromWebContents(event.sender) || null;
}

/**
 * 登記三個動作 channel（send）與一個狀態查詢（handle）。
 * 由 main.js 在 app ready 時呼叫一次即可（ipcMain 是 session 級、非視窗級）。
 */
function registerWindowControlsIpc(ipcMain) {
  ipcMain.on(CHANNELS.minimize, (event) => {
    const win = windowFor(event);
    if (win && !win.isDestroyed()) win.minimize();
  });

  ipcMain.on(CHANNELS.toggleMaximize, (event) => {
    const win = windowFor(event);
    if (!win || win.isDestroyed()) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });

  ipcMain.on(CHANNELS.close, (event) => {
    const win = windowFor(event);
    if (win && !win.isDestroyed()) win.close();
  });

  ipcMain.handle(CHANNELS.isMaximized, (event) => {
    const win = windowFor(event);
    if (!win || win.isDestroyed()) return false;
    return win.isMaximized() || win.isFullScreen();
  });
}

/**
 * 把視窗的最大化狀態推給該視窗的頁面（channel `eimu-shell:state`）。
 * 主視窗必掛；子視窗也掛（子視窗不需要控制鈕，但掛著不會壞，且避免頁面
 * 自行訂閱後永遠收不到初始狀態更新的落差）。
 *
 * 涵蓋 maximize/unmaximize 與 full-screen 進出：全螢幕時頁面也應把「還原」
 * 圖標換成「最大化」，所以兩者都視為 maximized=true。
 */
function attachWindowStateBroadcast(win) {
  const send = () => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send(CHANNELS.state, {
      maximized: win.isMaximized() || win.isFullScreen(),
    });
  };
  for (const eventName of [
    "maximize",
    "unmaximize",
    "enter-full-screen",
    "leave-full-screen",
  ]) {
    win.on(eventName, send);
  }
}

module.exports = {
  CHANNELS,
  registerWindowControlsIpc,
  attachWindowStateBroadcast,
};
