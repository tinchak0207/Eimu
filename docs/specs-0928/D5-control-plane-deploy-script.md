# D5：控面一鍵部署腳本（preflight＋雙向 diff 閘＋版本化鏡像＋回滾）（預期 60 分鐘）

工作目錄 `/home/lenovo/Desktop/image-app`。產出單一檔 `deploy/vps/deploy-control-plane.sh`（bash，`set -euo pipefail`）。

## 必讀記憶
- `~/.claude/memory/MEMORY.md`（Tier-0）＋ `~/.claude/memory/packs/infra-deploy.md`
- `~/.claude/memory/notes/2026-09-28-control-plane-mirror-port-and-verify-recipe.md`：控面座標、「md5 才是雙向 diff 的機器化判準」、`force-recreate` 約 7 秒空窗
- `~/.claude/memory/notes/2026-09-28-control-plane-mirror-port-gap.md`：控面是無 git 的手搬副本
- `docs/runbooks/infra-debugging.md` 第 1-40 行（VPS 連線、rebuild 後必重啟 imagesite-nginx）與 88-110 行（`OPENAI_COMPAT_GENERATION_ORIGIN` 部署依賴）
- 記憶與現場證據衝突時以現場為準，並在回報中寫明衝突。

## 現場事實（orchestrator 09-28 實測）
- VPS：`ssh -i /home/lenovo/.ssh/new.pem -p 22443 ubuntu@43.172.85.76`；**22443 連續快速連線 2-3 次會被 RST** ⇒ 腳本必須用 SSH ControlMaster 多工（`-o ControlMaster=auto -o ControlPath=/tmp/cp-deploy-%C -o ControlPersist=120`），整次執行共用一條連線。
- 控面：`/opt/image-control-plane/`，compose 檔 `control-plane-compose.yml`（**VPS 自有，含 secret，不入 git，腳本永不覆寫它**），建置 context `app/`（無 git 的純目錄），容器 `image-control-api`／`image-control-worker`／`image-control-postgres`；鏡像名 `image-control-plane-generation-api:latest`、`image-control-plane-generation-worker:latest`。所有 docker 命令要 `sudo`。
- VPS 根磁碟 59G 已用 94%（剩 3.7G）；worker 鏡像 2.27GB。Docker 29.1.3（BuildKit 預設）。
- 目前 `app/Dockerfile`＝repo HEAD 的 `deploy/vps/Dockerfile`；`app/.dockerignore`＝repo HEAD 的 `.dockerignore`。

## 子命令
### `plan`（唯讀，預設）
1. 來源＝**本機 git HEAD**，不是 working tree（working tree 有別人未提交的改動，不能部署出去）。`git archive HEAD` 取以下路徑解到 tmp：`src public worker tools db bridge skills deploy-staging/expert-gateway deploy-staging/gateway package.json package-lock.json next.config.mjs next-env.d.ts tsconfig.json tailwind.config.ts postcss.config.mjs components.json`，外加 `deploy/vps/Dockerfile → Dockerfile`、`.dockerignore → .dockerignore`（與 `.dockerignore` 白名單一致；不存在的路徑略過）。
2. 若上述路徑在 working tree 相對 HEAD 有未提交改動 → 印警告並列出（不擋，因為部署的是 HEAD）。
3. `rsync -rlc --dry-run --itemize-changes`（**不帶 --delete**，排除 `node_modules/`）走同一條 ControlMaster 連線，得出「VPS 新增」與「VPS 將被覆寫」兩份清單。
4. **雙向 diff 閘**：對每個「將被覆寫」的檔，取 VPS 端 md5；若該 md5 等於 repo 歷史上此路徑任何一版 blob 的 md5（`git log --all --format=%H -- <path>` 逐版 `git show <h>:<path> | md5sum`），屬於「VPS 只是落後」→ 可覆寫；**否則屬於「VPS 獨有修改」→ 列入 BLOCKED 清單**。
5. compose 漂移檢查（只報不改）：列出 VPS compose 的 service 名與 `environment` 鍵名（**只印鍵名不印值**），檢查 `generation-api` 有 `OPENAI_COMPAT_GENERATION_ORIGIN`。
6. 磁碟：印 `df -h /` 與 `sudo docker system df`。
7. 輸出摘要：將新增 N、將覆寫 M（可覆寫 A／BLOCKED B，BLOCKED 逐檔列出）、HEAD 短 hash。

### `deploy`
先跑完整 `plan`；有 BLOCKED 就中止（除非對應路徑逐一用 `--allow-overwrite <path>` 放行）。接著：
1. preflight：`npx tsx --test src/lib/control-plane-proxy-routes.test.ts`（若檔案存在）；`npx next lint` 不跑（太慢）。
2. 磁碟：可用空間 < 6G → `sudo docker builder prune -f --filter until=72h` 與 `sudo docker image prune -f`，再測；仍 < 4G → 中止。
3. 版本化：把現役兩個 `:latest` 各打一個 `:rollback-<UTC yyyymmddHHMMSS>` tag；rollback tag 各只保留最近 3 個，更舊的 `docker rmi`。
4. 真同步（rsync 同參數去掉 --dry-run）→ `sudo docker compose -f control-plane-compose.yml build generation-api generation-worker` → 成功後兩個新鏡像再打 `:git-<短hash>` → `sudo docker compose -f control-plane-compose.yml up -d generation-api generation-worker` → `sudo docker restart imagesite-nginx`。
5. postcheck（任一失敗 → 自動執行 rollback 到本次打的 rollback tag，並以非 0 退出）：
   - `sudo docker exec image-control-api printenv OPENAI_COMPAT_GENERATION_ORIGIN` 非空；
   - 容器內 `wget -qO- http://127.0.0.1:3000/api/healthz` 回 200（容器是 alpine，有 wget）；
   - 等 30 秒後 `image-control-worker` 仍是 running 且 `RestartCount` 沒增加。
6. 成功後在 VPS 寫 `/opt/image-control-plane/DEPLOYED`（`<短hash> <UTC 時間> <部署機 hostname>`），並印出 build 耗時。

### `rollback [tag]`
不給 tag 用最新的 `:rollback-*`。把該 tag 重新標成 `:latest`（api、worker 兩個），`up -d --no-build generation-api generation-worker`，重啟 imagesite-nginx，跑同一組 postcheck（此處失敗只報錯，不再遞迴回滾）。

## 你要執行的驗收（只准 `plan`）
- `bash -n deploy/vps/deploy-control-plane.sh`；有 shellcheck 就跑。
- **只跑 `plan`**，貼完整輸出。這份輸出就是「VPS 副本 vs repo」的雙向 diff 報告，orchestrator 要看 BLOCKED 清單。
- **禁止執行 `deploy`／`rollback`、禁止任何會改動 VPS 的命令**（包括 docker tag/prune/rsync 真同步/compose）。

## 紅線
- 不在任何輸出、log、commit 印出 secret 值（compose 與 `.env.control-plane` 只能印鍵名）。
- working tree 有別人未提交的改動：**只 `git add deploy/vps/deploy-control-plane.sh`**，禁 `git add -A`／stash／checkout／reset。
- 同一錯誤重試 2 次仍失敗 → 停下，回報事實。
- 完成後 `git commit`（`chore(deploy): …`，結尾 `Co-Authored-By: DeepSeek <noreply@deepseek.com>`）。

## 回報格式
commit hash、腳本行數、`plan` 全文輸出、BLOCKED 清單（路徑＋VPS md5）、未完成／偏離 spec 之處。
