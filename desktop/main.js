// Eimu 桌面壳（方案①：薄壳包 eimu.dev）
//
// 设计前提：不做双端维护。这里只做「网页做不到的事」，业务逻辑一律留在
// www.eimu.dev，壳里不复制任何前端代码。
//
// 三个必须由主进程介入的点：
//   1. 导航政策 → 只有 App 自身（且非 /api/auth/*）留在视窗内，其余一律转系统
//      浏览器。OAuth 授权必须在使用者的真实浏览器完成：App 视窗没有网址栏，
//      在里面输入凭证时使用者无从确认自己站在哪个站上，也用不到既有登入态。
//      2026-09-17 修正：授权页曾被开在 App 内，根因是只注册了 will-navigate
//      而漏掉服务端 302 走的 will-redirect（详见 applyNavigationPolicy）。
//   2. 外链（window.open）→ 分三类：/api/auth/* 转系统浏览器（跨浏览器交接
//      连结）、App 自身其他路径留在 App 内开子视窗（微信登入弹窗要靠
//      window.opener.postMessage 回传）、其余转系统浏览器。
//   3. 下载 → 原生「另存新档」对话框。eimu.dev 的图/影片是 blob: URL 触发的
//      <a download>，Chromium 对 blob 下载会直接落预设目录且不弹窗，用户找不到档。
//
// 明确不做：本地起 Next server。那会引入 standalone 打包、sharp、双份 API
// 语义等一整套维护面，与「不双端维护」的前提冲突。
//
// preload（2026-10-04 更新）：主视窗确实注册了 desktop/preload.js，因为壳需要
// 提供网页两个「网页做不到的事」的窄介面：
//   - window.eimuLocal（W3）：本机媒体能力（探测/挑档/probe/抽帧/转码），
//     安全判断全在主进程 local-worker.js。
//   - window.eimuShell（0.3.0）：自绘视窗控制钮 —— 只暴露 minimize /
//     toggleMaximize / close / isMaximized / onMaximizeChange（外加 platform），
//     目标视窗由主进程以 event.sender 反查。titleBarOverlay 已移除。
// 两组都不暴露 ipcRenderer / node / fs / shell 原物件。导航政策仍只允许
// eimu.dev 留在视窗内（will-navigate / will-redirect，见 applyNavigationPolicy），
// preload 不放宽任何导航或档案能力；子视窗不继承本 preload（见 webPreferences 注释）。

const { app, BrowserWindow, shell, session, dialog, Menu, screen, ipcMain } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const localWorker = require("./local-worker.js");
const { PERMISSION_MODES } = require("./lib/permission-rules.js");
const { startDeviceBridge, stopDeviceBridge, getDeviceBridgeState, resolveStableDeviceId } = require("./device-bridge-client.js");
const { readCredentialStore } = require("./lib/bridge-credential.js");
const {
  registerWindowControlsIpc,
  attachWindowStateBroadcast,
} = require("./window-controls.js");
// 0.3.2：自动更新（electron-updater + generic provider）。见 desktop/updater.js。
const { initUpdater, applyUpdate } = require("./updater.js");

