/**
 * harness_tts 適配層：站點控制面 kind=tts 的 job → **harness 閘道既有 TTS 端點**。
 *
 * 上游真源（逐字）：
 *   · `deploy-staging/gateway/router.ts:531` → `POST /agent/v1/tts` → `handleTts(key, req)`
 *     （`deploy-staging/gateway/media-internal-routes.ts`：同步調用，入 `{text, voice?}`，
 *      出 `{ok, url, chars, cost_coins, format:"mp3"}`；上游不可用回 503 `tts_unavailable`）。
 *   · 該端點的 `TTS_UPSTREAM`（media-internal-routes.ts:245-265）自 2026-08-30 起指向本機
 *     edge-tts-proxy（`/opt/edge-tts/`，免 key 中文音色）；此路徑已被一次真跑證實可出音檔
 *     （記憶 `tts-multiline-narration-p2-bug`：6 行台詞 → 6 個 distinct 音檔）。
 *
 * 為何必須新增本 adapter（既有輪子都不能用，逐條）：
 *   · `openai_images` / `adobe2api`（openai-images-adapter.ts:154）請求路徑固定 `/images/generations`
 *     （video 才走 `/video/generations`）——kind=tts 會把 `{model,prompt,n,size,quality}` 送去生圖端點，
 *     必然失敗，且會污染生圖渠道的失敗域。
 *   · `metaso` / `openai_video` / `newapi_video` / `filmera` 全是異步 video 形（`/video(s)/generations`）。
 *   · 真正可複用的是「閘道那條已驗證的 TTS 路徑」本身：本 adapter 只做
 *     「POST `{supplier.baseUrl}/v1/tts` → 收斂 `{ok,url}`」的最小封裝（請求包裝與錯誤語義逐條
 *     照 `metaso-upstream.ts` 的 `metasoRequest`；同步協議不進 provider-reconciliation）。
 *
 * 同步 adapter 鐵律（同 blender-node-upstream.ts 檔頭）：請求-回應內完成，不調
 * `onProviderTaskSubmitted`（永不落 provider task id、不進對帳），因此 `reconcileVia` 只是
 * `reconcileProtocolOf()` 的兜底映射（sync adapter 既有慣例＝"newapi_video"）。
 *
 * 費率／扣費：**不在本檔**。站內唯一真源＝`generation-model-catalog/tts-pricing.ts`（0.001 幣/字），
 * 由提交路由與消費端計算；本 adapter 只回上游事實，不重造第二份費率。
 */

import { SupplierRequestError } from "./failure-classifier";
import type { SupplierGenerationInput, SupplierGenerationOutput, SupplierRecord } from "./types";

/** 閘道 TTS 路徑（router.ts:531 逐字）。 */
export const HARNESS_TTS_PATH = "/v1/tts";

function cleanBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

/** 憑證讀取（逐行照 openai-images-adapter.ts 的 readCredential；缺值＝401 確定性失敗）。 */
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
 * harness 閘道 TTS 端點 → SupplierGenerationOutput。
 *
 * `responseFormat`：站點路由傳 `b64_json`／`url`，但閘道固定回一個公開 mp3 URL，故一律
 * 以 `url` 收斂，由 worker 既有 `persistOutputArtifact` 下載後入 Blob（artifact-service.ts
 * 已原生支援 audio/mpeg 魔數嗅探；worker-service.ts:371 已把 kind=tts 映射成 mediaKind=audio）。
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

  // voice：站點路由未帶 voice 時填哨兵 "default"（route.ts 註解逐字：代表「上游自己決定預設」）。
  // 對閘道語義＝不送 voice，讓閘道用它自己的 TTS_UPSTREAM_VOICE；其餘音色名逐字透傳
  // （閘道／proxy 對無法辨識的 voice 是靜默回退，站點路由已在入口用 normalizeVoiceId 擋過）。
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
    // 上游原文透傳不吞（tts_unavailable / text too long 等），交給 failure-classifier 分類。
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
