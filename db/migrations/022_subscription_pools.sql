-- 022: 订阅 SKU（REQ-D3）——帐本加「池维度」＋订阅合约表。
--
-- ┌─────────────────────────────────────────────────────────────────────────────┐
-- │ 机制不变量（waoowaoo BA-15/16，机制借用、代码禁抄）：                        │
-- │  ① 双池分离：订阅池（期末过期）／永久池（充值、开帐基线）；                  │
-- │     可用余额 = 永久池 + **未过期**订阅池。                                   │
-- │  ② 按原出资归还：退款回它原本的池（订阅消耗退订阅池、永久消耗退永久池），    │
-- │     不得跨池搬。                                                            │
-- │  ③ (订阅 id, 期次序号) 发放幂等，且下一期 **替换而非累加**。                 │
-- │  ④ 过期只在读取时 lazy 判定（正确性不依赖定时任务；清扫可有可无）。          │
-- └─────────────────────────────────────────────────────────────────────────────┘
--
-- 最小迁移（铁律）：池维度**进既有帐本**（020 的 account_ledger），不新造第二条
-- 帐务通道、不另立第二份余额公式。余额仍有唯一口径：
--   book(user)      = Σ amount                      （帐面净额，对帐用；020 原公式不变）
--   available(user) = 永久池 Σ + 未过期订阅池 Σ      （可用余额，读取时 lazy 判定）
--
-- 池维度三栏：
--   pool        'permanent'（默认，向后兼容 020 既有列）｜'subscription'
--   term_ref    'sub:<subscription id>:term:<期次序号>'；永久池为 NULL
--   expires_at  该期到期时刻；订阅池必填（无到期时刻就无从 lazy 判定）
-- 为何订阅列必带 term_ref/expires_at：过期判定是**读取端的 lazy 计算**，没有这两个
-- 栏位，读取端就只能靠定时任务把余额改掉——那就违反不变量 ④（正确性依赖 cron）。
--
-- 新增 entry_type：'expire'（下一期替换时，把旧期未用完的余额在写入时作废）。
-- 既有 7 种不动；'expire' 是减项，只由订阅续期写入器产生（见 subscription.ts）。
-- 注意区分两种「失效」：
--   ・expire 帐本行 = **写入时**的事件（续期替换，有人按了续费）
--   ・lazy 过期     = **读取时**的判定（时间到了），不落帐、不改写历史
--
-- 订阅合约表（subscription）：只存「合约」——SKU、期长、每期额度、起算时刻、开通来源。
-- 刻意**不存 current_term**：期次序号一律由帐本行推导（Σ 期次 = 帐本的期次行），
-- 存一个可变游标 = 第二个 writer，两边漂移时说不清哪个是真的（与 020「不存 balance_after」
-- 同一条理由）。幂等的真正保证在帐本的 UNIQUE(idempotency_ref)。

-- ── ① 帐本加池维度（既有列一律落在永久池，语义与 020 完全一致） ──────────────
ALTER TABLE account_ledger
  ADD COLUMN IF NOT EXISTS pool text NOT NULL DEFAULT 'permanent',
  ADD COLUMN IF NOT EXISTS term_ref text,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

ALTER TABLE account_ledger DROP CONSTRAINT IF EXISTS account_ledger_pool_check;
ALTER TABLE account_ledger ADD CONSTRAINT account_ledger_pool_check
  CHECK (pool IN ('permanent', 'subscription'));

-- 订阅池的每一列都必须带期次与到期时刻（见档头理由）。
ALTER TABLE account_ledger DROP CONSTRAINT IF EXISTS account_ledger_subscription_term_check;
ALTER TABLE account_ledger ADD CONSTRAINT account_ledger_subscription_term_check
  CHECK (pool = 'permanent' OR (term_ref IS NOT NULL AND expires_at IS NOT NULL));

-- entry_type 加 'expire'（替换语义的写入时作废）。
ALTER TABLE account_ledger DROP CONSTRAINT IF EXISTS account_ledger_entry_type_check;
ALTER TABLE account_ledger ADD CONSTRAINT account_ledger_entry_type_check
  CHECK (entry_type IN (
    'opening', 'recharge', 'consumption', 'refund', 'transfer_out', 'transfer_in', 'adjustment', 'expire'
  ));

-- 读取端的主查询：按身份取池＋期次（lazy 过期判定就是这条）。
CREATE INDEX IF NOT EXISTS account_ledger_pool_term_idx
  ON account_ledger (billing_user_id, pool, term_ref);

-- ── ② 订阅合约 ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS subscription (
  id text PRIMARY KEY,
  -- 帐本主体（new-api users.id），与 account_ledger.billing_user_id 同一把尺。
  billing_user_id integer NOT NULL,
  -- SKU 识别（兑换码 name 标记里的那个；见 subscription-sku.ts 的 SKU 注册表）。
  sku text NOT NULL,
  -- 每期额度（quota 单位，1 币 = 500000）——由实际购买金额决定，不由本表发明定价。
  term_quota bigint NOT NULL,
  -- 期长（秒）。
  term_seconds integer NOT NULL,
  -- 合约起算时刻（首次开通时刻；续期不移动它，只作审计/显示锚点）。
  started_at timestamptz NOT NULL,
  -- 开通来源：'redemption:<兑换码 id>'。UNIQUE ⇒ 同一张兑换码不得开出第二份订阅。
  source_ref text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS subscription_user_idx ON subscription (billing_user_id, sku);
