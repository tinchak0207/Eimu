// permission-policy.ts — 权限求值内核：模式、三桶规则、provenance、模式转移守卫、写路径安全。
//
// 约束：
// - 求值以纯计算为主；写路径的 symlink/realpath 事实由网关进程自己 lstat/realpath
//   （不信任调用方传参）；安全状态通过既有 SQLite 持久化，不允许内存兜底。
// - 求值序固定：safetyCheck（bypass 不可绕）→ deny → ask → allow，各桶取首命中。
// - 不引入新依赖；路径一律按 posix 语义处理，Windows 反斜线先正规化。
// - bypassPermissions 只存在于内部；对外模式集合见 EXTERNAL_MODES。

export { ALL_MODES, EXTERNAL_MODES, PROVENANCE_SOURCES, RULE_DESTINATIONS, RULE_SOURCE_ORDER, bypassPermissionsEnvAllowed, canonicalRule, formatRule, isExternalPermissionMode, isPermissionMode, isProvenanceSource, isRuleDestination, parseRule } from "./permission-policy-types"
export type { AutoAllowAuditEntry, Behavior, DecisionReasonType, DenyAuditSource, ExternalPermissionMode, PermissionDecision, PermissionMode, PermissionReason, PermissionRule, PermissionSuggestion, PolicyStateSnapshot, ProvenanceSource, RuleBehavior, RuleBuckets, RuleDestination } from "./permission-policy-types"
export { redactRuleForLog, toDenyAuditRecord } from "./permission-policy-audit"
export type { DenyAuditRecordLike } from "./permission-policy-audit"
export { getPolicyState, guardModeTransition, isDangerousAllowRule, resetPolicyState, updateRules } from "./permission-policy-rules"
export type { ModeGuardContext, ModeGuardResult, RuleAction, UpdateRulesInput, UpdateRulesResult } from "./permission-policy-rules"
export { checkPathSafety } from "./permission-policy-path"
export type { PathSafetyKind, PathSafetyResult } from "./permission-policy-path"
export { PLAN_CONTROL_TOOLS, PLAN_READ_ONLY_TOOLS, expandRulePath, isReadOnlyTool, ruleMatches, splitSimpleCommands } from "./permission-policy-match"
export type { PermissionContext } from "./permission-policy-match"
export { HIDDEN_SCHEMA_PARAMS, stripSandboxDisableParam } from "./permission-policy-safety"
export { evaluateToolPermission } from "./permission-policy-eval"
