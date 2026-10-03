// 手術 P1（CONTROL-PLANE-SURGERY.md）：計費閘拆除的提交路徑插樁。
//
// env SURGERY_QUOTA_PRECHECK=1 時，提交先做一次無狀態配額預檢——只讀 new-api
// users.quota（沿用 gateway-admin fetchGatewayUser 既有通路，即 /v1/quota 的
// 生產讀法，不造新輪子；users.quota 為唯一真源，1 幣 = 500000 quota）：
//   - 額度足夠 → 以 billingAmount=0 提交：createGenerationJob 對 0 額任務直接
//     落 queued（job-repository 零額快車道），阻塞式 reserve 執行器整段被跳過，
//     計費交事後投影（本階段未實現，帳面真源 = new-api logs type=2）；
//     commit/refund 機制原樣保留（0 額時天然 no-op，不動帳）。
//   - 額度不足 → 按現契約 402 insufficient_balance 拒單，不產生註定失敗的 job。
//   - 上游不可達 → 不替閘門做主，原樣回落現行阻塞式 reserve 路徑：現有代碼對
//     new-api 不可用的既有姿勢是歧義結果凍結 billing_unknown、永不盲目重放
//     （billing-ledger classifyBillingFailure）——手術模式不讓可用性變差。
//
// 映射依賴已拔除（暴君 2026-09-23 裁定，G1 刀）：配額權威在 new-api **user 層**
// （users.quota），biz_key_newapi_token 映射是殘留物（26 把在用 key vs 15 條映射，
// upsertBizKeyTokenMapping 零生產呼叫者、最後一筆 2026-09-17），舊行為是「09-17
// 之後簽發的任何 key 首次使用必 503」的地雷類別。現行語義：**無映射的 key 不再
// fail-closed**，與有映射的 key 逐位同路——照常走 user 額度預檢（額度足 → 放行；
// 不足 → 既有 402 契約），不再有任何 token 映射查詢。該 mapping 存取代碼已刪除，
// db/migrations/012 的表只作歷史留存（現已零代碼消費者）。
//
// 成員點數配額（REQ-B1，見 member-quota.ts，user 層模型）：成員 = new-api 另一個
// user，配額桶 = 該 user 的 users.quota（token 桶模型已被 09-23 只讀探針硬否定）。
// 若該 key 的計費 user 已被登記為某團隊主帳的成員，預檢**先判成員 user 額度再走
// 既有計費戶檢查**，兩種不足都是既有 402 insufficient_balance 契約，文案區分
// （成員額度不足／餘額不足）。未被登記為成員的 key 整段跳過，不新增任何上游讀取。
//
// 0 額任務（今日 TTS 即是）無帳可守，閘門不啟動——不給任務路徑添加今天沒有的
// 故障面；日後 TTS 定價接入後把 baseBillingAmount 改為實際金額即自動受閘。
//
// env 未設/非 "1" = 原路徑一字不變（影子期雙模式並存，部署時才切流量）：
// 閘門直通返回原金額，連成員名冊查詢與網關讀取都不發生。
//
// KEY 永不入 log：這裡只記 biz key id（非密鑰本體）、user id 與金額。

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

export const SURGERY_QUOTA_PRECHECK_ENV = "SURGERY_QUOTA_PRECHECK";

/** 預檢讀數的硬上限（僅異常情況的天花板；同網單次 GET 常規個位數毫秒）。 */
export const QUOTA_PRECHECK_TIMEOUT_MS_DEFAULT = 3_000;

/**
 * /v1 對外 402 統一契約（暴君 2026-09-28 裁決：破壞性變更已核准，受害面近乎零）。
 *
 * 所有「餘額／額度不足」出口一律回這一套：type 與 code 同碼 `insufficient_balance`，
 * 文案逐字固定（含充值入口）。legacy reserve 分支與本閘門共用同一常數——客戶端
 * 只認一種 402 形狀，不再有第二套文案與碼。非 402 的其他錯誤碼一律不動。
 */
