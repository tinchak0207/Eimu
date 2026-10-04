---
name: music-director
description: 音乐 Expert 配方库。触发时机：配乐／主题曲／MV 主题歌／插入曲生成任务（歌曲、器乐 BGM、歌词、音乐 prompt 工程）。音乐生成类请求必载本库，禁止凭记忆写音乐 prompt。
---

# Music Director — SunoForge v3.0 配方库

本目录是音乐域 Expert 的 must-load 配方库，主体为 SunoForge v3.0（MIT）12 档 verbatim 入库（`files/`，不翻译不修改）。目标生成平台为 Google Lyria 3.5（暴君裁定路线），配方同时覆盖 Suno／Flow Music／ElevenMusic／Stable Audio 等。

## 12 档结构（5 CORE 规则层 + 7 DATA 事实层）

**CORE 层（prompting 规则，不随平台版本腐烂）：**

| 档 | 内容 |
|---|---|
| `CORE_00_ENTRY.md` | 入口／preloader／路由／输出协议／信心标记 |
| `CORE_01_STYLE.md` | 六层 style 公式、时间与场景、人设（persona=传记非标签）、跨流派桥接 |
| `CORE_02_LYRICS.md` | 歌词括号规则、段落标签、演唱记号、adlibs、和弦、结构模板 |
| `CORE_03_DIAGNOSE.md` | 坏 prompt 诊断 12 查、修复引擎、失败模式、幻觉构造清理 |
| `CORE_04_WHY.md` | 每条规则的 rationale（教学层） |

**DATA 层（平台事实快照，会过期，更新只换这些档）：**

| 档 | 内容 |
|---|---|
| `DATA_GOOGLE_2026-07.md` | Lyria 3.5／Flow Music：时间戳 prompting、多模态、人声控制 |
| `DATA_SUNO_2026-07.md` | Suno 版本／栏位／slider／声音／stems |
| `DATA_OTHER_2026-07.md` | ElevenMusic／Stable Audio／MiniMax／聚合器比较 |
| `DATA_LEGAL_2026-07.md` | 商用权／版权归属／声音同意／诉讼与平台政策（最快腐烂，使用前必验） |
| `DATA_RECIPES.md` | 45+ 流派／混合／对唱预设（含 BPM/key/slider） |
| `DATA_POSTPROD.md` | 母带链／stems／DAW 交接／响度目标 |
| `DATA_VOCAB.md` | 音色／动态／律动／空间／乐器描述词汇表＋乐理→prompt 翻译 |

## CORE/DATA 分离哲学

平台事实（模型版本、栏位、政策）半年度全烂光，prompting 规则零烂——所以规则沉淀在 CORE、时效事实隔离在 DATA。**更新本库时只换 DATA 档（档名带日期后缀，换血即重命名），CORE 档一字不动。** 每个 DATA 档 frontmatter 带 `valid_as_of` 与过期警示，使用前先核对。

## 通路判定先于配方（2026-09-11 实测校正；2026-09-19 收录第三通路 YuE2）

**先确认这条 prompt 走哪条通路，再决定读哪个 DATA 档**——`music_gen` 回执的 `channel` 栏就是答案：

| 通路 | 触发条件 | 权威档 | `[0:00 - 0:10]` 时间戳 |
|---|---|---|---|
| YuE2（Modal） | env `YUE2_MODAL_ENDPOINT` 已配置即启用，**最高优先**（优先序 YuE2 > FlowMusic2API > Lyria） | 本节 YuE2 段（冻结契约真源＝`music-yue2.ts`） | **无效**：通路不认数字时间码（规则层会剥除）；`[Verse]/[Chorus]` 段落标签**有效**，原样穿透 |
| FlowMusic2API | env `FLOWMUSIC2API_URL` 已配置（YuE2 未配置时的主通路） | `DATA_FLOWMUSIC_2026-09.md` | **无效**：上游把 `:` 换成空格、无任何结构控制、成品长度不受约束 |
| Gemini Lyria 直连 | 未配置时回落 | `DATA_GOOGLE_2026-07.md` | 有效（官方控件） |

