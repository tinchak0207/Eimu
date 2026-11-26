// 收费授权复用用户显式设置；设备短断线和网关重启不会撤销已授予的 full。
import { hashKey, resolveCanonicalIdentity } from "./auth-gw.ts"
import { deviceBridge } from "./device-bridge.ts"
import { loadTenantPermissionMode, loadUserSettings } from "./persistence.ts"
import type { SessionState } from "./types-gateway.ts"

export async function billingPermissionTenant(state: Pick<SessionState, "apiKey">): Promise<string | null> {
  if (!state.apiKey) return null
  const identity = await resolveCanonicalIdentity(state.apiKey)
  return identity.userId != null ? `u:${identity.userId}` : `k:${await hashKey(state.apiKey)}`
}

export async function billingAutoApprovalEnabled(state: Pick<SessionState, "apiKey">): Promise<boolean> {
  if (!state.apiKey) return false
  const settings = loadUserSettings(state.apiKey) as (ReturnType<typeof loadUserSettings> & { interaction_mode?: string })
  if (settings?.interaction_mode === "auto") return true
  const tenant = await billingPermissionTenant(state)
  if (!tenant) return false
  // 持久记录优先：off/ask 必须能撤销仍在内存的旧 full。
  const saved = loadTenantPermissionMode(tenant)
  return (saved ?? deviceBridge.permissionStateForTenant(tenant).mode) === "full"
}