export const INSUFFICIENT_BALANCE_ERROR = {
  ok: false,
  status: 402,
  type: "insufficient_balance",
  code: "insufficient_balance",
  message: "余额不足，本次未扣费。充值：https://eimu.dev/pricing",
} as const;

/**
 * 單次任務預算超限的 402 契約（W5b）。
 *
 * 與 insufficient_balance 同族（都是 402、都保證「本次未扣費」），但碼不同：
 * 這是**客戶自己在請求體宣告的上限**被判超，不是帳戶餘額不足，故不導向充值頁。
 * 具體數字（`estimated_coins` / `cap_coins`）由呼叫端在 decision 上一併回傳，
 * route 放進 402 body 供前端顯示；本常數只固定碼與文案（對齊 insufficient_balance
 * 的中文句式，不另立格式）。
 */
export const TASK_BUDGET_EXCEEDED_ERROR = {
  ok: false,
  status: 402,
  type: "task_budget_exceeded",
  code: "task_budget_exceeded",
  message: "本次生成费用超过单次任务预算上限，本次未扣费。",
} as const;

/** 成員配額讀數（預檢注入點；默認讀 new-api 成員 user 的 users.quota）。 */
type MemberQuotaReader = (memberUserId: number) => Promise<MemberQuotaSnapshot | null>;

/** 既有契約體：images/videos durable 分支對控制面基底不可用的原樣碼。 */
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
      code: "insufficient_balance" | "control_plane_unavailable" | "task_budget_exceeded";
      message: string;
      /**
       * 僅 task_budget_exceeded 攜帶（W5b）：本次任務的估算幣值與客戶宣告的上限。
       * route 據此填進 402 body 的 `estimated_coins` / `cap_coins`。
       */
      estimated_coins?: number;
      cap_coins?: number;
    };

/** 手術開關：僅字面 "1" 生效（未設/"0"/其他值 = 原路徑）。 */
export function surgeryQuotaPrecheckEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[SURGERY_QUOTA_PRECHECK_ENV]?.trim() === "1";
}

function reasonOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

/** 可用餘額讀數（生效池口徑的注入點）。 */
export type AvailableQuotaReader = (billingUserId: number) => Promise<number | null>;

/**
 * 暫停用生效池口徑的時刻（見 defaultAvailableQuotaReader）：帳本讀不到時，一段時間內
 * 直接走回落路徑，不讓每個提交都白等一次讀取超時（任務路徑的可用性優先）。
 */
export const LEDGER_READ_BACKOFF_MS = 60_000;
let poolReadBackoffUntil = 0;

export function resetPoolReadBackoff(): void {
  poolReadBackoffUntil = 0;
}

/**
 * REQ-D3 預設可用餘額讀法＝**生效池口徑**（永久池 + 未過期訂閱池）。
 *
 * 為什麼先 `ensureAccountOpening`：帳本沒有基線時 Σ 是 0，直接拿來當可用餘額會把所有
 * 老用戶判成「餘額不足」——那才是真的把可用性弄差。基線的來源仍是 new-api 當下
 * users.quota（與 E1a 同一條路，幂等），故本路徑與原本的「讀一次上游」同價。
 *
 * 讀不到（儲存層未配置／基線不明／查詢失敗）一律回 null ⇒ 呼叫端回落原本的
 * users.quota 讀法：**可用性不降級**是既有紀律，本刀不破；連續失敗時退避
 * LEDGER_READ_BACKOFF_MS，避免每個請求都陪一次讀取超時。
 *
 * 帳本讀取走控制面正規連線（getGenerationSql，與 /v1/quota 同一條）——**不吃呼叫端
 * 注入的 sql 句柄**：預檢的「一跳上游、零額外 IO」語義由呼叫端注入 readAvailableQuota
 * 明示改變，不在背後偷偷加 IO。
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
      `[quota-precheck] 帳本可用餘額讀取失敗 user=${billingUserId}，回落上游讀數 ` +
        `（${LEDGER_READ_BACKOFF_MS}ms 內不再嘗試）：${reasonOf(error)}`,
    );
    return null;
  }
}

/**
 * 無狀態配額三態預檢：一次只讀（REQ-D3 起＝**我方帳本的可用餘額**，即永久池＋未過期
 * 訂閱池；帳本不可用時回落 GET /api/user/{id} 的 users.quota），無執行器、無鎖、
 * 無本地狀態，不可能卡住任務路徑（超時即判不可達）。
 */
