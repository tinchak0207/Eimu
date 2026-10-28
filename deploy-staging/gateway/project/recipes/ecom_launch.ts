// 配方 ecom_launch —— 由旧模板 deploy-staging/gateway/workflow-templates/ecom_launch.ts（只读）改写。
// 映射原则：docs/architecture/project-graph.md §6（电商族：shotlist(items) + keyframe#item → qc → export(image_pack)）。
// 旧 role：7 支 *_gen config + 7 个 image 环 + 1 个 delivery text。7 个 image 环仍是 22 张图，各自一个 keyframe；
// 行内字段（prompt/size/role/n）逐行承载旧 notes 与 deliverable，config 的 model/size/count 并入 params/defaults，gate 并入 qc.thresholds。
// 旧 connections 里 config 只是参数，图生图链是 product_card → scene_pack → model_shot → kv_hero → detail_page → aspect_matrix → final_assets。
// 参考图上限 5（specs MAX_REFERENCE_IMAGES）。PRODUCT LOCK 先占 1 格，其余给直接上游；装不下的留在回报里。
import type { Json, NewNode, ProjectDefaults, Recipe } from "../types"
import { materializeDefaults, MAX_REFERENCE_IMAGES } from "../specs"

const str = (v: Json | undefined, fallback: string): string => (typeof v === "string" && v.trim() !== "" ? v : fallback)

type Row = { id: string; role: string; label: string; size: string; prompt: string; n?: number }
const asRow = (r: Row): { [k: string]: Json } => ({ id: r.id, role: r.role, label: r.label, size: r.size, prompt: r.prompt, n: r.n ?? 1 })

/** locks 先占格（产品锁），direct 是旧图生图边的直接上游。合计不超过关键帧参考图上限。 */
function imageRefs(locks: readonly string[], direct: readonly string[]): Record<string, { from: string }> {
  const out: Record<string, { from: string }> = {}
  for (const id of [...locks, ...direct]) {
    if (Object.prototype.hasOwnProperty.call(out, id)) continue
    if (Object.keys(out).length >= MAX_REFERENCE_IMAGES) break
    out[id] = { from: id }
  }
  return out
}

function frame(id: string, row: Row, defaults: ProjectDefaults, inputs: Record<string, { from: string }>): NewNode {
  return {
    id, type: "keyframe",
    intent: `旧 role ${row.role}：${row.label}。上游定稿图接在 inputs。`,
    params: materializeDefaults("keyframe", id, {
      title: row.label, prompt: row.prompt, role: row.role, size: row.size, n: row.n ?? 1,
    }, defaults),
    ...(Object.keys(inputs).length ? { inputs } : {}),
  }
}

