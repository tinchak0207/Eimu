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
const fs = require("node:fs");
const localWorker = require("./local-worker.js");
const { PERMISSION_MODES } = require("./lib/permission-rules.js");
const { startDeviceBridge, stopDeviceBridge, getDeviceBridgeState, resolveStableDeviceId } = require("./device-bridge-client.js");
const { readCredentialStore } = require("./lib/bridge-credential.js");
const {
  registerWindowControlsIpc,
  attachWindowStateBroadcast,
} = require("./window-controls.js");
// 0.3.2：自動更新（electron-updater + generic provider）。見 desktop/updater.js。
const { initUpdater, applyUpdate } = require("./updater.js");

// 可測性改造（E2E 基建用）：EIMU_APP_ORIGIN 可覆寫殼要載入的站點。
//
// 安全閘（2026-10-04）：覆寫 origin 是「測試基建」，不是產品能力 —— 正式出貨的
// 殼若無條件吃 EIMU_APP_ORIGIN，任何能控制本機環境變數的程序就能把殼指去任意
// 站點（含把該站 host 併進 APP_HOSTS 導航白名單）。故兩個閘門（本檔的
// EIMU_APP_ORIGIN 與 local-worker.js 的 EIMU_E2E_PICK_FILES）一律要求**顯式
// 開關 `EIMU_E2E === "1"`**：未設＝完全忽略這兩個變數，行為與生產逐位元組相同。
// 正式產物預設不帶這個開關 ⇒ 預設關閉。
//
// 為什麼仍讓打包產物可開（不用 `!app.isPackaged` 直接鎖死）：E2E harness 跑的
// 就是**打包後**的 dist-e2e/linux-unpacked/eimu-desktop（app.isPackaged === true），
// 它靠 EIMU_APP_ORIGIN 指向本機 dev server；若加 `!app.isPackaged`，harness 會一起
// 被鎖死。權衡：以單一顯式 opt-in 開關取代 isPackaged 硬門，能同時滿足「正式產物
// 預設關閉」與「harness 仍可運作」。要讓閘門**連代碼都不進正式產物**，需在建置期
// 用 define／strip 剔除，那要動 package.json/electron-builder 設定（本輪紅線外）。
const E2E_ENABLED = process.env.EIMU_E2E === "1";
const APP_ORIGIN = (E2E_ENABLED && process.env.EIMU_APP_ORIGIN) || "https://www.eimu.dev";
// eimu.dev（無 www）會 308 到 www，但導航判斷一律以最終 host 為準，兩者都收。
const APP_HOSTS = new Set(["www.eimu.dev", "eimu.dev"]);
// 覆寫 origin 時把它自己的 host 併入導航白名單：isAppUrl 依 APP_HOSTS 判斷，
// 不併入的話殼會把自己的首頁當外部連結轉去系統瀏覽器。未設（或未開 E2E 閘）時
// 這段不執行，白名單維持上面兩筆，既有導航／外鏈／下載政策完全不受影響。
if (E2E_ENABLED && process.env.EIMU_APP_ORIGIN) {
  try {
    APP_HOSTS.add(new URL(process.env.EIMU_APP_ORIGIN).host);
    // 可審計：只在顯式 EIMU_E2E=1 且真的覆寫時輸出；生產不會有。
    console.warn(`[eimu-shell] E2E origin 覆寫生效（EIMU_E2E=1）：APP_ORIGIN=${APP_ORIGIN}`);
  } catch {
    /* 非法 URL：忽略覆寫，維持預設白名單 */
  }
}

// W6b／W6c：device bridge 殼內指示。連線**預設 OFF**；只有使用者明確開啟
// （持久化設定 deviceBridgeEnabled，或以 EIMU_DEVICE_BRIDGE=1 操作者覆寫）
// 且已有授權根、能取得憑證才連。開啟狀態以視窗標題可見化，並把狀態推給頁面
// （window.eimuLocal.onBridgeStatus 訂閱 eimu-local:bridge-state）。
let bridgeState = { enabled: false, state: "off", roots: [], deviceId: null, mode: "ask" };
// 控制器已把客戶端的 "reconnecting" 正規化為 "connecting"，故這裡收 connecting。
const BRIDGE_ACTIVE = new Set(["online", "connecting"]);

function applyBridgeIndicator() {
  if (!mainWindow) return;
  const on = BRIDGE_ACTIVE.has(bridgeState.state);
  mainWindow.setTitle(on ? "Eimu · 本機檔案橋接已開啟" : "Eimu");
}

