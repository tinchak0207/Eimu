import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail, productionScope } from "../lib/client"
import { GradioSession, GradioSpaceError } from "../lib/gradio-space"
import { fetchInputImage, glbReport, storeAsset } from "../lib/asset3d"
import {
  isLinkiiConfigured,
  linkiiJson,
  linkiiUpload,
  pollLinkiiTaskAndWork,
  readLinkiiAccounts,
  resolveLinkiiMediaUrl,
  withLinkiiAccountPool,
} from "../lib/linkii-client"
import { createHash } from "node:crypto"
import { gameCheckpoint, gameProject } from "../lib/game-project"

// model3d_generate — 单件 3D 模型生成（造世界：主角道具、陈设、可交互物件）。
//
// 上游 1：hunyuan3d / linkii ＝ Linkii 混元3D 3.1（deploymentId=667, modelCode=hunyuan3d-vod）：
//   支持文生 3D / 图生 3D / 多视图生 3D，直接产出带 PBR 贴图的 GLB，下载后转存平台。
// 上游 2：trellis2 ＝ 微软官方 TRELLIS.2 Space（Hugging Face ZeroGPU）：
//   start_session → preprocess_image（去背）→ image_to_3d（形状＋贴图，约 60s GPU）→ extract_glb（减面＋烘贴图）。
//   Space 有状态（gr.State），四步必须同一个 session_hash。

const TRELLIS_SPACE = process.env.EIMU_TRELLIS2_SPACE || "https://microsoft-trellis-2.hf.space"
const LINKII_URI = process.env.LINKII_BASE_URL || "https://linkii.tech"
const HUNYUAN_DEPLOYMENT_ID = 667
const MAX_GLB_BYTES = 150 * 1024 * 1024

// 描述随开通状态如实变化：仅当两个上游都未配置时才提示未开通。
const LINKII_CONFIGURED = isLinkiiConfigured()
const TRELLIS_CONFIGURED = !!(process.env.HF_TOKEN || process.env.HUGGINGFACE_TOKEN)
const CONFIGURED = LINKII_CONFIGURED || TRELLIS_CONFIGURED
const STATUS = CONFIGURED
  ? ""
  : "【当前未开通：平台未配置 Linkii 混元3D 凭证或 HF_TOKEN，调用只会返回 upstream_not_configured。对用户如实说单件 3D 模型生成暂时做不了，不要承诺能先做出来。】"

const DESCRIPTION = LINKII_CONFIGURED
  ? "单件 3D 模型生成（默认混元3D 3.1）：支持文生 3D（prompt）、图生 3D（image_url）与多视图生 3D（image_url 作正视图 + multi_view_images 后/左/右视图）→ 带 PBR 贴图的 GLB 网格，并转存平台、出资产报告（三角面数、贴图数、包围盒、sha256）。" +
    "适合主角道具、陈设、可拿起的交互物件；整片环境用 world_generate。图生 3D 建议单一主体、背景干净，多物件请先分别生图。" +
    "单次约 1–4 分钟。回执里的 glb_url 写进交付文（成品会归到 models 类）。"
  : "图生 3D：一张物件／角色概念图 → 带 PBR 贴图的 GLB 网格（TRELLIS.2），并转存平台、出资产报告（三角面数、贴图数、包围盒、sha256）。" +
    "适合主角道具、陈设、可拿起的交互物件；整片环境用 world_generate。输入图要单一主体、背景干净（会自动去背），多物件请先分别生图。" +
    "单次约 2–4 分钟。回执里的 glb_url 写进交付文（成品会归到 models 类）。"

async function uploadLinkiiImage(
  rawUrl: string,
  namePrefix: string,
  signal?: AbortSignal,
): Promise<{ uploadedUrl: string; sha256: string }> {
  const input = await fetchInputImage(rawUrl, signal)
  const sha256 = createHash("sha256").update(input.bytes).digest("hex")
  const up: any = await linkiiUpload(
    "/web/ai/modeling/upload-image",
    input.bytes,
    `${namePrefix}.${input.ext}`,
    input.mime,
    signal,
  )
  const rawUploaded = String(up?.data?.url || up?.url || up?.data?.objectName || up?.objectName || "").trim()
  if (!rawUploaded) {
    throw new Error(`Linkii 图片上传未返回 url/objectName：${JSON.stringify(up).slice(0, 200)}`)
  }
  const uploadedUrl = resolveLinkiiMediaUrl(rawUploaded)
  if (!uploadedUrl) {
    throw new Error("Linkii 图片上传地址解析为空")
  }
  return { uploadedUrl, sha256 }
}

