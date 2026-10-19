/**
 * 视频导演 persona 契约真源（MOE 改革 Wave2b，2026-09-08）。
 *
 * 逐行镜像轮子真源 src/lib/music-director-persona.ts（禁自造轮子铁律，记忆
 * no-reinvention-copy-verbatim）：身份/工具白名单/SKILL 挂载/委托单入参+回传
 * 契约/回复 token 帽/组装唯一出口六段全部同构。白名单差异仅三处：
 *   ① 域常量换视频版（VIDEO_DIRECTOR_PERSONA_ID="video-director"，
 *      工具白名单 = harness 既有视频工具三件 video_quote/video_upload/
 *      last_frame_video_chain + 报价对偶 image_quote，全部 harness-tool-registry
 *      登记在案，禁手抄未登记 id）；
 *   ② 委托单/回传契约 import 自 video-delegate.ts（视频版委派组装，
 *      交付物四栏 shots/duration_sec/model_hint/qc）；
 *   ③ 交付物契约 expertId 钉死 "video-director"（Wave2 收口接线翻正：值已在
 *      expert-contract ExpertId 联合内，交付物走全型 ExpertDeliverable，零 cast）。
 * 交互/组装逻辑一行不动：assembleVideoDirectorReply 同构（唯一出口、不新增
 * 校验、composeVideoDelegation 直接透传）。
 *
 * 为什么是「契约档」而非运行时：与 blender/music 版同构——persona 的运行时
 * 真源（模型绑定、subagent 派遣 gateway/subagent.ts、agent prompt / AGENTS.md）
 * 都在 VPS /opt/eimu-harness，本地 repo 无 gateway 真源可改。本档钉死契约
 * 四要素并被委托单/回传两端 import。
 *
 * SKILL 挂载：视频导演读取视频域导演配方；模型与运动参考按任务读取，
 * 不挂载 Blender 原生相机配方，不把文本运镜等同原生位姿控制。
 *
 * 隔离铁律：视频导演回传只含交付物契约 + 交付摘要（四栏 payload + video_summary
 * ≤500 token），过程（生成日志/试看中间态/多轮痕迹）不出 subagent——对应
 * gateway subagent.ts 既有隔离语义（subagent.delta 只透 text、summary 截
 * 600 字、子会话用后即删），本档不新增通道。
 * 文案简体（记忆 agent-gateway-copy-rules）。
 */

import {
  VIDEO_DELIVERABLES,
  collectVideoDeliverableFromToolResult,
  composeVideoDelegation,
  VIDEO_CLIP_KIND,
  type VideoDelegation,
  type VideoDelegationResult,
  type VideoToolResult,
} from "./video-delegate";
import { VIDEO_DELIVERABLE_EXPERT_ID } from "./video-delegate";

// ─────────────────────────────────────────── ① persona 身份与文案

/** persona 键名（gateway bindings / 设定 UI / 日志统一用此 id）。 */
export const VIDEO_DIRECTOR_PERSONA_ID = "video-director" as const;

/** 展示名（简体文案；选单/卡片/日志统一取此值）。 */
export const VIDEO_DIRECTOR_PERSONA_LABEL = "视频导演" as const;

/** persona 一句话定位（设定页/选单描述用）。 */
export const VIDEO_DIRECTOR_PERSONA_DESCRIPTION =
  "专属视频导演：接委托单自主设计分镜/运镜/时长与分辨率并选型 seedance/kling 系模型产出成片，只回交付物契约与交付摘要，过程不出子代理。" as const;

// ─────────────────────────────────────────── ② 工具白名单

/**
 * 视频导演可调用的工具白名单（MOE Wave2b 钉死；禁给全工具面——视频导演
 * 不需要跑 Blender/跑音乐）。
 *
 * 全部 id 经 harness-tool-registry.ts 逐行考古（2026-09-08）：
 * - video_quote：L99 登记，只列影片按秒报价清单（image_quote 刻意只列图片、
 *   报影片必须用对偶 video_quote，08-29 生产事故防呆，记忆
 *   video-quote-paired-tool-fix）。
 * - video_upload：L100 登记，视频素材上传。
 * - last_frame_video_chain：L151 登记，尾帧续生视频链（站点 /v1/videos/generations
 *   计费链，seedance 实证）。
 * - image_quote：L76 登记，报价查询对偶（列图侧；域内只用于图片参考素材报价）。
 *
 * 2026-10-01 art-style 接线：新增「视觉资产生成/风格深研」六件（全在
 * harness-tool-registry HARNESS_TOOL_IDS，实现真源见该档 2026-08-31 片3/片6 段）：
 * image_generate（复用现成生图轮子，src/lib/agent-tool-contract.ts:182 → 站点
 * /v1/images/generations）、canvas_get_state / canvas_apply_ops（art_style 模板
 * 明列的回填画布工具）、style_dna_extract / style_aligned_batch /
 * asset_provenance_archive（风格深研三件）。此前这些 id 不属任何 Expert，被
 * tools/export-expert-agents.ts 的补集规则对全部 Expert 写 false，art_style
 * 模板宣告的工具物理不可调；接入本行后由 video-director（视觉产出域）承接。
 */
