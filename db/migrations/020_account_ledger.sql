-- 020: account_ledger —— 我方帐本（REQ-E1a「余额权威与跨层对帐」）。
--
-- ┌─────────────────────────────────────────────────────────────────────────────┐
-- │ 裁定（暴君 2026-09-23）：**客户可见余额的权威归我方帐本**。                   │
-- │ new-api 的 users.quota 降格为「上游供货水位」＋内核执法点，不再是对外真相。   │
-- │ 依据＝waoowaoo BA-07「账本唯一 writer」：new-api 内核 relay 前扣 quota 是     │
-- │ 第二个 writer，与我方帐本双写（B1 真转移让两层同时变动）⇒ 必须有对帐。       │
-- └─────────────────────────────────────────────────────────────────────────────┘
--
-- 铁律（append-only 帐本，违者 = 余额撒谎，立即返工）：
--   1. 本表只允许 INSERT。禁 UPDATE / DELETE（含人工排障、含迁移脚本）。
--      修正一笔错帐 = 再 INSERT 一笔反向 adjustment，不是改历史。
--   2. 每笔帐必须带 `idempotency_ref`（UNIQUE）——写入端的重放不得双算。
--   3. 每一列必须指回真实来源：`source`（谁写的）＋ `source_ref`（哪一笔外部事实），
--      消费/退款列必须带 operation_id（billing_operation.id）或 job_id。
--   4. amount 是有号数（正 = 加项，负 = 减项），单位 = new-api quota（1 币 = 500000）。
--      方向由 entry_type 决定并由应用层强制（见 account-ledger.ts 的 sign 纪律）。
--
-- 余额公式（唯一口径）：balance(user) = Σ amount WHERE billing_user_id = user。
--
-- 加项 / 减项（完整清单，新增类型必须先改本注释与 account-ledger.ts 的判别表）：
--   ± opening      上线基线：以 new-api 当时 users.quota 种入（可为负，亦可为 0——
--                    0 基线是一句真话「此时此刻这个身份没有可入帐的历史净额」，且它
--                    同时定下「哪一刻之后的充值才该入帐」的时间界线，故允许 0）。
--                   历史净额已含在此，故本表只记基线之后的增量 —— 不得双算既有历史。
--   recharge     +  充值入帐（new-api 兑换码被使用时；用于 mPay 与人工发码两路）
--   refund       +  任务退款（billing_operation operation='refund' applied 对应的上游 credit）
--   transfer_in  +  B1 成员收到分配（主帐 → 成员，成员侧帐）
--   adjustment   ±  管理员加减额度（建户初始额度 / 人工补正；必须带 note）
--   consumption  −  消费扣费（legacy reserve 的上游扣款、gate path 投影扣款）
--   transfer_out −  B1 主帐划出给成员（主帐侧帐）
--   不进本表的事件：billing_operation operation='writeoff'（平台自身损失，不影响
--   用户 users.quota，记进本表 = 凭空扣用户钱）；reserve/commit 中不改上游余额的那些
--   （gate path 的 0 额 reserve、只作结算凭证的 commit）。
--
-- 为何不存 balance_after：快照栏位一旦写错就是永久谎言，且与 append-only 的
-- 更正方式（补一笔反向帐）互相矛盾。余额一律由 Σ amount 当场算（有具名测试）。

CREATE TABLE IF NOT EXISTS account_ledger (
  id text PRIMARY KEY,
  -- 帐本主体：new-api users.id（= biz_api_key.user_id）。团队成员有自己的桶 ⇒ 自己的列。
  billing_user_id integer NOT NULL,
  entry_type text NOT NULL CHECK (entry_type IN (
    'opening', 'recharge', 'consumption', 'refund', 'transfer_out', 'transfer_in', 'adjustment'
  )),
  -- 有号金额（quota 单位）：正 = 加项，负 = 减项；0 无意义，禁止（唯一例外：opening
  -- 的 0 基线，见上方注释——它承载「基线时刻」这个资讯而非金额）。
  amount bigint NOT NULL,
  -- 写入者：'seed' | 'billing-projection' | 'billing-ledger' | 'member-quota' |
  --         'redemption-sync' | 'admin'（自由字串，便于对帐报表归因）。
  source text NOT NULL,
  -- 外部事实的位址：'job:<id>' / 'billing-op:<id>' / 'transfer:<id>' /
  -- 'redemption:<id>' / 'manual:<actor>:<iso>'。对帐报表以此把差值指回具体来源。
  source_ref text NOT NULL,
  -- 一次且仅一次的判重键（重放同一件事必然算出同一个值）。
  idempotency_ref text NOT NULL UNIQUE,
  job_id text,
  operation_id text,
  -- 转移对手方（transfer_out 的收方 / transfer_in 的付方）；非转移为 NULL。
  counterparty_user_id integer,
  note text,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- 金额非零（表级约束，因 opening 的 0 基线是唯一例外，需要看 entry_type）。
  CONSTRAINT account_ledger_amount_nonzero CHECK (amount <> 0 OR entry_type = 'opening')
);

-- 余额与对帐的主查询路径：按身份取全部帐本行（时间序，让报表可逐笔解释）。
CREATE INDEX IF NOT EXISTS account_ledger_user_created_idx
  ON account_ledger (billing_user_id, created_at, id);

-- 对帐的帐本侧扫描：按入帐时间找「这段时间动过谁」。
CREATE INDEX IF NOT EXISTS account_ledger_created_idx
  ON account_ledger (created_at);

-- 写入端回查（例如 refund 是否已入帐）用 source_ref。
CREATE INDEX IF NOT EXISTS account_ledger_source_ref_idx
  ON account_ledger (source_ref);

-- 不加 FOREIGN KEY：帐本必须在 job 行被清理/归档后仍然存活（与 job_events 同一条理由）。
