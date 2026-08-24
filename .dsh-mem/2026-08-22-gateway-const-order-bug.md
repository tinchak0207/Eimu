# Onboarding 500 修復（2026-08-22）

## 症狀
部署 onboarding 引導後，發消息 POST /agent/v1/sessions/:id/messages 全 500。

## 根因
PROFILE_ONBOARDING_DIRECTIVE 常量被插在 memory-patch 路由之後（文件尾部的路由處理區），
而使用點在 handleSendMessage（文件中部）——**定義在使用之後** → ReferenceError。
bun build 只做語法檢查不報未定義引用（TS 弱路徑），重啟後 runtime 才炸。

## 修復
把常量塊移到 handleSendMessage 函數定義之前（定義 1455 行 < 使用 1521 行）。

## 教訓（gateway patch 流程補丁）
gateway 加頂層常量時：插入錨點必須選**使用點之前**的函數定義（如 handleSendMessage 前），
不要插在路由處理區（文件尾）。bun build 過 ≠ runtime 過——**每次 gateway 改動後必須
走端到端驗證：B 端 key 建會話（帶新參數）→ 發消息 → 確認 202**。

## 驗證（本輪）
公網域名建會話（memory_empty:true）→ session_id 返回；發「你好」→ 202；測試會話已 DELETE。
