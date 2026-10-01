import type { FailureExplanation } from "./failure-record";
import type { FailureClass } from "./types";

export interface ClassifiedFailure {
  failureClass: FailureClass;
  /**
   * 產品級的「可否重放」判斷。
   *
   * ⚠️ FG-02/03（2026-09-23）：**禁止**用這個欄位驅動自動重放裁決。
   * 重放許可唯一來源是 `operation-registry.ts` 的封閉 registry（未宣告＝禁）。
   * 本欄位只保留為顯示／統計用途；調度器與 worker 不得再讀它做重放決定。
   */
  retryable: boolean;
  /**
   * 產品級的「應該換渠道」判斷。
   *
   * ⚠️ FG-02/03：同樣**禁止**驅動重放／換道裁決（換道＝重放的一種）。
   * 只保留為顯示／診斷用途。
   */
  switchSupplier: boolean;
  /**
   * 隔離維度：允許把 supplier/account 標成 cooldown/disabled（保護動作，不是重放）。
   * 這一維仍由分類驅動——它只會「少做」不會「多做」，且不花上游與用戶的錢。
   */
  quarantineSupplier: boolean;
  /**
   * 冷卻截止（保護動作）。仍由分類驅動；餵給調度器的租約/冷卻閘，不餵重放裁決。
   */
  cooldownUntil: Date | null;
  detail: string;
  httpStatus?: number;
}

export class SupplierRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryAfter?: string | null,
    readonly responseBody?: string,
    /**
     * 適配器顯式裁定失敗類別（INC-0830-VIDEO）。詞表分類靠關鍵字猜測，會把
     * 「上游成功但我們解析不出 URL」誤判成 502 overloaded 而熔斷無辜渠道。
     * 適配器自己最清楚錯誤語義，顯式裁定優先於詞表。
     */
    readonly explicitClass?: FailureClass,
    /** 適配器拋錯時已知的上游任務 id，worker 回填 generation_attempt.provider_task_id。 */
    readonly providerTaskId?: string,
    /**
     * 上游**真實** HTTP 狀態（D-3，2026-09-23）：部分適配器（metaso/openai-video/newapi-video）
     * 刻意把非 401/403/429 的狀態改寫成 502 當作供應商側錯誤；那個改寫是**產品解釋**，
     * 不是原生事實。產品解釋決定隔離/冷卻（語義不動），但確定性 4xx 的重放裁決必須看到
     * 上游原文狀態——否則真 400 被看成 502，會被當成暫時性錯誤重放到預算上限。
     * 故此欄位原樣帶上 `response.status`，由 `captureNativeFailure` 存進
     * `FailureRecord.native.status`（優先於被改寫的 status）。
     */
    readonly upstreamStatus?: number,
  ) {
    super(message);
    this.name = "SupplierRequestError";
  }
}

function retryAfterDate(value: string | null | undefined, now: Date): Date {
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return new Date(now.getTime() + seconds * 1000);
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime()) && parsed > now) return parsed;
  }
  return new Date(now.getTime() + 60_000);
}

/**
 * 上游欠費/額度不足時賬號冷卻時長（2026-09-27 INC-VIDEO-0927）。
 *
 * 欠費是帳務狀態，不是憑證失效：冷卻而非永久隔離，讓 recoverExpiredCooldowns
 * 在充值後自動撿回渠道（30 分鐘足夠人工或自動充值落地，也足夠避免對欠費上游
 * 空轉燒 attempt）。憑證類（authentication）仍走 disabled 人工恢復。
 */
const QUOTA_EXHAUSTED_ACCOUNT_COOLDOWN_MS = 30 * 60_000;

/** 計價配置錯的 capability 冷卻（H2）：只作用於 capability，不碰 supplier/account。 */
const PRICING_CONFIG_CAPABILITY_COOLDOWN_MS = 180_000;

