# agent-poller

生产常驻轮询程式（VPS `agent-poller.service`）：接收 gateway/agent 工具注册的
生成任务，代替「fire-and-wait」把它轮询到终态，再回推事件与人话给 session。

## 为什么这里才有真源（历史，具名记录）

**这个程式过去没有 repo 真源、没有任何部署文件。** 它只存在于 VPS 的
`/opt/eimu-harness/poller/index.ts`，不在任何 git 仓库里：

- `grep -rln "pendingTasks\|POLLER_REGISTER_PORT" .` 无命中
- `git log --all -- '*poller*'` 无命中
- `docs/` 与 `deploy/CHECKLIST.md` 也没有任何 poller 部署说明

正因为没有真源，一个致命 bug 得以在生产存活至今（2026-10-02 修）：poller 对
**所有** kind 都无条件发 `image.done`（成功事件名写死）。影片成品是 .mp4，被推成
`image.done` 后前端把它塞进 `<img>`，卡片变破图、成品永远不会正确弹出。
**这才是本轮真正修好的那一半**：成功事件名由 `image.done` 改为 `video.done`
（`doneEventFor(kind)`，影片另带 `media_kind:"video"`）。

> **根因更正（2026-10-02；原假设已推翻）。** 本档与 `media-endpoints.ts` 曾记载
> 「影片 job id **不在 images 命名空间**，所以每轮 404」。此说法**已被现场推翻**：
> - `src/app/api/v1/images/[id]/route.ts:45` 与 `src/app/api/v1/videos/[id]/route.ts:24`
>   呼叫的是**同一个** `getGenerationJobForTenant(id, 'biz:'+key.id)`；
> - `src/lib/generation-core/job-repository.ts:200-202` 的查询是
>   `SELECT * FROM generation_job WHERE id = ? AND tenant_id = ? LIMIT 1`，
>   **没有任何 kind 过滤**；
> - 因此 `/v1/images/{影片id}` 对**拥有该 job 的同一把 key** 一样回 200。真正的
>   404 来源是 **tenant 不匹配**（换了 key／用了 fallback 的 `HARNESS_API_KEY`），
>   不是命名空间。生产 nginx access log 佐证：旧码对 video-kind 任务打
>   `/v1/images/<id>` 得到过 200。
>
> 结论：poller 改走 `/v1/videos/{id}` 在现行站点实作下是 **no-op**（方向没错、
> 不是必要修复）。同 repo 的 `opencode-runtime/tools/image_get_result.ts`
> 那份「404 → 回落 `/videos/{id}`」同理，在现行站点下不会被触发（保留是为兼容
> 旧版站点）。**不要把命名空间当成 404 根因。**

**自本目录起，`deploy-staging/poller/` 是本程式的唯一真源。** VPS 上的
`/opt/eimu-harness/poller/` 是部署目标（活本），不是真源。任何对 poller 的修改
都必须改这里、测试、提交，再部署。

## 档案

| 档 | 说明 |
|---|---|
| `index.ts` | 生产原文逐位元镜像 + 本次修复（见下） |
| `media-endpoints.ts` | 纯函式：kind → 轮询路径 / kind → 终态事件名 |
| `package.json` | 与生产逐位元相同（`bun run index.ts`，无依赖） |
| `media-endpoints.test.ts` | `media-endpoints` 的变更探针（非行为验收） |

## 本次修复（仅四处 + 一行 import）

1. `pollTask` 的 URL 改用 `pollPathFor(task.kind, task.task_id)`：影片走
   `/v1/videos/{id}`，不再所有 kind 都打 `/v1/images/`。**更正（2026-10-02）：
   这一改在现行站点是 no-op**——两端点共用同一条 tenant-scoped 查询、无 kind
   过滤（见上方根因更正），方向正确但非必要修复；保留是为语义清晰与对旧版站点兼容。
2. **本轮真正有效的一处**：成功分支事件名改用 `doneEventFor(task.kind)`（影片发
   `video.done`，图片维持 `image.done`）；影片带 `emitData.media_kind = "video"`
   （图片不带）。旧码对影片也发 `image.done`，会让 .mp4 被前端塞进 `<img>` 变破图卡。
3. refunded 文案：`kind === "video"` 时「这张图」→「这部影片」。
4. 逾时文案：同上。

其余（token bucket 容量 5 / 54rpm、dedup、watchdog 60s、register server
127.0.0.1 无鉴权、12/30 分钟 lifetime、`resolveKey`、`hashId`、`resumeSession`）
一律逐位元保留。

## 部署配置（实查生产，非猜测）

- **service**：`agent-poller.service`（`systemctl cat` 实查）
  ```
  User=ubuntu
  WorkingDirectory=/opt/eimu-harness/poller
  EnvironmentFile=/opt/eimu-harness/.env
  ExecStart=/home/ubuntu/.bun/bin/bun run index.ts
  Restart=always
  RestartSec=5
  After=network.target agent-gateway.service
  ```
- **监听埠**：`POLLER_REGISTER_PORT` **8082**（`.env` 实设 8082；`index.ts` 预设亦 8082），
  只绑 `127.0.0.1`（无鉴权，禁止对外）。实查：`ss -tlnp | grep 8082` → `127.0.0.1:8082 bun`。
- 其他环境变数：`POLLER_TICK_MS=4000`、`GATEWAY_URL=http://127.0.0.1:8081`。

## 部署命令

```bash
cd /home/user/Desktop/image-app
bash .pixai-refresh/start-ssh443.sh   # 幂等，确保 SSH-over-443 隧道在

# 推送真源三档到生产（目标目录 owner 为 ubuntu，无需 sudo）
for f in index.ts media-endpoints.ts package.json; do
  node .dsh-ssh/exec-443.js "echo $(base64 -w0 deploy-staging/poller/$f) | base64 -d > /opt/eimu-harness/poller/$f"
done

# 重启并看状态
node .dsh-ssh/exec-443.js "sudo systemctl restart agent-poller && systemctl status agent-poller --no-pager | head -12"
```

## 验证

```bash
# 服务在跑且无 crash-loop
node .dsh-ssh/exec-443.js "systemctl status agent-poller --no-pager"
# 轮询注册埠（pending 清单）
node .dsh-ssh/exec-443.js "curl -s 127.0.0.1:8082/"
#   预期：{"pending":N,"tasks":[...]}
# 近期日志
node .dsh-ssh/exec-443.js "sudo journalctl -u agent-poller -n 50 --no-pager"
```

**真正的行为验收**（由 orchestrator 在生产做）：拿一个**既有已成功的影片 job**
（免费、不重新生成）注册进 poller，确认 poller 发出 `video.done`
（含 `media_kind:"video"`）而非 `image.done`。（更正 2026-10-02：不要以「不再 404」
为验收点——对同一把 key，`/v1/images/{影片id}` 与 `/v1/videos/{影片id}` 都会回 200。）

## 版本控制注意

`.gitignore:150` 有 `/deploy-staging/*`，本目录预设被忽略。要让本真源入库，
需比照 `gateway/`、`vps-tools/`、`opencode-runtime/` 的既有例外，加一行：

```
!/deploy-staging/poller/
```

（本档建立时未改 `.gitignore`，留给 orchestrator 于提交前处理。）
