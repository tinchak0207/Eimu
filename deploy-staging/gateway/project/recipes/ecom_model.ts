// 配方 ecom_model —— 由旧模板 deploy-staging/gateway/workflow-templates/ecom_model.ts（只读）改写。
// 映射原则：docs/architecture/project-graph.md §6（电商族：shotlist(items) + keyframe#item → qc → export(image_pack)）。
// 旧 role：7 支 *_gen config + 7 个 image 环。image 环仍是 22 张图，各自一个 keyframe；行内承载旧 notes/deliverable，
// 候选数量用行字段 n 表达（模特卡 3 候选、每个试穿姿势 2 候选），gate 并入 qc.thresholds。
// 旧图生图链：garment_asset → model_card → tryon → retouch → grid → detail_page → distribution。
// 参考图上限 5。服装锁与三张人设卡先占格，剩下的给直接上游。
import type { Json, NewNode, ProjectDefaults, Recipe } from "../types"
import { materializeDefaults, MAX_REFERENCE_IMAGES } from "../specs"

const str = (v: Json | undefined, fallback: string): string => (typeof v === "string" && v.trim() !== "" ? v : fallback)

type Row = { id: string; role: string; label: string; size: string; prompt: string; n?: number }
const asRow = (r: Row): { [k: string]: Json } => ({ id: r.id, role: r.role, label: r.label, size: r.size, prompt: r.prompt, n: r.n ?? 1 })

/** locks 先占格（服装锁 + 人设卡），direct 是旧图生图边的直接上游。合计不超过关键帧参考图上限。 */
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

