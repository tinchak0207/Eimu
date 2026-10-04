// desktop/window-controls.js
//
// 0.3.0：自绘视窗控制钮的壳侧端点。
//
// 背景：KDE 深色原生标题列与浅色页面冲突（吃掉一整条高度）且系统画的
// titleBarOverlay 按钮形状无法自订，所以 0.3.0 移除 titleBarOverlay，改由
// 远端页面自己画「最小化／最大化／关闭」三颗钮。本模组是壳提供给网页的
// 唯一视窗操作面，只做「动视窗」，不含业务逻辑。
//
// 抽成独立模组的原因：main.js 与验证 harness 共用同一份实作，让「网页按下
// 去真的改变了视窗状态」可以用真行为断言（不是字串比对）。
//
// 一律以 BrowserWindow.fromWebContents(event.sender) 取得目标视窗，不用全域
// mainWindow：子视窗（微信登入弹窗）也载同一份 preload，动作必须落在发出
// 请求的那个视窗上，否则子视窗的按钮会去动主视窗。
//
// 安全：仅登记四个固定 channel，参数一概忽略（不接受任何来自页面的目标视窗
// 或座标）。页面无法藉此取得任何主进程能力。

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
 * 登记三个动作 channel（send）与一个状态查询（handle）。
 * 由 main.js 在 app ready 时呼叫一次即可（ipcMain 是 session 级、非视窗级）。
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
 * 把视窗的最大化状态推给该视窗的页面（channel `eimu-shell:state`）。
 * 主视窗必挂；子视窗也挂（子视窗不需要控制钮，但挂著不会坏，且避免页面
 * 自行订阅后永远收不到初始状态更新的落差）。
 *
 * 涵盖 maximize/unmaximize 与 full-screen 进出：全萤幕时页面也应把「还原」
 * 图标换成「最大化」，所以两者都视为 maximized=true。
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