// 可测性改造（E2E 基建用）：EIMU_APP_ORIGIN 可覆写壳要载入的站点。
//
// 安全闸（2026-10-04）：覆写 origin 是「测试基建」，不是产品能力 —— 正式出货的
// 壳若无条件吃 EIMU_APP_ORIGIN，任何能控制本机环境变数的程序就能把壳指去任意
// 站点（含把该站 host 并进 APP_HOSTS 导航白名单）。故两个闸门（本档的
// EIMU_APP_ORIGIN 与 local-worker.js 的 EIMU_E2E_PICK_FILES）一律要求**显式
// 开关 `EIMU_E2E === "1"`**：未设＝完全忽略这两个变数，行为与生产逐位元组相同。
// 正式产物预设不带这个开关 ⇒ 预设关闭。
//
// 为什么仍让打包产物可开（不用 `!app.isPackaged` 直接锁死）：E2E harness 跑的
// 就是**打包后**的 dist-e2e/linux-unpacked/eimu-desktop（app.isPackaged === true），
// 它靠 EIMU_APP_ORIGIN 指向本机 dev server；若加 `!app.isPackaged`，harness 会一起
// 被锁死。权衡：以单一显式 opt-in 开关取代 isPackaged 硬门，能同时满足「正式产物
// 预设关闭」与「harness 仍可运作」。要让闸门**连代码都不进正式产物**，需在建置期
// 用 define／strip 剔除，那要动 package.json/electron-builder 设定（本轮红线外）。
const E2E_ENABLED = process.env.EIMU_E2E === "1";
const APP_ORIGIN = (E2E_ENABLED && process.env.EIMU_APP_ORIGIN) || "https://www.eimu.dev";
// eimu.dev（无 www）会 308 到 www，但导航判断一律以最终 host 为准，两者都收。
const APP_HOSTS = new Set(["www.eimu.dev", "eimu.dev"]);
// 覆写 origin 时把它自己的 host 并入导航白名单：isAppUrl 依 APP_HOSTS 判断，
// 不并入的话壳会把自己的首页当外部连结转去系统浏览器。未设（或未开 E2E 闸）时
// 这段不执行，白名单维持上面两笔，既有导航／外链／下载政策完全不受影响。
if (E2E_ENABLED && process.env.EIMU_APP_ORIGIN) {
  try {
    APP_HOSTS.add(new URL(process.env.EIMU_APP_ORIGIN).host);
    // 可审计：只在显式 EIMU_E2E=1 且真的覆写时输出；生产不会有。
    console.warn(`[eimu-shell] E2E origin 覆写生效（EIMU_E2E=1）：APP_ORIGIN=${APP_ORIGIN}`);
  } catch {
    /* 非法 URL：忽略覆写，维持预设白名单 */
  }
}

// W6b／W6c：device bridge 壳内指示。连线**预设 OFF**；只有使用者明确开启
// （持久化设定 deviceBridgeEnabled，或以 EIMU_DEVICE_BRIDGE=1 操作者覆写）
// 且已有授权根、能取得凭证才连。开启状态以视窗标题可见化，并把状态推给页面
// （window.eimuLocal.onBridgeStatus 订阅 eimu-local:bridge-state）。
let bridgeState = { enabled: false, state: "off", roots: [], deviceId: null, mode: "ask" };
// 控制器已把客户端的 "reconnecting" 正规化为 "connecting"，故这里收 connecting。
const BRIDGE_ACTIVE = new Set(["online", "connecting"]);

function applyBridgeIndicator() {
  if (!mainWindow) return;
  const on = BRIDGE_ACTIVE.has(bridgeState.state);
  mainWindow.setTitle(on ? "Eimu · 本机档案桥接已开启" : "Eimu");
}

/** 状态变更：更新标题指示，并推给所有视窗的页面。 */
function broadcastBridgeStatus(status) {
  if (status && typeof status === "object") bridgeState = status;
  applyBridgeIndicator();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win || win.isDestroyed()) continue;
    try {
      win.webContents.send(localWorker.CHANNELS.bridgeEvent, bridgeState);
    } catch {
      /* 单一视窗传送失败不影响其他视窗 */
    }
  }
}

let mainWindow = null;

/**
 * W7a：向所有视窗索取一张短效装置票。桥没有可用凭证时由控制器回调触发一次；
 * 页面（已登录）铸票后经 `bridge.setCredential` 推回来。
 * 刻意**不含任何提示文字或错误**：纯信号，不泄露「有没有凭证」给非页面方。
 */
function broadcastCredentialRequired() {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win || win.isDestroyed()) continue;
    try {
      win.webContents.send(localWorker.CHANNELS.bridgeCredentialRequired, { reason: "credentials_unavailable" });
    } catch {
      /* 单一视窗传送失败不影响其他视窗 */
    }
  }
}

