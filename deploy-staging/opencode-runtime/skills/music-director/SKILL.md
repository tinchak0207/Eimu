---
name: music-director
description: 音乐/歌曲/配乐/BGM领域创作入口：参考研究、作曲编曲、演唱设计、版本选择与真实音频交付。生成前载入相关CORE和当前通路DATA。
---

# Music Director — SunoForge v3.0 配方库

本目录是音乐域 Expert 的 must-load 配方库，主体为 SunoForge v3.0（MIT）12 档 verbatim 入库（`files/`，不翻译不修改）。配方覆盖多通路；本次可用模型与能力由工具当前回执决定。

歌词文学创作与精修由 `lyricist` Expert 专职负责，入口为 `.opencode/skills/lyricist/SKILL.md`；仅歌词请求不载本库、不生成音频。完整原创歌曲先完成并验收歌词，再由 music 作曲编曲。用户已有完整原词按授权原样使用；纯器乐无需歌词专家。`files/CORE_02_LYRICS.md` 仅用于成稿的演唱标签与平台格式适配，不替代歌词专家，也不授权改写或压缩正文；第三方原文保持不变。锁定原词若超演唱字数预算，走下方【演唱字数预算闸】的披露制例外——不删改、不拒生成。

## 歌词与演唱设计

阅读完整歌词，交接完整正文和真实文件路径；不从摘要重写。发现具体文学或演唱问题时引用原唱句、说明影响，回交lyricist定向修订。qc与评分卡是文字自评，不能代替真实试听；公开版没有lyrics/catalog，不宣称全库查重。锁定原词逐字保留，不按预算截断。

演唱预算引用确定性工具回执或委托单已有计算结果：目标秒数×BPM÷60×每拍音节数（慢板≤76取0.8、中速77–119取1.0、快板≥120取1.4），建议单曲演唱正文≤400字。目标秒数按本次真实通路能力与用户要求确定；报告字数、预算、比例与计算来源，缺来源标未核算，不心算造数。原创稿超已核实预算时定向调整；锁定原词只披露演唱风险，按已有授权继续，不自动删词或改为快唱。专辑逐首生成，实际时长与用户总长不符时明确说明，不静默缩水。

标签独占一行，完整复唱保留；速度、调性和器乐设计放风格说明。演唱方式由流派与用户目标决定，抒情长音、叙事、说唱均可；不把no rap套到所有歌曲。

## 计费（硬规则，2026-10-10）

音乐生成**按次统一计价：1 币/次**（不分通路、不分 take 数——每次成功的 `music_gen` 调用各计 1 币；`probe=true` 免费不扣，未产出音频不扣）。**生成前先用 `quote_bundle`（`kind:"music"`）报价**，报价与实扣同源（平台目录 `x_coins_per_music`＝平台扣费端点同一权威），实际金额一律以 `music_gen` 回执 `cost_coins` 为准；回执无 `cost_coins` 或带 `charge_error` 时如实转述「本次扣费未完成／费用状态待核」，不得编价、不得默认免费。

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

## 当前能力与创作目标

先读免费probe或已有真实回执的channel/capability，按当前通路载对应DATA；探测不等于已经产出符合要求的音频。历史DATA供参考，冲突以工具当前回执为准。不将旧样本时长或模型名称当固定承诺。

风格描述说明流派、情绪、主导乐器、演唱方式、速度/调性和结构；按作品需要取舍，不强求六层固定句式。重要创作约束写清楚，字符串清洗、通路前置、长度裁剪与失败回落由既有adapter处理；只检查回执中的实际修改/截断，不在脑中模拟适配器。

工具没有精确控长能力时，生成前简明说明将以真实整曲再剪目标长度；当前full/auto或已有任务授权允许自主处理，不重复问开工。原版与剪辑版分别给真实引用和实测时长，注明duration_source；upstream_reported/model_hint标提示值。剪辑用合法现有剪辑专家/工具，不给本域新增run_py权限。

lyrics与风格prompt是独立输入，不把style字符限制误套原词；保留完整原词与标签。上游确实截断时按回执披露并针对缺口恢复，不先自行丢弃。score_abc仅在真实回执存在时引用，不伪造旋律或音符。

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

多个take先比较实际音频与用户目标。网关当前full/auto允许自主选择，直接采用有依据的版本并说明；用户明确要求自己选版本时，或无持续授权且该审美选择确实需要用户决定时，再用回执preference_question选项，按optionTakeUrls关联实际音频。不要仅因asked:true重复询问已授权自主决定的用户，也不冒称用户亲自选定。

- 每个 take 的音频已随 `audios[]` 各自发一张带播放器的音档卡（`audio.done`），问题卡只**指认**版本（选项 label A/B 对应 take），真正的音档对照靠回执里的 `optionTakeUrls`（label → url）；**禁止**试图把音档塞进 `question` 选项（选项只带 `{label, description}` 文字）。
- `preference_question` 只在 `audios.length >= 2` 时在场；单 clip 回执不含此字段，无需处理。

## 使用规则

1. 音乐生成任务必先载对应 CORE 档（写 style 载 01、写词载 02、产出可疑载 03）＋对应平台 DATA 档。
2. 不确定描述词时查 `DATA_VOCAB.md`，选风格预设时查 `DATA_RECIPES.md`。
3. 生成前跑 `CORE_03_DIAGNOSE.md` 的 audit 检查清单，禁止直接裸 prompt 出曲。

## 授权

SunoForge v3.0（github.com/sanic732/SunoForge）以 MIT License 发布，本库 verbatim 收录并保留归属；每档头部 HTML 注释块记录来源与入库日期。
