// Eimu 桌面殼（方案①：薄殼包 eimu.dev）
//
// 設計前提：不做雙端維護。這裡只做「網頁做不到的事」，業務邏輯一律留在
// www.eimu.dev，殼裡不複製任何前端代碼。
//
// 三個必須由主進程介入的點：
//   1. 導航政策 → 只有 App 自身（且非 /api/auth/*）留在視窗內，其餘一律轉系統
//      瀏覽器。OAuth 授權必須在使用者的真實瀏覽器完成：App 視窗沒有網址欄，
//      在裡面輸入憑證時使用者無從確認自己站在哪個站上，也用不到既有登入態。
//      2026-09-17 修正：授權頁曾被開在 App 內，根因是只註冊了 will-navigate
//      而漏掉服務端 302 走的 will-redirect（詳見 applyNavigationPolicy）。
//   2. 外鏈（window.open）→ 分三類：/api/auth/* 轉系統瀏覽器（跨瀏覽器交接
//      連結）、App 自身其他路徑留在 App 內開子視窗（微信登入彈窗要靠
//      window.opener.postMessage 回傳）、其餘轉系統瀏覽器。
//   3. 下載 → 原生「另存新檔」對話框。eimu.dev 的圖/影片是 blob: URL 觸發的
//      <a download>，Chromium 對 blob 下載會直接落預設目錄且不彈窗，用戶找不到檔。
//
// 明確不做：本地起 Next server。那會引入 standalone 打包、sharp、雙份 API
// 語義等一整套維護面，與「不雙端維護」的前提衝突。
//
// preload（2026-10-04 更新）：主視窗確實註冊了 desktop/preload.js，因為殼需要
// 提供網頁兩個「網頁做不到的事」的窄介面：
//   - window.eimuLocal（W3）：本機媒體能力（探測/挑檔/probe/抽幀/轉碼），
//     安全判斷全在主進程 local-worker.js。
//   - window.eimuShell（0.3.0）：自繪視窗控制鈕 —— 只暴露 minimize /
//     toggleMaximize / close / isMaximized / onMaximizeChange（外加 platform），
//     目標視窗由主進程以 event.sender 反查。titleBarOverlay 已移除。
// 兩組都不暴露 ipcRenderer / node / fs / shell 原物件。導航政策仍只允許
// eimu.dev 留在視窗內（will-navigate / will-redirect，見 applyNavigationPolicy），
// preload 不放寬任何導航或檔案能力；子視窗不繼承本 preload（見 webPreferences 註釋）。

const { app, BrowserWindow, shell, session, dialog, Menu, screen, ipcMain } = require("electron");
const path = require("node:path");
const { startDeviceBridge, stopDeviceBridge } = require("./device-bridge-client.js");
const {
  registerWindowControlsIpc,
  attachWindowStateBroadcast,
} = require("./window-controls.js");

const APP_ORIGIN = "https://www.eimu.dev";
// eimu.dev（無 www）會 308 到 www，但導航判斷一律以最終 host 為準，兩者都收。
const APP_HOSTS = new Set(["www.eimu.dev", "eimu.dev"]);

// W6b：device bridge 殼內指示。連線**預設 OFF**；只有使用者明確開啟
// （EIMU_DEVICE_BRIDGE=1 且能取得憑證）才連。開啟狀態以視窗標題可見化。
let bridgeState = { status: "off", enabled: false };
const BRIDGE_ACTIVE = new Set(["online", "reconnecting"]);

function applyBridgeIndicator() {
  if (!mainWindow) return;
  const on = BRIDGE_ACTIVE.has(bridgeState.status);
  mainWindow.setTitle(on ? "Eimu · 本機檔案橋接已開啟" : "Eimu");
}

let mainWindow = null;

function isAppUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    // M1：必須同時鎖 protocol，否則 file://www.eimu.dev/x 會以 host 冒充 App。
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return APP_HOSTS.has(url.host);
  } catch {
    return false;
  }
}

/**
 * 應用自身的 /api/auth/* 端點：被打開成新視窗時，語義一律是
 * 「去使用者的真實瀏覽器完成授權」。
 *
 * 這條是 2026-09-17 修 GitHub 登入開在 App 內那個 bug 的關鍵。App 的視窗
 * 沒有網址欄，在裡面輸入 GitHub 憑證時使用者無從確認自己站在哪個站上，
 * 也用不到瀏覽器既有的登入態。前端已走跨瀏覽器交接（PwaHandoffPanel），
 * 這裡負責把交接連結真的送出到系統瀏覽器。
 */
function isAppAuthUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    // M1：同 isAppUrl，protocol 必須是 http/https（擋 file://www.eimu.dev/api/auth/*）。
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return APP_HOSTS.has(url.host) && url.pathname.startsWith("/api/auth/");
  } catch {
    return false;
  }
}

