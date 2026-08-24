# Agent 網關會話持久化 + 滾動摘要（2026-08-21/22 交付，已驗收上線）

## 架構事實（認知修正）
- SessionState 從不存 messages：gateway sessions Map 只存 id 映射/SSE replayBuffer(200幀)/去重集合/注入標記；**對話歷史權威 owner 是 opencode serve（127.0.0.1:4096）**，重啟後完整保留。
- 「重啟丟會話」=內存 Map 丟 id 映射→404；修復=persist gateway 自有子集+lazy reload，不複製 messages。

## 實現
- /opt/agent-harness/gateway/persistence.ts（278 行）：bun:sqlite 單表 sessions(id,owner_key,opencode_session_id,created_at,updated_at,data JSON) WAL；寫入=dirty+3s 防抖+SIGTERM flush；載入=lazy reload；fail-open。
- 滾動摘要=擴展 opencode 原生 POST /session/:id/summarize（body 必須 {providerID,modelID}）：session.idle 時 >=40 條（env SESSION_COMPACT_THRESHOLD）且新增>=20 觸發；inFlight Set+持久化水位雙層防抖。
- 新端點 GET /agent/v1/sessions/:id（只讀歷史恢復）；reaper 掃 7 天 DB 孤兒。
- 備份 index.ts.bak-20260821-persist；回滾=cp 備份+rm persistence.ts sessions.db*+restart agent-gateway。

## 排障要點
- **bun build 必須 --target=bun**（bun:sqlite 是 builtin，browser target 拒絕）。
- **exec-443.js 傳 >100KB 參數會靜默損壞文件**，用 sftp fastPut+md5（.gateway-work/sftp-put-443.js）。
- 驗收：restart 後歷史完整+續聊 202；44 條自動 compaction；SSE+CORS 200；測試 session 已清。
- 遺留：SSE ticket 不持久化（前端自動重簽）；owner_key 明文（同機信任域）；前端可遷移掉 localStorage 兜底。
