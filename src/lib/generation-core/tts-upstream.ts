/**
 * tts_speech 適配層：supplier 派發 → OpenAI 兼容 `POST {base}/audio/speech`
 * （刀 3：配音音色庫 → 角色綁定 → TTS 音色參數落定）。
 *
 * 上游形狀（既有生產事實，勿造新協議）：
 *   - VPS `/opt/edge-tts/tts-proxy.js`（systemd edge-tts-proxy，127.0.0.1:8893）
 *     暴露 `POST /openai/v1/audio/speech` `{model,input,voice,response_format}` → MP3 二進位
 *     （SiliconFlow CosyVoice2 主路 + edge-tts 自動降級；見記憶 tts-upstream-edge-proxy）。
 *   - 任何 OpenAI 兼容 TTS 服務（SiliconFlow /v1/audio/speech 等）同形狀。
 *   baseUrl 由 supplier 行決定（含 `/openai/v1` 之類前綴），本檔只補 `/audio/speech`。
 *
 * 音色來源（voice-library.ts）：
 *   - `workflow.voice`：顯式 voiceCode（B 端 API 既有欄位，route 已帶）。
 *   - `workflow.cards`：角色卡陣列時取 `voiceCodeFromCards`（角色卡綁定音色）。
 *   - 兩者皆缺 → "default"（不假裝命中音色庫；artifact metadata 記 source="fallback"）。
 *
 * ⚠️ 音色生效誠實性（2026-09-15 實測，勿美化）：
 *   本 adapter 忠實把 `voiceCode` 送進上游 `voice` 欄；但**上游是否真換音色不由我們決定**。
 *   已查實：本站 gateway（VPS `/opt/edge-tts/tts-proxy.js` 的 `synthSiliconFlow`）對不含
 *   `:` 的 voice 執行 `voice = `${model}:alex``——AID 火山 bigtts code（如
 *   `zh_female_vv_uranus_bigtts`）全部落入此改寫，63 筆在我們網關上塌縮成同一個
 *   alex 音。故 metadata 帶 `voice_effective`（verified / unknown / collapsed）：
 *   `collapsed` = 任務會 200 成功，但不是該音色。**不得把 HTTP 200 當音色生效**。
 *   可試聽集合見 voice-library 的 `GATEWAY_VERIFIED_VOICES`（另立實測白名單）。
 *
 * 同步 adapter 鐵律（同 blender-node-upstream）：請求-回應內完成合成，無異步 task_id
 * 語義——不進 provider-reconciliation，worker-service protocolOfAdapter 不加映射。
 *
 * 錯誤鐵律：絕不拋原始 fetch 錯誤，一律包成 SupplierRequestError。音色被上游拒絕
 * （400 + voice 相關訊息）判 `user_input`（**不是** model_unsupported——那會讓
 * scheduler 把整個供應商 disabled=true），上游 5xx 交詞表分類。
 */

import { SupplierRequestError } from "./failure-classifier";
import { resolveTtsVoice, ttsVoiceRequestParams } from "../voice-library";
import type { CharacterCard } from "../character-cards";
import type { SupplierGenerationInput, SupplierGenerationOutput, SupplierRecord } from "./types";

const DEFAULT_TIMEOUT_MS = 120_000;
/** OpenAI /audio/speech 的 response_format 白名單（本站只收這三種；音訊校驗另在 artifact-service）。 */
const RESPONSE_FORMAT = "mp3";
/** supplier.configuration.ttsParams 可宣告轉發的擴充參數（未宣告 = 不轉發，不假裝支援）。 */
const FORWARDABLE_EXTRA_PARAMS = ["pitch", "emotion"] as const;

function cleanBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * 憑證可選：edge-tts / SiliconFlow 代理是免 key 的本機服務，缺 credentialRef 不該擋單
 * （缺 key 的付費上游會自行回 401，交詞表判 authentication）。
 */
function optionalCredential(supplier: SupplierRecord): string {
  return (process.env[supplier.account.credentialRef] ?? process.env[supplier.credentialRef] ?? "").trim();
}

function forwardableExtraParams(supplier: SupplierRecord): string[] {
  const raw = supplier.configuration?.ttsParams;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (value): value is string =>
      typeof value === "string" && (FORWARDABLE_EXTRA_PARAMS as readonly string[]).includes(value),
  );
}

/** 上游錯誤本文抽取：JSON `{error:{message}}` 優先，非 JSON 取前 500 字（原文透傳不吞）。 */
function upstreamErrorMessage(text: string, status: number): string {
  const trimmed = text.trim();
  if (!trimmed) return `TTS upstream returned HTTP ${status} with an empty body.`;
  try {
    const parsed = JSON.parse(trimmed) as { error?: { message?: unknown }; message?: unknown };
    const message = parsed?.error?.message ?? parsed?.message;
    if (typeof message === "string" && message.trim()) return message.trim().slice(0, 1000);
  } catch {
    // 非 JSON：走原文
  }
  return trimmed.slice(0, 500);
}