YuE2 通路的硬约束（2026-09-19 收录）：**白盒 ABC 乐谱**——回执带 `score_abc` 栏（ABC 记谱法：`K:` 调号、`Q:` 节拍、`V: Vocal` 声部音符序列），是 Expert 交付契约 `melody_notation` 的**真源**（有它勿自行编造音名序列，直接引用其 Vocal 声部；`score_abc` 为 null 时才自行标注）。**无 30s 短档**：`duration_hint=clip30` 会被工具层直接拒（如实报错，不静默生成整歌；要短档走别的通路）。**失败自动回落 FlowMusic**（工具层行为，回执会标明；Expert 不用手动换通路重试）。**一次一请求**：生成是分钟级，禁连发多请求；style prompt 上限 **600 runes**（实作 `CHANNEL_LIMITS.yue2Style`；超限依 CORE_01 权重由低到高整层丢弃，回执的 `truncated` 如实回报丢了哪些层）。

FlowMusic2API 通路的硬约束（实测，详见该 DATA 档）：**无歌词标签时 style prompt 被压成单行、上限 220 runes**；带 `[Verse]/[Chorus]` 标签的歌词走保版面分支（标签保留，**2026-10-03 实测为近乎逐字保留、零扩写**：489→487 字、段落标签全保留，一次呼叫出 181 秒完整版双 take——同词同 style、仅编曲／演唱不同）；BPM／调性／`Instrumental only, no vocals.` 实测有效。`duration_hint=clip30` 不是真短档（上游 `lyria-fast` 与 `lyria` 规格全等，整歌实测 162–182s）。

与 Suno 社群伪标签（`[BPM:120]`、`[Reverb:30%]` 等所有平台都不解析的神话构造）的区分照旧：**凡该通路 DATA 档没实测到的控件一律不写**。

### 时长硬约束前置揭露（硬规则，2026-10-04）

**当前通路没有精确时长控制**：YuE2 无 30s 短档、成品长度由模型决定（回执 `duration_seconds` 为上游自报实测值）；FlowMusic2API 成品实测 162–182s、`duration_hint` 不改变长度（`clip30` 不是真短档）；Lyria 直连的时间戳只控结构不控总长。免费 `probe=true` 体检口径也一致——它只报各通路 status／`can_generate_vocal_song`／`capability` 备注（YuE2 可用时给单首时长上限，或说明上游未回报预算），**不保证精确秒数**，不能拿它当「能压到你要的秒数」的证据。

- **生成前若用户给了明确时长（「要 60 秒」「整一首 90 秒的」）**：必须先向用户交代「本通路不能精确控长，只能整曲生成后再剪一版给你」，并取得同意；用户已明说「你定／直接开工」时，在同一句里明说「我将按此方式执行」，不额外弹卡（照 §3.6 素材齐全不反问）。**禁止先出整曲、事后才补刀**。
- **交付文与主指令「交付文逐句对帐」同口径**：凡交付前剪过，必须显式分列「原版」与「剪辑版」及各自实测时长。数值来源照回执——`duration_source=ffprobe` 才是实测，`upstream_reported`／`model_hint` 一律标提示值，不得写成实测；**剪辑版是通路外产物（run_py/ffmpeg 本地产出），回执里没有它的时长，必须自己对剪辑后的文件 ffprobe 实测后再写**，不许拿原曲时长冒充剪辑版时长。
- 违规／合规样子（判据：生成前有没有把「只能后剪」讲出来，交付里有没有分列两版）：
  - **违规**：开头不说通路无控长；出完 157.97s 直接剪，交付写「**60 秒版已完成**，时长均已核验」。
  - **合规**：开工前「你要 60 秒，但本通路不能精确控长，我会整曲生成后再剪一版 60 秒给你——按这个方式执行」；交付写「你要 60 秒，原曲实测 157.97 秒（本通路不能精确控长）；已从原曲 0:00 起到 1:00 剪出**剪辑版**并用淡出收尾，该文件 ffprobe 实测 60.000 秒」。

## 乐谱编辑与翻唱工作流（2026-09-19 收录；官方 agentic editing 语义，真源＝YuE2 repo docs/editing.md・docs/covers.md）

以下能力**只在 YuE2 通路成立**（其他通路不认 ABC，勿套用）。编辑乐谱时的合法 ABC 记法真源＝`references/yue2-abc-editing.md`（官方 `skills/yue2-music/references/abc-editing.md` Apache-2.0 verbatim 入库），改谱前必查。

