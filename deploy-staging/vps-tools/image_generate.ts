import { tool } from "@opencode-ai/plugin/tool"
import {
  priceForAsync,
  estimateVideoCoins,
  classifyError,
  confirmSpend,
  dedupHash,
  registerTask,
  platformFetch,
  siteFetch,
  probeModelAvailable,
  uploadImageBytes,
  ok,
  fail,
} from "../lib/client"

/**
 * 生圖尺寸白名單（R9-C, 2026-09-30）：真源＝站點 GET /v1/openapi.json 的
 * components.schemas.ImageGenerationRequest.properties.size.enum（站點端由
 * src/lib/generation-core/durable-image-sizes.ts 的 DURABLE_IMAGE_SIZES 生成，與
 * /v1/images/generations 真正擋人的 SUPPORTED_SIZES 同源）。不在本地硬編，避免漂移。
 * 取不到真源 → 回 null，呼叫端放行交給上游裁決（上游 400 會被 classifyError 具名成 unsupported_size）。
 * 事故依據：yuri-op-mv SSE 8433 confirm.request（1280x720）→ 8442 批准 → 8444 http_400 不支持的 size。
 */
let sizeWhitelistCache: { at: number; sizes: string[] } | null = null
const SIZE_WHITELIST_TTL_MS = 10 * 60 * 1000

async function supportedImageSizes(sessionID: string, signal?: AbortSignal): Promise<string[] | null> {
  if (sizeWhitelistCache && Date.now() - sizeWhitelistCache.at < SIZE_WHITELIST_TTL_MS) return sizeWhitelistCache.sizes
  try {
    const resp = await platformFetch("/openapi.json", { method: "GET" }, sessionID, signal)
    if (!resp.ok) return sizeWhitelistCache?.sizes ?? null
    const spec: any = await resp.json().catch(() => null)
    const e = spec?.components?.schemas?.ImageGenerationRequest?.properties?.size?.enum
    const sizes = Array.isArray(e) ? e.filter((x: unknown): x is string => typeof x === "string" && !!x) : []
    if (sizes.length === 0) return sizeWhitelistCache?.sizes ?? null
    sizeWhitelistCache = { at: Date.now(), sizes }
    return sizes
  } catch {
    return sizeWhitelistCache?.sizes ?? null
  }
}

/** 「通路可用」宣告紀律（R9-C）：所有失敗結果附帶，防止 agent 把參數錯誤/被擋誤讀成通路可用。 */
const CHANNEL_NOT_VERIFIED =
  "本次沒有生成出任何圖片，模型/付費通路的可用性未被驗證。只有工具真的回傳成功出圖（拿到 url，或 task 最終 succeeded）才可對用戶說該模型/付費通路「可用、是活的」；參數錯誤、提交前被擋、確認被拒都不算。"

/** 參考圖上限（與站點 /api/canvas/generate 的 5 張同尺，上游自尾部截斷）。 */
const MAX_REFERENCE_IMAGES = 5

/**
 * 影片確認金額（R9-A2 2026-09-30）：與 quote_bundle 同口徑——GET /v1/models 的
 * x_coins_per_second[解析度] × 時長（平台 /v1/videos/generations 以 generationCoins
 * 按秒扣費、gateway catalogVideoPerSecondCoins 同源）。本工具提交的 payload 不帶
 * resolution，平台按模型 defaultResolution 扣，故取 defaultResolution 那一檔；
 * generate_audio=true 且目錄有 x_coins_per_second_with_audio 時用帶音價。
 * 目錄查不到才退回 estimateVideoCoins（720P 5 幣/秒粗估）並在確認卡標「粗估待確認」。
 * 舊版一律走 estimateVideoCoins：seedance-2.0 15s 確認卡報 75，實扣 195。
 */
