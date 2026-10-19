# Eimu 架构总览

Eimu 是一个以 Agent 驱动的 AI 创作工作台：自然语言进来，画布上铺开图、视频、音乐与 3D 节点的生产链，任务在后台异步执行，失败可单点重跑，所有消耗进入同一本账。

本文只描述公开仓库里的代码结构与运行边界，不包含部署凭据、运营商账号或任何第三方私有配置。

## 1. 运行时拓扑

```
Browser / API client / MCP client
        │
        ▼
Next.js App Router (src/app)
  ├── 页面与组件 (src/components, src/hooks)
  ├── 分发 API: /api/v1, /openai/v1, /api/mcp
  └── 服务端编排: src/lib
        │
        ├──► Generation control plane (Postgres)
        │      jobs / attempts / billing ledger / callbacks / artifacts
        │            │
        │            └──► Worker (worker/generation-worker.ts)
        │                     └──► Supplier adapters ──► upstream providers
        │
        ├──► Agent gateway (deploy-staging/gateway)
        │      ├── 会话、工具调用、SSE 事件
        │      ├── 画布写入闸门与工作流执行
        │      └── 记忆、检索、子代理调度
        │
        └──► Agent runtime tools (deploy-staging/opencode-runtime)
               工具实现 + Skill 语料 + 供应商桥接

Artifact store (Vercel Blob 或兼容对象存储)
Desktop device bridge (desktop/ ↔ 本机执行器)
```

## 2. 平面划分

系统按三个平面组织，避免“加一条供给”牵动整个站点：

| 平面 | 职责 | 代码位置 |
| --- | --- | --- |
| 供给（Supply） | 上游协议、鉴权、账号池、健康与额度、能力声明 | `src/lib/generation-core/*-upstream.ts`、`src/lib/supplier-*`、`src/lib/provider-*` |
| 生产（Production） | 任务生命周期、调度与租约、重试与补偿、失败分类、产物落地、计费 reserve/commit/refund | `src/lib/generation-core/` |
| 分发（Distribution） | 页面、OpenAI 兼容层、B 端 API、MCP、Webhook | `src/app/`、`src/lib/openai-compat/`、`mcp-server/` |

依赖方向固定为：分发 → 生产门面 → 供给。生产核心不 import `next/server`，供给适配器不 import 计费与任务仓库。

## 3. 任务生命周期

```
pending_billing → queued → leased → submitting → running
                                      │            │
                                      │            ├─► succeeded
                                      │            ├─► failed
                                      │            └─► cancelled → refunded
                                      └─► retry / failover
```

关键不变量：

- **先预留、后执行、再结算**。`billing-ledger` 以 reserve / commit / refund 三段式记账；没有成功产物不 commit。
- **幂等**。提交侧支持 `Idempotency-Key`；重复请求复用同一任务，不重复扣费。
- **租约与回收**。worker 以 lease 领取任务，租约过期由调度器回收，避免进程崩溃留下永久 `running`。
- **回调不丢**。上游回调先写 `callback_outbox`，由独立消费者重试，超过窗口进入死信队列。
- **账本 append-only**。事件表只增不改；`job_events` 用于审计与对账。

主要模块：

| 模块 | 作用 |
| --- | --- |
| `command-service.ts` | 提交入口：参数校验、幂等、预留额度、建任务 |
| `job-repository.ts` | 任务与尝试的持久化 |
| `scheduler.ts` | 选择可执行任务、分配租约 |
| `worker-service.ts` | 领取任务、调用供给、推进状态 |
| `billing-ledger.ts` | reserve / commit / refund 与余额投影 |
| `failure-classifier.ts` | 把上游错误归入可决策分类 |
| `artifact-service.ts` | 产物登记、去重、回收 |
| `callback-outbox.ts` | 回调可靠投递 |
| `provider-reconciliation.ts` | 上游账单与本地账本对账 |

## 4. 画布与工作流

画布有两层真相，边界明确：

