/**
 * persistence.ts — 服务端会话持久化（bun:sqlite，零新依赖）
 *
 * 架构决策（2026-08-21）：
 * 1. 讯息历史的权威拥有者是 opencode serve（它自己的存储在 gateway 重启后仍完整存在）。
 *    gateway 不复制 messages 进自己的 DB —— 那会制造第二份会漂移的历史副本。
 *    gateway 需要持久化的只有自己拥有的那部分状态：
 *      - 身分映射：gateway sessionId ↔ opencode session id ↔ owner key
 *      - SSE replayBuffer（最近 REPLAY_BUFFER_SIZE 帧，断线/重启后前端 Last-Event-ID 续传用）
 *      - 事件翻译去重状态（messageRole / suppressedParts 等有界集合）
 *      - 一次性注入标记（vettingInjected / userMemory）
 *      - 画布摘要（canvasSummary）
 *      - 摘要压缩水位（compact.lastCount）
 * 2. 存储选 bun:sqlite（bun 内建）：单文件 /opt/agent-harness/state/sessions.db、
 *    WAL 模式、同步 API（getOwnedSession 是同步函数，lazy reload 不用改异步签名）。
 *    ⚠ db 必须放在 release 目录**之外**（2026-10-13「会话丢失」事故）：放在 release
 *    目录内时，每次发版换 symlink 会连库一起被换掉，新会话随旧 release 一起消失。
 * 3. 写入时机：dirty 标记 + 3s 防抖 flush（index.ts 持有 flush 循环），关键转换点
 *    （建立/删除）同步写；SIGTERM 时补一次 flush。重启最多丢 3s 内的 replay 帧，
 *    讯息本身永远安全在 opencode。
 * 4. 失败语义 fail-open：DB 不可用时只记日志、退回纯内存行为（与旧版一致），
 *    绝不让持久化故障杀死 gateway。
 */
export type { PersistableState, PersistedRow, Migration, MigrationReport, UserSettings, ReworkRecord, CriticScoreSource } from "./persistence-types.ts"
export { currentDbPath, SCHEMA_VERSION, readUserVersion, MIGRATIONS, loadHarnessSecurityState, saveHarnessSecurityState, deleteHarnessSecurityState, withHarnessSecurityTransaction, runMigrations, initPersistence, persistenceStatus } from "./persistence-schema.ts"
export { PERSISTED_DATA_KEYS, serialize, hydrateRow, saveSession, loadSessionById, loadSessionByOpencodeId, listSessionRows, setRowTitle, deleteSessionRow, loadUserSettings, saveUserSettings, loadTenantPermissionMode, saveTenantPermissionMode, saveReworkRecord, loadReworkRecords, deleteReworkRecord, markCriticPass, hasCriticPass, deleteCriticPass, saveCriticVerdict, getCriticVerdictByRun, saveHumanLabel, getHumanLabelByRun, saveExpertLesson, saveDelivery, loadSessionDeliveries, qualitySignalStats, loadSteerCommand, loadSteerCommandsForSession, saveSteerCommand, steerCommandStore, sweepStaleRows } from "./persistence-io.ts"
