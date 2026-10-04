# Device Bridge（本机侧客户端，W6b）

让云端 agent 透过使用者机器的**出站连线**读取「已授权」的本机档案。方向永远是本机
主动注册／心跳／长轮询，云端永不 inbound 打使用者机器。

## 档案
- `device-bridge-client.js`（主进程）：**只做连线与编排**（register/heartbeat/poll/result）。
- `lib/bridge-executor.js`（可测执行器）：四个唯读工具的实际档案存取与安全闸（注入 fs）。
- `lib/bridge-executor.test.js`：`node:test`，真正执行危险路径（空 allowlist、家目录外敏感、
  递回剪枝、单档大小上限、`path="/"`）。跑 `npx --yes tsx --test desktop/lib/bridge-executor.test.js`。
- `lib/bridge-protocol.js`（纯函式）：工具白名单、参数净化、`max_file_bytes` 夹制、256KB 夹制＋截断标记、退避。
- **denylist 唯一真源**＝云端 `deploy-staging/gateway/device-bridge-policy.vectors.json`；本机不再自带
  `lib/denylist-vectors.json`（已删）。`policy.test.js` 以 `fs.readFileSync` 直接载入云端那份的
  `sensitive` 段落逐条断言；本机刻意更严的加固项显式列在测试内。
- `lib/policy.test.js` / `lib/bridge-protocol.test.js`：纯函式层测试。
- `preload.js`（`window.eimuLocal.bridge.{status,enable,disable}` / `authorizedRoots` /
  `onBridgeStatus` 逐一白名单，无通用 invoke）＋ `local-worker.js`（四个 IPC handler 与可重入
  生命周期 `createBridgeController`）。
- `local-worker-bridge.test.js`：`node --test`，覆盖 status 三态、`enable()` 无授权根不启动、
  `disable()`、**授权根变更 → 以新 roots 重注册**、凭证 fail-closed、来源非白名单拒绝。


## 端点（逐栏对齐 `deploy-staging/gateway/device-bridge.ts`）
`POST /agent/v1/device-bridge/{register,heartbeat,poll,result}`，鉴权＝既有 Bearer `sk-biz-*`。
`/invoke` 是云端 agent 发起，本客户端不呼叫。

## 启用（使用者路径 ＋ 操作者覆写）
启用状态持久化在 `<userData>/settings.json` 的 `deviceBridgeEnabled`：使用者按
`window.eimuLocal.bridge.enable()` 时写入 true、`disable()` 写回 false。操作者可设
`EIMU_DEVICE_BRIDGE=1` **覆写**为「启动即开启」（保留既有 E2E／操作者路径）；此覆写**不**写回
设定档，使用者仍可在执行期 `disable()`。未设且设定为 false ⇒ 停在 `off`，一个位元组不出网。
开启且 `online`/`reconnecting` 时，视窗标题显示「Eimu · 本机档案桥接已开启」
（`page-title-updated` 期间维持，避免被远端 `<title>` 盖掉），并以 `eimu-local:bridge-state`
把状态推给所有视窗（页面用 `window.eimuLocal.onBridgeStatus` 订阅）。

**开启后仍会被授权根闸挡下**：allowlist 必填（见下）。授权根来自
`window.eimuLocal.pickFiles({ kind: "directory" })`——这是唯一授权入口。使用者要开 bridge 的
流程：① 先 pickFiles 挑资料夹 ② 再 `bridge.enable()`。若先 `enable()` 而尚无授权根，状态停在
`no_authorized_roots` 并**拒绝服务**（**不**自动授权任何路径）；之后 pickFiles 授权新根时，已启用
的 bridge 会**自动以新 roots 重注册**（stop→start，见 `local-worker.js` 的 `onRootsAuthorized`，
由 `handlePickFiles` → `applyPickAuthorization` 触发）。这是刻意、正确的结果（宁可不可用，也不退回
「只验 denylist」的危险语义）。

## 凭证来源（缺口未解，如实记录）
闸道鉴权沿用既有 `sk-biz-*`（`auth-gw.ts`）。桌面壳载入远端页面、**只有 session，没有 biz key**；
本模组**不**自造鉴权、**不**在壳内硬编任何 key。凭证**不由页面注入**：主进程读使用者自己放在
`<userData>/device-bridge.json`（必须 0600）的档案；缺档／JSON 坏／权限过宽一律回 `null` ⇒
bridge **不启动**、状态回报 `credentials_unavailable`（读取规则见 `lib/bridge-credential.js`）。
`gatewayBaseUrl` 优先序：`EIMU_GATEWAY_BASE_URL`（env） > `settings.json` 的
`deviceBridgeGatewayBaseUrl` > 凭证档自带 > 客户端预设；**apiKey 只从 0600 凭证档读，页面不可写**。

