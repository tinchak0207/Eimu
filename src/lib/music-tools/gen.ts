import { createHash } from "node:crypto"
import { FLOWMUSIC_MODELS, generateFlowMusicTrack, isFlowMusic2ApiEnabled, type GenerateFlowMusicTrackResult } from "../music-flowmusic"
import { LYRIA_MODELS, buildLyriaStylePrompt, generateLyriaTrack, hasGeminiStudioApiKey, type GenerateLyriaTrackResult, type LyriaMusicContract } from "../music-lyria"
import { YUE2_MODEL_ID, YUE2_TRANSCRIBE_ABC_MISSING_CODE, Yue2TranscribeError, generateYue2Track, isYue2ModalEnabled, transcribeYue2Score, type GenerateYue2TrackResult, type Yue2CotMode } from "../music-yue2"
import { describeRetainedParts, directMusicPrompt, stripLyricsTimestamps } from "../music-prompt-director"
import { buildMusicPreferenceQuestion, type MusicTakeFeature } from "../music-take-entropy"
import { MusicToolError, PROBE_STATUS_LABEL, YUE2_TOOL_COT_MODES, appendMusicPromptChain, asString, fail, measureAudioDuration, ok, probeMusicChannels, stripDataUrlPrefix, textFingerprint, toFail, uploadAudio, yue2FallbackReason, type MusicToolDef } from "./core"

/**
 * 情绪契约 → prompt（工具层薄组装：契约栏位从 prompt 文本解析不了，所以工具参数
 * 只收自由文本 prompt；结构标签/时间戳由调用方写进 prompt 文本。lyrics 缺省=纯器乐）。
 */
function buildToolPrompt(rawPrompt: string, hasLyrics: boolean): string {
  if (hasLyrics) return rawPrompt.trim()
  // 无歌词 → 官方器乐写法收尾（若 prompt 已声明 vocal 意图则尊重原文不重复加）。
  if (/instrumental only|no vocals/i.test(rawPrompt)) return rawPrompt.trim()
  return `${rawPrompt.trim()} Instrumental only, no vocals.`
}

