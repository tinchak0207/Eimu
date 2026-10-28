// 配方 novel_ip —— 由旧模板 deploy-staging/gateway/workflow-templates/novel_ip.ts（只读）改写。
// 映射原则：docs/architecture/project-graph.md §6（IP/策展族：script + shotlist + keyframe#item → qc(critic) → export(image_pack)）。
// 旧 15 role：world_bible(text) → script；7 个 *_gen(config) 不成节点（model/size/count 并入 defaults/params）；
// 7 个 image role → 7 个 keyframe（角色卡/名场面/多画幅/衍生用 shotlist + forEach 扇出）；说明与门禁并入 intent 与 qc.thresholds。
import type { Json, NewNode, ProjectDefaults, Recipe } from "../types"
import { materializeDefaults } from "../specs"

const str = (v: Json | undefined, fallback: string): string => (typeof v === "string" && v.trim() !== "" ? v : fallback)
const rowsOf = (rows: Record<string, string>[]): Json => rows.map((r) => ({ ...r }))

const DEFAULT_WORLD = `世界观圣经（world_bible_extract 口径）：
- 色彩域：主色 3 HEX + 点缀 2 HEX 字段化，后续所有生图按表查色
- 材质表：金属 / 皮肤 / 布料 / 环境四类，各写一条高光比例（金属×1.5、皮肤×0.5）
- 名场面候选：固定 3 个，各配一行钩子（悬念 / 反转 / 情绪爆点）+ 情绪值（-5~+5）
- 可绘制元素清单：scene-01 / prop-01 / char-01 编号建档，后续引用编号不重写描述
- 门禁：关键元素清单人工确认后才进情绪板`

// 旧 char_card 的三视图 + 表情差列（同构图片 → 一个行表，一个 keyframe 按行扇出）
const VIEWS = rowsOf([
  { id: "front", label: "正面特写", role: "character_front", size: "1024x1536", prompt: "正面特写，平视机位，纯灰背景均匀柔光；锁 face_identity；画面无文字。" },
  { id: "full", label: "正面全身", role: "character_full", size: "1024x1536", prompt: "正面全身，平视机位，纯灰背景；服装与配饰按 DNA 原文，不解构重画。" },
  { id: "side", label: "侧面", role: "character_side", size: "1024x1536", prompt: "90° 侧面，平视机位；锁轮廓、发型与服装侧面结构。" },
  { id: "joy", label: "表情·喜", role: "expression_joy", size: "1024x1024", prompt: "表情差列·喜：同 seed 只换情绪关键词，头部特写，不换服装与光线。" },
  { id: "anger", label: "表情·怒", role: "expression_anger", size: "1024x1024", prompt: "表情差列·怒：同 seed 只换情绪关键词，保留同一角色的五官基线。" },
  { id: "sorrow", label: "表情·哀", role: "expression_sorrow", size: "1024x1024", prompt: "表情差列·哀：同 seed 只换情绪关键词，保留同一角色的五官基线。" },
  { id: "fear", label: "表情·惧", role: "expression_fear", size: "1024x1024", prompt: "表情差列·惧：同 seed 只换情绪关键词，保留同一角色的五官基线。" },
  { id: "wild", label: "表情·狂", role: "expression_wild", size: "1024x1024", prompt: "表情差列·狂：同 seed 只换情绪关键词，保留同一角色的五官基线。" },
  { id: "calm", label: "表情·静", role: "expression_calm", size: "1024x1024", prompt: "表情差列·静：同 seed 只换情绪关键词，保留同一角色的五官基线。" },
])

// 旧 scene_set 的 3-5 张序列分镜（三景别节奏固定）
const SCENES = rowsOf([
  { id: "s1", label: "全景建场", role: "scene_wide", size: "1536x1024", prompt: "全景建场：交代空间与势力关系；光位写死方向与色温，全组统一。" },
  { id: "s2", label: "中景关系", role: "scene_medium", size: "1536x1024", prompt: "中景关系：人物互动推进叙事；机位与光位沿用全景，不许打架。" },
  { id: "s3", label: "特写爆点", role: "scene_close", size: "1024x1024", prompt: "特写爆点：对应钩子位，出 2 候选择优；落选帧留档不删。" },
])

