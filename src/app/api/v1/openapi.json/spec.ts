import { getSiteUrlFromEnv } from "@/lib/site-url";

import { COMPONENTS } from "./spec-components";
import { PATHS, bearerAuth } from "./spec-paths";

/**
 * OpenAPI 3.1 spec — 从代码派生，不手写漂移。
 *
 * 覆盖 10 个端点：7 图像 + 3 影片。
 * 认证一律走 `Authorization: Bearer sk-biz-<key>`，限流 60rpm。
 * 认证通过的所有回应都带 x-ratelimit-* 头（轮询端点 consumeRateLimit:false 不消耗额度）。
 */

export const SPEC = {
  openapi: "3.1.0",
  info: {
    title: "Eimu API",
    description:
      "OpenAI 相容的图像 + 影片生成 API，供 AI 聚合平台与 agent 自我发现。\n\n" +
      "认证：`Authorization: Bearer sk-biz-<key>`。限流 60 requests/minute，所有认证通过的回应都带 `x-ratelimit-*` 头。\n\n" +
      "生图/生影片为非同步模式：POST 回 202 task，轮询 GET /v1/images/{id}（或 /v1/videos/{id}）直到 `status = succeeded | failed`。\n" +
      "错误体为 OpenAI 风格 `{ error: { message, type, code, param, trace_id } }`；trace_id 同步落在 `X-Request-Id` 回应头。",
    version: "1.0.0",
  },
  servers: [
    { url: `${getSiteUrlFromEnv()}/v1`, description: "Production" },
    { url: "https://image.tinchak0207.xyz/v1", description: "Legacy (旧域名，仍可用)" },
  ],
  security: [bearerAuth],
  paths: PATHS,
  components: COMPONENTS,
} as const;
