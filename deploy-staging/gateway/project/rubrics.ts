// S8c：QC 评分表（纯函数）。machine QC 执行器与 takes 选优共用同一份评分。
// 期望值来源：设计文档 §3.9（时长 ±10%、有音轨、analyzeFilm 的响度/黑帧/冻结帧过阈值）与
// film-qc.ts 的 QC_TARGET_LUFS / QC_TARGET_TP；扣分权重是本片默认评分表 film_default（不含美学项，
// 美学评分按 S8c「禁止打磨」不在此片）。takes 的 select:"qc" 读取 Output.meta.qcScore（takes.ts 的键名）。
import { QC_TARGET_LUFS, QC_TARGET_TP } from "../film-qc.ts"
import type { Output, RubricId } from "./types.ts"

export type MediaKind = "video" | "image" | "audio"

/** 一次机器质检的全部可量测事实；缺陷文字也在这里成形（评分函数只负责扣分）。 */
export interface QcMetrics {
  kind: MediaKind
  filePath: string
  exists: boolean
  decodable: boolean
  probeError: string | null
  hasAudio: boolean
  audioRequired: boolean
  durationSec: number | null
  targetDurationSec: number | null
  durationTolerance: number
  maxDurationSec: number | null
  black: boolean
  blackDetail: string | null
  freeze: boolean
  freezeDetail: string | null
  lufs: number | null
  lufsTarget: number
  lufsTolerance: number
  truePeakDb: number | null
  truePeakMax: number
}

export interface RubricWeights {
  noAudio: number
  duration: number
  black: number
  freeze: number
  loudness: number
  truePeak: number
}

/** 可判定条目。kind=score 时 rule 写明 0–100 阈值；kind=passfail 时 rule 写明过/不过条件。 */
export interface RubricItem {
  id: string
  kind: "score" | "passfail"
  rule: string
}

export interface Rubric {
  id: RubricId
  title: string
  /** 这张表能签的交付媒体。验签必须与 export 的媒体种类一致，不能拿单图表去放行视频。 */
  media: "image" | "video"
  /** 低于此分判不过（设计文档 §3.9「qc 评分≥阈值」；阈值为本片默认，可由 params.thresholds.minScore 覆盖）。 */
  minScore: number
  weights: RubricWeights
  /** critic 逐项判定。缺省表示这张表只供 machine 技术扣分。 */
  items?: readonly RubricItem[]
}

/** 默认及格线：任一单条硬缺陷（权重 45–50）都会把 100 拉到 55 以下。 */
export const QC_MIN_SCORE = 60

/** 可测响度下限：低于此值视为近乎静音（与 film-qc.ts qcAndFixFilm 的 -70 判定同一口径）。 */
export const QUIET_LUFS = -70

const TECH_WEIGHTS: RubricWeights = { noAudio: 45, duration: 45, black: 50, freeze: 45, loudness: 45, truePeak: 45 }

function criticRubric(id: string, title: string, minScore: number, media: "image" | "video", items: readonly RubricItem[]): Rubric {
  return { id, title, media, minScore, weights: TECH_WEIGHTS, items }
}

const pf = (id: string, rule: string): RubricItem => ({ id, kind: "passfail", rule })
const sc = (id: string, rule: string): RubricItem => ({ id, kind: "score", rule })

