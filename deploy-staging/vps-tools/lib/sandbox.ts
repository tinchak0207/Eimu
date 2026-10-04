// 单一真源 re-export：沙箱实作只在 opencode-runtime/lib/sandbox.ts 维护。
//
// 本档原先是一份 runtime 的过时复本，2026-10-02 两者分叉（runtime 新增
// ensureSessionLauncher，供 plugin 的 shell.env hook 写本会话 launcher）。
// 改为纯 re-export，让 vps-tools 的测试与 runtime 共用同一份真源，
// 不再有第二份会漂移的实作。vps-tools 内的 import 路径不变。
export * from "../../opencode-runtime/lib/sandbox"
