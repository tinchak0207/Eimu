# 基礎設施排障 Runbook

> AGENTS.md 的按需附件：排障/部署/VPS 操作時才讀，平時不載入。本檔只進排障筆記；行為規則歸 AGENTS.md，歷史歸檔歸 memory。

## VPS 访问（2026-08-21 起主用 SSH-over-443）

- **主通道**：`bash .pixai-refresh/start-ssh443.sh`（幂等启动本地隧道）→ `node .dsh-ssh/exec-443.js "<命令>"`。链路：本机 127.0.0.1:22222 → ws 隧道 → `wss://store.tinchak0207.xyz/ssh` → nginx `/ssh` → gost `forward+ws://0.0.0.0:18083/127.0.0.1:22`（VPS systemd warp-proxy-gost，0.0.0.0 监听因 nginx 容器经网关 172.20.0.1 访问，UFW 已放行 172.16.0.0/12→18082/18083）→ sshd。**443 永通，连续 5 连间隔 1s 稳定，完全免疫 ISP 对 SSH 端口的 DPI 限流**
- **旧通道 22443** 仍可用（`node .dsh-ssh/exec.js`，`ssh -i /home/lenovo/.ssh/new.pem -p 22443 ubuntu@43.172.85.76`）但连续 2-3 次即被 RST，仅低频兜底；22 端口已废弃（路径级封锁，不可修）
- SCP 上传：`scp -i /home/lenovo/.ssh/new.pem -P 22443 -r <本地> ubuntu@43.172.85.76:<远程>`
- gost 若偶发卡死（forward+ws 连接泄漏，症状=ws 隧道 up 但 SSH 握手失败），VNC `sudo systemctl restart warp-proxy-gost` 即恢复
- Docker 已安装（docker.io + docker-compose-v2），工作目录 `/opt/`；旧 VPS `186.241.75.127` 已废弃

## 控制面常用命令

- DB：`sudo docker exec image-control-postgres psql -U image_control -d image_control -c "<SQL>"`（VPS 上）
- 容器状态：`sudo docker ps -a --format '{{.Names}} | {{.Status}}'`
- adobe2api 容器无 curl/wget，容器内探测用 python3 urllib
- **rebuild 控制面后必 restart imagesite-nginx**；改闸门必同步 VPS
- 中控已换血 new-api（2026-08-27/28）：记账/闸门/退款问题先读记忆 `control-plane-billing-paradigm`（唯一权威）与 `control-plane-newapi-surgery`

## 生图"卡"完整根因与修复（2026-08-19/20 彻查+修复+真图验证）

### 根因链（FACT，全部实测）

1. **表层**：adobe2api 容器健康端点是 `/api/v1/health`（200），但控制面 `adobe-health.ts` 默认 healthPath="health" 且曾配错路径 → 健康检查失败
2. **核心**：adobe2api health 新响应结构 `{status:"ok", accounts:[{auto_refresh_count, active_token_count, healthy}]}` 与 `adobe-health.ts` 解析的旧字段（顶层 `token_source`/`refresh_status`/`expires_at`）**不匹配** → account 永远判 `token_source=空、refresh_status=failing、health=degraded`
3. **放大**：scheduler `acquireSupplierLease` 的 adobe2api 门禁要求 `token_source='auto_refresh' AND refresh_status='healthy' AND credential_expires_at > now()+2min AND health_observed_at > now()-2min AND success_rate_5m>=0.8` → adobe2api 永不被选中 → gpt-image-2 任务全部 `capacity_saturated`（870 个任务 0 成功，诊断误报"all healthy"因为诊断的 notCooling 查询不含 token 门禁，与 acquire 不一致）

### 修复（已生效并出真图）

