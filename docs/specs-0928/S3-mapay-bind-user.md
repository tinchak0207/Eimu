# S3 付款绑定用户——notify 直接入帐（P0，预期 60 分钟）

先读 `_common.md`（同目录）。另外必读：
- `/home/lenovo/.claude/memory/payment-must-fulfill-0920.md`
- `/home/lenovo/.claude/memory/payment-callback-forensics-0920.md`
- `/home/lenovo/.claude/memory/mapay-fee-rejection-fix-0920.md`

## 为什么
现在 checkout 的 `param = plan.id`，订单不绑用户。notify 只生成兑换码，靠 return 回跳 `/pricing?cdk=` 自动兑换。用户付完钱如果关掉分页，钱已付、额度却没到帐。

## 做什么
1. `src/app/api/payments/mapay/checkout`：已登入时，`param = ${planId}.${userId}.${hmac8}`。
   - hmac8 = `HMAC-SHA256(GENERATION_BILLING_RELAY_SECRET, "mapay-order." + planId + "." + userId)` 的前 8 位 hex
   - 未登入沿用旧格式
   - 仿照 `src/lib/referral-code.ts` 的签名和 timingSafeEqual 写法
2. `notify`：param 验签通过后，调控面内部端点入帐：
   - 新建 `src/app/api/internal/mapay-credit/route.ts`，复用 biz-key-sync 的 HMAC 通道，仿照 `src/app/api/internal/user-attribution/route.ts`
   - 入帐逻辑仿照 `src/lib/referral-reward.ts` 的 grantOnce：占位表 `mapay_credit(out_trade_no pk, user_id, plan_id, amount_quota, status…)` → 上游 `adjustGatewayUserQuotaExact` → 帐本 `recordRecharge`
   - 幂等键 = mapay 的 out_trade_no
   - notify 重放时不重复入帐
3. notify 直接入帐成功后，**不再**生成兑换码。入帐失败时退回旧流程（生成兑换码），保证钱一定能落地。
4. return 页：如果订单已经直接入帐，显示「支付成功，已到账」，不再触发兑换。
5. 验签失败或 param 是旧格式 → 完全走旧流程。

## 验收（全部是单元测试，禁止真实支付）
- 签名对 / 错 / 篡改 userId 三种情况
- notify 同一单重放两次，只入帐一次
- 上游调额失败时退回兑换码流程
- 旧格式 param 行为不变
