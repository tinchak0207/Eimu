/**
 * Eimu 桌面壳注入的极窄桥接 API（contextBridge）。
 *
 * 只有 Electron 薄壳（loadURL https://www.eimu.dev）会在页面注入 `window.eimuShell`；
 * 普通浏览器（含 PWA）没有这个物件 ⇒ 视窗控制钮一律不渲染（避免死钮）。
 * 外壳原生视窗控制钮已移除，网页自绘的理由见 WindowControls.tsx 顶注。
 */
export interface EimuShellApi {
  /** 宿主平台标识（外壳传入，例如 "linux"／"win32"／"darwin"）。 */
  platform: string;
  /** 最小化整个视窗。 */
  minimize(): void;
  /** 最大化／还原切换。 */
  toggleMaximize(): void;
  /** 关闭整个视窗。 */
  close(): void;
  /** 目前是否最大化（外壳真相，非页面推测）。 */
  isMaximized(): Promise<boolean>;
  /** 订阅最大化状态变化，回传退订函式（卸载时务必呼叫）。 */
  onMaximizeChange(callback: (maximized: boolean) => void): () => void;
}

declare global {
  interface Window {
    eimuShell?: EimuShellApi;
  }
}
