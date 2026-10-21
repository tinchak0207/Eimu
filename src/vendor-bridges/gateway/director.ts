/**
 * director.ts — 3D 导演台服务端生命周期层（施工片3，2026-09-02）。
 *
 * 需求源：docs/director-console-integration-spec.md §3（HTTP 路由契约）§4（director.done 事件契约）。
 * 存储范式：./timeline.ts（$WORKSPACE_DIR/director/<sid>/current.json + versions/ last 20
 * + 每第 10 里程碑 + log.jsonl + withSessionLock + pruneVersions），逐段照搬。
 * 语义真源：kunpeng-vendor @872a58b src/stores/directorStore.ts（mutation 逐一对齐：
 * normalizeShotTimes / upgradePlanKeyframes / makeSequenceShot / makeDefaultPlan /
 * stateOfElement / snapshot / undo-redo JSON 快照 / removePlan 至少留一 / replacePlans
 * 空列表拒绝 / setActive* 重置 currentTime 与 playing）；守卫真源：kunpeng
 * src/lib/agent/tools/directorTools.ts（set_lock/delete 守卫、apply_proposal 无确认拒绝、
 * proposals 30 分 TTL）。纯函数层一律 import director-engine（片1+2 产物，禁改动）。
 *
 * 白名单声明：wheel 的 id 生成本用 `nanoid(7/8)`——本档逐字保留 nanoid 调用。
 * 文案纪律：本档所有工具错误/栏位描述一律简体（用户裁定，agent-gateway-copy-rules）。
 */

export { DirectorBlockedError, DirectorNotFoundError, DirectorNotInitializedError, DirectorValidationError } from "./director-types"
export type { DirectorCapabilities, DirectorDoc, DirectorHealth, DirectorLogEntry } from "./director-types"
export { resetDirector, setDirectorEmitter, setDirectorSessionResolver } from "./director-emit"
export type { DirectorEmitter, DirectorSessionResolver } from "./director-emit"
export type { DirectorActionSeed, DirectorOp } from "./director-ops"
export { applyDirectorOps, getDirectorState } from "./director-state"
export type { ApplyDirectorOpsResult, DirectorActionSummary, DirectorShotSummary, DirectorStateMode, DirectorStateResult, DirectorStateSummary } from "./director-state"
export { __clearPendingProposalsForTest, applyDirectorProposal, createDirectorProposals } from "./director-proposals"
export type { DirectorProposalSummary } from "./director-proposals"
export { getDirectorSchematic, handleDirectorRoutes } from "./director-http"
