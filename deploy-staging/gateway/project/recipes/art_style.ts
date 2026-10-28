// 配方 art_style —— 由旧模板 deploy-staging/gateway/workflow-templates/art_style.ts（只读）改写。
// 映射原则：docs/architecture/project-graph.md §6（IP/策展族：script/素材 + shotlist + keyframe#item → qc(critic) → export(image_pack)）。
// 旧 15 role：ref_pool(image) → reference（代表作原图由用户上传/素材库提供，缺图停在本步不生成）；
// 6 个 config 不成节点；lora_log(text) → qc 的 intent + thresholds.lora（upstream 未接＝unsupported_skip）；
// 其余 image role → keyframe（对拍 / 矩阵 / 成组用 shotlist + forEach）；evidence_archive(image) → export(image_pack)。
import type { Json, NewNode, ProjectDefaults, Recipe } from "../types"
import { materializeDefaults } from "../specs"

const str = (v: Json | undefined, fallback: string): string => (typeof v === "string" && v.trim() !== "" ? v : fallback)
const rowsOf = (rows: Record<string, string>[]): Json => rows.map((r) => ({ ...r }))
const ARTIFACT_ID_RE = /^art_[0-9a-f]{16}$/

// 旧 ref_pool 的元数据表（15-20 张原作，分期采样；保留 2-4 张盲测图）
const REFERENCES = rowsOf([
  { id: "r1", period: "早期", year: "2012", theme: "风景", asset: "asset_007", source: "url", resolution: "3200x2400", role: "dna" },
  { id: "r2", period: "中期", year: "2016", theme: "静物", asset: "asset_012", source: "url", resolution: "2800x2100", role: "dna" },
  { id: "r3", period: "晚期", year: "2020", theme: "人物", asset: "asset_021", source: "url", resolution: "3600x2700", role: "blind" },
])

// 旧 copy_compare 的逐维对拍（5 逐维 + 2 综合）
const COPY_DIMS = rowsOf([
  { id: "brush", label: "笔触", dimension: "笔触厚度/方向/干湿", prompt: "逐维对拍·笔触：写厚度、笔触方向、颜料堆叠、干湿边缘；其余维度沿用 prompt 骨架原文。" },
  { id: "material", label: "材质", dimension: "纸纹/颜料堆叠", prompt: "逐维对拍·材质：写 visible paint ridges、干底层覆盖、冷压纸纹显现；其余维度沿用骨架原文。" },
  { id: "light", label: "光观察", dimension: "光源方位/明暗交界", prompt: "逐维对拍·光观察：光源方位用钟点角度写死（如 10 点钟、约 45° 侧逆光）+ 明暗交界处理。" },
  { id: "composition", label: "构图", dimension: "视点/裁切/负形", prompt: "逐维对拍·构图：写视点高度、裁切比例、负形走向与视觉焦点路径。" },
  { id: "theme", label: "题材", dimension: "题材偏好", prompt: "逐维对拍·题材：只记录画什么（题材词），不混入观察方式。" },
  { id: "synth_a", label: "综合临摹 A", dimension: "综合", prompt: "综合临摹 A：五维同时还原，prompt 骨架与五维短语逐字复用，只允许整体组合不同。" },
  { id: "synth_b", label: "综合临摹 B", dimension: "综合", prompt: "综合临摹 B：换一个主体但保持五维描述不变，验证还原不是靠题材撞车。" },
])

