/** 转发逾时：与 `/v1` 路由的 maxDuration 同量级，生图/生视频是长请求。 */
export const DISPATCH_TIMEOUT_MS = 280_000;

/** agent 会话站内路径前缀（经 `/api/agent/biz` 代理到闸道 `/agent/v1/sessions`）。 */
export const AGENT_SESSIONS_PATH = "/api/agent/biz/sessions";
/** agent 帐号级设定路径（含 beast_mode）。 */
export const AGENT_SETTINGS_PATH = "/api/agent/biz/settings";
/** `run_agent` 轮询间隔；每次轮询一律走简化端点 `/sessions/{id}`（单次必须 <10s）。 */
export const RUN_AGENT_POLL_INTERVAL_MS = 2_000;
export const RUN_AGENT_DEFAULT_TIMEOUT_SECONDS = 180;
/** 上限同时硬编在 schema（maximum）；执行层再夹一次当防御。 */
export const RUN_AGENT_MAX_TIMEOUT_SECONDS = 300;
