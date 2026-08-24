# Canvas/AI模式 後端不可用 + 前端左側問題診斷（2026-08-21）— 待併入 ~/.codex/memories

## 視覺探查（read_image skill，groq 後備通道）
- gemini 主通道 429；groq 後備需隧道 127.0.0.1:18893，本機無 ssh 二進位 → 手寫 node ssh2 腳本 /tmp/dsh-tunnel.js（forwardOut → VPS 127.0.0.1:8891 groq-proxy）。dsh-groq-socks-tunnel user service 在此機不存在。

## 前端（左側）FACT
1. AI 助理浮動面板疊在畫布節點清單之上，遮擋「角色A四視圖配置」列表
2. 「已連接」與 workflow_start 卡片之間有灰白空白區
3. 輸入框左側圖標渲染異常

## 後端 FACT
1. worker 崩潰：uncaught rejection write CONNECT_TIMEOUT generation-postgres:5432 於 heartbeatGenerationJob（job-repository.ts:302）→ 進程死 → 任務停滯 → deadline_exceeded refunded
2. 6h 任務：19 refunded（全 deadline_exceeded）、8 succeeded（全 pixai-tsubaki2）；gpt-image-2 與 seedance-2.0 100% refunded
3. supplier_account：adobe2api healthy/auto_refresh 但 success_rate_5m=0；sub2api success_rate_5m=0；pixai=1
4. .env.biz-key 內容已變：60 字元前綴 IMAGE_STUD（非 sk-biz-）→ B 端 401；需確認是否被覆寫
5. /v1/models 線上逾時；/v1/model-status 生產 404（repo 有 route 但生產缺）；queue/system_stats/object_info 正常 JSON 401
6. SSH：443 通道握手失敗（gost 卡死）；22443 連續 RST；需 VNC sudo systemctl restart warp-proxy-gost

## INFERENCE
- 主瓶頸 = worker 對 Postgres 瞬斷零容錯（heartbeat 無 catch，uncaught rejection 殺進程）→ 批量超時退款
- gpt-image-2/seedance 全退款可能疊加渠道慢，需 attempt 級證據

## 修復記錄（A 任務完成，2026-08-21）
- commit 0c655c6：worker/generation-worker.ts 加 process 級 unhandledRejection 守衛；worker-service.ts 心跳 .catch 非致命 + 主迴圈迭代 try/catch
- 驗證：tsc --noEmit 通過；tsx --test generation-core 70/70 通過
- 部署：VPS /opt/image-control-plane/app 已同步（md5 全部對齊，發現並補同步 job-repository.ts、supplier-adapter.ts 兩個漂移檔案——worker-service 引用了 job-repository 的 listGenerationAttemptsForJob，VPS 版缺此函數會在執行時 TypeError）後 compose build + up -d 重建
- 部署後驗證：worker Up、零 error 日誌、queued 全清空、無重啟

## B 任務記錄（前端 dock 修復，2026-08-21）
- commit b87af83：ImagePlayground.tsx overlay 改 fixed right-0 + left:calc(0.75rem+var(--ce-dock-left))，AI 助理面板 dock 讓位畫布；CanvasEmbed.tsx 移除三處重複避讓；測試 37/37 + tsc 通過
- 部署：Vercel token 已過期（~/.local/share/com.vercel.cli/auth.json 唯讀且 expiresAt 2026-08-20 00:54）→ 用戶 OAuth 重新登入（vercel login，auth 存 .vercel-cli-data/，需 XDG_DATA_HOME=$PWD/.vercel-cli-data XDG_CACHE_HOME=$PWD/.vercel-cli-cache）→ vercel --prod 部署成功，alias www.eimu.dev READY（healthz 200）
- 遺留（非本次範圍）：/v1/model-status 生產 404（Vercel beforeFiles rewrite /v1/* → VPS control-plane，VPS repo 缺 model-status route，本地有；需同步 VPS src/app/api/v1/）；.env.biz-key 前綴 IMAGE_STUD 非 sk-biz-，401 待確認

## 後續修復：canvas 圖片 401（2026-08-21 第二輪）
- 症狀：/api/canvas/image-proxy?url=image.tinchak0207.xyz/v1/images/<id>/result 回 401，畫布「圖片加載失敗」
- 根因鏈（FACT）：/v1/images/{id} 輪詢回應含 result_url（相對、需 Bearer）+ data[0].url（公開 blob URL store.tinchak0207.xyz/image-data/...）；agent 網關工作流路徑（gateway/index.ts ~488 行）優先取 result_url → 前端拿到認證 URL → img 無法帶 auth → 直鏈 401 → 代理也 401（代理只代讀不做平台認證）
- 修復：VPS gateway/index.ts 取值順序改為 data[0].url 優先（python 精確替換，備份 index.ts.bak-20260821）；bun build 語法通過 + systemctl restart agent-gateway（重啟會清空內存 session，已知架構事實）
- 注意：已存在的壞節點（存了認證 URL）重試節點才會拿到新公開 URL；新提交的生成直接走新路徑
- resolveResultUrl（網關 687 行）本來就會把 /v1/images/{id}/result 解析成公開 URL，但工作流輪詢路徑沒用它，是 emitImageDone 路徑專用
