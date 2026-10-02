// 單一真源 re-export：沙箱實作只在 opencode-runtime/lib/sandbox.ts 維護。
//
// 本檔原先是一份 runtime 的過時複本，2026-10-02 兩者分叉（runtime 新增
// ensureSessionLauncher，供 plugin 的 shell.env hook 寫本會話 launcher）。
// 改為純 re-export，讓 vps-tools 的測試與 runtime 共用同一份真源，
// 不再有第二份會漂移的實作。vps-tools 內的 import 路徑不變。
export * from "../../opencode-runtime/lib/sandbox"
