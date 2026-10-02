// 成本聚合（2026-10-02 成本欄位假 0/null 修復）。
//
// 背景（gateway 9526ed2a 現場）：關鍵幀批次回包 total_cost_coins=0、逐幀 cost_coins=null，
// 但實際有生成、有扣費。根因有兩層：
//   ① 上游輪詢回應常無已結算價（平台帳本秒級延遲；見 client.ts「平台輪詢回應裡沒有價格欄位」、
//      workflow-gw.ts「剛 succeeded 時 cost_coins 可能還是 null/0，35s 後才是真值」）→ 逐項 cost_coins=null；
//   ② 聚合端用 `r.cost_coins ?? 0` 把「缺值」當 0 相加 → total 假 0。
//
// 本模組是唯一權威的聚合規則，零副作用、零依賴，供 img-orchestrate.runGenBatch 與測試使用：
//   - 缺值（null）一律以 null 表示，**永不以 0 冒充未知**；
//   - 有產出（url/task_id）卻顯式 0 者標 cost_suspect（可疑，非可信 0），並排除於合計之外；
//   - 全部已結算時才給可信數字（含合法 0）；部分已結算給下限並以 cost_known=false 標明。

export interface CostItemLike {
  /** 產物標籤（如 "SH01-first"），用於標出可疑項。 */
  tag: string
  /** "succeeded" | "failed"（其他字串按非成功處理）。 */
  status: string
  url?: string | null
  task_id?: string | null
  /** 上游回報的實扣幣數；缺欄位＝null（未知），顯式 0＝可疑。 */
  cost_coins: number | null
}

export interface CostAggregate {
  /** 已落帳實扣合計；未知/未定價時為 null（絕不為假 0）。部分已結算時為已知下限。 */
  total_cost_coins: number | null
  /** true＝所有應計費項皆已落帳，total_cost_coins 為可信值（可含合法 0）。 */
  cost_known: boolean
  /** 成功但無已結算價（cost_coins 為 null 或未定的 0）的項數。>0 ⇒ total 為下限或未知。 */
  unpriced_items: number
  /** true＝存在「有產出卻 cost_coins=0」的可疑項。 */
  cost_suspect: boolean
  /** 可疑項的 tag 清單。 */
  cost_suspect_items: string[]
}

/**
 * 成本聚合：見檔頭規則。失敗項不預期扣費，不計入未知；成功項缺值計入 unpriced_items。
 */
export function aggregateBatchCost(results: readonly CostItemLike[]): CostAggregate {
  let sum = 0
  let unpriced = 0
  const suspect: string[] = []
  for (const r of results) {
    const c = r.cost_coins
    // 已落帳的正值：唯一可計入合計的值。
    if (typeof c === "number" && c > 0) {
      sum += c
      continue
    }
    // 失敗項：不預期扣費（計費鏈失敗自動退款），null 屬正常，不視為未知。
    if (r.status !== "succeeded") continue
    const hasOutput = !!(r.url || r.task_id)
    if (c === 0 && hasOutput) {
      suspect.push(r.tag) // 有產出卻 0 幣：可疑，非可信 0（上游帳本未落帳會先回 0）。
      unpriced++
    } else {
      unpriced++ // 成功但無已結算價（null）：缺值，未知。
    }
  }
  const known = unpriced === 0
  const total = known
    ? Math.round(sum * 1e6) / 1e6 // 全已結算：含合法 0
    : sum > 0
      ? Math.round(sum * 1e6) / 1e6 // 部分已結算：給下限，cost_known=false 標明
      : null // 全未結算：null，絕不以 0 冒充
  return {
    total_cost_coins: total,
    cost_known: known,
    unpriced_items: unpriced,
    cost_suspect: suspect.length > 0,
    cost_suspect_items: suspect,
  }
}
