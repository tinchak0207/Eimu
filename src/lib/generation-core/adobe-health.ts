import { getGenerationSql, type GenerationSql } from "./database";

type AdobeHealthPayload = Record<string, unknown>;

function field(payload: AdobeHealthPayload, name: string): unknown {
  const data = payload.data;
  if (data && typeof data === "object") return (data as Record<string, unknown>)[name] ?? payload[name];
  return payload[name];
}

function optionalDate(value: unknown): Date | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const result = new Date(value);
  return Number.isNaN(result.getTime()) ? null : result;
}

export function adobeHealthEndpoint(baseUrl: string, healthPath: string): string {
  const path = healthPath.trim();
  if (/^https?:\/\//i.test(path)) return new URL(path).toString();
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
  return new URL(endpoint).toString();
}

/**
 * Adobe2API owns session material. This projection reads only its sanitized health
 * response and never imports cookies or tokens into Image Studio.
 */
export async function refreshAdobeSupplierHealth(sql: GenerationSql = getGenerationSql()): Promise<{ checked: number; healthy: number }> {
  const accounts = await sql<Array<{
    id: string;
    base_url: string;
    credential_ref: string;
    configuration_json: Record<string, unknown> | string;
  }>>`
    SELECT account.id, supplier.base_url, account.credential_ref, account.configuration_json
    FROM supplier_account account
    JOIN supplier ON supplier.id = account.supplier_id
    WHERE supplier.adapter_type = 'adobe2api' AND account.enabled
  `;
  let healthy = 0;
  for (const account of accounts) {
    const config = typeof account.configuration_json === "string"
      ? JSON.parse(account.configuration_json) as Record<string, unknown>
      : account.configuration_json;
    const healthPath = typeof config.healthPath === "string" ? config.healthPath : "health";
    const endpoint = adobeHealthEndpoint(account.base_url, healthPath);
    try {
      const key = process.env[account.credential_ref] ?? "";
      const response = await fetch(endpoint, {
        headers: key ? { Authorization: `Bearer ${key}` } : {},
        signal: AbortSignal.timeout(10_000),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`Adobe health HTTP ${response.status}: ${text.slice(0, 300)}`);
      const payload = JSON.parse(text) as AdobeHealthPayload;
      // Adobe2API 的 health 响应有两代结构，这里都要兼容：
      //   旧结构：顶层 { token_source, refresh_status, expires_at, success_rate_5m }
      //   新结构：{ status:"ok", accounts:[{ auto_refresh_count, active_token_count, healthy, cooldown_until }] }
      // 新结构没有顶层 token_source/refresh_status；只要 status=ok 且 accounts 里存在
      // 带 auto_refresh token 的健康账号，就视同 token_source=auto_refresh、refresh_status=healthy。
      const accounts = Array.isArray(payload.accounts) ? payload.accounts as Record<string, unknown>[] : [];
      const topStatus = String(field(payload, "status") ?? "");
      const hasAutoRefresh = accounts.some((a) => Number(a.auto_refresh_count ?? 0) > 0 && a.healthy !== false);
      const hasActiveToken = accounts.some((a) => Number(a.active_token_count ?? 0) > 0);
      const anyHealthy = accounts.length === 0 || accounts.some((a) => a.healthy !== false);

      const tokenSource = String(field(payload, "token_source") ?? field(payload, "source") ?? "")
        || (hasAutoRefresh ? "auto_refresh" : "");
      const rawRefreshStatus = String(field(payload, "refresh_status") ?? "unknown");
      const refreshStatus = rawRefreshStatus === "unknown" && topStatus === "ok" ? "healthy" : rawRefreshStatus;
      const expiresAt = optionalDate(field(payload, "expires_at") ?? field(payload, "credential_expires_at"))
        ?? (hasActiveToken ? new Date(Date.now() + 24 * 3600 * 1000) : null);
      const refreshFailure = field(payload, "last_refresh_failure_at");
      const explicitSuccessRate = Number(field(payload, "success_rate_5m"));
      const successRate = Number.isFinite(explicitSuccessRate) ? Math.min(1, Math.max(0, explicitSuccessRate)) : null;
      const sourceOkay = tokenSource === "auto_refresh";
      const refreshOkay = refreshStatus === "healthy";
      const expiresOkay = Boolean(expiresAt && expiresAt.getTime() > Date.now() + 2 * 60_000);
      const rateOkay = successRate === null || successRate >= 0.8;
      const isHealthy = sourceOkay && refreshOkay && expiresOkay && rateOkay && anyHealthy;
      if (isHealthy) healthy += 1;
      await sql`
        UPDATE supplier_account
        SET token_source = ${tokenSource || null}, credential_expires_at = ${expiresAt},
            refresh_status = ${refreshStatus === "healthy" ? "healthy" : refreshStatus === "expired" ? "expired" : "failing"},
            last_refresh_at = CASE WHEN ${refreshStatus} = 'healthy' THEN now() ELSE last_refresh_at END,
            last_refresh_failure_at = CASE WHEN ${refreshFailure ? true : false} THEN now() ELSE last_refresh_failure_at END,
            success_rate_5m = COALESCE(${successRate}, success_rate_5m),
            health_status = ${isHealthy ? "healthy" : "degraded"},
            health_observed_at = now(), updated_at = now()
        WHERE id = ${account.id}
      `;
    } catch (error) {
      const detail = error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000);
      console.error(`[generation-adobe-health] account=${account.id} ${detail}`);
      await sql`
        UPDATE supplier_account
        SET health_status = 'degraded', refresh_status = 'failing', last_refresh_failure_at = now(),
            health_observed_at = now(), updated_at = now()
        WHERE id = ${account.id}
      `;
    }
  }
  return { checked: accounts.length, healthy };
}
