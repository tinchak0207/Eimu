<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Time discipline (user-mandated 2026-08-02, applies to EVERY new session)

Golden time only: decide what to change → edit code → deploy → write memory pointer.

Garbage time. Minimize ruthlessly. NEVER perform:
- **No self UI checks.** The user owns aesthetics. Dev server / Playwright / screenshots to verify layout, ratios, or appearance = garbage. Finish the edit, deploy, and let the user look.
- **No self-invented helper scripts/tools** (deploy/check scripts, etc.) unless the user explicitly names them.
- **Cooking order:** do non-waiting work first (rules, memory, local edits), waiting work LAST (deploy, long verifications, external calls). Deploy is always the final step.
- **Stop guessing:** after 3 reads/probes without producing a code change, ask the user one question. Never guess-screen sizes, states, or intentions from files.
- **Grep-first for research:** locate evidence with targeted grep/ripgrep, do NOT full-read large files (>200 lines) unless the task requires holistic understanding. Full-read pollutes context and is slower than 3 greps.
- **No self-narration:** never output lines like "I will now read...", "analysis complete". Output decisions, evidence, and results only.
- **Never re-run a completed closed loop** ("run it again to see").
- **Memory discipline:** every finished usable tool, solved recurring problem, or user-corrected behavior MUST be written to memory the same session (`/home/lenovo/.codex/memories/extensions/ad_hoc/notes/` note + `memory_summary.md` update). Not writing it = intelligence reset next session.
- **Harness iteration loop (2026-08-02):** when the user reports a harness effect (time still being wasted, a rule not taking effect), fix the corresponding rule/flow IMMEDIATELY, before any other work, same session. Every user report is one compression.
- Respond in Traditional Chinese; run commands with bash syntax (this machine is Arch Linux since 2026-08-17; PowerShell/Windows paths are legacy and wrong).

## First-principles mainline

- Define the final user outcome, primitive system, dominant bottleneck, highest-leverage action, and proof before using project workflows.
- Skills and checklists are subordinate tools; skip any ritual that does not change a mainline decision.

## Coding execution rule

- **Delegate coding to subagents.** Any code change task with 2+ files, or a single file > 50 lines of diff, MUST be dispatched to a subagent. The orchestrating agent only: identifies the target files, writes the diff spec, dispatches, then collects and verifies.
- The orchestrator never writes code directly when a subagent can do it in parallel or independently.
- If only one small targeted edit is needed (< 5 lines, single file), the orchestrator may apply it inline to avoid the spawn overhead.

## Verification rule

- Never intentionally run a test that is expected to fail.
- Implement the change first, then run only verification that is expected to pass.
- If a verification fails unexpectedly, diagnose it, fix the cause, and rerun it; do not create a deliberate red-test phase.
- When the user explicitly takes over visual verification after a production push, stop after the Vercel deployment is READY and the production alias is confirmed. Report visual verification as pending user acceptance; do not continue browser automation or claim that the visual result was verified.
- When Adobe2API is the target, trace its direct request and upstream response before changing authentication or routing; do not modify or restart relay services.
- Do not infer a scope or token failure from HTTP 408. Reserve that diagnosis for direct 401/403, `invalid_ims_scope`, `x-access-error`, or claim evidence.

## Authentication rule

- Never use a headless browser or automation-marked Chromium for Adobe, Google, or similar interactive identity authentication.
- If an identity provider reports that the browser or app may not be secure, stop that browser path immediately and use a standard user-controlled Chrome session.
- Resume automation only after user-controlled authentication completes. Never expose passwords, OTPs, cookies, or access tokens in logs or task output; store tokens only in the application's intended token store.
- Do not replay stale IMS authorization URLs containing dynamic state or device context.
- Production must not depend on an open Chrome tab. Chrome is bootstrap/recovery only; normal Adobe2API renewal must come from an enabled server-side refresh profile and active `auto_refresh` token.
- Never schedule Chrome memory/process scanning as the production renewal path. Keep browser token extraction manual and preserve the last working renewable server token until its replacement is accepted.

## Product decision doctrine

