-- 020: account_ledger —— 我方帳本（REQ-E1a「餘額權威與跨層對帳」）。
--
-- ┌─────────────────────────────────────────────────────────────────────────────┐
-- │ 裁定（暴君 2026-09-23）：**客戶可見餘額的權威歸我方帳本**。                   │
-- │ new-api 的 users.quota 降格為「上游供貨水位」＋內核執法點，不再是對外真相。   │
-- │ 依據＝waoowaoo BA-07「賬本唯一 writer」：new-api 內核 relay 前扣 quota 是     │
-- │ 第二個 writer，與我方帳本雙寫（B1 真轉移讓兩層同時變動）⇒ 必須有對帳。       │
-- └─────────────────────────────────────────────────────────────────────────────┘
--
-- 鐵律（append-only 帳本，違者 = 餘額撒謊，立即返工）：
--   1. 本表只允許 INSERT。禁 UPDATE / DELETE（含人工排障、含遷移腳本）。
--      修正一筆錯帳 = 再 INSERT 一筆反向 adjustment，不是改歷史。
--   2. 每筆帳必須帶 `idempotency_ref`（UNIQUE）——寫入端的重放不得雙算。
--   3. 每一列必須指回真實來源：`source`（誰寫的）＋ `source_ref`（哪一筆外部事實），
--      消費/退款列必須帶 operation_id（billing_operation.id）或 job_id。
--   4. amount 是有號數（正 = 加項，負 = 減項），單位 = new-api quota（1 幣 = 500000）。
--      方向由 entry_type 決定並由應用層強制（見 account-ledger.ts 的 sign 紀律）。
--
-- 餘額公式（唯一口徑）：balance(user) = Σ amount WHERE billing_user_id = user。
--
-- 加項 / 減項（完整清單，新增類型必須先改本註釋與 account-ledger.ts 的判別表）：
--   ± opening      上線基線：以 new-api 當時 users.quota 種入（可為負，亦可為 0——
--                    0 基線是一句真話「此時此刻這個身份沒有可入帳的歷史淨額」，且它
--                    同時定下「哪一刻之後的充值才該入帳」的時間界線，故允許 0）。
--                   歷史淨額已含在此，故本表只記基線之後的增量 —— 不得雙算既有歷史。
--   recharge     +  充值入帳（new-api 兌換碼被使用時；用於 mPay 與人工發碼兩路）
--   refund       +  任務退款（billing_operation operation='refund' applied 對應的上游 credit）
--   transfer_in  +  B1 成員收到分配（主帳 → 成員，成員側帳）
--   adjustment   ±  管理員加減額度（建戶初始額度 / 人工補正；必須帶 note）
--   consumption  −  消費扣費（legacy reserve 的上游扣款、gate path 投影扣款）
--   transfer_out −  B1 主帳劃出給成員（主帳側帳）
--   不進本表的事件：billing_operation operation='writeoff'（平台自身損失，不影響
--   用戶 users.quota，記進本表 = 憑空扣用戶錢）；reserve/commit 中不改上游餘額的那些
--   （gate path 的 0 額 reserve、只作結算憑證的 commit）。
--
-- 為何不存 balance_after：快照欄位一旦寫錯就是永久謊言，且與 append-only 的
-- 更正方式（補一筆反向帳）互相矛盾。餘額一律由 Σ amount 當場算（有具名測試）。

CREATE TABLE IF NOT EXISTS account_ledger (
  id text PRIMARY KEY,
  -- 帳本主體：new-api users.id（= biz_api_key.user_id）。團隊成員有自己的桶 ⇒ 自己的列。
  billing_user_id integer NOT NULL,
  entry_type text NOT NULL CHECK (entry_type IN (
    'opening', 'recharge', 'consumption', 'refund', 'transfer_out', 'transfer_in', 'adjustment'
  )),
  -- 有號金額（quota 單位）：正 = 加項，負 = 減項；0 無意義，禁止（唯一例外：opening
  -- 的 0 基線，見上方註釋——它承載「基線時刻」這個資訊而非金額）。
  amount bigint NOT NULL,
  -- 寫入者：'seed' | 'billing-projection' | 'billing-ledger' | 'member-quota' |
  --         'redemption-sync' | 'admin'（自由字串，便於對帳報表歸因）。
  source text NOT NULL,
  -- 外部事實的位址：'job:<id>' / 'billing-op:<id>' / 'transfer:<id>' /
  -- 'redemption:<id>' / 'manual:<actor>:<iso>'。對帳報表以此把差值指回具體來源。
  source_ref text NOT NULL,
  -- 一次且僅一次的判重鍵（重放同一件事必然算出同一個值）。
  idempotency_ref text NOT NULL UNIQUE,
  job_id text,
  operation_id text,
  -- 轉移對手方（transfer_out 的收方 / transfer_in 的付方）；非轉移為 NULL。
  counterparty_user_id integer,
  note text,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- 金額非零（表級約束，因 opening 的 0 基線是唯一例外，需要看 entry_type）。
  CONSTRAINT account_ledger_amount_nonzero CHECK (amount <> 0 OR entry_type = 'opening')
);

-- 餘額與對帳的主查詢路徑：按身份取全部帳本行（時間序，讓報表可逐筆解釋）。
CREATE INDEX IF NOT EXISTS account_ledger_user_created_idx
  ON account_ledger (billing_user_id, created_at, id);

-- 對帳的帳本側掃描：按入帳時間找「這段時間動過誰」。
CREATE INDEX IF NOT EXISTS account_ledger_created_idx
  ON account_ledger (created_at);

-- 寫入端回查（例如 refund 是否已入帳）用 source_ref。
CREATE INDEX IF NOT EXISTS account_ledger_source_ref_idx
  ON account_ledger (source_ref);

-- 不加 FOREIGN KEY：帳本必須在 job 行被清理/歸檔後仍然存活（與 job_events 同一條理由）。