// 旧 aspect_pack 的多画幅（每画幅重构图，不裁切）
const ASPECTS = rowsOf([
  { id: "a34", label: "3:4", role: "aspect_34", size: "768x1024", safe_zone: "顶部 25% 书名区留空", prompt: "3:4 竖版（起点 / QQ阅读）：主体与书名区随画幅重排，禁 center-crop。" },
  { id: "a11", label: "1:1", role: "aspect_11", size: "1024x1024", safe_zone: "四周留安全边", prompt: "1:1 社媒信息流：主体居中，色板与风格锚一致。" },
  { id: "a916", label: "9:16", role: "aspect_916", size: "864x1536", safe_zone: "底部 20% 避让账号信息条", prompt: "9:16 短视频封面：主体压下半区，顶部留书名区。" },
  { id: "a169", label: "16:9", role: "aspect_169", size: "1536x864", safe_zone: "右下 15% 避让时长角标", prompt: "16:9 横版 banner（B 站）：主视觉重构图，右下留空。" },
])

// 旧 derivative_pack 的衍生物料（规格固定，全部从锁定资产派生）
const DERIVATIVES = rowsOf([
  { id: "avatar", label: "头像", role: "derivative_avatar", size: "512x512", prompt: "头像：从锁定资产派生，不做新设定。" },
  { id: "standee", label: "立绘", role: "derivative_standee", size: "1024x1536", prompt: "竖版立绘：透明底便于运营抠图（生成后抠底）。" },
  { id: "poster", label: "海报", role: "derivative_poster", size: "1536x864", prompt: "16:9 海报：主视觉 + 书名区，主视觉区禁 AI 文字。" },
  { id: "emoji", label: "Q版表情包", role: "derivative_emoji", size: "240x240", prompt: "Q 版表情包 8-12 张：从表情差列 6 格扩展，同 seed 只换情绪关键词。" },
])

const DEFAULTS: ProjectDefaults = {
  imageModel: "gpt-image-2.5-flare",
  imageSize: "1024x1024",
  style: "IP 视觉包统一风格：主色 3 HEX + 点缀 2 HEX 写死，规范外主色即判漂移；金属高光×1.5、皮肤×0.5；sref 码 + 权重 + seed 冻结后全案逐字复用",
}

