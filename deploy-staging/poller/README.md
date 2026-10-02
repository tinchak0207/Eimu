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
**所有** kind 都無條件發 `image.done`（成功事件名寫死）。影片成品是 .mp4，被推成
`image.done` 後前端把它塞進 `<img>`，卡片變破圖、成品永遠不會正確彈出。
**這才是本輪真正修好的那一半**：成功事件名由 `image.done` 改為 `video.done`
（`doneEventFor(kind)`，影片另帶 `media_kind:"video"`）。

> **根因更正（2026-10-02；原假設已推翻）。** 本檔與 `media-endpoints.ts` 曾記載
> 「影片 job id **不在 images 命名空間**，所以每輪 404」。此說法**已被現場推翻**：
> - `src/app/api/v1/images/[id]/route.ts:45` 與 `src/app/api/v1/videos/[id]/route.ts:24`
>   呼叫的是**同一個** `getGenerationJobForTenant(id, 'biz:'+key.id)`；
> - `src/lib/generation-core/job-repository.ts:200-202` 的查詢是
>   `SELECT * FROM generation_job WHERE id = ? AND tenant_id = ? LIMIT 1`，
>   **沒有任何 kind 過濾**；
> - 因此 `/v1/images/{影片id}` 對**擁有該 job 的同一把 key** 一樣回 200。真正的
>   404 來源是 **tenant 不匹配**（換了 key／用了 fallback 的 `HARNESS_API_KEY`），
>   不是命名空間。生產 nginx access log 佐證：舊碼對 video-kind 任務打
>   `/v1/images/<id>` 得到過 200。
>
> 結論：poller 改走 `/v1/videos/{id}` 在現行站點實作下是 **no-op**（方向沒錯、
> 不是必要修復）。同 repo 的 `opencode-runtime/tools/image_get_result.ts`
> 那份「404 → 回落 `/videos/{id}`」同理，在現行站點下不會被觸發（保留是為兼容
> 舊版站點）。**不要把命名空間當成 404 根因。**

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
   `/v1/videos/{id}`，不再所有 kind 都打 `/v1/images/`。**更正（2026-10-02）：
   這一改在現行站點是 no-op**——兩端點共用同一條 tenant-scoped 查詢、無 kind
   過濾（見上方根因更正），方向正確但非必要修復；保留是為語義清晰與對舊版站點兼容。
2. **本輪真正有效的一處**：成功分支事件名改用 `doneEventFor(task.kind)`（影片發
   `video.done`，圖片維持 `image.done`）；影片帶 `emitData.media_kind = "video"`
   （圖片不帶）。舊碼對影片也發 `image.done`，會讓 .mp4 被前端塞進 `<img>` 變破圖卡。
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
（免費、不重新生成）註冊進 poller，確認 poller 發出 `video.done`
（含 `media_kind:"video"`）而非 `image.done`。（更正 2026-10-02：不要以「不再 404」
為驗收點——對同一把 key，`/v1/images/{影片id}` 與 `/v1/videos/{影片id}` 都會回 200。）

## 版本控制注意

`.gitignore:150` 有 `/deploy-staging/*`，本目錄預設被忽略。要讓本真源入庫，
需比照 `gateway/`、`vps-tools/`、`opencode-runtime/` 的既有例外，加一行：

```
!/deploy-staging/poller/
```

（本檔建立時未改 `.gitignore`，留給 orchestrator 於提交前處理。）