export const RUBRICS: Readonly<Record<string, Rubric>> = {
  film_default: {
    id: "film_default",
    title: "影音交付默认",
    media: "video",
    minScore: QC_MIN_SCORE,
    weights: TECH_WEIGHTS,
  },
  image_default: criticRubric("image_default", "单图三要素", 60, "image", [
    pf("subject", "画面主体与提示词里的主体是同一个，多一个或少一个主体即不过"),
    pf("style", "画面风格与提示词里的风格词一致，对不上即不过"),
    pf("composition", "构图与提示词里的构图要求一致，裁切主体或主体出画即不过"),
    pf("no_fake_text", "画面没有伪造文字、乱码或标签畸变；出现任一即不过"),
  ]),
  scene_default: criticRubric("scene_default", "场景设定锚", 60, "image", [
    pf("light_direction", "光源方向、色温与场景设定文本一致，方向相反即不过"),
    pf("no_characters", "画面没有人物；出现人物即不过"),
    pf("no_text", "画面没有文字；出现文字即不过"),
  ]),
  character_sheet: criticRubric("character_sheet", "角色四视图", 60, "image", [
    pf("dna_dims", "DNA 八维短语在四视图上逐维可指认，缺一维即不过"),
    pf("identity_anchors", "瞳距、脸型轮廓、发际线三锚点与设定一致，任一漂移即不过"),
    pf("no_fake_text", "画面没有伪造文字；出现即不过"),
  ]),
  ecom_launch: criticRubric("ecom_launch", "电商上市 PRODUCT LOCK", 60, "image", [
    pf("product_lock", "产品形状、标签文字、LOGO 与 PRODUCT LOCK 一致，零变形零乱码；任一不符即不过"),
    sc("cta_negative_space", "CTA 负空间占比 ≥ 30%，视觉层级里产品锐度未因逆光损失；低于 30% 即不过"),
    pf("label_readable", "标签文字放大后仍可读，错别字或乱码即不过"),
    pf("hand_joints", "若画面有手，指数与关节无畸变；畸变即不过"),
  ]),
  ecom_model: criticRubric("ecom_model", "电商模特试穿", 60, "image", [
    pf("garment_fit", "服装贴合、抠图边缘无光晕，服色与原件 ΔE ≤ 5；超标即不过"),
    pf("identity_anchors", "瞳距、脸型轮廓、发际线与模特卡一致，任一漂移即不过"),
    pf("hand_joints", "手部指数与关节无畸变；畸变即不过"),
    pf("safe_area", "平台安全区顶部 ≥ 12%、底部 ≥ 20%，画面文字 ≥ 24px；任一不达标即不过"),
  ]),
  shortdrama_poster: criticRubric("shortdrama_poster", "短剧海报", 60, "image", [
    pf("identity", "两版五官是同一个人：瞳距、脸型轮廓、发际线一致，脸互串即不过"),
    pf("safe_area", "9:16 内剧名区与平台 UI 区没有关键元素入侵；入侵即不过"),
    pf("text_over_face", "文字与字效不覆盖演员面部关键区；覆盖即不过"),
    sc("palette", "取色落在规范色板内，与色板 ΔE ≤ 5；超标即不过"),
  ]),
  ip_pack_visual: criticRubric("ip_pack_visual", "小说 IP 视觉包", 70, "image", [
    pf("mood_blind", "情绪板盲测能猜中题材频道；猜不对即不过。无关者盲猜 3 次，至少 2 次猜中同一频道；9 格至少 7 格命中该频道关键词，主色 3 个 HEX、点缀 2 个 HEX。"),
    pf("style_retest", "同一风格锚配方复测 2 次无偏差；有偏差即不过。两次的主色 HEX 逐个相同，色相偏移 0°，构图逻辑一致；sref 权重只在 0.4、0.5、0.6、0.7 四档里冻结命中最高的一档后再复测。"),
    pf("shuffle_recognize", "三视图与表情列打乱后仍能认出同一角色；认不出即不过。3 张视图加 6 张表情共 9 张打乱，盲认必须 9/9 都指回同一角色。"),
    pf("zero_drift", "组图并排后角色与风格零漂移；有漂移即不过。3 张名场面并排，每张的脸、服装、配色都与三视图一致，不一致的张数是 0。"),
    pf("cover_title", "封面书名区完整且主体无截断；裁字或截断即不过"),
    pf("archive", "DNA 表、sref 配方、衍生物料三者齐备；缺一项即不过"),
  ]),
  curation_consistency: criticRubric("curation_consistency", "策展一致", 60, "image", [
    sc("color_temp", "全组色温一致：色相偏移 ≤ 8° 且 ΔE ≤ 12；超标即不过"),
    pf("light_direction", "全组光源方向一致；方向打架即不过"),
    sc("stroke", "笔触密度差 ≤ 15%；超出即不过"),
    sc("whitespace", "留白占比在 30%–45%，单张偏差 ≤ 5%；出区间即不过"),
    pf("no_outlier", "每张的色盘、笔触密度、留白占比都落在上述区间；任一出界即不过"),
  ]),
  style_dna_consistency: criticRubric("style_dna_consistency", "风格 DNA", 70, "image", [
    sc("restore_70", "五维还原度全部 ≥ 70%（复现成功特征数 / 该维特征总数）；任一维低于 70% 即不过。每维出 5 张，去掉最高与最低各 1 张，取中间 3 张的中位数；中位数低于 70% 即不过。"),
    sc("high_weight_85", "高权重项还原度 ≥ 85%；低于 85% 即不过。高权重锚点按 DNA 卡每张对位图圈出的 3 处计。"),
    pf("grid_7_of_9", "9 格至少 7 格保留四个以上 DNA 维度，且 outlier 已记录；未达到即不过"),
    sc("palette_steps", "组内 HEX 主色偏移 ≤ 2 档；超出即不过"),
    pf("composition_unique", "任意两张的景别、视点、负形三项不完全相同；完全相同即不过"),
    pf("theme_not_copy", "题材没有复刻单一代表作；复刻即不过"),
  ]),
  film_frame_critic: criticRubric("film_frame_critic", "电影族抽帧评审", 70, "video", [
    sc("style_unity_70", "风格统一审计 ≥ 70：色彩方差、质感一致性、风格关键词命中都要有可复算证据；低于 70 即不过"),
    pf("shot_consistency", "逐镜关键帧与角色三视图比对脸部、服装、配色；任一镜不一致即不过"),
    pf("frame_sample", "抽首帧、中帧、尾帧；形变、闪帧或角色漂移任一即不过"),
    pf("character_lock", "角色一致性：DNA 短语原文、固定 seed、三视图参考三者一致；变动没有原因记录即不过"),
    pf("segment_le_15s", "单段时长 ≤ 15s；超出即不过"),
    pf("shot_2_to_5s", "单镜时长在 2–5s；出区间即不过"),
    pf("aspect_matches_target", "画幅与配方目标一致（短剧目标为 9:16）；不一致即不过"),
    pf("shot_reverse_pair", "正反打成对：视线、轴线、背景互为镜像；跳轴即不过"),
    pf("axis_continuous", "轴线连续；跳轴即不过"),
    pf("cut_dialogue", "切点与台词对得上；对不上即不过"),
    pf("hook_early", "钩子位在前段；没有前置钩子即不过"),
    pf("asset_refs", "资产引用完整；缺引用即不过"),
    pf("emotion_chain", "情绪链完整；断裂即不过"),
    pf("hand_closeup_plan", "手部特写若缺失，已有预案；缺失且无预案即不过"),
    pf("transition_marks", "转场标记齐备；缺失即不过"),
    pf("storyboard_qc_17", "storyboard_qc_17：段≤15s、镜 2–5s、画幅、正反打、轴线、切点对账、钩子、资产、情绪链、手部预案、转场标记逐项都过；缺一项即不过"),
    sc("av_sync_0_5s", "抽对白镜头，人声时长与口型镜头时长偏差 ≤ 0.5s；超出即不过"),
  ]),
}

