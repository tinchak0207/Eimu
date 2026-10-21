# 本地优先 I/O 与重算本地化（W1–W6）

> 2026-10-04 文件化。**本档只描述、不改码**——裁定来源＝`mem show 2026-10-04-desktop-localization-assessment.md`：
> 「T1（网页层 File System Access＋WebCodecs）→ T2（桌面壳本机媒体工人），T3（agent 搬本机）押后」。
> 本轮落地＝W1 本机影片前处理、W3 桌面壳本地能力契约、W4 重算卸载 adapter、W5 计费/额度/幂等、W6 device bridge。
> 薄壳钦定（`mem show electron-desktop-packaging-assessment-0916.md`「方案①、不想双端维护」，`desktop/main.js:3` 自述「明确不做本地起 Next server」）
> **未被推翻**——本地能力是渐进增强，不是第二条分支。

## 0. 一句话切线

**推理、付费生成、计费帐本、画布 world1 状态留在云端；素材入库、产物落地、本机重算下放到使用者机器。**
本机能力侦测一律走「端点/API 是否存在」，不是 UA 字串（`src/lib/local-save.ts:3-7`）；任一能力缺席即回落今天的云端路径，站点与薄壳行为不变。

## 1. 能力清单

| 能力 | 入口档案 | 生效条件 | 缺席时的行为（回落） |
|---|---|---|---|
| 影片本机前处理（抽关键帧＋poster＋probe，只上行衍生小档） | `src/lib/local-media-ingest.ts:440`（`ingestMediaLocally`，契约「永不抛出」见档头 :10）；呼叫端 `src/components/agent-chat/AgentComposer.tsx:564` | 浏览器可解码该影片且衍生档 ≤ `MAX_DERIVED_UPLOAD_BYTES` 4MB（:43） | 逐级回落：衍生档上传失败→原片直传（`AgentComposer.tsx:595` uploadVideoDirect）→再失败→旧抽帧路径（:606） |
| 直传物件存储（本站不经手位元组） | `src/lib/direct-upload-client.ts:243`（`uploadDirect`）；消费端 `src/components/canvas/embed/use-canvas-interaction.ts:531` | `/api/uploads/sign` 回可直传的 `uploadUrl`；`file.size ≤ 回应 maxBytes`（:9-13） | 后端不支援带 headers 的 PUT 时抛 `UNSUPPORTED_BACKEND_CODE`（:33），呼叫端自走旧路径 |
| 产物直写本机目录（File System Access API） | `src/lib/local-save.ts:78` `saveBlobLocally`／:116 `saveManyLocally`；消费端 `src/lib/image-helpers.ts:138`、`src/lib/export-zip.ts:66`、`src/lib/history-export.ts:11` | 端点 `showSaveFilePicker`/`showDirectoryPicker` 存在（:70 `hasLocalFileSave`） | 回 `"unsupported"`（:11），呼叫端回落 blob＋`<a download>`；桌面壳的 `will-download` 拦截仍是那条落地面（`desktop/main.js:257`） |
| 本机重算卸载 adapter（probe/抽帧/转码走桌面壳 ffmpeg） | `src/lib/local-media-worker.ts:143` `hasLocalMediaWorker`／:157／:171／:188 | 页面存在 `window.eimuLocal` 且 `capabilities().ffmpeg === true`（:14-19） | 一律回 `{ok:false, reason}`，**不 throw**（档头 :10-12）；纯浏览器＝`no_local_worker` |
| 桌面壳本地能力通道（原生挑档／ffprobe／ffmpeg） | `desktop/preload.js`（暴露 `window.eimuLocal`）→ `desktop/local-worker.js`（主进程授权闸） | `main.js:224` 注入 preload；仅 `eimu.dev` 顶层 frame；逐次 pickFiles 授权 | 非授权来源/路径回 `E_*` 错误（契约见 `desktop/LOCAL-CAPABILITIES.md:32`） |
| Device bridge（云端 agent 经本机出站连线读已授权档） | 云端 `deploy-staging/gateway/device-bridge.ts`；本机 `desktop/device-bridge-client.js` | `EIMU_DEVICE_BRIDGE=1` 且能取得凭证（见 §3、§6） | 闸道 `router.ts:375` 前缀闸不进；本机停 `off`，一位元组不出网（`desktop/device-bridge-client.js:16-17`） |

## 2. 两份契约（指引，不复制）

- 桌面壳本地能力（`window.eimuLocal` 介面、错误码、denylist、验证边界）：`desktop/LOCAL-CAPABILITIES.md`（W3）。
- Device bridge 本机侧（出站协议、工具白名单、预设 OFF、凭证缺口）：`desktop/DEVICE-BRIDGE.md`（W6b）；云端半边档头契约＝`deploy-staging/gateway/device-bridge.ts:1-38`。
  两份是**各自唯一真源**，本档只指向，不抄全文。

