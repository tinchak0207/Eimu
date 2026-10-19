/**
 * Laya (convaiinnovations/laya) 客户端 — Jev 的开源 fallback 出口。
 *
 * 定位：Jev (TypeSafe System One) 是闭源付费上游，额度用尽 → 站点多条能力
 * （注入闸／expert 路由／模板判定／记忆入库闸）同时断路。Laya 同为
 * 非自回归「System One 决策模型」——同样收 state + 带型别问题、同样回
 * `answers.<key>.{choice|noul|score}`，无文字生成。故本档是**契约对接层**，
 * 不是新的判定范式：呼叫端（jev-gate.ts）拿到的形状与 Jev 逐位同构。
 *
 * 分工（与 jev-gate.ts 的分工铁律一致）：
 * - **机器闸**（Jev 优先，Laya 兜底）：判「有没有注入」「派哪个 expert」。
 * - Laya 只回数字/标签，内容生成一律不归它。
 *
 * 纪律：与 Jev 客户端同款 fail-open——任何失败（逾时/非 2xx/畸形/未配置）
 * 一律静默回 null，呼叫端各自降级。判定层挂掉永不阻断主链路。
 *
 * 部署形态：Laya 是 Python 套件（421M/322M 参数），本档对接的是我们自架的
 * HTTP 包装（见 deploy-staging/laya-server/server.py）。**不依赖 HF 公共
 * demo Space**——实测该 Space 校准已坏（benign 被判 jailbreak 0.9999）且
 * SSE 串流间歇不回应，只可当玩具，不可当基础设施。
 */

/**
 * Laya 本地服务端点。预设走 gateway 同机（127.0.0.1），亦可指向任一自架实例。
 * 注意 Laya 需 ~4.4GB RSS，**不可与 opencode-server 同机部署**（VPS 仅 3.7GB
 * 总记忆体、swap 已 57%），故正式部署在独立机器/容器。
 */
const LAYA_ENDPOINT = process.env.LAYA_ENDPOINT?.trim() || "http://127.0.0.1:8082/predict"
const LAYA_TIMEOUT_MS = Number(process.env.LAYA_TIMEOUT_MS ?? 2_500)

/** Laya 是否可用：未配置端点或显式关闭＝零动作（gateway 行为逐位等价现状）。 */
export function layaEnabled(): boolean {
  return process.env.LAYA_ENABLED === "true" && !!process.env.LAYA_ENDPOINT?.trim()
}

/** Jev 的 answer 形状子集（Laya 回传同构，故直接复用）。 */
export interface LayaAnswer {
  noul?: unknown
  choice?: unknown
  confidence?: unknown
  score?: unknown
}

interface LayaHttpPayload {
  answers?: Record<string, LayaAnswer>
}

/**
 * 呼叫 Laya 服务：state（物件，内部序列化）＋ questions（与 Jev 同款 map）。
 * 回 null＝Laya 不可用/逾时/畸形（呼叫端 fail-open）。
 *
 * 契约：请求 `{state, questions}`，回应 `{answers:{<qid>:{noul|choice|score}}}`。
 */
export async function layaSystemOne(
  state: unknown,
  questions: Record<string, unknown>,
): Promise<Record<string, LayaAnswer> | null> {
  if (!layaEnabled()) return null
  try {
    const res = await fetch(LAYA_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state, questions }),
      signal: AbortSignal.timeout(LAYA_TIMEOUT_MS),
    })
    if (!res.ok) {
      console.log(`[gateway] laya: skipped (http ${res.status})`)
      return null
    }
    const payload = (await res.json()) as LayaHttpPayload
    if (typeof payload.answers !== "object" || payload.answers === null) {
      console.log("[gateway] laya: skipped (malformed)")
      return null
    }
    return payload.answers
  } catch {
    console.log("[gateway] laya: skipped (network/timeout)")
    return null
  }
}

/** Laya 健康探针（供 /healthz 类端点或运维手查；不参与判定链）。 */
export async function layaHealth(): Promise<boolean> {
  if (!layaEnabled()) return false
  try {
    const url = LAYA_ENDPOINT.replace(/\/predict$/, "/healthz")
    const res = await fetch(url, { signal: AbortSignal.timeout(1_500) })
    return res.ok
  } catch {
    return false
  }
}