function extractLinkiiGlbUrl(work: any): string {
  if (typeof work?.resultContent === "string" && work.resultContent.trim()) {
    return resolveLinkiiMediaUrl(work.resultContent.trim())
  }
  let files: any = work?.resultFiles
  if (typeof files === "string") {
    const trimmed = files.trim()
    if (trimmed) {
      try {
        files = JSON.parse(trimmed)
      } catch {
        if (/\.glb(\?|#|$)/i.test(trimmed)) return resolveLinkiiMediaUrl(trimmed)
        files = null
      }
    }
  }
  if (Array.isArray(files)) {
    for (const item of files) {
      if (item && String(item.type ?? "").toLowerCase() === "glb") {
        const raw = String(item.url || item.objectName || "").trim()
        if (raw) return resolveLinkiiMediaUrl(raw)
      }
    }
    for (const item of files) {
      const raw = typeof item === "string" ? item.trim() : String(item?.url || item?.objectName || "").trim()
      if (raw && /\.glb(\?|#|$)/i.test(raw)) return resolveLinkiiMediaUrl(raw)
    }
  }
  return ""
}

async function downloadGlbBytes(url: string, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
  const timed = AbortSignal.timeout(180_000)
  const combined = signal ? AbortSignal.any([signal, timed]) : timed
  const res = await fetch(url, { signal: combined })
  if (!res.ok) throw new Error(`GLB 产物下载失败 HTTP ${res.status}`)
  const declared = Number(res.headers.get("content-length") || 0)
  if (declared > maxBytes) throw new Error(`产物 ${declared} 字节，超过 ${maxBytes}`)
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer())
    if (buf.byteLength > maxBytes) throw new Error(`产物 ${buf.byteLength} 字节，超过 ${maxBytes}`)
    if (!buf.byteLength) throw new Error("GLB 产物为空")
    return buf
  }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) throw new Error(`产物超过 ${maxBytes} 字节上限`)
      chunks.push(value)
    }
  } catch (err) {
    await reader.cancel().catch(() => undefined)
    throw err
  } finally {
    reader.releaseLock()
  }
  if (!total) throw new Error("GLB 产物为空")
  return new Uint8Array(Buffer.concat(chunks))
}

