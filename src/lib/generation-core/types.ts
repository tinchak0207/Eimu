export type GenerationSource = "web" | "biz" | "canary";
export type GenerationKind = "image_generate" | "image_edit" | "video_generate" | "tts" | "avatar" | "lipsync";
export type RoutingClass = "generic" | "firefly_only";
export type GenerationJobStatus =
  | "pending_billing"
  | "billing_unknown"
  | "queued"
  | "leased"
  | "submitting"
  | "running"
  | "submit_unknown"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "refunded";

export type FailureClass =
  | "user_input"
  | "content_rejected"
  | "model_unsupported"
  | "authentication"
  | "quota_exhausted"
  | "rate_limited"
  | "overloaded"
  | "network"
  | "malformed_output"
  | "empty_result"
  | "artifact_download"
  | "deadline_exceeded"
  | "cancelled"
  | "unknown";

export interface GenerationReference {
  artifactId?: string;
  url: string;
  mimeType: string;
  name?: string;
  sourceResultId?: string;
  sourceGenerationId?: string;
  referenceRole?: "general" | "character" | "product" | "style" | "composition";
}

export interface GenerationWorkflow {
  references?: GenerationReference[];
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface GenerationJob {
  id: string;
  tenantId: string;
  apiKeyId: string | null;
  billingUserId: number | null;
  source: GenerationSource;
  idempotencyKey: string | null;
  requestHash: string;
  kind: GenerationKind;
  routingClass: RoutingClass;
  modelId: string;
  size: string | null;
  ratio: string | null;
  resolution: string | null;
  quality: string | null;
  promptCiphertext: string;
  workflow: GenerationWorkflow;
  responseFormat: "b64_json" | "url";
  callbackUrl: string | null;
  retryOfTaskId: string | null;
  primaryResultId: string | null;
  /** 批量生成編排層（/v1/batches）回填的歸屬；非批量任務為 null。 */
  batchId?: string | null;
  /** 批內序號（0 起，對應 POST /v1/batches 的 requests 索引）；非批量任務為 null。 */
  batchIndex?: number | null;
  status: GenerationJobStatus;
  requestedCount: number;
  completedCount: number;
  attemptCount: number;
  billingAmount: number;
  deadlineAt: Date;
  availableAt: Date;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  failureClass: FailureClass | null;
  failureDetail: string | null;
  result: GenerationJobResult | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  updatedAt: Date;
}

export interface GenerationArtifactResult {
  id: string;
  outputIndex: number;
  url: string | null;
  b64Json?: string;
  mimeType: string;
  sha256: string;
  width: number;
  height: number;
  endpointLabel: string;
}

export interface GenerationJobResult {
  created: number;
  artifacts: GenerationArtifactResult[];
  endpointLabel?: string;
}

export interface CreateGenerationJobInput {
  id: string;
  tenantId: string;
  apiKeyId?: string | null;
  billingUserId?: number | null;
  source: GenerationSource;
  idempotencyKey?: string | null;
  requestHash: string;
  kind: GenerationKind;
  routingClass: RoutingClass;
  modelId: string;
  size?: string | null;
  ratio?: string | null;
  resolution?: string | null;
  quality?: string | null;
  promptCiphertext: string;
  workflow?: GenerationWorkflow;
  responseFormat?: "b64_json" | "url";
  callbackUrl?: string | null;
  retryOfTaskId?: string | null;
  /** 批量生成編排層（/v1/batches）回填的歸屬；單任務提交不帶。 */
  batchId?: string | null;
  batchIndex?: number | null;
  referenceArtifacts?: CreateGenerationReferenceArtifactInput[];
  requestedCount: number;
  billingAmount: number;
  deadlineAt: Date;
}

export interface CreateGenerationReferenceArtifactInput {
  id: string;
  objectKey: string;
  deliveryUrl: string;
  mimeType: string;
  sha256: string;
  byteSize: number;
  width: number;
  height: number;
  sourceResultId?: string | null;
  sourceGenerationId?: string | null;
  referenceRole?: "general" | "character" | "product" | "style" | "composition";
  metadata?: Record<string, unknown>;
}

export interface SupplierRecord {
  id: string;
  label: string;
  adapterType: "adobe2api" | "openai_images" | "minimax" | "did";
  supplyTier: "first_party" | "managed_pool" | "relay" | "fallback";
  failureDomain: string;
  baseUrl: string;
  credentialRef: string;
  configuration: Record<string, unknown>;
  priority: number;
  concurrencyLimit: number;
  qualityScore: number;
  unitCost: number;
  healthStatus: "healthy" | "degraded" | "cooldown" | "disabled";
  healthScore: number;
  latencyEwmaMs: number | null;
  supplierModelId: string | null;
  capabilityId: number;
  capabilityConcurrencyLimit: number;
  contractVersion: number;
  capabilityHealthStatus: "healthy" | "degraded" | "cooldown" | "disabled";
  account: SupplierAccountRecord;
}

export interface SupplierAccountRecord {
  id: string;
  label: string;
  credentialRef: string;
  concurrencyLimit: number;
  healthStatus: "healthy" | "degraded" | "cooldown" | "disabled";
  tokenSource: string | null;
  credentialExpiresAt: Date | null;
  refreshStatus: "unknown" | "healthy" | "failing" | "expired";
  successRate5m: number;
  healthObservedAt: Date | null;
  configuration: Record<string, unknown>;
}

export interface SupplierLease {
  id: string;
  jobId: string;
  workerId: string;
  expiresAt: Date;
  supplier: SupplierRecord;
}

export interface SupplierGenerationInput {
  jobId: string;
  attemptId: string;
  modelId: string;
  supplierModelId: string | null;
  prompt: string;
  kind: GenerationKind;
  size: string | null;
  ratio: string | null;
  resolution: string | null;
  quality: string | null;
  workflow: GenerationWorkflow;
}

export interface SupplierGenerationOutput {
  base64: string | null;
  url: string | null;
  providerRequestId?: string;
  providerTaskId?: string;
  httpStatus: number;
  endpointLabel: string;
  supplierModelId: string;
  evidence?: Record<string, unknown>;
}
