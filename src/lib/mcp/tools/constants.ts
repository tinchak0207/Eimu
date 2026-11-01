/** 转发逾时：与 `/v1` 路由的 maxDuration 同量级，生图/生视频是长请求。 */
export const DISPATCH_TIMEOUT_MS = 280_000;

/** agent 会话站内路径前缀（经 `/api/agent/biz` 代理到闸道 `/agent/v1/sessions`）。 */
export const AGENT_SESSIONS_PATH = "/api/agent/biz/sessions";
/** agent 帐号级设定路径（含 beast_mode）。 */
export const AGENT_SETTINGS_PATH = "/api/agent/biz/settings";
/** 余额读口（与 get_quota 同一端点；导演 preflight 复用）。 */
export const QUOTA_PATH = "/api/v1/quota";
/** `run_agent` 轮询间隔；每次轮询一律走简化端点 `/sessions/{id}`（单次必须 <10s）。 */
export const RUN_AGENT_POLL_INTERVAL_MS = 2_000;
export const RUN_AGENT_DEFAULT_TIMEOUT_SECONDS = 180;
/** 上限同时硬编在 schema（maximum）；执行层再夹一次当防御。 */
export const RUN_AGENT_MAX_TIMEOUT_SECONDS = 300;

/** 导演入口有界等待（对照 fal 默认 45s）；超时回 processing + job_id，勿重提交。 */
export const EIMU_DIRECT_DEFAULT_WAIT_SECONDS = 45;
export const EIMU_DIRECT_MAX_WAIT_SECONDS = 45;
export const EIMU_JOB_DEFAULT_WAIT_SECONDS = 45;
export const EIMU_JOB_MAX_WAIT_SECONDS = 45;
export const EIMU_DIRECTOR_POLL_INTERVAL_MS = 2_000;
/** 超时后续查建议间隔（秒）。 */
export const EIMU_POLL_AFTER_SECONDS = 5;

/**
 * 导演报价粗估（币，与 get_quota.balance_coins 同单位）。
 * 非计费真源——只作 preflight／缺 budget 时的提示；正式扣费仍走业务帐本。
 */
export const EIMU_QUOTE_ESTIMATE_COINS = {
  quote: 0,
  plan: 2,
  full: 20,
} as const;