// ── 使用者设定持久化（<userData>/settings.json）─────────────────────────
// 只读写白名单栏位：
//   - deviceBridgeEnabled: boolean        使用者是否开启本机档案授权
//   - deviceBridgeMode: "off"|"ask"|"auto"|"full"  权限模式（W6c；非法值忽略回预设）
//   - deviceBridgeGatewayBaseUrl: string  使用者显式设定的闸道位址（可选）
//   - deviceBridgeDeviceId: string        本安装的稳定装置识别（非机密，可下发闸道；
//                                         缺＝首次启动产生一次并写回，之后沿用不重生）
//   - deviceBridgeConsentRoots: string[]  对话内「permanent」就地授权的根（去重、绝对、
//                                         上限 64）：落盘后重启仍有效，register 时与 roots 联集下发
//   - deviceBridgeAuthorizedRoots: string[] 使用者以 pickFiles 挑选的授权根（W7a，去重、
//                                         绝对、上限 64）：旧行为只存记忆体、App 一重启就空，
//                                         使用者每次重启都得重挑资料夹。载入时逐条重过
//                                         local-worker 的同一套闸（realpath＋敏感路径）。
// **不**持久化 apiKey：操作者后备凭证只从 <userData>/device-bridge.json（0600）读；
// 使用者路径的短效票（sk-dev-…）由页面经 IPC 推来，**只活记忆体、绝不落盘**（W7a）。
function settingsFilePath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function readSettings() {
  const out = {};
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(settingsFilePath(), "utf8"));
  } catch {
    return out; // 不存在／坏 JSON＝预设（桥 OFF），不影响壳启动
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
  if (typeof parsed.deviceBridgeEnabled === "boolean") out.deviceBridgeEnabled = parsed.deviceBridgeEnabled;
  // W6c：模式白名单验证（enum 之外一律忽略，由呼叫端回预设 "ask"）。
  if (typeof parsed.deviceBridgeMode === "string" && PERMISSION_MODES.includes(parsed.deviceBridgeMode)) {
    out.deviceBridgeMode = parsed.deviceBridgeMode;
  }
  if (typeof parsed.deviceBridgeGatewayBaseUrl === "string") {
    out.deviceBridgeGatewayBaseUrl = parsed.deviceBridgeGatewayBaseUrl;
  }
  // 稳定安装装置识别（缺陷修复）：非机密、可下发闸道；空/非字串一律忽略（呼叫端会重生）。
  if (typeof parsed.deviceBridgeDeviceId === "string" && parsed.deviceBridgeDeviceId.trim()) {
    out.deviceBridgeDeviceId = parsed.deviceBridgeDeviceId.trim().slice(0, 128);
  }
  // 对话内就地授权（缺陷修复）：permanent 同意根的落盘栏位。string[]、去重、仅绝对路径、
  // 上限 64（非机密，仅路径；不含 token/apiKey）。非法项一律略过（fail-closed）。
  if (Array.isArray(parsed.deviceBridgeConsentRoots)) {
    const roots = [];
    for (const r of parsed.deviceBridgeConsentRoots) {
      if (typeof r !== "string") continue;
      const t = r.trim();
      if (t.length === 0 || !t.startsWith("/")) continue;
      if (roots.includes(t)) continue;
      if (roots.length >= 64) break;
      roots.push(t);
    }
    if (roots.length > 0) out.deviceBridgeConsentRoots = roots;
  }
  // W7a：使用者 pickFiles 挑过的授权根（同一套形状约束；载入后的安全复核在
  // local-worker.registerLocalWorker 里逐条重过，不在此处假装已验）。
  if (Array.isArray(parsed.deviceBridgeAuthorizedRoots)) {
    const roots = [];
    for (const r of parsed.deviceBridgeAuthorizedRoots) {
      if (typeof r !== "string") continue;
      const t = r.trim();
      if (t.length === 0 || !t.startsWith("/")) continue;
      if (roots.includes(t)) continue;
      if (roots.length >= 64) break;
      roots.push(t);
    }
    if (roots.length > 0) out.deviceBridgeAuthorizedRoots = roots;
  }
  return out;
}

