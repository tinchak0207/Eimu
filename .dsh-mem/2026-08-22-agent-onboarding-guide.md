# Agent 畫像 Onboarding 引導（2026-08-22，PM 原則：選擇題零打字）

## 用戶決策
用戶否決「設置面板填表」方案：不如無數據時 agent 主動用**選擇題** guide 用戶——賓至如歸 + 用戶不動腦（PM 懶人原則）。

## 實現（全鏈路已部署）
- 站點 POST /api/agent/sessions：buildAgentMemoryInjection 為 null 時 payload.memory_empty=true
- gateway handleCreateSession：memory_empty → state.profileOnboardingPending=true（persistence 序列化/恢復都加欄位）
- gateway 首條訊息 system 注入：vetting 之後追加 PROFILE_ONBOARDING_DIRECTIVE——
  指導 agent 用 question 工具問選擇題（行業/素材類型/風格偏好，每次一道，4-6 選項），
  用戶點選零打字；趕時間的用戶（直接說任務）跳過採集先幹活
- 復用全部現有設施：question 工具（agent→前端選項卡）零新工具、零新前端組件

## 部署
- gateway：patch-onboarding 1-4 + persistence（bun build 0 error，systemctl restart active）
- 站點：image-3vm4lsuiu（DEPLOY_RC:0），commit 已 push

## 後續（未做，等用戶驗收後）
- onboarding 答案落 profile DB（現只進當前會話上下文；跨會話持久需 agent 答案回寫站點 DB 或 gateway 存 pendingProfile）
- 引導完成後 profileOnboardingPending 翻 false 的觸發（目前 agent 問完即止，標記仍 true——下次新會話若 DB 已有畫像則不再觸發）
