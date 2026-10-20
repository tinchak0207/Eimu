export { IdempotencyConflictError, mapFailureRecordColumn, mapGenerationJob } from "./job-repository/types";
export type { CreatedJob, GenerationAttemptSummary, VideoAttemptSummary } from "./job-repository/types";

export {
  getGenerationArtifactForTenant,
  getGenerationJob,
  getGenerationJobForTenant,
  hasGenerationCapability,
  listCompletedGenerationArtifacts,
  listGenerationAttemptsForJob,
  listGenerationJobsForTenant,
  listVideoAttemptSummariesForJob,
} from "./job-repository/query";

export {
  attemptedSupplierRoutingForOutput,
  beginGenerationAttempt,
  cancelGenerationJob,
  claimNextGenerationJob,
  completeGenerationAttempt,
  completeGenerationJob,
  createGenerationJob,
  extendGenerationDeadlineJob,
  extendGenerationQueueDeadline,
  failGenerationAttempt,
  failGenerationJob,
  failGenerationJobForReconciliation,
  freezeGenerationJobForReconciliation,
  heartbeatGenerationJob,
  jobHasUnresolvedProviderTask,
  mapSupplierLease,
  mapSupplierRecord,
  markProviderTaskSubmitted,
  recoverExpiredGenerationLeases,
  releaseJobForRetry,
  replaceProviderTaskId,
  reviveGenerationJobWithArtifacts,
} from "./job-repository/write";

export { clearProviderOutputCheckpoint } from "./job-repository/spool-io";
export { checkpointProviderOutput, checkpointProviderTaskReceipt, recoverJobsFromCanonicalArtifacts, restoreProviderResponsesFromSpool, settleRequestedGenerationCancellation } from "./job-repository/spool";
