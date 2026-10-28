// 配方 art_curation —— 由旧模板 deploy-staging/gateway/workflow-templates/art_curation.ts（只读）改写。
// 映射原则：docs/architecture/project-graph.md §6（IP/策展族：script(主题) + shotlist(情绪板/构图/展陈/交付) + keyframe#item → qc(critic) → export(image_pack)）。
// 旧 14 role：theme_brief(text) → script；6 个 *_gen(config) 不成节点；audit(text) → qc 的 rubric/thresholds；
// 6 个 image role → 6 个 keyframe（构图稿/成组渲染按同一行表 forEach，交付包按交付行表 forEach）。
import type { Json, NewNode, ProjectDefaults, Recipe } from "../types"
import { materializeDefaults } from "../specs"

const str = (v: Json | undefined, fallback: string): string => (typeof v === "string" && v.trim() !== "" ? v : fallback)
const rowsOf = (rows: Record<string, string>[]): Json => rows.map((r) => ({ ...r }))

const DEFAULT_THEME = `策展立意（theme_brief 口径）：
- 关键词四层：题材层 / 视觉层 / 情绪层 / 观念层，各 3-5 词，四层合计 ≤20 词，同义重复即合并
- 立意句：一句可陈述的主张（例：城市的孤独在霓虹下更亮），先于一切画面
- 目标观众：一句话画像（年龄 / 看展场景 / 动机），调性词 2-3 个，作为情绪板收敛的唯一判据
- 门禁：四层字段齐全且立意句可陈述才放行`

// 旧 composition 的 5-6 张黑白构图稿（起承转合排序；低分辨率先行）
const COMPOSITIONS = rowsOf([
  { id: "c1", label: "起·开场", role: "composition_open", size: "768x768", focus: "1", whitespace: "45%", prompt: "开场构图：留白最足（约 45%），主体九宫格左下，视觉焦点 1 个，黑白灰层次拉满。" },
  { id: "c2", label: "承·铺陈", role: "composition_develop", size: "768x512", focus: "1", whitespace: "38%", prompt: "铺陈构图：横向展开，留白约 38%，主体沿视线动线右移。" },
  { id: "c3", label: "转·对峙", role: "composition_turn", size: "768x768", focus: "2", whitespace: "33%", prompt: "对峙构图：双主体分踞九宫格两侧，视觉焦点 2 个，负形留出张力。" },
  { id: "c4", label: "合·高潮", role: "composition_climax", size: "768x512", focus: "1", whitespace: "30%", prompt: "高潮构图：密度最高，主体压满画面，留白约 30%，黑白对比最强。" },
  { id: "c5", label: "收·回扣", role: "composition_close", size: "768x768", focus: "1", whitespace: "42%", prompt: "收尾构图：回扣立意句，留白回升至约 42%，主体缩小退后。" },
])

// 旧 delivery 的多规格交付行表（印刷比例母版 + 墙面模拟 + 展厅 + 图录）
const DELIVERABLES = rowsOf([
  { id: "print_a2", label: "A2 印刷母版", role: "delivery_print_a2", size: "1536x2176", prompt: "A2 比例印刷母版（420×594mm）：按作品比例重构图，交付前以 300 DPI 复检像素量，不足走放大链路。" },
  { id: "wall", label: "墙面布置模拟", role: "delivery_wall", size: "1536x1024", prompt: "墙面布置模拟：按观展动线挂画，单墙 3-4 幅、中心线 150cm、间距取单幅宽 50%-80%。" },
  { id: "hall", label: "线上展厅", role: "delivery_hall", size: "1536x864", prompt: "线上 3D 展厅空间 + 挂点布置图：位置沿用墙面动线，灯光延续 key art 光源法则。" },
  { id: "catalogue", label: "图录版式", role: "delivery_catalogue", size: "1024x1536", prompt: "图录版式：每件作品配展签（作品名 / 媒介 / 尺寸 / 年份 / 一句话阐释），字号规范统一。" },
])

const DEFAULTS: ProjectDefaults = {
  imageModel: "gpt-image-2.5-flare",
  imageSize: "1024x1024",
  style: "策展系列统一：主色 3 HEX（合计约 70%）+ 点缀 2 HEX（≤10%）；笔触 / 光源方向 / 色温写死，全组逐字复用；留白 30%-45%",
}

