# 對話歷史 Dropdown（2026-08-21 深夜）

## 交付內容
- 網關（VPS /opt/agent-harness/gateway/）：
  - persistence.ts 加 listSessionRows(apiKey)：SELECT by owner_key ORDER BY updated_at DESC
  - index.ts 加 GET /agent/v1/sessions 路由（返回 session_id/created_at/updated_at/last_activity_at）
  - 之前已加 teardownSession keepRow（idle reap 不刪 row）
- 站點：GET /api/agent/sessions（resolveAgentCaller 鑑權 + callAgentGateway 透傳）
- client：listAgentSessions() + AgentSessionSummary 類型（src/lib/agent-chat-client.ts）
- hook：switchSession(targetSessionId)（src/hooks/use-agent-chat.ts）——斷流→探活（sse-ticket，觸發 hydrateFromDb 復活）→restore（若存檔匹配）或 reset→開流；返回 bool
- UI：AgentChatSurface 對話歷史按鈕 → dropdown（首次打開拉目錄；條目=日期時間標題+最後活動相對時間；當前會話標記「當前」；點選切換，切換中轉圈）

## 設計要點
- transcript 回放：localStorage 只存最後一個會話的 transcript。切到舊會話時若存檔匹配才回放，否則空 transcript 開流（agent 端上下文完整，不失憶）
- 數據流：網關 sessions 表（owner_key 隔離）→ 目錄；transcript 本體永遠在前端 localStorage
- dropdown 位置：absolute 定位在按鈕下方（z-30，iOS 風格白底毛玻璃卡）

## 已驗證
- 網關直連：curl -H 'Authorization: Bearer <key>' http://127.0.0.1:8081/agent/v1/sessions 返回該 key 全部會話（實測返回 2 條）
- 站點：未登錄 401（鑑權正確）；部署 image-da7u2luua（Production Ready）
- tsc 零錯；commit b5104b8 已 push
