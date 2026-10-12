import { tool } from "@opencode-ai/plugin/tool"
import {
  priceForAsync,
  classifyError,
  confirmSpend,
  dedupHash,
  registerTask,
  platformFetch,
  siteFetch,
  probeModelAvailable,
  publicImageUrl,
  ok,
  fail,
} from "../lib/client"
import { checkAgentPath, looksLikeAgentPath } from "../lib/sandbox"

/**
 * 生图尺寸白名单（R9-C, 2026-09-30）：真源＝站点 GET /v1/openapi.json 的
 * components.schemas.ImageGenerationRequest.properties.size.enum（站点端由
 * src/lib/generation-core/durable-image-sizes.ts 的 DURABLE_IMAGE_SIZES 生成，与
 * /v1/images/generations 真正挡人的 SUPPORTED_SIZES 同源）。不在本地硬编，避免漂移。
 * 取不到真源 → 回 null，呼叫端放行交给上游裁决（上游 400 会被 classifyError 具名成 unsupported_size）。
 * 事故依据：yuri-op-mv SSE 8433 confirm.request（1280x720）→ 8442 批准 → 8444 http_400 不支持的 size。
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

/** 「通路可用」宣告纪律（R9-C）：所有失败结果附带，防止 agent 把参数错误/被挡误读成通路可用。 */
const CHANNEL_NOT_VERIFIED =
  "本次没有生成出任何图片，模型/付费通路的可用性未被验证。只有工具真的回传成功出图（拿到 url，或 task 最终 succeeded）才可对用户说该模型/付费通路「可用、是活的」；参数错误、提交前被挡、确认被拒都不算。"

/** 参考图上限（与站点 /api/canvas/generate 的 5 张同尺，上游自尾部截断）。 */
const MAX_REFERENCE_IMAGES = 5

/** 视频确认金额直接取站点计费函数导出的完整档位，未知时不提交。 */
async function videoCostFromCatalog(
  model: string, secs: number, generateAudio: boolean | undefined, sessionID: string, signal?: AbortSignal,
): Promise<{ coins: number; billing_unit: string; resolution: string } | null> {
  try {
    const res = await platformFetch("/models", { method: "GET" }, sessionID, signal)
    if (!res.ok) return null
    const body = (await res.json()) as { data?: Array<Record<string, any>> }
    const m = (body.data ?? []).find((x) => x?.id === model)
    const billing = m?.x_billing
    const resolution = m?.x_capabilities?.defaultResolution
    const audio = generateAudio ?? m?.x_capabilities?.defaultAudio === true
    if (audio && m?.x_capabilities?.audio !== true) return null
    const table = audio ? billing?.prices_with_audio ?? billing?.prices : billing?.prices
    const coins = typeof resolution === "string" ? table?.[resolution]?.[String(secs)] : undefined
    if (billing?.currency !== "coins" || !["per_second", "per_video"].includes(billing.unit) || typeof coins !== "number" || !Number.isFinite(coins) || coins < 0) return null
    return { coins, billing_unit: billing.unit, resolution }
  } catch { return null }
}

/**
 * 验证 `data:image/...;base64,...` 参考图（2026-10-04 修）：只放行 image/* 的 base64 data URI，
 * 且 base64 必须能解出非空位元组（round-trip 比对，容忍空白与 padding）。不合法回报错讯息，
 * 合法回 null。此前的 `/^(https?:|data:image)/` 前缀检查会让 `data:image/png;base64,@@@` 或
 * `data:text/html;base64,...` 直接放行，坏资料送上游只换来一句笼统失败。
 */
function validateDataImage(src: string, index: number): string | null {
  const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]*)$/.exec(src)
  if (!m) {
    return `第 ${index} 张参考图 data URI 不合法：应为 data:image/<类型>;base64,<数据>（目前只支持 base64 编码的图片）。`
  }
  const payload = m[2].replace(/\s+/g, "")
  if (!payload) {
    return `第 ${index} 张参考图 data URI 的 base64 数据为空。`
  }
  const bytes = Buffer.from(payload, "base64")
  const normalized = payload.replace(/=+$/, "")
  if (bytes.length === 0 || bytes.toString("base64").replace(/=+$/, "") !== normalized) {
    return `第 ${index} 张参考图 base64 解码失败（不是合法的 base64 数据），请检查后重传。`
  }
  return null
}