/** 狀態變更：更新標題指示，並推給所有視窗的頁面。 */
function broadcastBridgeStatus(status) {
  if (status && typeof status === "object") bridgeState = status;
  applyBridgeIndicator();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win || win.isDestroyed()) continue;
    try {
      win.webContents.send(localWorker.CHANNELS.bridgeEvent, bridgeState);
    } catch {
      /* 單一視窗傳送失敗不影響其他視窗 */
    }
  }
}

let mainWindow = null;

// ── 使用者設定持久化（<userData>/settings.json）─────────────────────────
// 只讀寫白名單欄位：
//   - deviceBridgeEnabled: boolean        使用者是否開啟本機檔案授權
//   - deviceBridgeMode: "off"|"ask"|"auto"|"full"  權限模式（W6c；非法值忽略回預設）
//   - deviceBridgeGatewayBaseUrl: string  使用者顯式設定的閘道位址（可選）
//   - deviceBridgeDeviceId: string        本安裝的穩定裝置識別（非機密，可下發閘道；
//                                         缺＝首次啟動產生一次並寫回，之後沿用不重生）
// **不**持久化 apiKey：憑證只從 <userData>/device-bridge.json（0600）讀，
// 頁面不可寫（見上方 bridge 註解與 lib/bridge-credential.js）。
function settingsFilePath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function readSettings() {
  const out = {};
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(settingsFilePath(), "utf8"));
  } catch {
    return out; // 不存在／壞 JSON＝預設（橋 OFF），不影響殼啟動
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
  if (typeof parsed.deviceBridgeEnabled === "boolean") out.deviceBridgeEnabled = parsed.deviceBridgeEnabled;
  // W6c：模式白名單驗證（enum 之外一律忽略，由呼叫端回預設 "ask"）。
  if (typeof parsed.deviceBridgeMode === "string" && PERMISSION_MODES.includes(parsed.deviceBridgeMode)) {
    out.deviceBridgeMode = parsed.deviceBridgeMode;
  }
  if (typeof parsed.deviceBridgeGatewayBaseUrl === "string") {
    out.deviceBridgeGatewayBaseUrl = parsed.deviceBridgeGatewayBaseUrl;
  }
  // 穩定安裝裝置識別（缺陷修復）：非機密、可下發閘道；空/非字串一律忽略（呼叫端會重生）。
  if (typeof parsed.deviceBridgeDeviceId === "string" && parsed.deviceBridgeDeviceId.trim()) {
    out.deviceBridgeDeviceId = parsed.deviceBridgeDeviceId.trim().slice(0, 128);
  }
  return out;
}