async function videoCostFromCatalog(
  model: string,
  secs: number,
  generateAudio: boolean | undefined,
  sessionID: string,
  signal?: AbortSignal,
): Promise<{ coins: number; coins_per_second: number; resolution: string } | null> {
  try {
    const res = await platformFetch("/models", { method: "GET" }, sessionID, signal)
    if (!res.ok) return null
    const body = (await res.json()) as { data?: Array<Record<string, any>> }
    const m = (body.data ?? []).find((x) => x?.id === model)
    const table = generateAudio && m?.x_coins_per_second_with_audio ? m.x_coins_per_second_with_audio : m?.x_coins_per_second
    if (!table || typeof table !== "object") return null
    const cps: Record<string, number> = {}
    for (const [k, v] of Object.entries(table)) if (typeof v === "number") cps[k.toLowerCase()] = v
    const def = m?.x_capabilities?.defaultResolution
    const resolution = (typeof def === "string" ? def : Object.keys(cps)[0] ?? "").toLowerCase()
    const rate = cps[resolution]
    if (typeof rate !== "number") return null
    return { coins: Math.round(rate * secs * 1e6) / 1e6, coins_per_second: rate, resolution }
  } catch {
    return null
  }
}

/**
 * 參考圖正規化（A1, 2026-09-25）：把 args.reference_images 每個元素轉成上游吃得下的字串。
 * - 已是 http(s) / data:image → 原樣傳。
 * - 其餘（本機絕對路徑、聊天附件路徑）→ 上傳平台 /uploads，取公網 url；url 空則退回 mediaId。
 * 保序、上限 5；兩者皆空 → { ok:false }（呼叫端回 fail("upload_failed")，不靜默丟圖）。
 */
async function normalizeReferenceImages(
  raw: string[] | undefined,
  sessionID: string,
  signal?: AbortSignal,
): Promise<{ ok: true; images: string[] } | { ok: false; message: string }> {
  const images: string[] = []
  for (const item of (raw ?? []).slice(0, MAX_REFERENCE_IMAGES)) {
    const src = typeof item === "string" ? item.trim() : ""
    if (!src) continue
    if (/^(https?:|data:image)/i.test(src)) {
      images.push(src)
      continue
    }
    const up = await uploadImageBytes(src, sessionID, signal)
    const ref = (up?.url || up?.mediaId || "").trim()
    if (!ref) {
      return {
        ok: false,
        message: `參考圖上傳失敗（${src}）：平台未回傳可用位址，請改用公網 URL 或 data:image 重試。`,
      }
    }
    images.push(ref)
  }
  return { ok: true, images }
}

/**
 * 去重鍵（A1, 2026-09-25）：dedupHash 只讀 model/prompt/size/n 四個欄位，故把「正規化後的
 * 參考圖清單」接進 prompt 欄位一起算。無參考圖 → 回傳原 prompt，雜湊與改動前逐位元相同
 * （既有快取不失效）；有參考圖 → 雜湊必不同，避免「同 prompt 換了參考圖」誤命中快取、
 * 回一張沒有該角色的圖。
 */
function dedupKeyPrompt(prompt: string, referenceImages: string[]): string {
  if (referenceImages.length === 0) return prompt
  return `${prompt}\u0000ref:${referenceImages.join("\u0000")}`
}

/**
 * 行內實體 tag 解析（E2, 2026-09-25）：prompt 內有 `@[種類:名稱]` 時，先請站點把 tag
 * 就地展開成該卡的描述片段，並把命中卡的參考圖併進 reference_images（卡的圖在前、≤5）。
 * 解析是平台的事，工具端只用 `prompt.includes("@[")` 判斷、不自己寫 token regex。
 * 不含 `@[` 時完全不呼叫（不多一個 RTT，行為與改動前逐位元相同）。
 * 失敗回 { ok:false }，呼叫端必須 fail("card_resolve_failed")，且不得把含原始 `@[...]`
 * 的 prompt 送去生圖（原始 token 進模型＝生出廢圖）。
 */
