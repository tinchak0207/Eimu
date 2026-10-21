# S6 补发开发者漏掉的新人礼＋修正回溯排除口径（预期 30 分钟）

先读 `_common.md`（同目录）。另外必读：`/home/lenovo/.claude/memory/product-reality-funnel-0927.md`（新人礼上线、回溯细节）。

## 事实（S1 报告）
- 245、250、251、252、254 建了 biz key，但 new-api 额度是 **$0**。他们按下按钮只会撞 402。
- 根因（推论，先验证）：`src/lib/welcome-gift.ts` 的回溯用 `listBizBillingUserIds()`，把**所有 biz key 持有者**都排除掉了。原意只是排除内部的 B 端计费帐户。
- 登入时补发要靠 `/api/auth/me`，但开发者用的是 API，不会再登入网页，所以永远补不到。

## 做什么
1. 回溯排除口径改为只排除 `INTERNAL_USER_IDS`（env），加上现有的 probe/test/canary 规则，**不再**按「持有 biz key」排除。
   - 把 `welcomeGiftBackfillCandidates` 的测试改成新口径：持有 biz key 的外部用户要进候选。
2. 在 worker 维护轮（`src/lib/generation-core/worker-service.ts` 的 `runAccountMaintenanceOnce`）加一步：外部用户一旦建了 biz key、又还没领过新人礼、也没成功出过图，就自动发。
   - 直接复用 `grantWelcomeGift`，不另写发放逻辑
   - 每轮最多 20 人
3. 不做一次性手工补发，交给第 2 步在部署后自动补齐。回报时说明预期会补到哪些 user id（只读查询得出）。

## 验收
- 单元测试：biz key 持有者、无 gift、无成功单 → 发；内部 id → 不发；已领 → 不发
