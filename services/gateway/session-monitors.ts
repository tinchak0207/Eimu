// Monitor（事件监视）持久层、子进程/WebSocket 采集与 reaper。
//
// 语义取证自 Claude Code 2.1.302 的 Monitor：
// - description 必填（短句）；
// - timeout_ms 默认 300000，上限 1800000（超过压到上限）；
// - command 与 ws 二选一：命令每行 stdout = 一个事件，进程退出即结束；ws 每帧 = 一个事件；
// - 事件到达时作为会话事件推送（复用 emitToSession），不打断当前 turn，也不是用户发言；
// - 超时/结束注入一条系统通知（见 expiryMessage）；0 事件时附 widen the filter 提示；
// - 同一 monitor 每秒最多 20 条进入会话，超出丢弃并计数（防 firehose）。
//
// 约束：
// - 模块 import 时不得启动任何定时器；reaper 只能由 startMonitorReaper() 显式启动。
// - 与 job-store.ts 同一条真源（SESSIONS_DB_PATH），WAL + CREATE TABLE IF NOT EXISTS。
// - 子进程只用 Bun.spawn（bash -lc），cwd=/opt/agent-harness/workspace（HARNESS_WORKSPACE 可覆写），
//   env 只传 PATH/HOME/LANG/TZ；stdout 按行切分；spawn 时 detached=true，停止时杀整个进程组。
// - 命令安全闸是最小防线，不是沙箱：按 shell 分词逐段检查危险形态（含引号/反引号/$()/管道），
//   真正的权限边界在 Eimu 既有工具闸与宿主隔离。
// 子代理会话不在主 sessions 表；monitor 的 session_id 可能是子会话的 opencode id，
// 存活判定必须与其它 /internal 路由同源：resolveSession ?? subagentParentState。
export { MONITOR_DEFAULT_TIMEOUT_MS, MONITOR_MAX_TIMEOUT_MS, MONITOR_MIN_TIMEOUT_MS, MONITOR_MAX_EVENTS_PER_SECOND, MONITOR_LAST_LINES, MONITOR_MAX_PER_SESSION, MONITOR_MAX_ACTIVE, MonitorPolicyError, normalizeMonitorTimeout } from "./session-monitors-types.ts"
export type { MonitorInput, SessionMonitorRow, MonitorView } from "./session-monitors-types.ts"
export { assertMonitorCommandAllowed } from "./session-monitors-shell.ts"
export { startMonitor, stopMonitor, listMonitors, killSessionMonitors, pruneMonitors, startMonitorReaper } from "./session-monitors-runtime.ts"
