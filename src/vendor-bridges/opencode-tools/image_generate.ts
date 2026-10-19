import { tool } from "@opencode-ai/plugin/tool"
import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import {
  classifyError,
  confirmSpend,
  dedupHash,
  registerTask,
  platformFetch,
  siteFetch,
  loadCatalog,
  randomUUID,
  productionScope,
  publicImageUrl,
  authorizedProjectBudget,
  uploadImageBytes,
  ok,
  fail,
} from "../lib/client"
import { WORKSPACE, checkAgentPath, looksLikeAgentPath, safeFetch } from "../lib/sandbox"
import { acceptTaskSubmission, lockedProjectBudget, prepareSubmission, finishSubmission, getSubmission, contentHash } from "../lib/image-journal"

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
): Promise<{ ok: true; images: string[]; fingerprints: string[] } | { ok: false; message: string }> {
  const images: string[] = []
  const fingerprints:string[] = []
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
      fingerprints.push(createHash("sha256").update(Buffer.from(src.split(",")[1].replace(/\s+/g,""),"base64")).digest("hex"))
      continue
    }
    if (/^https?:/i.test(src)) {
      try {
        const response=await safeFetch(src,{signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000)})
        if(!response.ok||!response.body)throw new Error("reference_unreachable")
        const reader=response.body.getReader();const hash=createHash("sha256");const chunks:Uint8Array[]=[];let bytes=0
        try {for(;;){const item=await reader.read();if(item.done)break;bytes+=item.value.byteLength;if(bytes>20*1024*1024)throw new Error("reference_too_large");hash.update(item.value);chunks.push(item.value)}}catch(e){await reader.cancel().catch(()=>undefined);throw e}finally{reader.releaseLock()}
        if(!bytes)throw new Error("reference_empty")
        const mime=(response.headers.get("content-type")??"image/png").split(";")[0]
        if(!mime.startsWith("image/"))throw new Error("reference_not_image")
        const frozen=await uploadImageBytes(`data:${mime};base64,${Buffer.concat(chunks).toString("base64")}`,sessionID,signal)
        if(!frozen.url)throw new Error("reference_snapshot_missing")
        images.push(frozen.url);fingerprints.push(hash.digest("hex"));continue
      }catch {return {ok:false,message:`第 ${i+1} 张参考图无法验证内容hash；未生成，请恢复原canonical参考地址。`}}
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
      const bytes=readFileSync(src.startsWith("/")?src:`${WORKSPACE}/${src}`)
      const fingerprint=createHash("sha256").update(bytes).digest("hex")
      const url = (await uploadImageBytes(`data:image/png;base64,${bytes.toString("base64")}`,sessionID,signal)).url
      if (!url) {
        return {
          ok: false,
          message: `第 ${i + 1} 张参考图（${src}）入库后未拿到公网 URL，请改用公网 URL 或 data:image 重试。`,
        }
      }
      images.push(url)
      fingerprints.push(fingerprint)
    } catch (e: any) {
      const msg = e?.message || String(e)
      // 传目录时 readFileSync 会抛裸 EISDIR（2026-10-04 修）：换成人话，不把 errno 丢给用户。
      if (/EISDIR|illegal operation on a directory/i.test(msg)) {
        return { ok: false, message: `第 ${i + 1} 张参考图路径是目录、不是图片文件：${src}。请传入具体图片文件路径。` }
      }
      return { ok: false, message: `第 ${i + 1} 张参考图处理失败（${src}）：${msg}` }
    }
  }
  return { ok: true, images, fingerprints }
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
    project: tool.schema.string().optional().describe("制作项目稳定ID；跨批次共享冻结模型、尺寸、参考版本与硬预算"),
    frame: tool.schema.number().int().min(1).optional().describe("项目帧号；逐帧制作必须n=1，150帧即150个独立task"),
    request_id: tool.schema.string().optional().describe("稳定提交ID；断线/429重试必须沿用，不产生无关联新job"),
    retry_task_id: tool.schema.string().optional().describe("已有完整task_id：恢复查询与收据，不再次付费生成"),
    cap_coins: tool.schema.number().min(0).optional().describe("该单请求硬预算，传给权威控制面"),
    project_budget_coins: tool.schema.number().min(0).optional().describe("项目累计上限约束；可信用户配置优先，模型参数仅收紧，不冒充付费授权"),
    reference_version: tool.schema.string().optional().describe("已冻结canonical/reference版本"),
    style_version: tool.schema.string().optional().describe("已冻结STYLE LOCK版本"),
    style_lock: tool.schema.string().optional().describe("项目固定风格前缀，工具逐字附加；同项目不允许改变"),
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
    // 模型准入只由控制面执行；工具不把排队/退款/下载失败算成模型故障。
    const size = args.size ?? "1024x1024"
    const n = args.n ?? 1
    const kind = args.kind ?? "image"
    if (args.frame != null && (!args.project || kind !== "image" || n !== 1)) return fail("invalid_frame_contract", "逐帧生成必须提供project，kind=image且n=1；不允许以拼图或多候选冒充多帧。")
    if (args.project && (args.project.length > 200 || !args.project.trim())) return fail("invalid_project", "project必须为非空稳定ID，最多200字。")
    if (args.request_id && args.request_id.length > 200) return fail("invalid_request_id", "request_id最多200字。")
    if (args.style_version && !args.style_lock) return fail("missing_style_lock", "冻结style_version必须同时提供完整style_lock。")
    if (args.reference_version && !args.reference_images?.length) return fail("missing_canonical", "冻结reference_version必须提供canonical参考图。")
    const request_id = args.request_id ?? (args.frame != null ? `frame:${args.project}:${args.frame}` : randomUUID())
    let scope:string
    try {scope=await productionScope(context.sessionID,args.project,context.abort)}
    catch {return fail("session_identity_unavailable","网关暂不能证明当前凭证归属；不使用共享key、不生成，原request_id可恢复。",{request_id,recoverable:true,new_generation:false})}
    if (args.retry_task_id) {
      try {
        const original = await platformFetch(`/${kind === "video" ? "videos" : "images"}/${encodeURIComponent(args.retry_task_id)}`, {method:"GET"}, context.sessionID, context.abort)
        const body = await original.json().catch(() => ({}))
        if (!original.ok) { const err = await classifyError(original, body); return fail(err.code, err.hint, { task_id:args.retry_task_id, request_id, recoverable:true }) }
        const registration = await registerTask(args.retry_task_id, context.sessionID, kind, undefined, { model:body.model ?? model, request_id, project:args.project, frame:args.frame })
        return ok({ task_id:args.retry_task_id, request_id, status:body.status ?? "unknown", resumed:true, new_generation:false, artifacts:body.data ?? [], registration, note:"只恢复原job；未创建新付费请求。终态失败需按原job与明确返工授权交中控恢复。" })
      } catch { return fail("result_unknown", "原job状态暂不可确认；保留原task_id，不能创建无关联替代任务。", {task_id:args.retry_task_id,request_id,recoverable:true}) }
    }
    const input_signature=contentHash({prompt:args.prompt,model,size,n,kind,quality:args.quality ?? "standard",duration_seconds:args.duration_seconds,generate_audio:args.generate_audio,project:args.project,frame:args.frame,reference_images:args.reference_images??[],reference_version:args.reference_version,style_version:args.style_version,style_lock:args.style_lock??""})
    let prior:any
    try {prior=getSubmission(scope,request_id)} catch {return fail("submission_journal_unavailable","当前席位不能写耐久提交/预算收据；未生成，请交具备制作能力的席位。",{request_id,recoverable:true,new_generation:false})}
    const priorIdentity = prior ? JSON.parse(prior.metadata_json) : null
    if(priorIdentity?.input_signature && priorIdentity.input_signature!==input_signature)return fail("idempotency_key_reused","同request_id的输入已改变；保留原job，不静默切模型、参考图或帧。",{task_id:prior?.task_id,request_id,new_generation:false})
    if (prior?.task_id) {
      const reg = await registerTask(prior.task_id, prior.session_id, kind, undefined, JSON.parse(prior.metadata_json))
      return ok({task_id:prior.task_id,request_id,status:"accepted",resumed:true,new_generation:false,registration:reg,note:"原提交已接受；使用image_get_result与image_result_download续接，不重生成。"})
    }

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

    // 单价取自平台目录（权威值），不用本地硬编码表
    const catalog = await loadCatalog(context.sessionID, context.abort)
    const entry = catalog?.[model]
    const unit = args.quality === "hd" ? (entry?.hd ?? entry?.standard) : (entry?.standard ?? entry?.hd)
    if (kind === "image" && (typeof unit !== "number" || !Number.isFinite(unit) || unit < 0)) return fail("price_unknown", "没有本次模型档位的权威报价，未提交；恢复目录后用相同 request_id 重试。")
    // 影片：目录秒价 × 时长（与实扣同源，R9-A2）；目录查不到才粗估并在确认卡标「粗估待确认」。
    const video_price =
      kind === "video"
        ? await videoCostFromCatalog(model, duration_seconds ?? 10, generate_audio, context.sessionID, context.abort)
        : null
    if (kind === "video" && !video_price) return fail("video_price_unknown", "目录没有本次完整提交档位的币值报价；尚未提交生成，不以未知价格开跑。")
    if (kind === "video" && args.quality === "hd" && video_price?.resolution !== "1080p") return fail("unsupported_resolution", "当前视频API不接受显式1080p品质；模型默认档不同，未提交且未降规格。")
    let cost_coins =
      kind === "video"
        ? video_price!.coins
        : Math.round(unit! * n * 1e6) / 1e6

    if(prior && prior.state!=="rejected")cost_coins=prior.reservation

    let budget: {cap?:number;version:string;source:string} | undefined
    if(args.project) {
      try {budget=prior&&prior.state!=="rejected"&&priorIdentity?.budget_version&&lockedProjectBudget(scope)!=null ? {cap:lockedProjectBudget(scope)!,version:priorIdentity.budget_version,source:priorIdentity.budget_source??"agent_constraint"} : await authorizedProjectBudget(context.sessionID,args.project,args.project_budget_coins,context.abort)}
      catch(e:any){return fail(e.code??"project_budget_unknown",e.message,{request_id,new_generation:false,recoverable:true})}
    }

    // 扣费闸门：≤0.1 币的草稿直接放行，其余需用户确认
    if (cost_coins > 0.1 && (!prior || prior.state==="rejected")) {
      const description =
        kind === "video"
          ? video_price
            ? `生成 ${duration_seconds ?? 10} 秒视频（${model}，${video_price.resolution}、${video_price.billing_unit}），预估花费 ${cost_coins} 币`
            : `生成 ${duration_seconds ?? 10} 秒视频（${model}），预估花费 ${cost_coins} 币（目录查无秒价，粗估待确认，实扣可能更高）`
          : `生成 ${n} 张图（${model}），预估花费 ${cost_coins} 币`
      const approved = await confirmSpend(
        { sessionID: context.sessionID, amount_coins: cost_coins, description, model, request_id },
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
      let final_prompt = args.style_lock ? `${args.style_lock}\n${args.prompt}` : args.prompt
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
      if(priorIdentity?.submitted_references && prior.state!=="rejected") reference_images=priorIdentity.submitted_references
      let fingerprints:string[]
      if(priorIdentity?.reference_fingerprints && prior.state!=="rejected") fingerprints=priorIdentity.reference_fingerprints
      else {
        const known=new Map(normalized_refs.images.map((url,index)=>[url,normalized_refs.fingerprints[index]]))
        const extra=reference_images.filter(url=>!known.has(url))
        const finalRefs=await normalizeReferenceImages(extra,context.sessionID,context.abort,maxReferences)
        if(!finalRefs.ok)return fail("reference_hash_unavailable",finalRefs.message,{new_generation:false})
        const frozen=new Map(extra.map((url,index)=>[url,{url:finalRefs.images[index],hash:finalRefs.fingerprints[index]}]))
        fingerprints=reference_images.map(url=>known.get(url)??frozen.get(url)?.hash!)
        reference_images=reference_images.map(url=>frozen.get(url)?.url??url)
        if(fingerprints.some(hash=>!hash))return fail("reference_hash_unavailable","角色卡最终参考图内容未完整验证；未提交。",{new_generation:false})
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

      const identity = { scope, budget_version:budget?.version, budget_source:budget?.source, size, input_signature, submitted_references:reference_images, reference_fingerprints:fingerprints, request_id, session_id:context.sessionID, project:args.project, frame:args.frame, model, cost_coins, reference_version:args.reference_version ?? contentHash(fingerprints), style_version:args.style_version ?? contentHash(args.style_lock ?? "") }
      payload.workflow = { metadata: { budget_version:budget?.version, session_id:context.sessionID,project:args.project,frame:args.frame,request_id,size,reference_version:identity.reference_version,style_version:identity.style_version,style_lock:args.style_lock ?? "" } }
      payload.cap_coins = Math.min(args.cap_coins ?? cost_coins, cost_coins)
      // 单次权威实扣不得高于本地原子保留；目录变价应拒绝而非穿透项目上限。
      // 在任何生成POST前原子预留项目硬预算和提交意图。网络不明时继续保留，不能盲目释放。
      try {
        prepareSubmission(identity, { ...payload, reference_images:args.reference_images ?? [], workflow:payload.workflow }, {model,size,quality:args.quality ?? "standard",reference_version:identity.reference_version,reference_hash:contentHash(fingerprints),style_version:identity.style_version,style_lock:args.style_lock ?? ""}, budget?.cap)
      } catch (e:any) { return fail(String(e.message).split(":")[0], e.message, {request_id,new_generation:false}) }
      const resp = await platformFetch(
        endpoint,
        { method: "POST", headers:{"Idempotency-Key":request_id}, body: JSON.stringify(payload) },
        context.sessionID,
        context.abort,
      )
      const data = await resp.json().catch(() => ({}))
      const task_id = data?.task_id ?? data?.id ?? null

      if (resp.status === 202 || (resp.ok && task_id)) {
        if (typeof task_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(task_id)) return fail("submission_unknown", "上游接受但未给完整task_id；保留request_id与预算，按相同Idempotency-Key恢复。", {request_id,recoverable:true})
        acceptTaskSubmission(scope,request_id,task_id,{task_id,session_id:context.sessionID,kind,model,cost_coins,project:args.project,frame:args.frame,request_id,reference_version:identity.reference_version,style_version:identity.style_version,requested_count:n,size})
        if (task_id) {
          // 收据先SQLite落盘，再登记网关；失败保持可恢复接受态。
          // dedup_hash 让 poller 能认出「同一个请求重送」直接回快取（0 币），
          // cost_coins 让 poller 续接时发得出正确金额（平台轮询回应不含价格）。
          // E2：杂凑用「解析后」的最终 prompt 与最终参考图——否则同一个请求重送会
          // 误命中不同内容的快取。
          const reg = await registerTask(task_id, context.sessionID, kind, context.abort, {
            dedup_hash: dedupHash({ model, prompt: dedupKeyPrompt(final_prompt, reference_images), size, n }),
            model,
            cost_coins,
            project:args.project,frame:args.frame,request_id,
            reference_version:identity.reference_version,style_version:identity.style_version,requested_count:n,size,
          })
          poller_ok = reg.ok
          poller_error = reg.error
          if (!reg.durable) return fail("registration_pending", "上游已接受且本地耐久收据已保存，网关登记暂不可达；稍后按同一task_id/request_id恢复，禁止重复生成。", {task_id,request_id,status:"accepted",recoverable:true,new_generation:false})
        }
        return ok(
          {
            task_id: task_id ?? null,
            request_id,project:args.project,frame:args.frame,reference_version:identity.reference_version,style_version:identity.style_version,
            kind,
            model,
            estimated_cost_coins: cost_coins,
            note:
              "已提交并耐久登记。queued不等于上游失败；完整task_id/request_id必须保留。" +
              (kind === "video"
                ? "视频完成后用video_result_fetch读取，再video_fetch {task_id} 下载全部artifact、验证落盘并提交downloaded ACK；"
                : "图完成后用image_get_result读取，再image_result_download验证落盘与ACK；") +
              "Agent回合结束不撤销作业，不重生成。" +
              (card_note ? `\n${card_note}` : ""),
          },
          { poller_ok, poller_error },
        )
      }

      // 同步产物没有平台job时建立明确来源的内部产物收据；不交poller查虚构平台ID。
      if (resp.ok) {
        const artifacts=Array.isArray(data.data)?data.data.filter((a:any)=>typeof a.url==="string"):data.result_url?[{url:data.result_url}]:data.url?[{url:data.url}]:[]
        if(artifacts.length) {
          const hex=contentHash({scope,request_id});const receiptID=`${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`
          const status=artifacts.length>=n?"succeeded":"failed"
          const extra={model,cost_coins,project:args.project,frame:args.frame,request_id,reference_version:identity.reference_version,style_version:identity.style_version,requested_count:n,size,result_source:"synchronous_receipt",completion:{status,artifacts,cost_coins:data.cost_coins??cost_coins}}
          acceptTaskSubmission(scope,request_id,receiptID,{task_id:receiptID,session_id:context.sessionID,kind,...extra})
          const receipt=await registerTask(receiptID,context.sessionID,kind,context.abort,extra)
          return ok({task_id:receiptID,source:"synchronous_receipt",upstream_task_id:null,request_id,status,partial_result:artifacts.length<n,artifacts,url:artifacts[0].url,kind,model,estimated_cost_coins:cost_coins,registration_durable:receipt.durable,recoverable:!receipt.durable,download_tool:kind==="image"?"image_result_download":"video_fetch",...(kind==="video"?{download_args:{task_id:receiptID}}:{}),...(card_note?{note:card_note}:{})})
        }
      }

      const err = await classifyError(resp, data)
      if (resp.status >= 400 && resp.status < 500) finishSubmission(scope, request_id, "rejected")
      return fail(err.code, err.hint, { request_id, recoverable:true, retry_after_ms: err.retry_after_ms, channel_verified: false, note: CHANNEL_NOT_VERIFIED })
    } catch (e: any) {
      const err = await classifyError(null, e)
      return fail("submission_unknown", "提交状态不确定；已保留request_id与预算，请使用相同Idempotency-Key恢复，不能创建无关联新job。", {request_id,recoverable:true,original_error:err.code,channel_verified:false})
    }
  },
})