function writeSettings(next) {
  try {
    fs.mkdirSync(path.dirname(settingsFilePath()), { recursive: true });
    fs.writeFileSync(settingsFilePath(), JSON.stringify(next, null, 2), { mode: 0o600 });
    return true;
  } catch (err) {
    console.warn(`[eimu-shell] 設定寫入失敗：${err && err.code ? err.code : "error"}`);
    return false;
  }
}

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
    if (BRIDGE_ACTIVE.has(bridgeState.state)) {
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

  // W6c：頁面載入完成時補推一次當前 bridge 狀態，避免頁面訂閱（onBridgeStatus）
  // 晚於啟動推送而永遠收不到初始狀態。用既有廣播（含標題指示）即可。
  mainWindow.webContents.on("did-finish-load", () => {
    broadcastBridgeStatus(bridgeState);
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

    // W6b／W6c：device bridge（雲端 agent 經本機**出站**連線讀已授權檔案）。
    //
    // 憑證**不由頁面注入**——殼載入的是遠端頁面，讓頁面能把憑證交給主進程等於多開
    // 一條 remote→local 信任路徑。改讀使用者自己放在 <userData>/device-bridge.json
    // 的檔案（必須 0600）：沒有那個檔、JSON 壞、權限過寬，一律回 null ⇒ 橋停在
    // credentials_unavailable。讀取規則見 lib/bridge-credential.js，啟用步驟見
    // desktop/DEVICE-BRIDGE.md。
    const bridgeCredential = readCredentialStore(path.join(app.getPath("userData"), "device-bridge.json"), {
      onWarn: (reason) => console.warn(`[device-bridge] ${reason}`),
    });
    const settings = readSettings();
    // 穩定安裝裝置識別（缺陷修復）：同一安裝的每次 register 必須帶同一 device_id，否則
    // 閘道對每次重連都配新 deviceId，同 tenant 累積多台 online ⇒ device_ambiguous／逾時
    // （見 device-bridge-client.js 檔頭 helper 註解）。讀 settings.json 白名單欄位
    // deviceBridgeDeviceId；缺值＝這裡產生一次並寫回（resolveStableDeviceId → write →
    // writeSettings），之後每次啟動沿用同一值、不重生。值非機密（≠憑證），可下發閘道。
    const stableDeviceId = resolveStableDeviceId({
      read: () => settings.deviceBridgeDeviceId,
      write: (id) => {
        settings.deviceBridgeDeviceId = id;
        writeSettings(settings);
      },
    });
    // 閘道位址優先序：env 覆寫 > 使用者設定 > 憑證檔自帶 > 客戶端預設。
    const resolveGatewayBaseUrl = () =>
      process.env.EIMU_GATEWAY_BASE_URL || settings.deviceBridgeGatewayBaseUrl || bridgeCredential?.gatewayBaseUrl;

    // 生命週期編排（可重入）在 local-worker.createBridgeController：這裡只做依賴注入。
    // 好處：「授權根變更→以新 roots 重註冊」可在純 node 下以間諜 client 驗（*.test.js），
    // 不必啟動 Electron（本檔頂層呼叫 app API，無法在 node 下 require）。
    const bridgeController = localWorker.createBridgeController({
      startBridge: (opts) => startDeviceBridge({ ...opts, deviceIdProvider: () => stableDeviceId }),
      stopBridge: () => stopDeviceBridge(),
      getClientState: () => getDeviceBridgeState(),
      readEnabled: () => settings.deviceBridgeEnabled === true,
      writeEnabled: (v) => {
        settings.deviceBridgeEnabled = v === true;
        writeSettings(settings);
      },
      // W6c：權限模式持久化（deviceBridgeMode 白名單欄位；非法值於 readSettings 已忽略）。
      readMode: () => settings.deviceBridgeMode,
      writeMode: (m) => {
        settings.deviceBridgeMode = m;
        writeSettings(settings);
      },
      // 規則來源目前無使用者設定面（契約已預留）：回 undefined ⇒ 不下發 rules 欄位。
      // 第二道防線仍以硬 denylist／safety-check／模式生效。
      rulesProvider: () => undefined,
      getGatewayBaseUrl: resolveGatewayBaseUrl,
      credentialProvider: () => (bridgeCredential ? bridgeCredential.apiKey : null),
      onStatusChange: (s) => broadcastBridgeStatus(s),
    });

    // W3／W6c：註冊本機媒體工人（preload 暴露的 window.eimuLocal 之主進程側，含
    // device bridge 四個新 API）。每個 handler 自行驗 senderFrame origin 與逐次路徑授權。
    localWorker.registerLocalWorker({ appHosts: APP_HOSTS, bridgeController });

    // W6b 啟動：以持久化設定（或 EIMU_DEVICE_BRIDGE=1 操作者覆寫）決定「已開啟意圖」。
    // env 覆寫保留既有 E2E／操作者路徑，且**不**寫回設定檔。無授權根時控制器停在
    // no_authorized_roots；之後 pickFiles 授權新根會自動以新 roots 重註冊（見 local-worker）。
    //
    // W6c 權限模式優先序：EIMU_DEVICE_BRIDGE_MODE（env，供 E2E／操作者）
    //   > settings.deviceBridgeMode > "ask"。模式 off ⇒ 等於不開啟（不啟動）。
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
        /* 啟動失敗不得影響殼啟動 */
      });
    } else {
      broadcastBridgeStatus(bridgeController.status()); // 讓頁面收到初始狀態（off 或 mode=off）
    }

    // 0.3.0：自繪視窗控制鈕的 IPC（preload 暴露的 window.eimuShell 之主進程側）。
    // 登記一次即可；目標視窗以 event.sender 反查，非全域 mainWindow。
    registerWindowControlsIpc(ipcMain);

    // 0.3.2：自動更新接入點（另一條工作流請留意，勿重排）。
    //   - initUpdater：開發模式自動 no-op；打包後延遲 15s 檢查、每 6h 一次，
    //     下載完成時向主視窗送 eimu-shell:update-ready。
    //   - eimu-shell:apply-update：頁面按下「重啟並套用」時觸發。
    //     放在 main.js（組合根）而非 window-controls.js，讓後者維持單一職責。
    initUpdater({ getWindow: () => mainWindow });
    ipcMain.on("eimu-shell:apply-update", () => {
      applyUpdate();
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