/**
 * 参考图正规化（A1 2026-09-25；2026-10-04 修：本机／工作区路径改走公开媒体上传轮子）。
 * 把 args.reference_images 每个元素转成上游吃得下的字串（≤5 张，超过明确报错不截断）：
 * - `http(s)://` → 原样放行；`data:image/...;base64,...` → 先验格式与 base64 可解再放行。
 * - 看似路径 → 先过沙箱白名单闸 checkAgentPath（realpath 落 workspace 子树、uploads 只放行
 *   本会话），再复用 publicImageUrl（= image_edit 同一条轮子：readLocalImageBytes →
 *   网关 /internal/media/upload）读位元组换成公网 URL。
 * - 其余（含 media: 句柄）→ fail-loud。
 * 任一项失败 → { ok:false }（呼叫端回 fail("upload_failed")），**不静默丢图**
 * （丢掉参考图＝出的图与参考无关，属静默假成功）。大小上限沿用 publicImageUrl 的
 * MAX_UPLOAD_BYTES（20MB），超限明确报错，不截断。
 */
async function normalizeReferenceImages(
  raw: string[] | undefined,
  sessionID: string,
  signal?: AbortSignal,
  maxImages = MAX_REFERENCE_IMAGES,
): Promise<{ ok: true; images: string[] } | { ok: false; message: string }> {
  const images: string[] = []
  // 超过上限不静默截断（2026-10-04 修）：静默丢掉第 6 张以后＝「参考图与出图无关」的假成功。
  const provided = raw ?? []
  if (provided.length > maxImages) {
    return {
      ok: false,
      message: `参考图最多 ${maxImages} 张，本次收到 ${provided.length} 张（未截断、未提交）。请精简到 ${maxImages} 张以内后重试。`,
    }
  }
  const items = provided
  for (let i = 0; i < items.length; i++) {
    const src = typeof items[i] === "string" ? (items[i] as string).trim() : ""
    // 空字串也算一项「提供但不可用」的参考图：如实报错，不静默丢（丢图＝出图与参考无关）。
    if (!src) {
      return { ok: false, message: `第 ${i + 1} 张参考图为空字符串，请传 http(s) URL、data:image/...;base64,... 或工作区内的本地绝对路径。` }
    }
    // data:image/...;base64,... 必须先验格式与 base64 可解（2026-10-04 修）：坏 base64 照送
    // 只会让上游回一句笼统错误，这里当场说清楚，且不得把解不开的资料当成有效参考图。
    if (/^data:/i.test(src)) {
      const invalid = validateDataImage(src, i + 1)
      if (invalid) return { ok: false, message: invalid }
      images.push(src)
      continue
    }
    if (/^https?:/i.test(src)) {
      images.push(src)
      continue
    }
    if (!looksLikeAgentPath(src)) {
      return {
        ok: false,
        message: `第 ${i + 1} 张参考图无法识别：${src}。只接受 http(s) URL、data:image/...;base64,... 或工作区内的本地绝对路径。`,
      }
    }
    // 看似路径 → 必须经沙箱白名单闸（不得绕过、不得读工作区外的档）。
    const verdict = checkAgentPath(src, sessionID)
    if (!verdict.ok) {
      const reasonText: Record<string, string> = {
        outside_workspace: "路径不在创作工作区内",
        internal_state: "路径是平台内部状态目录，不对创作任务开放",
        internal_config: "路径是平台内部配置文件，不对创作任务开放",
        uploads_root: "不能指向全部上传目录",
        foreign_upload: "该附件不属于当前会话",
      }
      return {
        ok: false,
        message: `第 ${i + 1} 张参考图路径被沙箱拒绝（${reasonText[verdict.reason] ?? verdict.reason}）：${src}。只能读取本会话可见的文件（推荐 uploads/<session>/ 下的附件），或改传 http(s) URL / data:image。`,
      }
    }
    try {
      // 复用 image_edit durable 链的同一轮子：读位元组 → 网关 /internal/media/upload → 公网 URL。
      const url = await publicImageUrl(src, sessionID, signal)
      if (!url) {
        return {
          ok: false,
          message: `第 ${i + 1} 张参考图（${src}）入库后未拿到公网 URL，请改用公网 URL 或 data:image 重试。`,
        }
      }
      images.push(url)
    } catch (e: any) {
      const msg = e?.message || String(e)
      // 传目录时 readFileSync 会抛裸 EISDIR（2026-10-04 修）：换成人话，不把 errno 丢给用户。
      if (/EISDIR|illegal operation on a directory/i.test(msg)) {
        return { ok: false, message: `第 ${i + 1} 张参考图路径是目录、不是图片文件：${src}。请传入具体图片文件路径。` }
      }
      return { ok: false, message: `第 ${i + 1} 张参考图处理失败（${src}）：${msg}` }
    }
  }
  return { ok: true, images }
}

