# 收尾任务：三平面修复（V-01/02/03/04/06/07/08/09 + Web 负面词）提交、上控面、上 Vercel

预期 45 分钟；超过 90 分钟就停下，回报卡在哪一步。用正体中文回报。
repo：`/home/lenovo/Desktop/image-app`，分支 `image`，bash（Arch Linux）。

## 必读记忆（先读，再动手）
1. `~/.claude/memory/MEMORY.md`：Tier-0 路由。
2. `mem show 2026-09-28-planes-contract-0928.md`：本轮做了什么、上线要做的三件事。
3. `mem show 2026-09-28-sync-charge-ledger-facade-0928.md`：pixai 同步扣款的帐本门面，以及它依赖控面 DB 的原因。
4. `mem show 2026-09-28-s8-openai-sync-deploy-verify.md`：上一次控面加 Vercel 部署的实录。雷：`maxDuration` 只能写字面量，唯一可信的检验是真的跑一次 build。
5. `mem show 2026-09-28-p0-deploy-debt-audit-0928.md`：VPS 磁碟 94% 是真风险。
6. `mem show 2026-09-24-header-offset-deploy-verify.md`：Vercel 要从干净的 worktree 部署。
7. `docs/architecture/planes-violations.md`：顶部的修复进度表。

记忆和现场证据冲突时，以现场为准，并在回报中写明冲突。

## 红线（违反任何一条就立刻停下回报）
- **零付费上游呼叫。** 禁止任何生成型 POST（真单验证留给暴君，见第 7 步）。不读、不印任何 key、token 或 `.env` 的值。
- **工作区里有其他会话未提交的改动，一律不准 add、不准改、不准 stash／checkout／reset。** 只提交下面「本轮档案清单」里的档，并且逐档 `git add <path>`。禁止 `git add -A` 或 `git add .`。
- 不准碰 `db/migrations/033_team_quota_limits.sql`，也不准碰任何 team-quota、assets、docs 页的改动（那是别的会话的）。
- 同一个错误重试 2 次仍没通过，就停下回报原文。
- 控面部署一律用 `deploy/vps/deploy-control-plane.sh`。plan 出现 BLOCKED 就停下回报，**不准加 `--allow-overwrite`**。

## 本轮档案清单（只提交这些）
```
docs/architecture/planes.md
docs/architecture/planes-violations.md
docs/specs-0928/planes-wrapup-deepseek.md
db/migrations/032_supplier_adapter_type_open.sql
src/app/api/canvas/generate/route.ts
src/app/api/canvas/generate/route.test.ts
src/app/api/generation-jobs/route.ts
src/app/api/generation-jobs/[id]/route.ts
src/app/api/pixai/edit/route.ts
src/app/api/pixai/template-generations/route.ts
src/app/api/pixai/upscale/route.ts
src/app/api/v1/images/edits/route.ts
src/app/api/v1/template-generations/route.ts
src/app/api/v1/upscale/route.ts
src/lib/control-plane-proxy-routes.mjs
src/lib/control-plane-proxy-routes.test.ts
src/lib/generation-core/billing-ledger.ts
src/lib/generation-core/cancel-generation.test.ts
src/lib/generation-core/cancel-service.ts
src/lib/generation-core/newapi-adapter.ts
src/lib/generation-core/openai-images-adapter.ts
src/lib/generation-core/openai-video-upstream.ts
src/lib/generation-core/paid-video-cost-gate.ts
src/lib/generation-core/provider-reconciliation.ts
src/lib/generation-core/provider-reconciliation.test.ts
src/lib/generation-core/subscription.test.ts
src/lib/generation-core/supplier-adapter.ts
src/lib/generation-core/supply-registry.ts
src/lib/generation-core/supply-registry.test.ts
src/lib/generation-core/sync-charge.ts
src/lib/generation-core/sync-charge.test.ts
src/lib/generation-core/types.ts
src/lib/generation-core/worker-service.ts
src/lib/generation-task-history.ts
src/lib/paid-video-cost-gate.test.ts
src/lib/pixai-proxy.ts
src/lib/supplier-channels.config.ts
src/lib/web-task-prompt.ts
src/lib/web-task-prompt.test.ts
tools/add-supplier-channel.ts
tools/seed-generation-suppliers.ts
```
清单内的档若在 `git diff` 里夹带和三平面无关的 hunk（别的会话改到同一档），停下回报，不要自己拆。

## 步骤（按顺序，不跳步）

### 1. 提交前验证（预期全绿）
```bash
cd /home/lenovo/Desktop/image-app
npx tsc --noEmit -p .
npx tsx --test src/lib/generation-core/*.test.ts src/lib/web-task-prompt.test.ts src/lib/paid-video-cost-gate.test.ts src/lib/control-plane-proxy-routes.test.ts src/app/api/canvas/generate/route.test.ts
```
基准：tsc 0 错误，测试 0 失败（2026-09-28 的实测是 483 通过、11 跳过）。若有失败，先确认是不是别的会话的档造成的，把原文写进回报后停下。

