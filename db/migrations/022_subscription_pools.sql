-- 022: 訂閱 SKU（REQ-D3）——帳本加「池維度」＋訂閱合約表。
--
-- ┌─────────────────────────────────────────────────────────────────────────────┐
-- │ 機制不變量（waoowaoo BA-15/16，機制借用、代碼禁抄）：                        │
-- │  ① 雙池分離：訂閱池（期末過期）／永久池（充值、開帳基線）；                  │
-- │     可用餘額 = 永久池 + **未過期**訂閱池。                                   │
-- │  ② 按原出資歸還：退款回它原本的池（訂閱消耗退訂閱池、永久消耗退永久池），    │
-- │     不得跨池搬。                                                            │
-- │  ③ (訂閱 id, 期次序號) 發放冪等，且下一期 **替換而非累加**。                 │
-- │  ④ 過期只在讀取時 lazy 判定（正確性不依賴定時任務；清掃可有可無）。          │
-- └─────────────────────────────────────────────────────────────────────────────┘
--
-- 最小遷移（鐵律）：池維度**進既有帳本**（020 的 account_ledger），不新造第二條
-- 帳務通道、不另立第二份餘額公式。餘額仍有唯一口徑：
--   book(user)      = Σ amount                      （帳面淨額，對帳用；020 原公式不變）
--   available(user) = 永久池 Σ + 未過期訂閱池 Σ      （可用餘額，讀取時 lazy 判定）
--
-- 池維度三欄：
--   pool        'permanent'（默認，向後兼容 020 既有列）｜'subscription'
--   term_ref    'sub:<subscription id>:term:<期次序號>'；永久池為 NULL
--   expires_at  該期到期時刻；訂閱池必填（無到期時刻就無從 lazy 判定）
-- 為何訂閱列必帶 term_ref/expires_at：過期判定是**讀取端的 lazy 計算**，沒有這兩個
-- 欄位，讀取端就只能靠定時任務把餘額改掉——那就違反不變量 ④（正確性依賴 cron）。
--
-- 新增 entry_type：'expire'（下一期替換時，把舊期未用完的餘額在寫入時作廢）。
-- 既有 7 種不動；'expire' 是減項，只由訂閱續期寫入器產生（見 subscription.ts）。
-- 注意區分兩種「失效」：
--   ・expire 帳本行 = **寫入時**的事件（續期替換，有人按了續費）
--   ・lazy 過期     = **讀取時**的判定（時間到了），不落帳、不改寫歷史
--
-- 訂閱合約表（subscription）：只存「合約」——SKU、期長、每期額度、起算時刻、開通來源。
-- 刻意**不存 current_term**：期次序號一律由帳本行推導（Σ 期次 = 帳本的期次行），
-- 存一個可變游標 = 第二個 writer，兩邊漂移時說不清哪個是真的（與 020「不存 balance_after」
-- 同一條理由）。幂等的真正保證在帳本的 UNIQUE(idempotency_ref)。

-- ── ① 帳本加池維度（既有列一律落在永久池，語義與 020 完全一致） ──────────────
ALTER TABLE account_ledger
  ADD COLUMN IF NOT EXISTS pool text NOT NULL DEFAULT 'permanent',
  ADD COLUMN IF NOT EXISTS term_ref text,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

ALTER TABLE account_ledger DROP CONSTRAINT IF EXISTS account_ledger_pool_check;
ALTER TABLE account_ledger ADD CONSTRAINT account_ledger_pool_check
  CHECK (pool IN ('permanent', 'subscription'));

-- 訂閱池的每一列都必須帶期次與到期時刻（見檔頭理由）。
ALTER TABLE account_ledger DROP CONSTRAINT IF EXISTS account_ledger_subscription_term_check;
ALTER TABLE account_ledger ADD CONSTRAINT account_ledger_subscription_term_check
  CHECK (pool = 'permanent' OR (term_ref IS NOT NULL AND expires_at IS NOT NULL));

-- entry_type 加 'expire'（替換語義的寫入時作廢）。
ALTER TABLE account_ledger DROP CONSTRAINT IF EXISTS account_ledger_entry_type_check;
ALTER TABLE account_ledger ADD CONSTRAINT account_ledger_entry_type_check
  CHECK (entry_type IN (
    'opening', 'recharge', 'consumption', 'refund', 'transfer_out', 'transfer_in', 'adjustment', 'expire'
  ));

-- 讀取端的主查詢：按身份取池＋期次（lazy 過期判定就是這條）。
CREATE INDEX IF NOT EXISTS account_ledger_pool_term_idx
  ON account_ledger (billing_user_id, pool, term_ref);

-- ── ② 訂閱合約 ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS subscription (
  id text PRIMARY KEY,
  -- 帳本主體（new-api users.id），與 account_ledger.billing_user_id 同一把尺。
  billing_user_id integer NOT NULL,
  -- SKU 識別（兌換碼 name 標記裡的那個；見 subscription-sku.ts 的 SKU 註冊表）。
  sku text NOT NULL,
  -- 每期額度（quota 單位，1 幣 = 500000）——由實際購買金額決定，不由本表發明定價。
  term_quota bigint NOT NULL,
  -- 期長（秒）。
  term_seconds integer NOT NULL,
  -- 合約起算時刻（首次開通時刻；續期不移動它，只作審計/顯示錨點）。
  started_at timestamptz NOT NULL,
  -- 開通來源：'redemption:<兌換碼 id>'。UNIQUE ⇒ 同一張兌換碼不得開出第二份訂閱。
  source_ref text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS subscription_user_idx ON subscription (billing_user_id, sku);