- Start from friction observed in the real creation workflow, not from a generic feature inventory. Name the affected user, task stage, blocked outcome, and observable evidence before proposing work.
- Treat the professional workspace as a task-state machine. Allocate attention and screen space according to whether the user is preparing, generating, reviewing, or reusing an asset; do not keep every panel equally prominent at all times.
- Readability, comprehension, and reliable operation outrank fitting everything into one viewport. Preserve visual quality, but never use beauty or zero-scroll as a reason to shrink text, targets, previews, or feedback below comfortable use.
- Remove duplicate mental models before adding another surface. If two modules transform substantially the same fields, merge them behind one authoritative entry and preserve undo rather than teaching two names for one action.
- UI claims must match real capability. Do not label plain prompt concatenation as regional editing, expose decorative percentages as real control, or imply an upstream/model path is available without generation evidence.
- Prefer closed loops over isolated features: an action should lead to a visible result, a recoverable state, and the next reuse action without making the user hunt across queue, canvas, gallery, and history.
- Convert repeated manual intervention into an interface or state transition only after the decision is stable. Automate deterministic work; keep ambiguous visual judgment with the user when they explicitly own final acceptance.
- Search for and extend the existing owner of state, persistence, billing, model capability, or UI responsibility. Do not create a second queue, history store, capability catalog, or task system without an explicit migration plan.
- Rank product work by expected movement of the user outcome per unit of time, implementation risk, operational risk, and future reuse. Feature count and architectural novelty are not value.
- State important beliefs as `FACT`, `INFERENCE`, or `HYPOTHESIS`. Each accepted issue must name the dominant bottleneck, smallest useful intervention, acceptance evidence, and what remains out of scope.
- Verification depth is a product decision. Use expected-pass contract tests, type checks, and production builds by default; add browser automation only when its result can change a decision. If the user takes over visual acceptance, report it as pending and stop after the agreed deploy boundary.
- When implementation is requested and expected-pass gates succeed, Image Studio changes default to production deployment unless the user explicitly limits the task to research, planning, documentation, or local-only work.

