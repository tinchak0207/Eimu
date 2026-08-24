# Agent 會話「每次新對話」根因與修復（2026-08-21 夜）

## 根因（FACT，VPS 實測）
- 網關 idle reaper（SESSION_IDLE_TTL_MS=30min 無 SSE 客戶端且無活動）觸發 teardownSession("idle_timeout")
- teardownSession 原本連 sqlite row 一起刪（deleteSessionRow），lazy reload 無從復活
- 用戶離開超過 30 分鐘後回來，resume() 探活 404，只好開新對話 = 「每次從外面點進來都是新對話」
- 前端 fdc3297（auto-resume）已正確部署在 www.eimu.dev（Production image-8au30zgdk），但救不了已被刪 row 的會話

## 修復（已生效）
- VPS /opt/agent-harness/gateway/index.ts：teardownSession 加 keepRow 參數
  - idle_timeout 場景 keepRow=true：只清內存，保留 sqlite row
  - DELETE 場景 keepRow=false（默認）：連 row 刪（用戶明確棄單）
- 復活鏈：30min 後回來，resume() 探活，requestSseTicket，getOwnedSession，hydrateFromDb，會話復活，SSE 續傳
- systemctl restart agent-gateway 已執行（active, persistence ready）

## 排障要點
- 服務入口：systemd agent-gateway，ExecStart=bun run index.ts（源碼直跑，patch 即時生效）
- keepRow 相關：grep keepRow index.ts 應 2 處（簽名+idle 調用）
- 修網關流程：本地寫 patch 腳本，node .gateway-work/sftp-put-443.js 上傳，exec-443 執行，bun build 語法檢查，systemctl restart
