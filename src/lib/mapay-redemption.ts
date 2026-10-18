import { generationDatabaseConfigured, getGenerationSql, type GenerationSql } from "./generation-core/database";
import { QUOTA_PER_COIN } from "./quota-constants";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type EnvLike = Record<string, string | undefined>;

type GatewayResult<T> = {
  success: boolean;
  message?: string;
  data?: T;
};

type RedemptionSearchData = {
  items?: NewApiRedemption[];
};

export type NewApiRedemption = {
  id: number;
  key: string;
  name: string;
  quota: number;
  status: number;
};

export type FulfilledRedemption = {
  key: string;
  created: boolean;
};

export type MapayRedemptionPlan = {
  id: string;
  name: string;
  price: number;
  coins: number;
};

function gatewayBaseUrl(env: EnvLike): string {
  // [riskclose 2026-09-27] TLS gateway channel (bare-IP plaintext /api closed).
  // [riskclose 2026-10-04] 生产环境**必须**显式配置 GATEWAY_BASE_URL：旧实现在 env 缺失时
  // 静默回退到硬编码默认值，2026-09-19 真实订单 IMGMU7UH9SFF9A21D 就是走到一条已死的
  // 默认 URL 被支付商推送 6 次全回 500（钱路定时炸弹）。钱路不得静默回退。
  const configured = env.GATEWAY_BASE_URL?.trim();
  if (configured) return configured;
  if (env.NODE_ENV === "production") {
    throw new Error(
      "Missing GATEWAY_BASE_URL：生产环境 mPay 兑换码履约必须显式配置网关地址，禁止回退到硬编码默认值。",
    );
  }
  return "http://localhost:3001";
}

function bearer(value: string): string {
  const token = value.replace(/^Bearer\s+/i, "").trim();
  return `Bearer ${token}`;
}

function adminHeaders(env: EnvLike): Record<string, string> {
  const token =
    env.GATEWAY_ADMIN_ACCESS_TOKEN ??
    env.GATEWAY_ADMIN_TOKEN ??
    env.NEW_API_ADMIN_ACCESS_TOKEN ??
    "";
  const userId = env.GATEWAY_ADMIN_USER_ID ?? env.NEW_API_ADMIN_USER_ID ?? "";

  if (!token.trim() || !userId.trim()) {
    throw new Error("Missing New API admin redemption credentials.");
  }

  return {
    Authorization: bearer(token),
    "Content-Type": "application/json",
    "New-Api-User": userId.trim(),
  };
}

async function readGatewayResult<T>(response: Response): Promise<GatewayResult<T>> {
  const text = await response.text();
  if (!text) return { success: false, message: `Gateway returned ${response.status}` };

  try {
    return JSON.parse(text) as GatewayResult<T>;
  } catch {
    return { success: false, message: text.slice(0, 300) };
  }
}

export function mapayOrderRedemptionName(orderId: string): string {
  return `MP${orderId.slice(-18)}`;
}

export function mapayPlanQuota(plan: MapayRedemptionPlan): number {
  return plan.coins * QUOTA_PER_COIN;
}

function exactRedemption(items: NewApiRedemption[] | undefined, name: string, quota: number) {
  return items?.find((item) => item.name === name && item.quota === quota && item.key);
}

let generatingStateReady: Promise<void> | null = null;

/** mapay_order_intake.state 现有值是 received/fulfilled/parked。待处理＝received。占位改成 generating。 */
async function ensureGeneratingState(sql: GenerationSql): Promise<void> {
  if (!generatingStateReady) {
    generatingStateReady = (async () => {
      await sql`
        ALTER TABLE mapay_order_intake
        DROP CONSTRAINT IF EXISTS mapay_order_intake_state_check
      `;
      await sql`
        ALTER TABLE mapay_order_intake
        ADD CONSTRAINT mapay_order_intake_state_check
        CHECK (state IN ('received', 'generating', 'fulfilled', 'parked'))
      `;
    })().catch((error) => {
      generatingStateReady = null;
      throw error;
    });
  }
  return generatingStateReady;
}

type ClaimResult = "claimed" | "lost" | "skip";

/**
 * 创建前占位。有本地订单行就条件更新 state：只有一个并发能从 received 改成 generating。
 * 没有行则按 out_trade_no 唯一键插入。抢不到返回 lost，调用方不得再 POST 上游。
 * 没有控制面库（回跳/Vercel）返回 skip。
 */