- **world1（画布状态）**：`src/lib/canvas/`。`types.ts` 定义 `CanvasAgentOp`，`reducer.ts` 是执行语义的唯一归属，`layout.ts` 负责节点与 metadata 的白名单清洗。
- **world2（产线模板）**：`deploy-staging/gateway/workflow-templates/`。模板描述一次多步生产要跑哪些节点、用什么模型与门禁。

Agent 不直接改画布对象，而是输出 `WorkflowDslSource`，由 `src/lib/workflow-dsl/compile.ts` 确定性编译成 op；`decompile.ts` 支持回读，保证 round-trip 幂等。非法值按“省略该键、不动该栏”处理，不写入猜测值。

事件通道：

```
agent tool ──► canvas_apply_ops ──► SSE canvas.ops ──► 前端队列 ──► reducer
```

## 5. Agent 层

`deploy-staging/gateway` 是会话与工具网关，`deploy-staging/opencode-runtime` 是工具实现与技能语料。

工具按域分组：

- 画布：`canvas_get_state`、`canvas_apply_ops`、`canvas_create_generation_flow`、`canvas_generate_image`
- 生成：图片、视频、音乐、TTS、放大、报价
- 资产：上传、检索、登记、校验、角色卡与场景卡
- 工作流：编译、写入、历史、回滚
- 记忆：检索、写入、批量导入
- 协作：子代理派遣、提问、恢复

网关侧的门禁负责：会话空闲时检查画布是否已写入、付费动作是否符合已授权的预算、设备桥调用是否具备对应权限。所有拒绝都要给出可执行的下一步，而不是静默失败。

## 6. 数据与存储

| 数据 | 位置 |
| --- | --- |
| 用户、团队、订阅、额度 | 站点数据库 / 上游账户系统 |
| 生成任务、尝试、事件、账本 | `GENERATION_DATABASE_URL`（Postgres） |
| 会话与 Agent 状态 | `SESSIONS_DB_PATH`（SQLite 或 Postgres，按部署配置） |
| 产物文件 | `BLOB_READ_WRITE_TOKEN` 指向的对象存储 |
| 迁移 | `db/migrations/`，按编号顺序执行 |

迁移文件是 schema 的唯一真源。新增字段必须同时更新迁移、写入路径和读回路径。

## 7. 部署形态

公开仓库提供三种部署入口：

- **Vercel / Node 单体**：`next build` 后由 `next start` 提供服务，适合前端与同步 API。
- **Docker Compose**：`deploy/vps/` 提供 control plane、worker、Postgres、反向代理的模板。
- **分离式**：Next.js 站点、generation worker、agent gateway、agent runtime 各自独立进程，通过 HTTP/SSE 连接。

具体步骤见 [SELF-HOSTING.md](SELF-HOSTING.md)。

## 8. 目录导航

```
src/app/                  Next.js 路由与 API
src/components/           页面与画布组件
src/hooks/                客户端状态与 SSE
src/lib/canvas/           画布契约、reducer、布局
src/lib/workflow-dsl/     工作流 DSL 编译与回读
src/lib/generation-core/  生产平面
src/lib/openai-compat/    OpenAI 兼容层
deploy-staging/gateway/   Agent 网关
deploy-staging/opencode-runtime/  Agent 工具与技能
db/migrations/            Postgres schema
desktop/                  桌面端与设备桥客户端
mcp-server/               MCP 服务端
deploy/                   Docker、Nginx、systemd 模板
tools/                    运维与迁移脚本
```

## 9. 设计约束

- 任何客户端可达的代码不得包含内部渠道标识或凭据；provider 键使用中性值。
- 密钥只从环境变量读取，仓库不保存任何可用凭据。
- 付费动作必须有预算与授权来源；没有明确授权时先询问。
- 产物与账本以服务端账号 ID 归属，客户端缓存不作为归属依据。
- 失败必须可解释：错误分类、尝试记录、对账结果都要能被外部读到。
