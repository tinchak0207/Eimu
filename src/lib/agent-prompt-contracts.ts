/**
 * Agent 提示词契约目录（吞 AID 产品层单向差，刀 3-③，2026-09-15）。
 *
 * 结构范式参考：gzxx-2025/aid-server（MIT，copyright 光子讯息(杭州)科技有限公司）
 * `doc/提示词开发指南.md`（27 份契约：用途／输入（占位符表）／输出（形态＋顶层键＋
 * 栏位表）／开发要点／AI 生成指引 + 五条通用硬规则）。**本档只借用结构范式，
 * 全部内容为我方自有**——八个 Expert 的职责、输入栏位、输出栏位一律从现场代码
 * 读出（persona／delegate／registry），没有一项取自 AID。
 *
 * 口径（现场取证，2026-09-15）：
 *   - `inputMode` 八个 Expert 一律 `"user_message"`：我方没有 system prompt
 *     占位符替换通道，委托单是主脑以用户消息递给子代理的（gateway 原样透传
 *     `compose*Delegation(...).serialized` 或 `assemble*Prompt(...).prompt`）。
 *     故 `placeholders` 记录的是「委托单 user message 栏位表」（AID 对 user_message
 *     类 agent 也是这样记：输入栏位表而非 `{xxx}` 表）。
 *   - `outputMode` / `topLevelKeys` / `fields` 描述的是**工具回执 JSON 的顶层契约**
 *     —— 即各 `*-delegate.ts` 的 `collect*DeliverableFromToolResult` 实际
 *     `JSON.parse` 后逐键查验的那一层（`ok` 必为 true + 域必填键）。payload 栏位
 *     （registry `requiredFields`）在回执顶层不保证出现（由 collect 组装），故列为
 *     `required: false` 并在 meaning 标明来源，不冒充必填。
 *   - director3d（`blender-director-persona.ts`）**无模型层 JSON 契约**：
 *     blender-delegate.ts 全档 0 处 `JSON.parse`，产物分拣吃的是 bridge 回传物件
 *     （`BlenderExecuteSuccess`），模型输出是散文。依实情标 `structured_text`
 *     且 `fields: []`，缺口写进 `pitfalls`。
 *
 * 硬规则（照 AID §二 通用硬规则，机械检查见 agent-prompt-contract-check.ts）：
 *   ① 纯 JSON：整段合法 JSON、首字符 `{`/`[`，禁前后说明/围栏/注释；
 *   ② 字符串值内引号用「」，禁未转义英文双引号；
 *   ③ 私有协议标记原样保留（我方的标记＝回执键名与委托单段落标题）；
 *   ④ 必填栏位缺失即判失败（不要的内容写「无」或空数组，**不省略栏位**）；
 *   ⑤ 改提示词不改契约：语气／规则可调，输入栏位、输出结构、协议标记动了就断链路。
 *
 * 本档零运行时逻辑（纯常量 + 一个查表函数）；改契约必同步改 *_delegate.ts 与
 * expert-registry 的 `deliverableContract`（三处同源，禁各抄一份）。
 */

import { DIRECTOR_PERSONA_DESCRIPTION } from "./blender-director-persona";
import { CRITIC_PERSONA_DESCRIPTION } from "./critic-persona";
import { EDITOR_PERSONA_DESCRIPTION } from "./editor-persona";
import { MOTION_DIRECTOR_PERSONA_DESCRIPTION } from "./motion-director-persona";
import { MUSIC_DIRECTOR_PERSONA_DESCRIPTION } from "./music-director-persona";
import { SCREENWRITER_PERSONA_DESCRIPTION } from "./screenwriter-persona";
import { VIDEO_DIRECTOR_PERSONA_DESCRIPTION } from "./video-director-persona";
import { WEB3D_DIRECTOR_PERSONA_DESCRIPTION } from "./web3d-director-persona";

// ─────────────────────────────────────────── 契约型别（结构照 AID）

/** 输入栏位（user message 栏位表项；我方无 `{xxx}` 占位符通道）。 */
export interface PromptPlaceholder {
  /** 栏位名（委托单 JSON 键名，逐字不可改）。 */
  name: string;
  /** 含义（从 delegate 的 JSDoc／校验读出）。 */
  meaning: string;
  /** 来源（谁注入：主脑委托单／画布节点／附件 path／URL…）。 */
  source: string;
}

/** 输出栏位（工具回执顶层契约栏位表项）。 */
export interface PromptField {
  name: string;
  /** 型别（boolean／string／number／string[]／object[]）。 */
  type: string;
  /** true = collect 实际强制该键在回执顶层出现，缺即 missing_deliverables。 */
  required: boolean;
  meaning: string;
}

