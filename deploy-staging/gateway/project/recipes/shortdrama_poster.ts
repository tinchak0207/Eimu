// 配方 shortdrama_poster —— 由旧模板 deploy-staging/gateway/workflow-templates/shortdrama_poster.ts（只读）改写。
// 映射原则：docs/architecture/project-graph.md §6（电商族：shotlist(items) + keyframe#item → qc → export(image_pack)）。
// 旧 role：5 支 *_gen config + 5 个 image 步 + iteration/delivery 两个 text。image 步仍是 22 张图，各自一个 keyframe；
// 两个 text（回流报告 / 交付参数卡）分别并入 qc.intent 与 export.intent（不成节点）。
// 旧封面链：key_art → main_poster → cp_pair → slice_cover → variant_pack。参考图上限 5，key art 先占 1 格。
import type { Json, NewNode, ProjectDefaults, Recipe } from "../types"
import { materializeDefaults, MAX_REFERENCE_IMAGES } from "../specs"

const str = (v: Json | undefined, fallback: string): string => (typeof v === "string" && v.trim() !== "" ? v : fallback)

type Row = { id: string; role: string; label: string; size: string; prompt: string; n?: number }
const asRow = (r: Row): { [k: string]: Json } => ({ id: r.id, role: r.role, label: r.label, size: r.size, prompt: r.prompt, n: r.n ?? 1 })

/** locks 先占格（key art），direct 是旧封面链的直接上游。合计不超过关键帧参考图上限。 */
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

function buildRows(drama: string, actor: string): Row[] {
  const anchor = `短剧：${drama}。以 key art 与色彩情绪规范 JSON（主色 HEX×2 / 辅色×2 / 光效方向与强度 / 情绪词）为全链 sref 风格锚；主演：${actor}，以主演锁定卡 cref 保五官一致。全链竖版 9:16。`
  const slicePoints = ["打脸", "反转", "告白", "悬念", "冲突", "误会", "救场", "结局"]
  const slices = slicePoints.map((point, i): Row => ({
    id: `slice_cover_${i + 1}`, role: "slice_cover", label: `切片封面 ${point}`, size: "1024x1536",
    prompt: `${anchor} 信息流切片封面第 ${i + 1} 张：本张对应剧情点「${point}」（清单格式 集数_剧情点_情绪档1-5），取该集最强情绪帧；剧名安全区模板——顶部 15% 与底部 20% 留白，脸与手不进安全区；固定 seed + 同一 sref 权重，只换主体动作与场景词；情绪标签写入文件名。`,
  }))
  return [
    {
      id: "key_art", role: "key_art", label: "剧设 key art", size: "1024x1536",
      prompt: `${anchor} 剧设 key art 主视觉（竖版 9:16）：一张图锁全剧气质，无人无手纯净定调；主色 HEX×2（背景基调+人物高光）、辅色×2、光效字段≥2（方向角+强度档 1-5）、情绪词≥2，规范 JSON 与 key art 同步冻结；以同题材对标爆款做笔触/色板/构图 DNA 解构后再起稿。`,
    },
    {
      id: "main_poster_1", role: "main_poster", label: "主演海报 气场版", size: "1024x1536", n: 3,
      prompt: `${anchor} 主演海报 · 气场版（9:16）：低角度仰拍 + 明暗对照布光，人物占画面 2/3，气场压过背景；主演 cref 高权重，五官/发型/服装跨张一致；固定 seed 族只换情绪词不换风格词；出 3 候选择优。`,
    },
    {
      id: "main_poster_2", role: "main_poster", label: "主演海报 情绪版", size: "1024x1536", n: 3,
      prompt: `${anchor} 主演海报 · 情绪版（9:16）：面部特写 + 眼神光，情绪对应剧本最大爽点/虐点；背景色只从规范 JSON 取色，禁止自创配色；出 3 候选择优；双版并排比对瞳距/脸型轮廓/发际线，任一漂移该张重出。`,
    },
    {
      id: "cp_pair_1", role: "cp_pair", label: "CP 对视", size: "1024x1536",
      prompt: `${anchor} CP 对戏 · 对视版（9:16）：对称站位、视线相交；双 cref 主 0.9 / 配 0.6；张力靠肢体语言与负空间，不靠夸张表情；背景光效沿 key art 明暗对照方向。`,
    },
    {
      id: "cp_pair_2", role: "cp_pair", label: "CP 逼近", size: "1024x1536",
      prompt: `${anchor} CP 对戏 · 逼近版（9:16）：不对称构图，一方侵入另一方空间；双主演脸不互串；张力递进可辨，构图级问题回生成层重出，不在编辑层叠补丁。`,
    },
    {
      id: "cp_pair_3", role: "cp_pair", label: "CP 拉扯", size: "1024x1536",
      prompt: `${anchor} CP 对戏 · 拉扯版（9:16）：肢体接触 + 动态失衡 + 衣发飘动；三张共用同一固定 seed，张力只由站位/肢体/负空间控制，风格因子隔离供 A/B 归因。`,
    },
    ...slices,
    {
      id: "variant_hook_top", role: "variant_pack", label: "变体 钩子位=上", size: "1024x1536",
      prompt: `${anchor} A/B 变体 · 钩子文案位=上（标题党）：单变量原则，只改文案位，底图与字效逐字节一致；文字不遮演员面部关键区；命名规则 底图ID_文案位_字效ID。`,
    },
    {
      id: "variant_hook_mid", role: "variant_pack", label: "变体 钩子位=中", size: "1024x1536",
      prompt: `${anchor} A/B 变体 · 钩子文案位=中（情绪共鸣）：单变量只改文案位；字效只落安全区内，不遮脸。`,
    },
    {
      id: "variant_hook_bottom", role: "variant_pack", label: "变体 钩子位=下", size: "1024x1536",
      prompt: `${anchor} A/B 变体 · 钩子文案位=下（悬念留白）：单变量只改文案位；文字与字效不覆盖演员面部关键区。`,
    },
    {
      id: "variant_type_calligraphy", role: "variant_pack", label: "变体 书法字效", size: "1024x1536",
      prompt: `${anchor} A/B 变体 · 字效=书法体：同组共享底图与 sref，只有字效维度进变量表；字效不遮脸；命名可追溯到变体 ID。`,
    },
    {
      id: "variant_type_stroke", role: "variant_pack", label: "变体 描边字效", size: "1024x1536",
      prompt: `${anchor} A/B 变体 · 字效=描边：单变量只改字效；文字与字效不覆盖面部关键区。`,
    },
    {
      id: "variant_type_shadow", role: "variant_pack", label: "变体 立体阴影字效", size: "1024x1536",
      prompt: `${anchor} A/B 变体 · 字效=立体阴影：单变量只改字效；字效只落安全区内，不遮脸。`,
    },
    {
      id: "variant_bigtext_full", role: "variant_pack", label: "变体 大字报满版", size: "1024x1536",
      prompt: `${anchor} A/B 变体 · 大字报冲击版（满版）：单变量只改版式；变体包总量 6-9 张为上限，超预算先砍底图数不砍维度。`,
    },
    {
      id: "variant_bigtext_margin", role: "variant_pack", label: "变体 大字报留白", size: "1024x1536",
      prompt: `${anchor} A/B 变体 · 大字报冲击版（留白）：单变量只改版式；文字不遮脸，命名规则完整可追溯。`,
    },
  ]
}

