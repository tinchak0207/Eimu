import { REGISTRY_CHANNELS } from "@/lib/supplier-channels.config";
import { generateWithBlenderNode } from "./blender-node-upstream";
import { generateWithFilmera, pollFilmeraTask } from "./filmera-upstream";
import { generateWithHarnessTts } from "./harness-tts-upstream";
import { generateWithMetaso, pollMetasoTask } from "./metaso-upstream";
import { generateWithNewApiVideo, pollNewApiVideoTask } from "./newapi-video-upstream";
import { requestOpenAiCompatibleSupplier } from "./openai-images-adapter";
import { generateWithOpenaiVideo, openaiVideoSubmissionFacts, pollOpenaiVideoTask } from "./openai-video-upstream";
import type { PaidVideoSubmissionFacts } from "./paid-video-cost-gate";
import type { ProviderTaskPollResult, SupplierGenerationInput, SupplierGenerationOutput, SupplierRecord } from "./types";

// 供给 adapter registry（V-06，docs/architecture/planes.md §2）。
//
// 协议分派原本散在三处中央 switch（supplier-adapter `requestSupplier`、
// worker-service `protocolOfAdapter`、provider-reconciliation `pollProviderTask`）；
// 现在三处都以 `supplier.adapter_type`（＝`SupplyAdapter.protocol`）查本表。
//
// 新增一条**新协议**供给＝2 档：
//   ① 新 adapter 档：`export const fooAdapter: SupplyAdapter = { protocol: "foo", submit, poll? }`
//   ② `src/lib/supplier-channels.config.ts` 条目：`adapterType: "foo", adapter: fooAdapter`
// 本档在载入时扫 REGISTRY_CHANNELS 的 `adapter` 栏位自动注册，不需改本档。
// 未知协议一律明确失败（不再 default 成 newapi_video）。
//
// 内建 adapter 只**包装**既有上游函式，上游逻辑一行未改。

export interface SupplyAdapter {
  /** 全域唯一；＝ DB `supplier.adapter_type` ＝ attempt `provider_protocol`。 */
  readonly protocol: string;
  /** 提交。同步协议回成品；异步协议在拿到 task id 时呼叫 `input.onProviderTaskSubmitted`。 */
  submit(supplier: SupplierRecord, input: SupplierGenerationInput): Promise<SupplierGenerationOutput>;
  /** 异步协议的对帐轮询（provider-reconciliation 用）。缺席＝同步协议。 */
  poll?(supplier: SupplierRecord, providerTaskId: string): Promise<ProviderTaskPollResult>;
  /**
   * 同步协议若意外带出 provider task id，交给哪个协议的 poll 对帐。
   * 只为保住 INC-0831 以来的既有行为（旧 `protocolOfAdapter` 的 default 分支＝newapi_video），
   * 由各 adapter 显式宣告，不再是中央 default。
   */
  readonly reconcileVia?: string;
  /**
   * 付费视频成本闸（生产平面 worker 在提交前执行）：
   * - `paidVideoFailClosed: true`：本协议的每个 video_generate 提交都过闸（白名单外即拒）。
   * - 否则只有提交的上游 model 落在白名单内才套价检。
   * `paidVideoFacts` 回报本协议实际会送给上游的（model, resolution, seconds）；缺席时
   * worker 以 `supplier.supplierModelId ?? input.modelId`＋job 的 resolution/秒数推定。
   */
  readonly paidVideoFailClosed?: boolean;
  paidVideoFacts?(supplier: SupplierRecord, input: SupplierGenerationInput): PaidVideoSubmissionFacts;
}