function writeSettings(next) {
  try {
    fs.mkdirSync(path.dirname(settingsFilePath()), { recursive: true });
    fs.writeFileSync(settingsFilePath(), JSON.stringify(next, null, 2), { mode: 0o600 });
    return true;
  } catch (err) {
    console.warn(`[eimu-shell] 设定写入失败：${err && err.code ? err.code : "error"}`);
    return false;
  }
}

function isAppUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    // M1：必须同时锁 protocol，否则 file://www.eimu.dev/x 会以 host 冒充 App。
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return APP_HOSTS.has(url.host);
  } catch {
    return false;
  }
}

/**
 * 应用自身的 /api/auth/* 端点：被打开成新视窗时，语义一律是
 * 「去使用者的真实浏览器完成授权」。
 *
 * 这条是 2026-09-17 修 GitHub 登入开在 App 内那个 bug 的关键。App 的视窗
 * 没有网址栏，在里面输入 GitHub 凭证时使用者无从确认自己站在哪个站上，
 * 也用不到浏览器既有的登入态。前端已走跨浏览器交接（PwaHandoffPanel），
 * 这里负责把交接连结真的送出到系统浏览器。
 */
function isAppAuthUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    // M1：同 isAppUrl，protocol 必须是 http/https（挡 file://www.eimu.dev/api/auth/*）。
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return APP_HOSTS.has(url.host) && url.pathname.startsWith("/api/auth/");
  } catch {
    return false;
  }
}

function openInSystemBrowser(rawUrl) {
  // 只放行 http/https 给系统浏览器：mailto/tel 之外的自订 scheme
  // （例如被注入的 eimu:// 或 file://）不转出去，避免成为攻击跳板。
  try {
    const { protocol } = new URL(rawUrl);
    if (protocol !== "http:" && protocol !== "https:") return true;
  } catch {
    return true;
  }
  void shell.openExternal(rawUrl);
  return true;
}

/**
 * 解析 window.open 的 features 字串（"popup,width=440,height=640"）成
 * BrowserWindow 选项。只取尺寸：其余 Chromium 视窗特性（toolbar 等）在
 * Electron 下无意义，硬塞会变成无效选项。取不到就交回空物件用预设值。
 */
function parseWindowFeatures(features) {
  const options = {};
  for (const part of String(features || "").split(",")) {
    const [rawKey, rawValue] = part.split("=");
    const key = String(rawKey || "").trim().toLowerCase();
    const value = Number(String(rawValue || "").trim());
    if (!Number.isFinite(value) || value <= 0) continue;
    if (key === "width") options.width = Math.round(value);
    if (key === "height") options.height = Math.round(value);
  }
  return options;
}

/**
 * 导航政策：只有 App 自身、且非 /api/auth/* 的路径留在视窗内，其余一律
 * 转系统浏览器。
 *
 * 必须同时挂 will-navigate 与 will-redirect —— 两者是不同事件：
 * will-navigate 涵盖使用者/JS 发起的导航，服务端 302 走 will-redirect。
 * 2026-09-17 的 bug 正是只注册了前者：/api/auth/github/start 的同源导航被
 * 放行后，它 302 到 github.com 就无人检查，GitHub 授权页直接开在 App 视窗里
 * （实测事件链 will-navigate(app) → will-redirect(github.com) → did-navigate(github.com)）。
 * App 视窗没有网址栏，在里面输入凭证时使用者无从确认自己站在哪个站上，
 * 也用不到浏览器既有的登入态。
 */
function applyNavigationPolicy(win) {
  for (const eventName of ["will-navigate", "will-redirect"]) {
    win.webContents.on(eventName, (event, url) => {
      if (isAppUrl(url) && !isAppAuthUrl(url)) return;
      event.preventDefault();
      openInSystemBrowser(url);
    });
  }
}

