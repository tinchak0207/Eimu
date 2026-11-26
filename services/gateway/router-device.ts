import { resolveCanonicalIdentity } from "./auth-gw.ts"
import { resolveSession } from "./sessions-core.ts"
import { subagentParentState } from "./subagent.ts"

/**
 * W6a（2026-10-04）：装置桥内部路由的 session → 租户解析。
 * 与 `/internal/media/upload` **同源**的 session 解析（`resolveSession` → `subagentParentState`
 * 兜底子会话），owner 由既有正典化身分路径 `resolveCanonicalIdentity(session.apiKey)` 取得
 * （与装置注册时 `tenant = u:<userId>` 的推导同源，不自造第二套）。解析不到回 `null`。
 */
export async function internalDeviceResolveTenant(sessionId: string): Promise<string | null> {
  const state = resolveSession(sessionId) ?? subagentParentState(sessionId)
  if (!state) return null
  const key = typeof state.apiKey === "string" ? state.apiKey : ""
  if (!key) return null
  const identity = await resolveCanonicalIdentity(key)
  return identity.userId == null ? null : `u:${identity.userId}`
}

/**
 * G2（2026-10-14 协作总线修复）：`/internal/subagent/*` 端点组的统一错误兜底。
 * 这些 handler 读 body／解析字段，任何未预期抛错此前会冒到 Bun 顶层 → **HTML 500**，
 * 机器调用方（opencode 工具）`res.json()` 直接失败。此处捕获后一律回**同形状 JSON**
 * `{ok:false, code:"internal_error", error}`，500。error 只给一句话原因（不泄漏栈）。
 */
export async function guardedSubagentEndpoint(label: string, fn: () => Promise<Response>, req?: Request): Promise<Response> {
  try {
    return await fn()
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    const rid = req?.headers.get("x-request-id") || req?.headers.get("x-trace-id") || crypto.randomUUID()
    console.error(`[gateway] subagent endpoint error (${label}) rid=${rid}:`, e)
    return Response.json({ ok: false, code: "internal_error", error: `子代理端点内部错误（${label}）：${reason}` }, { status: 500 })
  }
}
