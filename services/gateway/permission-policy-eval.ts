import { Behavior, InternalPolicyState, PermissionDecision, PermissionMode, PermissionRule, PermissionSuggestion, ProvenanceSource, RULE_SOURCE_ORDER, formatRule, isExternalPermissionMode, parseRule } from "./permission-policy-types"
import { getState, isDangerousAllowRule, listRules, persistPolicyState, recordAutoAllow } from "./permission-policy-rules"
import { normalizePathString } from "./permission-policy-path"
import { PLAN_CONTROL_TOOLS, PermissionContext, isEditTool, isReadOnly, normalizeAbsolute, pathsFromTool, ruleMatches, withinAnyRoot } from "./permission-policy-match"
import { resolveSafetyPath, safetyCheck } from "./permission-policy-safety"


interface RuleHit {
  rule: string
  source: ProvenanceSource
}

function injectedRules(
  bucket: Behavior,
  context: PermissionContext,
): PermissionRule[] {
  const raw = context.rules?.[bucket]
  if (!Array.isArray(raw)) return []
  const out: PermissionRule[] = []
  for (const item of raw) {
    const parsed = parseRule(item)
    if (parsed) out.push(parsed)
  }
  return out
}

function firstRuleHit(
  bucket: Behavior,
  state: InternalPolicyState,
  context: PermissionContext,
  tool: string,
  input: Record<string, unknown>,
  skipDangerous = false,
): RuleHit | null {
  for (const source of RULE_SOURCE_ORDER) {
    const rules = listRules(state.rules[bucket], source)
    for (const ruleText of rules) {
      if (skipDangerous && isDangerousAllowRule(ruleText)) continue
      const rule = parseRule(ruleText)
      if (rule && ruleMatches(rule, tool, input, context, bucket)) {
        return { rule: formatRule(rule), source }
      }
    }
    if (source === "session") {
      for (const rule of injectedRules(bucket, context)) {
        if (skipDangerous && isDangerousAllowRule(formatRule(rule))) continue
        if (ruleMatches(rule, tool, input, context, bucket)) {
          return { rule: formatRule(rule), source }
        }
      }
    }
  }
  return null
}

function ruleDecision(hit: RuleHit, behavior: Behavior): PermissionDecision {
  return {
    behavior,
    reason: {
      type: "rule",
      rule: hit.rule,
      source: hit.source,
      ruleBehavior: behavior,
      ...(behavior === "deny" ? { auditSource: "deny_glob" as const } : {}),
    },
  }
}

function allowSuggestion(tool: string, matchedRule?: string): PermissionSuggestion {
  const rule = matchedRule ? parseRule(matchedRule) : { toolName: tool }
  return {
    type: "addRules",
    rules: [rule ?? { toolName: tool }],
    behavior: "allow",
    destination: "session",
  }
}

/** 计划模式的合法动作：控制类工具与「写计划文件」不受 plan floor 拦截。 */
function isPlanControlTool(tool: string): boolean {
  return PLAN_CONTROL_TOOLS.has(tool.toLowerCase())
}

function isPlanFileWrite(tool: string, input: Record<string, unknown>, context: PermissionContext): boolean {
  if (!context.planFilePath || !context.planFilePath.trim()) return false
  if (!isEditTool(tool)) return false
  const paths = pathsFromTool(tool, input)
  if (paths.length === 0) return false
  const target = normalizeAbsolute(normalizePathString(context.planFilePath))
  return paths.every((path) => resolveSafetyPath(path, context) === target)
}

function planAllowsTool(tool: string, input: Record<string, unknown>, context: PermissionContext): boolean {
  return isReadOnly(tool, context) || isPlanControlTool(tool) || isPlanFileWrite(tool, input, context)
}