// 旧 variant_matrix 的 3x3 泛化矩阵（3 个新题材 × 3 个新构图）
const MATRIX = rowsOf([
  { id: "m11", label: "工业静物 · 远景", theme: "工业静物", comp: "远景", prompt: "泛化格 1：新题材=工业静物（与惯用题材零重叠），构图=远景，只改题材与构图，观察层 DNA 原文不动。" },
  { id: "m12", label: "工业静物 · 中景", theme: "工业静物", comp: "中景", prompt: "泛化格 2：题材=工业静物，构图=中景，保留四维以上 DNA。" },
  { id: "m13", label: "工业静物 · 近景", theme: "工业静物", comp: "近景", prompt: "泛化格 3：题材=工业静物，构图=近景，保留四维以上 DNA。" },
  { id: "m21", label: "城市夜景 · 远景", theme: "城市夜景", comp: "远景", prompt: "泛化格 4：题材=城市夜景，构图=远景，验证怎么看仍成立。" },
  { id: "m22", label: "城市夜景 · 中景", theme: "城市夜景", comp: "中景", prompt: "泛化格 5：题材=城市夜景，构图=中景，验证怎么看仍成立。" },
  { id: "m23", label: "城市夜景 · 近景", theme: "城市夜景", comp: "近景", prompt: "泛化格 6：题材=城市夜景，构图=近景，验证怎么看仍成立。" },
  { id: "m31", label: "深海 · 远景", theme: "深海", comp: "远景", prompt: "泛化格 7：题材=深海，构图=远景，只改题材与构图。" },
  { id: "m32", label: "深海 · 中景", theme: "深海", comp: "中景", prompt: "泛化格 8：题材=深海，构图=中景，只改题材与构图。" },
  { id: "m33", label: "深海 · 近景", theme: "深海", comp: "近景", prompt: "泛化格 9：题材=深海，构图=近景，只改题材与构图。" },
])

// 旧 origin_set 的原创成组（6-8 张，人工逐张自查）
const ORIGIN = rowsOf([
  { id: "o1", label: "原创 1", prompt: "原创成组 1：题材 / 构图 / 叙事原创，不复刻单一代表作；五维自查逐条核对。" },
  { id: "o2", label: "原创 2", prompt: "原创成组 2：景别 / 视点 / 负形与组内任一其他张不完全相同。" },
  { id: "o3", label: "原创 3", prompt: "原创成组 3：色盘主色偏移 ≤2 档，共享观察层 DNA。" },
  { id: "o4", label: "原创 4", prompt: "原创成组 4：掉维即重生成或记录人工修复，不把 outlier 混入系列。" },
  { id: "o5", label: "原创 5", prompt: "原创成组 5：笔触逻辑与光处理沿用 DNA，题材保持原创。" },
  { id: "o6", label: "原创 6", prompt: "原创成组 6：材质短语逐字复用，构图查重通过。" },
])

const DEFAULTS: ProjectDefaults = {
  imageModel: "gpt-image-2.5-flare",
  imageSize: "1024x1024",
  style: "风格深研统一：笔触 / 色盘 / 光观察 / 构图 / 材质五维短语逐字复用，题材层留作变量；拒绝「大气/唯美/电影感」等不可验证套话",
}

