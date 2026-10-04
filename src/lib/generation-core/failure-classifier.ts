import type { FailureExplanation } from "./failure-record";
import type { FailureClass } from "./types";

export interface ClassifiedFailure {
  failureClass: FailureClass;
  /**
   * 产品级的「可否重放」判断。
   *
   * ⚠️ FG-02/03（2026-09-23）：**禁止**用这个栏位驱动自动重放裁决。
   * 重放许可唯一来源是 `operation-registry.ts` 的封闭 registry（未宣告＝禁）。
   * 本栏位只保留为显示／统计用途；调度器与 worker 不得再读它做重放决定。
   */
  retryable: boolean;
  /**
   * 产品级的「应该换渠道」判断。
   *
   * ⚠️ FG-02/03：同样**禁止**驱动重放／换道裁决（换道＝重放的一种）。
   * 只保留为显示／诊断用途。
   */
  switchSupplier: boolean;
  /**
   * 隔离维度：允许把 supplier/account 标成 cooldown/disabled（保护动作，不是重放）。
   * 这一维仍由分类驱动——它只会「少做」不会「多做」，且不花上游与用户的钱。
   */
  quarantineSupplier: boolean;
  /**
   * 冷却截止（保护动作）。仍由分类驱动；喂给调度器的租约/冷却闸，不喂重放裁决。
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
     * 适配器显式裁定失败类别（INC-0830-VIDEO）。词表分类靠关键字猜测，会把
     * 「上游成功但我们解析不出 URL」误判成 502 overloaded 而熔断无辜渠道。
     * 适配器自己最清楚错误语义，显式裁定优先于词表。
     */
    readonly explicitClass?: FailureClass,
    /** 适配器抛错时已知的上游任务 id，worker 回填 generation_attempt.provider_task_id。 */
    readonly providerTaskId?: string,
    /**
     * 上游**真实** HTTP 状态（D-3，2026-09-23）：部分适配器（metaso/openai-video/newapi-video）
     * 刻意把非 401/403/429 的状态改写成 502 当作供应商侧错误；那个改写是**产品解释**，
     * 不是原生事实。产品解释决定隔离/冷却（语义不动），但确定性 4xx 的重放裁决必须看到
     * 上游原文状态——否则真 400 被看成 502，会被当成暂时性错误重放到预算上限。
     * 故此栏位原样带上 `response.status`，由 `captureNativeFailure` 存进
     * `FailureRecord.native.status`（优先于被改写的 status）。
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
 * 上游欠费/额度不足时账号冷却时长（2026-09-27 INC-VIDEO-0927）。
 *
 * 欠费是帐务状态，不是凭证失效：冷却而非永久隔离，让 recoverExpiredCooldowns
 * 在充值后自动捡回渠道（30 分钟足够人工或自动充值落地，也足够避免对欠费上游
 * 空转烧 attempt）。凭证类（authentication）仍走 disabled 人工恢复。
 */
const QUOTA_EXHAUSTED_ACCOUNT_COOLDOWN_MS = 30 * 60_000;

/** 计价配置错的 capability 冷却（H2）：只作用于 capability，不碰 supplier/account。 */
const PRICING_CONFIG_CAPABILITY_COOLDOWN_MS = 180_000;

/**
 * FG-04：显示层人话表。**只读不改写**——这些字串只允许出现在
 * `FailureRecord.explanation.humanMessage` 与展示层，永不回写上游错误原文
 * （原生事实住在 `FailureRecord.native`，逐字保留）。
 */
const HUMAN_FAILURE_MESSAGES: Record<FailureClass, string> = {
  user_input: "请求参数不被该模型接受，请调整提示词或尺寸后重试。",
  content_rejected: "内容被上游合规审查拒绝，请修改提示词或参考图后重试。",
  model_unsupported: "当前渠道不支援这个模型，已自动切换其它渠道。",
  authentication: "上游凭证失效，已暂停该渠道并等待人工恢复。",
  quota_exhausted: "上游额度不足，已停止重试，请充值或恢复其它渠道。",
  rate_limited: "上游限流，稍后会自动重试。",
  overloaded: "上游暂时过载，正在换渠道重试。",
  network: "网络异常，正在重试。",
  malformed_output: "上游返回的成品无法解码，已换渠道重试。",
  empty_result: "上游返回空结果，已换渠道重试。",
  artifact_download: "成品下载失败，已换渠道重试。",
  upstream_protocol: "上游返回成功但解析失败（我方协议问题），已记录待查。",
  pricing_config: "该模型的计价配置暂不完整（我方问题），已换其它渠道并记录待修。",
  deadline_exceeded: "等待预算用完；若上游仍在执行，结果会在对帐后补交付。",
  cancelled: "任务已被取消。",
  unknown: "生成失败，正在重试。",
};

/** 显示层人话（纯函数）。不接触、不覆写原生错误栏位。 */
export function humanMessageForFailureClass(failureClass: FailureClass): string {
  return HUMAN_FAILURE_MESSAGES[failureClass] ?? HUMAN_FAILURE_MESSAGES.unknown;
}

/**
 * 把分类结果转成 FG-01 的产品解释物件（写进 `FailureRecord.explanation`）。
 * 原生错误原文（`detail`）**原样带入不改写**；人话另存 `humanMessage`。
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

  // 适配器显式裁定优先于词表（INC-0830-VIDEO）。「上游成功但我们解析不出输出」
  // 是我们的解析 bug，不是上游过载：不触发任何 cooldown/熔断，任务换渠道重试。
  if (requestError?.explicitClass) {
    const explicit = requestError.explicitClass;
    return { failureClass: explicit, retryable: true, switchSupplier: true, quarantineSupplier: false, cooldownUntil: null, detail, httpStatus: status };
  }

  // H2：我方计价配置错（如 `no per_request price configured for resolution "2k"`）
  // 是本地配置缺口，不是上游故障。必须先于 status>=500 / 词表判定：适配器常把它
  // 包成 502，若落入 overloaded 桶会触发供应商级 180s 冷却，连坐同供应商其它健康
  // capability。这里只冷却该 capability（scheduler 以 capabilityFailure 处理，
  // 不动 supplier/account），retryable=false：同 capability 重试必然同错。
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
  // 顺序铁律（2026-09-27 INC-VIDEO-0927b）：欠费判定必须先于 401/403 鉴权判定。
  // xiaoyxiao 欠费以 HTTP 401 + insufficient_user_quota 回来，若先进鉴权桶就会
  // quarantineSupplier → 帐号被标 disabled、任务排队空转到 deadline。
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
  // 暴君裁定（2026-08-29 事故）：上游欠费重试无意义。旧词表只有英文，metaso 的
  // 中文文案「H3 积分余额不足 (1008)」匹配不到 → 502 掉进下方 overloaded 桶，
  // 任务在退避循环里空转到 deadline，真话只躺在 attempt 表。扩成中英双语 +
  // hailuo 错误码带括号形态（避免裸数字误配）。改为 fail-fast：retryable=false，
  // 宁可立刻诚实失败 + 退款，也不要静默空转。单供应商渠道因此放弃换渠道重试。
  //
  // 2026-09-27 修正「充值 ≠ 自动恢复」：原 quarantineSupplier=true 把账号设成
  // disabled，而 recoverExpiredCooldowns 只恢复 'cooldown'（disabled 是「凭证
  // 吊销待人工」语义，刻意不自愈）→ 上游一充值，渠道仍被永久挡住，必须人工 SQL
  // （实录 cangyuansuanli 08-31 欠费 disabled 后 27 天零单；napi 09-19 同）。
  // 欠费是帐务状态、不是凭证失效：改成「长 cooldown + 不自愈账号」——
  // fail-fast 不变（retryable=false，仍换渠道），只是冷却到期后由
  // recoverExpiredCooldowns 自动捡回。凭证类（authentication）维持 quarantine。
  // 2026-09-27 INC-VIDEO-0927（升级既有裁定，同 metaso 事故同型）：new-api fork
  // 的欠费文案是「预扣费额度失败, 用户剩余额度: ¥1.440000, 需要预扣费额度: ¥3.900000」
  // 与错误码 `insufficient_user_quota`——旧词表（余额不足/额度不足/insufficient_quota）
  // 全部匹配不到 → 502 掉进 overloaded 桶 → retryable → 任务在退避循环空转到
  // deadline（实录：seedance-2.0/-fast/-mini/-2.5-720p 共 72 笔 deadline_exceeded，
  // 真话只躺在 attempt 表）。补齐中英词与错误码。
  if (status === 408 || (status !== undefined && status >= 500) || containsAny(normalized, ["system under load", "overloaded", "service unavailable", "temporarily unavailable"])) {
    // 3 分钟而非 30 秒（2026-08-27）：first_party 排序永远压过 managed_pool，
    // 30s 冷却到期又被选中→再失败，单个 job 的 attempt 预算被同一渠道烧光
    // （实测 adobe2api「temporarily unavailable」31 次、sub2api 29 次）。
    return { failureClass: "overloaded", retryable: true, switchSupplier: true, quarantineSupplier: false, cooldownUntil: new Date(now.getTime() + 180_000), detail, httpStatus: status };
  }
  if (status === 400 || status === 422 || containsAny(normalized, ["invalid prompt", "invalid image", "unsupported size", "invalid size", "reference image", "content policy", "moderation_blocked"])) {
    const content = containsAny(normalized, ["content policy", "moderation", "safety"]);
    return { failureClass: content ? "content_rejected" : "user_input", retryable: false, switchSupplier: false, quarantineSupplier: false, cooldownUntil: null, detail, httpStatus: status };
  }
  if (status === 404 || containsAny(normalized, ["model not found", "model_not_found", "unsupported model", "does not support", "requires an image model", "not an image model"])) {
    // 供应商不认这个模型名（例如 sub2api images endpoint 只认上游命名，收到
    // 平台 id 会回 400 "images endpoint requires an image model"）。这是渠道
    // capability 错配，不是使用者输入错：不可重试原渠道、禁用该 capability、
    // 换下一个供应商。（并集合并 2026-08-29：VPS 版两个词组 + 注释，本地版
    // status === 404 分支，两边都保留。）
    return { failureClass: "model_unsupported", retryable: false, switchSupplier: false, quarantineSupplier: false, cooldownUntil: null, detail, httpStatus: status };
  }
  if (containsAny(normalized, ["econnreset", "enotfound", "fetch failed", "socket hang up", "network", "timed out", "timeout"])) {
    return { failureClass: "network", retryable: true, switchSupplier: true, quarantineSupplier: false, cooldownUntil: new Date(now.getTime() + 30_000), detail, httpStatus: status };
  }
  return { failureClass: "unknown", retryable: true, switchSupplier: true, quarantineSupplier: false, cooldownUntil: new Date(now.getTime() + 30_000), detail, httpStatus: status };
}