/**
 * 视窗外链政策（window.open / target=_blank）。三类去处：
 *   - App 自身的 /api/auth/* → 系统浏览器。这是跨浏览器交接连结
 *     （PwaHandoffPanel 的「去浏览器打开」），必须真的在使用者浏览器开启，
 *     授权完成后才会把一次性票据投递回伺服器。
 *   - App 自身其他路径 → 留在 App 内开新视窗。微信扫码登入弹窗
 *     （/wechat-login）走这条：它靠 window.opener.postMessage 回传结果，且要
 *     与主视窗共用同一 session 的 cookie/localStorage；送去外部浏览器等于
 *     登入态落在外站，App 永远拿不到。
 *   - 其余 → 系统浏览器。
 */
function applyWindowOpenPolicy(win) {
  win.webContents.setWindowOpenHandler(({ url, features }) => {
    if (isAppUrl(url) && !isAppAuthUrl(url)) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          ...parseWindowFeatures(features),
          autoHideMenuBar: true,
          // 子视窗继承主视窗的隔离等级，不因是弹窗而放宽。
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            webSecurity: true,
          },
        },
      };
    }
    openInSystemBrowser(url);
    return { action: "deny" };
  });

  // 新开的子视窗（如微信登入弹窗）同样套用导航与外链政策：子视窗不弹出去
  // 不代表它内部的连结安全，授权完成后它也可能被导去外部站。
  win.webContents.on("did-create-window", (child) => {
    applyNavigationPolicy(child);
    applyWindowOpenPolicy(child);
    // 0.3.0：子视窗不需要自绘控制钮，但同样挂状态广播（挂著不会坏，
    // 且与主视窗行为一致）。子视窗不继承本 preload，故页面多半收不到，
    // 这是刻意的（更严）。
    attachWindowStateBroadcast(child);
  });
}

function createWindow() {
  // 尺寸必须依当前工作区推导，不能写死。实测环境：eDP-1 物理 2560x1600、
  // KDE 缩放 2x → 逻辑工作区只有 1280x800。写死 1440x940 会让视窗比逻辑
  // 萤幕还大，右侧与底部被推出萤幕外（使用者实测回报）。改用工作区的
  // 92% 并夹在可用范围内，兼顾高 DPI 小工作区与大萤幕。
  const { workAreaSize } = screen.getPrimaryDisplay();
  const width = Math.min(1440, Math.max(960, Math.round(workAreaSize.width * 0.92)));
  const height = Math.min(940, Math.max(640, Math.round(workAreaSize.height * 0.92)));

  mainWindow = new BrowserWindow({
    width,
    height,
    // 下限同样依工作区夹住：若硬设 960x640 而逻辑工作区更小，使用者仍会
    // 遇到同一类「视窗比萤幕大」的问题。
    minWidth: Math.min(960, workAreaSize.width),
    minHeight: Math.min(640, workAreaSize.height),
    center: true,
    backgroundColor: "#ffffff",
    // build/icon.png 由 electron-builder 的 files 一并打入 asar，路径相对 main.js
    // 在开发模式与打包后都成立，不需要区分 resourcesPath。
    icon: path.join(__dirname, "build", "icon.png"),
    show: false,
    autoHideMenuBar: true,
    // 标题列交给页面自己的页首（Chrome 式 CSD）。KDE 预设深色标题列与
    // 浅色页面冲突且吃掉一整条高度（2026-09-17 暴君回报「其他 app 不这样」）。
    // 0.3.0：移除 titleBarOverlay —— 原生 overlay 按钮的形状由系统决定、
    // 无法做到「看得出精心设计、完美融入 Eimu」。改为纯 frameless，三颗
    // 视窗控制钮由远端页面自绘，经 window.eimuShell → window-controls.js 操作。
    titleBarStyle: "hidden",
    webPreferences: {
      // 网页是远端内容，主进程能力一律不暴露：node 关闭，仍不注入 Node。
      nodeIntegration: false,
      contextIsolation: true,
      // 保留 Chromium 既有的同源限制即可；壳不需要放宽。
      webSecurity: true,
      // W3：唯一的本地能力通道。preload 只在隔离世界以 contextBridge 暴露
      // 「极窄」的 window.eimuLocal（探测/挑档/probe/抽帧/转码），不含
      // exec/spawn/shell/fs。真正的授权闸在主进程 local-worker.js（含
      // origin 验证与逐次路径授权）。子视窗不继承本 preload（更严）。
      preload: path.join(__dirname, "preload.js"),
    },
  });

  // 首屏白屏时间压到最短：等内容绘制完再显示，避免先闪一个空白框。
  // 最大化必须等视窗真正映射后才送：KDE Wayland 上「show 前 maximize」
  // 与「show 后同步 maximize」都会被合成器丢掉（实测停在 92% 尺寸），
  // 延迟一拍才生效。maximize 以工作区而非物理萤幕计算，系统面板不会被
  // 盖住；上面推导的 width/height 则成为还原时的尺寸。
  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    setTimeout(() => mainWindow.maximize(), 80);
  });

  // 导航政策：主视窗与所有子视窗共用同一套（子视窗同样是远端内容，
  // 不因是弹窗而放宽）。
  applyNavigationPolicy(mainWindow);
  applyWindowOpenPolicy(mainWindow);

  // 0.3.0：主视窗的最大化状态变化推给页面（自绘控制钮的还原/最大化图标）。
  attachWindowStateBroadcast(mainWindow);

  // W6b：bridge 开启时，避免远端页面的 <title> 覆盖掉壳内的「已开启」指示。
  // 未开启时不拦（既有行为完全不变）。
  mainWindow.on("page-title-updated", (event) => {
    if (BRIDGE_ACTIVE.has(bridgeState.state)) {
      event.preventDefault();
      applyBridgeIndicator();
    }
  });

  // 下载：blob:/data: 的 <a download> 在 Chromium 预设会静默存到预设目录。
  // 这里拦下来开原生存档对话框，并用建议档名。
  mainWindow.webContents.session.on("will-download", (event, item) => {
    const suggested = item.getFilename() || "download";
    const savePath = dialog.showSaveDialogSync(mainWindow, {
      title: "保存文件",
      defaultPath: path.join(app.getPath("downloads"), suggested),
    });
    if (!savePath) {
      item.cancel();
      return;
    }
    item.setSavePath(savePath);
  });

  // W6c：页面载入完成时补推一次当前 bridge 状态，避免页面订阅（onBridgeStatus）
  // 晚于启动推送而永远收不到初始状态。用既有广播（含标题指示）即可。
  mainWindow.webContents.on("did-finish-load", () => {
    broadcastBridgeStatus(bridgeState);
  });

  void mainWindow.loadURL(APP_ORIGIN);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// 单实例锁：第二次启动只是聚焦既有视窗，不开第二份（否则同一 session
