// 成本聚合（2026-10-02 成本栏位假 0/null 修复）。
//
// 背景（gateway 9526ed2a 现场）：关键帧批次回包 total_cost_coins=0、逐帧 cost_coins=null，
// 但实际有生成、有扣费。根因有两层：
//   ① 上游轮询回应常无已结算价（平台帐本秒级延迟；见 client.ts「平台轮询回应里没有价格栏位」、
//      workflow-gw.ts「刚 succeeded 时 cost_coins 可能还是 null/0，35s 后才是真值」）→ 逐项 cost_coins=null；
//   ② 聚合端用 `r.cost_coins ?? 0` 把「缺值」当 0 相加 → total 假 0。
//
// 本模组是唯一权威的聚合规则，零副作用、零依赖，供 img-orchestrate.runGenBatch 与测试使用：
//   - 缺值（null）一律以 null 表示，**永不以 0 冒充未知**；
//   - 有产出（url/task_id）却显式 0 者标 cost_suspect（可疑，非可信 0），并排除于合计之外；
//   - 全部已结算时才给可信数字（含合法 0）；部分已结算给下限并以 cost_known=false 标明。

export interface CostItemLike {
  /** 产物标签（如 "SH01-first"），用于标出可疑项。 */
  tag: string
  /** "succeeded" | "failed"（其他字串按非成功处理）。 */
  status: string
  url?: string | null
  task_id?: string | null
  /** 上游回报的实扣币数；缺栏位＝null（未知），显式 0＝可疑。 */
  cost_coins: number | null
}

export interface CostAggregate {
  /** 已落帐实扣合计；未知/未定价时为 null（绝不为假 0）。部分已结算时为已知下限。 */
  total_cost_coins: number | null
  /** true＝所有应计费项皆已落帐，total_cost_coins 为可信值（可含合法 0）。 */
  cost_known: boolean
  /** 成功但无已结算价（cost_coins 为 null 或未定的 0）的项数。>0 ⇒ total 为下限或未知。 */
  unpriced_items: number
  /** true＝存在「有产出却 cost_coins=0」的可疑项。 */
  cost_suspect: boolean
  /** 可疑项的 tag 清单。 */
  cost_suspect_items: string[]
}

/**
 * 成本聚合：见档头规则。失败项不预期扣费，不计入未知；成功项缺值计入 unpriced_items。
 */
export function aggregateBatchCost(results: readonly CostItemLike[]): CostAggregate {
  let sum = 0
  let unpriced = 0
  const suspect: string[] = []
  for (const r of results) {
    const c = r.cost_coins
    // 已落帐的正值：唯一可计入合计的值。
    if (typeof c === "number" && c > 0) {
      sum += c
      continue
    }
    // 失败项：不预期扣费（计费链失败自动退款），null 属正常，不视为未知。
    if (r.status !== "succeeded") continue
    const hasOutput = !!(r.url || r.task_id)
    if (c === 0 && hasOutput) {
      suspect.push(r.tag) // 有产出却 0 币：可疑，非可信 0（上游帐本未落帐会先回 0）。
      unpriced++
    } else {
      unpriced++ // 成功但无已结算价（null）：缺值，未知。
    }
  }
  const known = unpriced === 0
  const total = known
    ? Math.round(sum * 1e6) / 1e6 // 全已结算：含合法 0
    : sum > 0
      ? Math.round(sum * 1e6) / 1e6 // 部分已结算：给下限，cost_known=false 标明
      : null // 全未结算：null，绝不以 0 冒充
  return {
    total_cost_coins: total,
    cost_known: known,
    unpriced_items: unpriced,
    cost_suspect: suspect.length > 0,
    cost_suspect_items: suspect,
  }
}