## 3. 开关清单

| 开关 | 预设 | 开启方式 | 开启后影响面 |
|---|---|---|---|
| `EIMU_DEVICE_BRIDGE` | **OFF**（非 truthy 即关，`device-bridge.ts:59-62`） | `=1`（VPS systemd gateway env；壳侧 `main.js:313` 需严格 `"1"`） | 挂载 `/agent/v1/device-bridge/{register,heartbeat,poll,result}`（`router.ts:375`）＋壳启动出站客户端；**即使开启**，壳的 `credentialProvider` 恒回 null（`main.js:314`）⇒ 只会得到 `credentials_unavailable`，桥实际不启动 |
| `EIMU_DEVICE_BRIDGE_HEARTBEAT_TTL_MS` | 90000 | env 覆写（`device-bridge.ts:65`） | 心跳逾时即视装置离线，invoke 回 `device_offline` |
| `EIMU_DEVICE_BRIDGE_REQUEST_TIMEOUT_MS` | 30000 | env 覆写（:67） | 单次呼叫等待上限，逾时回 `device_request_timeout` |
| `EIMU_DEVICE_BRIDGE_CONSENT_TTL_MS` | 45000 | env 覆写（:69；需 ≥ 请求逾时） | 同意票有效期（逐次、单用、绑 deviceId+tool+requestId） |
| `EIMU_GATEWAY_BASE_URL` | 未设 | env 覆写（`main.js:312`） | 壳连闸道的 base URL；未设时 bridge 连线失败但**不影响壳启动**（:319-321） |
| `SURGERY_QUOTA_PRECHECK` | 既有开关 | 既有机制（`quota-precheck.ts:310`） | **`budgetCapCoins` 硬停刻意排在此开关之前**（:289-290）：宣告上限不因影子期关掉而失效 |

## 4. 计费面规则（本轮重点）

1. **客户端只算「预估」**：`src/lib/task-budget.ts:13` `estimateCoins` 由 catalog credits÷10 推导（:7），与 `/v1/quota` 同源。结算权威仍在伺服器：`account_ledger`（`src/lib/mapay-credit.ts:14`「我方帐本 account_ledger 记一笔 recharge（余额权威）」）；`users.quota` 是内核执法点（`quota-precheck.ts:317-320`）。
2. **额度显示三态**：`src/lib/quota-display.ts:52` `describeQuota` 收敛 authoritative／estimated／unavailable；`unavailable` **一律回「暂不可用」且 tone=unknown，永不显示 0**（:32、档头 :9-12，与伺服器端 `src/app/api/v1/quota/decision.ts:56-57` 503 `quota_unavailable` 同一诚实线）。
3. **预算硬停**：呼叫端在请求体宣告 `cap_coins` → route 透传 `budgetCapCoins`（`images/generations/route.ts:341-347`、`videos/generations/route.ts:323-329`）；超限回 **402 `task_budget_exceeded`**（`quota-precheck.ts:81-83`、guard :295-307），附 `estimated_coins`/`cap_coins`。未宣告＝零回归（:288-290）。
4. **新增生成入口不得绕过 `enforceQuotaGate`**：现况只有 4 条对外生成路由接闸（`quota-gate-coverage.test.ts:34-39`），另有 6 条 legacy（见 §6）。守门测试 `quota-gate-coverage.test.ts` 会在「新入口没接闸又不在白名单」时红灯，但它**只是变更探针**（自述 :10-21）。
5. **幂等**：生成型请求带并沿用**同一个 `X-Request-Id`**（`generation-request-headers.ts:23`、:39；MCP 幂等键 `mcpGenerationIdempotencyKey` :58）。直传 PUT 重试沿用同一 `objectKey` 以保证伺服器端 `alreadyCommitted` 幂等（`direct-upload-client.ts:11-13`）。任何 log 不得含 `authorization` 值（`generation-request-headers.ts:13`）。

## 5. 验证 oracle（「通过」长什么样）

- **真上传位元组**：`/api/uploads/commit` 由**伺服器亲自验 sha256**（`direct-upload-client.ts:6`）——以真实档案位元组跑通 sign→PUT→commit 才算。
- **真档案 hash／真档案落地**：本机产物以实际档案（非 base64／记忆体）比对大小与内容（`local-save.ts:78` 回 `"saved"` 需真写入成功）。
- **真帐本行**：402 `insufficient_balance`／`task_budget_exceeded` 必须能在 `account_ledger` 对应「本次未扣费」；权威是帐本行，不是前端数字。
- **真 VPS 计数／真上游回应**：device bridge 的离线/逾时/同意票重放错误码须由真闸道＋真装置产生；本轮**未跑**。
- **哪些不算 oracle（变更探针）**：`quota-gate-coverage.test.ts` 的 source-scan（自述 :10-21）、任何原始码字串断言、档案存在、`node --check` 语法检、HTTP 200。守门件不是 oracle（AGENTS.md 验证铁律）。