export const DEFAULT_RUBRIC_ID = "film_default"

/** 未知 id 返回 null（执行器据此报 bad_input，而不是静默套默认表）。缺省=film_default。 */
export function rubricOf(id?: string | null): Rubric | null {
  if (!id) return RUBRICS[DEFAULT_RUBRIC_ID]
  return Object.prototype.hasOwnProperty.call(RUBRICS, id) ? RUBRICS[id] : null
}

export interface QcVerdict {
  score: number
  pass: boolean
  deficiencies: string[]
}

const pct = (v: number) => `${(v * 100).toFixed(0)}%`

/**
 * 评分：100 起扣，每类缺陷扣 rubric.weights 里声明的分。
 * 文件不存在/无法解码是硬失败（0 分，不看及格线）；其余按 minScore 判过。
 */
export function scoreQc(m: QcMetrics, rubric: Rubric = RUBRICS[DEFAULT_RUBRIC_ID]): QcVerdict {
  if (!m.exists) return { score: 0, pass: false, deficiencies: [`文件不存在：${m.filePath}`] }
  if (!m.decodable) return { score: 0, pass: false, deficiencies: [`无法解码：${m.probeError ?? "ffprobe 读不出任何流"}`] }

  const w = rubric.weights
  const deficiencies: string[] = []
  let score = 100

  if (m.audioRequired && !m.hasAudio) {
    score -= w.noAudio
    deficiencies.push(m.kind === "audio" ? "无音轨：音频交付里没有音频流" : "无音轨：交付要求有声音，但文件没有音频流")
  }

  if (m.kind !== "image") {
    if (m.durationSec === null || !(m.durationSec > 0)) {
      score -= w.duration
      deficiencies.push("时长为 0：ffprobe 读不出有效时长")
    } else if (m.targetDurationSec !== null) {
      const deviation = Math.abs(m.durationSec - m.targetDurationSec) / m.targetDurationSec
      if (deviation > m.durationTolerance) {
        score -= w.duration
        deficiencies.push(
          `时长 ${m.durationSec.toFixed(2)}s 偏离目标 ${m.targetDurationSec}s 达 ${pct(deviation)}（容差 ${pct(m.durationTolerance)}）`,
        )
      }
    } else if (m.maxDurationSec !== null && m.durationSec > m.maxDurationSec) {
      score -= w.duration
      deficiencies.push(`时长 ${m.durationSec.toFixed(2)}s 超过上限 ${m.maxDurationSec}s`)
    }
  }

  if (m.black) {
    score -= w.black
    deficiencies.push(m.blackDetail ?? "全黑：画面为黑")
  }
  if (m.freeze) {
    score -= w.freeze
    deficiencies.push(m.freezeDetail ?? "冻结：画面静止")
  }

  if (m.hasAudio) {
    if (m.lufs === null) {
      if (m.audioRequired) {
        score -= w.loudness
        deficiencies.push("响度无法测量（ebur128 无结果）")
      }
    } else if (m.lufs <= QUIET_LUFS) {
      if (m.audioRequired) {
        score -= w.loudness
        deficiencies.push(`音轨近乎静音（${m.lufs.toFixed(1)} LUFS），响度不可用`)
      }
    } else {
      if (Math.abs(m.lufs - m.lufsTarget) > m.lufsTolerance) {
        score -= w.loudness
        deficiencies.push(`响度 ${m.lufs.toFixed(1)} LUFS 超出 ${m.lufsTarget}±${m.lufsTolerance} LUFS`)
      }
      if (m.truePeakDb !== null && m.truePeakDb > m.truePeakMax) {
        score -= w.truePeak
        deficiencies.push(`真峰值 ${m.truePeakDb.toFixed(1)} dBFS 超过上限 ${m.truePeakMax} dBFS`)
      }
    }
  }

  score = Math.max(0, Math.min(100, Math.round(score)))
  return { score, pass: score >= rubric.minScore, deficiencies }
}

/** 把 QC 分数写进候选产物的 meta.qcScore（S4：takes select:"qc" 按它取最高分）。返回浅拷贝，不改原产物。 */
export function scoredOutput(o: Output, verdict: Pick<QcVerdict, "score" | "pass"> & { deficiencies?: string[] }): Output {
  return {
    ...o,
    meta: {
      ...(o.meta ?? {}),
      qcScore: verdict.score,
      qcPass: verdict.pass,
      ...(verdict.deficiencies ? { qcDeficiencies: verdict.deficiencies } : {}),
    },
  }
}

/** 默认阈值（qc 节点 params.thresholds 的同名键可覆盖）。 */
export const QC_DEFAULT_THRESHOLDS = {
  durationTolerance: 0.1, // 设计文档 §3.9：targets.durationSec ±10%
  lufsTolerance: 1.5, // 与 film-qc.ts 的 LOUD_TOLERANCE_LU 同一口径
  lufsTarget: QC_TARGET_LUFS,
  truePeakDb: QC_TARGET_TP,
} as const