function buildRows(garment: string): Row[] {
  const lock = `服装：${garment}。以服装 DNA 卡为唯一基准：材质/版型/颜色（3 处主色 HEX）/标签四维逐项复用，禁止同义改写。`
  return [
    {
      id: "garment_asset", role: "garment_asset", label: "透明底服装单品", size: "1024x1024",
      prompt: `${lock} 透明底服装平铺（去背景）：BiRefNet/RMBG 细带分割，细带/流苏/蕾丝优先 BiRefNet；边缘 alpha≥0.3 才计实体、无残留光晕；量衣长/胸围/袖长比例写进 DNA；101% 回贴干净白底自检，边缘误差 ≤1%；同时输出透明底 PNG 与纯色底 JPEG。`,
    },
    {
      id: "model_card_1", role: "model_card", label: "人设卡 正面特写", size: "1024x1024", n: 3,
      prompt: `模特人设卡 · 正面特写：客群反推（人种/年龄/气质/体型）四维固定短语，全系列复用；IP-Adapter FaceID 权重 0.6-0.8 + 固定 seed 双锁；negativePrompt 排除多人物/五官漂移/脸部畸变；候选 3 个供选定后锁定（中途换模特=全链返工）。`,
    },
    {
      id: "model_card_2", role: "model_card", label: "人设卡 全身", size: "1024x1024",
      prompt: `模特人设卡 · 全身基准：同一 FaceID 基线与同一固定 seed，全身比例与体态一致；作为试穿与九宫格的 face_identity 参考图组之一，与基准脸比对不过即重生。`,
    },
    {
      id: "model_card_3", role: "model_card", label: "人设卡 侧面", size: "1024x1024",
      prompt: `模特人设卡 · 侧面基准：同一 FaceID 基线与同一固定 seed，侧脸轮廓与发型一致；三张基准图共同锁定身份，任一图漂移即该张重生。`,
    },
    {
      id: "tryon_1", role: "tryon", label: "试穿 正面", size: "1024x1024", n: 2,
      prompt: `${lock} 试穿图 · 正面：CatVTON/IDM-VTON 主通道 + OpenPose 姿势库（不自造畸形骨架），CFG 6-8；只重绘穿戴 mask 内像素，背景与手部原样保留；手部 grip 接触细节显式写；后缀 only one person；服装色与 DNA HEX 比对 ΔE≤5；每姿势留 2 候选。`,
    },
    {
      id: "tryon_2", role: "tryon", label: "试穿 侧面", size: "1024x1024", n: 2,
      prompt: `${lock} 试穿图 · 侧面：同一服装 DNA 与模特卡，侧面姿势骨架取自姿势库；贴合与比例不过整组重生不做局部修补；接触点不悬空不穿模。`,
    },
    {
      id: "tryon_3", role: "tryon", label: "试穿 背面", size: "1024x1024", n: 2,
      prompt: `${lock} 试穿图 · 背面：同一服装 DNA 与模特卡，背面姿势展示背部版型与标签位；色差 ΔE>5 判定跑色重生。`,
    },
    {
      id: "retouch", role: "retouch", label: "精修试穿图", size: "1024x1024",
      prompt: `${lock} 精修试穿图：MeshGraphormer + scribble 手套修手部（六指/关节反折零容忍）；ControlNet 两段 0.4（铺姿势）→0.9（锁版型）；双 LoRA 分挂（面料垂坠/款式轮廓，权重 0.5-0.7）；面料物理逐图打勾（垂坠顺重力/褶皱密度符合材质/纱质透内层肤色）；只在 mask 内动刀，脸与背景不动。`,
    },
    {
      id: "grid", role: "grid", label: "3x3 九宫格", size: "2048x2048",
      prompt: `${lock} 3x3 九宫格种草图（≥2048px）：远/中/近各 3 格混排（3 远景环境 / 3 中景穿搭 / 3 近景面料细节）；同一 FaceID 基线与 seed 族，任一格与基准脸比对不过单格重生；统一影调 5500K 顺光 45°，主色 HEX 偏差 >10% 判影调跳格重生；单格 ≥683px 先出高清再拼版；九格机位/姿势/场景至少两项不同。`,
    },
    {
      id: "detail_page_1", role: "detail_page", label: "详情 1 钩子", size: "1024x1536",
      prompt: `${lock} 详情页第 1 屏（钩子）：前 10% 高度内出钩，用九宫格最优远景/中景格 + 一句痛点文案；图与文案一一对应，卖点必须有图内证据。`,
    },
    {
      id: "detail_page_2", role: "detail_page", label: "详情 2 卖点", size: "1024x1536",
      prompt: `${lock} 详情页第 2 屏（卖点 1）：claim 与图内细节一一对应，卖点文案 ≤20 字，图文比例 7:3，一屏只装一个信息点。`,
    },
    {
      id: "detail_page_3", role: "detail_page", label: "详情 3 卖点", size: "1024x1536",
      prompt: `${lock} 详情页第 3 屏（卖点 2）：同第 2 屏规则；缺失图内证据的卖点要么补拍细节屏要么删文案，禁止图文两张皮。`,
    },
    {
      id: "detail_page_4", role: "detail_page", label: "详情 4 细节", size: "1024x1536",
      prompt: `${lock} 详情页第 4 屏（细节 1）：近景格放大 2x 取局部，纹理/面料/标签清晰；清晰度不足的细节屏判不合格。`,
    },
    {
      id: "detail_page_5", role: "detail_page", label: "详情 5 细节", size: "1024x1536",
      prompt: `${lock} 详情页第 5 屏（细节 2）：同细节屏规则，覆盖另一处卖点证据；竖排基准宽 750px，单屏高 800-1200px。`,
    },
    {
      id: "detail_page_6", role: "detail_page", label: "详情 6 场景", size: "1024x1536",
      prompt: `${lock} 详情页第 6 屏（场景）：全身试穿图 + 使用场景收尾；整页 ≤10 屏防加载过长；与前面各屏同一色板与光向。`,
    },
    {
      id: "dist_xhs_34", role: "distribution", label: "小红书 3:4", size: "1080x1440",
      prompt: `${lock} 小红书 3:4（1080×1440）：同一精修图源重排不重生，文案居下 1/4；底部 UI 遮挡区预留 15%，主体不贴边；字号 ≥24px（1080 宽基准）。`,
    },
    {
      id: "dist_douyin_916", role: "distribution", label: "抖音 9:16", size: "1080x1920",
      prompt: `${lock} 抖音 9:16（1080×1920）：重排不重生，文案避开顶部/底部各 250px 安全区；关键卖点字与商品主体不落遮挡区。`,
    },
    {
      id: "taobao_1", role: "distribution", label: "淘宝主图 正面", size: "800x800",
      prompt: `${lock} 淘宝主图 1:1（800×800）· 正面：纯商品无文案，主体完整不贴边；同一精修图源重排，禁止裁切。`,
    },
    {
      id: "taobao_2", role: "distribution", label: "淘宝主图 45°", size: "800x800",
      prompt: `${lock} 淘宝主图 1:1 · 45°：纯商品无文案，重排构图展示侧面与版型；主体完整不贴边。`,
    },
    {
      id: "taobao_3", role: "distribution", label: "淘宝主图 细节", size: "800x800",
      prompt: `${lock} 淘宝主图 1:1 · 细节：面料/标签特写，纯商品无文案；纹理清晰，禁止低分辨率硬缩。`,
    },
    {
      id: "taobao_4", role: "distribution", label: "淘宝主图 使用场景", size: "800x800",
      prompt: `${lock} 淘宝主图 1:1 · 使用场景：真实穿着情境，产品为视觉焦点；纯商品无文案。`,
    },
    {
      id: "taobao_5", role: "distribution", label: "淘宝主图 包装", size: "800x800",
      prompt: `${lock} 淘宝主图 1:1 · 包装：包装与吊牌细节，与服装 DNA 标签一致；纯商品无文案。`,
    },
  ]
}