- 改 `src/lib/generation-core/adobe-health.ts`：兼容两代响应结构——顶层 status=="ok" → refresh_status=healthy；accounts 里有 `auto_refresh_count>0 且 healthy` → token_source=auto_refresh；有 active_token_count → 视为未过期；accounts 全空或任一 healthy → anyHealthy
- healthPath 保持 `http://adobe2api:6001/api/v1/health`（Docker 内部直连，worker 同网 imagesite_imagesite，可达）
- 同步到 VPS `/opt/image-control-plane/app` 后 `docker compose -f control-plane-compose.yml build + up -d generation-worker` 重建
- 验证：account 变 `auto_refresh/healthy/healthy`，B 端 key 提交 gpt-image-2 任务 succeeded，出图 1024x1024 PNG（1.1MB，endpointLabel=adobe2api，sha256 匹配）

### capacity_saturated 诊断顺序（下次直接抄）

① 查 supplier_lease 残留 → ② 查 supplier_account 的 token_source/refresh_status/health → ③ 查 adobe2api 容器真实 health 路径（容器内 `python3 urllib` 探测各路径）→ ④ 对照 adobe-health.ts 解析字段。诊断查询必须与 acquireSupplierLease 的 token 门禁一致，否则误报 all healthy。

## agent 网关 CORS 拦截（2026-08-20 修复）

- **症状**：浏览器从 `https://www.eimu.dev` 请求 `store.tinchak0207.xyz/agent/v1/sessions/*/events`（SSE 会话事件流）被 CORS 拦截（无 Access-Control-Allow-Origin）
- **根因**：agent 网关（VPS `/opt/agent-harness/gateway/index.ts`，systemd agent-gateway，端口 8081，nginx `/agent/` → `host.docker.internal:8081`）的 CORS 白名单默认 `https://image.tinchak0207.xyz`，`CORS_ORIGINS` 环境变量未配置 → `www.eimu.dev`/`eimu.dev` 不在白名单 → corsOriginFor 返回 null → 无 CORS 头
- **修复**：`/opt/agent-harness/.env` 追加 `CORS_ORIGINS="https://image.tinchak0207.xyz,https://eimu.dev,https://www.eimu.dev"`，`systemctl restart agent-gateway`
- **验证**：OPTIONS/GET 均返回 `access-control-allow-origin: https://www.eimu.dev`（含 allow-methods/headers/max-age/vary: Origin）
- **排障要点**：网关 index.ts 的 `corsOriginFor`（2492 行）/`corsHeaders`（2502 行）；`.env` 有 10 个键（OPENCODE_SERVER_PASSWORD/HARNESS_API_KEY/GROQ_API_KEY 等），修改前先 `cp .env .env.bak-*`
- **CORS 修复补完（SSE 200 路径）**：仅配 CORS_ORIGINS 不够——`openEventStream`（gateway index.ts 587 行）的 SSE 响应头**硬编码**（Content-Type/Cache-Control/X-Accel-Buffering/Connection），**不经过 corsHeaders()**，导致 200 事件流仍无 CORS 头（401/JSON 路径反而有）。修复=函数签名加 `req?: Request`，headers 合并 `...corsHeaders(corsOriginFor(req?.headers.get("origin") ?? null))`，两个调用点（handleEventStream 1344、ticket 路径 2636）传 req。改完 `bun build index.ts` 语法检查 + `systemctl restart agent-gateway`
- **SSE 端到端验证法**（无需用户侧 ticket）：用 B 端 key `POST /agent/v1/sessions` 建测试 session → `POST /agent/v1/sessions/:id/sse-ticket` 签发 ticket → `GET .../events?ticket=X` 带 Origin 头，看 200 + `access-control-allow-origin` + `event: connected` 流内容；测完 DELETE 清理
- **判别新旧错误**：用户贴的 CORS 错误若 ticket 值与上次完全相同，多为修复前的旧日志；以实测 200 SSE 路径为准

## agent 会话 404 "session not found"（2026-08-20 修复）