export const artCurationRecipe: Recipe = {
  id: "art_curation",
  title: "策展式创作",
  build(p) {
    const defaults: ProjectDefaults = {
      ...DEFAULTS,
      ...(typeof p.model === "string" && p.model ? { imageModel: p.model } : {}),
      ...(typeof p.size === "string" && p.size ? { imageSize: p.size } : {}),
      ...(typeof p.style === "string" && p.style ? { style: p.style } : {}),
    }
    const theme = str(p.theme, DEFAULT_THEME)
    const nodes: NewNode[] = [
      {
        id: "theme", type: "script",
        intent: "旧 role theme_brief：策展立意（四层关键词 JSON + 一句可陈述主张 + 目标观众画像 + 2-3 个调性词）；四层字段齐全才放行。",
        params: { text: theme },
      },
      {
        id: "compositions", type: "shotlist",
        intent: "旧 role composition 的行表：5-6 张黑白构图稿按起承转合排序；每张标九宫格坐标 + 视觉焦点数（1-2）+ 留白占比（30%-45%）。",
        params: { kind: "items", rows: COMPOSITIONS },
        inputs: { brief: { from: "theme" } },
      },
      {
        id: "deliverables", type: "shotlist",
        intent: "旧 role delivery 的行表：印刷母版 / 墙面模拟 / 线上展厅 / 图录版式；300 DPI 与安全区逐项核对，缺一项不算交付完成。",
        params: { kind: "items", rows: DELIVERABLES },
        inputs: { brief: { from: "theme" } },
      },
      {
        id: "moodboard", type: "keyframe",
        intent: "旧 role moodboard：9-12 格情绪板 + 色彩（主 3 + 点缀 2 HEX，带占比）/ 材质（2-3 种）/ 情绪词三类标签；存在两套打架的主色即打回。",
        params: materializeDefaults("keyframe", "moodboard", {
          title: "情绪板",
          prompt: "9-12 格情绪板参考图组：\n${theme}\n每格打三类标签：色彩（主色 3 HEX 合计约 70% + 点缀 2 HEX ≤10%）、材质（2-3 种，各附质感短语）、情绪词；两轮制发散→按立意砍半，收敛为唯一方向。",
          role: "moodboard",
          size: "1536x1024",
        }, defaults),
      },
      {
        id: "style_anchor", type: "keyframe",
        intent: "旧 role style_anchor：canonical key art 一张 + style DNA 四维（笔触肌理 / 光源法则 / 构图法则 / 渲染质感）；四维能从画面逐项指认才算铸成。",
        params: materializeDefaults("keyframe", "style_anchor", {
          title: "风格锚",
          prompt: "本展 canonical key art（全展定调之作）：\n${theme}\n情绪板：${moodboard}\nstyle DNA 四维写死：笔触肌理 / 光源方向 + 硬度 + 色温 / 构图法则 / 渲染质感；定稿后锁定为 sref 风格参考锚，成组阶段共用。",
          role: "style_anchor",
          size: "1536x1024",
        }, defaults),
        inputs: { mood: { from: "moodboard" } },
      },
      {
        id: "composition", type: "keyframe", forEach: { over: "compositions", as: "comp" },
        intent: "旧 role composition：黑白 sketch-lock 构图稿；每张标主体九宫格坐标 + 视觉焦点数 + 留白占比；并排留白节奏统一，任一跳脱即重画该张。",
        params: materializeDefaults("keyframe", "composition", {
          title: "${row.label}",
          prompt: "${row.prompt}\n风格锚：${style_anchor}\n纯黑白构图稿（低成本验证构图），只谈黑白灰分布与视觉重量；留白约 ${row.whitespace}，视觉焦点 ${row.focus} 个。",
          role: "${row.role}",
          size: "${row.size}",
        }, defaults),
        inputs: { style: { from: "style_anchor" } },
      },
      {
        id: "batch_render", type: "keyframe", forEach: { over: "compositions", as: "comp" },
        intent: "旧 role batch_render：按各自黑白构图稿上色，成组同 seed 域、同风格锚；色温 / 光源方向 / 笔触密度并排一致，逐张对表 style DNA 才进组。",
        params: materializeDefaults("keyframe", "batch_render", {
          title: "成组·${row.label}",
          prompt: "${row.prompt}\n按 ${comp.composition} 的黑白构图稿上色；共享 style DNA 四维后缀与同 seed 域；风格锚：${style_anchor}；每张对表色板 HEX 与笔触密度，不对表不进组。",
          role: "batch_render",
          size: "1536x1024",
        }, defaults),
        inputs: { style: { from: "style_anchor" }, sketch: { from: "composition" } },
      },
      {
        id: "exhibition_visual", type: "keyframe",
        intent: "旧 role exhibition_visual：海报（key art + 展名 + 立意句）+ 墙面布置模拟 + 图录版式；三者并排同色系、同留白节奏、同立意表达。",
        params: materializeDefaults("keyframe", "exhibition_visual", {
          title: "展陈主视觉",
          prompt: "展陈主视觉：海报 1 张（key art + 展名 + 立意句排版）+ 墙面布置模拟（起承转合动线）+ 图录版式：\n${theme}\n成组：${batch_render}\n风格锚：${style_anchor}\n单面墙 3-4 幅为限，挂画中心线统一 150cm，间距取单幅宽 50%-80%；展陈留白与作品留白同频。",
          role: "exhibition_visual",
          size: "1536x1024",
        }, defaults),
        inputs: { batch: { from: "batch_render" } },
      },
      {
        id: "delivery_pack", type: "keyframe", forEach: { over: "deliverables", as: "item" },
        intent: "旧 role delivery：多规格交付包逐项生成；印刷 300 DPI 按画幅算死像素（A2 4961×7016、A1 7016×9933，各加 3mm 出血），CMYK 预检 TAC≤300%。",
        params: materializeDefaults("keyframe", "delivery_pack", {
          title: "${row.label}",
          prompt: "${row.prompt}\n规格：${row.label}\n风格锚：${style_anchor}\n印刷用途做 CMYK 预检（TAC≤300%、小字 K100、超色域标注替代），线上素材保持 HEX 色板原样。",
          role: "${row.role}",
          size: "${row.size}",
        }, defaults),
        inputs: { exhibit: { from: "exhibition_visual" } },
      },
      {
        id: "check", type: "qc",
        intent: "一致性质检（旧 role audit）：逐张配色盘 HEX / 笔触密度 / 留白占比；色相偏移 >8° 或 ΔE>12、笔触差 >15%、留白出区间即 outlier 重生，不重跑全组。条目 color_temp、light_direction、stroke、whitespace、no_outlier。",
        params: {
          mode: "critic",
          rubric: "curation_consistency",
          thresholds: {
            palette: { mainColors: 3, accentColors: 2, hueShiftMaxDeg: 8, deltaEMax: 12 },
            strokeDensityTolerance: 0.15,
            whitespace: { min: 0.3, max: 0.45, perImageTolerance: 0.05 },
            layout: { backgrounds: ["起", "承", "转", "合"], focusMax: 2 },
            batch: { min: 5, max: 6, colorTempAligned: true, lightDirectionAligned: true },
            delivery: { printDpi: 300, tacMax: 300, wallHeightCm: 150, wallSpacing: [0.5, 0.8] },
            items: ["color_temp", "light_direction", "stroke", "whitespace", "no_outlier"],
            minScore: 0.7,
          },
        },
        inputs: {
          moodboard: { from: "moodboard" },
          style: { from: "style_anchor" },
          compositions: { from: "composition" },
          batch: { from: "batch_render" },
          exhibition: { from: "exhibition_visual" },
          delivery: { from: "delivery_pack" },
        },
        onFail: { action: "regenerate", max: 2 },
      },
      {
        id: "pack", type: "export",
        intent: "8 环策展交付包（立意 → 情绪板 → 风格锚 → 构图稿 → 成组 → 审计 → 展陈 → 多规格）：图片包 + 评审 verdict，展签与来源记录随包。",
        params: { preset: "image_pack" },
        inputs: {
          moodboard: { from: "moodboard" },
          style: { from: "style_anchor" },
          compositions: { from: "composition" },
          batch: { from: "batch_render" },
          exhibition: { from: "exhibition_visual" },
          delivery: { from: "delivery_pack" },
          verdict: { from: "check" },
        },
      },
    ]
    return { nodes, targets: { shots: 17, aspect: "3:4", subtitles: false, audio: "none" }, defaults }
  },
  legacyRoleMap: {
    theme_brief: "theme",
    moodboard_gen: { intentOf: "moodboard" }, // config 不成节点：model/size/count 已并入 defaults 与 keyframe.params
    moodboard: "moodboard",
    style_gen: { intentOf: "style_anchor" },
    style_anchor: "style_anchor",
    composition_gen: { intentOf: "composition" },
    composition: "composition",
    batch_gen: { intentOf: "batch_render" },
    batch_render: "batch_render",
    audit: "check", // 文本审计的数值门禁并入 qc.params.thresholds
    exhibition_gen: { intentOf: "exhibition_visual" },
    exhibition_visual: "exhibition_visual",
    delivery_gen: { intentOf: "delivery_pack" },
    delivery: "delivery_pack",
  },
}
