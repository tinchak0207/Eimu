# D5：控面一键部署脚本（preflight＋双向 diff 闸＋版本化镜像＋回滚）（预期 60 分钟）

工作目录 `/home/lenovo/Desktop/image-app`。产出单一档 `deploy/vps/deploy-control-plane.sh`（bash，`set -euo pipefail`）。

## 必读记忆
- `~/.claude/memory/MEMORY.md`（Tier-0）＋ `~/.claude/memory/packs/infra-deploy.md`
- `~/.claude/memory/notes/2026-09-28-control-plane-mirror-port-and-verify-recipe.md`：控面座标、「md5 才是双向 diff 的机器化判准」、`force-recreate` 约 7 秒空窗
- `~/.claude/memory/notes/2026-09-28-control-plane-mirror-port-gap.md`：控面是无 git 的手搬副本
- `docs/runbooks/infra-debugging.md` 第 1-40 行（VPS 连线、rebuild 后必重启 imagesite-nginx）与 88-110 行（`OPENAI_COMPAT_GENERATION_ORIGIN` 部署依赖）
- 记忆与现场证据冲突时以现场为准，并在回报中写明冲突。

## 现场事实（orchestrator 09-28 实测）
- VPS：`ssh -i /home/lenovo/.ssh/new.pem -p 22443 ubuntu@43.172.85.76`；**22443 连续快速连线 2-3 次会被 RST** ⇒ 脚本必须用 SSH ControlMaster 多工（`-o ControlMaster=auto -o ControlPath=/tmp/cp-deploy-%C -o ControlPersist=120`），整次执行共用一条连线。
- 控面：`/opt/image-control-plane/`，compose 档 `control-plane-compose.yml`（**VPS 自有，含 secret，不入 git，脚本永不覆写它**），建置 context `app/`（无 git 的纯目录），容器 `image-control-api`／`image-control-worker`／`image-control-postgres`；镜像名 `image-control-plane-generation-api:latest`、`image-control-plane-generation-worker:latest`。所有 docker 命令要 `sudo`。
- VPS 根磁碟 59G 已用 94%（剩 3.7G）；worker 镜像 2.27GB。Docker 29.1.3（BuildKit 预设）。
- 目前 `app/Dockerfile`＝repo HEAD 的 `deploy/vps/Dockerfile`；`app/.dockerignore`＝repo HEAD 的 `.dockerignore`。

## 子命令
### `plan`（唯读，预设）
1. 来源＝**本机 git HEAD**，不是 working tree（working tree 有别人未提交的改动，不能部署出去）。`git archive HEAD` 取以下路径解到 tmp：`src public worker tools db bridge skills deploy-staging/expert-gateway deploy-staging/gateway package.json package-lock.json next.config.mjs next-env.d.ts tsconfig.json tailwind.config.ts postcss.config.mjs components.json`，外加 `deploy/vps/Dockerfile → Dockerfile`、`.dockerignore → .dockerignore`（与 `.dockerignore` 白名单一致；不存在的路径略过）。
2. 若上述路径在 working tree 相对 HEAD 有未提交改动 → 印警告并列出（不挡，因为部署的是 HEAD）。
3. `rsync -rlc --dry-run --itemize-changes`（**不带 --delete**，排除 `node_modules/`）走同一条 ControlMaster 连线，得出「VPS 新增」与「VPS 将被覆写」两份清单。
4. **双向 diff 闸**：对每个「将被覆写」的档，取 VPS 端 md5；若该 md5 等于 repo 历史上此路径任何一版 blob 的 md5（`git log --all --format=%H -- <path>` 逐版 `git show <h>:<path> | md5sum`），属于「VPS 只是落后」→ 可覆写；**否则属于「VPS 独有修改」→ 列入 BLOCKED 清单**。
5. compose 漂移检查（只报不改）：列出 VPS compose 的 service 名与 `environment` 键名（**只印键名不印值**），检查 `generation-api` 有 `OPENAI_COMPAT_GENERATION_ORIGIN`。
6. 磁碟：印 `df -h /` 与 `sudo docker system df`。
7. 输出摘要：将新增 N、将覆写 M（可覆写 A／BLOCKED B，BLOCKED 逐档列出）、HEAD 短 hash。

### `deploy`
先跑完整 `plan`；有 BLOCKED 就中止（除非对应路径逐一用 `--allow-overwrite <path>` 放行）。接著：
1. preflight：`npx tsx --test src/lib/control-plane-proxy-routes.test.ts`（若档案存在）；`npx next lint` 不跑（太慢）。
2. 磁碟：可用空间 < 6G → `sudo docker builder prune -f --filter until=72h` 与 `sudo docker image prune -f`，再测；仍 < 4G → 中止。
3. 版本化：把现役两个 `:latest` 各打一个 `:rollback-<UTC yyyymmddHHMMSS>` tag；rollback tag 各只保留最近 3 个，更旧的 `docker rmi`。
4. 真同步（rsync 同参数去掉 --dry-run）→ `sudo docker compose -f control-plane-compose.yml build generation-api generation-worker` → 成功后两个新镜像再打 `:git-<短hash>` → `sudo docker compose -f control-plane-compose.yml up -d generation-api generation-worker` → `sudo docker restart imagesite-nginx`。
5. postcheck（任一失败 → 自动执行 rollback 到本次打的 rollback tag，并以非 0 退出）：
   - `sudo docker exec image-control-api printenv OPENAI_COMPAT_GENERATION_ORIGIN` 非空；
   - 容器内 `wget -qO- http://127.0.0.1:3000/api/healthz` 回 200（容器是 alpine，有 wget）；
   - 等 30 秒后 `image-control-worker` 仍是 running 且 `RestartCount` 没增加。
6. 成功后在 VPS 写 `/opt/image-control-plane/DEPLOYED`（`<短hash> <UTC 时间> <部署机 hostname>`），并印出 build 耗时。

### `rollback [tag]`
不给 tag 用最新的 `:rollback-*`。把该 tag 重新标成 `:latest`（api、worker 两个），`up -d --no-build generation-api generation-worker`，重启 imagesite-nginx，跑同一组 postcheck（此处失败只报错，不再递回回滚）。

## 你要执行的验收（只准 `plan`）
- `bash -n deploy/vps/deploy-control-plane.sh`；有 shellcheck 就跑。
- **只跑 `plan`**，贴完整输出。这份输出就是「VPS 副本 vs repo」的双向 diff 报告，orchestrator 要看 BLOCKED 清单。
- **禁止执行 `deploy`／`rollback`、禁止任何会改动 VPS 的命令**（包括 docker tag/prune/rsync 真同步/compose）。

## 红线
- 不在任何输出、log、commit 印出 secret 值（compose 与 `.env.control-plane` 只能印键名）。
- working tree 有别人未提交的改动：**只 `git add deploy/vps/deploy-control-plane.sh`**，禁 `git add -A`／stash／checkout／reset。
- 同一错误重试 2 次仍失败 → 停下，回报事实。
- 完成后 `git commit`（`chore(deploy): …`，结尾 `Co-Authored-By: DeepSeek <noreply@deepseek.com>`）。

## 回报格式
commit hash、脚本行数、`plan` 全文输出、BLOCKED 清单（路径＋VPS md5）、未完成／偏离 spec 之处。