export const VIDEO_DIRECTOR_PERSONA_TOOL_IDS = [
  "video_quote",
  "video_upload",
  "last_frame_video_chain",
  "image_quote",
  "image_generate",
  "image_get_result",
  "image_result_download",
  "video_result_fetch",
  "canvas_get_state",
  "canvas_apply_ops",
  "style_dna_extract",
  "style_aligned_batch",
  "asset_provenance_archive",
] as const;

export type VideoDirectorPersonaToolId = (typeof VIDEO_DIRECTOR_PERSONA_TOOL_IDS)[number];

// ─────────────────────────────────────────── ③ SKILL 挂载引用

/** 生成器统一映射为 workspace/.opencode 路径，参考文件由 Skill 按需索引。 */
export const VIDEO_DIRECTOR_PERSONA_SKILL_PATHS: readonly string[] = ["skills/video-director/SKILL.md"];

/** 运行期仅挂载短入口；不常驻模型手册或运动词库。 */
export const VIDEO_DIRECTOR_PERSONA_PROMPT = "共同真实性、授权、安全与交付契约见 workspace/AGENTS.md。本域配方按任务与网关事实行加载。\n\n【你的角色：视频导演（分镜/镜头设计/生成影片）】被派来的领域专家，只做本域的活。严格按任务书执行（唯一需求来源，看不到主对话历史），产出遵守交付契约，跳过环节须写明「跳过 X，原因 Y」。只回结论与产物引用。\n\n你是 Eimu 视频导演。研究先行，制作前读取 .opencode/skills/video-director/SKILL.md；根据任务按需读取其中运动与模型参考。先说明镜头叙事收益，再选主体动作、机位路径与时序；遵守明确 static/固定焦距，不默认 slow push。未知素材明确尚未观看。平台真实能力、参考输入、报价与授权为准，研究并发与独立评审保留；实际时序感知回执才能支撑运动审核。制作委托必须包含共享workspace、project/frame/request_id、已有明确预算及canonical/reference/style版本（无额外cap时明确注明，不制造新权限门槛）；图片回收使用image_result_download，不派无该能力的通用席位。按耐久任务与本地hash报告coverage，observed不是downloaded，queued不是失败；持续授权不重复确认。";

// ─────────────────────────────────────────── ④ 委托单 + 回传契约（import，零重定义）

/**
 * 委托单入参契约 = video-delegate.ts composeVideoDelegation 的 schema。
 * 类型全 import（VideoDelegation / VideoDelegationResult），此处零重定义。
 */
export type { VideoDelegation, VideoDelegationResult };

/** 视频工具回执契约（video-delegate.ts 钉死的 ok()/fail() JSON 字符串形）。 */
export type { VideoToolResult };

/** 委托单回传（隔离铁律形）：交付物契约 + 交付摘要，≤500 token。 */
export type VideoDirectorDelegationReply =
  | {
      ok: true;
      /** 交付物契约（expert-contract.ts 契约形：四栏 payload + QC 签名）。 */
      deliverable: import("./video-delegate").VideoDeliverable;
      /** 交付摘要（≤500 token，隔离铁律：过程不出 subagent）。 */
      video_summary: string;
    }
  | { ok: false; code: string; hint: string };

/** 回传摘要 token 帽（隔离铁律钉死值，与 blender/music 版同构）。 */
export const VIDEO_DIRECTOR_REPLY_SUMMARY_TOKEN_CAP = 500 as const;

/**
 * 视频导演回传组装（唯一出口）：视频工具回执 → 交付物契约 → VideoDeliverable。
 * 两端函数均 import 自 video-delegate.ts，本档只做序列（不新增校验、不改契约
 * 形状）。
 */
export function assembleVideoDirectorReply(
  result: VideoToolResult,
  ctx: Parameters<typeof collectVideoDeliverableFromToolResult>[1],
): VideoDirectorDelegationReply {
  const assembled = collectVideoDeliverableFromToolResult(result, ctx);
  if (!assembled.ok) {
    return { ok: false, code: assembled.code, hint: assembled.hint };
  }
  return {
    ok: true,
    deliverable: assembled.deliverable,
    video_summary: videoSummaryFromDeliverable(assembled.deliverable, ctx),
  };
}

/**
 * 交付摘要组装（≤500 token 帽内的确定性拼接；只述结果与证据，不含过程）。
 */
function videoSummaryFromDeliverable(d: import("./video-delegate").VideoDeliverable, ctx: Parameters<typeof collectVideoDeliverableFromToolResult>[1]): string {
  const p = d.payload;
  const shots = Array.isArray(p.shots) ? p.shots : undefined;
  return [
    `视频交付：${VIDEO_CLIP_KIND}，${shots && shots.length > 0 ? `${shots.length} 镜` : "（分镜见交付物）"}${typeof p.duration_sec === "number" ? `，${p.duration_sec} 秒` : ""}`,
    `成片：${d.evidence.url ?? "（见交付物 evidence）"}`,
    `模型口径：${p.model_hint ?? "未知"}`,
    `派工：${ctx.contract.intent}`,
  ].join("；");
}

/**
 * 主脑 → 视频导演委托单构造（唯一入口）：直接透传 composeVideoDelegation
 * （import 轮子，零包装逻辑）。persona 层不做第二套校验。
 */
export const composeVideoDirectorDelegation = composeVideoDelegation;

/** 交付字段白名单 re-export（契约钉死：与 registry video 行 requiredFields 一一对应）。 */
export { VIDEO_DELIVERABLES, VIDEO_DELIVERABLE_EXPERT_ID };
