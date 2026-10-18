// 手术 P1（CONTROL-PLANE-SURGERY.md）：计费闸拆除的提交路径插桩。
//
// env SURGERY_QUOTA_PRECHECK=1 时，提交先做一次无状态配额预检——只读 new-api
// users.quota（沿用 gateway-admin fetchGatewayUser 既有通路，即 /v1/quota 的
// 生产读法，不造新轮子；users.quota 为唯一真源，1 币 = 500000 quota）：
//   - 额度足够 → 回传 baseBillingAmount（等于即将由既有 reserve 执行器预扣的金额）。
//     禁止再写 billingAmount=0：0 会让 job 走零额快车道，事后投影再扣一遍。
//   - 额度不足 → 按现契约 402 insufficient_balance 拒单，不产生注定失败的 job。
//   - 上游不可达 → 不替闸门做主，原样回落现行阻塞式 reserve 路径：现有代码对
//     new-api 不可用的既有姿势是歧义结果冻结 billing_unknown、永不盲目重放
//     （billing-ledger classifyBillingFailure）——手术模式不让可用性变差。
//
// 映射依赖已拔除（暴君 2026-09-23 裁定，G1 刀）：配额权威在 new-api **user 层**
// （users.quota），biz_key_newapi_token 映射是残留物（26 把在用 key vs 15 条映射，
// upsertBizKeyTokenMapping 零生产呼叫者、最后一笔 2026-09-17），旧行为是「09-17
// 之后签发的任何 key 首次使用必 503」的地雷类别。现行语义：**无映射的 key 不再
// fail-closed**，与有映射的 key 逐位同路——照常走 user 额度预检（额度足 → 放行；
// 不足 → 既有 402 契约），不再有任何 token 映射查询。该 mapping 存取代码已删除，
// db/migrations/012 的表只作历史留存（现已零代码消费者）。
//
// 成员点数配额（REQ-B1，见 member-quota.ts，user 层模型）：成员 = new-api 另一个
// user，配额桶 = 该 user 的 users.quota（token 桶模型已被 09-23 只读探针硬否定）。
// 若该 key 的计费 user 已被登记为某团队主帐的成员，预检**先判成员 user 额度再走
// 既有计费户检查**，两种不足都是既有 402 insufficient_balance 契约，文案区分
// （成员额度不足／余额不足）。未被登记为成员的 key 整段跳过，不新增任何上游读取。
//
// 0 额任务（今日 TTS 即是）无帐可守，闸门不启动——不给任务路径添加今天没有的
// 故障面；日后 TTS 定价接入后把 baseBillingAmount 改为实际金额即自动受闸。
//
// env 未设/非 "1" = 原路径一字不变（影子期双模式并存，部署时才切流量）：
// 闸门直通返回原金额，连成员名册查询与网关读取都不发生。
//
// KEY 永不入 log：这里只记 biz key id（非密钥本体）、user id 与金额。

import { fetchGatewayUser } from "@/lib/gateway-admin";
import { QUOTA_PER_COIN } from "@/lib/quota-constants";
import { exceedsBudget } from "@/lib/task-budget";
import { accountLedgerStoreEnabled, ensureAccountOpening, readAvailableQuota } from "./account-ledger";
import type { GenerationSql } from "./database";
import {
  MEMBER_QUOTA_DISABLED_MESSAGE,
  MEMBER_QUOTA_INSUFFICIENT_MESSAGE,
  findMemberByUserId,
  readMemberQuota,
  type MemberQuotaSnapshot,
} from "./member-quota";
import {
  consumeMemberDailyQuota,
  quotaLimitStoreEnabled,
  readMemberQuotaLimitRow,
} from "./team-quota-limits";

export const SURGERY_QUOTA_PRECHECK_ENV = "SURGERY_QUOTA_PRECHECK";

/** 预检读数的硬上限（仅异常情况的天花板；同网单次 GET 常规个位数毫秒）。 */
export const QUOTA_PRECHECK_TIMEOUT_MS_DEFAULT = 3_000;

/**
 * /v1 对外 402 统一契约（暴君 2026-09-28 裁决：破坏性变更已核准，受害面近乎零）。
 *
 * 所有「余额／额度不足」出口一律回这一套：type 与 code 同码 `insufficient_balance`，
 * 文案逐字固定（含充值入口）。legacy reserve 分支与本闸门共用同一常数——客户端
 * 只认一种 402 形状，不再有第二套文案与码。非 402 的其他错误码一律不动。
 */