async function resolveCharacterTags(
  prompt: string,
  referenceImages: string[],
  sessionID: string,
  signal?: AbortSignal,
): Promise<
  { ok: true; prompt: string; reference_images: string[]; warnings: string[] } | { ok: false; message: string }
> {
  try {
    const resp = await siteFetch(
      "/api/biz/character-resolve",
      {
        method: "POST",
        // 無參考圖時不帶該鍵（與生成 payload 同紀律）。
        body: JSON.stringify({
          prompt,
          ...(referenceImages.length > 0 ? { reference_images: referenceImages } : {}),
        }),
      },
      sessionID,
      signal,
    )
    if (!resp.ok) return { ok: false, message: `HTTP ${resp.status}` }
    const body: any = await resp.json().catch(() => null)
    if (!body || typeof body !== "object" || typeof body.prompt !== "string") {
      return { ok: false, message: "回應形狀不符（缺 prompt 字串）" }
    }
    const refs = Array.isArray(body.reference_images)
      ? body.reference_images
          .filter((u: unknown): u is string => typeof u === "string" && !!u.trim())
          .slice(0, MAX_REFERENCE_IMAGES)
      : referenceImages
    const warnings = Array.isArray(body.warnings)
      ? body.warnings.filter((w: unknown): w is string => typeof w === "string" && !!w.trim())
      : []
    return { ok: true, prompt: body.prompt, reference_images: refs, warnings }
  } catch (e: any) {
    return { ok: false, message: e?.message || String(e) }
  }
}