### 编辑循环（改既有歌曲：换和声、改段落、二次精修）

1. **生成取谱**：`music_gen` 走 YuE2 通路（cot=full），回执 `score_abc` 即白盒乐谱——音符、和弦、速度、段落顺序全部可读可改。旋律骨干引用它，勿自行编造。
2. **有界编辑**：改 ABC 前先写一个短的改动契约：哪些声部、段落、旋律音高、节奏、歌词、速度是**固定**的，哪些可以动。编辑必须守住不变量（官方原文，逐字）：**vocal/instrumental 旋律音符、时值、小节线、段落顺序、tempo——除非显式宣告改 tempo**。不许无边界地「给我改好听一点」。
3. **重渲染**：改完的 ABC 经 `music_gen` 带 `abc`＋`cot_mode="full"` 重新渲染成新录音（同一生成器，乐谱即编辑介面）。
4. **新版本保存对比**：每次编辑产出**新版本**，原版保留（官方：每次编辑存新版本、原版不覆盖）；回执的 `abc_sha256`（上游 artifacts[] 中 score.abc 的 sha256）可对版本溯源，逐版本记下改了什么。

### 翻唱循环（cover：同旋律骨架，新风格/新歌词/新语言）

1. **取旋律骨架**：从 `score_abc` 取旋律（或官方 SheetSage2 扒谱路径；扒谱错误会带进 cover，用前先审查旋律）。
2. **chord-free ABC**：`cot_mode="melody"` 模式下旋律骨干来自 abc、伴奏自由适配新风格；**melody 模式不自动剥和弦，要 chord-free abc**——带引号和弦符号的 abc 须先剥除和弦再送。
3. **重渲染**：`music_gen` 带 chord-free `abc`＋`cot_mode="melody"`＋新 style＋新歌词。**歌词要对齐旋律的音节数与段落**（换语言时按演唱适配改写，勿逐字直译）；不保留原歌手音色/波形。

### 诚实条款（官方原文语义，逐条适用）

- **乐谱匹配 ≠ 相同演唱/音色**：改完重渲染，波形会变，同一份乐谱两次渲染也不是同一录音；验收要**听成品对比**（尤其被改的小节与其衔接），不是只看乐谱匹配。
- **每版本独立保存**：源 ABC、编辑后 ABC、style、歌词、音频逐版本留档，禁止只留最终版。
- **编辑 brief 有界**：无不变量契约的编辑请求＝不可验收，先补契约再动刀。

## 多版本偏好闸（2026-10-03 收录）

**多版本偏好闸**：`music_gen` 回执带 `preference_question` 字段时——`asked: true` 必须立刻用 `question` 工具把它抬给用户，`question`/`header`/`options` **逐字照抄**回执字段，不得改写、不得增删选项（`都不行，重写` 与 `你替我定` 两条退路已在 options 内）；拿到答复后，用回执里的 `optionTakeUrls`（label → url）把选中的 label 翻译成对应的音频 URL 作为定版，并在交付说明里写明「用户选定的版本」。`asked: false` 时**不要**弹卡，直接采用 `suggestedIndex` 指向的那一版（索引对齐 `audios[]`），并在交付说明里用 `entropy.reason` 的一句话解释为什么不问。

- 每个 take 的音频已随 `audios[]` 各自发一张带播放器的音档卡（`audio.done`），问题卡只**指认**版本（选项 label A/B 对应 take），真正的音档对照靠回执里的 `optionTakeUrls`（label → url）；**禁止**试图把音档塞进 `question` 选项（选项只带 `{label, description}` 文字）。
- `preference_question` 只在 `audios.length >= 2` 时在场；单 clip 回执不含此字段，无需处理。

## 使用规则

1. 音乐生成任务必先载对应 CORE 档（写 style 载 01、写词载 02、产出可疑载 03）＋对应平台 DATA 档。
2. 不确定描述词时查 `DATA_VOCAB.md`，选风格预设时查 `DATA_RECIPES.md`。
3. 生成前跑 `CORE_03_DIAGNOSE.md` 的 audit 检查清单，禁止直接裸 prompt 出曲。

## 授权

SunoForge v3.0（github.com/sanic732/SunoForge）以 MIT License 发布，本库 verbatim 收录并保留归属；每档头部 HTML 注释块记录来源与入库日期。