/**
 * FG-04：顯示層人話表。**只讀不改寫**——這些字串只允許出現在
 * `FailureRecord.explanation.humanMessage` 與展示層，永不回寫上游錯誤原文
 * （原生事實住在 `FailureRecord.native`，逐字保留）。
 */
const HUMAN_FAILURE_MESSAGES: Record<FailureClass, string> = {
  user_input: "請求參數不被該模型接受，請調整提示詞或尺寸後重試。",
  content_rejected: "內容被上游合規審查拒絕，請修改提示詞或參考圖後重試。",
  model_unsupported: "當前渠道不支援這個模型，已自動切換其它渠道。",
  authentication: "上游憑證失效，已暫停該渠道並等待人工恢復。",
  quota_exhausted: "上游額度不足，已停止重試，請充值或恢復其它渠道。",
  rate_limited: "上游限流，稍後會自動重試。",
  overloaded: "上游暫時過載，正在換渠道重試。",
  network: "網絡異常，正在重試。",
  malformed_output: "上游返回的成品無法解碼，已換渠道重試。",
  empty_result: "上游返回空結果，已換渠道重試。",
  artifact_download: "成品下載失敗，已換渠道重試。",
  upstream_protocol: "上游返回成功但解析失敗（我方協議問題），已記錄待查。",
  pricing_config: "該模型的計價配置暫不完整（我方問題），已換其它渠道並記錄待修。",
  deadline_exceeded: "等待預算用完；若上游仍在執行，結果會在對帳後補交付。",
  cancelled: "任務已被取消。",
  unknown: "生成失敗，正在重試。",
};

/** 顯示層人話（純函數）。不接觸、不覆寫原生錯誤欄位。 */
export function humanMessageForFailureClass(failureClass: FailureClass): string {
  return HUMAN_FAILURE_MESSAGES[failureClass] ?? HUMAN_FAILURE_MESSAGES.unknown;
}

/**
 * 把分類結果轉成 FG-01 的產品解釋物件（寫進 `FailureRecord.explanation`）。
 * 原生錯誤原文（`detail`）**原樣帶入不改寫**；人話另存 `humanMessage`。
 */
export function explainFailure(failure: ClassifiedFailure): FailureExplanation {
  return {
    failureClass: failure.failureClass,
    detail: failure.detail,
    humanMessage: humanMessageForFailureClass(failure.failureClass),
    httpStatus: failure.httpStatus ?? null,
  };
}

function containsAny(value: string, patterns: string[]): boolean {
  return patterns.some((pattern) => value.includes(pattern));
}