export const INSUFFICIENT_BALANCE_ERROR = {
  ok: false,
  status: 402,
  type: "insufficient_balance",
  code: "insufficient_balance",
  message: "余额不足，本次未扣费。充值：https://eimu.dev/pricing",
} as const;

/**
 * 单次任务预算超限的 402 契约（W5b）。
 *
 * 与 insufficient_balance 同族（都是 402、都保证「本次未扣费」），但码不同：
 * 这是**客户自己在请求体宣告的上限**被判超，不是帐户余额不足，故不导向充值页。
 * 具体数字（`estimated_coins` / `cap_coins`）由呼叫端在 decision 上一并回传，
 * route 放进 402 body 供前端显示；本常数只固定码与文案（对齐 insufficient_balance
 * 的中文句式，不另立格式）。
 */
export const TASK_BUDGET_EXCEEDED_ERROR = {
  ok: false,
  status: 402,
  type: "task_budget_exceeded",
  code: "task_budget_exceeded",
  message: "本次生成费用超过单次任务预算上限，本次未扣费。",
} as const;

/** 成员配额读数（预检注入点；默认读 new-api 成员 user 的 users.quota）。 */
type MemberQuotaReader = (memberUserId: number) => Promise<MemberQuotaSnapshot | null>;

/** 既有契约体：images/videos durable 分支对控制面基底不可用的原样码。 */
const CONTROL_PLANE_UNAVAILABLE = {
  ok: false,
  status: 503,
  type: "api_error",
  code: "control_plane_unavailable",
  message: "Generation control plane is temporarily unavailable.",
} as const;

type GatewayUserReader = typeof fetchGatewayUser;

export type QuotaPrecheckVerdict =
  | { verdict: "available"; quota: number }
  | { verdict: "insufficient"; quota: number; requiredQuota: number }
  | { verdict: "unreachable"; reason: string };

export type QuotaGateDecision =
  | { ok: true; billingAmount: number }
  | {
      ok: false;
      status: 402 | 503;
      type: "insufficient_balance" | "api_error" | "task_budget_exceeded";
      code: "insufficient_balance" | "control_plane_unavailable" | "task_budget_exceeded" | "daily_quota_exceeded";
      message: string;
      /**
       * 仅 task_budget_exceeded 携带（W5b）：本次任务的估算币值与客户宣告的上限。
       * route 据此填进 402 body 的 `estimated_coins` / `cap_coins`。
       */
      estimated_coins?: number;
      cap_coins?: number;
    };

/** 手术开关：仅字面 "1" 生效（未设/"0"/其他值 = 原路径）。 */
export function surgeryQuotaPrecheckEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[SURGERY_QUOTA_PRECHECK_ENV]?.trim() === "1";
}

function reasonOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

/** 可用余额读数（生效池口径的注入点）。 */
export type AvailableQuotaReader = (billingUserId: number) => Promise<number | null>;

/**
 * 暂停用生效池口径的时刻（见 defaultAvailableQuotaReader）：帐本读不到时，一段时间内
 * 直接走回落路径，不让每个提交都白等一次读取超时（任务路径的可用性优先）。
 */
export const LEDGER_READ_BACKOFF_MS = 60_000;
let poolReadBackoffUntil = 0;

export function resetPoolReadBackoff(): void {
  poolReadBackoffUntil = 0;
}

/**
 * REQ-D3 预设可用余额读法＝**生效池口径**（永久池 + 未过期订阅池）。
 *
 * 为什么先 `ensureAccountOpening`：帐本没有基线时 Σ 是 0，直接拿来当可用余额会把所有
 * 老用户判成「余额不足」——那才是真的把可用性弄差。基线的来源仍是 new-api 当下
 * users.quota（与 E1a 同一条路，幂等），故本路径与原本的「读一次上游」同价。
 *
 * 读不到（储存层未配置／基线不明／查询失败）一律回 null ⇒ 呼叫端回落原本的
 * users.quota 读法：**可用性不降级**是既有纪律，本刀不破；连续失败时退避
 * LEDGER_READ_BACKOFF_MS，避免每个请求都陪一次读取超时。
 *
 * 帐本读取走控制面正规连线（getGenerationSql，与 /v1/quota 同一条）——**不吃呼叫端
 * 注入的 sql 句柄**：预检的「一跳上游、零额外 IO」语义由呼叫端注入 readAvailableQuota
 * 明示改变，不在背后偷偷加 IO。
 */
