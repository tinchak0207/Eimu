/**
 * harness_tts 适配层：站点控制面 kind=tts 的 job → **harness 闸道既有 TTS 端点**。
 *
 * 上游真源（逐字）：
 *   · `deploy-staging/gateway/router.ts:531` → `POST /agent/v1/tts` → `handleTts(key, req)`
 *     （`deploy-staging/gateway/media-internal-routes.ts`：同步调用，入 `{text, voice?}`，
 *      出 `{ok, url, chars, cost_coins, format:"mp3"}`；上游不可用回 503 `tts_unavailable`）。
 *   · 该端点的 `TTS_UPSTREAM`（media-internal-routes.ts:245-265）自 2026-08-30 起指向本机
 *     edge-tts-proxy（`/opt/edge-tts/`，免 key 中文音色）；此路径已被一次真跑证实可出音档
 *     （记忆 `tts-multiline-narration-p2-bug`：6 行台词 → 6 个 distinct 音档）。
 *
 * 为何必须新增本 adapter（既有轮子都不能用，逐条）：
 *   · `openai_images` / `adobe2api`（openai-images-adapter.ts:154）请求路径固定 `/images/generations`
 *     （video 才走 `/video/generations`）——kind=tts 会把 `{model,prompt,n,size,quality}` 送去生图端点，
 *     必然失败，且会污染生图渠道的失败域。
 *   · `metaso` / `openai_video` / `newapi_video` / `filmera` 全是异步 video 形（`/video(s)/generations`）。
 *   · 真正可复用的是「闸道那条已验证的 TTS 路径」本身：本 adapter 只做
 *     「POST `{supplier.baseUrl}/v1/tts` → 收敛 `{ok,url}`」的最小封装（请求包装与错误语义逐条
 *     照 `metaso-upstream.ts` 的 `metasoRequest`；同步协议不进 provider-reconciliation）。
 *
 * 同步 adapter 铁律（同 blender-node-upstream.ts 档头）：请求-回应内完成，不调
 * `onProviderTaskSubmitted`（永不落 provider task id、不进对帐），因此 `reconcileVia` 只是
 * `reconcileProtocolOf()` 的兜底映射（sync adapter 既有惯例＝"newapi_video"）。
 *
 * 费率／扣费：**不在本档**。站内唯一真源＝`generation-model-catalog/tts-pricing.ts`（0.001 币/字），
 * 由提交路由与消费端计算；本 adapter 只回上游事实，不重造第二份费率。
 */

import { SupplierRequestError } from "./failure-classifier";
import type { SupplierGenerationInput, SupplierGenerationOutput, SupplierRecord } from "./types";

/**
 * 拼在 supplier.baseUrl 后面的路径。
 * 渠道基址已经是 `https://…/agent`，网关注册的是 `/agent/v1/tts`，
 * 这里只能再加 `/v1/tts`，否则会变成 `/agent/agent/v1/tts`。
 */
export const HARNESS_TTS_PATH = "/v1/tts";

function cleanBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

/** 凭证读取（逐行照 openai-images-adapter.ts 的 readCredential；缺值＝401 确定性失败）。 */
function readCredential(supplier: SupplierRecord): string {
  const value = process.env[supplier.account.credentialRef] ?? process.env[supplier.credentialRef] ?? "";
  if (!value.trim()) throw new SupplierRequestError(`Missing configured credential ${supplier.account.credentialRef}.`, 401);
  return value.trim();
}

interface HarnessTtsResponse {
  ok?: unknown;
  url?: unknown;
  chars?: unknown;
  cost_coins?: unknown;
  error?: { message?: unknown } | null;
}

/**
 * harness 闸道 TTS 端点 → SupplierGenerationOutput。
 *
 * `responseFormat`：站点路由传 `b64_json`／`url`，但闸道固定回一个公开 mp3 URL，故一律
 * 以 `url` 收敛，由 worker 既有 `persistOutputArtifact` 下载后入 Blob（artifact-service.ts
 * 已原生支援 audio/mpeg 魔数嗅探；worker-service.ts:371 已把 kind=tts 映射成 mediaKind=audio）。
 */
export async function generateWithHarnessTts(
  supplier: SupplierRecord,
  input: SupplierGenerationInput,
): Promise<SupplierGenerationOutput> {
  if (input.kind !== "tts") {
    throw new SupplierRequestError(`Harness TTS adapter only serves kind=tts (got ${input.kind}).`, 400);
  }
  const text = input.prompt.trim();
  if (!text) throw new SupplierRequestError("Harness TTS input text is empty.", 400);

  // voice：站点路由未带 voice 时填哨兵 "default"（route.ts 注解逐字：代表「上游自己决定预设」）。
  // 对闸道语义＝不送 voice，让闸道用它自己的 TTS_UPSTREAM_VOICE；其余音色名逐字透传
  // （闸道／proxy 对无法辨识的 voice 是静默回退，站点路由已在入口用 normalizeVoiceId 挡过）。
  const rawVoice = typeof input.workflow.voice === "string" ? input.workflow.voice.trim() : "";
  const voice = rawVoice && rawVoice !== "default" ? rawVoice : null;

  const url = `${cleanBaseUrl(supplier.baseUrl)}${HARNESS_TTS_PATH}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${readCredential(supplier)}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text, ...(voice ? { voice } : {}) }),
      signal: AbortSignal.timeout(Number(process.env.HARNESS_TTS_TIMEOUT_MS ?? 120_000)),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new SupplierRequestError("Harness TTS request timed out.", 408);
    }
    throw new SupplierRequestError(
      `Harness TTS gateway unreachable (${(error as Error)?.message ?? String(error)}).`,
      503,
    );
  }

  const payload = (await response.json().catch(() => null)) as HarnessTtsResponse | null;
  if (!response.ok) {
    const message =
      typeof payload?.error?.message === "string" && payload.error.message
        ? payload.error.message
        : `HTTP ${response.status}`;
    // 上游原文透传不吞（tts_unavailable / text too long 等），交给 failure-classifier 分类。
    throw new SupplierRequestError(
      `Harness TTS gateway error: ${message}`,
      response.status,
      response.headers.get("retry-after"),
    );
  }
  const audioUrl = typeof payload?.url === "string" ? payload.url : "";
  if (payload?.ok !== true || !(audioUrl.startsWith("http://") || audioUrl.startsWith("https://"))) {
    throw new SupplierRequestError(
      `Harness TTS gateway returned no audio url (ok=${String(payload?.ok)}).`,
      502,
    );
  }
  return {
    base64: null,
    url: audioUrl,
    httpStatus: response.status,
    endpointLabel: supplier.label,
    supplierModelId: input.modelId,
    evidence: {
      adapter: supplier.adapterType,
      supplierId: supplier.id,
      chars: typeof payload.chars === "number" ? payload.chars : text.length,
      gatewayCostCoins: typeof payload.cost_coins === "number" ? payload.cost_coins : null,
    },
  };
}