/** job workflow 的秒数（成本闸事实用）；缺省／非数值回 null（闸会 fail-closed 拒收白名单 model）。 */
export function workflowSeconds(input: SupplierGenerationInput): number | null {
  const raw = input.workflow.durationSeconds;
  if (raw === undefined || raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.round(value) : null;
}

const openaiImagesAdapter: SupplyAdapter = {
  protocol: "openai_images",
  submit: (supplier, input) => requestOpenAiCompatibleSupplier(supplier, input),
  reconcileVia: "newapi_video",
};

const adobe2apiAdapter: SupplyAdapter = {
  protocol: "adobe2api",
  submit: (supplier, input) => requestOpenAiCompatibleSupplier(supplier, input),
  reconcileVia: "newapi_video",
};

const metasoAdapter: SupplyAdapter = {
  protocol: "metaso",
  submit: (supplier, input) => generateWithMetaso(supplier, input),
  poll: (supplier, providerTaskId) => pollMetasoTask(supplier, providerTaskId),
};

const openaiVideoAdapter: SupplyAdapter = {
  protocol: "openai_video",
  submit: (supplier, input) => generateWithOpenaiVideo(supplier, input),
  poll: (supplier, providerTaskId) => pollOpenaiVideoTask(supplier, providerTaskId),
  paidVideoFailClosed: true,
  paidVideoFacts: (supplier, input) => openaiVideoSubmissionFacts(supplier, input),
};

const filmeraAdapter: SupplyAdapter = {
  protocol: "filmera",
  submit: (supplier, input) => generateWithFilmera(supplier, input),
  poll: (_supplier, providerTaskId) => pollFilmeraTask(providerTaskId),
};

// blender 节点（片Y/片AA）：同步单帧渲染——bridge /v1/execute 契约，见
// blender-node-upstream.ts。同步 adapter：无 provider task id，不进异步对帐。
const blenderBridgeAdapter: SupplyAdapter = {
  protocol: "blender_bridge",
  submit: (supplier, input) => generateWithBlenderNode(supplier, input),
  reconcileVia: "newapi_video",
};

// harness TTS（2026-10-01）：同步调用「harness 闸道既有 TTS 端点」`POST {base}/v1/tts`
//（deploy-staging/gateway/router.ts:531 → media-internal-routes handleTts；上游自 2026-08-30
// 指向本机 edge-tts-proxy）。同步 adapter：无 provider task id，不进异步对帐；见
// harness-tts-upstream.ts 档头（为何既有生图/视频轮子不能用）。
const harnessTtsAdapter: SupplyAdapter = {
  protocol: "harness_tts",
  submit: (supplier, input) => generateWithHarnessTts(supplier, input),
  reconcileVia: "newapi_video",
};

// new-api 原生视频任务内核（NEWAPI_VIDEO_KERNEL 影子期，见 newapi-video-upstream.ts）。
// 提交不读 supplier（渠道选择由 new-api Distribute 承担，V-05 另案）。
const newapiVideoAdapter: SupplyAdapter = {
  protocol: "newapi_video",
  submit: (_supplier, input) => generateWithNewApiVideo(input),
  poll: (_supplier, providerTaskId) => pollNewApiVideoTask(providerTaskId),
  // 内核提交的 model＝控制面平台 id（newapi-video-upstream.ts:164），不是渠道上游名。
  paidVideoFacts: (_supplier, input) => ({
    supplierModelId: input.modelId,
    resolution: input.resolution,
    seconds: workflowSeconds(input),
  }),
};

const BUILTIN_ADAPTERS: readonly SupplyAdapter[] = [
  openaiImagesAdapter,
  adobe2apiAdapter,
  metasoAdapter,
  openaiVideoAdapter,
  filmeraAdapter,
  blenderBridgeAdapter,
  harnessTtsAdapter,
  newapiVideoAdapter,
];

function buildRegistry(): Map<string, SupplyAdapter> {
  const registry = new Map<string, SupplyAdapter>();
  const add = (adapter: SupplyAdapter, source: string) => {
    const protocol = adapter.protocol?.trim();
    if (!protocol) throw new Error(`[supply-registry] ${source}: adapter.protocol 不得为空。`);
    const existing = registry.get(protocol);
    if (existing && existing !== adapter) {
      throw new Error(`[supply-registry] ${source}: protocol "${protocol}" 已被另一个 adapter 注册（协议名必须全域唯一）。`);
    }
    registry.set(protocol, adapter);
  };
  for (const adapter of BUILTIN_ADAPTERS) add(adapter, "builtin");
  for (const channel of REGISTRY_CHANNELS) {
    if (!channel.adapter) continue;
    if (channel.adapterType && channel.adapterType !== channel.adapter.protocol) {
      throw new Error(
        `[supply-registry] channel "${channel.label}": adapterType "${channel.adapterType}" 与 adapter.protocol "${channel.adapter.protocol}" 不一致。`,
      );
    }
    add(channel.adapter, `channel "${channel.label}"`);
  }
  for (const adapter of registry.values()) {
    if (adapter.reconcileVia && !registry.get(adapter.reconcileVia)?.poll) {
      throw new Error(`[supply-registry] protocol "${adapter.protocol}" 的 reconcileVia "${adapter.reconcileVia}" 不是可轮询的已注册协议。`);
    }
  }
  return registry;
}

const REGISTRY = buildRegistry();

/** 查表；未注册回 undefined。 */
export function getSupplyAdapter(protocol: string): SupplyAdapter | undefined {
  return REGISTRY.get(protocol);
}

export class UnknownSupplyProtocolError extends Error {
  constructor(readonly protocol: string, context: string) {
    super(`Unknown supply protocol "${protocol}" (${context}); registered: ${[...REGISTRY.keys()].join(", ")}.`);
    this.name = "UnknownSupplyProtocolError";
  }
}

/** 查表；未注册即抛 UnknownSupplyProtocolError（明确失败，不 default）。 */
export function requireSupplyAdapter(protocol: string, context = "dispatch"): SupplyAdapter {
  const adapter = REGISTRY.get(protocol);
  if (!adapter) throw new UnknownSupplyProtocolError(protocol, context);
  return adapter;
}

/** 已注册协议清单（add-supplier-channel 等工具的合法值来源）。 */
export function listSupplyProtocols(): string[] {
  return [...REGISTRY.keys()];
}

export function isRegisteredSupplyProtocol(value: unknown): value is string {
  return typeof value === "string" && REGISTRY.has(value);
}

/**
 * supplier adapter_type → 对帐协议标记（INC-0831；原 worker-service `protocolOfAdapter`）。
 * 异步协议＝自身；同步协议＝其 `reconcileVia`；未知协议或无对帐路径一律抛错。
 */
export function reconcileProtocolOf(adapterType: string): string {
  const adapter = requireSupplyAdapter(adapterType, "reconcile protocol");
  if (adapter.poll) return adapter.protocol;
  if (adapter.reconcileVia) return adapter.reconcileVia;
  throw new Error(`Supply protocol "${adapterType}" has no reconciliation path (no poll, no reconcileVia).`);
}

/**
 * 对帐轮询分派（原 provider-reconciliation `pollProviderTask` 的 switch）。
 * 协议自带 poll 用自己的；同步协议走 `reconcileVia`；未知协议抛错（由呼叫端记 poll_error 退避）。
 */
export async function pollSupplyTask(protocol: string, supplier: SupplierRecord, providerTaskId: string): Promise<ProviderTaskPollResult> {
  const adapter = requireSupplyAdapter(protocol, "reconcile poll");
  const poller = adapter.poll ? adapter : adapter.reconcileVia ? requireSupplyAdapter(adapter.reconcileVia, "reconcile poll") : null;
  if (!poller?.poll) {
    return Promise.reject(new Error(`Supply protocol "${protocol}" cannot be polled (no poll, no reconcileVia).`));
  }
  return poller.poll(supplier, providerTaskId);
}