async function defaultAvailableQuotaReader(billingUserId: number): Promise<number | null> {
  if (!accountLedgerStoreEnabled()) return null;
  if (Date.now() < poolReadBackoffUntil) return null;
  try {
    const opening = await ensureAccountOpening(billingUserId);
    if (opening.baselineQuota === null) return null;
    return await readAvailableQuota(billingUserId);
  } catch (error) {
    poolReadBackoffUntil = Date.now() + LEDGER_READ_BACKOFF_MS;
    console.error(
      `[quota-precheck] 帐本可用余额读取失败 user=${billingUserId}，回落上游读数 ` +
        `（${LEDGER_READ_BACKOFF_MS}ms 内不再尝试）：${reasonOf(error)}`,
    );
    return null;
  }
}

/**
 * 无状态配额三态预检：一次只读（REQ-D3 起＝**我方帐本的可用余额**，即永久池＋未过期
 * 订阅池；帐本不可用时回落 GET /api/user/{id} 的 users.quota），无执行器、无锁、
 * 无本地状态，不可能卡住任务路径（超时即判不可达）。
 */
export async function checkQuotaAvailable(
  input: { billingUserId: number; requiredQuota: number },
  deps: { fetchUser?: GatewayUserReader; timeoutMs?: number; readAvailableQuota?: AvailableQuotaReader } = {},
): Promise<QuotaPrecheckVerdict> {
  // user_id=0 是 007 迁移定义的「无从计费」应急通道，new-api 侧不存在该用户，
  // 直接判不可达（fail-closed），不发无谓请求。
  if (!Number.isInteger(input.billingUserId) || input.billingUserId <= 0) {
    return { verdict: "unreachable", reason: `no usable billing user (user_id=${input.billingUserId})` };
  }

  const timeoutMs = deps.timeoutMs ?? QUOTA_PRECHECK_TIMEOUT_MS_DEFAULT;

  // ① 生效池口径（REQ-D3）：读得到就用它决定放行／不足；读不到（null）才走 ②。
  const poolReader = deps.readAvailableQuota ?? defaultAvailableQuotaReader;
  const poolQuota = await withQuotaTimeout(
    poolReader(input.billingUserId).catch((error) => {
      console.error(`[quota-precheck] 可用余额读取异常 user=${input.billingUserId}：${reasonOf(error)}`);
      return null;
    }),
    timeoutMs,
  );
  if (typeof poolQuota === "number" && Number.isFinite(poolQuota)) {
    if (poolQuota >= input.requiredQuota) return { verdict: "available", quota: poolQuota };
    return { verdict: "insufficient", quota: poolQuota, requiredQuota: input.requiredQuota };
  }

  // ② 回落：既有 users.quota 读法（可用性不降级）。
  const fetchUser = deps.fetchUser ?? fetchGatewayUser;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const user = await Promise.race([
      fetchUser(input.billingUserId),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve(null);
        }, timeoutMs);
      }),
    ]);
    if (!user || !Number.isFinite(user.quota)) {
      return {
        verdict: "unreachable",
        reason: timedOut
          ? `new-api quota read timed out after ${timeoutMs}ms`
          : "new-api user lookup failed or returned no quota",
      };
    }
    if (user.quota >= input.requiredQuota) {
      return { verdict: "available", quota: user.quota };
    }
    return { verdict: "insufficient", quota: user.quota, requiredQuota: input.requiredQuota };
  } catch (error) {
    return { verdict: "unreachable", reason: reasonOf(error) };
  } finally {
    clearTimeout(timer);
  }
}