export function classifySupplierFailure(error: unknown, now = new Date()): ClassifiedFailure {
  const requestError = error instanceof SupplierRequestError ? error : null;
  const status = requestError?.status;
  const detail = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
  const normalized = `${detail} ${requestError?.responseBody ?? ""}`.toLowerCase();

  // 適配器顯式裁定優先於詞表（INC-0830-VIDEO）。「上游成功但我們解析不出輸出」
  // 是我們的解析 bug，不是上游過載：不觸發任何 cooldown/熔斷，任務換渠道重試。
  if (requestError?.explicitClass) {
    const explicit = requestError.explicitClass;
    return { failureClass: explicit, retryable: true, switchSupplier: true, quarantineSupplier: false, cooldownUntil: null, detail, httpStatus: status };
  }

  // H2：我方計價配置錯（如 `no per_request price configured for resolution "2k"`）
  // 是本地配置缺口，不是上游故障。必須先於 status>=500 / 詞表判定：適配器常把它
  // 包成 502，若落入 overloaded 桶會觸發供應商級 180s 冷卻，連坐同供應商其它健康
  // capability。這裡只冷卻該 capability（scheduler 以 capabilityFailure 處理，
  // 不動 supplier/account），retryable=false：同 capability 重試必然同錯。
  if (/no [\w-]+ price configured/.test(normalized)) {
    return { failureClass: "pricing_config", retryable: false, switchSupplier: true, quarantineSupplier: false, cooldownUntil: new Date(now.getTime() + PRICING_CONFIG_CAPABILITY_COOLDOWN_MS), detail, httpStatus: status };
  }

  if (error instanceof Error && error.name === "AbortError") {
    return { failureClass: "network", retryable: true, switchSupplier: true, quarantineSupplier: false, cooldownUntil: new Date(now.getTime() + 30_000), detail };
  }
  if (status === 451 || containsAny(normalized, ["legal_error", "content_rejected", "compliance filter"])) {
    return { failureClass: "content_rejected", retryable: false, switchSupplier: false, quarantineSupplier: false, cooldownUntil: null, detail, httpStatus: status };
  }
  if (containsAny(normalized, ["missing image output", "empty image result", "result was empty"])) {
    return { failureClass: "empty_result", retryable: true, switchSupplier: true, quarantineSupplier: false, cooldownUntil: new Date(now.getTime() + 5 * 60_000), detail, httpStatus: status };
  }
  if (containsAny(normalized, ["failed to download image", "artifact download failed", "output download failed"])) {
    return { failureClass: "artifact_download", retryable: true, switchSupplier: true, quarantineSupplier: false, cooldownUntil: new Date(now.getTime() + 60_000), detail, httpStatus: status };
  }
  if (normalized.includes("malformed image") || normalized.includes("undecodable image")) {
    return { failureClass: "malformed_output", retryable: true, switchSupplier: true, quarantineSupplier: false, cooldownUntil: new Date(now.getTime() + 5 * 60_000), detail, httpStatus: status };
  }
  // 順序鐵律（2026-09-27 INC-VIDEO-0927b）：欠費判定必須先於 401/403 鑑權判定。
  // xiaoyxiao 欠費以 HTTP 401 + insufficient_user_quota 回來，若先進鑑權桶就會
  // quarantineSupplier → 帳號被標 disabled、任務排隊空轉到 deadline。
  if (status === 402 || containsAny(normalized, [
    "quota exhausted", "insufficient quota", "insufficient_quota", "insufficient_user_quota",
    "credit balance", "余额不足", "积分余额不足", "积分不足", "欠费", "额度不足",
    "预扣费额度失败", "剩余额度", "额度已用完",
    "insufficient balance", "insufficient credit", "balance exhausted", "(1008)",
  ])) {
    return {
      failureClass: "quota_exhausted",
      retryable: false,
      switchSupplier: true,
      quarantineSupplier: false,
      cooldownUntil: new Date(now.getTime() + QUOTA_EXHAUSTED_ACCOUNT_COOLDOWN_MS),
      detail,
      httpStatus: status,
    };
  }
  if (status === 401 || status === 403 || containsAny(normalized, ["invalid api key", "invalid_api_key", "unauthorized", "token expired"])) {
    return { failureClass: "authentication", retryable: true, switchSupplier: true, quarantineSupplier: true, cooldownUntil: null, detail, httpStatus: status };
  }
  if (status === 429 || containsAny(normalized, ["rate limit", "too many requests"])) {
    return { failureClass: "rate_limited", retryable: true, switchSupplier: true, quarantineSupplier: false, cooldownUntil: retryAfterDate(requestError?.retryAfter, now), detail, httpStatus: status };
  }
  // 暴君裁定（2026-08-29 事故）：上游欠費重試無意義。舊詞表只有英文，metaso 的
  // 中文文案「H3 積分餘額不足 (1008)」匹配不到 → 502 掉進下方 overloaded 桶，
  // 任務在退避循環裡空轉到 deadline，真話只躺在 attempt 表。擴成中英雙語 +
  // hailuo 錯誤碼帶括號形態（避免裸數字誤配）。改為 fail-fast：retryable=false，
  // 寧可立刻誠實失敗 + 退款，也不要靜默空轉。單供應商渠道因此放棄換渠道重試。
  //
  // 2026-09-27 修正「充值 ≠ 自動恢復」：原 quarantineSupplier=true 把賬號設成
  // disabled，而 recoverExpiredCooldowns 只恢復 'cooldown'（disabled 是「憑證
  // 吊銷待人工」語義，刻意不自愈）→ 上游一充值，渠道仍被永久擋住，必須人工 SQL
  // （實錄 cangyuansuanli 08-31 欠費 disabled 後 27 天零單；napi 09-19 同）。
  // 欠費是帳務狀態、不是憑證失效：改成「長 cooldown + 不自癒賬號」——
  // fail-fast 不變（retryable=false，仍換渠道），只是冷卻到期後由
  // recoverExpiredCooldowns 自動撿回。憑證類（authentication）維持 quarantine。
  // 2026-09-27 INC-VIDEO-0927（升級既有裁定，同 metaso 事故同型）：new-api fork
  // 的欠費文案是「预扣费额度失败, 用户剩余额度: ¥1.440000, 需要预扣费额度: ¥3.900000」
  // 與錯誤碼 `insufficient_user_quota`——舊詞表（余额不足/额度不足/insufficient_quota）
  // 全部匹配不到 → 502 掉進 overloaded 桶 → retryable → 任務在退避循環空轉到
  // deadline（實錄：seedance-2.0/-fast/-mini/-2.5-720p 共 72 筆 deadline_exceeded，
  // 真話只躺在 attempt 表）。補齊中英詞與錯誤碼。
  if (status === 408 || (status !== undefined && status >= 500) || containsAny(normalized, ["system under load", "overloaded", "service unavailable", "temporarily unavailable"])) {
    // 3 分鐘而非 30 秒（2026-08-27）：first_party 排序永遠壓過 managed_pool，
    // 30s 冷卻到期又被選中→再失敗，單個 job 的 attempt 預算被同一渠道燒光
    // （實測 adobe2api「temporarily unavailable」31 次、sub2api 29 次）。
    return { failureClass: "overloaded", retryable: true, switchSupplier: true, quarantineSupplier: false, cooldownUntil: new Date(now.getTime() + 180_000), detail, httpStatus: status };
  }
  if (status === 400 || status === 422 || containsAny(normalized, ["invalid prompt", "invalid image", "unsupported size", "invalid size", "reference image", "content policy", "moderation_blocked"])) {
    const content = containsAny(normalized, ["content policy", "moderation", "safety"]);
    return { failureClass: content ? "content_rejected" : "user_input", retryable: false, switchSupplier: false, quarantineSupplier: false, cooldownUntil: null, detail, httpStatus: status };
  }
  if (status === 404 || containsAny(normalized, ["model not found", "model_not_found", "unsupported model", "does not support", "requires an image model", "not an image model"])) {
    // 供應商不認這個模型名（例如 sub2api images endpoint 只認上游命名，收到
    // 平台 id 會回 400 "images endpoint requires an image model"）。這是渠道
    // capability 錯配，不是使用者輸入錯：不可重試原渠道、禁用該 capability、
    // 換下一個供應商。（並集合併 2026-08-29：VPS 版兩個詞組 + 註釋，本地版
    // status === 404 分支，兩邊都保留。）
    return { failureClass: "model_unsupported", retryable: false, switchSupplier: false, quarantineSupplier: false, cooldownUntil: null, detail, httpStatus: status };
  }
  if (containsAny(normalized, ["econnreset", "enotfound", "fetch failed", "socket hang up", "network", "timed out", "timeout"])) {
    return { failureClass: "network", retryable: true, switchSupplier: true, quarantineSupplier: false, cooldownUntil: new Date(now.getTime() + 30_000), detail, httpStatus: status };
  }
  return { failureClass: "unknown", retryable: true, switchSupplier: true, quarantineSupplier: false, cooldownUntil: new Date(now.getTime() + 30_000), detail, httpStatus: status };
}