export default tool({
  description: STATUS + DESCRIPTION,
  args: {
    image_url: tool.schema
      .string()
      .optional()
      .describe("概念图／正视图公网 URL（png/jpg/webp，≤20MB），单一主体。图生 3D 与多视图生 3D（作正视图）必填；纯文生 3D 可省略。"),
    prompt: tool.schema.string().optional().describe("文生 3D 描述词（中文或英文，含主体、风格与材质）。纯文生 3D 必填。"),
    multi_view_images: tool.schema
      .object({
        back: tool.schema.string().optional().describe("后视图公网 URL。"),
        left: tool.schema.string().optional().describe("左视图公网 URL。"),
        right: tool.schema.string().optional().describe("右视图公网 URL。"),
      })
      .optional()
      .describe("多视图生 3D 的后/左/右视图公网 URL，须配合 image_url 作为正视图且至少提供一个额外视角。"),
    generate_type: tool.schema
      .enum(["紋理風格不限", "Normal", "LowPoly", "Geometry", "Sketch"])
      .optional()
      .describe("混元3D 生成风格类型，预设「紋理風格不限」。"),
    enable_pbr: tool.schema.boolean().optional().describe("混元3D 是否开启 PBR 材质贴图，预设 true。"),
    upstream: tool.schema
      .enum(["hunyuan3d", "trellis2", "linkii"])
      .optional()
      .describe("上游：hunyuan3d（或 linkii，混元3D 3.1）或 trellis2；配置 Linkii 时预设 hunyuan3d，否则 trellis2。"),
    resolution: tool.schema.enum(["512", "1024", "1536"]).optional().describe("TRELLIS.2 生成分辨率，预设 1024；512 更快更省配额。"),
    target_tris: tool.schema.number().int().min(100000).max(500000).optional().describe("TRELLIS.2 导出减面目标（三角面），100000–500000，预设 100000；更低的面数在 Blender/UE 里再减。"),
    texture_size: tool.schema.enum(["1024", "2048", "4096"]).optional().describe("TRELLIS.2 贴图边长，预设 2048。"),
    seed: tool.schema.number().int().min(0).max(2147483647).optional(),
    project: tool.schema.string().optional().describe("项目名（写进回执，供 game_asset_manifest 归档）。"),
    label: tool.schema.string().optional().describe("给人看的资产名，如「1966 年搪瓷脸盆」。"),
    cap_coins: tool.schema.number().min(0).optional().describe("本次可花的币上限；当前上游不扣平台币，填不填都不扣。"),
  },
  async execute(args, context) {
    const linkiiReady = isLinkiiConfigured()
    const upstream: "hunyuan3d" | "trellis2" =
      args.upstream === "hunyuan3d" || args.upstream === "linkii"
        ? "hunyuan3d"
        : args.upstream === "trellis2"
          ? "trellis2"
          : linkiiReady
            ? "hunyuan3d"
            : "trellis2"

    if (upstream === "hunyuan3d" && !linkiiReady) {
      return fail(
        "upstream_not_configured",
        "混元3D 3.1（Linkii）未配置账号凭证（LINKII_USERNAME/LINKII_PASSWORD 或 LINKII_AUTH_TOKEN）。" +
          (TRELLIS_CONFIGURED ? "可改用 upstream=trellis2。" : "请先配置 Linkii 凭证或 HF_TOKEN。"),
      )
    }

    const token = process.env.HF_TOKEN || process.env.HUGGINGFACE_TOKEN || ""
    if (upstream === "trellis2" && !token) {
      return fail(
        "upstream_not_configured",
        "TRELLIS.2 跑在 Hugging Face ZeroGPU 上，匿名配额撑不到导出 GLB（实测两次都在最后一步被拒）；平台需要配置 HF_TOKEN 才能出模型。如实告诉使用者这一步还没开通，不要改用 Blender 白模冒充。",
      )
    }

    const frontInputUrl = args.image_url?.trim() || ""
    const promptText = args.prompt?.trim() || ""
    const extraViews: Array<{ viewType: "back" | "left" | "right"; url: string }> = []
    if (args.multi_view_images) {
      for (const viewType of ["back", "left", "right"] as const) {
        const raw = args.multi_view_images[viewType]?.trim()
        if (raw) extraViews.push({ viewType, url: raw })
      }
    }

    if (upstream === "trellis2") {
      if (!frontInputUrl) {
        return fail("invalid_args", "TRELLIS.2 仅支持图生 3D，请提供 image_url（概念图公网 URL）。")
      }
    } else {
      if (extraViews.length > 0 && !frontInputUrl) {
        return fail("invalid_args", "多视图生 3D 须提供 image_url 作为正视图，并至少提供 multi_view_images 中的一个视角（back/left/right）。")
      }
      if (!frontInputUrl && !promptText) {
        return fail("invalid_args", "混元3D 3.1 请至少提供 prompt（文生 3D）或 image_url（图生 3D / 多视图生 3D 正视图）。")
      }
    }

    const started = Date.now()
    const stages: Array<{ stage: string; seconds: number }> = []
    const mark = (stage: string) => stages.push({ stage, seconds: Math.round((Date.now() - started) / 100) / 10 })

    try {
      const scope = args.project ? await productionScope(context.sessionID, args.project, context.abort) : null
      if (scope && args.project) gameProject(scope, args.project, context.sessionID)

      let glb!: Uint8Array
      let sourceMeta!: Record<string, unknown>
      let receiptExtra!: Record<string, unknown>

      if (upstream === "hunyuan3d") {
        // 号池：同一账号同时只能跑 1 个建模任务（C9999），上传＋创建＋轮询整段在一个账号作用域内，忙则换号。
        await withLinkiiAccountPool(async (linkiiAccount) => {
        let capability: "文生3D" | "圖生3D" | "多視圖生3D"
        let frontUrl: string | undefined
        let promptToSend = ""
        let imageUrls: string[] = []
        let multiViewImages: Array<{ viewType: "front" | "back" | "left" | "right"; url: string }> | undefined
        const inputHashes: string[] = []

        if (extraViews.length > 0) {
          const front = await uploadLinkiiImage(frontInputUrl, "input", context.abort)
          frontUrl = front.uploadedUrl
          inputHashes.push(front.sha256)
          const extras = await Promise.all(
            extraViews.map(async (v) => {
              const up = await uploadLinkiiImage(v.url, `input-${v.viewType}`, context.abort)
              inputHashes.push(up.sha256)
              return { viewType: v.viewType, url: up.uploadedUrl }
            }),
          )
          capability = "多視圖生3D"
          promptToSend = ""
          imageUrls = []
          multiViewImages = [{ viewType: "front", url: frontUrl }, ...extras]
          mark("upload_images")
        } else if (frontInputUrl) {
          const front = await uploadLinkiiImage(frontInputUrl, "input", context.abort)
          frontUrl = front.uploadedUrl
          inputHashes.push(front.sha256)
          capability = "圖生3D"
          promptToSend = ""
          imageUrls = [frontUrl]
          mark("upload_image")
        } else {
          capability = "文生3D"
          promptToSend = promptText
          imageUrls = []
        }

        const generateType = args.generate_type ?? "紋理風格不限"
        const enablePbr = args.enable_pbr ?? true
        const createRes: any = await linkiiJson(
          "/web/ai/modeling/create",
          {
            method: "POST",
            timeoutMs: 60_000,
            body: JSON.stringify({
              deploymentId: HUNYUAN_DEPLOYMENT_ID,
              prompt: promptToSend,
              params: JSON.stringify({
                generateType,
                enablePBR: enablePbr,
                imageUrl: frontUrl || undefined,
                capability,
                multiViewImages,
                imageUrls,
              }),
              imageUrl: frontUrl || undefined,
            }),
          },
          context.abort,
        )

        const createData = createRes?.data && typeof createRes.data === "object" ? createRes.data : createRes
        const taskId = createData?.id ?? createData?.taskId
        const creationId = createData?.creationId ?? createData?.workId
        if (taskId == null || taskId === "" || creationId == null || creationId === "") {
          throw new Error(`混元3D 提交任务失败（${createRes?.code ?? "unknown"}）：${createRes?.message || JSON.stringify(createRes).slice(0, 200)}`)
        }
        mark("create")

        const { work } = await pollLinkiiTaskAndWork(taskId, creationId, {
          timeoutMs: 720_000,
          pollMs: 5_000,
          signal: context.abort,
        })
        mark("generate")

        const glbUrl = extractLinkiiGlbUrl(work)
        if (!glbUrl || !/^https?:\/\//i.test(glbUrl)) {
          throw new Error(`混元3D 任务完成但未返回有效 GLB 地址：${JSON.stringify(work).slice(0, 300)}`)
        }
        glb = await downloadGlbBytes(glbUrl, MAX_GLB_BYTES, context.abort)
        mark("download_glb")

        sourceMeta = {
          kind: "generated",
          upstream: "hunyuan3d",
          model: "hunyuan3d-vod",
          deployment_id: HUNYUAN_DEPLOYMENT_ID,
          capability,
          uri: LINKII_URI,
          task_id: taskId,
          creation_id: creationId,
          ...(readLinkiiAccounts().length > 1 ? { linkii_account: linkiiAccount } : {}),
          ...(inputHashes.length === 1 ? { input_image_sha256: inputHashes[0] } : {}),
          ...(inputHashes.length > 1 ? { input_image_sha256s: inputHashes } : {}),
          ...(promptToSend ? { prompt: promptToSend } : {}),
        }
        receiptExtra = {
          upstream: "hunyuan3d",
          model: "hunyuan3d-vod",
          capability,
          generate_type: generateType,
          enable_pbr: enablePbr,
          task_id: taskId,
          creation_id: creationId,
          ...(readLinkiiAccounts().length > 1 ? { linkii_account: linkiiAccount } : {}),
        }
        })
      } else {
        const input = await fetchInputImage(frontInputUrl, context.abort)
        const space = new GradioSession(TRELLIS_SPACE, token)
        await space.call("start_session", [], { signal: context.abort, timeoutMs: 60_000 })
        const ref = await space.upload(input.bytes, `input.${input.ext}`, input.mime, context.abort)
        const pre = await space.call("preprocess_image", [ref], { signal: context.abort, timeoutMs: 180_000 })
        mark("preprocess")
        const seed = args.seed ?? Math.floor(Math.random() * 2147483647)
        await space.call(
          "image_to_3d",
          [pre[0], seed, args.resolution ?? "1024", 7.5, 0.7, 12, 5.0, 7.5, 0.5, 12, 3.0, 1.0, 0.0, 12, 3.0],
          { signal: context.abort, timeoutMs: 900_000 },
        )
        mark("image_to_3d")
        const out = await space.call("extract_glb", [null, args.target_tris ?? 100000, Number(args.texture_size ?? "2048")], {
          signal: context.abort,
          timeoutMs: 900_000,
        })
        mark("extract_glb")
        glb = await space.download(out[1] ?? out[0], MAX_GLB_BYTES, context.abort)

        sourceMeta = {
          kind: "generated",
          upstream: "trellis2",
          uri: TRELLIS_SPACE,
          input_image_sha256: createHash("sha256").update(input.bytes).digest("hex"),
          seed,
        }
        receiptExtra = {
          upstream: "trellis2",
          upstream_space: TRELLIS_SPACE,
          seed,
        }
      }

      const report = glbReport(glb)
      const slug = (args.label || "model").replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "model"
      const stored = await storeAsset(glb, `${slug}.glb`, context.sessionID)
      mark("stored")
      const label = args.label?.trim() || "3D 模型"
      const costBasis =
        upstream === "hunyuan3d"
          ? "Linkii 混元3D 3.1（hunyuan3d-vod）当前平台记账为 0 币；未计入生成参考图的独立费用。"
          : "TRELLIS.2 Hugging Face ZeroGPU 上游不收费；未计入生成参考图的独立费用。"
      const receipt = {
        title: `3D 模型：${label}`,
        glb_url: stored.url,
        markdown_link: `[${label}（GLB，${report.triangles} 面）](${stored.url})`,
        asset_report: report,
        asset_manifest_entry: {
          id: `sha256:${stored.sha256}`,
          label,
          url: stored.url,
          sha256: stored.sha256,
          bytes: stored.bytes,
          triangles: report.triangles,
          source: sourceMeta,
          cost_coins: 0,
          cost_basis: costBasis,
          ue_asset_paths: [],
          verification_status: "unknown",
          missing: ["local_path", "ue_import_and_load_receipt", "world_plan_actor_reconciliation"],
        },
        ...receiptExtra,
        project: args.project ?? null,
        cost_coins: 0,
        stages,
        note: "GLB 已转存平台存储（长期有效）。交付时写 markdown_link；要进 UE 时把 glb_url 交给 ue_editor 的导入工具。",
      }
      let checkpoint: Record<string, unknown> | null = null
      if (scope && args.project) {
        try {
          const snapshot = gameProject(scope, args.project, context.sessionID)
          const operationID = `model3d:${stored.sha256}`
          const prior = snapshot.checkpoints.find((entry: any) => entry.operation_id === operationID)
          const saved = prior
            ? snapshot
            : gameCheckpoint(scope, args.project, context.sessionID, operationID, "assets", "completed", {
                asset_manifest_entry: receipt.asset_manifest_entry,
                glb_url: stored.url,
              })
          checkpoint = { status: "persisted", workspace: saved.workspace, operation_id: operationID }
        } catch (error: any) {
          // The stored GLB is already valid. Preserve its delivery even if optional project bookkeeping fails.
          checkpoint = { status: "unknown", error: String(error?.message ?? error) }
        }
      }
      return ok({ ...receipt, checkpoint })
    } catch (e: any) {
      const msg = String(e?.message ?? e)
      // Linkii 同一账号同时只允许 1 个建模任务（C9999「還有一個AI建模任務正在生成中」）；一单约 7 分钟，别让 agent 连点重试。
      if (/C9999|建模任務正在生成|建模任务正在生成/.test(msg)) {
        return fail("upstream_busy", "混元3D 同一时间只能跑一个建模任务，上一个还在生成（单件约 7 分钟）。如实告诉使用者在排队，几分钟后再发起一次；不要连续重试，也不要改用 Blender 冒充。", { stages, upstream })
      }
      const code = e instanceof GradioSpaceError ? e.code : typeof e?.code === "string" && e.code ? e.code : "model3d_failed"
      return fail(code, msg.slice(0, 600), { stages, upstream })
    }
  },
})