- **症状**：浏览器 console `Failed to load resource: /api/agent/sessions/<id> 404`（资源加载失败格式，多为 DELETE 清理旧会话时）
- **根因**：网关 session 存在**内存 Map**（index.ts `sessions`），`getOwnedSession` 按 key 隔离且**进程重启即全丢**——任何 `systemctl restart agent-gateway`（如 CORS 修复部署）都会让所有已创建 session 变 404。前端"开新会话"（discardAndStartNew）best-effort 清理旧存档 → DELETE 已回收 session → 网关 404 → 站点透传 → console 噪音
- **修复**：站点 `src/app/api/agent/sessions/[id]/route.ts` DELETE 幂等化——网关 404 且 `code==="not_found"` 时返回 `200 {success:true, already_gone:true}`（目标已不存在=删除成功），其他 4xx/5xx 原样透传
- **验证**：`route.test.ts` 12/12 通过 + tsc 无错 + `vercel --prod` 部署
- **排障要点**：`journalctl -u agent-gateway` 看 session created 时间线对照重启时间（`systemctl show agent-gateway --property=ActiveEnterTimestamp`）；DELETE 幂等化只吞 not_found。**（2026-09-28 更新）session 已持久化到 `/opt/agent-harness/agent-gateway.db`（`persistence.ts`），`getOwnedSession` 内存 miss 时 `hydrateFromDb`，网关重启不再让 session 404；上面「内存 Map、重启全丢」只是 08-20 当时的事实**

## agent 模型註冊表：加/換底層模型 SOP（2026-08-29 治本）

**唯一真源 = `/opt/agent-harness/agent-models.json`**（VPS）。加/換 agent 聊天模型 = 改這一個檔 + 跑兩條命令，禁止再手改 `opencode.json` 的 provider 或 gateway 硬編碼（那些現在是生成產物/回退默認）。

- **檔案職責**：`agent-models.json`（providers + bindings: default/small_model/persona/fallbacks）；`/opt/agent-harness/gateway/gen-opencode.ts`（registry → 生成 `workspace/.opencode/opencode.json` 的 provider/model/small_model 三鍵，**deny 表等其餘鍵原樣保留**；`--check` 驗漂移）；`/opt/agent-harness/verify-models.ts`（逐模型實彈 ping 出全表）；gateway `personaModel()` 讀 registry（缺檔回退內聯默認，行為=08-29 遷移前）+ 抖動重試 attempt≥2 按 `bindings.fallbacks[persona]` 換模型（鏈取 `chain[(attempt-1) % len]`）
- **加模型 5 分鐘配方**：
  ```bash
  SSHBIN=/var/lib/flatpak/runtime/org.freedesktop.Platform/x86_64/25.08/bd44a6230581917d04f89812a4c21090c304d390edb73995af1c2f9fd8abf4e8/files/bin/ssh
  $SSHBIN -i /home/lenovo/.ssh/new.pem -p 22443 ubuntu@43.172.85.76
  # ① agent-models.json 的 providers 加一段（npm=@ai-sdk/openai-compatible + baseURL + apiKey + models；模型級選項如 reasoningEffort 寫在該 model 的 options，**opencode 1.18 variants 不透傳 options 的坑仍在**）
  # ② bindings.persona / fallbacks 指到 "provider/model"
  cd /opt/agent-harness && ~/.bun/bin/bun verify-models.ts        # ③ 實彈驗證新模型活著
  ~/.bun/bin/bun gen-opencode.ts                                   # ④ 生成 opencode.json
  sudo -n systemctl restart opencode-server agent-gateway          # ⑤ 生效
  ```
