/**
 * Eimu 桌面殼注入的極窄橋接 API（contextBridge）。
 *
 * 只有 Electron 薄殼（loadURL https://www.eimu.dev）會在頁面注入 `window.eimuShell`；
 * 普通瀏覽器（含 PWA）沒有這個物件 ⇒ 視窗控制鈕一律不渲染（避免死鈕）。
 * 外殼原生視窗控制鈕已移除，網頁自繪的理由見 WindowControls.tsx 頂註。
 */
export interface EimuShellApi {
  /** 宿主平台標識（外殼傳入，例如 "linux"／"win32"／"darwin"）。 */
  platform: string;
  /** 最小化整個視窗。 */
  minimize(): void;
  /** 最大化／還原切換。 */
  toggleMaximize(): void;
  /** 關閉整個視窗。 */
  close(): void;
  /** 目前是否最大化（外殼真相，非頁面推測）。 */
  isMaximized(): Promise<boolean>;
  /** 訂閱最大化狀態變化，回傳退訂函式（卸載時務必呼叫）。 */
  onMaximizeChange(callback: (maximized: boolean) => void): () => void;
}

declare global {
  interface Window {
    eimuShell?: EimuShellApi;
  }
}
