import { REGISTRY_CHANNELS } from "@/lib/supplier-channels.config";
import { generateWithBlenderNode } from "./blender-node-upstream";
import { generateWithFilmera, pollFilmeraTask } from "./filmera-upstream";
import { generateWithMetaso, pollMetasoTask } from "./metaso-upstream";
import { generateWithNewApiVideo, pollNewApiVideoTask } from "./newapi-video-upstream";
import { requestOpenAiCompatibleSupplier } from "./openai-images-adapter";
import { generateWithOpenaiVideo, openaiVideoSubmissionFacts, pollOpenaiVideoTask } from "./openai-video-upstream";
import type { PaidVideoSubmissionFacts } from "./paid-video-cost-gate";
import type { ProviderTaskPollResult, SupplierGenerationInput, SupplierGenerationOutput, SupplierRecord } from "./types";

// 供給 adapter registry（V-06，docs/architecture/planes.md §2）。
//
// 協議分派原本散在三處中央 switch（supplier-adapter `requestSupplier`、
// worker-service `protocolOfAdapter`、provider-reconciliation `pollProviderTask`）；
// 現在三處都以 `supplier.adapter_type`（＝`SupplyAdapter.protocol`）查本表。
//
// 新增一條**新協議**供給＝2 檔：
//   ① 新 adapter 檔：`export const fooAdapter: SupplyAdapter = { protocol: "foo", submit, poll? }`
//   ② `src/lib/supplier-channels.config.ts` 條目：`adapterType: "foo", adapter: fooAdapter`
// 本檔在載入時掃 REGISTRY_CHANNELS 的 `adapter` 欄位自動註冊，不需改本檔。
// 未知協議一律明確失敗（不再 default 成 newapi_video）。
//
// 內建 adapter 只**包裝**既有上游函式，上游邏輯一行未改。

export interface SupplyAdapter {
  /** 全域唯一；＝ DB `supplier.adapter_type` ＝ attempt `provider_protocol`。 */
  readonly protocol: string;
  /** 提交。同步協議回成品；異步協議在拿到 task id 時呼叫 `input.onProviderTaskSubmitted`。 */
  submit(supplier: SupplierRecord, input: SupplierGenerationInput): Promise<SupplierGenerationOutput>;
  /** 異步協議的對帳輪詢（provider-reconciliation 用）。缺席＝同步協議。 */
  poll?(supplier: SupplierRecord, providerTaskId: string): Promise<ProviderTaskPollResult>;
  /**
   * 同步協議若意外帶出 provider task id，交給哪個協議的 poll 對帳。
   * 只為保住 INC-0831 以來的既有行為（舊 `protocolOfAdapter` 的 default 分支＝newapi_video），
   * 由各 adapter 顯式宣告，不再是中央 default。
   */
  readonly reconcileVia?: string;
  /**
   * 付費視頻成本閘（生產平面 worker 在提交前執行）：
   * - `paidVideoFailClosed: true`：本協議的每個 video_generate 提交都過閘（白名單外即拒）。
   * - 否則只有提交的上游 model 落在白名單內才套價檢。
   * `paidVideoFacts` 回報本協議實際會送給上游的（model, resolution, seconds）；缺席時
   * worker 以 `supplier.supplierModelId ?? input.modelId`＋job 的 resolution/秒數推定。
   */
  readonly paidVideoFailClosed?: boolean;
  paidVideoFacts?(supplier: SupplierRecord, input: SupplierGenerationInput): PaidVideoSubmissionFacts;
}

/** job workflow 的秒數（成本閘事實用）；缺省／非數值回 null（閘會 fail-closed 拒收白名單 model）。 */
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

// blender 節點（片Y/片AA）：同步單幀渲染——bridge /v1/execute 契約，見
// blender-node-upstream.ts。同步 adapter：無 provider task id，不進異步對帳。
const blenderBridgeAdapter: SupplyAdapter = {
  protocol: "blender_bridge",
  submit: (supplier, input) => generateWithBlenderNode(supplier, input),
  reconcileVia: "newapi_video",
};

// new-api 原生視頻任務內核（NEWAPI_VIDEO_KERNEL 影子期，見 newapi-video-upstream.ts）。
// 提交不讀 supplier（渠道選擇由 new-api Distribute 承擔，V-05 另案）。
const newapiVideoAdapter: SupplyAdapter = {
  protocol: "newapi_video",
  submit: (_supplier, input) => generateWithNewApiVideo(input),
  poll: (_supplier, providerTaskId) => pollNewApiVideoTask(providerTaskId),
  // 內核提交的 model＝控制面平台 id（newapi-video-upstream.ts:164），不是渠道上游名。
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
  newapiVideoAdapter,
];