export const novelIpRecipe: Recipe = {
  id: "novel_ip",
  title: "IP视觉包",
  build(p) {
    const defaults: ProjectDefaults = {
      ...DEFAULTS,
      ...(typeof p.model === "string" && p.model ? { imageModel: p.model } : {}),
      ...(typeof p.size === "string" && p.size ? { imageSize: p.size } : {}),
      ...(typeof p.style === "string" && p.style ? { style: p.style } : {}),
    }
    const world = str(p.world, DEFAULT_WORLD)
    const nodes: NewNode[] = [
      {
        id: "world", type: "script",
        intent: "旧 role world_bible：世界观圣经（色彩域 5 HEX、材质表、3 个名场面候选、可绘制元素清单）。关键元素人工确认后才进情绪板。",
        params: { text: world },
      },
      {
        id: "views", type: "shotlist",
        intent: "旧 role char_card 的行表：三视图（正面 / 全身 / 侧面）+ 表情差列 6 格（喜 / 怒 / 哀 / 惧 / 狂 / 静）；同 seed 只换情绪关键词。",
        params: { kind: "views", rows: VIEWS },
        inputs: { brief: { from: "world" } },
      },
      {
        id: "scenes", type: "shotlist",
        intent: "旧 role scene_set 的行表：3-5 张序列分镜，三景别节奏固定（全景建场 → 中景关系 → 特写爆点），光位全程统一。",
        params: { kind: "items", rows: SCENES },
        inputs: { brief: { from: "world" } },
      },
      {
        id: "aspects", type: "shotlist",
        intent: "旧 role aspect_pack 的行表：3:4 / 1:1 / 9:16 / 16:9 各画幅重构图；平台安全区逐项核对（书名区 / 角标 / 账号条）。",
        params: { kind: "items", rows: ASPECTS },
      },
      {
        id: "derivatives", type: "shotlist",
        intent: "旧 role derivative_pack 的行表：头像 / 立绘 / 海报 / Q 版表情包；规格固定，全部从锁定资产（DNA 表 + key art + 多画幅包）派生。",
        params: { kind: "items", rows: DERIVATIVES },
        inputs: { brief: { from: "world" } },
      },
      {
        id: "moodboard", type: "keyframe",
        intent: "旧 role mood_board：3x3 情绪板 + 情绪坐标轴。两轮制发散→收敛；9 格 ≥7 格命中同一频道关键词；色彩收敛到主 3 + 点缀 2 HEX 写死。",
        params: materializeDefaults("keyframe", "moodboard", {
          title: "情绪板",
          prompt: "3x3 情绪板 + 情绪坐标轴：\n${world}\n9 格各配 1-2 个不重复情绪标签；主色 3 HEX + 点缀 2 HEX；9 格中 ≥7 格命中同一频道关键词才算收敛；标出「热血↔治愈」「暗黑↔明亮」两轴落点。",
          role: "moodboard",
          size: "1024x1024",
        }, defaults),
      },
      {
        id: "style_anchor", type: "keyframe",
        intent: "旧 role style_anchor：canonical key art 16:9 一张；sref 0.4/0.5/0.6/0.7 四档测试选命中最高档冻结（码 + 权重 + seed），复测 2 次无偏差。",
        params: materializeDefaults("keyframe", "style_anchor", {
          title: "风格锚",
          prompt: "canonical key art（16:9 定调，视点拉远交代史诗尺度）：\n${world}\n情绪板：${moodboard}\n沿用主色 3 HEX + 点缀 2 HEX；冻结 sref 码 + 权重 + seed 三件套，同配方复测 2 次无偏差才算铸成。",
          role: "style_anchor",
          size: "1536x1024",
        }, defaults),
        inputs: { mood: { from: "moodboard" } },
      },
      {
        id: "char_view", type: "keyframe", forEach: { over: "views", as: "view" },
        intent: "旧 role char_card：三视图 + 表情差列逐张生成；DNA 八维逐字复用，换词=换脸；每角色记录专属 seed 与参考图 ID，洗牌盲认须认出同一角色。",
        params: materializeDefaults("keyframe", "char_view", {
          title: "${row.label}",
          prompt: "${row.prompt}\n世界观：${world}\n风格锚：${style_anchor}\nDNA 八维（脸型 / 发型 / 瞳色 / 体型 / 服装 / 配饰 / 肤色 / 气质）逐字复用，禁止同义替换。",
          role: "${row.role}",
          size: "${row.size}",
        }, defaults),
        inputs: { style: { from: "style_anchor" } },
      },
      {
        id: "scene_frame", type: "keyframe", forEach: { over: "scenes", as: "scene" },
        intent: "旧 role scene_set：名场面组图逐张生成；先 sketch-lock 黑白构图稿再成图；序列内共享 DNA 八维 + 场景锚编号；并排零漂移才算过。",
        params: materializeDefaults("keyframe", "scene_frame", {
          title: "${row.label}",
          prompt: "${row.prompt}\n风格锚：${style_anchor}\n景别 / 机位 / 光位三字段写死，光位全程统一；序列内共享 DNA 八维与场景锚编号，角色与配色不得漂移。",
          role: "${row.role}",
          size: "${row.size}",
        }, defaults),
        inputs: { chars: { from: "char_view" } },
      },
      {
        id: "cover", type: "keyframe",
        intent: "旧 role cover_key_art：竖版 3:4 封面主视觉；男频仰拍 / 女频留白双构图二选一（takes:user）；顶部 1/3 书名区留白，主视觉区禁 AI 文字。",
        params: materializeDefaults("keyframe", "cover", {
          title: "封面主视觉",
          prompt: "竖版封面主视觉：\n${world}\n按频道选构图（男频仰拍、人物占 60%+；女频留白、人物约 40%）；顶部 1/3 为书名区、低细节近平色；主视觉区禁 AI 文字。风格锚：${style_anchor}",
          role: "cover",
          size: "768x1024",
        }, defaults),
        inputs: { scenes: { from: "scene_frame" } },
        takes: { n: 2, select: "user" },
      },
      {
        id: "aspect_frame", type: "keyframe", forEach: { over: "aspects", as: "aspect" },
        intent: "旧 role aspect_pack：每画幅按比例重新构图（禁裁切）；书名区完整 / 主体无截断 / 分辨率达标三项套检，任一不过打回重排。",
        params: materializeDefaults("keyframe", "aspect_frame", {
          title: "${row.label}",
          prompt: "${row.prompt}\n画幅：${row.label}；安全区：${row.safe_zone}\n按画幅重新构图而非裁切；主视觉：${cover}；书名区完整、主体无截断、分辨率达标（三项套检）。",
          role: "${row.role}",
          size: "${row.size}",
        }, defaults),
        inputs: { cover: { from: "cover" } },
      },
      {
        id: "derivative_item", type: "keyframe", forEach: { over: "derivatives", as: "item" },
        intent: "旧 role derivative_pack：头像 / 立绘 / 海报 / Q 版表情包逐张派生；规格固定、不引入规范外色彩；归档记来源 asset_id / seed / sref 版本。",
        params: materializeDefaults("keyframe", "derivative_item", {
          title: "${row.label}",
          prompt: "${row.prompt}\n规格：${row.label}\n从锁定封面、四画幅与风格锚派生，不做新设定；主视觉：${cover}；多画幅：${aspect_frame}；风格锚：${style_anchor}；登记来源 asset_id / seed / sref 配方。",
          role: "${row.role}",
          size: "${row.size}",
        }, defaults),
        inputs: { aspects: { from: "aspect_frame" } },
      },
      {
        id: "check", type: "qc",
        intent: "独立评审：情绪板盲测频道、角色洗牌盲认、名场面并排零漂移、封面书名区、多画幅安全区、归档完整性；不达标逐环回炉，critic 分只当筛选器。条目 mood_blind、style_retest、shuffle_recognize、zero_drift。",
        params: {
          mode: "critic",
          rubric: "ip_pack_visual",
          thresholds: {
            moodboard: { cells: 9, channelHitMin: "7/9", mainColors: 3, accentColors: 2, axes: ["热血↔治愈", "暗黑↔明亮"] },
            styleAnchor: { srefWeights: [0.4, 0.5, 0.6, 0.7], repeatRuns: 2, driftTolerance: 0 },
            character: { views: ["front", "full", "side"], expressions: 6, dnaDims: 8, seedStable: true },
            scenes: { min: 3, max: 5, rhythm: ["wide", "medium", "close"], lightFixed: true },
            cover: { aspect: "3:4", titleZone: "top_third", aiText: false, takes: 2 },
            aspects: { sizes: ["768x1024", "1024x1024", "864x1536", "1536x864"], safetyZones: true },
            derivatives: { specs: { avatar: "512x512", standee: "1024x1536", poster: "1536x864", emoji: "240x240" } },
            archive: { required: ["dna_table", "sref_recipe", "derivatives"] },
            items: ["mood_blind", "style_retest", "shuffle_recognize", "zero_drift", "cover_title", "archive"],
            minScore: 0.7,
          },
        },
        inputs: {
          moodboard: { from: "moodboard" },
          style: { from: "style_anchor" },
          characters: { from: "char_view" },
          scenes: { from: "scene_frame" },
          cover: { from: "cover" },
          aspects: { from: "aspect_frame" },
          derivatives: { from: "derivative_item" },
        },
        onFail: { action: "regenerate", max: 2 },
      },
      {
        id: "pack", type: "export",
        intent: "8 环产物交付包（世界观 → 情绪板 → 风格锚 → 角色 → 名场面 → 封面 → 多画幅 → 衍生）：图片包 + 评审 verdict；DNA 表与 sref 配方副本随包归档。",
        params: { preset: "image_pack" },
        inputs: {
          moodboard: { from: "moodboard" },
          style: { from: "style_anchor" },
          characters: { from: "char_view" },
          scenes: { from: "scene_frame" },
          cover: { from: "cover" },
          aspects: { from: "aspect_frame" },
          derivatives: { from: "derivative_item" },
          verdict: { from: "check" },
        },
      },
    ]
    return { nodes, targets: { shots: 24, aspect: "3:4", subtitles: false, audio: "none" }, defaults }
  },
  legacyRoleMap: {
    world_bible: "world",
    mood_gen: { intentOf: "moodboard" }, // config 不成节点：model/size/count 已并入 defaults 与 keyframe.params
    mood_board: "moodboard",
    style_gen: { intentOf: "style_anchor" },
    style_anchor: "style_anchor",
    char_gen: { intentOf: "char_view" },
    char_card: "char_view",
    scene_gen: { intentOf: "scene_frame" },
    scene_set: "scene_frame",
    cover_gen: { intentOf: "cover" },
    cover_key_art: "cover",
    aspect_gen: { intentOf: "aspect_frame" },
    aspect_pack: "aspect_frame",
    derivative_gen: { intentOf: "derivative_item" },
    derivative_pack: "derivative_item",
  },
}