## 6. 已知缺口与未验证项（照实）

1. **device bridge 缺凭证来源**：壳只载远端页面、只有 session，无 biz key；`credentialProvider` 恒回 null（`desktop/main.js:306-314`）⇒ 即使 `EIMU_DEVICE_BRIDGE=1`，桥得到 `credentials_unavailable` 不启动。补法（短效 device token 经窄 IPC 注入）**尚未实作**（`desktop/DEVICE-BRIDGE.md:32-39`）。**未验证**。
2. **`cap_coins` 前端未接**：全站 UI 无任何元件送 `cap_coins`（grep 命中仅 images/videos route 与测试）；「使用者如何在 UI 设预算」未定。后端有能力，**前端未接、未验证**。
3. **6 条 legacy 生成入口不经 precheck（既有状况，非本轮引入）**：`batches`／`generation-jobs`／`upscale`／`storyboard-voiceover`／`sku/run-service`／`generation-core/canary-service`（明文白名单＋各自收费依据见 `quota-gate-coverage.test.ts:45-52`）。它们走 legacy reserve/sync-charge（有实际扣费），但确实不经 `enforceQuotaGate`。
4. **`db/migrations/036_generation_attempt_source.sql.pending` 刻意未套用**：`tools/migrate-generation-db.ts:9` 只收 `.sql` 结尾档，故以 `.pending` 副档名挡住（档头自述）。**未对任何真实 DB 执行**。
5. **桌面壳 GUI E2E 尚未跑**（无显示环境）：挑档对话框、真 ffmpeg 抽帧/转码、origin 拒绝、IPC 串接、device bridge 真连线均未验（`desktop/LOCAL-CAPABILITIES.md:43`、`desktop/DEVICE-BRIDGE.md:69-74`）。
6. **W4 本机重算 adapter 无生产消费者**：`local-media-worker.ts` 仅有自身与 `local-media-worker.test.ts`，无 route/元件 import（grep 实查）。lib＋单元测试已交付，**尚未接线**。已确认无适用接点：前端发起的媒体重算仅 `AgentComposer.tsx`／`local-media-ingest.ts` 两处（已由 W1 覆盖，见 §1），canvas 路径吃远端 https，本机 worker 契约不适用。
7. **额度三态显示已接 UI（原缺口解除）**：`src/components/WalletBadge.tsx:8` import `describeQuota`、`:106` 呼叫消费（`quotaState ?? derivedQuotaState`），不再是「仅 lib＋测试」。三态呈现（`WalletBadge.tsx:82-112`）：① 有有限读数 ⇒ `authoritative`，直接显示帐本权威值（含真实的 0）；② 读不到但有上次成功读数 ⇒ `estimated`，显示「约 N」并以 `stale` 标已过期、tone 依时效 `ok`/`warn`；③ 完全读不到 ⇒ `unavailable`，显示「暂不可用」、tone=`unknown`，**永不画假 0**。`quotaToneClass`（:107-112）对应 tone 上色。纯显示层收敛，未改任何取余额 API／资料层；真帐本 E2E 仍未跑。

## 7. 不做什么

- **不搬 agent loop**：推理与工具编排在 VPS opencode-server；T3（agent 打包进 App）押后（assessment 建议）。
- **不下发上游付费 key**：付费生成仍回云端（AGENTS.md「付费上游呼叫硬闸」）。
- **不放宽 Electron 安全边界**：`nodeIntegration:false`、`contextIsolation:true`、`webSecurity:true` 均未放宽（`desktop/main.js:216-219`）；preload 无 `exec`/`spawn`/`shell`/`fs`（`desktop/preload.js:8-11`）。
- **不新增写入/删除/执行类本机能力**：device bridge 工具面只有 `list_dir`/`read_file`/`grep`/`stat`（`device-bridge-policy.ts:14`）。

## 8. 复核用命令

```bash
# 能力入口与开关
grep -n "ingestMediaLocally" src/components/agent-chat/AgentComposer.tsx          # W1 呼叫点
grep -n "EIMU_DEVICE_BRIDGE" desktop/main.js deploy-staging/gateway/device-bridge.ts deploy-staging/gateway/router.ts
grep -n "enforceQuotaGate\|budgetCapCoins" src/lib/generation-core/quota-precheck.ts

# 计费三态与预算闸
grep -n "QUOTA_UNAVAILABLE_LABEL\|describeQuota" src/lib/quota-display.ts
grep -n "exceedsBudget" src/lib/task-budget.ts

# 绕过预检清单（变更探针，非 oracle）
grep -n "RESERVE_PATH_ALLOWLIST\|GATED_FILES" src/lib/generation-core/quota-gate-coverage.test.ts

# 桌面壳 E2E（无显示环境时不跑）
npx --yes tsx --test desktop/lib/*.test.js
```