function buildRegistry(): Map<string, SupplyAdapter> {
  const registry = new Map<string, SupplyAdapter>();
  const add = (adapter: SupplyAdapter, source: string) => {
    const protocol = adapter.protocol?.trim();
    if (!protocol) throw new Error(`[supply-registry] ${source}: adapter.protocol 不得為空。`);
    const existing = registry.get(protocol);
    if (existing && existing !== adapter) {
      throw new Error(`[supply-registry] ${source}: protocol "${protocol}" 已被另一個 adapter 註冊（協議名必須全域唯一）。`);
    }
    registry.set(protocol, adapter);
  };
  for (const adapter of BUILTIN_ADAPTERS) add(adapter, "builtin");
  for (const channel of REGISTRY_CHANNELS) {
    if (!channel.adapter) continue;
    if (channel.adapterType && channel.adapterType !== channel.adapter.protocol) {
      throw new Error(
        `[supply-registry] channel "${channel.label}": adapterType "${channel.adapterType}" 與 adapter.protocol "${channel.adapter.protocol}" 不一致。`,
      );
    }
    add(channel.adapter, `channel "${channel.label}"`);
  }
  for (const adapter of registry.values()) {
    if (adapter.reconcileVia && !registry.get(adapter.reconcileVia)?.poll) {
      throw new Error(`[supply-registry] protocol "${adapter.protocol}" 的 reconcileVia "${adapter.reconcileVia}" 不是可輪詢的已註冊協議。`);
    }
  }
  return registry;
}

const REGISTRY = buildRegistry();

/** 查表；未註冊回 undefined。 */
export function getSupplyAdapter(protocol: string): SupplyAdapter | undefined {
  return REGISTRY.get(protocol);
}

export class UnknownSupplyProtocolError extends Error {
  constructor(readonly protocol: string, context: string) {
    super(`Unknown supply protocol "${protocol}" (${context}); registered: ${[...REGISTRY.keys()].join(", ")}.`);
    this.name = "UnknownSupplyProtocolError";
  }
}

/** 查表；未註冊即拋 UnknownSupplyProtocolError（明確失敗，不 default）。 */
export function requireSupplyAdapter(protocol: string, context = "dispatch"): SupplyAdapter {
  const adapter = REGISTRY.get(protocol);
  if (!adapter) throw new UnknownSupplyProtocolError(protocol, context);
  return adapter;
}

/** 已註冊協議清單（add-supplier-channel 等工具的合法值來源）。 */
export function listSupplyProtocols(): string[] {
  return [...REGISTRY.keys()];
}

export function isRegisteredSupplyProtocol(value: unknown): value is string {
  return typeof value === "string" && REGISTRY.has(value);
}

/**
 * supplier adapter_type → 對帳協議標記（INC-0831；原 worker-service `protocolOfAdapter`）。
 * 異步協議＝自身；同步協議＝其 `reconcileVia`；未知協議或無對帳路徑一律拋錯。
 */
export function reconcileProtocolOf(adapterType: string): string {
  const adapter = requireSupplyAdapter(adapterType, "reconcile protocol");
  if (adapter.poll) return adapter.protocol;
  if (adapter.reconcileVia) return adapter.reconcileVia;
  throw new Error(`Supply protocol "${adapterType}" has no reconciliation path (no poll, no reconcileVia).`);
}

/**
 * 對帳輪詢分派（原 provider-reconciliation `pollProviderTask` 的 switch）。
 * 協議自帶 poll 用自己的；同步協議走 `reconcileVia`；未知協議拋錯（由呼叫端記 poll_error 退避）。
 */
export async function pollSupplyTask(protocol: string, supplier: SupplierRecord, providerTaskId: string): Promise<ProviderTaskPollResult> {
  const adapter = requireSupplyAdapter(protocol, "reconcile poll");
  const poller = adapter.poll ? adapter : adapter.reconcileVia ? requireSupplyAdapter(adapter.reconcileVia, "reconcile poll") : null;
  if (!poller?.poll) {
    return Promise.reject(new Error(`Supply protocol "${protocol}" cannot be polled (no poll, no reconcileVia).`));
  }
  return poller.poll(supplier, providerTaskId);
}