/**
 * 去重键（A1, 2026-09-25）：dedupHash 只读 model/prompt/size/n 四个栏位，故把「正规化后的
 * 参考图清单」接进 prompt 栏位一起算。无参考图 → 回传原 prompt，杂凑与改动前逐位元相同
 * （既有快取不失效）；有参考图 → 杂凑必不同，避免「同 prompt 换了参考图」误命中快取、
 * 回一张没有该角色的图。
 */
function dedupKeyPrompt(prompt: string, referenceImages: string[]): string {
  if (referenceImages.length === 0) return prompt
  return `${prompt}\u0000ref:${referenceImages.join("\u0000")}`
}

/**
 * 行内实体 tag 解析（E2, 2026-09-25）：prompt 内有 `@[种类:名称]` 时，先请站点把 tag
 * 就地展开成该卡的描述片段，并把命中卡的参考图并进 reference_images（卡的图在前、≤5）。
 * 解析是平台的事，工具端只用 `prompt.includes("@[")` 判断、不自己写 token regex。
 * 不含 `@[` 时完全不呼叫（不多一个 RTT，行为与改动前逐位元相同）。
 * 失败回 { ok:false }，呼叫端必须 fail("card_resolve_failed")，且不得把含原始 `@[...]`
 * 的 prompt 送去生图（原始 token 进模型＝生出废图）。
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
        // 无参考图时不带该键（与生成 payload 同纪律）。
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
      return { ok: false, message: "回应形状不符（缺 prompt 字串）" }
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
    "异步提交图片或视频生成，返回完整task_id；完成由harness续接，不轮询。单图和已有分镜关键帧可直接调用；多镜制作沿用workflow工具。先用image_quote/video_quote核当前模型、尺寸、时长与价格。≤0.1币低成本草稿可直接执行；其它按本轮网关授权：full/auto直接提交，无持续或已有预算授权时确认。工具成功交付url或任务succeeded才证明产出；余额不足与模型不可用按原始错误区分。参考图支持URL/data URL/合法本地路径；可用角色卡tag或character_card_list维持一致性，图片参考不保证锁定视频首尾帧。返回task_id完整保留。",
  args: {
    prompt: tool.schema.string().describe("生成提示词"),
    model: tool.schema.string().optional().describe("模型名，预设 gpt-image-2"),
    size: tool.schema.string().optional().describe("尺寸，如 1024x1024"),
    n: tool.schema.number().int().min(1).max(4).optional().describe("生成张数，预设 1"),
    kind: tool.schema.enum(["image", "video"]).optional().describe("image 或 video，预设 image"),
    quality: tool.schema
      .enum(["standard", "hd"])
      .optional()
      .describe("standard 或 hd，预设 standard。部分模型 hd 较贵（如 gpt-image-2 标准 1 币 / hd 2 币）"),
    duration_seconds: tool.schema
      .number()
      .min(5)
      .optional()
      .describe(
        "视频时长（秒），minimax-h3 支持 5–15 秒，默认推荐 15 秒；其他模型以 video_quote 为准。",
      ),
    generate_audio: tool.schema.boolean().optional().describe("是否生成音讯，仅 video 用"),
    reference_images: tool.schema
      .array(tool.schema.string())
      .max(9)
      .optional()
      .describe(
        "参考图：图片最多5张，视频上限依模型（minimax-h3最多9张）；支持http(s) URL、data:image或合法本地绝对路径，原始校验错误会返回，不静默丢图。图片参考不保证锁定视频首尾帧。",
      ),
  },
  async execute(args, context) {
    const model = args.model ?? "gpt-image-2"
    // 模型可用性强制探测（2026-08-15）：不可用不得提交，避免把请求发给坏渠道。
    const probe = await probeModelAvailable(model, context.sessionID, context.abort)
    if (probe.availability === "unavailable") {
      return fail(
        "model_unavailable",
        `模型 ${model} 目前不可用（${probe.note ?? "渠道故障"}）——这是模型/通路层故障，不是用户余额问题。请改用同类型可用模型，或告知用户此模型暂时不可用。`,
        { channel_verified: false, note: CHANNEL_NOT_VERIFIED },
      )
    }

    const size = args.size ?? "1024x1024"
    const n = args.n ?? 1
    const kind = args.kind ?? "image"

    // 尺寸白名单前置校验（R9-C）：必须在报价/confirm.request 之前，非法尺寸不得让用户签字。
    if (kind === "image") {
      const allowed = await supportedImageSizes(context.sessionID, context.abort)
      if (allowed && !allowed.includes(size)) {
        return fail(
          "unsupported_size",
          `不支持的 size ${size}（未提交、未跳确认、未扣费）。可选：${allowed.join("、")}。16:9/横图请用 1536x1024，竖图用 1024x1536。改好尺寸再调用。`,
          { allowed_sizes: allowed, channel_verified: false, note: CHANNEL_NOT_VERIFIED },
        )
      }
    }

    const maxReferences = kind === "video" && model === "minimax-h3" ? 9 : MAX_REFERENCE_IMAGES
    if ((args.reference_images?.length ?? 0) > maxReferences) {
      return fail("invalid_reference_images", `模型 ${model} 最多接受 ${maxReferences} 张参考图，本次未提交且未扣费。`)
    }

    const raw_duration = args.duration_seconds
    const generate_audio = args.generate_audio

    // minimax-h3 视频支持 5–15 秒；默认推荐 15 秒
    if (kind === "video") {
      if (typeof raw_duration === "number" && raw_duration < 5) {
        return fail(
          "invalid_duration",
          `时长档位违规：${raw_duration} 秒过短。平台硬规则（§4b 时长档位最大化）：上游视频按条计费，视频时长最少 5 秒。minimax-h3 为 5–15 秒，推荐 15 秒；其他模型以 video_quote 为准，并遵循时长最大化原则。`,
        )
      }
    }
    const duration_seconds = kind === "video" ? (raw_duration ?? 15) : undefined

    // 最近 24h 真实表现提醒（2026-08-27）：可用 ≠ 表现好。样本 ≥5 且成功率 <50%
    // 时，先劝 agent 换模型而不是把请求发出去（失败会浪费排队时间，退款也不补时间）。
    const last24h = probe.last_24h
    if (last24h && last24h.jobs >= 5 && last24h.success_rate < 0.5) {
      return fail(
        "model_low_success_rate",
        `模型 ${model} 探测可用，但最近 24h 真实成功率只有 ${Math.round(last24h.success_rate * 100)}%（${last24h.delivered}/${last24h.jobs} 成功，${last24h.refunded} 笔已退款）。强烈建议改用同类型近期成功率高的模型（可查 /v1/model-status 的 last_24h 对比），或明确告知用户此模型近期表现差、可能反覆失败。`,
      )
    }

    // 单价取自平台目录（权威值），不用本地硬编码表
    const unit = await priceForAsync(model, context.sessionID, args.quality, context.abort)
    // 影片：目录秒价 × 时长（与实扣同源，R9-A2）；目录查不到才粗估并在确认卡标「粗估待确认」。
    const video_price =
      kind === "video"
        ? await videoCostFromCatalog(model, duration_seconds ?? 10, generate_audio, context.sessionID, context.abort)
        : null
    if (kind === "video" && !video_price) return fail("video_price_unknown", "目录没有本次完整提交档位的币值报价；尚未提交生成，不以未知价格开跑。")
    if (kind === "video" && args.quality === "hd" && video_price?.resolution !== "1080p") return fail("unsupported_resolution", "当前视频API不接受显式1080p品质；模型默认档不同，未提交且未降规格。")
    const cost_coins =
      kind === "video"
        ? video_price!.coins
        : Math.round(unit * n * 1e6) / 1e6

    // 扣费闸门：≤0.1 币的草稿直接放行，其余需用户确认
    if (cost_coins > 0.1) {
      const description =
        kind === "video"
          ? video_price
            ? `生成 ${duration_seconds ?? 10} 秒视频（${model}，${video_price.resolution}、${video_price.billing_unit}），预估花费 ${cost_coins} 币`
            : `生成 ${duration_seconds ?? 10} 秒视频（${model}），预估花费 ${cost_coins} 币（目录查无秒价，粗估待确认，实扣可能更高）`
          : `生成 ${n} 张图（${model}），预估花费 ${cost_coins} 币`
      const approved = await confirmSpend(
        { sessionID: context.sessionID, amount_coins: cost_coins, description, model },
        context.abort,
      )
      if (!approved) {
        return fail("user_declined", "用户未确认扣费，已取消。可以改用更便宜的模型或减少张数再试。", {
          channel_verified: false,
          note: CHANNEL_NOT_VERIFIED,
        })
      }
    }

    let poller_ok: boolean | undefined
    let poller_error: string | undefined

    try {
      const endpoint = kind === "video" ? "/videos/generations" : "/images/generations"
      // 参考图正规化（A1, 2026-09-25）：本机路径先上传平台取公网 URL；失败如实报错。
      const normalized_refs = await normalizeReferenceImages(args.reference_images, context.sessionID, context.abort, maxReferences)
      if (!normalized_refs.ok) return fail("upload_failed", normalized_refs.message)
      let reference_images = normalized_refs.images
      // 行内实体 tag 解析（E2, 2026-09-25）：只在 prompt 含 `@[` 时呼叫；必须在送出
      // 生成请求之前完成，且解析后的值才是真正送上游／算 dedup 的值。
      let final_prompt = args.prompt
      let card_warnings: string[] = []
      if (args.prompt.includes("@[")) {
        const resolved = await resolveCharacterTags(final_prompt, reference_images, context.sessionID, context.abort)
        if (!resolved.ok) {
          return fail(
            "card_resolve_failed",
            `角色卡解析失败（${resolved.message}）。可改用 reference_images 直接带该角色的参考图，或稍后重试。`,
          )
        }
        final_prompt = resolved.prompt
        reference_images = kind === "video"
          ? [...reference_images, ...resolved.reference_images.filter((url) => !reference_images.includes(url))]
          : resolved.reference_images
        if (reference_images.length > maxReferences) return fail("invalid_reference_images", `角色卡补图后共 ${reference_images.length} 张，超过 ${maxReferences} 张；原参考图未截断、未提交。`)
        card_warnings = resolved.warnings
      }
      const card_note = card_warnings.length > 0 ? `【角色卡 tag 提醒】${card_warnings.join("；")}` : ""
      const payload: any =
        kind === "video"
          ? { prompt: final_prompt, model, size, duration_seconds, generate_audio, ...(reference_images.length > 0 ? { reference_images } : {}) }
          : {
              prompt: final_prompt,
              model,
              size,
              n,
              response_format: "url",
              ...(args.quality ? { quality: args.quality } : {}),
              // 无参考图时此键不出现，payload 与改动前逐栏位相同。
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
          // 注册给 poller 自动轮询；best-effort，失败不影响主流程。
          // dedup_hash 让 poller 能认出「同一个请求重送」直接回快取（0 币），
          // cost_coins 让 poller 续接时发得出正确金额（平台轮询回应不含价格）。
          // E2：杂凑用「解析后」的最终 prompt 与最终参考图——否则同一个请求重送会
          // 误命中不同内容的快取。
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
              "已提交。完成时间不定：空闲时通常几十秒到几分钟，高峰期可能排队更久，逾时会自动退款——对用户报耗时时用这个分档说法，不要报精确秒数。harness 会自动续接结果。不要轮询。回报 task_id 给用户时必须原样照抄完整 UUID（36 字元含连字号），严禁截断成前 8 位——短 id 在平台查不到任务。" +
              (card_note ? `\n${card_note}` : ""),
          },
          { poller_ok, poller_error },
        )
      }

      // 部分实作可能同步直接回图，兜底处理
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