export interface AgentPromptContract {
  /** 我方 Expert id（＝ expert-registry 键，如 "screenwriter"）。 */
  agentCode: string;
  /** 一句话职责（取 persona DESCRIPTION 常量，单一真源）。 */
  purpose: string;
  inputMode: "placeholder" | "user_message";
  placeholders: PromptPlaceholder[];
  outputMode: "json" | "structured_text";
  /** 回执 JSON 顶层键（json 模式；structured_text 为空阵列）。 */
  topLevelKeys: string[];
  fields: PromptField[];
  /** 不可动的常量（必现在检查文本中的键名／协议标记）。 */
  frozenConstants: string[];
  /** 常见出错点。 */
  pitfalls: string[];
}

// ─────────────────────────────────────────── 共用栏位表片段

/** 工具回执成功位（七个 delegate 一律 `parsed.ok !== true` 即判未交付）。 */
const FIELD_OK: PromptField = {
  name: "ok",
  type: "boolean",
  required: true,
  meaning: "工具回执成功位：必须存在且为 true（值判定由 collect 执行；false = 未交付，禁拿失败回执组装交付物）。",
};

/** 交付物指针二选一（artifact_path／url）——机械检查器不表达二选一，如实标非必填。 */
const FIELD_ARTIFACT_PATH: PromptField = {
  name: "artifact_path",
  type: "string",
  required: false,
  meaning: "交付物本地/相对路径指针（与 url 二选一，至少一项；二选一由 collect 强制，非本键单独必填）。",
};

const FIELD_URL_OPT: PromptField = {
  name: "url",
  type: "string",
  required: false,
  meaning: "交付物公网 URL 指针（与 artifact_path 二选一，至少一项）。",
};

// ─────────────────────────────────────────── 契约目录

/**
 * 八个 Expert 的提示词契约（agentCode = expert-registry 注册键；EXPERT_IDS 八值全覆盖）。
 * 顺序与 expert-registry.EXPERT_REGISTRY 宣告序一致（director3d → critic）。
 */