export const artStyleRecipe: Recipe = {
  id: "art_style",
  title: "风格深研线",
  build(p) {
    const defaults: ProjectDefaults = {
      ...DEFAULTS,
      ...(typeof p.model === "string" && p.model ? { imageModel: p.model } : {}),
      ...(typeof p.size === "string" && p.size ? { imageSize: p.size } : {}),
      ...(typeof p.style === "string" && p.style ? { style: p.style } : {}),
    }
    const artist = str(p.artist, "（待补：艺术家与创作期）")
    const aid = str(p.referenceArtifactId, "art_0000000000000000")
    const artifactId = ARTIFACT_ID_RE.test(aid) ? aid : "art_0000000000000000"
    const nodes: NewNode[] = [
      {
        id: "brief", type: "script",
        intent: "风格深研 brief：艺术家 / 创作期、只记录「画什么」与「怎么看」的分离口径、五模块 prompt 骨架（笔触/色盘/光观察/构图/材质，题材层留变量）。",
        params: {
          text: "风格深研 brief：\n- 艺术家 / 创作期：" + artist + "\n- 口径：题材层只记录画什么（题材词），观察层记录怎么看（边缘处理 / 环境色 / 阴影补色 / 焦点路径）\n- 拒绝「大气 / 唯美 / 电影感」等不可验证套话；每条特征要有数值、方向、比例、频率或原作局部证据\n- 五模块 prompt 骨架：笔触 / 色盘 / 光观察 / 构图 / 材质，逐字复用，题材层留空位变量\n- 盲测集：保留 2-4 张原作不参与解构，只用于最终比对",
        },
      },
      {
        id: "references", type: "shotlist",
        intent: "旧 role ref_pool 的元数据表：15-20 张高清原作，分期采样、题材≥2 类、保留 2-4 张盲测图；长边 <1024px 标「仅参考不进 DNA」。",
        params: { kind: "items", rows: REFERENCES },
      },
      {
        id: "ref_material", type: "reference",
        intent: "旧 role ref_pool 的原图素材：由用户上传/素材库提供（artifactId 待接线）；缺高清图停在本步，不调用生图、不造假成功。",
        params: { title: "代表作原图", source: "upload", artifactId },
      },
      {
        id: "dna_board", type: "keyframe",
        intent: "旧 role dna_board：五维 DNA 解构图 + 证据局部；每维 ≥3 条可验证特征，每条挂证据 asset_id；色盘 5-8 HEX、光源方位用钟点角度写死。",
        params: materializeDefaults("keyframe", "dna_board", {
          title: "五维 DNA 解构图",
          prompt: "五维 DNA 解构图（含证据局部）：笔触 / 色盘 / 光观察 / 构图习惯 / 题材偏好。\n原作：${ref_material}\n研究 brief：${brief}\n艺术家：" + artist + "\n每维 ≥3 条可验证特征，每条挂证据 asset_id + 局部定位；色盘 5-8 HEX 按占比降序；光源方位用钟点角度；拒绝不可验证套话。",
          role: "dna_board",
          size: "1536x1024",
        }, defaults),
      },
      {
        id: "dna_card", type: "keyframe",
        intent: "旧 role dna_card：用户逐条签核的 style DNA 卡 + 两张原作局部对位图，各圈 3 处高权重特征锚点；签核定版号 style_dna_approved_v1。",
        params: materializeDefaults("keyframe", "dna_card", {
          title: "style DNA 卡",
          prompt: "style DNA 卡（用户逐条签核版）：四维描述（笔触 / 色盘 / 光 / 构图）+ 两张原作局部对位图，各圈 3 处高权重特征锚点（笔触走向线、明暗交界带、色盘取样点）。\n解构：${dna_board}\n原作：${ref_material}\n签核定版号 style_dna_approved_v1，修正写 revision_log。",
          role: "dna_card",
          size: "1024x1536",
        }, defaults),
      },
      {
        id: "copy_dims", type: "shotlist",
        intent: "旧 role copy_compare 的行表：5 个逐维对拍 + 2 张综合临摹；固定 seed，一轮只换一个维度描述词；逐维还原度=复现成功特征数/该维特征总数。",
        params: { kind: "items", rows: COPY_DIMS },
      },
      {
        id: "copy_compare", type: "keyframe", forEach: { over: "copy_dims", as: "probe" },
        intent: "旧 role copy_compare：临摹对照板逐张生成；五维还原度 ≥70%、高权重项 ≥85%；低于阈值回退 style_dna_approved_v1 修订，不得硬闯。",
        params: materializeDefaults("keyframe", "copy_compare", {
          title: "${row.label}",
          prompt: "${row.prompt}\nDNA 卡：${dna_card}\n本轮只替换 ${row.dimension} 一个维度，其余 prompt 骨架逐字不动；固定 seed；逐维还原度 = 复现成功特征数 / 该维特征总数。",
          role: "copy_compare",
          size: "1024x1024",
        }, defaults),
      },
      {
        id: "matrix", type: "shotlist",
        intent: "旧 role variant_matrix 的行表：3 个新题材 × 3 个新构图 = 9 格；至少 1 个题材与艺术家惯用题材零重叠，构图覆盖远 / 中 / 近景别。",
        params: { kind: "items", rows: MATRIX },
      },
      {
        id: "variant_matrix", type: "keyframe", forEach: { over: "matrix", as: "cell" },
        intent: "旧 role variant_matrix：3x3 泛化矩阵；9 格 ≥7 格保留四个以上 DNA 维度；丢失 ≥2 维标 outlier 并记录题材词是否带回了「画什么」层。",
        params: materializeDefaults("keyframe", "variant_matrix", {
          title: "${row.label}",
          prompt: "${row.prompt}\nDNA 卡：${dna_card}\n9 格共用观察层 DNA，变量只改题材与构图；同一 seed 便于对照；逐格填 格号/题材词/构图词/seed/保留维度数/丢失维度/outlier/原因。",
          role: "variant_matrix",
          size: "1024x1024",
        }, defaults),
      },
      {
        id: "origin", type: "shotlist",
        intent: "旧 role origin_set 的行表：6-8 张原创成组；组内风格统一、构图不重复、题材不复刻单一代表作，每张登记 seed / prompt / 来源节点。",
        params: { kind: "items", rows: ORIGIN },
      },
      {
        id: "origin_set", type: "keyframe", forEach: { over: "origin", as: "work" },
        intent: "旧 role origin_set：原创成组逐张生成并过五维自查；掉维重生成不超过 2 次，否则记人工修复待办，不把 outlier 混入最终系列。",
        params: materializeDefaults("keyframe", "origin_set", {
          title: "${row.label}",
          prompt: "${row.prompt}\nDNA 卡：${dna_card}\n成组共用怎么看的 DNA（笔触逻辑 / 色盘纪律 / 光处理 / 材质），题材、构图、叙事必须原创；一张一张生成、逐张过自查表。",
          role: "origin_set",
          size: "1024x1024",
        }, defaults),
      },
      {
        id: "check", type: "qc",
        intent: "独立评审 + LoRA 可选轨记录：五维还原度 / 组内色盘 / 构图查重 / 题材查重；Lora 训练与挂载 upstream 未接＝unsupported_skip，不生成假模型文件。",
        params: {
          mode: "critic",
          rubric: "style_dna_consistency",
          thresholds: {
            dna: { dims: 5, minEvidencePerDim: 3 },
            copy: { restoreMin: 0.7, highWeightMin: 0.85 },
            variant: { keepMin: "7/9", outlierRecorded: true },
            origin: { count: [6, 8], colorOffsetMaxSteps: 2, uniqueAxes: ["景别", "视点", "负形"], themeNotReplicated: true },
            archive: { required: ["ref_pool", "dna_card", "copy_compare", "variant_matrix", "lora_skip", "origin_set", "prompt_skeleton"] },
            lora: { status: "unsupported_skip", reason: "upstream_unavailable", alt: "fixed_seed+shared_prompt_skeleton" },
            minScore: 0.7,
          },
        },
        inputs: {
          refs: { from: "references" },
          dna: { from: "dna_card" },
          copies: { from: "copy_compare" },
          variants: { from: "variant_matrix" },
          originals: { from: "origin_set" },
        },
      },
      {
        id: "pack", type: "export",
        intent: "旧 role evidence_archive：内化证物档案交付包（原作库 / DNA 卡 / 对拍 / 矩阵 / LoRA skip / 成组 / prompt 骨架）；任何成品图 3 跳内可追到源原作。",
        params: { preset: "image_pack" },
        inputs: {
          catalog: { from: "references" },
          materials: { from: "ref_material" },
          dna_board: { from: "dna_board" },
          dna_card: { from: "dna_card" },
          copies: { from: "copy_compare" },
          variants: { from: "variant_matrix" },
          originals: { from: "origin_set" },
          verdict: { from: "check" },
        },
      },
    ]
    return { nodes, targets: { shots: 24, aspect: "1:1", subtitles: false, audio: "none" }, defaults }
  },
  legacyRoleMap: {
    ref_gen: { intentOf: "ref_material" }, // config 不成节点：model/size/count 已并入 defaults 与 keyframe.params
    ref_pool: "ref_material", // 原图素材走 reference(materialize)，元数据表在 references 行表
    dna_gen: { intentOf: "dna_board" },
    dna_board: "dna_board",
    dna_card_gen: { intentOf: "dna_card" },
    dna_card: "dna_card",
    copy_gen: { intentOf: "copy_compare" },
    copy_compare: "copy_compare",
    matrix_gen: { intentOf: "variant_matrix" },
    variant_matrix: "variant_matrix",
    lora_log: { intentOf: "check" }, // 文本实验记录并入 qc intent；可复算字段进 thresholds.lora
    origin_gen: { intentOf: "origin_set" },
    origin_set: "origin_set",
    archive_gen: { intentOf: "pack" },
    evidence_archive: "pack",
  },
}