function modeDecision(
  mode: PermissionMode,
  tool: string,
  input: Record<string, unknown>,
  context: PermissionContext,
): PermissionDecision {
  if (mode === "bypassPermissions") {
    return {
      behavior: "allow",
      reason: { type: "mode", mode, source: "mode", reason: "bypassPermissions allows the call" },
    }
  }

  if (mode === "dontAsk") {
    return {
      behavior: "deny",
      reason: { type: "mode", mode, source: "mode", reason: "dontAsk denies calls that are not explicitly allowed" },
    }
  }

  if (mode === "plan") {
    if (planAllowsTool(tool, input, context)) {
      return {
        behavior: "allow",
        reason: {
          type: "mode",
          mode,
          source: "mode",
          reason: isPlanControlTool(tool)
            ? "plan mode allows plan control tools"
            : isPlanFileWrite(tool, input, context)
              ? "plan mode allows writing the plan file"
              : "plan mode allows read-only calls",
        },
      }
    }
    return {
      behavior: "ask",
      reason: { type: "mode", mode, source: "mode", reason: "plan mode holds write or side-effecting calls" },
      suggestions: [{ type: "addRules", rules: [{ toolName: tool }], behavior: "allow", destination: "session" }],
    }
  }

  if (mode === "acceptEdits") {
    if (isEditTool(tool)) {
      const paths = pathsFromTool(tool, input)
      if (paths.length === 0) {
        return {
          behavior: "allow",
          reason: { type: "mode", mode, source: "mode", reason: "acceptEdits allows edits" },
        }
      }
      if (paths.every((path) => withinAnyRoot(path, context))) {
        return {
          behavior: "allow",
          reason: { type: "mode", mode, source: "mode", reason: "acceptEdits allows edits inside the working directories" },
        }
      }
      return {
        behavior: "ask",
        reason: {
          type: "workingDir",
          mode,
          source: "mode",
          reason: "edit target is outside the working directories",
          path: paths[0],
        },
        suggestions: [allowSuggestion(tool)],
      }
    }
    return {
      behavior: "ask",
      reason: { type: "mode", mode, source: "mode", reason: "acceptEdits only auto-allows edit tools" },
      suggestions: [allowSuggestion(tool)],
    }
  }

  if (mode === "auto") {
    // auto 的产品语义就是「无需确认」；没有规则命中时放行，而不是 fail-closed 卡死全部工具。
    // 危险 allow 规则仍在进入 auto / 新增 allow 时被剥离（stripDangerousAllowRules），
    // safetyCheck（写路径）与 deny 桶仍先于本分支生效。
    return {
      behavior: "allow",
      reason: {
        type: "classifier",
        mode,
        source: "mode",
        classifier: "auto-allow",
        reason: "auto mode allows calls without confirmation",
      },
    }
  }

  return {
    behavior: "ask",
    reason: { type: "mode", mode, source: "mode", reason: "default mode requires confirmation" },
    suggestions: [allowSuggestion(tool)],
  }
}

/**
 * 求值序：safetyCheck → deny → ask → allow（各桶首命中）→ 模式兜底。
 * ask 命中在 dontAsk 下转 deny；在 bypassPermissions 下转 allow（safetyCheck 已先挡）。
 * plan 对非只读调用保留 ask 闸门，allow 规则不能越过。
 */
export function evaluateToolPermission(args: {
  sessionId: string
  tenant?: string
  tool: string
  input?: Record<string, unknown> | null
  context?: PermissionContext
}): PermissionDecision {
  const sessionId = typeof args.sessionId === "string" && args.sessionId ? args.sessionId : "default"
  const tenant = typeof args.tenant === "string" && args.tenant ? args.tenant : "default"
  const context = args.context ?? {}
  const input = args.input && typeof args.input === "object" ? args.input : {}
  const tool = typeof args.tool === "string" && args.tool ? args.tool : "unknown"
  const state = getState(sessionId, tenant)

  // restricted 只能 latch true：context 不得解除。
  if ((context.restricted === true && !state.restricted) || (context.bypassDisabled === true && !state.bypassDisabled)) {
    if (context.restricted === true) state.restricted = true
    if (context.bypassDisabled === true) state.bypassDisabled = true
    persistPolicyState(state)
  }

  // C2：context.mode 只认对外模式；bypassPermissions 一律忽略（只能来自可信状态）。
  const requestedMode = context.mode && isExternalPermissionMode(context.mode) ? context.mode : undefined
  const mode = requestedMode ?? state.mode

  // 1. safetyCheck：先于所有规则与模式，bypassPermissions 不可绕。
  const safety = safetyCheck(tool, input, context, mode)
  if (safety) return safety

  // 2. deny 桶（全体来源，首命中）。
  const denyHit = firstRuleHit("deny", state, context, tool, input)
  if (denyHit) return ruleDecision(denyHit, "deny")

  // 3. ask 桶（首命中）；dontAsk 转 deny，bypass 转 allow。
  const askHit = firstRuleHit("ask", state, context, tool, input)
  if (askHit) {
    if (mode === "dontAsk") return ruleDecision(askHit, "deny")
    if (mode === "bypassPermissions") {
      return {
        behavior: "allow",
        reason: {
          type: "mode",
          mode,
          source: "mode",
          rule: askHit.rule,
          ruleBehavior: "ask",
          replacedBehavior: "ask",
          reason: "bypassPermissions converts an ask rule to allow",
        },
      }
    }
    const decision = ruleDecision(askHit, "ask")
    decision.suggestions = [allowSuggestion(tool, askHit.rule)]
    return decision
  }

  // 4. allow 桶（首命中）。plan 对非计划合法动作保留 ask。
  const allowHit = firstRuleHit("allow", state, context, tool, input, mode === "auto")
  if (allowHit) {
    if (mode === "plan" && !planAllowsTool(tool, input, context)) {
      return {
        behavior: "ask",
        reason: {
          type: "mode",
          mode,
          source: "mode",
          rule: allowHit.rule,
          reason: "plan mode holds non-read-only calls even when an allow rule matches",
        },
        suggestions: [allowSuggestion(tool, allowHit.rule)],
      }
    }
    return ruleDecision(allowHit, "allow")
  }

  // 5. 模式兜底。auto 的自动放行落一条进程内审计（无规则命中路径）。
  const decision = modeDecision(mode, tool, input, context)
  if (decision.behavior === "allow" && mode === "auto") recordAutoAllow(state, tool)
  return decision
}
