export interface ServerConfig {
  /** Normalized API base URL without a trailing slash, e.g. https://image.tinchak0207.xyz/api/v1 */
  apiBase: string;
  /** Biz API key (sk-biz-...) read from environment only. Never logged. */
  apiKey: string;
  /** Poll interval in milliseconds used while waiting for async tasks. */
  pollIntervalMs: number;
  /** Overall timeout in milliseconds for waiting on a single async task. */
  pollTimeoutMs: number;
}

export const DEFAULT_API_BASE = "https://image.tinchak0207.xyz/api/v1";
export const DEFAULT_POLL_INTERVAL_SECONDS = 3;
export const DEFAULT_POLL_TIMEOUT_SECONDS = 1800;

function readPositiveSeconds(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/**
 * Reads runtime configuration from environment variables. The token only ever
 * lives in the returned object; it is never written to stdout/stderr or logs.
 */
export function resolveConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const rawBase = (env.IMAGE_STUDIO_API_BASE ?? DEFAULT_API_BASE).trim().replace(/\/+$/, "");
  return {
    apiBase: rawBase || DEFAULT_API_BASE,
    apiKey: (env.IMAGE_STUDIO_BIZ_KEY ?? "").trim(),
    pollIntervalMs: readPositiveSeconds(env.IMAGE_STUDIO_POLL_INTERVAL_SECONDS, DEFAULT_POLL_INTERVAL_SECONDS) * 1000,
    pollTimeoutMs: readPositiveSeconds(env.IMAGE_STUDIO_POLL_TIMEOUT_SECONDS, DEFAULT_POLL_TIMEOUT_SECONDS) * 1000,
  };
}