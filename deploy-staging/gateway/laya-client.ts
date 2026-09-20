/**
 * Laya (convaiinnovations/laya) 客戶端 — Jev 的開源 fallback 出口。
 *
 * 定位：Jev (TypeSafe System One) 是閉源付費上游，額度用盡 → 站點多條能力
 * （注入閘／expert 路由／模板判定／記憶入庫閘）同時斷路。Laya 同為
 * 非自回歸「System One 決策模型」——同樣收 state + 帶型別問題、同樣回
 * `answers.<key>.{choice|noul|score}`，無文字生成。故本檔是**契約對接層**，
 * 不是新的判定範式：呼叫端（jev-gate.ts）拿到的形狀與 Jev 逐位同構。
 *
 * 分工（與 jev-gate.ts 的分工鐵律一致）：
 * - **機器閘**（Jev 優先，Laya 兜底）：判「有沒有注入」「派哪個 expert」。
 * - Laya 只回數字/標籤，內容生成一律不歸它。
 *
 * 紀律：與 Jev 客戶端同款 fail-open——任何失敗（逾時/非 2xx/畸形/未配置）
 * 一律靜默回 null，呼叫端各自降級。判定層掛掉永不阻斷主鏈路。
 *
 * 部署形態：Laya 是 Python 套件（421M/322M 參數），本檔對接的是我們自架的
 * HTTP 包裝（見 deploy-staging/laya-server/server.py）。**不依賴 HF 公共
 * demo Space**——實測該 Space 校準已壞（benign 被判 jailbreak 0.9999）且
 * SSE 串流間歇不回應，只可當玩具，不可當基礎設施。
 */

/**
 * Laya 本地服務端點。預設走 gateway 同機（127.0.0.1），亦可指向任一自架實例。
 * 注意 Laya 需 ~4.4GB RSS，**不可與 opencode-server 同機部署**（VPS 僅 3.7GB
 * 總記憶體、swap 已 57%），故正式部署在獨立機器/容器。
 */
const LAYA_ENDPOINT = process.env.LAYA_ENDPOINT?.trim() || "http://127.0.0.1:8082/predict"
const LAYA_TIMEOUT_MS = Number(process.env.LAYA_TIMEOUT_MS ?? 2_500)

/** Laya 是否可用：未配置端點或顯式關閉＝零動作（gateway 行為逐位等價現狀）。 */
export function layaEnabled(): boolean {
  return process.env.LAYA_ENABLED === "true" && !!process.env.LAYA_ENDPOINT?.trim()
}

/** Jev 的 answer 形狀子集（Laya 回傳同構，故直接複用）。 */
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
 * 呼叫 Laya 服務：state（物件，內部序列化）＋ questions（與 Jev 同款 map）。
 * 回 null＝Laya 不可用/逾時/畸形（呼叫端 fail-open）。
 *
 * 契約：請求 `{state, questions}`，回應 `{answers:{<qid>:{noul|choice|score}}}`。
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

/** Laya 健康探針（供 /healthz 類端點或運維手查；不參與判定鏈）。 */
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
