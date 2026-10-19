# 自托管指南

公开仓库包含完整的站点、生产控制面、Agent 网关、Agent 工具、数据库迁移与部署模板。你需要自备上游模型账号与对象存储；仓库不附带任何可用凭据。

> eimu.dev 是本项目的官方托管服务。自托管不会获得官方服务的额度、上游通道或运维支持。

## 1. 依赖

| 组件 | 版本 / 说明 |
| --- | --- |
| Node.js | 22.x（见 `.node-version`） |
| 包管理器 | npm（仓库含 `package-lock.json`；同时保留 pnpm workspace 配置） |
| Postgres | 16，用于生成控制面 |
| 对象存储 | 任何兼容 Vercel Blob 语义的存储；也可替换 `artifact-service` 的落地实现 |
| 反向代理 | Nginx / Caddy，需支持 SSE 长连接 |
| 可选 | Docker 24+，用于控制面与 worker |

## 2. 环境变量

```bash
cp .env.example .env.local
```

至少需要配置：

- `GENERATION_DATABASE_URL`：Postgres 连接串。
- `GENERATION_PROMPT_ENCRYPTION_KEY`：32 字节 base64 或 64 位 hex，用于提示词加密。
- `GENERATION_BILLING_RELAY_SECRET`：站点与计费中继之间的共享密钥。
- `BLOB_READ_WRITE_TOKEN`：对象存储写入令牌。
- 上游供应商密钥：按你实际接入的渠道配置，未配置的渠道不会参与路由。
- `GATEWAY_URL` / `GATEWAY_BASE_URL`：Agent 网关地址。

所有变量都可以在 `src/lib/` 与 `deploy-staging/` 中通过 `process.env.*` 检索到用途。**不要把真实值提交进仓库。**

## 3. 本地启动

```bash
npm install
npm run build
npm run start          # Next.js 站点与同步 API
npm run generation:worker   # 独立进程：领取并执行生成任务
```

首次启动前执行数据库迁移：

```bash
npx tsx tools/apply-migrations.ts --dry-run   # 预览
npx tsx tools/apply-migrations.ts             # 应用
```

迁移工具自带 advisory lock 与校验和，重复执行是安全的。控制面 worker 容器也可以运行 `npm run generation:bootstrap`，它会按“迁移 → 播种 → worker”的顺序自举。

健康检查：

```bash
npm run healthz
```

## 4. Docker Compose

`deploy/vps/` 提供三份模板：

- `docker-compose.yml`：站点、worker、账户系统与反向代理。
- `control-plane-compose.yml`：Postgres、控制面 API、worker。
- `control-plane.env.example`：控制面环境变量清单。

模板默认假设代码位于 `./app`，并且 `.env.production` / `.env.control-plane` 已按示例填好。复制模板后按你的目录结构修改 `build.context` 与卷路径。

```bash
cd deploy/vps
cp control-plane.env.example .env.control-plane
# 填入真实值后
docker compose -f control-plane-compose.yml up -d --build
```

生产环境建议：

- 只让反向代理暴露 80/443，Postgres 与账户系统只监听回环地址。
- 给 Next.js、worker、网关分别配置内存上限与重启策略。
- 产物目录与数据库卷设置保留策略；磁盘写满会导致持久化降级。
- 在低配机器上把构建放到 CI 或另一台机器，生产主机只接收预构建产物。

## 5. Agent 网关与工具

`deploy-staging/gateway` 是 Agent 会话与工具网关，`deploy-staging/opencode-runtime` 是工具实现与 Skill 语料。

- 网关通过 `GATEWAY_URL` 被站点调用，使用 SSE 推送 `turn.*`、`canvas.*` 等事件。
- 工具实现依赖 `HARNESS_INTERNAL_TOKEN` 等内部令牌；请自行生成高强度随机值。
- Skill 目录是纯文本语料，不含凭据；新增技能不需要重新构建站点。
- 桌面端通过设备桥连接本机执行器，权限模型在 `desktop/lib/bridge-credential.js` 与 `deploy-staging/gateway/device-bridge.ts`。

## 6. 供应商接入

供给适配器位于 `src/lib/generation-core/*-upstream.ts` 与 `src/lib/supplier-*`。接入新供应商的最小步骤：

1. 实现上游协议适配（提交、轮询/回调、错误映射）。
2. 在 supplier 注册表声明能力、并发、成本与健康检查。
3. 跑 `npm run generation:seed` 播种能力，确保路由能选中它。
4. 用真实请求验证：提交、成功、失败、超时、取消、退款六条路径都要有回执。

仓库不包含任何上游账号、Cookie、Token 或代理池配置。

## 7. 升级

- 先跑迁移的 `--dry-run`，确认没有意料之外的 schema 变更。
- 控制面与 worker 必须使用同一份迁移版本；不要让 worker 带着半套 schema 运行。
- 发布前检查 `npm run ops:deploy-freshness`（按你的部署方式调整）。
- 回滚时同时回滚代码与数据库迁移；账本表只增不改，不要手工删除事件。