const DEFAULTS: ProjectDefaults = {
  imageModel: "gpt-image-2.5-flare",
  imageSize: "1024x1536",
  style: "短剧投放：全链竖版 9:16，key art 作 sref 风格锚，主演 cref 锁脸，色板只从规范 JSON 取，安全区与字效遮脸为硬门禁",
}

export const shortdramaPosterRecipe: Recipe = {
  id: "shortdrama_poster",
  title: "投放海报线",
  build(p) {
    const defaults: ProjectDefaults = {
      ...DEFAULTS,
      ...(typeof p.model === "string" && p.model ? { imageModel: p.model } : {}),
      ...(typeof p.style === "string" && p.style ? { style: p.style } : {}),
    }
    const rows = buildRows(str(p.drama, "待定剧名"), str(p.actor, "待定主演"))
    const ids = (role: string) => rows.filter((r) => r.role === role).map((r) => r.id)
    const art = ids("key_art")
    const poster = ids("main_poster")
    const cp = ids("cp_pair")
    const slice = ids("slice_cover")
    const refsOf = (role: string): Record<string, { from: string }> => {
      if (role === "key_art") return { catalog: { from: "items" } }
      if (role === "main_poster") return imageRefs(art, [])
      if (role === "cp_pair") return imageRefs(art, poster)
      if (role === "slice_cover") return imageRefs(art, [...cp, ...poster])
      return imageRefs(art, slice)
    }
    const pictures = Object.fromEntries(rows.map((r) => [r.id, { from: r.id }]))
    const nodes: NewNode[] = [
      {
        id: "items", type: "shotlist",
        intent: "旧 5 个 image 步的行表：key art / 主演海报 ×2 / CP 对戏 ×3 / 切片封面 ×8 / A/B 变体 ×8，共 22 行。",
        params: { kind: "items", rows: rows.map(asRow) },
      },
      ...rows.map((r) => frame(r.id, r, defaults, refsOf(r.role))),
      {
        id: "qc", type: "qc",
        intent: "旧 role iteration：按单变量命名拆 CTR 贡献，赢家特征回写参数（winner_*），离群变体（低于组均值 50%）淘汰；风格根不动，只改参数层。",
        params: {
          mode: "critic",
          rubric: "shortdrama_poster",
          thresholds: {
            styleAnchor: "key_art_sref", paletteFromSpecJson: true, actorIdentityAnchors: ["瞳距", "脸型轮廓", "发际线"],
            safeAreaPct: { top: 15, bottom: 20 }, textOverFace: "forbidden", seedSample: 3, colorDeltaE: 5, outlierCutPct: 50,
          },
        },
        inputs: pictures,
        onFail: { action: "regenerate", max: 2 },
      },
      {
        id: "export", type: "export",
        intent: "旧 role delivery：全量物料按平台规格归档（9:16 主图 + 变体包 + 情绪标签对位表）+ styleLock 参数卡（sref/cref/seed/色板 JSON）；安全区与字效遮脸 100% 通过后出口。",
        params: { preset: "image_pack" },
        inputs: { ...pictures, verdict: { from: "qc" } },
      },
    ]
    return { nodes, targets: { shots: rows.length, subtitles: false, audio: "none" }, defaults }
  },
  legacyRoleMap: {
    tone_gen: { intentOf: "key_art" },
    key_art: "key_art",
    poster_gen: { intentOf: "main_poster_1" },
    main_poster: "main_poster_1",
    cp_gen: { intentOf: "cp_pair_1" },
    cp_pair: "cp_pair_1",
    cover_gen: { intentOf: "slice_cover_1" },
    slice_cover: "slice_cover_1",
    variant_gen: { intentOf: "variant_hook_top" },
    variant_pack: "variant_hook_top",
    iteration: { intentOf: "qc" },
    delivery: { intentOf: "export" },
  },
}