export default tool({
  description:
    "提交生圖任務，回 task_id。【通路可用性宣告紀律】只有本工具真的成功出圖（拿到 url，或 task 最終 succeeded）才可對用戶說某模型/付費通路「可用、是活的」；參數錯誤（如 unsupported_size）、提交前被擋、確認被拒、insufficient_quota 都沒有驗證通路，不得據此宣稱通路可用。insufficient_quota＝用戶帳戶餘額不足（帳戶層，換模型無效）；model_unavailable＝該模型通路故障（模型層，可換同類模型）——兩者不可混報。size（僅 kind=image）只接受站點白名單（GET /v1/openapi.json 的 ImageGenerationRequest.size.enum，目前為 1024x1024/1536x1024/1024x1536/2048x2048/4096x4096，要 16:9 橫圖用 1536x1024），白名單外在確認扣費前就會被拒。此工具是「非同步」的：完成時間不定（空閒時幾十秒到幾分鐘，高峰期排隊可能更久、逾時自動退款），harness 會自動續接結果。不要用本工具等待/輪詢結果，提交後立即交還控制權。預估花費 ≤0.1 幣的低成本草稿（如 gpt-image-2 單張）會直接執行、不需確認；其餘會先跳出扣費確認。\n\n【重要分流】用戶要「影片/大片/電影/名場面/分鏡腳本/角色四視圖/多鏡頭」時，必須用 workflow_* 工具建工作流（workflow_start + workflow_add_node + workflow_connect + workflow_generate），不要用本工具生單張圖。本工具只用於單張圖片生成。\n\n【影片時長硬規則（§4b 時長最大化）】生影片（kind=video）時，上游按條計費，全系影片只支持 ≥10 秒（嚴禁 5 秒短檔，10 秒以下虧本）；seedance-2.0 爲 10–15 秒，seedance-2.5-480p 爲 10–30 秒。必須選最大檔或符合分鏡的 ≥10s 檔。小於 10 秒將被工具直接拒絕。\n\n【task_id 紀律】回給用戶的 task_id 必須是工具返回的完整 UUID（36 字元、含連字號），原樣照抄，嚴禁截斷或縮寫（例如只寫前 8 位）——短 id 在平台永遠查不到任務。\n\n【角色一致性與 tag 角色卡】要用「同一張臉」時，優先把該角色的參考圖（三視圖／定妝照）用 reference_images 帶上——這比只寫文字描述可靠。也可以在 prompt 裡寫行內實體 tag `@[角色:名稱]`（種類字可用 角色/场景/风格/道具/音频，繁簡皆可）：平台會用該用戶角色卡庫裡同名同 kind 的卡自動展開它的描述片段並附上它的參考圖；卡庫裡沒有同名卡時 tag 會原樣保留（不會報錯）。用 character_card_list 可以列出該用戶已有的卡（名稱/種類/參考圖）——先查再寫 tag，不要憑記憶猜名字。",
  args: {
    prompt: tool.schema.string().describe("生成提示詞"),
    model: tool.schema.string().optional().describe("模型名，預設 gpt-image-2"),
    size: tool.schema.string().optional().describe("尺寸，如 1024x1024"),
    n: tool.schema.number().int().min(1).max(4).optional().describe("生成張數，預設 1"),
    kind: tool.schema.enum(["image", "video"]).optional().describe("image 或 video，預設 image"),
    quality: tool.schema
      .enum(["standard", "hd"])
      .optional()
      .describe("standard 或 hd，預設 standard。部分模型 hd 較貴（如 gpt-image-2 標準 1 幣 / hd 2 幣）"),
    duration_seconds: tool.schema
      .number()
      .min(10)
      .optional()
      .describe(
        "影片時長（秒，僅 video 用，最小 10 秒）。硬規則（§4b 時長檔位最大化）：上游按條計費，全系影片只支持 ≥10 秒（嚴禁 5 秒短檔，10 秒以下虧本）；seedance-2.0 爲 10–15 秒，seedance-2.5 爲 10–30 秒。必須選最大檔或符合分鏡的 ≥10s 檔。",
      ),
    generate_audio: tool.schema.boolean().optional().describe("是否生成音訊，僅 video 用"),
    reference_images: tool.schema
      .array(tool.schema.string())
      .max(5)
      .optional()
      .describe("參考圖（最多 5 張）。可用：平台公網 URL、`data:image/...;base64,...`、或本機絕對路徑。"),
  },
  async execute(args, context) {
    const model = args.model ?? "gpt-image-2"
    // 模型可用性強制探測（2026-08-15）：不可用不得提交，避免把請求發給壞渠道。
    const probe = await probeModelAvailable(model, context.sessionID, context.abort)
    if (probe.availability === "unavailable") {
      return fail(
        "model_unavailable",
        `模型 ${model} 目前不可用（${probe.note ?? "渠道故障"}）——這是模型/通路層故障，不是用戶餘額問題。請改用同類型可用模型，或告知用戶此模型暫時不可用。`,
        { channel_verified: false, note: CHANNEL_NOT_VERIFIED },
      )
    }

    const size = args.size ?? "1024x1024"
    const n = args.n ?? 1
    const kind = args.kind ?? "image"

    // 尺寸白名單前置校驗（R9-C）：必須在報價/confirm.request 之前，非法尺寸不得讓用戶簽字。
    if (kind === "image") {
      const allowed = await supportedImageSizes(context.sessionID, context.abort)
      if (allowed && !allowed.includes(size)) {
        return fail(
          "unsupported_size",
          `不支持的 size ${size}（未提交、未跳確認、未扣費）。可選：${allowed.join("、")}。16:9/橫圖請用 1536x1024，豎圖用 1024x1536。改好尺寸再調用。`,
          { allowed_sizes: allowed, channel_verified: false, note: CHANNEL_NOT_VERIFIED },
        )
      }
    }

    // 影片參考圖尚未支援（A1, 2026-09-25）：如實報錯，不靜默丟掉參考圖。
    if (kind === "video" && (args.reference_images?.length ?? 0) > 0) {
      return fail("unsupported_reference_images", "影片參考圖尚未支援，請改用 kind=image 或改用 workflow_* 工具")
    }

    const raw_duration = args.duration_seconds
    const generate_audio = args.generate_audio

    // 影片時長硬規則（§4b）：嚴禁 <10 秒短檔
    if (kind === "video") {
      if (typeof raw_duration === "number" && raw_duration < 10) {
        return fail(
          "invalid_duration",
          `時長檔位違規：${raw_duration} 秒過短。平台硬規則（§4b 時長檔位最大化）：上游視頻按條計費，全系影片只支持 ≥10 秒（5 秒/短檔會造成平台虧本且被門禁攔截）。請改用支持的時長檔位（例如 seedance-2.0 爲 10–15 秒，seedance-2.5 爲 10–30 秒），並遵循時長最大化原則。`,
        )
      }
    }
    const duration_seconds = kind === "video" ? (raw_duration ?? 10) : undefined

    // 最近 24h 真實表現提醒（2026-08-27）：可用 ≠ 表現好。樣本 ≥5 且成功率 <50%
    // 時，先勸 agent 換模型而不是把請求發出去（失敗會浪費排隊時間，退款也不補時間）。
    const last24h = probe.last_24h
    if (last24h && last24h.jobs >= 5 && last24h.success_rate < 0.5) {
      return fail(
        "model_low_success_rate",
        `模型 ${model} 探測可用，但最近 24h 真實成功率只有 ${Math.round(last24h.success_rate * 100)}%（${last24h.delivered}/${last24h.jobs} 成功，${last24h.refunded} 筆已退款）。強烈建議改用同類型近期成功率高的模型（可查 /v1/model-status 的 last_24h 對比），或明確告知用戶此模型近期表現差、可能反覆失敗。`,
      )
    }

    // 單價取自平台目錄（權威值），不用本地硬編碼表
    const unit = await priceForAsync(model, context.sessionID, args.quality, context.abort)
    // 影片：目錄秒價 × 時長（與實扣同源，R9-A2）；目錄查不到才粗估並在確認卡標「粗估待確認」。
    const video_price =
      kind === "video"
        ? await videoCostFromCatalog(model, duration_seconds ?? 10, generate_audio, context.sessionID, context.abort)
        : null
    const cost_coins =
      kind === "video"
        ? (video_price?.coins ?? estimateVideoCoins(duration_seconds, args.quality))
        : Math.round(unit * n * 1e6) / 1e6

    // 扣費閘門：≤0.1 幣的草稿直接放行，其餘需用戶確認
    if (cost_coins > 0.1) {
      const description =
        kind === "video"
          ? video_price
            ? `生成 ${duration_seconds ?? 10} 秒视频（${model}，${video_price.resolution} ${video_price.coins_per_second} 币/秒），预估花费 ${cost_coins} 币`
            : `生成 ${duration_seconds ?? 10} 秒视频（${model}），预估花费 ${cost_coins} 币（目录查无秒价，粗估待确认，实扣可能更高）`
          : `生成 ${n} 张图（${model}），预估花费 ${cost_coins} 币`
      const approved = await confirmSpend(
        { sessionID: context.sessionID, amount_coins: cost_coins, description, model },
        context.abort,
      )
      if (!approved) {
        return fail("user_declined", "用戶未確認扣費，已取消。可以改用更便宜的模型或減少張數再試。", {
          channel_verified: false,
          note: CHANNEL_NOT_VERIFIED,
        })
      }
    }

    let poller_ok: boolean | undefined
    let poller_error: string | undefined

    try {
      const endpoint = kind === "video" ? "/videos/generations" : "/images/generations"
      // 參考圖正規化（A1, 2026-09-25）：本機路徑先上傳平台取公網 URL；失敗如實報錯。
      const normalized_refs = await normalizeReferenceImages(args.reference_images, context.sessionID, context.abort)
      if (!normalized_refs.ok) return fail("upload_failed", normalized_refs.message)
      let reference_images = normalized_refs.images
      // 行內實體 tag 解析（E2, 2026-09-25）：只在 prompt 含 `@[` 時呼叫；必須在送出
      // 生成請求之前完成，且解析後的值才是真正送上游／算 dedup 的值。
      let final_prompt = args.prompt
      let card_warnings: string[] = []
      if (args.prompt.includes("@[")) {
        const resolved = await resolveCharacterTags(final_prompt, reference_images, context.sessionID, context.abort)
        if (!resolved.ok) {
          return fail(
            "card_resolve_failed",
            `角色卡解析失敗（${resolved.message}）。可改用 reference_images 直接帶該角色的參考圖，或稍後重試。`,
          )
        }
        final_prompt = resolved.prompt
        reference_images = resolved.reference_images
        card_warnings = resolved.warnings
      }
      const card_note = card_warnings.length > 0 ? `【角色卡 tag 提醒】${card_warnings.join("；")}` : ""
      const payload: any =
        kind === "video"
          ? { prompt: final_prompt, model, size, duration_seconds, generate_audio }
          : {
              prompt: final_prompt,
              model,
              size,
              n,
              response_format: "url",
              ...(args.quality ? { quality: args.quality } : {}),
              // 無參考圖時此鍵不出現，payload 與改動前逐欄位相同。
              ...(reference_images.length > 0 ? { reference_images } : {}),
            }

      const resp = await platformFetch(
        endpoint,
        { method: "POST", body: JSON.stringify(payload) },
        context.sessionID,
        context.abort,
      )
      const data = await resp.json().catch(() => ({}))
      const task_id = data?.task_id ?? data?.id ?? null

      if (resp.status === 202 || (resp.ok && task_id)) {
        if (task_id) {
          // 註冊給 poller 自動輪詢；best-effort，失敗不影響主流程。
          // dedup_hash 讓 poller 能認出「同一個請求重送」直接回快取（0 幣），
          // cost_coins 讓 poller 續接時發得出正確金額（平台輪詢回應不含價格）。
          // E2：雜湊用「解析後」的最終 prompt 與最終參考圖——否則同一個請求重送會
          // 誤命中不同內容的快取。
          const reg = await registerTask(task_id, context.sessionID, kind, context.abort, {
            dedup_hash: dedupHash({ model, prompt: dedupKeyPrompt(final_prompt, reference_images), size, n }),
            model,
            cost_coins,
          })
          poller_ok = reg.ok
          poller_error = reg.error
        }
        return ok(
          {
            task_id: task_id ?? null,
            kind,
            model,
            estimated_cost_coins: cost_coins,
            note:
              "已提交。完成時間不定：空閒時通常幾十秒到幾分鐘，高峰期可能排隊更久，逾時會自動退款——對用戶報耗時時用這個分檔說法，不要報精確秒數。harness 會自動續接結果。不要輪詢。回報 task_id 給用戶時必須原樣照抄完整 UUID（36 字元含連字號），嚴禁截斷成前 8 位——短 id 在平台查不到任務。" +
              (card_note ? `\n${card_note}` : ""),
          },
          { poller_ok, poller_error },
        )
      }

      // 部分實作可能同步直接回圖，兜底處理
      if (resp.ok) {
        const url = data?.data?.[0]?.url || data?.result_url || data?.url
        if (url) {
          return ok({
            url,
            task_id: data?.id ?? null,
            kind,
            model,
            estimated_cost_coins: cost_coins,
            ...(card_note ? { note: card_note } : {}),
          })
        }
      }

      const err = await classifyError(resp, data)
      return fail(err.code, err.hint, { retry_after_ms: err.retry_after_ms, channel_verified: false, note: CHANNEL_NOT_VERIFIED })
    } catch (e: any) {
      const err = await classifyError(null, e)
      return fail(err.code, err.hint, { channel_verified: false, note: CHANNEL_NOT_VERIFIED })
    }
  },
})