## B 端 API 密钥位置（2026-08-19 用户签发，仅此一把不再签发）
- 明文密钥文件：`.env.biz-key`（权限 600，`.gitignore` 的 `.env*` 已覆盖，不进 git）
- 用途：调 `https://image.tinchak0207.xyz/v1/*`（B 端 OpenAI 兼容端点），`Authorization: Bearer sk-biz-...`
- 丢失/泄露只能吊销重签——用户明确不会再签发下一把，务必保管

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
### 排障秘诀（下次直接抄）
- **VPS 访问（2026-08-21 起主用 SSH-over-443）**：`bash .pixai-refresh/start-ssh443.sh`（幂等启动本地隧道）→ `node .dsh-ssh/exec-443.js "<命令>"`。链路：本机 127.0.0.1:22222 → ws 隧道 → `wss://store.tinchak0207.xyz/ssh` → nginx `/ssh` → gost `forward+ws://0.0.0.0:18083/127.0.0.1:22`（VPS systemd warp-proxy-gost，0.0.0.0 监听因 nginx 容器经网关 172.20.0.1 访问，UFW 已放行 172.16.0.0/12→18082/18083）→ sshd。**443 永通，连续 5 连间隔 1s 稳定，完全免疫 ISP 对 SSH 端口的 DPI 限流**。旧通道 22443 仍可用（`node .dsh-ssh/exec.js`）但连续 2-3 次即被 RST，仅低频兜底；22 端口已废弃（路径级封锁，不可修）。gost 若偶发卡死（forward+ws 连接泄漏，症状=ws 隧道 up 但 SSH 握手失败），VNC `sudo systemctl restart warp-proxy-gost` 即恢复
- **控制面 DB**：`sudo docker exec image-control-postgres psql -U image_control -d image_control -c "<SQL>"`（VPS 上）
- **容器状态**：`sudo docker ps -a --format '{{.Names}} | {{.Status}}'`
- **capacity_saturated 诊断顺序**：① 查 supplier_lease 残留 → ② 查 supplier_account 的 token_source/refresh_status/health → ③ 查 adobe2api 容器真实 health 路径（容器内 `python3 urllib` 探测各路径）→ ④ 对照 adobe-health.ts 解析字段
- **adobe2api 容器无 curl/wget**，容器内探测用 python3 urllib
### agent 网关 CORS 拦截（2026-08-20 修复）
- **症状**：浏览器从 `https://www.eimu.dev` 请求 `store.tinchak0207.xyz/agent/v1/sessions/*/events`（SSE 会话事件流）被 CORS 拦截（无 Access-Control-Allow-Origin）
- **根因**：agent 网关（VPS `/opt/agent-harness/gateway/index.ts`，systemd agent-gateway，端口 8081，nginx `/agent/` → `host.docker.internal:8081`）的 CORS 白名单默认 `https://image.tinchak0207.xyz`，`CORS_ORIGINS` 环境变量未配置 → `www.eimu.dev`/`eimu.dev` 不在白名单 → corsOriginFor 返回 null → 无 CORS 头
- **修复**：`/opt/agent-harness/.env` 追加 `CORS_ORIGINS="https://image.tinchak0207.xyz,https://eimu.dev,https://www.eimu.dev"`，`systemctl restart agent-gateway`
- **验证**：OPTIONS/GET 均返回 `access-control-allow-origin: https://www.eimu.dev`（含 allow-methods/headers/max-age/vary: Origin）
- **排障要点**：网关 index.ts 的 `corsOriginFor`（2492 行）/`corsHeaders`（2502 行）；`.env` 有 10 个键（OPENCODE_SERVER_PASSWORD/HARNESS_API_KEY/GROQ_API_KEY 等），修改前先 `cp .env .env.bak-*`
- **CORS 修复补完（SSE 200 路径）**：仅配 CORS_ORIGINS 不够——`openEventStream`（gateway index.ts 587 行）的 SSE 响应头**硬编码**（Content-Type/Cache-Control/X-Accel-Buffering/Connection），**不经过 corsHeaders()**，导致 200 事件流仍无 CORS 头（401/JSON 路径反而有）。修复=函数签名加 `req?: Request`，headers 合并 `...corsHeaders(corsOriginFor(req?.headers.get("origin") ?? null))`，两个调用点（handleEventStream 1344、ticket 路径 2636）传 req。改完 `bun build index.ts` 语法检查 + `systemctl restart agent-gateway`
- **SSE 端到端验证法**（无需用户侧 ticket）：用 B 端 key `POST /agent/v1/sessions` 建测试 session → `POST /agent/v1/sessions/:id/sse-ticket` 签发 ticket → `GET .../events?ticket=X` 带 Origin 头，看 200 + `access-control-allow-origin` + `event: connected` 流内容；测完 DELETE 清理
- **判别新旧错误**：用户贴的 CORS 错误若 ticket 值与上次完全相同，多为修复前的旧日志；以实测 200 SSE 路径为准
### agent 会话 404 "session not found"（2026-08-20 修复）
- **症状**：浏览器 console `Failed to load resource: /api/agent/sessions/<id> 404`（资源加载失败格式，多为 DELETE 清理旧会话时）
- **根因**：网关 session 存在**内存 Map**（index.ts `sessions`），`getOwnedSession` 按 key 隔离且**进程重启即全丢**——任何 `systemctl restart agent-gateway`（如 CORS 修复部署）都会让所有已创建 session 变 404。前端"开新会话"（discardAndStartNew）best-effort 清理旧存档 → DELETE 已回收 session → 网关 404 → 站点透传 → console 噪音
- **修复**：站点 `src/app/api/agent/sessions/[id]/route.ts` DELETE 幂等化——网关 404 且 `code==="not_found"` 时返回 `200 {success:true, already_gone:true}`（目标已不存在=删除成功），其他 4xx/5xx 原样透传
- **验证**：`route.test.ts` 12/12 通过 + tsc 无错 + `vercel --prod` 部署
- **排障要点**：`journalctl -u agent-gateway` 看 session created 时间线对照重启时间（`systemctl show agent-gateway --property=ActiveEnterTimestamp`）；会话进程重启即断是架构事实（内存 Map），若要持久化需另做；DELETE 幂等化只吞 not_found