### 2. 提交（只提交清单内的档）
逐档 `git add`，然后：
```bash
git commit -m "refactor(planes): 三平面契约落地——供给 adapter registry、成本闸按供给核价、pixai 同步扣款入帐本、canvas 走 durable、Web 负面词不再丢失

V-01/02/03/04/06/07/08/09 见 docs/architecture/planes-violations.md 顶部进度表。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git show --stat HEAD | tail -5
```
提交后 `git status --short` 里剩下的必须全是别的会话的档。确认后贴出剩余清单。

### 3. 真的跑一次 build（在干净的 worktree，不受别的会话未提交改动污染）
```bash
C=$(git rev-parse --short HEAD)
git worktree add /tmp/emu-planes-$C $C
cp -r .vercel /tmp/emu-planes-$C/
cd /tmp/emu-planes-$C && npm ci --prefer-offline && npm run build
```
build 失败就停下回报，不准部署。

### 4. 控面 DB：先套 migration 032（纯放宽约束，安全）
```bash
bash .pixai-refresh/start-ssh443.sh   # 若 22443 直连不通时用；直连：ssh -i /home/lenovo/.ssh/new.pem -p 22443 ubuntu@43.172.85.76
# 在 VPS 上：
sudo docker exec image-control-postgres psql -U image_control -d image_control -c "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='supplier_adapter_type_check';"
# 把本机的 032 内容 scp 上去，或用 heredoc 逐字贴进 psql -c，然后再查一次约束，应该变成 CHECK ((adapter_type <> ''::text))
```
回报时贴出套用前后的约束定义。

### 5. 控面部署（用脚本，它读的是 git HEAD）
```bash
cd /home/lenovo/Desktop/image-app
deploy/vps/deploy-control-plane.sh plan      # 唯读；BLOCKED 就停
deploy/vps/deploy-control-plane.sh deploy    # 内含 build、up、重启 nginx，postcheck 失败会自动回滚
```
部署前后各看一次 VPS 的 `df -h /`。超过 95% 就停下回报，不要自行清理。
部署后在 VPS 上重新 seed，让 sub2api 的 `modelAliases` 和 claim 价格写进 DB：
```bash
sudo docker exec -w /app image-control-worker npx tsx tools/seed-generation-suppliers.ts
sudo docker exec image-control-postgres psql -U image_control -d image_control -c "SELECT id, adapter_type, configuration_json->'modelAliases' AS aliases FROM supplier ORDER BY id;"
```
预期：sub2api 那一行的 aliases 含 `"gemini-3-image": "gemini-3-pro-image"`；所有 `adapter_type` 都在 registry 协议清单内（`openai_images/adobe2api/metaso/openai_video/filmera/blender_bridge/newapi_video`）。若 DB 有 `minimax` 或 `did` 的列，**不要删**，列出来回报（这两种现在会明确回 400）。

### 6. Vercel 部署（从第 3 步的干净 worktree）
```bash
cd /tmp/emu-planes-$C
HOME=/home/lenovo/Desktop/image-app/.tmp-home XDG_DATA_HOME=/home/lenovo/Desktop/image-app/.tmp-home/.local/share vercel deploy --prod --yes
```
记下 deployment id，并确认 alias `eimu.dev` 指向它（READY 加 alias 对上就停，不做视觉检查）。

### 7. 免费的唯读烟测（只准打这些）
```bash
# 代理生效：/api/pixai/edit 应落在控面（未登入时回 401，而且不是 Vercel 的 404 或 500）
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://eimu.dev/api/pixai/edit
# 控面活著
curl -s -o /dev/null -w "%{http_code}\n" https://eimu.dev/api/version
# 控面 worker 日志没有 UnknownSupplyProtocolError
ssh ... "sudo docker logs --since 10m image-control-worker 2>&1 | grep -c UnknownSupplyProtocol"
```

### 8. 收尾
- `git worktree remove /tmp/emu-planes-$C`
- 更新记忆：`mem show 2026-09-28-planes-contract-0928.md` 把「进度」段改成「已上线：commit <hash>／控面 rollback tag <tag>／Vercel <dpl id>」，然后 `mem build`。禁止手改 MEMORY.md、packs、catalog。

## 待暴君逐次授权的付费真单（你不准执行，只要原样列在回报末尾）
1. Web 画布出一张图（gpt-image-2，1024，n=1）：验证 canvas 走 durable、历史显示原始 prompt。
2. Web 带负面词出一张图：验证上游收到的 prompt 含 `Avoid:` 段（查 job 的 attempt 纪录）。
3. B 端 `/v1/upscale` 一单：验证 `billing_operation` 有 reserve、commit、refund 列。

## 回报格式
每一步一行：✅／❌、关键输出（commit hash、build 结果、032 套用前后的约束、plan 结果、rollback tag、seed 输出摘要、Vercel dpl id、烟测状态码、磁碟 %）。最后附上付费真单的待授权清单。
