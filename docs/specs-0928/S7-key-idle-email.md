# S7 「key 建了沒用」召回信（預期 40 分鐘）

先讀 `_common.md`（同目錄）。另外必讀：`/home/lenovo/.claude/memory/lifecycle-email-system-0927.md`，以及 `src/lib/lifecycle-email.ts` 全檔（這次是加模板，不是重寫）。

## 事實（S1 報告）
23 個外部 key 持有者中，14 人建 key 後一次都沒調用。12 人是在註冊當下順手建的，之後再也沒回來。他們不是被拒絕，是沒有下一步。

## 做什麼
1. `lifecycle-email.ts` 新增模板 `key_idle`：
   - 觸發條件：建了第一把 biz key 滿 24 小時；該用戶沒有任何 source=biz 的 job；沒有退訂營銷郵件；有已驗證的 email
   - 每人只發一次（沿用 `email_send_log` 的 PK）
2. 文案（簡體中文，版式沿用現有模板）：
   - 標題：「你的 API key 还没出过第一张图」
   - 正文放一段 curl，**key 位置寫 `$EMU_API_KEY` 佔位符，絕不嵌入真實 key**
   - 模型用 `src/lib/dev-quickstart.ts` 已經生成的 gpt-image-2 範例（複用，不另寫）
   - 標明餘額：「新人礼 X 张可直接调用」，X 從 WELCOME_GIFT 常量取
   - CTA 按鈕：「查看我的 key」→ `/settings?tab=api-keys`（先 grep 確認實際路由）
   - 附退訂鏈接
3. 在 `runLifecycleEmailsOnce` 的候選查詢裡加上這個模板，沿用 claim → send → settle 流程。

## 驗收
- 單元測試：沒建 key → 不發；建了未滿 24 小時 → 不發；已有 biz job → 不發；已退訂 → 不發
- 渲染出的 HTML 不含任何 `sk-` 開頭的字串