// 的 cookie/localStorage 会被两个进程同时读写）。
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    // 权限：只放行网页真的会用的两项（复制图片到剪贴簿），其余
    // （geolocation/media/notifications 等）一律拒绝，避免远端内容
    // 取得非预期的装置能力。
    const allowedPermissions = new Set(["clipboard-sanitized-write", "clipboard-read"]);
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(allowedPermissions.has(permission));
    });

    // W6b／W6c：device bridge（云端 agent 经本机**出站**连线读已授权档案）。
    //
    // 凭证**不由页面注入**——壳载入的是远端页面，让页面能把凭证交给主进程等于多开
    // 一条 remote→local 信任路径。改读使用者自己放在 <userData>/device-bridge.json
    // 的档案（必须 0600）：没有那个档、JSON 坏、权限过宽，一律回 null ⇒ 桥停在
    // credentials_unavailable。读取规则见 lib/bridge-credential.js，启用步骤见
    // desktop/DEVICE-BRIDGE.md。
    const bridgeCredential = readCredentialStore(path.join(app.getPath("userData"), "device-bridge.json"), {
      onWarn: (reason) => console.warn(`[device-bridge] ${reason}`),
    });
    const settings = readSettings();
    // 稳定安装装置识别（缺陷修复）：同一安装的每次 register 必须带同一 device_id，否则
    // 闸道对每次重连都配新 deviceId，同 tenant 累积多台 online ⇒ device_ambiguous／逾时
    // （见 device-bridge-client.js 档头 helper 注解）。读 settings.json 白名单栏位
    // deviceBridgeDeviceId；缺值＝这里产生一次并写回（resolveStableDeviceId → write →
    // writeSettings），之后每次启动沿用同一值、不重生。值非机密（≠凭证），可下发闸道。
    const stableDeviceId = resolveStableDeviceId({
      read: () => settings.deviceBridgeDeviceId,
      write: (id) => {
        settings.deviceBridgeDeviceId = id;
        writeSettings(settings);
      },
    });
    // 闸道位址优先序：env 覆写 > 使用者设定 > 凭证档自带 > 客户端预设。
    const resolveGatewayBaseUrl = () =>
      process.env.EIMU_GATEWAY_BASE_URL || settings.deviceBridgeGatewayBaseUrl || bridgeCredential?.gatewayBaseUrl;

    // 对话内就地授权（缺陷修复）：permanent 同意根落盘（并入既有设定并 writeSettings）；
    // register/放行时以已落盘同意根为来源。稽核选配：每接受一个新的同意根追加一行
    // 本机稽核（ISO 时间 + scope + root；**永不**写 token/apiKey），供使用者自查。
    const persistConsentRoots = (roots) => {
      const list = Array.isArray(settings.deviceBridgeConsentRoots) ? settings.deviceBridgeConsentRoots.slice() : [];
      for (const r of Array.isArray(roots) ? roots : []) {
        if (typeof r !== "string" || !r.startsWith("/") || list.includes(r) || list.length >= 64) continue;
        list.push(r);
      }
      settings.deviceBridgeConsentRoots = list;
      writeSettings(settings);
    };
    const auditConsent = (entry) => {
      try {
        const line = `${new Date().toISOString()} ${entry && entry.scope ? entry.scope : "unknown"} ${entry && entry.root ? entry.root : ""}\n`;
        fs.appendFileSync(path.join(app.getPath("userData"), "device-bridge-audit.log"), line, { mode: 0o600 });
      } catch {
        /* 稽核失败不得影响 bridge */
      }
    };

    // 生命周期编排（可重入）在 local-worker.createBridgeController：这里只做依赖注入。
    // 好处：「授权根变更→以新 roots 重注册」可在纯 node 下以间谍 client 验（*.test.js），
    // 不必启动 Electron（本档顶层呼叫 app API，无法在 node 下 require）。
    const bridgeController = localWorker.createBridgeController({
      startBridge: (opts) =>
        startDeviceBridge({
          ...opts,
          deviceIdProvider: () => stableDeviceId,
          consentRootsProvider: () =>
            Array.isArray(settings.deviceBridgeConsentRoots) ? settings.deviceBridgeConsentRoots : [],
          persistConsentRoots,
          auditConsent,
        }),
      stopBridge: () => stopDeviceBridge(),
      getClientState: () => getDeviceBridgeState(),
      readEnabled: () => settings.deviceBridgeEnabled === true,
      writeEnabled: (v) => {
        settings.deviceBridgeEnabled = v === true;
        writeSettings(settings);
      },
      // W6c：权限模式持久化（deviceBridgeMode 白名单栏位；非法值于 readSettings 已忽略）。
      readMode: () => settings.deviceBridgeMode,
      writeMode: (m) => {
        settings.deviceBridgeMode = m;
        writeSettings(settings);
      },
      // 规则来源目前无使用者设定面（契约已预留）：回 undefined ⇒ 不下发 rules 栏位。
      // 第二道防线仍以硬 denylist／safety-check／模式生效。
      rulesProvider: () => undefined,
      getGatewayBaseUrl: resolveGatewayBaseUrl,
      credentialProvider: () => (bridgeCredential ? bridgeCredential.apiKey : null),
      // W7a：页面推来的短效票优先（主进程记忆体）。票换新由控制器 stop→start 重注册，
      // 所以这里必须即时读、不能快取。
      tokenProvider: () => localWorker.currentBridgeCredential(),
      // 客户端发现没票/票过期：转推给所有视窗，页面（已登录）重铸一张再推回来。
      onCredentialRequired: () => broadcastCredentialRequired(),
      onStatusChange: (s) => broadcastBridgeStatus(s),
    });

    // W3／W6c：注册本机媒体工人（preload 暴露的 window.eimuLocal 之主进程侧，含
    // device bridge 四个新 API）。每个 handler 自行验 senderFrame origin 与逐次路径授权。
    // W7a：授权根与永久同意根一样落盘（deviceBridgeAuthorizedRoots），重启后不必重挑；
    // 载入时逐条重过同一套闸（见 local-worker.registerLocalWorker）。
    localWorker.registerLocalWorker({
      appHosts: APP_HOSTS,
      bridgeController,
      loadPersistedRoots: () =>
        Array.isArray(settings.deviceBridgeAuthorizedRoots) ? settings.deviceBridgeAuthorizedRoots : [],
      persistRoots: (roots) => {
        const list = [];
        for (const r of Array.isArray(roots) ? roots : []) {
          if (typeof r !== "string" || !r.startsWith("/") || list.includes(r) || list.length >= 64) continue;
          list.push(r);
        }
        settings.deviceBridgeAuthorizedRoots = list;
        writeSettings(settings);
      },
    });

    // W6b 启动：以持久化设定（或 EIMU_DEVICE_BRIDGE=1 操作者覆写）决定「已开启意图」。
    // env 覆写保留既有 E2E／操作者路径，且**不**写回设定档。无授权根时控制器停在
    // no_authorized_roots；之后 pickFiles 授权新根会自动以新 roots 重注册（见 local-worker）。
    //
    // W6c 权限模式优先序：EIMU_DEVICE_BRIDGE_MODE（env，供 E2E／操作者）
    //   > settings.deviceBridgeMode > "ask"。模式 off ⇒ 等于不开启（不启动）。
    const envBridgeOverride = process.env.EIMU_DEVICE_BRIDGE === "1";
    const envMode = process.env.EIMU_DEVICE_BRIDGE_MODE;
    const resolvedMode = PERMISSION_MODES.includes(envMode)
      ? envMode
      : PERMISSION_MODES.includes(settings.deviceBridgeMode)
        ? settings.deviceBridgeMode
        : "ask";
    bridgeController.setModeSilently(resolvedMode);
    const wantEnabled =
      (envBridgeOverride || settings.deviceBridgeEnabled === true) && resolvedMode !== "off";
    bridgeController.setEnabledSilently(wantEnabled);
    if (wantEnabled) {
      void bridgeController.restart().catch(() => {
        /* 启动失败不得影响壳启动 */
      });
    } else {
      broadcastBridgeStatus(bridgeController.status()); // 让页面收到初始状态（off 或 mode=off）
    }

    // 0.3.0：自绘视窗控制钮的 IPC（preload 暴露的 window.eimuShell 之主进程侧）。
    // 登记一次即可；目标视窗以 event.sender 反查，非全域 mainWindow。
    registerWindowControlsIpc(ipcMain);

    // 0.3.2：自动更新接入点（另一条工作流请留意，勿重排）。
    //   - initUpdater：开发模式自动 no-op；打包后延迟 15s 检查、每 6h 一次，
    //     下载完成时向主视窗送 eimu-shell:update-ready。
    //   - eimu-shell:apply-update：页面按下「重启并套用」时触发。
    //     放在 main.js（组合根）而非 window-controls.js，让后者维持单一职责。
    initUpdater({ getWindow: () => mainWindow });
    ipcMain.on("eimu-shell:apply-update", () => {
      applyUpdate();
    });

    // 去掉预设选单列（File/Edit/View/Window/Help），它是桌面壳里最突兀的
    // 非产品元素；剪贴簿快捷键由 Chromium 内建处理，不依赖选单。
    Menu.setApplicationMenu(null);
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  // 视窗全关就退出（连 macOS 一起，本壳不做 dock 常驻）。
  app.on("window-all-closed", () => app.quit());

  // W6b：退出时停掉 bridge（清计时器、中止 in-flight 请求、丢弃凭证）。
  app.on("before-quit", () => {
    stopDeviceBridge();
  });
}
