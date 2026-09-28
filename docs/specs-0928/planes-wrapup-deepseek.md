# 收尾任務：三平面修復（V-01/02/03/04/06/07/08/09 + Web 負面詞）提交、上控面、上 Vercel

預期 45 分鐘；超過 90 分鐘就停下，回報卡在哪一步。用正體中文回報。
repo：`/home/lenovo/Desktop/image-app`，分支 `image`，bash（Arch Linux）。

## 必讀記憶（先讀，再動手）
1. `~/.claude/memory/MEMORY.md`：Tier-0 路由。
2. `mem show 2026-09-28-planes-contract-0928.md`：本輪做了什麼、上線要做的三件事。
3. `mem show 2026-09-28-sync-charge-ledger-facade-0928.md`：pixai 同步扣款的帳本門面，以及它依賴控面 DB 的原因。
4. `mem show 2026-09-28-s8-openai-sync-deploy-verify.md`：上一次控面加 Vercel 部署的實錄。雷：`maxDuration` 只能寫字面量，唯一可信的檢驗是真的跑一次 build。
5. `mem show 2026-09-28-p0-deploy-debt-audit-0928.md`：VPS 磁碟 94% 是真風險。
6. `mem show 2026-09-24-header-offset-deploy-verify.md`：Vercel 要從乾淨的 worktree 部署。
7. `docs/architecture/planes-violations.md`：頂部的修復進度表。

記憶和現場證據衝突時，以現場為準，並在回報中寫明衝突。

## 紅線（違反任何一條就立刻停下回報）
- **零付費上游呼叫。** 禁止任何生成型 POST（真單驗證留給暴君，見第 7 步）。不讀、不印任何 key、token 或 `.env` 的值。
- **工作區裡有其他會話未提交的改動，一律不准 add、不准改、不准 stash／checkout／reset。** 只提交下面「本輪檔案清單」裡的檔，並且逐檔 `git add <path>`。禁止 `git add -A` 或 `git add .`。
- 不准碰 `db/migrations/033_team_quota_limits.sql`，也不准碰任何 team-quota、assets、docs 頁的改動（那是別的會話的）。
- 同一個錯誤重試 2 次仍沒通過，就停下回報原文。
- 控面部署一律用 `deploy/vps/deploy-control-plane.sh`。plan 出現 BLOCKED 就停下回報，**不准加 `--allow-overwrite`**。

## 本輪檔案清單（只提交這些）
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
清單內的檔若在 `git diff` 裡夾帶和三平面無關的 hunk（別的會話改到同一檔），停下回報，不要自己拆。

## 步驟（按順序，不跳步）

### 1. 提交前驗證（預期全綠）
```bash
cd /home/lenovo/Desktop/image-app
npx tsc --noEmit -p .
npx tsx --test src/lib/generation-core/*.test.ts src/lib/web-task-prompt.test.ts src/lib/paid-video-cost-gate.test.ts src/lib/control-plane-proxy-routes.test.ts src/app/api/canvas/generate/route.test.ts
```
基準：tsc 0 錯誤，測試 0 失敗（2026-09-28 的實測是 483 通過、11 跳過）。若有失敗，先確認是不是別的會話的檔造成的，把原文寫進回報後停下。

### 2. 提交（只提交清單內的檔）
逐檔 `git add`，然後：
```bash
git commit -m "refactor(planes): 三平面契約落地——供給 adapter registry、成本閘按供給核價、pixai 同步扣款入帳本、canvas 走 durable、Web 負面詞不再丟失

V-01/02/03/04/06/07/08/09 見 docs/architecture/planes-violations.md 頂部進度表。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git show --stat HEAD | tail -5
```
提交後 `git status --short` 裡剩下的必須全是別的會話的檔。確認後貼出剩餘清單。

### 3. 真的跑一次 build（在乾淨的 worktree，不受別的會話未提交改動污染）
```bash
C=$(git rev-parse --short HEAD)
git worktree add /tmp/emu-planes-$C $C
cp -r .vercel /tmp/emu-planes-$C/
cd /tmp/emu-planes-$C && npm ci --prefer-offline && npm run build
```
build 失敗就停下回報，不准部署。