const DEFAULTS: ProjectDefaults = {
  imageModel: "gpt-image-2.5-flare",
  imageSize: "1024x1024",
  style: "模特种草线：服装 DNA 与 FaceID 基线全链一致，同一光照方向与色温，统一 sRGB，禁止换脸/换衣同义改写",
}

export const ecomModelRecipe: Recipe = {
  id: "ecom_model",
  title: "模特种草线",
  build(p) {
    const defaults: ProjectDefaults = {
      ...DEFAULTS,
      ...(typeof p.model === "string" && p.model ? { imageModel: p.model } : {}),
      ...(typeof p.style === "string" && p.style ? { style: p.style } : {}),
    }
    const rows = buildRows(str(p.garment, "锁定服装"))
    const ids = (role: string) => rows.filter((r) => r.role === role).map((r) => r.id)
    const garment = ids("garment_asset")
    const model = ids("model_card")
    const tryon = ids("tryon")
    const detail = ids("detail_page")
    const locks = [...garment, ...model]
    const refsOf = (role: string): Record<string, { from: string }> => {
      if (role === "garment_asset") return { catalog: { from: "items" } }
      if (role === "model_card") return imageRefs(garment, [])
      if (role === "tryon") return imageRefs(garment, model)
      if (role === "retouch") return imageRefs(locks, tryon)
      if (role === "grid") return imageRefs(locks, ["retouch"])
      if (role === "detail_page") return imageRefs(locks, ["grid"])
      return imageRefs(locks, detail)
    }
    const pictures = Object.fromEntries(rows.map((r) => [r.id, { from: r.id }]))
    const nodes: NewNode[] = [
      {
        id: "items", type: "shotlist",
        intent: "旧 7 个 image 环的行表：服装资产 / 人设卡 ×3 / 试穿 ×3 / 精修 / 九宫格 / 详情 ×6 / 分发 ×7，共 22 行（服装 DNA + FaceID 为全链基准）。",
        params: { kind: "items", rows: rows.map(asRow) },
      },
      ...rows.map((r) => frame(r.id, r, defaults, refsOf(r.role))),
      {
        id: "qc", type: "qc",
        intent: "旧各环门禁：抠图边缘无光晕、FaceID 三锚点一致、手部无畸变、服色 ΔE≤5、九宫格主色偏差≤10%、文字≥24px、平台安全区、短边≥2048。",
        params: {
          mode: "critic",
          rubric: "ecom_model",
          thresholds: {
            garmentAlphaMin: 0.3, garmentHexDeltaE: 5, faceIdentityAnchors: ["瞳距", "脸型轮廓", "发际线"], handJoints: true,
            gridColorHexDeltaPct: 10, minTextPx: 24, safeAreaPct: { top: 12, bottom: 20 }, minShortEdgePx: 2048,
            garmentInputShortEdgePx: 1024, evidenceMapRegions: true,
          },
        },
        inputs: pictures,
        onFail: { action: "regenerate", max: 2 },
      },
      {
        id: "export", type: "export",
        intent: "旧 role distribution 的交付：小红书 3:4 / 抖音 9:16 / 淘宝主图 1:1 五张按平台规格打包，重排不重生；安全区与分辨率套检 100% 通过后出口。",
        params: { preset: "image_pack" },
        inputs: { ...pictures, verdict: { from: "qc" } },
      },
    ]
    return { nodes, targets: { shots: rows.length, subtitles: false, audio: "none" }, defaults }
  },
  legacyRoleMap: {
    garment_gen: { intentOf: "garment_asset" },
    garment_asset: "garment_asset",
    model_gen: { intentOf: "model_card_1" },
    model_card: "model_card_1",
    tryon_gen: { intentOf: "tryon_1" },
    tryon: "tryon_1",
    retouch_gen: { intentOf: "retouch" },
    retouch: "retouch",
    grid_gen: { intentOf: "grid" },
    grid: "grid",
    detail_gen: { intentOf: "detail_page_1" },
    detail_page: "detail_page_1",
    reflow_gen: { intentOf: "dist_xhs_34" },
    distribution: "dist_xhs_34",
  },
}
