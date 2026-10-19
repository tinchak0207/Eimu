import { getFilmeraAccessToken } from "./filmera-upstream";
import { getGenerationSql, type GenerationSql } from "./database";

// filmera 渠道健康检查：先走 token 生命周期管理（必要时自动 refresh），
// 再用 access_token 探 Supabase /auth/v1/user。200 = 账号可用；401/403 = refresh
// 也失败（refresh_token 失效）→ degraded。不导入任何 cookie/token 进 Image Studio，
// 只做探测。

export async function refreshFilmeraSupplierHealth(sql: GenerationSql = getGenerationSql()): Promise<{ checked: number; healthy: number }> {
  const accounts = await sql<Array<{
    id: string;
    base_url: string;
    credential_ref: string;
    configuration_json: Record<string, unknown> | string;
  }>>`
    SELECT account.id, supplier.base_url, account.credential_ref, account.configuration_json
    FROM supplier_account account
    JOIN supplier ON supplier.id = account.supplier_id
    WHERE supplier.adapter_type = 'filmera' AND account.enabled
  `;
  let healthy = 0;
  for (const account of accounts) {
    const config = typeof account.configuration_json === "string"
      ? JSON.parse(account.configuration_json) as Record<string, unknown>
      : account.configuration_json;
    const supabaseUrl = String(config.supabaseUrl ?? process.env.FILMERA_SUPABASE_URL ?? "").replace(/\/+$/, "");
    const anonKey = String(config.anonKey ?? process.env.FILMERA_ANON_KEY ?? "");
    try {
      const token = (process.env[account.credential_ref] ?? "").trim();
      if (!token && !process.env.FILMERA_REFRESH_TOKEN) throw new Error("Missing FILMERA_AUTH_TOKEN");
      if (!supabaseUrl || !anonKey) throw new Error("Missing filmera supabase config");
      // token 生命周期管理：距过期自动 refresh（refresh 也失败时 health 才真正 degraded）
      const { token: freshToken } = await getFilmeraAccessToken({ supabaseUrl, anonKey });
      const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
        headers: { apikey: anonKey, Authorization: `Bearer ${freshToken}` },
        signal: AbortSignal.timeout(10_000),
      });
      const isHealthy = response.ok;
      if (isHealthy) healthy += 1;
      await sql`
        UPDATE supplier_account
        SET token_source = 'auto_refresh', refresh_status = ${isHealthy ? "healthy" : "failing"},
            health_status = ${isHealthy ? "healthy" : "degraded"},
            last_refresh_at = CASE WHEN ${isHealthy} THEN now() ELSE last_refresh_at END,
            last_refresh_failure_at = CASE WHEN ${isHealthy} THEN last_refresh_failure_at ELSE now() END,
            health_observed_at = now(), updated_at = now()
        WHERE id = ${account.id}
      `;
    } catch (error) {
      const detail = error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000);
      console.error(`[generation-filmera-health] account=${account.id} ${detail}`);
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
