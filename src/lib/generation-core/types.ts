import type { FailureRecord } from "./failure-record";
import type { NormalizedVideoPostProduction } from "./video-post-production";

export type GenerationSource = "web" | "biz" | "canary";
export type GenerationKind = "image_generate" | "image_edit" | "video_generate" | "tts" | "avatar" | "lipsync";
export type RoutingClass = "generic" | "firefly_only" | "hub_only";
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
  | "upstream_protocol"
  | "pricing_config"
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
  /**
   * 生成式后期（P1-3／对称差 D22）：续片 `extend_video`／局部改片 `edit_video`。
   * 建单前由 `parseVideoPostProduction()` 正规化（来源影片已解析成可读 URL）；
   * 缺省＝普通生成，零行为变化。kind 仍是 `video_generate`（不新增 DB kind）。
   */
  videoPostProduction?: NormalizedVideoPostProduction;
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
  /** 批量生成编排层（/v1/batches）回填的归属；非批量任务为 null。 */
  batchId?: string | null;
  /** 批内序号（0 起，对应 POST /v1/batches 的 requests 索引）；非批量任务为 null。 */
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
  /**
   * FG-01：版本化失败记录（原生栏位逐字保留、cause 递回）。null = 无失败或记录缺失。
   * 产品解释只住在 record.explanation，永不回写 failureClass/failureDetail 的来源事实。
   */
  failureRecord: FailureRecord | null;
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
  /** 实测尺寸；成片（G4）probe 缺失时为 null——禁止 0 冒充。 */
  width: number | null;
  height: number | null;
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
  /** 批量生成编排层（/v1/batches）回填的归属；单任务提交不带。 */
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
  /** 实测尺寸；图片上传验证路径恒有值，放宽是配合 ValidatedImage（G4 成片 probe 可缺）。 */
  width: number | null;
  height: number | null;
  sourceResultId?: string | null;
  sourceGenerationId?: string | null;
  referenceRole?: "general" | "character" | "product" | "style" | "composition";
  metadata?: Record<string, unknown>;
}

export interface SupplierRecord {
  id: string;
  label: string;
  /**
   * 供给协议（DB supplier.adapter_type）。V-06 起放宽为 string：合法值由
   * supply-registry 在执行期判定（未注册＝明确失败），不再随供给增长改联集。
   */
  adapterType: string;
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

/**
 * 异步任务适配器的对帐协议标记（INC-0831）：provider task id 落库后，由
 * provider-reconciliation 按协议向上游查询真相。V-06 起＝supply-registry 的
 * `SupplyAdapter.protocol`（string），执行期由 registry 校验；新增异步适配器不再改此型别。
 */
export type ProviderProtocol = string;

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
  /**
   * 异步任务适配器（openai-video/newapi-video/metaso/filmera 等）在上游提交完成、
   * 取得 provider task id 的瞬间回调（INC-0830-VIDEO）。worker 用它把 task id +
   * 对帐排程 durably 落进 attempt 行（只发事件不落行 = 事故重演）。同步适配器
   * 不需要实现。
   */
  onProviderTaskSubmitted?: (providerTaskId: string, protocol: ProviderProtocol) => void;
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

/**
 * INC-0831 对帐轮询结果：按 provider task id 问上游拿真相。
 * - running：仍在排队/处理中（或上游暂时查不到，保守视为仍在跑，等下轮）。
 * - succeeded：上游确认成功（url 直用；base64 供需要鉴栏下载的渠道）。
 * - failed：上游确认失败/取消（reason = 上游原文，退款只认这里）。
 */
export type ProviderTaskPollResult =
  | { state: "running" }
  | { state: "succeeded"; url: string | null; base64: string | null }
  | { state: "failed"; reason: string };