export const musicGenTool: MusicToolDef = {
  id: "music_gen",
  description:
    "调用 Lyria／FlowMusic2API／YuE2 生成音乐（主题曲/插曲/配乐）。整歌或快速生成，返回音频 URL、时长与歌词回显；YuE2 通路另返回可编辑的白盒 ABC 乐谱 score_abc（可二次精修），且支持带谱重渲染——传入 abc（自备/已编辑的 ABC 乐谱）＋cot_mode 即以该乐谱为约束重新生成录音（乐谱编辑＝改和弦/改谱后重渲染出新版本，仅 YuE2 通路有效），或传入 source_audio（源音频 base64，可带 data: 前缀）走翻唱工作流——先自动扒谱（SheetSage2 提取旋律骨干）再以新风格重新演绎（cot_mode 缺省 melody＝官方翻唱模式，伴奏自由适配新风格；显式传 full 则保留原曲和声重渲染）。无歌词时按纯器乐处理；需要人声必须提供歌词。风格 prompt 按六层公式写全（顺序即优先级）：GENRE（流派/年代或场景，放最前）→ 决定性参数（BPM／调性 key／和弦进行／段落结构，写在最前 1/3，如 96 BPM, key of C major, Am7-Dm7-G7-Cmaj7, verse-chorus-bridge；上游摘要只逐字保留前段，写在尾部会被丢）→ MOOD（最多两个相容情绪词）→ INSTRUMENTATION（2-3 件主导乐器＋演奏法）→ VOCAL（谁唱、怎么唱）→ PRODUCTION（年代/混音/空间等修饰性描述，放最后、可被裁）。提示词会先过规则层（补缺层/剥死时间码/整句裁长度），结果在回执 prompt_director 如实回报。长度硬上限（runes）：FlowMusic2API 无歌词单行分支 220、带歌词/段落标签保版面分支 3000；YuE2 style 600；Lyria 不设上限。无歌词器乐分支最紧——超 220 时规则层整句丢弃低优先的描述性修饰子句（混音／空间／年代感），保住 GENRE 与前置的决定性参数（BPM／调性／和弦进行／段落结构），绝不切半句，被丢的层在回执 prompt_director.truncated 列出；想保住完整描述就压进 220，或给歌词走 3000 分支。写歌词前先传 probe=true 做免费通路体检（不生成、不计费），确认 can_generate_vocal_song 再动笔。通路由环境配置固定（优先序 YuE2 > FlowMusic2API > Gemini Lyria 直连），三通路能力有差异，见各参数说明。",
  args: {
    probe: {
      type: "boolean",
      required: false,
      description:
        "true=只做免费通路健康探针（不生成音乐、不花钱、不需要 prompt），返回每条通路状态：ready 可用／needs_human_login 需人工登录／config_disabled 配置未启用／resource_insufficient 资源不足（显存/GPU 忙/配额）／unreachable 服务不可达，以及 can_generate_vocal_song、can_generate_instrumental、first_ready、human_actions 与各通路 capability 备注（YuE2 可用时此处给单首时长上限，或说明上游未回报预算）。写歌词前先调一次。",
    },
    prompt: {
      type: "string",
      // 生成时必填（execute 内校验并回 invalid_args）；schema 放宽是为了 probe=true 可单独调用。
      required: false,
      description:
        "生成时必填（probe=true 时可省略）。风格描述按六层公式写全（顺序即优先级）：GENRE（流派/年代或场景，放最前）→ 决定性参数（BPM／调性 key／和弦进行／段落结构，写在最前 1/3，如 96 BPM, key of C major, Am7-Dm7-G7-Cmaj7, verse-chorus-bridge）→ MOOD（≤2 个相容情绪词）→ INSTRUMENTATION（2-3 件乐器＋演奏法）→ VOCAL（谁唱/怎么唱）→ PRODUCTION（年代/混音/空间等修饰性描述，放最后、可被裁）。例：cinematic orchestral, 90 BPM, key of D minor, mood: heroic and sweeping（速度／调性紧接流派，写在最前）。可写 [Verse]/[Chorus] 段落标签或 [0:00 - 0:10] Intro: 时间戳结构。长度硬上限（runes）：FlowMusic2API 无歌词单行分支 220／带歌词保版面分支 3000、YuE2 600、Lyria 无限制；超限时规则层整句丢低优先的描述性修饰子句（保住 GENRE 与前置的 BPM／调性／和弦进行／段落结构，绝不切半句），丢掉的层见回执 prompt_director.truncated/warnings。注意：时间戳结构只对 Gemini Lyria 直连通路生效，FlowMusic2API 与 YuE2 通路不认时间戳（会被剥除并如实标注）。",
    },
    lyrics: {
      type: "string",
      required: false,
      description:
        "自定义歌词（可选）。支持 [Verse]/[Chorus]/[Bridge] 段落标签或 [0:00 - 0:10] 时间戳结构；中文歌词一律简体（用户给繁体中文歌词先转成简体再送，不写繁体字形）；非中文歌词按内容语言（英文歌英文、日文歌日文），不强制汉化。YuE2 通路要求自定义歌词带 [Verse]/[Chorus] 段落标签（上游语法必需）。时间码只有 Gemini Lyria 直连认：FlowMusic2API 与 YuE2 会剥除歌词里的 [0:00 - 0:10] 时间码（段落标签原样保留），并在回执 notes 用大白话说明。缺省=纯器乐（Instrumental only, no vocals）。",
    },
    duration_hint: {
      type: "string",
      required: false,
      enum: ["full", "clip30"],
      description:
        "full=整歌（约 2.5 分钟），clip30=快速生成（上游无 30 秒片段模式，实际为快速整歌）。默认 full。YuE2 通路无时长控制（成品长度由模型决定，回执 duration_seconds 为上游自报实测值）且不支持 clip30——传 clip30 会直接报错，请改传 full。",
    },
    reference_images: {
      type: "string",
      required: false,
      description:
        "MV 分镜/参考图（可选，图生乐）：base64（允许 data: 前缀），多张用英文逗号分隔，最多 10 张。注意：仅 Gemini 直连通路支持，FlowMusic2API 与 YuE2 通路会忽略并如实标注（YuE2 上游不支持图生乐）。",
    },
    abc: {
      type: "string",
      required: false,
      description:
        '自备/已编辑的 ABC 乐谱（可选，仅 YuE2 通路有效）：传入即以该乐谱为约束重新渲染（乐谱编辑工作流——改和弦/改谱 → 新录音）。来源通常是上一次 music_gen 回执的 score_abc（可先编辑再传回）。编辑建议守住不变量：vocal/instrumental 旋律音符、时值、小节线、段落顺序、tempo（除非刻意改，改 tempo 用显式声明）。注意：编辑不是降噪重绘——不保证相同演唱/音色/波形，每次编辑都会生成新版本；其他通路（FlowMusic2API／Gemini Lyria）不认乐谱，传了会直接报错（不静默忽略）。',
    },
    cot_mode: {
      type: "string",
      required: false,
      enum: ["full", "melody"],
      description:
        'YuE2 乐谱约束模式（可选，默认 full，仅 YuE2 通路有效）：full=旋律与和弦都被乐谱约束（编辑工作流）；melody=只约束旋律，伴奏自由适配新风格（翻唱/改编模式）。melody 模式必须传 abc（其语义就是「以 abc 为旋律骨干」）。仅在与 abc 搭配时有意义；无 abc 时保持默认 full。注意：传 source_audio（翻唱）时本参数缺省自动取 melody（官方翻唱模式），显式传 full 则保留原曲和声重渲染。',
    },
    source_audio: {
      type: "string",
      required: false,
      description:
        "翻唱工作流：源音频 base64（可选，可带 data: 前缀，仅 YuE2 通路有效）。传入即走翻唱——先自动扒谱（SheetSage2 从源音频提取旋律骨干 ABC，回执 transcribed_abc_sha256/transcribe_warnings 如实回报），再以 prompt 描述的新风格重新演绎（cot_mode 缺省 melody＝官方翻唱模式：只保留旋律骨干，伴奏自由适配新风格）。与 abc 参数互斥（一个要现扒谱、一个已自备乐谱，同传报错）。其他通路（FlowMusic2API／Gemini Lyria）不支持翻唱，传了会直接报错（不静默忽略）；扒谱/生成失败也直接报错不回落（翻唱语义不可被无谱通路顶替）。",
    },
  },
  async execute(rawArgs, context) {
    try {
      if (rawArgs.probe === true || rawArgs.probe === "true") {
        const report = await probeMusicChannels()
        const summary = report.channels.map((c) => `${c.channel}=${PROBE_STATUS_LABEL[c.status]}`).join("，")
        return ok({
          title: report.can_generate_vocal_song
            ? `音乐通路可用（${report.first_ready}）`
            : report.can_generate_instrumental
              ? `仅纯器乐可用（${report.first_ready}），不能出人声歌曲`
              : "音乐通路全部不可用",
          mode: "probe",
          summary,
          ...report,
          hint: report.can_generate_vocal_song
            ? `可以写歌：生成会先走 ${report.first_ready}。${report.channels.find((c) => c.channel === report.first_ready)?.capability ?? ""}`
            : report.can_generate_instrumental
              ? `现在只能出纯器乐（无人声）。需要人声歌曲先别写歌词；把 human_actions 原样告诉用户。纯器乐/BGM 需求可直接生成。`
              : `现在做不出带人声的歌，先别写歌词；把 human_actions 原样告诉用户，等其处理后再探针。`,
        })
      }
      const prompt = asString(rawArgs.prompt)
      if (!prompt) {
        return fail("invalid_args", "缺少必填参数 prompt：需要风格+情绪描述（genre/BPM/调性/编制/氛围）。")
      }
      const lyrics = asString(rawArgs.lyrics)
      // 歌词时间码剥除（2026-10-04 F-06）：FlowMusic2API／YuE2 不认 `[0:00 - 0:10]` 时间码
      // （只认 `[Verse]`/`[Chorus]` 段落标签），剥除后如实回报；Lyria 直连认时间码，原样保留。
      // 与 style prompt 同一政策（段落标签保留、文字不动）。
      const rawLyrics = lyrics ?? ""
      const strippedLyrics = stripLyricsTimestamps(rawLyrics)
      const lyricsForChannel = (channel: "yue2" | "flowmusic" | "lyria") =>
        channel === "lyria" ? rawLyrics : strippedLyrics.lyrics
      const durationHintRaw = asString(rawArgs.duration_hint) ?? "full"
      if (durationHintRaw !== "full" && durationHintRaw !== "clip30") {
        return fail("invalid_args", `duration_hint 只接受 "full" 或 "clip30"，收到 "${durationHintRaw}"。`)
      }
      const toolPrompt = buildToolPrompt(prompt, Boolean(lyrics))

      // ── 乐谱编辑参数（片 K，2026-09-19）────────────────────────────────────
      // abc＝自备/已编辑 ABC 乐谱（官方 editing.md 语义：同生成器、带修改后的乐谱再渲染
      // 一次）；cot_mode＝乐谱约束模式（full=旋律+和弦都约束／melody=只约束旋律、伴奏
      // 自由适配＝翻唱模式）。仅 YuE2 通路有效——其他通路不认乐谱，如实报错不静默忽略
      //（静默忽略＝让 agent 误以为带谱语义已生效，比报错更糟）。
      const abc = asString(rawArgs.abc)
      // ── 翻唱参数（片 O，2026-09-19）────────────────────────────────────────
      // source_audio＝源音频 base64（允 data: 前缀，同 reference_images 处理模式）。
      // 语义＝翻唱：先 transcribeYue2Score 扒出旋律骨干 ABC，再带 abc 生成。
      // 互斥：source_audio 与 abc 同传＝语义冲突（一个要现扒、一个已自备）→ invalid_args。
      const sourceAudioRaw = asString(rawArgs.source_audio)
      if (sourceAudioRaw && abc) {
        return fail(
          "invalid_args",
          "source_audio 与 abc 互斥：source_audio＝现场扒谱（从源音频提取旋律骨干），abc＝已自备/已编辑的乐谱，两者同传语义冲突。请只传其一。",
        )
      }
      // cot_mode 缺省：常规＝full；翻唱（带 source_audio）＝melody（官方翻唱模式：
      // 只保留旋律骨干、伴奏自由适配新风格）；显式传 full 也允许＝保留原和声的重渲染。
      const cotModeExplicit = asString(rawArgs.cot_mode)
      const cotModeRaw = cotModeExplicit ?? (sourceAudioRaw ? "melody" : "full")
      if (!YUE2_TOOL_COT_MODES.includes(cotModeRaw as Yue2CotMode)) {
        return fail(
          "invalid_args",
          `cot_mode 只接受 "full" 或 "melody"，收到 "${cotModeRaw}"（"off" 不对工具开放：工具语义永远要求乐谱回执 score_abc，off 模式不回乐谱且对编辑工作流无用）。`,
        )
      }
      const cotMode = cotModeRaw as Yue2CotMode
      // melody 无乐谱来源（既无 abc 也无 source_audio）＝语义不成立；带 source_audio
      // 时 abc 由扒谱补上，不适用本规则。
      if (cotMode === "melody" && !abc && !sourceAudioRaw) {
        return fail(
          "invalid_args",
          'cot_mode="melody" 必须搭配 abc 参数：melody 模式的语义就是「以传入的 ABC 乐谱为旋律骨干（伴奏自由适配）」，没有 abc 无意义。请补传 abc，或改用默认 full。',
        )
      }
      const abcSha256 = abc ? createHash("sha256").update(abc, "utf8").digest("hex") : null

      // 通路选择（2026-09-09 换血，2026-09-18 加第三通路）：env YUE2_MODAL_ENDPOINT 非空
      // → YuE2 Modal（白盒 ABC 乐谱、cot、无时长控制）；否则 FLOWMUSIC2API_URL 配置即走
      // FlowMusic2API（lyria 整歌 / lyria-fast 快速；上游无 30s 片段模式，clip30 映射快速别名）；
      // 两者皆未配置回落 Gemini Lyria interactions 直连。三路返回形状同构
      // （audioBase64/mimeType），下游上传/ffprobe 实测/交付形状完全不变。
      // 2026-09-19 加失败回落：YuE2 服务跑在笔电上（反向隧道进 VPS），笔电关机/隧道
      // 断线时 generateYue2Track 抛错（网路层/超时/非 2xx）→ 自动回落 FlowMusic 完整
      // 重跑一次，音乐管线不因单通路故障而坏（见下方生成段）。
      // YuE2 是「歌词→整歌」：纯器乐（无歌词）或 30 秒短档它兑现不了（上游 400「lyrics must be
      // a non-empty string」／无时长栏位）。有别的通路在场就让位给它们，而不是先撞 YuE2 再报错
      //（2026-09-29 e2e：「咖啡店背景音乐 30 秒」两种都撞墙）。abc／翻唱委托仍必走 YuE2。
      const otherMusicChannel = isFlowMusic2ApiEnabled() || hasGeminiStudioApiKey() || Boolean(process.env.GEMINI_API_KEY?.trim())
      const yue2Enabled =
        isYue2ModalEnabled() &&
        (abc !== undefined || sourceAudioRaw !== undefined || !otherMusicChannel || (Boolean(lyrics) && durationHintRaw !== "clip30"))
      const flowMusicEnabled = isFlowMusic2ApiEnabled()
      const flowMusicModel = FLOWMUSIC_MODELS[durationHintRaw === "clip30" ? "clip30" : "full"]
      const lyriaModel = durationHintRaw === "clip30" ? LYRIA_MODELS.clip30 : LYRIA_MODELS.full

      // YuE2 无 30 秒短档模式（冻结合约根本没有时长栏位）：如实报错，绝不静默生成整歌再
      // 假装是 30 秒。理由：clip30 的委托语义是「短档对时」（MV 对点），上游产不出来；
      // 硬吞会让回执 duration_hint=clip30 与实际成品互相矛盾＝说谎，且 YuE2 一次生成是
      // 分钟级，先失败比烧完才报废便宜；hint 直接给可执行的下一步。
      // 注意：这是参数性 fail（委托本身不合法，我们在上游前自己拒的），不是 YuE2 服务
      // 抛错——不触发回落，语义与「隧道断线」不同。
      if (yue2Enabled && durationHintRaw === "clip30") {
        return fail(
          "unsupported_duration_hint",
          'YuE2 通路无 30 秒短档模式（上游契约无时长控制）；请改传 duration_hint="full" 走整歌，或改用 FlowMusic2API／Gemini Lyria 通路。',
        )
      }

      // 带 abc 的委托在非 YuE2 通路＝通路能力不匹配，如实报错不静默忽略（clip30 同款
      // 参数性 fail 语义：委托本身带了通路兑现不了的语义，上游前自己拒，不触发回落）。
      if (abc && !yue2Enabled) {
        return fail(
          "unsupported_channel_for_abc",
          "abc（ABC 乐谱重渲染）仅 YuE2 通路支持，当前环境未启用 YuE2（YUE2_MODAL_ENDPOINT 未配置）。请去掉 abc 后重试，或等 YuE2 通路可用。FlowMusic2API／Gemini Lyria 不认乐谱，静默忽略会让乐谱语义凭空丢失。",
        )
      }

      // 带 source_audio 的委托（翻唱）同样仅 YuE2 通路：扒谱（/transcribe）与带谱生成
      // 都是 YuE2 服务能力，其他通路兑现不了「以这首歌的旋律骨干重新演绎」的语义。
      // 同款参数性 fail（上游前自己拒，零上游请求，不触发回落）。
      if (sourceAudioRaw && !yue2Enabled) {
        return fail(
          "unsupported_channel_for_source_audio",
          "source_audio（翻唱：扒谱＋重演绎）仅 YuE2 通路支持，当前环境未启用 YuE2（YUE2_MODAL_ENDPOINT 未配置）。请去掉 source_audio 后重试，或等 YuE2 通路可用。FlowMusic2API／Gemini Lyria 无扒谱能力，静默忽略会让翻唱语义凭空丢失。",
        )
      }

      // 确定性规则层（Music Prompt Director）必须是送上游前的最后一关：
      // 先让 buildToolPrompt 组出含器乐声明的完整文本，再过 director 做伪标签/时间戳
      // 剥除、六层补齐与长度上限——220 runes 上限必须把器乐声明等所有字元算进去，
      // 提前过 director 会让后加的声明把长度顶爆（且 strip-timestamps 只认 flowmusic/yue2）。
      let directorChannel: "yue2" | "flowmusic" | "lyria" = yue2Enabled
        ? "yue2"
        : flowMusicEnabled
          ? "flowmusic"
          : "lyria"
      const initialLyriaInstrumental = directorChannel === "lyria" && !hasGeminiStudioApiKey()
      let directed = directMusicPrompt(initialLyriaInstrumental ? buildToolPrompt(prompt, false) : toolPrompt, {
        channel: directorChannel,
        hasLyrics: initialLyriaInstrumental ? false : Boolean(lyrics),
        durationSeconds: durationHintRaw === "clip30" ? 30 : undefined,
      })
      let finalPrompt = directed.prompt

      const imagesBase64 = (asString(rawArgs.reference_images) ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "")

      // ── 翻唱：先扒谱（片 O，2026-09-19）──────────────────────────────────
      // source_audio → transcribeYue2Score 得旋律骨干 ABC（melodyOnly=true 与 cot=melody
      // 语义对齐）。扒谱抛错（含 422 abc_missing 确定性失败）→ 带专属错误码 fail，
      // **不回落**（翻唱语义不可被无谱通路顶替，同带 abc 不回落的诚实铁律）。
      let effectiveAbc: string | undefined = abc
      let transcribedAbcSha256: string | null = null
      let transcribeWarnings: string[] | null = null
      if (sourceAudioRaw) {
        let transcribed: Awaited<ReturnType<typeof transcribeYue2Score>>
        try {
          transcribed = await transcribeYue2Score({
            audioBase64: stripDataUrlPrefix(sourceAudioRaw),
            melodyOnly: true,
          })
        } catch (e) {
          if (e instanceof Yue2TranscribeError) {
            // abc_missing（422）＝这份音频扒不出旋律，重试同一份不会变好，hint 如实说。
            return fail(
              e.code,
              e.code === YUE2_TRANSCRIBE_ABC_MISSING_CODE
                ? `翻唱扒谱失败（源音频中找不到可提取的旋律素材，服务端 422 abc_missing——确定性失败，换源音频或改传 abc，勿重试同一份音频）：${e.message}`
                : `翻唱扒谱失败（/transcribe）：${e.message}`,
            )
          }
          throw e
        }
        effectiveAbc = transcribed.abc
        transcribedAbcSha256 = createHash("sha256").update(transcribed.abc, "utf8").digest("hex")
        transcribeWarnings = transcribed.warnings
      }
      // 实际送生成的乐谱指纹：带 abc＝委托谱；翻唱＝扒谱产物（与 transcribed_abc_sha256 同值）。
      const effectiveAbcSha256 = effectiveAbc
        ? createHash("sha256").update(effectiveAbc, "utf8").digest("hex")
        : null

      // ── 生成＋失败回落（2026-09-19）────────────────────────────────────────
      // yue2 启用且 generateYue2Track 抛错（网路层/超时/非 2xx）→ 若 FlowMusic 已配置，
      // 回落走 generateFlowMusicTrack 完整重跑一次；回执 channel 用实际通路字串，
      // additive 加 fallback_from/fallback_reason。回落时 prompt 必须用 flowmusic 通道
      // **重新过 director**（yue2 与 flowmusic 的规则层不同：剥时间戳 vs 压单行/220 上限），
      // 不能拿 yue2 版面直接送 flowmusic——director 是纯函数，可重复呼叫。
      // 2026-09-28 改为整条链回落：YuE2 → FlowMusic → Gemini Lyria 直连（Lyria 仅在
      // GEMINI_API_KEY 已配置时入链）。起因＝漫剧评测实锤：纯器乐 BGM 送 YuE2 被冻结合约
      // 400（lyrics 必填）→ 回落 FlowMusic 又遇帐号鉴权 502 → 整集无 BGM，而 Lyria 金钥
      // 在场却从未被尝试。回落只在「已选通路抛错」时发生，全链失败 fail 带每一路原因。
      // 2026-09-19 片 K 例外：带 abc 的委托 YuE2 抛错**不触发回落**，直接 fail 带原文。
      // 理由＝语义完整性优先：FlowMusic 不认 abc，回落会静静丢失「以这份乐谱为约束」的
      // 委托语义，agent 拿到的是一首语义无关的歌却以为编辑已生效——比直接失败更糟
      //（诚实铁律：能力不匹配要如实报错，绝不静默降级）。
      // 2026-09-19 片 O 同款：带 source_audio（翻唱）的委托抛错同样不回落。
      const hasScoreSemantics = abc !== undefined || sourceAudioRaw !== undefined
      const lyriaEnabled = hasGeminiStudioApiKey() || Boolean(process.env.GEMINI_API_KEY?.trim())
      const channelChain: Array<"yue2" | "flowmusic" | "lyria"> = []
      if (yue2Enabled) channelChain.push("yue2")
      if (flowMusicEnabled) channelChain.push("flowmusic")
      if (lyriaEnabled || channelChain.length === 0) channelChain.push("lyria")
      const channelLabel = { yue2: "yue2_modal", flowmusic: "flowmusic2api", lyria: "lyria_gemini" } as const
      let activeChannel: "yue2" | "flowmusic" | "lyria" = channelChain[0]
      let generated: GenerateYue2TrackResult | GenerateFlowMusicTrackResult | GenerateLyriaTrackResult | undefined
      let fallbackFrom: string | null = null
      let fallbackReason: string | null = null
      const channelFailures: string[] = []
      for (let i = 0; i < channelChain.length; i += 1) {
        const channel = channelChain[i]
        activeChannel = channel
        if (channel !== directorChannel) {
          // 换通路必须用该通路**重新过 director**（各通路规则层不同），director 是纯函数可重复呼叫。
          directorChannel = channel
          // Vertex lyria-002 纯器乐：含人声/歌词措辞的 prompt 会被上游 500「Could not generate audio」，
          // 故落到它时按纯器乐重组 prompt（歌词丢弃会在回执 degraded/ignored_inputs 明说）。
          const lyriaInstrumentalOnly = channel === "lyria" && !hasGeminiStudioApiKey()
          directed = directMusicPrompt(lyriaInstrumentalOnly ? buildToolPrompt(prompt, false) : toolPrompt, {
            channel,
            hasLyrics: lyriaInstrumentalOnly ? false : Boolean(lyrics),
            durationSeconds: durationHintRaw === "clip30" ? 30 : undefined,
          })
          finalPrompt = directed.prompt
        }
        try {
          generated =
            channel === "yue2"
              ? await generateYue2Track({
                  style: finalPrompt,
                  lyrics: lyricsForChannel("yue2"),
                  cot: cotMode,
                  ...(effectiveAbc !== undefined ? { abc: effectiveAbc } : {}),
                })
              : channel === "flowmusic"
                ? await generateFlowMusicTrack({ prompt: finalPrompt, lyrics: lyricsForChannel("flowmusic"), model: flowMusicModel })
                : await generateLyriaTrack({ prompt: finalPrompt, lyrics: lyricsForChannel("lyria"), model: lyriaModel, imagesBase64 })
          break
        } catch (e) {
          if (hasScoreSemantics) throw e
          if (i === channelChain.length - 1) {
            // 单通路失败照旧抛原错误；多通路全灭则每一路原因都要在回执里看得见。
            if (channelFailures.length === 0) throw e
            throw new MusicToolError(
              "music_all_channels_failed",
              `音乐生成全部通路失败：${[...channelFailures, `${channelLabel[channel]}：${yue2FallbackReason(e)}`].join("；")}`,
            )
          }
          channelFailures.push(`${channelLabel[channel]}：${yue2FallbackReason(e)}`)
          if (fallbackFrom === null) fallbackFrom = channelLabel[channel]
          fallbackReason = channelFailures.join("；")
        }
      }
      if (generated === undefined) throw new MusicToolError("music_tool_error", "音乐生成没有可用通路")
      const model: string =
        activeChannel === "yue2"
          ? YUE2_MODEL_ID
          : activeChannel === "flowmusic"
            ? flowMusicModel
            : ((generated as GenerateLyriaTrackResult).effectiveModel ?? lyriaModel)
      const lyriaVertex = activeChannel === "lyria" && (generated as GenerateLyriaTrackResult).backend === "vertex_express"
      const lyriaIgnored = lyriaVertex ? ((generated as GenerateLyriaTrackResult).ignoredInputs ?? []) : []
      // 诚实降级：要人声(有歌词)或要整歌(full)却落到 Vertex lyria-002（纯器乐 30s）＝降级交付，必须明说。
      const degradedReasons: string[] = []
      if (lyriaVertex && lyrics) degradedReasons.push("请求含歌词/人声，但最终通路 Vertex lyria-002 仅纯器乐，成品无人声、歌词未使用")
      if (lyriaVertex && durationHintRaw !== "clip30") degradedReasons.push("请求整歌，但 lyria-002 仅出约 30 秒片段")
      const upstreamUrl =
        activeChannel === "flowmusic" ? (generated as unknown as { upstreamUrl: string }).upstreamUrl : null

      // 音频落盘：复用 gateway 会话上传存储（与 TTS/附件同域）。无 sessionId 时
      // 跳过上传、result 如实带 audio_base64（不伪造 URL）。
      const bytes = Buffer.from(generated.audioBase64, "base64")
      let url: string | null = null
      let uploadCode = "skipped_no_session"
      if (context?.sessionId || context?.uploadOverride) {
        try {
          url = await uploadAudio({ bytes, mimeType: generated.mimeType }, context)
          uploadCode = "uploaded"
        } catch (e) {
          if (e instanceof MusicToolError) {
            return fail(e.code, e.message, {
              title: "音乐生成完成但上传失败",
              model,
              audio_bytes: bytes.length,
              mime_type: generated.mimeType,
              audio_base64: generated.audioBase64,
            })
          }
          throw e
        }
      }

      // 时长：ffprobe 实测优先；不可用回退通路提示值并如实标注
      // （YuE2 带上游自报 duration_s＝上游端真量测值 → duration_source=upstream_reported；
      //  FlowMusic2API 带上游 Duration 提示、Gemini 通路按 model_hint → model_hint）。
      // 170/180 = 整歌实测区间 162–182s 的中位，仅为模型提示值非实测
      // （duration_source=model_hint 如实标注，不冒充 ffprobe；YuE2 契约保证回 duration_s，
      //  180 只在该栏缺失时才走到，且照样标 model_hint）。
      // 2026-09-19 回落后这段以 activeChannel 为准（回落成功＝实际通路是 flowmusic，
      //  时长语义照 flowmusic：上游 Duration 提示 → model_hint）。
      const yue2Track = activeChannel === "yue2" ? (generated as GenerateYue2TrackResult) : null
      // 上游自报时长（YuE2 duration_s，>0 才是可用量测值；契约保证有，缺了照样标 model_hint）。
      const yue2Duration = yue2Track?.durationSeconds ?? 0
      const measured = await measureAudioDuration(generated.audioBase64)
      const hintSeconds =
        activeChannel === "yue2"
          ? yue2Duration > 0
            ? yue2Duration
            : 180
          : activeChannel === "flowmusic"
            ? ((generated as { upstreamDurationHint?: number }).upstreamDurationHint ?? 170)
            : durationHintRaw === "clip30" || lyriaVertex
              ? 30
              : 180
      const durationSeconds = measured ?? hintSeconds
      const durationSource =
        measured !== null
          ? "ffprobe"
          : activeChannel === "yue2" && yue2Duration > 0
            ? "upstream_reported"
            : "model_hint"

      // 多候选交付（2026-10-02）：FlowMusic 上游多数回 2 个 clips。主候选照旧走既有
      // url/upstream_url 单数栏位（向后兼容零改动），其余候选经同一上传通路落成平台
      // URL，以 gateway 既已消费的 audios[] 形状 additive 带出（每笔一个 audio.done）。
      // 诚实降级：次候选下载/上传失败只记进 candidate_errors，绝不拖垮主候选交付。
      const flowResult = activeChannel === "flowmusic" ? (generated as GenerateFlowMusicTrackResult) : null
      const candidateErrors: Array<{ candidate_index: number; upstream_url: string; error: string }> = (
        flowResult?.candidateErrors ?? []
      ).map((e) => ({ candidate_index: e.candidateIndex, upstream_url: e.upstreamUrl, error: e.error }))
      // title/sound_prompt（2026-10-03 多 take 偏好闸 additive）：上游 clips[].title 与
      // 回吐的 clips[].sound_prompt 逐候选带出（缺省不带键，既有键零改动），供熵决策层
      // 判「这几版听起来一不一样」。
      const audios: Array<{
        url: string
        upstream_url?: string
        duration_seconds?: number
        candidate_index: number
        title?: string
        sound_prompt?: string
      }> = []
      if (flowResult && url) {
        const primaryCandidate = flowResult.candidates[0]
        // 主候选（index 0）沿用既有 url：同一份位元组不重复上传。
        audios.push({
          url,
          ...(upstreamUrl ? { upstream_url: upstreamUrl } : {}),
          duration_seconds: Math.round(durationSeconds * 100) / 100,
          candidate_index: 0,
          ...(primaryCandidate?.title !== undefined ? { title: primaryCandidate.title } : {}),
          ...(primaryCandidate?.soundPrompt !== undefined ? { sound_prompt: primaryCandidate.soundPrompt } : {}),
        })
        for (const candidate of flowResult.candidates.slice(1)) {
          try {
            const candidateUrl = await uploadAudio(
              { bytes: Buffer.from(candidate.audioBase64, "base64"), mimeType: candidate.mimeType },
              context,
            )
            audios.push({
              url: candidateUrl,
              upstream_url: candidate.upstreamUrl,
              ...(candidate.upstreamDurationHint !== undefined
                ? { duration_seconds: Math.round(candidate.upstreamDurationHint * 100) / 100 }
                : {}),
              candidate_index: candidate.candidateIndex,
              ...(candidate.title !== undefined ? { title: candidate.title } : {}),
              ...(candidate.soundPrompt !== undefined ? { sound_prompt: candidate.soundPrompt } : {}),
            })
          } catch (e) {
            candidateErrors.push({
              candidate_index: candidate.candidateIndex,
              upstream_url: candidate.upstreamUrl,
              error: (e as Error)?.message ?? String(e),
            })
          }
        }
      }

      // 多版本偏好闸（2026-10-03 additive）：≥2 个候选时呼叫熵决策层，把偏好问题带进
      // 回执（键名 preference_question，只在 ≥2 候选时在场；< 2 时回执形状零变化）。
      // 音档已随各 take 的 audio.done 卡交付，问题卡只「指认」；label → 音频 URL 的
      // 对照见 optionTakeUrls，供导演在拿到答覆后翻译成定版 URL。
      const preferenceQuestion =
        audios.length >= 2
          ? buildMusicPreferenceQuestion(
              audios.map((audio): MusicTakeFeature => ({
                url: audio.url,
                candidateIndex: audio.candidate_index,
                durationSeconds: audio.duration_seconds,
                title: audio.title,
                soundPrompt: audio.sound_prompt,
                lyricsEcho: flowResult?.lyricsEcho,
              })),
            )
          : undefined

      // 人话回执（2026-10-04 F-06／220）：把规则层「动了什么」用人能懂的话带出，
      // 不只丢内部 tag（使用者看不到 agent 的 tool part 细节，这条要 agent 能直接转述）。
      const notes: string[] = []
      if (strippedLyrics.hadTimestamp && activeChannel !== "lyria") {
        notes.push(
          "歌词里的时间码（如 [0:00 - 0:10]）这次没有送进模型——当前通路不认时间码，已按段落标签处理（[Verse]/[Chorus] 等原样保留），除时间码外的歌词文字未改动。",
        )
      }
      // 压缩是事实，回执必须由**实际被丢的层**与**最终 prompt_used 的实际内容**反推，
      // 不得写死成功句（2026-10-04 F2：旧版在 genre 被丢、句子被硬截时仍宣称「保住了流派…没有截半句」）。
      if (directed.compressedClauses !== undefined || directed.hardTruncated) {
        const dropped = directed.compressedLayers ?? []
        const kept = describeRetainedParts(finalPrompt)
        notes.push(
          "风格描述超出了当前通路的长度上限" +
            (dropped.length > 0
              ? `，已按优先级整段丢掉了不重要的子句（丢掉的核心子句层：${dropped.join("、")}）`
              : "，且已无更低优先级的整句子句可丢") +
            `，最终 prompt 里保住：${kept.length > 0 ? kept.join("、") : "（无完整子句）"}。` +
            (directed.hardTruncated ? "结尾为硬截，可能被切成半句。" : "其余为整句处理，没有把句子截成半截。"),
        )
      }

      // prompt 链落档（2026-10-04 G1，best-effort）：把「送上游的 prompt」（＝director
      // 后的 finalPrompt，即回执 prompt_used）与「上游回吐的 sound_prompt」逐次写进
      // workspace 既有 outputs/music-prompt-chain.jsonl，使链在回执 part 未必落库时仍可复算。
      const lyricsForLog = lyricsForChannel(activeChannel)
      const lyricsEchoForLog = (generated as { lyricsEcho?: string }).lyricsEcho
      const promptChainRef = await appendMusicPromptChain({
        session_id: context?.sessionId ?? null,
        channel: activeChannel === "yue2" ? "yue2_modal" : activeChannel === "flowmusic" ? "flowmusic2api" : "lyria_gemini",
        model,
        duration_hint: durationHintRaw,
        // 站 1：agent 自己交给 music_gen 的原始 style prompt（director 前）。
        prompt_input: prompt,
        prompt_input_fingerprint: textFingerprint(prompt),
        // 站 2/3：规则层输出（实送上游文本；＝回执 prompt_used）。
        prompt_sent: finalPrompt,
        prompt_sent_fingerprint: textFingerprint(finalPrompt),
        director: {
          channel: directorChannel,
          applied: directed.applied,
          warnings: directed.warnings,
          truncated: directed.truncated,
          layers: directed.layers,
          compressed_layers: directed.compressedLayers ?? null,
          hard_truncated: directed.hardTruncated ?? false,
        },
        // 歌词只落结构（指纹＋段落标签），不落正文。
        lyrics: {
          ...textFingerprint(lyricsForLog),
          sections: Array.from(new Set(lyricsForLog.match(/\[[^\]]+\]/g) ?? [])),
        },
        lyrics_echo: lyricsEchoForLog ? textFingerprint(lyricsEchoForLog) : null,
        // 站 4：上游 clips[].sound_prompt（逐候选；缺省 null）。
        upstream_sound_prompts: audios.map((a) => a.sound_prompt ?? null),
        upstream_titles: audios.map((a) => a.title ?? null),
      })

      return ok({
        title: "音乐生成完成",
        ...(promptChainRef ? { prompt_chain_ref: promptChainRef } : {}),
        ...(url ? { url, path_source: "gateway_uploads" } : { audio_base64: generated.audioBase64, upload: uploadCode }),
        ...(upstreamUrl ? { upstream_url: upstreamUrl } : {}),
        ...(audios.length > 0 ? { audios } : {}),
        ...(preferenceQuestion !== undefined ? { preference_question: preferenceQuestion } : {}),
        ...(candidateErrors.length > 0 ? { candidate_errors: candidateErrors } : {}),
        ...(notes.length > 0 ? { notes } : {}),
        // 通路如实回报实际生成通路（回落时 flowmusic2api＝真的走 flowmusic，不虚报 yue2）。
        channel: activeChannel === "yue2" ? "yue2_modal" : activeChannel === "flowmusic" ? "flowmusic2api" : "lyria_gemini",
        // 回落事实 additive 回报（只在真的发生回落时在场；既有键零改动）。
        ...(degradedReasons.length > 0 ? { degraded: true, degraded_reason: degradedReasons.join("；") } : {}),
        ...(lyriaIgnored.length > 0 ? { ignored_inputs: lyriaIgnored } : {}),
        ...(fallbackFrom !== null ? { fallback_from: fallbackFrom, fallback_reason: fallbackReason } : {}),
        duration_seconds: Math.round(durationSeconds * 100) / 100,
        duration_source: durationSource,
        duration_hint: durationHintRaw,
        model,
        mime_type: generated.mimeType,
        audio_bytes: bytes.length,
        // 白盒乐谱入交付契约的接点（additive 栏位）：YuE2 通路带可编辑 ABC 乐谱，
        // 其余通路固定 null（栏位一律在场，前端/Expert 契约相容）。
        score_abc: yue2Track?.scoreAbc ?? null,
        // 乐谱编辑回执（片 K additive）：实际生效的 cot 模式（仅 YuE2 通路在场——
        // 其余通路无乐谱语义，回报反而误导）＋带谱委托的乐谱指纹（有传 abc 时在场，
        // 长乐谱不重复回传，agent 比对指纹即知编辑版是否被采用）。
        ...(activeChannel === "yue2" ? { cot_mode: cotMode } : {}),
        ...(abcSha256 !== null ? { abc_sha256: abcSha256 } : {}),
        // 翻唱回执（片 O additive）：扒谱产物的乐谱指纹（＝本次送入生成的旋律骨干）＋
        // 扒谱警告如实透传（空数组＝无警告）。仅带 source_audio 的委托在场——
        // 与 abc_sha256 独立：abc_sha256 指委托自备谱、transcribed_abc_sha256 指扒谱产物，
        // 互斥规则保证两者不同时在场。
        ...(transcribedAbcSha256 !== null ? { transcribed_abc_sha256: transcribedAbcSha256 } : {}),
        ...(transcribeWarnings !== null ? { transcribe_warnings: transcribeWarnings } : {}),
        // 上游如实回报的截断资讯（冻结合约 truncated）：只有 YuE2 会有，不静默吞掉。
        ...(yue2Track?.truncated ? { yue2_truncated: yue2Track.truncated } : {}),
        lyrics_echo: (generated as { lyricsEcho?: string }).lyricsEcho ?? null,
        prompt_used: finalPrompt,
        // 规则层如实回报：改了什么/发现什么/丢了什么层，不粉饰（prompt_used 才是实送上游文本）。
        // 回落时 director 以 flowmusic 通道重跑，channel 如实回报实际版面。
        prompt_director: {
          channel: directorChannel,
          applied: directed.applied,
          warnings: directed.warnings,
          truncated: directed.truncated,
          layers: directed.layers,
          // 压缩事实一并透传（2026-10-04 F2）：agent 才判得出是「整句丢子句」还是「被迫硬截」，
          // 不再只能从 truncated 猜。缺省＝null/false（未压缩）。
          compressedClauses: directed.compressedClauses ?? null,
          compressedLayers: directed.compressedLayers ?? null,
          hardTruncated: directed.hardTruncated ?? false,
          // P0-11 结构化校验账一并透传（2026-10-06）：agent/使用者才看得到「BPM 与段落秒数是否
          // 落在小节线上」「声明的段数与给出的个数是否一致」这类可判定结论，而非只有人话 warnings。
          // 输入不足的判据 ok:true 且 detail 写明跳过，不虚报。
          checks: directed.checks,
        },
        reference_image_count:
          activeChannel === "lyria" && !lyriaVertex ? imagesBase64.filter((i) => i !== "").length : 0,
        ...((activeChannel !== "lyria" || lyriaVertex) && imagesBase64.some((i) => i !== "")
          ? {
              reference_images_note:
                activeChannel === "yue2"
                  ? "YuE2 通路不支持参考图（图生乐），本次已忽略"
                  : activeChannel === "lyria"
                    ? "Vertex lyria-002 通路不支持参考图（图生乐），本次已忽略"
                    : "FlowMusic2API 通路暂不支持参考图（图生乐），本次已忽略",
            }
          : {}),
      })
    } catch (e) {
      return toFail(e)
    }
  },
}

/** 情绪契约组装导出（Expert spec 模板用：orchestrator 心意 → 契约 → prompt）。 */
export type { LyriaMusicContract }
export { buildLyriaStylePrompt }

/** harness-tool-registry.ts 登记用 id 元组（同 BLENDER_HARNESS_TOOL_IDS 范式）。
 *  本体已迁到 ./harness-tool-ids.ts（客户端安全），此处 re-export 保持既有 import 者不破。 */
export { MUSIC_HARNESS_TOOL_IDS } from "../harness-tool-ids"
