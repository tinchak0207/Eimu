// device-bridge.ts — W6a：装置桥**云端侧**（闸道端）。
//
// 目的：让**云端 agent** 经由使用者机器的**出站连线**读本机档案——云端永不 inbound
// 打使用者机器；方向永远是「本机 daemon 主动对外注册／心跳／轮询，取回云端下发的
// 工作，执行后把**必要片段**回传」。本档实作闸道这半边：把「本机档案工具」呼叫
// 转下去、验同意票、夹大小、逾时取消。
//
// 为什么要这一层（第一性原理）：agent 的推理在云端，档案在使用者机器；主流解法是
// 「档案 I/O 留在本机、只把 agent 实际打开的那一小片内容回填」——companion daemon
// ＋出站通道正是这条。这与「把整个 repo 搬上云」是两个极端。
//
// ── 预设 OFF（硬性）─────────────────────────────────────────────────────
// 总开关＝env `EIMU_DEVICE_BRIDGE`。未设／非 truthy（1/true/yes/on）＝整个能力不挂载：
// router 连路由前缀都不进（见 router.ts 的 `deviceBridgeEnabled()` 闸），对既有生产
// 行为零影响。开启方式：`EIMU_DEVICE_BRIDGE=1`（通常写进 VPS systemd 的 gateway env）。
//
// ── 鉴权（复用，不造第二套）─────────────────────────────────────────────
// 装置端与云端 agent 都走**既有** Bearer sk-biz-* 闸门：router 已完成
// validateApiKey + resolveCanonicalKey；本档再用 auth-gw 的 resolveCanonicalIdentity
// 取 userId（正典化缓存命中，几乎零成本），绑定 userId ↔ deviceId ↔ connection。
//
// 2026-10-05（W7a）：**装置端多一条短效票路径**。桌面壳载入的是远端页面、壳内不可能有
// 也不该有长期 key，旧设计「使用者自己把 0600 key 档放进 userData」对真实使用者等于
// 功能不存在（实测停在 credentials_unavailable）。新增：已登录页面经站内服务端
// 向 `POST /agent/v1/device-bridge/token`（Bearer sk-biz-*）换一张 `sk-dev-…`
// 短效票，经窄 IPC 交给壳当 Bearer 打 register/heartbeat/poll/result。票由 router 核销后
// 以 `ctx.deviceIdentity` 传进来，tenant 与 sk-biz 路径**逐字同源**；0600 档仍保留为
// 操作者后备。票绝不落盘、绝不入 log。
//
// ── 安全模型 ────────────────────────────────────────────────────────────
//   1. 工具面收敛成最小集合 list_dir/read_file/grep/stat（无写/删/执行）。
//   2. 伺服器侧 denylist（device-bridge-policy.isSensitivePath）：路径敏感一律拒，
//      不倚赖本机端自报（纵深防御）。
//   3. 逐次同意票（consent token）：每次下发一票，单次可用、绑
//      deviceId+tool+requestId、短 TTL；本机端**执行前验票**，闸道端在回传时再验
//      （过期／不匹配／重放各回明确错误码）。
//   4. 回传内容大小硬上限 MAX_READ_BYTES（256KB）＋截断标记。
//   5. 请求逾时可取消，回 `device_request_timeout`。
//   6. H2（2026-10-04）递回根夹制：`grep`/`list_dir` 会由装置**递回**收集档案，
//      云端看不到收集结果，故要求装置在 register 回报使用者已授权根（`roots`），
//      递回根必须落在授权根之下；档案系统根（`/`、Windows 磁碟根、UNC share）一律拒。
//      未授权任何根 ⇒ 递回型工具全拒（fail-closed）。
//   7. H2 输入侧契约：`grep` 随参数下发 `max_file_bytes`（单档读入上限
//      MAX_FILE_READ_BYTES=1MB，装置端遵守）；装置若自报递回触碰敏感段
//      （`sensitive_path_touched`／`excluded_sensitive_count`／`sensitive_paths`），
//      云端整笔拒绝、结果不落地。
//
// 本档只准动 deploy-staging/gateway/ 之下；未部署、未接 VPS。

export { AUTHORIZATION_OPTIONS, ConsentTokenStore, DEVICE_CONSENT_TTL_MS, DEVICE_GATEWAY_BASE_URL, DEVICE_HEARTBEAT_TTL_MS, DEVICE_ONCE_GRANT_TTL_MS, DEVICE_POLL_MAX_WAIT_MS, DEVICE_REQUEST_TIMEOUT_MS, OnceGrantStore, deviceBridgeEnabled, finalizeDeviceResult, isBinaryTextPayload, sanitizeToolArgs } from "./device-bridge-types.ts"
export type { ConsentTokenBinding, ConsentTokenError, ConsentTokenRecord, DeviceBridgeErrorCode, DeviceRecord, DeviceRequestMessage, InvokeResult, NeedsAuthorizationInfo, OnceGrantBinding, OnceGrantError, OnceGrantRecord, PickDeviceResult, SanitizeErr, SanitizeOk, TenantDeviceDescription } from "./device-bridge-types.ts"
export { DeviceBridge } from "./device-bridge-class.ts"
export { deviceBridge, deviceBridgePolicyState, deviceBridgeRuntimeState, handleDeviceBridgeRoutes, handleInternalDeviceAuthorize, handleInternalDeviceInvoke, handleInternalDeviceStatus } from "./device-bridge-routes.ts"
export type { DeviceBridgePolicyState, DeviceBridgeRuntimeState, InternalDeviceRouteDeps } from "./device-bridge-routes.ts"