**建议补法（尚未实作，勿当已存在）**：由「已登入的网页」向服务端换一张**短效、限 device-bridge
scope 的 device token**（TTL 分钟级、可撤销），经窄 IPC 交给主进程当 Bearer 用；或维持由使用者
手动提供一次性凭证。任何方案都必须是短效、可撤回、不入 log／memory／commit。

## 安全模型
1. 工具白名单＝`list_dir`/`read_file`/`grep`/`stat`，**无任何写入／删除／执行命令**。
2. 路径先 `realpath` 解 symlink，再过 `lib/policy.js` 的 `isSensitivePath`（denylist 单一真源，
   不另造第二份）：**扫描所有路径段**（不限 `$HOME`）、一律转小写、fail-closed；涵盖
   `.ssh`/`.aws`/`.gnupg`/`.kube`/`.docker`、凭证档、浏览器 profile（Linux 与 macOS）。
3. **allowlist 必填**：授权根读 `local-worker.js` 的**同一份** `authorizedRoots`
   （使用者以 `pickFiles` 显式挑选的根），不另造第二套授权机制。授权根空集 ⇒ **整条 bridge
   拒绝服务**（状态 `no_authorized_roots`）、执行器亦一律拒（`no_authorized_roots`）；
   **不得**退回「只验 denylist」。
4. **档案系统根**（`/`、`C:\`）一律拒（`path_is_root`），避免整盘扫描。
5. `grep` **逐档先 `stat` 再决定读取**；单档上限＝`min(云端下发 max_file_bytes, MAX_GREP_FILE_BYTES)`
   （`MAX_GREP_FILE_BYTES`＝1MB＝云端契约上限，本机只能更严不得更松），超过者跳过并以
   `skipped_large_files` 计数（不整档入记忆体）。不跟 symlink、有深度/档数/行数/每行长上限。
   另回报 `sensitive_path_touched`／`excluded_sensitive_count`（H2 契约：递回/列举碰到敏感段即计数，
   云端 `sensitiveResultProblem` 据此整笔拒绝）。
6. 回传前 `clampResult` 夹 256KB（与云端 `MAX_READ_BYTES` 同值）＋ `…[truncated N bytes]` 标记，UTF-8 边界安全。
7. `consent_token` 执行前验形状/有效期；**成功与错误回报都带票**（闸道 result 一律先 `consume`，
   缺票必得 `consent_token_not_found` 并吃满逾时）。
8. 逾时与连线失败以指数退避重连（`nextBackoff`，封顶 30s）。
9. log 只写状态与错误码，**永不**写凭证或档案内容。

## 已知差异（来源备注）
`policy.js` 的 denylist 与云端 `device-bridge-policy.ts` **同一语义**（扫所有路径段、一律小写、
fail-closed）。两者跨 runtime（Electron CJS ↔ bun TS）无法共用模组，故以**云端向量表**
`deploy-staging/gateway/device-bridge-policy.vectors.json` 为唯一真源（本机测试直接载入它，
不再自带第二份 JSON）。本机是保守超集（额外 `.mozilla` 段、`.config/{gcloud,gh,git,code,electron}`
序列、`.python_history`），只多挡不松绑——这些加固项显式列在 `policy.test.js`，不进真源档。

## 未验证
真装置／真闸道／真 agent 呼叫未跑（无显示环境，且无 biz key 无法连闸道）。纯函式层由
`policy.test.js` / `bridge-protocol.test.js` 覆盖；**执行器（真正读档的危险路径）由
`bridge-executor.test.js` 覆盖**（空 allowlist、家目录外敏感、递回剪枝、单档上限、`path="/"`）。
连线回圈（register/heartbeat/poll/result）与 `main.js` 的 protocol 闸仅经 `node --check` 语法检与
`tsc`；未做真闸道 E2E。

W6c（使用者面四个 IPC）已在纯 node 以注入间谍 client 验过（`local-worker-bridge.test.js`），但
**真壳端到端未验**：真 `pickFiles` 对话框、真 `bridge.enable()` → 真闸道注册，以及「状态推送到
`onBridgeStatus`」都需真 Electron。且新增 IPC **必须重建桌面产物**才会出货（目前对外 0.3.2 不含
这些 channel）；未重建前 `window.eimuLocal.bridge` 不存在。
