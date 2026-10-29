// S17：运行时 AGENTS.md 的规则绑定表（设计文档 §3.9 / §0.1 第 1 点）。
//
// 判定口径：一条规则只有能被代码强制，才留在 AGENTS.md 并在这里登记
// 「标签 → 强制它的代码路径 → 守住它的测试名」。代码管不住的愿望（措辞、语气、
// 并行习惯、版权与乐理判断）已从 AGENTS.md 删除，删除清单见 S17 回报。
//
// 与 AGENTS.md 的标签集合必须精确相等（gates.test.ts 双向断言）：
//   AGENTS.md 里出现 [R-nn] 而本表没有 → 规则无强制点，测试失败；
//   本表里有而 AGENTS.md 没有 → 死映射，测试失败。

export interface RuleMapping {
  /** 强制这条规则的代码路径：「文件:函数」。 */
  enforce: string
  /** 守住它的测试名（bun test 的 test()/describe() 名）。 */
  test: string
}

export const RULES_MAP: Readonly<Record<string, RuleMapping>> = {
  // ── 席位与工具面 ────────────────────────────────────────────────
  "R-01": {
    enforce: "deploy-staging/gateway/messages-gw-admission.ts:resolvePromptSeat（席位表在 opencode.json / expert/opencode-agents.json）",
    test: "creator 启用集逐项等于设计文档 §3.7 第 8 点的十个工具",
  },
  "R-02": {
    enforce: "deploy-staging/gateway/expert/opencode-agents.json:席位表（creator 与 <expert>_p 的生成工具全 false；opencode.json 同源）",
    test: "creator/orchestrator/全部 _p：opencode.json 启用集与生成工具交集为 0",
  },

  // ── 交付：只认产物 ──────────────────────────────────────────────
  "R-03": {
    enforce: "deploy-staging/gateway/project/gates.ts:deliverablesFromExport",
    test: "只有模型文本已完成、没有 export 产物 → 无交付卡",
  },
  "R-04": {
    enforce: "deploy-staging/gateway/project/gates.ts:checkExportArtifacts",
    test: "export 前置检查：好片全过",
  },
  "R-05": {
    enforce: "deploy-staging/gateway/project/gates.ts:checkQcMedia（量测复用 executors/qc.ts:inspectMedia）",
    test: "qc 前置检查：好片全过（响度/黑帧/冻结/分数）",
  },
  "R-06": {
    enforce: "deploy-staging/gateway/project/executors/qc.ts:runCritic + verifySignedCriticVerdict",
    test: "critic 判不过 → 重生 → 第二轮判过；同一轮只派一次",
  },

  // ── 钱与授权 ────────────────────────────────────────────────────
  "R-07": {
    enforce: "deploy-staging/gateway/project/admission.ts:admit（报价→预算→确认，三关顺序固定）",
    test: "报价 ≥ 阈值且非 auto/full → needs_user + 确认卡登记一次，run 立即返回（不 await 用户）",
  },
  "R-08": {
    enforce: "deploy-staging/gateway/project/admission.ts:admit（authorized 端口读会话设置 billingAutoApprovalEnabled，不读正文）",
    test: "auto/full 授权直接放行；用户批准后重入也放行",
  },
  "R-09": {
    enforce: "deploy-staging/gateway/project/submit-generation.ts:finishSuccess + deploy-staging/gateway/project/ledger.ts:createLedgerWriter",
    test: "上游任务失败：写 failed+refunded 行（带 node_id），预算释放，收据 failed",
  },

  // ── 执行与失败语义 ──────────────────────────────────────────────
  "R-10": {
    enforce: "deploy-staging/gateway/project/scheduler.ts:executeNode",
    test: "不当作失败、不重试（即使 onFail=regenerate）、保持 running+inflight 交恢复核对",
  },
  "R-11": {
    enforce: "deploy-staging/gateway/project/scheduler.ts:executePlan（planRun 命中即复用）",
    test: "第二次 run 不调执行器；node_reused 事件与 reused 账本行各 = 复用节点数，cost_coins=0",
  },
  "R-12": {
    enforce: "deploy-staging/gateway/project/patch.ts:checkLane",
    test: "set 越界 → LANE_VIOLATION；lane 内 → 提交",
  },
  "R-13": {
    enforce: "deploy-staging/gateway/router-internal.ts:projectPlanDenial",
    test: "计划模式下三个工具都被拒绝（教学式原因），project_get 不被本闸拦",
  },

  // ── 记忆（旧席位也在用，强制点在 memory-gate）───────────────────
  "R-14": {
    enforce: "deploy-staging/gateway/memory-gate.ts:applyMemoryGates（G2 证据硬线）",
    test: "G2 证据（硬线）",
  },
  "R-15": {
    enforce: "deploy-staging/gateway/memory-gate.ts:applyMemoryGates（G3 敏感）",
    test: "G3 敏感（只回代号、不回显内容）",
  },
  "R-16": {
    enforce: "deploy-staging/gateway/memory-gate.ts:applyMemoryGates（G4 身份泄漏）",
    test: "G4 身份泄漏（仅 shared → 降级 private）",
  },

  // ── 节奏：铺满、派专家、多回报 ──────────────────────────────────
  "R-17": {
    enforce: "deploy-staging/gateway/project/store.ts:setDefaultRecipes（首句 ingress 的 apply_recipe 与工具共用配方表）＋ project/routes.ts:onProjectEvents（任何写入后画布即时追平）",
    test: "首句命中配方 → 节点建齐，不回 UNKNOWN_RECIPE",
  },
  "R-18": {
    enforce: "deploy-staging/gateway/project/lanes.ts:inferLaneFromGraph（派发未带 lane 时按专家类型推 lane，并写进任务书）",
    test: "派 music 不带 lane → lane＝图里的 music 节点；未完成的排前面",
  },
  "R-19": {
    enforce: "deploy-staging/gateway/project/routes.ts:emitProgressCards（节点新产物即时进对话）",
    test: "新 node_output 有公网 url → 对应 image/video/audio.done 各推一次、不重复",
  },
}

/** 有规则但找不到强制点 = 该规则不该留在 AGENTS.md；v1 为空（删掉的愿望见 S17 回报清单）。 */
export const UNMAPPED_RULES: ReadonlyArray<{ tag: string; rule: string }> = []

const TAG_RE = /\[(R-\d{2})\]/g

/** 抽出文本里出现的全部 [R-nn] 标签（去重、保序）。 */
export function extractRuleTags(text: string): string[] {
  const out: string[] = []
  for (const m of String(text).matchAll(TAG_RE)) {
    if (!out.includes(m[1])) out.push(m[1])
  }
  return out
}

/** 标签的数值序（R-02 < R-10），用于回报与测试排序。 */
export function compareRuleTags(a: string, b: string): number {
  return Number(a.slice(2)) - Number(b.slice(2))
}