- **failover 語義**：turn 零正文抖動重試時，attempt 2 起換 fallback 鏈上的模型（跨 provider，防「主/備同源全死」復發）；registry 異常 = 鏈只剩主模型（行為退回現狀，不會更壞）。N1 redrive 路徑始終用主模型。
- **坑位**：改 registry 後 `gen-opencode.ts --check` 有漂移屬正常（你剛改的），生成後重啟即收斂；opencode.json 手改會被下次生成沖掉——deny 表調整要改 gen-opencode.ts 的保留邏輯之外那份現檔（生成器不碰 permission 鍵，手改 permission 安全）。**特別提醒：必須同時重啟 `opencode-server` 與 `agent-gateway` 雙服務（步驟 ⑤）**——若只重啟 opencode-server，gateway 的 `/event` SSE 連線會死鎖/懸掛長達 4 分鐘（直到底層 fetch 逾時前收不到任何 delta 幀），導致前端完全看不到思考與正文、誤判「過程被隱藏/卡在正在思考」、watchdog 誤判零文本引發重複重發。**（2026-09-28 根因與修復）**懸掛是 `opencode-client.ts` 的 `/event` fetch 沒有看門狗、要等 Bun 預設逾時（journal 實錘 5 分鐘）；已加 30s 無位元組即 abort 重連（opencode 每 ~10s 發 `server.heartbeat`）。該修復部署到 VPS 後，只重啟 opencode-server 最多 ~32s 盲窗，雙服務綁定重啟不再必要。

## Adobe2API 定向排障附加规则

- 不从 HTTP 408 推断 scope/token 问题；该诊断只留给直接 401/403、`invalid_ims_scope`、`x-access-error` 或 claim 证据。完整方法论见 skill `adobe2api-direct-debugging`（含 2026-08-22 适用范围前置判断：该 skill 是修复型纪律，能力建设任务不适用）
- Adobe2API 是目标时：先追直接请求与上游响应，再动鉴权/路由；不改不动 relay 服务

## OpenAI 同步兼容层（/openai/v1）在控面的部署依赖（2026-09-28 实锤）

**症状**：`POST https://eimu.dev/openai/v1/images/generations` 回 `503 {"code":"control_plane_unreachable"}`，耗时约 1 秒（立刻失败，不是等超时）。

**根因**：`src/lib/openai-compat/generation.ts` 的提交/轮询默认打「当前请求自己的 origin + `/api/v1/*`」——那是**站台（Vercel）拓扑**：Vercel 上 `/api/v1/*` 被 `beforeFiles` 代理到控面。但同步层现在跑在控面自己身上，控面那份 app 的对应路径在 `/image-control/api/v1/*` 底下（nginx `location ^~ /image-control/` rewrite 掉前缀），`+ /api/v1/*` 落不到任何 route。

**修法（部署配置，非代码）**：控面 `control-plane-compose.yml` 的 `generation-api` 服务 `environment:` 里加

```yaml
      OPENAI_COMPAT_GENERATION_ORIGIN: http://127.0.0.1:3000
```

然后只重建 api：`sudo docker compose -f control-plane-compose.yml up -d generation-api`（`docker exec image-control-api printenv OPENAI_COMPAT_GENERATION_ORIGIN` 可验证）。备份档：`control-plane-compose.yml.bak-0928-openai-origin`。旋钮的语义写在 `resolveGenerationOrigin()` 的注释里，代码侧不需要改。

**同类判据（下次先查这个）**：任何「站台上跑得好、搬到控面就 503/404」的路由，第一件事是看它内部 HTTP 调用的 path 有没有带 `/image-control` 前缀——站台靠 `beforeFiles` 代理补前缀，控面不会。

**同一轮的其他两条部署事实**：
- 段配置 `export const maxDuration` **只能是字面量**：写成 `= SOME_CONST` 会让 Next 抛 `Unknown identifier ... at maxDuration` 并炸掉整个 build（`tsc` 与单测全绿也抓不到，只有真 build 会爆）。
- 本项目 Vercel 是 **Hobby**（函数硬上限 60s）⇒ 同步等待类路由不放 Vercel，放控面（无时长上限，且能读 `GENERATION_DATABASE_URL` 让熔断/断供闸真生效）。
