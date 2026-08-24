# Agent 跨會話記憶：斷點診斷 + 補注鏈（2026-08-22）

## 用戶現象
用戶問 agent「有沒有關於我帳戶的記憶」→ agent 說沒有。記憶系統（L0 畫像+教訓注入）明明部署過。

## 根因（FACT，全鏈路實測）
1. 注入鏈本身完好：POST /api/agent/sessions 建會話 → loadAgentProfile+listAgentLessons → buildAgentMemoryInjection → gateway state.userMemory → 首條訊息 system 注入 → memoryInjected 持久化
2. **斷點一（主因）**：用戶從沒填過畫像——profile/lessons API 齊全（/api/agent/profile GET/PUT + /profile/lessons）但**沒有任何前端 UI 消費**（grep 'api/agent/profile' in components = 0 命中）。空畫像 → buildAgentMemoryInjection 返回 null → userMemory=undefined → 無記憶可注
3. **斷點二**：注入只發生在建新會話時。gateway sessions.db 裡 8 個會話全部無 userMemory 鍵（sqlite LIKE 全 0）——老會話 resume/switch 永遠拿不到記憶（即使將來填了畫像）

## 修復（斷點二，已部署 image-mdgwrdv0q）
- gateway：POST /agent/v1/sessions/memory-patch——更新已存在會話的 userMemory + 重置 memoryInjected（下一條訊息帶最新畫像）
- 站點：POST /api/agent/sessions/[id]/memory——讀權威 profile/lessons 推給 gateway（與建會話同一套組裝）
- hook：resume()/switchSession() 成功後 void patchAgentSessionMemory(sid)（best-effort，失敗不打擾）

## 未做（斷點一，需要產品決策）
- 畫像填寫 UI（onboarding 表單或 agent 設置面板）——PUT /api/agent/profile 已就緒等 UI
- lessons 提煉/確認流程的 UI 入口
- 沒有這兩個，記憶系統是「有引擎沒油箱」
