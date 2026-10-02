# agent-poller

生產常駐輪詢程式（VPS `agent-poller.service`）：接收 gateway/agent 工具註冊的
生成任務，代替「fire-and-wait」把它輪詢到終態，再回推事件與人話給 session。

## 為什麼這裡才有真源（歷史，具名記錄）

**這個程式過去沒有 repo 真源、沒有任何部署文件。** 它只存在於 VPS 的
`/opt/agent-harness/poller/index.ts`，不在任何 git 倉庫裡：

- `grep -rln "pendingTasks\|POLLER_REGISTER_PORT" .` 無命中
- `git log --all -- '*poller*'` 無命中
- `docs/` 與 `deploy/CHECKLIST.md` 也沒有任何 poller 部署說明

正因為沒有真源，一個致命 bug 得以在生產存活至今（2026-10-02 修）：poller 對
**所有** kind 都去輪詢 `/v1/images/{task_id}` 並無條件發 `image.done`。影片 job id
**不在 images 命名空間**，所以影片任務每輪 404 → backoff → 撐滿 30 分鐘 TTL 才死，
**全程零幀**、成品永遠不會自動彈出。同 repo 的
`deploy-staging/opencode-runtime/tools/image_get_result.ts:47-56` 早就在 404 時回落
`/videos/{id}`，但 poller 從未拿到這個修復——因為它不在庫裡，沒人能修它。

**自本目錄起，`deploy-staging/poller/` 是本程式的唯一真源。** VPS 上的
`/opt/agent-harness/poller/` 是部署目標（活本），不是真源。任何對 poller 的修改
都必須改這裡、測試、提交，再部署。

## 檔案

| 檔 | 說明 |
|---|---|
| `index.ts` | 生產原文逐位元鏡像 + 本次修復（見下） |
| `media-endpoints.ts` | 純函式：kind → 輪詢路徑 / kind → 終態事件名 |
| `package.json` | 與生產逐位元相同（`bun run index.ts`，無依賴） |
| `media-endpoints.test.ts` | `media-endpoints` 的變更探針（非行為驗收） |

## 本次修復（僅四處 + 一行 import）

1. `pollTask` 的 URL 改用 `pollPathFor(task.kind, task.task_id)`：影片走
   `/v1/videos/{id}`，不再所有 kind 都打 `/v1/images/`。
2. 成功分支事件名改用 `doneEventFor(task.kind)`（影片發 `video.done`，圖片維持
   `image.done`）；影片帶 `emitData.media_kind = "video"`（圖片不帶）。
3. refunded 文案：`kind === "video"` 時「這張圖」→「這部影片」。
4. 逾時文案：同上。

其餘（token bucket 容量 5 / 54rpm、dedup、watchdog 60s、register server
127.0.0.1 無鑑權、12/30 分鐘 lifetime、`resolveKey`、`hashId`、`resumeSession`）
一律逐位元保留。

## 部署配置（實查生產，非猜測）

- **service**：`agent-poller.service`（`systemctl cat` 實查）
  ```
  User=ubuntu
  WorkingDirectory=/opt/agent-harness/poller
  EnvironmentFile=/opt/agent-harness/.env
  ExecStart=/home/ubuntu/.bun/bin/bun run index.ts
  Restart=always
  RestartSec=5
  After=network.target agent-gateway.service
  ```
- **監聽埠**：`POLLER_REGISTER_PORT` **8082**（`.env` 實設 8082；`index.ts` 預設亦 8082），
  只綁 `127.0.0.1`（無鑑權，禁止對外）。實查：`ss -tlnp | grep 8082` → `127.0.0.1:8082 bun`。
- 其他環境變數：`POLLER_TICK_MS=4000`、`GATEWAY_URL=http://127.0.0.1:8081`。

## 部署命令

```bash
cd /home/lenovo/Desktop/image-app
bash .pixai-refresh/start-ssh443.sh   # 冪等，確保 SSH-over-443 隧道在

# 推送真源三檔到生產（目標目錄 owner 為 ubuntu，無需 sudo）
for f in index.ts media-endpoints.ts package.json; do
  node .dsh-ssh/exec-443.js "echo $(base64 -w0 deploy-staging/poller/$f) | base64 -d > /opt/agent-harness/poller/$f"
done

# 重啟並看狀態
node .dsh-ssh/exec-443.js "sudo systemctl restart agent-poller && systemctl status agent-poller --no-pager | head -12"
```

## 驗證

```bash
# 服務在跑且無 crash-loop
node .dsh-ssh/exec-443.js "systemctl status agent-poller --no-pager"
# 輪詢註冊埠（pending 清單）
node .dsh-ssh/exec-443.js "curl -s 127.0.0.1:8082/"
#   預期：{"pending":N,"tasks":[...]}
# 近期日誌
node .dsh-ssh/exec-443.js "sudo journalctl -u agent-poller -n 50 --no-pager"
```

**真正的行為驗收**（由 orchestrator 在生產做）：拿一個**既有已成功的影片 job**
（免費、不重新生成）註冊進 poller，確認 poller 對它不再 404、且會發出
`video.done`（含 `media_kind:"video"`）而非 `image.done`。

## 版本控制注意

`.gitignore:150` 有 `/deploy-staging/*`，本目錄預設被忽略。要讓本真源入庫，
需比照 `gateway/`、`vps-tools/`、`opencode-runtime/` 的既有例外，加一行：

```
!/deploy-staging/poller/
```

（本檔建立時未改 `.gitignore`，留給 orchestrator 於提交前處理。）