function buildRows(subject: string): Row[] {
  const lock = `产品：${subject}。以白底 PRODUCT LOCK 为唯一身份基准：形状/颜色/材质/包装标签/LOGO 位置零变形，禁止伪造文字与多余产品。`
  return [
    {
      id: "product_card", role: "product_card", label: "白底产品锁", size: "1024x1024",
      prompt: `${lock} 正面 45° 棚拍，柔光箱双侧补光，阴影柔和落地，突出材质与标签纹理；输出透明底抠图（RMBG，半透明材质保留 Alpha）与产品 DNA JSON（shape/color/packaging/label/material）。负向：no fake text, no label distortion, no extra products, no warp。`,
    },
    {
      id: "scene_pack_1", role: "scene_pack", label: "棚拍极简", size: "1024x1024",
      prompt: `${lock} 棚拍极简场景：浅色无缝背景，顶部柔光 5500K，接触阴影落地，产品不悬浮；ControlNet Canny 锁产品轮廓，IP-Adapter 注入抠图外观保材质颜色；本张只改背景变量。`,
    },
    {
      id: "scene_pack_2", role: "scene_pack", label: "生活方式实景", size: "1024x1024",
      prompt: `${lock} 生活方式实景：3800K 暖调侧后 45° 光，产品置于真实使用台面，倒影与接触阴影严格与光源反向；产品本体不改变。`,
    },
    {
      id: "scene_pack_3", role: "scene_pack", label: "材质微距", size: "1024x1024",
      prompt: `${lock} 材质微距特写：柔光 0.6 + 逆光 1.2 勾轮廓，纹理与倒影落地，产品不悬浮；无伪造文字。`,
    },
    {
      id: "model_shot_1", role: "model_shot", label: "模特全身场景", size: "1024x1024",
      prompt: `${lock} 模特全身场景演绎：OpenPose 锁骨架姿势，产品为视觉焦点且零形变；模特人群设定（人种/年龄/气质）一次定死；手部五指关节自然无畸变，grip 接触细节显式描述。`,
    },
    {
      id: "model_shot_2", role: "model_shot", label: "模特特写佩戴", size: "1024x1024",
      prompt: `${lock} 模特特写佩戴/使用：Inpainting 只重绘穿戴与持握区域；手指关节计数正确、持握接触面积自然；产品在模特身上零形变，脸与人群设定一致。`,
    },
    {
      id: "kv_hero_1", role: "kv_hero", label: "KV 主视觉", size: "1536x1024",
      prompt: `${lock} KV 主视觉：低机位仰拍 + 逆光轮廓光，前景产品、背景简洁分层；3 秒原则——第一眼看到产品 + 一个记忆点；产品锐度不因逆光损失。`,
    },
    {
      id: "kv_hero_2", role: "kv_hero", label: "CTA 负空间版", size: "1536x1024",
      prompt: `${lock} KV 的负空间 CTA 版：画面留出 1/3 干净区域（左或右）给标题/卖点/按钮，禁止产品居中占满，CTA 负空间占比 ≥30%；构图按最终投放宽高比先定，不事后裁切。`,
    },
    {
      id: "detail_page_1", role: "detail_page", label: "详情 1 痛点开场", size: "1024x1536",
      prompt: `${lock} 详情页第 1 屏（痛点开场）：首屏 3 秒内完成「痛点→产品解法」信息闭环；图文比例 7:3，字号手机端 ≥24pt 等效，文字可读无乱码。`,
    },
    {
      id: "detail_page_2", role: "detail_page", label: "详情 2 产品亮相", size: "1024x1536",
      prompt: `${lock} 详情页第 2 屏（产品亮相）：白底基准图 + 场景图对照，产品身份与 PRODUCT LOCK 一致；一屏一个信息点。`,
    },
    {
      id: "detail_page_3", role: "detail_page", label: "详情 3 细节特写", size: "1024x1536",
      prompt: `${lock} 详情页第 3 屏（细节特写）：材质/标签/LOGO 微距，放大后小字仍可读；素材复用白底基准与微距场景，保持一致。`,
    },
    {
      id: "detail_page_4", role: "detail_page", label: "详情 4 场景演绎", size: "1024x1536",
      prompt: `${lock} 详情页第 4 屏（场景演绎）：生活方式场景图，产品处于真实使用情境；与首屏同一光源方向与色温。`,
    },
    {
      id: "detail_page_5", role: "detail_page", label: "详情 5 参数对比", size: "1024x1536",
      prompt: `${lock} 详情页第 5 屏（参数对比）：只列可验证参数（尺寸/材质/认证），禁止与竞品做无依据功效对比，防虚假 claim 进详情页。`,
    },
    {
      id: "detail_page_6", role: "detail_page", label: "详情 6 信任背书", size: "1024x1536",
      prompt: `${lock} 详情页第 6 屏（信任背书收尾）：资质/认证/服务承诺排布，文字可读无错别字；与全链素材同一色板。`,
    },
    {
      id: "aspect_1x1", role: "aspect_matrix", label: "主图 1:1", size: "2048x2048",
      prompt: `${lock} 主图 1:1（2048×2048）重排：产品位置/留白/视线引导按 1:1 重新设计，禁止中心裁切；主体完整不贴边。`,
    },
    {
      id: "aspect_3x1", role: "aspect_matrix", label: "详情横幅 3:1", size: "3072x1024",
      prompt: `${lock} 详情横幅 3:1（3072×1024）重排：按 3:1 重新构图，产品与文案区分区，非裁切。`,
    },
    {
      id: "aspect_9x16", role: "aspect_matrix", label: "社媒 9:16", size: "1080x1920",
      prompt: `${lock} 社媒 9:16（1080×1920）：构图重心上移，产品置上 1/3、文案区留下方 40%，避让信息流 UI 安全区（顶部 12%/底部 20%）。`,
    },
    {
      id: "aspect_16x9", role: "aspect_matrix", label: "Banner 16:9", size: "2560x1440",
      prompt: `${lock} Banner 16:9（2560×1440）重排：按 16:9 重新构图，产品与负空间分区，非裁切；宽高比先定再生成。`,
    },
    {
      id: "final_main", role: "final_assets", label: "精修主图 4096", size: "4096x4096",
      prompt: `${lock} 交付级精修主图：以定稿构图重出 4096×4096（供印刷），纹理锐化不过冲，放大后标签小字仍可读，色彩统一 sRGB。`,
    },
    {
      id: "final_banner", role: "final_assets", label: "精修详情横幅", size: "6144x2048",
      prompt: `${lock} 交付级精修详情横幅：以定稿构图重出 6144×2048（短边 ≥2048），边缘锐度与噪点不劣化，sRGB。`,
    },
    {
      id: "final_social", role: "final_assets", label: "精修社媒 9:16", size: "2048x3641",
      prompt: `${lock} 交付级精修社媒纵版：以定稿构图重出 2048×3641（短边 ≥2048），主体不贴边，sRGB。`,
    },
    {
      id: "final_wide", role: "final_assets", label: "精修 Banner 16:9", size: "3641x2048",
      prompt: `${lock} 交付级精修横幅：以定稿构图重出 3641×2048（短边 ≥2048），负空间留白完整，sRGB。`,
    },
  ]
}

