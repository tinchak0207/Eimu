# 2026-10-23 历史露 prompt + 过时通知烧 token

## A. 手机历史暴露系统 prompt

**机制**

1. `GET …/messages` → `slimHistoryMessages`（`sessions-http.ts`）此前仍回传 `role=system`（含非唤醒）与机制 user 文（`【生成结果耐久收件箱】`）；客户端 normalize 虽丢多数 system，但防御应在网关读路径。
2. `GET …/sessions/:id`（`handleGetSession`）原样拼接全部 text，**无过滤**。
3. `GET …/transcript`（`handleTranscript`）把非 user **一律映射成 assistant**，system/内部指令会冒充助手气泡。
4. 文本中的 `<system-reminder>…</system-reminder>`（上游/AGENTS 注入）在读路径未剥。

**修复（读路径，不改模型上下文）**

- `system-wake.ts`：`isInternalMechanismText` / `stripSystemReminders`
- `slimHistoryMessages`：丢 developer、非唤醒 system、耐久收件箱等机制 user；剥 system-reminder
- `handleGetSession`：先 slim 再投影
- `handleTranscript`：保留真实 role；非唤醒 system/developer/机制 user 丢弃；剥 reminder

## B. 用户走后重复过时通知

**机制**

`drainGenerationInbox`（每 10s）对未 ACK 的 image/video 在指数退避后仍以 12h 地板 **无限** `prompt_async` 投 `【生成结果耐久收件箱】`。用户关页后 `state.clients.size===0`，无人 ACK → 反复唤醒 agent 烧 token。

**修复**

- `notify_count >= 10` 硬停
- 已 `notified_at` 且父会话无 SSE 客户端（或不在内存）→ 推迟重投；用户重连后再投一次

## 发版

改的是 gateway 读路径 + drain；需 harness gateway 正常 drain 发版（禁 --force）。本机 commit 后未自动上线。