/** 逾时保护（回 null ＝ 超时；与 ② 的 Promise.race 同一姿势）。 */
async function withQuotaTimeout<T>(promise: Promise<T | null>, timeoutMs: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 提交路径计费闸：决定本次提交的金额（0 = 跳过阻塞式 reserve）或拒单。
 *
 * 返回 ok=true 时 billingAmount 交给 submitGenerationCommand——0 额任务由
 * job-repository 直送 queued；非 0 额 = 原路径（reserve 执行器照旧）。
 * 返回 ok=false 时携带现契约错误码，路由原样转成 OpenAI 风格错误体。
 */
export async function enforceQuotaGate(
  input: {
    bizKeyId: string;
    billingUserId: number;
    baseBillingAmount: number;
    /**
     * 单次任务预算上限（**币**，W5b）：呼叫端（route）从请求体宣告值透传。
     * 未给（undefined）⇒ 预算闸完全不启用，本函式行为与今天逐位元组相同（零回归）。
     */
    budgetCapCoins?: number;
  },
  deps: {
    fetchUser?: GatewayUserReader;
    sql?: GenerationSql;
    env?: Record<string, string | undefined>;
    timeoutMs?: number;
    /** 成员归属查询（默认读 team_member_quota 按 user_id；控制面未开时返回 null = 不受成员执法）。 */
    findMember?: typeof findMemberByUserId;
    /** 成员配额读数（默认读 new-api 成员 user）。 */
    readMemberQuota?: MemberQuotaReader;
    /** 可用余额读数（REQ-D3 生效池口径的注入点；默认读我方帐本）。 */
    readAvailableQuota?: AvailableQuotaReader;
  } = {},
): Promise<QuotaGateDecision> {
  // ── W5b 单次任务预算硬停 ────────────────────────────────────────────────────
  // 客户在请求体宣告 budgetCapCoins 才启用；没宣告 = 下面流程一字不动（零回归）。
  // 刻意放在 SURGERY_QUOTA_PRECHECK 开关之前：宣告上限是客户自负的硬天花板，与
  // 配额预检是否处于影子期无关——开关关掉不该让一个已宣告的安全上限静默失效。
  //
  // 估价 = 本次 baseBillingAmount 换算回币（route 端是 `币 × QUOTA_PER_COIN` 算出来
  // 的，这里忠实取其逆）；判定一律交 task-budget 的 exceedsBudget（单一真源），
  // 本档不另写一份比较逻辑。非有限数（NaN/Infinity）由 exceedsBudget 判为不触发。
  if (input.budgetCapCoins !== undefined) {
    const estimatedCoins = input.baseBillingAmount / QUOTA_PER_COIN;
    if (exceedsBudget(estimatedCoins, input.budgetCapCoins)) {
      console.log(
        `[quota-precheck] task budget exceeded bizKey=${input.bizKeyId} userId=${input.billingUserId} estimated_coins=${estimatedCoins} cap_coins=${input.budgetCapCoins}`,
      );
      return {
        ...TASK_BUDGET_EXCEEDED_ERROR,
        estimated_coins: estimatedCoins,
        cap_coins: input.budgetCapCoins,
      };
    }
  }

  const env = deps.env ?? process.env;
  if (!surgeryQuotaPrecheckEnabled(env) || input.baseBillingAmount <= 0) {
    return { ok: true, billingAmount: input.baseBillingAmount };
  }

  // 无 token 映射的 key 不再 fail-closed（2026-09-23 G1 裁定，见档头）：配额权威
  // 在 user 层，映射层已从本档拆除，这里直接进下面的成员／计费户 user 额度检查。

  // 消耗面次序（REQ-B1，user 层）：成员 = new-api 另一个 user，配额桶就是该
  // user 自己的 users.quota（内核一律执法）。成员 key 的 billingUserId 正是成员
  // user，所以成员判定与读数都走 user 层：findMemberByUserId + readMemberQuota
  // （= fetchGatewayUser），不依赖 token 任何一面。
  // 不在成员名册里的 key（未纳入成员配额管理）整段跳过 —— 零上游读取，行为与
  // 手术前逐位等价。
  const member = await (deps.findMember ?? findMemberByUserId)(input.billingUserId, deps.sql);
  if (member) {
    if (!member.enabled) {
      console.log(`[quota-precheck] member disabled memberUser=${member.memberUserId} memberKey=${member.memberKeyId}`);
      return {
        ...INSUFFICIENT_BALANCE_ERROR,
        // 成员额度停在管理员手上，补救是找团队主帐号——不套主帐的充值文案（指引会错）。
        message: MEMBER_QUOTA_DISABLED_MESSAGE,
      };
    }
    const readMemberQuotaForMember: MemberQuotaReader =
      deps.readMemberQuota ?? ((memberUserId: number) => readMemberQuota(memberUserId));
    // 上游读数同样带超时：任务路径不许被一次慢请求卡住（与主帐读数同一纪律）。
    const timeoutMs = deps.timeoutMs ?? QUOTA_PRECHECK_TIMEOUT_MS_DEFAULT;
    let memberReadTimedOut = false;
    let memberTimer: ReturnType<typeof setTimeout> | undefined;
    let snapshot: MemberQuotaSnapshot | null;
    try {
      snapshot = await Promise.race([
        readMemberQuotaForMember(member.memberUserId).catch(() => null),
        new Promise<null>((resolve) => {
          memberTimer = setTimeout(() => {
            memberReadTimedOut = true;
            resolve(null);
          }, timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(memberTimer);
    }
    // 读不到或 unlimited：受管的成员却读不出可执法的配额桶 = 上游抽风／配置漂移，
    // fail-closed（不静默把没核过额度的单放进内核）。这是本档**唯一**的 503 出口，
    // 仅对已登记的成员生效；token 映射缺失那条 fail-closed 已于 2026-09-23 拔除。
    if (!snapshot || snapshot.unlimited) {
      console.error(
        `[quota-precheck] fail-closed: managed member user ${member.memberUserId} has no enforceable member quota (${snapshot ? "unlimited" : memberReadTimedOut ? `read timed out after ${timeoutMs}ms` : "unreadable"})`,
      );
      return { ...CONTROL_PLANE_UNAVAILABLE };
    }
    if (snapshot.remaining < input.baseBillingAmount) {
      console.log(
        `[quota-precheck] member quota insufficient memberUser=${member.memberUserId} remaining=${snapshot.remaining} required=${input.baseBillingAmount}`,
      );
      return {
        ok: false,
        status: 402,
        type: "insufficient_balance",
        code: "insufficient_balance",
        message: MEMBER_QUOTA_INSUFFICIENT_MESSAGE,
      };
    }
    if (quotaLimitStoreEnabled()) {
      const limitRow = await readMemberQuotaLimitRow(member.memberUserId, deps.sql);
      if (limitRow?.mode === "daily") {
        const daily = await consumeMemberDailyQuota(
          {
            teamUserId: member.teamUserId,
            memberUserId: member.memberUserId,
            costQuota: input.baseBillingAmount,
          },
          { sql: deps.sql },
        );
        if (!daily.ok) {
          return {
            ok: false,
            status: 402,
            type: "insufficient_balance",
            code: "daily_quota_exceeded",
            message: daily.message,
          };
        }
      }
    }
  }

  const precheck = await checkQuotaAvailable(
    { billingUserId: input.billingUserId, requiredQuota: input.baseBillingAmount },
    {
      fetchUser: deps.fetchUser,
      timeoutMs: deps.timeoutMs,
      // REQ-D3：可用余额改读生效池口径（永久池＋未过期订阅池）。帐本读取走**控制面
      // 正规连线**（getGenerationSql，与 /v1/quota 同一条）；刻意不吃呼叫端注入的
      // sql 句柄——那是成员名册／测试用的句柄，预检的「一跳上游、零额外 IO」语义
      // 由呼叫端自行注入 readAvailableQuota 来改变，不偷偷加 IO。
      readAvailableQuota: deps.readAvailableQuota,
    },
  );

  if (precheck.verdict === "insufficient") {
    return { ...INSUFFICIENT_BALANCE_ERROR };
  }

  if (precheck.verdict === "unreachable") {
    // 不可达：沿用现有代码对 new-api 不可用的既有姿势——回落原 reserve 路径，
    // 由 billing-ledger 按既有分类冻结/重试，闸门不发明新语义。
    console.error(
      `[quota-precheck] new-api unreachable for biz key ${input.bizKeyId} userId=${input.billingUserId}; falling back to incumbent reserve: ${precheck.reason}`,
    );
    return { ok: true, billingAmount: input.baseBillingAmount };
  }

  console.log(
    `[quota-precheck] pass bizKey=${input.bizKeyId} userId=${input.billingUserId} quota=${precheck.quota} required=${input.baseBillingAmount}; incumbent reserve amount=${input.baseBillingAmount}`,
  );
  // 余额足够不等于免费。金额交给 job 的 pending reserve（reserveGenerationBilling 单次预扣）。
  // 不在这里再调 reserve：此刻还没有 job，再扣会和执行器双扣。billing_amount 非 0，投影不扫这笔。
  return { ok: true, billingAmount: input.baseBillingAmount };
}
