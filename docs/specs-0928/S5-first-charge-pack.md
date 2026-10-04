# S5 一次性首充套餐：1 刀 300 张（预期 45 分钟，**依赖 S3 合并**）

先读 `_common.md`（同目录）。**正价 PLANS 一行都不许动。**

## 口径（暴君拍板）
- plan id `first-charge`：**¥7（≈$1）→ 300 币**
  - 正价 ¥9.9 = 100 币，这个是它的约 4 倍划算
  - 成本约 ¥1.5
- 资格：该帐号在 account_ledger **从未有过 recharge 行**，并且从未购买过 first-charge。每个帐号限一次。

## 做什么
1. `src/lib/plans.ts`：新增 `FIRST_CHARGE_PLAN`，**不放进** `PLANS` 阵列，免得出现在正价列表、也免得 lifecycle-email 的 `entryPlan()` 误把它选成最便宜的档。
2. 资格判定放在控面：新增内部端点，或并入 S3 的 mapay-credit 通道。**checkout 和 notify 两端都要校验**：
   - 没资格的人 checkout → 403
   - notify 时发现已经不符合资格（例如并发下了两单）→ 按 ¥7 对应的正价币数（约 70 币）入帐，不给 300；记 detail
3. 定价页 `src/components/PricingClient.tsx`：
   - 有资格时，在最前面放一张卡：「首充专享 · 限一次｜¥7 得 300 币（约 300 张 GPT Image 2）」
   - 没资格或未登入时不显示；未登入时只显示文案，点击后先登入
4. 余额不足 toast 的「去充值」（`src/components/ImagePlayground.tsx`）：改为跳转 `/pricing?plan=first-charge`，定价页据此滚动到该卡。
5. API 的 402 讯息（S2）里的充值链接同样带上 `?plan=first-charge`。

## 验收
- 资格判定的单元测试：没有 recharge → 有资格；有 recharge → 无资格；买过 first-charge → 无资格
- `PLANS` 阵列与正价数字无 diff（`git diff src/lib/plans.ts` 只能是新增）
