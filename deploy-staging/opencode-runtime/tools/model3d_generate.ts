import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import { GradioSession, GradioSpaceError } from "../lib/gradio-space"
import { fetchInputImage, glbReport, storeAsset } from "../lib/asset3d"

// model3d_generate — 图生 3D 网格（造世界：主角道具、陈设、可交互物件）。
//
// 上游 trellis2 ＝ 微软官方 TRELLIS.2 Space（Hugging Face ZeroGPU）：
//   start_session → preprocess_image（去背）→ image_to_3d（形状＋贴图，约 60s GPU）→ extract_glb（减面＋烘贴图）。
//   Space 有状态（gr.State），四步必须同一个 session_hash。
// 实测（2026-11-10）：匿名调用的 ZeroGPU 配额撑不到 extract_glb（要预留 120s）——两次都在最后一步被拒，
// 所以没配 HF_TOKEN 时直接报缺什么，不白烧一次 GPU。
// 上游本身不收费（cost_coins=0 是真值，不是未知）；hunyuan3d（腾讯云混元生3D）需要腾讯云密钥，未配置。

const TRELLIS_SPACE = process.env.EIMU_TRELLIS2_SPACE || "https://microsoft-trellis-2.hf.space"
const MAX_GLB_BYTES = 150 * 1024 * 1024

export default tool({
  description:
    "图生 3D：一张物件／角色概念图 → 带 PBR 贴图的 GLB 网格（TRELLIS.2），并转存平台、出资产报告（三角面数、贴图数、包围盒、sha256）。" +
    "适合主角道具、陈设、可拿起的交互物件；整片环境用 world_generate。输入图要单一主体、背景干净（会自动去背），多物件请先分别生图。" +
    "单次约 2–4 分钟。回执里的 glb_url 写进交付文（成品会归到 models 类）。",
  args: {
    image_url: tool.schema.string().describe("概念图公网 URL（png/jpg/webp，≤20MB），单一主体。"),
    upstream: tool.schema.enum(["trellis2", "hunyuan3d"]).optional().describe("上游，预设 trellis2。"),
    resolution: tool.schema.enum(["512", "1024", "1536"]).optional().describe("生成分辨率，预设 1024；512 更快更省配额。"),
    target_tris: tool.schema.number().int().min(100000).max(500000).optional().describe("导出减面目标（三角面），100000–500000，预设 100000；更低的面数在 Blender/UE 里再减。"),
    texture_size: tool.schema.enum(["1024", "2048", "4096"]).optional().describe("贴图边长，预设 2048。"),
    seed: tool.schema.number().int().min(0).max(2147483647).optional(),
    project: tool.schema.string().optional().describe("项目名（写进回执，供 game_asset_manifest 归档）。"),
    label: tool.schema.string().optional().describe("给人看的资产名，如「1966 年搪瓷脸盆」。"),
    cap_coins: tool.schema.number().min(0).optional().describe("本次可花的币上限；trellis2 上游不收费，填不填都不扣。"),
  },
  async execute(args, context) {
    const upstream = args.upstream ?? "trellis2"
    if (upstream === "hunyuan3d") {
      return fail("upstream_not_configured", "混元生3D 需要腾讯云 SecretId/SecretKey，平台尚未配置；改用 upstream=trellis2。")
    }
    const token = process.env.HF_TOKEN || process.env.HUGGINGFACE_TOKEN || ""
    if (!token) {
      return fail(
        "upstream_not_configured",
        "TRELLIS.2 跑在 Hugging Face ZeroGPU 上，匿名配额撑不到导出 GLB（实测两次都在最后一步被拒）；平台需要配置 HF_TOKEN 才能出模型。如实告诉使用者这一步还没开通，不要改用 Blender 白模冒充。",
      )
    }
    const started = Date.now()
    const stages: Array<{ stage: string; seconds: number }> = []
    const mark = (stage: string) => stages.push({ stage, seconds: Math.round((Date.now() - started) / 100) / 10 })
    try {
      const input = await fetchInputImage(args.image_url, context.abort)
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
      const glb = await space.download(out[1] ?? out[0], MAX_GLB_BYTES, context.abort)
      const report = glbReport(glb)
      const slug = (args.label || "model").replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "model"
      const stored = await storeAsset(glb, `${slug}.glb`, context.sessionID)
      mark("stored")
      const label = args.label?.trim() || "3D 模型"
      return ok({
        title: `3D 模型：${label}`,
        glb_url: stored.url,
        markdown_link: `[${label}（GLB，${report.triangles} 面）](${stored.url})`,
        asset_report: report,
        upstream: "trellis2",
        upstream_space: TRELLIS_SPACE,
        seed,
        project: args.project ?? null,
        cost_coins: 0,
        stages,
        note: "GLB 已转存平台存储（长期有效）。交付时写 markdown_link；要进 UE 时把 glb_url 交给 ue_editor 的导入工具。",
      })
    } catch (e: any) {
      const code = e instanceof GradioSpaceError ? e.code : "model3d_failed"
      return fail(code, String(e?.message ?? e).slice(0, 600), { stages, upstream: "trellis2" })
    }
  },
})