export const AGENT_PROMPT_CONTRACTS: readonly AgentPromptContract[] = [
  {
    agentCode: "director3d",
    purpose: DIRECTOR_PERSONA_DESCRIPTION,
    // 委托单以序列化 JSON 文本作 prompt（blender-director-persona.ts
    // composeDirectorDelegationPrompt OFF 分支回 composed.serialized），非占位符替换。
    inputMode: "user_message",
    placeholders: [
      { name: "effect_description", meaning: "效果描述（一句话人话，3D 导演据此自主拆解 bpy 脚本）。", source: "主脑委托单（user message）" },
      { name: "shot_count", meaning: "镜头数（整数 1-12；超界结构化报错）。", source: "主脑委托单（user message）" },
      { name: "deliverables", meaning: "交付物清单（白名单 turntable/stills/blend/glb）。", source: "主脑委托单（user message）" },
      { name: "duration_sec", meaning: "期望时长秒（1-120，选填）。", source: "主脑委托单（user message）" },
      { name: "style_constraints", meaning: "风格约束（渲染引擎／打光／色调，选填）。", source: "主脑委托单（user message）" },
      { name: "reference_refs", meaning: "参考资产引用（画布节点 id／附件 path／URL，选填 ≤8 条）。", source: "画布节点／附件／URL" },
    ],
    // 实情：blender-delegate.ts 全档 0 处 JSON.parse；产物分拣吃 bridge 回传物件
    // （collectSceneCardFromArtifacts(BlenderExecuteSuccess)），模型输出为散文。
    outputMode: "structured_text",
    topLevelKeys: [],
    fields: [],
    // 模型层无 JSON 契约；此三键是**工具回执层**（blender-tools.ts ok() 产出，
    // 定义 L121-124；exec 回执 L564-572、render 回执 L774-787、export 回执
    // L829-837）的实际键。
    frozenConstants: ["ok", "artifacts", "scene_summary"],
    pitfalls: [
      "尚无机器契约：模型层输出（散文 + 资产引用）不受纯 JSON 检查；契约检查器对本 Expert 只能校验工具回执层键名，喂散文会误报——如实缺口，非现有规则可涵盖。",
      "产物 kind 白名单 turntable=mp4／stills=png／blend／glb（blender-delegate.ts collectSceneCardFromArtifacts）：缺 mp4 用首张 png 兜底并在 scene_summary 前缀标注；缺 blend 或 glb 直接 missing_deliverables，不产半形数据。",
      "委托单 2k token 预算（DELEGATION_TOKEN_BUDGET）：超预算结构化报错，不会截断后派遣。",
    ],
  },
  {
    agentCode: "music",
    purpose: MUSIC_DIRECTOR_PERSONA_DESCRIPTION,
    inputMode: "user_message",
    placeholders: [
      { name: "effect_description", meaning: "效果描述（一句话人话，音乐导演据此自主拆解情绪契约与生成参数）。", source: "主脑委托单（user message）" },
      { name: "emotion_contract", meaning: "情绪契约（genre／BPM／key／mood／结构，music-lyria.ts 真源形）。", source: "主脑委托单（user message）" },
      { name: "deliverables", meaning: "交付字段清单（白名单：emotion_contract/lyrics/melody_notation/audio_url/duration_source/qc）。", source: "主脑委托单（user message）" },
      { name: "lyrics", meaning: "自订歌词（选填；[Verse]/[Chorus] 段落标签或时间戳；缺省纯器乐）。", source: "主脑委托单（user message）" },
      { name: "duration_hint", meaning: "时长档 full／clip30（选填，缺省 full）。", source: "主脑委托单（user message）" },
      { name: "reference_refs", meaning: "参考素材引用（选填 ≤8 条）。", source: "画布节点／附件／URL" },
    ],
    outputMode: "json",
    // score_abc（2026-09-19 收录）：工具回执层 additive 键，YuE2 通路带白盒 ABC 乐谱，
    // 其余通路固定 null（栏位一律在场）——是 melody_notation 的真源，故列为回执顶层契约；
    // 它非 collect 必查键（缺而不误判），required: false 如实标，亦不入 frozenConstants
    // （frozenConstants ⊆ 必填栏位集是「极简样本零误报」自检的设计不变量）。
    // cot_mode／abc_sha256（2026-09-19 片 K 收录）：乐谱编辑工作流的回执 additive 键——
    // cot_mode=实际生效的 YuE2 乐谱约束模式（full/melody，仅 YuE2 通路在场）；
    // abc_sha256=带谱委托的乐谱指纹（有传 abc 时在场，长乐谱不重复回传）。
    // transcribed_abc_sha256／transcribe_warnings（2026-09-19 片 O 收录）：翻唱工作流
    //（source_audio 扒谱）的回执 additive 键——前者＝扒谱产物的乐谱指纹（＝送入生成
    // 的旋律骨干），后者＝扒谱警告如实透传（可为空数组）。
    // preference_question（2026-10-03 多版本偏好闸收录）：≥2 个候选（audios）时在场的回执层
    // additive 键——熵决策层输出的偏好问题（含 optionTakeUrls：label → 音频 URL 对照），
    // 导演用既有 question 工具抬给使用者；<2 候选时缺席（选填故不入 frozenConstants）。
    topLevelKeys: ["ok", "url", "duration_source", "score_abc", "channel", "fallback_from", "fallback_reason", "cot_mode", "abc_sha256", "transcribed_abc_sha256", "transcribe_warnings", "preference_question"],
    fields: [
      FIELD_OK,
      { name: "url", type: "string", required: true, meaning: "音频公网 URL（music-delegate.ts:338；上游未上传 gateway 即 missing_deliverables）→ payload.audio_url。" },
      { name: "duration_source", type: "string", required: true, meaning: "时长来源（ffprobe 实测／upstream_reported（YuE2 上游端真量测）／model_hint；music-delegate.ts:339）。" },
      { name: "score_abc", type: "string", required: false, meaning: "白盒 ABC 乐谱（music-tools.ts 回执层，栏位一律在场）：YuE2 通路带可编辑 ABC 记谱（K: 调号＋Q: 节拍＋V: Vocal 声部），其余通路固定 null——melody_notation 的真源，导演可直接引用其 Vocal 声部组装交付。" },
      { name: "channel", type: "string", required: false, meaning: "生成通路标识（music-tools.ts 回执层：yue2_modal／flowmusic2api／lyria_gemini）；技能库按回执 channel 栏选 DATA 档，不预判通路。" },
      { name: "fallback_from", type: "string", required: false, meaning: "回落来源通路（music-tools.ts 回执层，仅 YuE2 抛错且 FlowMusic 接手时出场，值 \"yue2_modal\"）；正常生成缺席，缺而不误判。" },
      { name: "fallback_reason", type: "string", required: false, meaning: "回落原因摘要（YuE2 原错误压平＋500 字截断＋secret 遮蔽）；诊断用，导演可引用如实说明。" },
      { name: "cot_mode", type: "string", required: false, meaning: "实际生效的 YuE2 乐谱约束模式（music-tools.ts 回执层，仅 YuE2 通路在场）：full=旋律与和弦都被乐谱约束；melody=只约束旋律、伴奏自由适配（翻唱模式）。带 abc 委托时导演可引用核对编辑语义是否生效。" },
      { name: "abc_sha256", type: "string", required: false, meaning: "带谱委托的 ABC 乐谱指纹（music-tools.ts 回执层，有传 abc 时在场；hex sha256）：长乐谱不重复回传，比对指纹即知送入重渲染的乐谱版本。" },
      { name: "transcribed_abc_sha256", type: "string", required: false, meaning: "翻唱工作流（source_audio）的扒谱产物指纹（music-tools.ts 回执层，带 source_audio 时在场；hex sha256）：＝送入生成的旋律骨干 ABC——比对指纹即知本次翻唱沿用的旋律骨干；与 abc_sha256（委托自备谱）互斥不同时在场。" },
      { name: "transcribe_warnings", type: "string[]", required: false, meaning: "扒谱警告（music-tools.ts 回执层，带 source_audio 时在场，可为空数组）：SheetSage2 对源音频的如实警告（如截断提示），导演可引用说明扒谱品质；不粉饰不吞掉。" },
      { name: "preference_question", type: "object", required: false, meaning: "多版本偏好闸（music-tools.ts 回执层，仅 audios.length>=2 时在场）：熵决策层（music-take-entropy.ts）输出的偏好问题对象——asked/question/header/options/optionTakeUrls/entropy/suggestedIndex。asked=true 时导演用既有 question 工具把 question/header/options 逐字抬给用户，拿到答复后用 optionTakeUrls（label → 音频 URL）把选中 label 翻成定版 URL；asked=false 时不弹卡、直接采 suggestedIndex（索引对齐 audios[]）。音频已随各 take 的 audio.done 卡交付，问题卡只指认版本。" },
      { name: "duration_seconds", type: "number", required: false, meaning: "时长秒（music-delegate.ts:354-357，>0 才取用）→ evidence.durationSec。" },
      { name: "audio_bytes", type: "number", required: false, meaning: "音频字节数（music-delegate.ts:353）→ evidence.bytes。" },
      { name: "mime_type", type: "string", required: false, meaning: "音频 MIME（music-delegate.ts:366，进 qc 栏）。" },
      { name: "model", type: "string", required: false, meaning: "上游模型名（music-delegate.ts:366，进 qc 栏）。" },
      { name: "lyrics_echo", type: "string", required: false, meaning: "歌词回声（music-delegate.ts:358；缺省回退委托单 lyrics）。" },
      { name: "emotion_contract", type: "object", required: false, meaning: "payload 栏（registry requiredFields；由 collect 从委托单组装，回执顶层不要求）。" },
      { name: "lyrics", type: "string", required: false, meaning: "payload 栏（registry requiredFields；由 collect 组装，回执顶层不要求）。" },
      { name: "melody_notation", type: "string", required: false, meaning: "payload 栏（registry requiredFields）：人声主旋律音高序列，由导演**正文**逐字出现栏位名＋实质内容（VPS 闸门判据），非回执键、collect 不伪造。" },
      { name: "audio_url", type: "string", required: false, meaning: "payload 栏（registry requiredFields；＝回执 url）。" },
      { name: "qc", type: "string", required: false, meaning: "payload 栏（registry requiredFields）：由 collect 生成（duration_source/mime/bytes/model 拼接），回执顶层不要求。" },
    ],
    frozenConstants: ["ok", "url", "duration_source"],
    pitfalls: [
      "melody_notation 不存在于工具回执：它由导演正文交付，缺整栏 = 未交付；委托单 deliverables 含它时组装 prompt 会附「栏位名逐字＋实质内容」形态指引（music-delegate.ts assembleMusicDirectorPrompt）；YuE2 通路回执的 score_abc（ABC 记谱，K: 调号＋Q: 节拍＋V: Vocal 声部）是其真源，可直接引用组装，勿另行编造音名序列。",
      "duration_source 缺失即 missing_deliverables——时长不可自报口径（上游自报与 ffprobe 实测必须标明来源）。",
      "melody_notation 之外的六栏里，emotion_contract/lyrics/audio_url/qc 由 collect 组装，勿在回执里手拼。",
      "score_abc 是回执层栏非导演义务栏：非 YuE2 通路固定 null，勿手拼 ABC 乐谱回填（闸门只认导演正文的 melody_notation 栏）。",
      "乐谱编辑工作流（带 abc 重渲染）仅 YuE2 通路有效：cot_mode／abc_sha256 只在 YuE2 回执在场；带 abc 委托在 YuE2 抛错时直接失败不回落（FlowMusic 不认乐谱，回落会静默丢失编辑语义）——导演引用时如实说明，勿把回落版本当编辑结果。",
      "翻唱工作流（source_audio 扒谱＋重演绎）仅 YuE2 通路有效：transcribed_abc_sha256／transcribe_warnings 只在带 source_audio 的回执在场；source_audio 与 abc 互斥（同传即 invalid_args）；扒谱 422 abc_missing 是确定性失败（源音频无可提取旋律）勿重试同一份音频；扒谱/生成失败直接报错不回落——翻唱语义不可被无谱通路顶替。",
      "多版本偏好闸（preference_question）只在 audios.length>=2 时在场（单 clip 回执不含此键，勿误判为缺栏）：asked=true 必须立刻用 question 工具把 question/header/options 逐字抬给用户，不得改写或增删选项；选项只带文字，音频对照靠 optionTakeUrls（label → url），禁止把音频塞进 question 选项。asked=false 不弹卡，直接采 suggestedIndex（索引对齐 audios[]），并用 entropy.reason 说明为何不问。",
    ],
  },
  {
    agentCode: "video-director",
    purpose: VIDEO_DIRECTOR_PERSONA_DESCRIPTION,
    inputMode: "user_message",
    placeholders: [
      { name: "subject", meaning: "主题（拍什么／给谁看，视频导演据此自主拆镜头）。", source: "主脑委托单（user message）" },
      { name: "action", meaning: "动作／剧情描述（画面里发生什么）。", source: "主脑委托单（user message）" },
      { name: "deliverables", meaning: "交付字段清单（白名单：shots/duration_sec/model_hint/qc）。", source: "主脑委托单（user message）" },
      { name: "shots", meaning: "分镜列表（选填；缺省导演自主分镜 ≤20 条）。", source: "主脑委托单（user message）" },
      { name: "duration_hint", meaning: "时长档（正数秒，取整；选填）。", source: "主脑委托单（user message）" },
      { name: "resolution", meaning: "分辨率档（如 720p/1080p，选填）。", source: "主脑委托单（user message）" },
      { name: "model_hint", meaning: "模型提示（如 seedance-2.5／kling；导演自主终选）。", source: "主脑委托单（user message）" },
      { name: "camera_notes", meaning: "镜头笔记（运镜／光影／节奏约束，选填）。", source: "主脑委托单（user message）" },
      { name: "reference_refs", meaning: "参考素材引用（选填 ≤8 条）。", source: "画布节点／附件／URL" },
    ],
    outputMode: "json",
    topLevelKeys: ["ok", "url", "duration_seconds"],
    fields: [
      FIELD_OK,
      { name: "url", type: "string", required: true, meaning: "成片公网 URL（video-delegate.ts:374；未上传 gateway 即 missing_deliverables）。" },
      { name: "duration_seconds", type: "number", required: true, meaning: "成片时长秒（video-delegate.ts:375-378，>0 才取用；缺失即 missing_deliverables，video-delegate.ts:381）。" },
      { name: "shots_echo", type: "string[]", required: false, meaning: "分镜回声（video-delegate.ts:392；缺省回退委托单 shots）。" },
      { name: "model", type: "string", required: false, meaning: "上游模型名（video-delegate.ts:394；缺省回退委托单 model_hint）。" },
      { name: "video_bytes", type: "number", required: false, meaning: "成片字节数（video-delegate.ts:395）→ evidence.bytes。" },
      { name: "mime_type", type: "string", required: false, meaning: "成片 MIME（video-delegate.ts:401，进 qc 栏）。" },
      { name: "shots", type: "string[]", required: false, meaning: "payload 栏（registry requiredFields；＝回执 shots_echo 或委托单 shots，回执顶层不要求）。" },
      { name: "duration_sec", type: "number", required: false, meaning: "payload 栏（registry requiredFields；＝回执 duration_seconds，键名不同）。" },
      { name: "model_hint", type: "string", required: false, meaning: "payload 栏（registry requiredFields；＝回执 model 或委托单 model_hint）。" },
      { name: "qc", type: "string", required: false, meaning: "payload 栏（registry requiredFields）：由 collect 生成，回执顶层不要求。" },
    ],
    frozenConstants: ["ok", "url", "duration_seconds"],
    pitfalls: [
      "回执键名与 payload 栏名不同（url→audio_url 家族：duration_seconds→duration_sec、model→model_hint）：改回执键名会断 collect，改 payload 栏名会断 registry 闸门。",
      "duration_seconds 缺失即 missing_deliverables——禁把委托单 duration_hint 当实测时长回填。",
      "分镜回声栏（shots_echo）缺席时 collect 回退委托单 shots 或「（导演自主分镜，未显式指定）」——此为兜底非交付。",
    ],
  },
  {
    agentCode: "editor",
    purpose: EDITOR_PERSONA_DESCRIPTION,
    inputMode: "user_message",
    placeholders: [
      { name: "source_clips", meaning: "源素材清单（每个素材是什么，剪辑师据此自主排时间线 ≤30 条）。", source: "主脑委托单（user message）" },
      { name: "deliverables", meaning: "交付字段清单（白名单：timeline_ops/duration_sec/qc）。", source: "主脑委托单（user message）" },
      { name: "timeline_ops", meaning: "时间线操作意图（选填 ≤40 条；缺省剪辑师自主编排）。", source: "主脑委托单（user message）" },
      { name: "rhythm_notes", meaning: "节奏笔记（卡点／情绪曲线／段落停顿，选填）。", source: "主脑委托单（user message）" },
      { name: "mix_notes", meaning: "混音笔记（旁白／BGM／SFX 层级与 ducking，选填）。", source: "主脑委托单（user message）" },
      { name: "duration_hint", meaning: "时长档（正数秒，取整；选填）。", source: "主脑委托单（user message）" },
      { name: "delivery_spec", meaning: "交付规格（如 1080p H.264 + AAC、竖屏 9:16，选填）。", source: "主脑委托单（user message）" },
      { name: "reference_refs", meaning: "参考素材引用（选填 ≤8 条）。", source: "画布节点／附件／URL" },
    ],
    outputMode: "json",
    topLevelKeys: ["ok", "url", "duration_seconds", "qc"],
    fields: [
      FIELD_OK,
      { name: "url", type: "string", required: true, meaning: "成片公网 URL（editor-delegate.ts:367；未上传 gateway 即 missing_deliverables）。" },
      { name: "duration_seconds", type: "number", required: true, meaning: "成片时长秒（editor-delegate.ts:368-371，>0 才取用；缺失即 missing_deliverables）。" },
      { name: "qc", type: "string", required: true, meaning: "质检结论（editor-delegate.ts:373；timeline_lint／timeline_master 结论必须随回执上交，缺失即 missing_deliverables）。" },
      { name: "timeline_ops_echo", type: "string[]", required: false, meaning: "时间线操作回声（editor-delegate.ts:372；缺省回退委托单 timeline_ops）。" },
      { name: "video_bytes", type: "number", required: false, meaning: "成片字节数（editor-delegate.ts:389）→ evidence.bytes。" },
      { name: "timeline_ops", type: "string[]", required: false, meaning: "payload 栏（registry requiredFields；＝回执 timeline_ops_echo 或委托单 timeline_ops，editor-delegate.ts:391-395）。" },
      { name: "duration_sec", type: "number", required: false, meaning: "payload 栏（registry requiredFields；＝回执 duration_seconds，键名不同）。" },
    ],
    frozenConstants: ["ok", "url", "duration_seconds", "qc"],
    pitfalls: [
      "qc 是唯一在回执层就必填的域内结论栏（video/music 的 qc 由 collect 生成，剪辑域要求工具链自报）——省掉它 = 未交付。",
      "timeline_ops_echo 缺席时 collect 回退委托单 timeline_ops；回执不带 echo 不等于交付了操作，是兜底。",
      "成片必须走 lint／master 质检再回执：url 有了但 qc 空＝missing_deliverables。",
    ],
  },
  {
    agentCode: "screenwriter",
    purpose: SCREENWRITER_PERSONA_DESCRIPTION,
    inputMode: "user_message",
    placeholders: [
      { name: "logline", meaning: "故事内核（一句话人话：谁在何处想干什么、遇到什么阻力，≤600 字）。", source: "主脑委托单（user message）" },
      { name: "deliverables", meaning: "交付字段清单（白名单：beats/shotlist/qc）。", source: "主脑委托单（user message）" },
      { name: "genre", meaning: "题材（选填，≤120 字）。", source: "主脑委托单（user message）" },
      { name: "tone", meaning: "基调（选填，≤120 字）。", source: "主脑委托单（user message）" },
      { name: "beats", meaning: "既有故事节拍（选填 ≤24 条；缺省编剧自主拆解）。", source: "主脑委托单（user message）" },
      { name: "shotlist", meaning: "既有分镜清单（选填 ≤48 场；每场 description 必填 ≤200 字、scene/duration_sec 取整）。", source: "主脑委托单（user message）" },
      { name: "characters", meaning: "角色清单（名字＋一句话人设，选填 ≤12 条）。", source: "主脑委托单（user message）" },
      { name: "world_refs", meaning: "世界观／素材引用（画布节点 id／附件 path／URL，原样透传 ≤8 条）。", source: "画布节点／附件／URL" },
    ],
    outputMode: "json",
    topLevelKeys: ["ok", "beats", "shotlist", "qc"],
    fields: [
      FIELD_OK,
      { name: "beats", type: "string[]", required: true, meaning: "故事节拍（screenwriter-delegate.ts:385；空阵列即 missing_deliverables）。" },
      { name: "shotlist", type: "object[]", required: true, meaning: "分镜清单（screenwriter-delegate.ts:386；空阵列即 missing_deliverables；元素是 ShotlistEntry）。" },
      { name: "qc", type: "string", required: true, meaning: "QC 结论（screenwriter-delegate.ts:387；缺失即 missing_deliverables）。" },
      FIELD_ARTIFACT_PATH,
      FIELD_URL_OPT,
    ],
    frozenConstants: ["ok", "beats", "shotlist", "qc"],
    pitfalls: [
      "beats／shotlist 必须是非空**阵列**（collect 只认 Array.isArray），字串或物件即视同空 → missing_deliverables。",
      "该域回执必须附 artifact_path 或 url 交付物指针（二选一），两者皆缺即 missing_deliverables。",
      "shotlist 元素走白名单收敛（ShotlistEntry 已知键）：未知键被丢弃，description 为必填非空字串。",
    ],
  },
  {
    agentCode: "motion-director",
    purpose: MOTION_DIRECTOR_PERSONA_DESCRIPTION,
    inputMode: "user_message",
    placeholders: [
      { name: "motion_spec", meaning: "动态规格（一句人话：什么元素做什么运动、什么节奏与氛围，≤600 字）。", source: "主脑委托单（user message）" },
      { name: "deliverables", meaning: "交付字段清单（白名单：motion_spec/qc）。", source: "主脑委托单（user message）" },
      { name: "keyframes", meaning: "既有关键帧清单（选填 ≤24 条；缺省动态导演自主拆）。", source: "主脑委托单（user message）" },
      { name: "easing_notes", meaning: "缓动／节奏笔记（easing／时长分配／物理感，选填）。", source: "主脑委托单（user message）" },
      { name: "duration_hint", meaning: "时长档（正数秒，取整；选填）。", source: "主脑委托单（user message）" },
      { name: "deliverable_format", meaning: "交付格式（如 mp4／gif／png 序列，选填 ≤40 字）。", source: "主脑委托单（user message）" },
    ],
    outputMode: "json",
    topLevelKeys: ["ok", "motion_spec", "qc"],
    fields: [
      FIELD_OK,
      { name: "motion_spec", type: "string", required: true, meaning: "动态规格（motion-delegate.ts:323；空则回退委托单，仍空即 missing_deliverables）。" },
      { name: "qc", type: "string", required: true, meaning: "QC 结论（motion-delegate.ts:324；缺失即 missing_deliverables）。" },
      FIELD_ARTIFACT_PATH,
      FIELD_URL_OPT,
      { name: "keyframes_echo", type: "string[]", required: false, meaning: "关键帧回声（motion-delegate.ts:327）→ payload.keyframes。" },
    ],
    frozenConstants: ["ok", "motion_spec", "qc"],
    pitfalls: [
      "回执必须附 artifact_path 或 url（二选一），两者皆缺即 missing_deliverables。",
      "motion_spec 缺席时 collect 回退委托单原文；回退不是交付，缺整栏仍算未交付。",
      "keyframes_echo 可缺（payload.keyframes 为选填栏），但栏位名不得改写成 keyframes 回填。",
    ],
  },
  {
    agentCode: "web3d-director",
    purpose: WEB3D_DIRECTOR_PERSONA_DESCRIPTION,
    inputMode: "user_message",
    placeholders: [
      { name: "scene_spec", meaning: "场景规格（什么场景、什么视觉目标、跑在什么页面，≤600 字）。", source: "主脑委托单（user message）" },
      { name: "deliverables", meaning: "交付字段清单（白名单：scene_spec/bundle_ref/qc）。", source: "主脑委托单（user message）" },
      { name: "interactions", meaning: "交互清单（点击／拖拽／滚轮／悬停，选填 ≤16 条）。", source: "主脑委托单（user message）" },
      { name: "camera_notes", meaning: "相机笔记（机位／轨道／视场／降级约束，选填）。", source: "主脑委托单（user message）" },
      { name: "bundle_hint", meaning: "资产链提示（GLB 来源／资产包 id／纹理口径，选填 ≤300 字）。", source: "资产包／主脑委托单" },
    ],
    outputMode: "json",
    topLevelKeys: ["ok", "scene_spec", "bundle_ref", "qc"],
    fields: [
      FIELD_OK,
      { name: "scene_spec", type: "string", required: true, meaning: "场景规格（web3d-delegate.ts:300；空即 missing_deliverables）。" },
      { name: "bundle_ref", type: "string", required: true, meaning: "GLB／打包产物指针（web3d-delegate.ts:301；可回退 artifact_path／url，三者皆缺即 missing_deliverables）。" },
      { name: "qc", type: "string", required: true, meaning: "QC 结论（web3d-delegate.ts:302；缺失即 missing_deliverables）。" },
      FIELD_ARTIFACT_PATH,
      FIELD_URL_OPT,
    ],
    frozenConstants: ["ok", "scene_spec", "bundle_ref", "qc"],
    pitfalls: [
      "bundle_ref 同时是 payload 栏与 evidence 本体：http(s) 走 evidence.url，其余（如 .blender-work/out/*.glb）走 evidence.artifactPath（web3d-delegate.ts:325-329）——改判定式会让指针落错槽。",
      "GLB 唯一现成出口是 blender_export_gltf（persona 工具白名单两件之一）；没有第二条资产通路。",
      "bundle_ref／artifact_path／url 三者皆缺即 missing_deliverables，别把 bundle_hint（委托单提示）当交付指针回填。",
    ],
  },
  {
    agentCode: "critic",
    purpose: CRITIC_PERSONA_DESCRIPTION,
    inputMode: "user_message",
    placeholders: [
      { name: "review_target", meaning: "被审对象（审哪个交付物／声称、验什么收，≤600 字）。", source: "主脑委托单（user message）" },
      { name: "deliverables", meaning: "交付字段清单（白名单：verdict/issues/evidence/qc）。", source: "主脑委托单（user message）" },
      { name: "scope", meaning: "审核范围／重点（选填，≤120 字）。", source: "主脑委托单（user message）" },
      { name: "checklist", meaning: "审核要点清单（选填 ≤24 条；缺省按交付契约自行展开）。", source: "主脑委托单（user message）" },
      { name: "reference_deliverables", meaning: "跨档对表的交付物指针（画布节点 id／附件 path／URL，原样透传 ≤8 条）。", source: "画布节点／附件／URL" },
    ],
    outputMode: "json",
    topLevelKeys: ["ok", "verdict", "issues", "evidence", "qc"],
    fields: [
      FIELD_OK,
      { name: "verdict", type: "string", required: true, meaning: "审核结论（critic-delegate.ts:326；缺失即 missing_deliverables）。" },
      { name: "issues", type: "string[]", required: true, meaning: "驳回清单（critic-delegate.ts:327；**键必须在场**，通过时可为空数组——非 Array 即 missing_deliverables）。" },
      { name: "evidence", type: "string[]", required: true, meaning: "复算过程与指针（critic-delegate.ts:328；键必须在场，可为空数组；注意此键是**数组**，非 evidence 物件）。" },
      { name: "qc", type: "string", required: true, meaning: "自检结论（critic-delegate.ts:329；缺失即 missing_deliverables）。" },
      FIELD_ARTIFACT_PATH,
      FIELD_URL_OPT,
    ],
    frozenConstants: ["ok", "verdict", "issues", "evidence", "qc"],
    pitfalls: [
      "issues／evidence 必须**在场且为数组**（可空数组）——「不需要就省略栏位」在本域直接判未交付（AID 硬规则 ④ 同款：写「无」或空数组，不省栏）。",
      "本域 evidence 是字符串数组，与 ExpertDeliverable.evidence（可核验指针物件）同名不同物：回执里写成物件即判缺失。",
      "审核官不产内容（工具白名单只有 search_web）：verdict 不得依赖任何生成工具，回执须附 artifact_path／url 指针（二选一）。",
    ],
  },
];

// ─────────────────────────────────────────── 查表

/** 按 agentCode 取契约（未注册返回 undefined，不抛）。 */
export function getContract(agentCode: string): AgentPromptContract | undefined {
  return AGENT_PROMPT_CONTRACTS.find((c) => c.agentCode === agentCode);
}