async function claimRedemptionCreate(orderId: string): Promise<ClaimResult> {
  if (!generationDatabaseConfigured()) return "skip";
  let sql: GenerationSql;
  try {
    sql = getGenerationSql();
  } catch {
    return "skip";
  }

  try {
    await ensureGeneratingState(sql);
    const updated = await sql<{ out_trade_no: string }[]>`
      UPDATE mapay_order_intake
      SET state = 'generating', updated_at = now()
      WHERE out_trade_no = ${orderId} AND state = 'received'
      RETURNING out_trade_no
    `;
    if (updated.length > 0) return "claimed";

    const current = await sql<{ state: string }[]>`
      SELECT state FROM mapay_order_intake WHERE out_trade_no = ${orderId} LIMIT 1
    `;
    if (current.length === 0) {
      const inserted = await sql<{ out_trade_no: string }[]>`
        INSERT INTO mapay_order_intake (out_trade_no, raw_params, state)
        VALUES (${orderId}, ${sql.json({})}, 'generating')
        ON CONFLICT (out_trade_no) DO NOTHING
        RETURNING out_trade_no
      `;
      return inserted.length > 0 ? "claimed" : "lost";
    }
    return "lost";
  } catch (error) {
    try {
      await sql`
        CREATE TABLE IF NOT EXISTS mapay_redemption_claim (
          out_trade_no text PRIMARY KEY,
          state text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        )
      `;
      const inserted = await sql<{ out_trade_no: string }[]>`
        INSERT INTO mapay_redemption_claim (out_trade_no, state)
        VALUES (${orderId}, 'generating')
        ON CONFLICT (out_trade_no) DO NOTHING
        RETURNING out_trade_no
      `;
      return inserted.length > 0 ? "claimed" : "lost";
    } catch (fallbackError) {
      console.error(
        "[mapay-redemption] claim skipped",
        error instanceof Error ? error.message : String(error),
        fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
      );
      return "skip";
    }
  }
}

async function searchMapayRedemption(
  input: { orderId: string; plan: MapayRedemptionPlan },
  env: EnvLike,
  fetcher: FetchLike,
): Promise<NewApiRedemption | null> {
  const name = mapayOrderRedemptionName(input.orderId);
  const quota = mapayPlanQuota(input.plan);
  const headers = adminHeaders(env);
  const baseUrl = gatewayBaseUrl(env);
  const search = await fetcher(
    `${baseUrl}/api/redemption/search?keyword=${encodeURIComponent(name)}`,
    { headers, cache: "no-store" },
  );
  const searchResult = await readGatewayResult<RedemptionSearchData>(search);
  if (!search.ok || !searchResult.success) {
    throw new Error(searchResult.message ?? "Failed to search redemption code.");
  }
  return exactRedemption(searchResult.data?.items, name, quota) ?? null;
}

/** 只查已有兑换码，不创建。 */
export async function findMapayRedemption(
  input: { orderId: string; plan: MapayRedemptionPlan },
  env: EnvLike = process.env,
  fetcher: FetchLike = fetch,
): Promise<FulfilledRedemption | null> {
  const existing = await searchMapayRedemption(input, env, fetcher);
  return existing ? { key: existing.key, created: false } : null;
}

const redemptionInflight = new Map<string, Promise<FulfilledRedemption>>();

async function createMapayRedemption(
  input: { orderId: string; plan: MapayRedemptionPlan },
  env: EnvLike,
  fetcher: FetchLike,
): Promise<FulfilledRedemption> {
  const claim = await claimRedemptionCreate(input.orderId);
  const existing = await searchMapayRedemption(input, env, fetcher);
  if (existing) return { key: existing.key, created: false };
  if (claim === "lost") {
    throw new Error("Redemption already claimed; upstream key is not ready.");
  }

  const name = mapayOrderRedemptionName(input.orderId);
  const quota = mapayPlanQuota(input.plan);
  const create = await fetcher(`${gatewayBaseUrl(env)}/api/redemption/`, {
    method: "POST",
    headers: adminHeaders(env),
    body: JSON.stringify({
      name,
      count: 1,
      quota,
      expired_time: 0,
    }),
    cache: "no-store",
  });
  const createResult = await readGatewayResult<string[]>(create);
  const key = createResult.data?.[0];
  if (!create.ok || !createResult.success || !key) {
    throw new Error(createResult.message ?? "Failed to create redemption code.");
  }
  return { key, created: true };
}

export function fulfillMapayRedemption(
  input: { orderId: string; plan: MapayRedemptionPlan },
  env: EnvLike = process.env,
  fetcher: FetchLike = fetch,
): Promise<FulfilledRedemption> {
  const pending = redemptionInflight.get(input.orderId);
  if (pending) {
    return pending.then((winner) => ({ key: winner.key, created: false }));
  }
  const run = createMapayRedemption(input, env, fetcher).finally(() => {
    redemptionInflight.delete(input.orderId);
  });
  redemptionInflight.set(input.orderId, run);
  return run;
}