function openInSystemBrowser(rawUrl) {
  // 只放行 http/https 給系統瀏覽器：mailto/tel 之外的自訂 scheme
  // （例如被注入的 eimu:// 或 file://）不轉出去，避免成為攻擊跳板。
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
 * BrowserWindow 選項。只取尺寸：其餘 Chromium 視窗特性（toolbar 等）在
 * Electron 下無意義，硬塞會變成無效選項。取不到就交回空物件用預設值。
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
 * 導航政策：只有 App 自身、且非 /api/auth/* 的路徑留在視窗內，其餘一律
 * 轉系統瀏覽器。
 *
 * 必須同時掛 will-navigate 與 will-redirect —— 兩者是不同事件：
 * will-navigate 涵蓋使用者/JS 發起的導航，服務端 302 走 will-redirect。
 * 2026-09-17 的 bug 正是只註冊了前者：/api/auth/github/start 的同源導航被
 * 放行後，它 302 到 github.com 就無人檢查，GitHub 授權頁直接開在 App 視窗裡
 * （實測事件鏈 will-navigate(app) → will-redirect(github.com) → did-navigate(github.com)）。
 * App 視窗沒有網址欄，在裡面輸入憑證時使用者無從確認自己站在哪個站上，
 * 也用不到瀏覽器既有的登入態。
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
 * 視窗外鏈政策（window.open / target=_blank）。三類去處：
 *   - App 自身的 /api/auth/* → 系統瀏覽器。這是跨瀏覽器交接連結
 *     （PwaHandoffPanel 的「去瀏覽器打開」），必須真的在使用者瀏覽器開啟，
 *     授權完成後才會把一次性票據投遞回伺服器。
 *   - App 自身其他路徑 → 留在 App 內開新視窗。微信掃碼登入彈窗
 *     （/wechat-login）走這條：它靠 window.opener.postMessage 回傳結果，且要
 *     與主視窗共用同一 session 的 cookie/localStorage；送去外部瀏覽器等於
 *     登入態落在外站，App 永遠拿不到。
 *   - 其餘 → 系統瀏覽器。
 */
function applyWindowOpenPolicy(win) {
  win.webContents.setWindowOpenHandler(({ url, features }) => {
    if (isAppUrl(url) && !isAppAuthUrl(url)) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          ...parseWindowFeatures(features),
          autoHideMenuBar: true,
          // 子視窗繼承主視窗的隔離等級，不因是彈窗而放寬。
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

  // 新開的子視窗（如微信登入彈窗）同樣套用導航與外鏈政策：子視窗不彈出去
  // 不代表它內部的連結安全，授權完成後它也可能被導去外部站。
  win.webContents.on("did-create-window", (child) => {
    applyNavigationPolicy(child);
    applyWindowOpenPolicy(child);
    // 0.3.0：子視窗不需要自繪控制鈕，但同樣掛狀態廣播（掛著不會壞，
    // 且與主視窗行為一致）。子視窗不繼承本 preload，故頁面多半收不到，
    // 這是刻意的（更嚴）。
    attachWindowStateBroadcast(child);
  });
}

function createWindow() {
  // 尺寸必須依當前工作區推導，不能寫死。實測環境：eDP-1 物理 2560x1600、
  // KDE 縮放 2x → 邏輯工作區只有 1280x800。寫死 1440x940 會讓視窗比邏輯
  // 螢幕還大，右側與底部被推出螢幕外（使用者實測回報）。改用工作區的
  // 92% 並夾在可用範圍內，兼顧高 DPI 小工作區與大螢幕。
  const { workAreaSize } = screen.getPrimaryDisplay();
  const width = Math.min(1440, Math.max(960, Math.round(workAreaSize.width * 0.92)));
  const height = Math.min(940, Math.max(640, Math.round(workAreaSize.height * 0.92)));

  mainWindow = new BrowserWindow({
    width,
    height,
    // 下限同樣依工作區夾住：若硬設 960x640 而邏輯工作區更小，使用者仍會
    // 遇到同一類「視窗比螢幕大」的問題。
    minWidth: Math.min(960, workAreaSize.width),
    minHeight: Math.min(640, workAreaSize.height),
    center: true,
    backgroundColor: "#ffffff",
    // build/icon.png 由 electron-builder 的 files 一併打入 asar，路徑相對 main.js
    // 在開發模式與打包後都成立，不需要區分 resourcesPath。
    icon: path.join(__dirname, "build", "icon.png"),
    show: false,
    autoHideMenuBar: true,
    // 標題列交給頁面自己的頁首（Chrome 式 CSD）。KDE 預設深色標題列與
    // 淺色頁面衝突且吃掉一整條高度（2026-09-17 暴君回報「其他 app 不這樣」）。
    // 0.3.0：移除 titleBarOverlay —— 原生 overlay 按鈕的形狀由系統決定、
    // 無法做到「看得出精心設計、完美融入 Eimu」。改為純 frameless，三顆
    // 視窗控制鈕由遠端頁面自繪，經 window.eimuShell → window-controls.js 操作。
    titleBarStyle: "hidden",
    webPreferences: {
      // 網頁是遠端內容，主進程能力一律不暴露：node 關閉，仍不注入 Node。
      nodeIntegration: false,
      contextIsolation: true,
      // 保留 Chromium 既有的同源限制即可；殼不需要放寬。
      webSecurity: true,
      // W3：唯一的本地能力通道。preload 只在隔離世界以 contextBridge 暴露
      // 「極窄」的 window.eimuLocal（探測/挑檔/probe/抽幀/轉碼），不含
      // exec/spawn/shell/fs。真正的授權閘在主進程 local-worker.js（含
      // origin 驗證與逐次路徑授權）。子視窗不繼承本 preload（更嚴）。
      preload: path.join(__dirname, "preload.js"),
    },
  });

  // 首屏白屏時間壓到最短：等內容繪製完再顯示，避免先閃一個空白框。
  // 最大化必須等視窗真正映射後才送：KDE Wayland 上「show 前 maximize」
  // 與「show 後同步 maximize」都會被合成器丟掉（實測停在 92% 尺寸），
  // 延遲一拍才生效。maximize 以工作區而非物理螢幕計算，系統面板不會被
  // 蓋住；上面推導的 width/height 則成為還原時的尺寸。
  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    setTimeout(() => mainWindow.maximize(), 80);
  });

  // 導航政策：主視窗與所有子視窗共用同一套（子視窗同樣是遠端內容，
  // 不因是彈窗而放寬）。
  applyNavigationPolicy(mainWindow);
  applyWindowOpenPolicy(mainWindow);

  // 0.3.0：主視窗的最大化狀態變化推給頁面（自繪控制鈕的還原/最大化圖標）。
  attachWindowStateBroadcast(mainWindow);

  // W6b：bridge 開啟時，避免遠端頁面的 <title> 覆蓋掉殼內的「已開啟」指示。
  // 未開啟時不攔（既有行為完全不變）。
  mainWindow.on("page-title-updated", (event) => {
    if (BRIDGE_ACTIVE.has(bridgeState.status)) {
      event.preventDefault();
      applyBridgeIndicator();
    }
  });

  // 下載：blob:/data: 的 <a download> 在 Chromium 預設會靜默存到預設目錄。
  // 這裡攔下來開原生存檔對話框，並用建議檔名。
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

  void mainWindow.loadURL(APP_ORIGIN);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// 單實例鎖：第二次啟動只是聚焦既有視窗，不開第二份（否則同一 session
// 的 cookie/localStorage 會被兩個進程同時讀寫）。
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
    // 權限：只放行網頁真的會用的兩項（複製圖片到剪貼簿），其餘
    // （geolocation/media/notifications 等）一律拒絕，避免遠端內容
    // 取得非預期的裝置能力。
    const allowedPermissions = new Set(["clipboard-sanitized-write", "clipboard-read"]);
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(allowedPermissions.has(permission));
    });

    // W3：註冊本機媒體工人（preload 暴露的 window.eimuLocal 之主進程側）。
    // 每個 handler 自行驗 senderFrame origin 與逐次路徑授權；未授權路徑一律拒。
    require("./local-worker").registerLocalWorker({ appHosts: APP_HOSTS });

    // 0.3.0：自繪視窗控制鈕的 IPC（preload 暴露的 window.eimuShell 之主進程側）。
    // 登記一次即可；目標視窗以 event.sender 反查，非全域 mainWindow。
    registerWindowControlsIpc(ipcMain);

    // W6b：device bridge（雲端 agent 經本機**出站**連線讀已授權檔案）。
    // 預設 OFF（EIMU_DEVICE_BRIDGE 未設＝不連）。本殼載入遠端頁面、只有 session，
    // 沒有既有 Bearer sk-biz-* 憑證；因此 credentialProvider 誠實回 null ——
    // 即使被開啟也只會得到 credentials_unavailable，不在殼內硬編任何 key。
    // 缺口與建議補法見 desktop/DEVICE-BRIDGE.md。
    void startDeviceBridge({
      gatewayBaseUrl: process.env.EIMU_GATEWAY_BASE_URL,
      enabled: process.env.EIMU_DEVICE_BRIDGE === "1",
      credentialProvider: () => null,
      onStatus: (s) => {
        bridgeState = s;
        applyBridgeIndicator();
      },
    }).catch(() => {
      /* 啟動失敗不得影響殼啟動 */
    });

    // 去掉預設選單列（File/Edit/View/Window/Help），它是桌面殼裡最突兀的
    // 非產品元素；剪貼簿快捷鍵由 Chromium 內建處理，不依賴選單。
    Menu.setApplicationMenu(null);
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  // 視窗全關就退出（連 macOS 一起，本殼不做 dock 常駐）。
  app.on("window-all-closed", () => app.quit());

  // W6b：退出時停掉 bridge（清計時器、中止 in-flight 請求、丟棄憑證）。
  app.on("before-quit", () => {
    stopDeviceBridge();
  });
}