### 4. 控面 DB：先套 migration 032（純放寬約束，安全）
```bash
bash .pixai-refresh/start-ssh443.sh   # 若 22443 直連不通時用；直連：ssh -i /home/lenovo/.ssh/new.pem -p 22443 ubuntu@43.172.85.76
# 在 VPS 上：
sudo docker exec image-control-postgres psql -U image_control -d image_control -c "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='supplier_adapter_type_check';"
# 把本機的 032 內容 scp 上去，或用 heredoc 逐字貼進 psql -c，然後再查一次約束，應該變成 CHECK ((adapter_type <> ''::text))
```
回報時貼出套用前後的約束定義。

### 5. 控面部署（用腳本，它讀的是 git HEAD）
```bash
cd /home/lenovo/Desktop/image-app
deploy/vps/deploy-control-plane.sh plan      # 唯讀；BLOCKED 就停
deploy/vps/deploy-control-plane.sh deploy    # 內含 build、up、重啟 nginx，postcheck 失敗會自動回滾
```
部署前後各看一次 VPS 的 `df -h /`。超過 95% 就停下回報，不要自行清理。
部署後在 VPS 上重新 seed，讓 sub2api 的 `modelAliases` 和 claim 價格寫進 DB：
```bash
sudo docker exec -w /app image-control-worker npx tsx tools/seed-generation-suppliers.ts
sudo docker exec image-control-postgres psql -U image_control -d image_control -c "SELECT id, adapter_type, configuration_json->'modelAliases' AS aliases FROM supplier ORDER BY id;"
```
預期：sub2api 那一行的 aliases 含 `"gemini-3-image": "gemini-3-pro-image"`；所有 `adapter_type` 都在 registry 協議清單內（`openai_images/adobe2api/metaso/openai_video/filmera/blender_bridge/newapi_video`）。若 DB 有 `minimax` 或 `did` 的列，**不要刪**，列出來回報（這兩種現在會明確回 400）。

### 6. Vercel 部署（從第 3 步的乾淨 worktree）
```bash
cd /tmp/emu-planes-$C
HOME=/home/lenovo/Desktop/image-app/.tmp-home XDG_DATA_HOME=/home/lenovo/Desktop/image-app/.tmp-home/.local/share vercel deploy --prod --yes
```
記下 deployment id，並確認 alias `eimu.dev` 指向它（READY 加 alias 對上就停，不做視覺檢查）。

### 7. 免費的唯讀煙測（只准打這些）
```bash
# 代理生效：/api/pixai/edit 應落在控面（未登入時回 401，而且不是 Vercel 的 404 或 500）
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://eimu.dev/api/pixai/edit
# 控面活著
curl -s -o /dev/null -w "%{http_code}\n" https://eimu.dev/api/version
# 控面 worker 日誌沒有 UnknownSupplyProtocolError
ssh ... "sudo docker logs --since 10m image-control-worker 2>&1 | grep -c UnknownSupplyProtocol"
```

### 8. 收尾
- `git worktree remove /tmp/emu-planes-$C`
- 更新記憶：`mem show 2026-09-28-planes-contract-0928.md` 把「進度」段改成「已上線：commit <hash>／控面 rollback tag <tag>／Vercel <dpl id>」，然後 `mem build`。禁止手改 MEMORY.md、packs、catalog。

## 待暴君逐次授權的付費真單（你不准執行，只要原樣列在回報末尾）
1. Web 畫布出一張圖（gpt-image-2，1024，n=1）：驗證 canvas 走 durable、歷史顯示原始 prompt。
2. Web 帶負面詞出一張圖：驗證上游收到的 prompt 含 `Avoid:` 段（查 job 的 attempt 紀錄）。
3. B 端 `/v1/upscale` 一單：驗證 `billing_operation` 有 reserve、commit、refund 列。

## 回報格式
每一步一行：✅／❌、關鍵輸出（commit hash、build 結果、032 套用前後的約束、plan 結果、rollback tag、seed 輸出摘要、Vercel dpl id、煙測狀態碼、磁碟 %）。最後附上付費真單的待授權清單。