export async function checkQuotaAvailable(
  input: { billingUserId: number; requiredQuota: number },
  deps: { fetchUser?: GatewayUserReader; timeoutMs?: number; readAvailableQuota?: AvailableQuotaReader } = {},
): Promise<QuotaPrecheckVerdict> {
  // user_id=0 是 007 遷移定義的「無從計費」應急通道，new-api 側不存在該用戶，
  // 直接判不可達（fail-closed），不發無謂請求。
  if (!Number.isInteger(input.billingUserId) || input.billingUserId <= 0) {
    return { verdict: "unreachable", reason: `no usable billing user (user_id=${input.billingUserId})` };
  }

  const timeoutMs = deps.timeoutMs ?? QUOTA_PRECHECK_TIMEOUT_MS_DEFAULT;

  // ① 生效池口徑（REQ-D3）：讀得到就用它決定放行／不足；讀不到（null）才走 ②。
  const poolReader = deps.readAvailableQuota ?? defaultAvailableQuotaReader;
  const poolQuota = await withQuotaTimeout(
    poolReader(input.billingUserId).catch((error) => {
      console.error(`[quota-precheck] 可用餘額讀取異常 user=${input.billingUserId}：${reasonOf(error)}`);
      return null;
    }),
    timeoutMs,
  );
  if (typeof poolQuota === "number" && Number.isFinite(poolQuota)) {
    if (poolQuota >= input.requiredQuota) return { verdict: "available", quota: poolQuota };
    return { verdict: "insufficient", quota: poolQuota, requiredQuota: input.requiredQuota };
  }

  // ② 回落：既有 users.quota 讀法（可用性不降級）。
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

/** 逾時保護（回 null ＝ 超時；與 ② 的 Promise.race 同一姿勢）。 */
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
 * 提交路徑計費閘：決定本次提交的金額（0 = 跳過阻塞式 reserve）或拒單。
 *
 * 返回 ok=true 時 billingAmount 交給 submitGenerationCommand——0 額任務由
 * job-repository 直送 queued；非 0 額 = 原路徑（reserve 執行器照舊）。
 * 返回 ok=false 時攜帶現契約錯誤碼，路由原樣轉成 OpenAI 風格錯誤體。
 */
export async function enforceQuotaGate(
  input: {
    bizKeyId: string;
    billingUserId: number;
    baseBillingAmount: number;
    /**
     * 單次任務預算上限（**幣**，W5b）：呼叫端（route）從請求體宣告值透傳。
     * 未給（undefined）⇒ 預算閘完全不啟用，本函式行為與今天逐位元組相同（零回歸）。
     */
    budgetCapCoins?: number;
  },
  deps: {
    fetchUser?: GatewayUserReader;
    sql?: GenerationSql;
    env?: Record<string, string | undefined>;
    timeoutMs?: number;
    /** 成員歸屬查詢（默認讀 team_member_quota 按 user_id；控制面未開時返回 null = 不受成員執法）。 */
    findMember?: typeof findMemberByUserId;
    /** 成員配額讀數（默認讀 new-api 成員 user）。 */
    readMemberQuota?: MemberQuotaReader;
    /** 可用餘額讀數（REQ-D3 生效池口徑的注入點；默認讀我方帳本）。 */
    readAvailableQuota?: AvailableQuotaReader;
  } = {},
): Promise<QuotaGateDecision> {
  // ── W5b 單次任務預算硬停 ────────────────────────────────────────────────────
  // 客戶在請求體宣告 budgetCapCoins 才啟用；沒宣告 = 下面流程一字不動（零回歸）。
  // 刻意放在 SURGERY_QUOTA_PRECHECK 開關之前：宣告上限是客戶自負的硬天花板，與
  // 配額預檢是否處於影子期無關——開關關掉不該讓一個已宣告的安全上限靜默失效。
  //
  // 估價 = 本次 baseBillingAmount 換算回幣（route 端是 `幣 × QUOTA_PER_COIN` 算出來
  // 的，這裡忠實取其逆）；判定一律交 task-budget 的 exceedsBudget（單一真源），
  // 本檔不另寫一份比較邏輯。非有限數（NaN/Infinity）由 exceedsBudget 判為不觸發。
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

  // 無 token 映射的 key 不再 fail-closed（2026-09-23 G1 裁定，見檔頭）：配額權威
  // 在 user 層，映射層已從本檔拆除，這裡直接進下面的成員／計費戶 user 額度檢查。

  // 消耗面次序（REQ-B1，user 層）：成員 = new-api 另一個 user，配額桶就是該
  // user 自己的 users.quota（內核一律執法）。成員 key 的 billingUserId 正是成員
  // user，所以成員判定與讀數都走 user 層：findMemberByUserId + readMemberQuota
  // （= fetchGatewayUser），不依賴 token 任何一面。
  // 不在成員名冊裡的 key（未納入成員配額管理）整段跳過 —— 零上游讀取，行為與
  // 手術前逐位等價。
  const member = await (deps.findMember ?? findMemberByUserId)(input.billingUserId, deps.sql);
  if (member) {
    if (!member.enabled) {
      console.log(`[quota-precheck] member disabled memberUser=${member.memberUserId} memberKey=${member.memberKeyId}`);
      return {
        ...INSUFFICIENT_BALANCE_ERROR,
        // 成員額度停在管理員手上，補救是找團隊主帳號——不套主帳的充值文案（指引會錯）。
        message: MEMBER_QUOTA_DISABLED_MESSAGE,
      };
    }
    const readMemberQuotaForMember: MemberQuotaReader =
      deps.readMemberQuota ?? ((memberUserId: number) => readMemberQuota(memberUserId));
    // 上游讀數同樣帶超時：任務路徑不許被一次慢請求卡住（與主帳讀數同一紀律）。
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
    // 讀不到或 unlimited：受管的成員卻讀不出可執法的配額桶 = 上游抽風／配置漂移，
    // fail-closed（不靜默把沒核過額度的單放進內核）。這是本檔**唯一**的 503 出口，
    // 僅對已登記的成員生效；token 映射缺失那條 fail-closed 已於 2026-09-23 拔除。
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
  }

  const precheck = await checkQuotaAvailable(
    { billingUserId: input.billingUserId, requiredQuota: input.baseBillingAmount },
    {
      fetchUser: deps.fetchUser,
      timeoutMs: deps.timeoutMs,
      // REQ-D3：可用餘額改讀生效池口徑（永久池＋未過期訂閱池）。帳本讀取走**控制面
      // 正規連線**（getGenerationSql，與 /v1/quota 同一條）；刻意不吃呼叫端注入的
      // sql 句柄——那是成員名冊／測試用的句柄，預檢的「一跳上游、零額外 IO」語義
      // 由呼叫端自行注入 readAvailableQuota 來改變，不偷偷加 IO。
      readAvailableQuota: deps.readAvailableQuota,
    },
  );

  if (precheck.verdict === "insufficient") {
    return { ...INSUFFICIENT_BALANCE_ERROR };
  }

  if (precheck.verdict === "unreachable") {
    // 不可達：沿用現有代碼對 new-api 不可用的既有姿勢——回落原 reserve 路徑，
    // 由 billing-ledger 按既有分類凍結/重試，閘門不發明新語義。
    console.error(
      `[quota-precheck] new-api unreachable for biz key ${input.bizKeyId} userId=${input.billingUserId}; falling back to incumbent reserve: ${precheck.reason}`,
    );
    return { ok: true, billingAmount: input.baseBillingAmount };
  }

  console.log(
    `[quota-precheck] pass bizKey=${input.bizKeyId} userId=${input.billingUserId} quota=${precheck.quota} required=${input.baseBillingAmount}; skipping blocking reserve (billing -> post-hoc projection)`,
  );
  return { ok: true, billingAmount: 0 };
}