const DEFAULTS: ProjectDefaults = {
  imageModel: "gpt-image-2.5-flare",
  imageSize: "1024x1024",
  style: "电商上市包：PRODUCT LOCK 全链一致（产品零形变、标签文字清晰），倒影与接触阴影落地，统一 sRGB 与色板",
}

export const ecomLaunchRecipe: Recipe = {
  id: "ecom_launch",
  title: "新品上市包",
  build(p) {
    const defaults: ProjectDefaults = {
      ...DEFAULTS,
      ...(typeof p.model === "string" && p.model ? { imageModel: p.model } : {}),
      ...(typeof p.style === "string" && p.style ? { style: p.style } : {}),
    }
    const rows = buildRows(str(p.product, "锁定商品"))
    const ids = (role: string) => rows.filter((r) => r.role === role).map((r) => r.id)
    const product = ids("product_card")
    const scene = ids("scene_pack")
    const model = ids("model_shot")
    const kv = ids("kv_hero")
    const detail = ids("detail_page")
    const aspect = ids("aspect_matrix")
    const refsOf = (role: string): Record<string, { from: string }> => {
      if (role === "product_card") return { catalog: { from: "items" } }
      if (role === "scene_pack") return imageRefs(product, [])
      if (role === "model_shot") return imageRefs(product, scene)
      if (role === "kv_hero") return imageRefs(product, model)
      if (role === "detail_page") return imageRefs(product, kv)
      if (role === "aspect_matrix") return imageRefs(product, detail)
      return imageRefs(product, aspect)
    }
    const pictures = Object.fromEntries(rows.map((r) => [r.id, { from: r.id }]))
    const nodes: NewNode[] = [
      {
        id: "items", type: "shotlist",
        intent: "旧 7 个 image 环的行表：产品卡 / 场景包 ×3 / 模特 ×2 / KV ×2 / 详情 ×6 / 多画幅 ×4 / 精修 ×4，共 22 行（白底产品 DNA 为全链根基）。",
        params: { kind: "items", rows: rows.map(asRow) },
      },
      ...rows.map((r) => frame(r.id, r, defaults, refsOf(r.role))),
      {
        id: "qc", type: "qc",
        intent: "旧各环 VLM/抽检/分辨率门禁：产品 DNA 零变形、标签与 LOGO 可读、手部无畸变、CTA 负空间≥30%、文字≥24pt、短边≥2048、sRGB；任一不符重出。",
        params: {
          mode: "critic",
          rubric: "ecom_launch",
          thresholds: {
            productDnaConsistency: true, labelTextReadable: true, logoUnwarped: true, handJoints: true,
            ctaNegativeSpacePct: 30, detailTextMinPt: 24, minShortEdgePx: 2048, colorSpace: "sRGB",
            scenePaletteVariancePct: 5, namePattern: "渠道_用途_SKU_画幅_序号", upscaleAudit: ["noise", "edge", "colorCast"],
            spelling: true, noUnauthorizedLogo: true, noFalseClaim: true, commercialRights: true,
          },
        },
        inputs: pictures,
        onFail: { action: "regenerate", max: 2 },
      },
      {
        id: "export", type: "export",
        intent: "旧 role delivery：全包按渠道归档（主图/场景/模特/KV+CTA/详情/社媒矩阵），12 项终审全绿才算交付；命名 渠道_用途_SKU_画幅_序号，使用索引按 CSV 交付。",
        params: { preset: "image_pack" },
        inputs: { ...pictures, verdict: { from: "qc" } },
      },
    ]
    return { nodes, targets: { shots: rows.length, subtitles: false, audio: "none" }, defaults }
  },
  legacyRoleMap: {
    product_gen: { intentOf: "product_card" },
    product_card: "product_card",
    scene_gen: { intentOf: "scene_pack_1" },
    scene_pack: "scene_pack_1",
    model_gen: { intentOf: "model_shot_1" },
    model_shot: "model_shot_1",
    kv_gen: { intentOf: "kv_hero_1" },
    kv_hero: "kv_hero_1",
    detail_gen: { intentOf: "detail_page_1" },
    detail_page: "detail_page_1",
    aspect_gen: { intentOf: "aspect_1x1" },
    aspect_matrix: "aspect_1x1",
    upscale_gen: { intentOf: "final_main" },
    final_assets: "final_main",
    delivery: { intentOf: "export" },
  },
}