/**
 * tts_speech supplier → /audio/speech → SupplierGenerationOutput（base64 MP3）。
 * 分派入口：supplier-adapter.ts requestSupplier 的 tts_speech 分支。
 */
export async function generateWithTtsSpeech(
  supplier: SupplierRecord,
  input: SupplierGenerationInput,
): Promise<SupplierGenerationOutput> {
  const workflow = input.workflow as { voice?: unknown; speed?: unknown; pitch?: unknown; emotion?: unknown; cards?: unknown };
  const cards = Array.isArray(workflow.cards) ? (workflow.cards as CharacterCard[]) : null;
  const resolution = resolveTtsVoice({ voiceCode: workflow.voice, cards });
  const params = ttsVoiceRequestParams({
    resolution,
    speed: workflow.speed,
    pitch: workflow.pitch,
    emotion: workflow.emotion,
  });

  const allowed = forwardableExtraParams(supplier);
  const transmitted: string[] = ["voice", "input", "response_format"];
  const body: Record<string, unknown> = {
    model: input.supplierModelId ?? input.modelId,
    input: input.prompt,
    voice: params.voice,
    response_format: RESPONSE_FORMAT,
  };
  if (typeof params.speed === "number") {
    body.speed = params.speed;
    transmitted.push("speed");
  }
  for (const key of FORWARDABLE_EXTRA_PARAMS) {
    if (!allowed.includes(key)) continue;
    const value = params[key];
    if (value === undefined) continue;
    body[key] = value;
    transmitted.push(key);
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const credential = optionalCredential(supplier);
  if (credential) headers.Authorization = `Bearer ${credential}`;

  let response: Response;
  try {
    response = await fetch(`${cleanBaseUrl(supplier.baseUrl)}/audio/speech`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Number(process.env.TTS_SUPPLIER_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS)),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new SupplierRequestError("TTS upstream request timed out.", 408, null, undefined, "deadline_exceeded");
    }
    throw error;
  }

  // artifact metadata（刀 3 可查證端）：voice_code 落在成品 artifact 的 metadata_json，
  // 由 listCompletedGenerationArtifacts → task response `data[].metadata` 對外可查。
  //
  // voice_effective：**誠實欄位**。本站 gateway（VPS /opt/edge-tts/tts-proxy.js）
  // 對不含 `:` 的 voice 會靜默改寫成 `<model>:alex`（實測 2026-09-15）——這類請求
  // 會成功回 200 但**不是**指定的音色。這裡把它顯式記下來，避免「任務成功」被誤讀成
  // 「音色生效」。值域：verified=庫內實測可播集；unknown=未實測；collapsed=上游會改寫。
  const voiceEffective = resolution.entry?.playable
    ? "verified"
    : resolution.voiceCode.includes(":")
      ? "unknown"
      : "collapsed";
  const artifactMetadata: Record<string, unknown> = {
    voice_code: resolution.voiceCode,
    voice_source: resolution.source,
    voice_library_known: resolution.entry !== null,
    voice_effective: voiceEffective,
    voice_params_transmitted: transmitted.join(","),
    ...(resolution.entry ? { voice_name: resolution.entry.voiceName } : {}),
    ...(typeof params.speed === "number" ? { tts_speed: params.speed } : {}),
    ...(typeof params.pitch === "number" ? { tts_pitch: params.pitch } : {}),
    ...(typeof params.emotion === "string" ? { tts_emotion: params.emotion } : {}),
  };

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const message = upstreamErrorMessage(text, response.status);
    // 400/422 且訊息涉及 voice：上游不接受該音色編碼 = 參數錯誤（非供應商故障）。
    // 判 user_input 而非 model_unsupported：後者會觸發 scheduler 停用整個供應商。
    const voiceRejected =
      (response.status === 400 || response.status === 422) && /voice|音色|timbre|speaker/i.test(message);
    throw new SupplierRequestError(
      `TTS upstream rejected the request: HTTP ${response.status}. ${message}`,
      response.status,
      response.headers.get("retry-after"),
      text.slice(0, 1000),
      voiceRejected ? "user_input" : undefined,
    );
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) throw new SupplierRequestError("TTS upstream returned an empty audio body.", response.status, null, undefined, "empty_result");

  return {
    base64: bytes.toString("base64"),
    url: null,
    providerRequestId: response.headers.get("x-request-id") ?? undefined,
    httpStatus: response.status,
    endpointLabel: supplier.label,
    supplierModelId: String(body.model),
    artifactMetadata,
    evidence: {
      adapter: supplier.adapterType,
      supplierId: supplier.id,
      voiceCode: resolution.voiceCode,
      voiceSource: resolution.source,
      voiceLibraryKnown: resolution.entry !== null,
      voiceEffective,
      bytes: bytes.length,
    },
  };
}
