# 提示词质量全面审计（2026-10-06）

> 范围：AI 助理（Eimu 创作助理，opencode harness）可能接触到的**全部提示词面**。
> 尺子：Claude Code v2.1.88 源码实证基准（本地全量源码 `/home/lenovo/teacher-repo/`，基准摘要 `/tmp/ccref/CLAUDE-CODE-BENCHMARK.md`）。
> 方法：6 路并发只读审计（身份宪法／技能／工具描述／网关注入／生成导演／上下文组装），全部结论带 `档:行` 与逐字证据，orchestrator 抽验复现。

---

## 0. 头条结论

**没有「提示词整体烂掉」这回事**——真正的问题是三类可定点修复的缺陷：**同一约束多处复制后漂移、状态事后打补丁导致自相矛盾、若干「已写好」的提示词层从未接进生产**。

最刺眼的一条：**三层已写好的提示词资产（kunpeng 53KB 知识层、契约机械检查器、视频优化器的 6 条硬规则）在生产上零消费者**，而测试全绿——这正是「守门件不是 oracle」的现场复现。

同时纠正一条流传的错误前提：**线上提示词资产零繁体字**（严格扫描只剩 `外/演/的/系/行` 这类简繁同形字），早前的「野兽帧是繁体」样本是 `BEAST_FRAME_V2=0` 旧单体帧、且早于 2026-09-30 繁转简的历史快照，不是现况。

---

## 1. Claude Code 基准对照：我方已达标 vs 缺口

| 基准机制 | 我方现状 | 证据 |
|---|---|---|
| **B2** 静态/动态边界 + session latch + `DANGEROUS_uncached` 必须写理由 | **已落地** | `deploy-staging/gateway/messages-gw.ts:112-260`，`dangerousUncachedSystemSection` 缺理由会抛错 |
| **B9** 记忆召回条数上限 + 人话新鲜度 | **部分落地** | `memory-recall.ts:35-37`、`:193-196` 已有 ≤5 条 + 「N 天前」过期警示；**但每轮注入的 L0 私有记忆块没有**（见 P0-10 邻域） |
| **B7** 工具结果 50k/100k/单讯息 200k，超限落盘 | **已落地（在另一进程）** | `deploy-staging/opencode-runtime/lib/context-slim-core.ts`（opencode transform plugin），gateway 只做水位校验 |
| **B8** 压缩阈值与摘要角色/旗标 | **由 opencode 拥有** | gateway 仅做在途闸；`context-compaction-toolresult.test.ts` 注记移交 |
| **B1** 常驻提示词不含事故叙事/日期戳 | **未达标** | 见 P1-1：playbook 33 处日期戳、14 处「事故/实锤/血案」 |
| **B3** 条件装配、死指令不上船 | **未达标** | 见 P0-3：路由表仍教直调已被物理裁剪的工具 |
| **B4** 细则外移 + 推/拉双通道 | **部分** | 技能有推（`【可用 skill】`）无「已浮现就过滤」的拉通道 |
| **B5** 子代理提示词极短 | **未达标** | 每次派遣注入 4.9KB 专家宪法 + 任务书模板 |
| **B10** 不写死内部机制、也不假装其不存在 | **未达标** | 见 P0-7：帧满布 `verdict`/`qcSignature`，同时硬禁模型输出它们 |

---

## 2. P0（会打到使用者）

### P0-1 ｜ MCP `quality` 参数静默降级——付费意图落空且不报错
- **尺子**：A10 描述说谎 ｜ **档**：`mcp-server/src/index.ts:44` 声明 `quality: z.enum(["fast","quality"])`；实作 `src/app/api/v1/images/generations/route.ts:259-260` 只认 `"hd"`/`"high"`，其余一律落 `fast`。
- **后果**：模型按描述传 `"quality"` 必被静默降级，用户为品质档付费的意图落空，回执不报错。
- **修法**：两侧收敛到同一真源（路由接受 `"quality"`，或 MCP 枚举改为上游真词汇）。

### P0-2 ｜ 同一工具 `canvas_apply_ops` 三份互相矛盾的模型面描述
- **尺子**：A1 复制漂移 + A10 ｜ **档**：站点宣告层 `src/lib/agent-tool-contract.ts:217` 教「把 add_node 与 connect_nodes 放同一批」；VPS 活本 `deploy-staging/opencode-runtime/tools/canvas_apply_ops.ts:10` 明文「**禁**手拼 add_node＋connect_nodes」；`deploy-staging/vps-tools/canvas_apply_ops.ts` 第三份二者皆无。
- **后果**：模型读到哪份取决于部署面，行为对立；「绕过编译器」与「同批插入」必然有一半场景出错。
- **修法**：canvas 三件纳入机械导出（照 `tools/export-music-tools-staging.ts` 范式），`src/lib` 单一真源，`vps-tools/` 副本删除。

### P0-3 ｜ 注入的 AGENTS.md 仍教主 agent 直调已被物理裁剪的工具
- **尺子**：B3 死指令不上船 ｜ **档**：`opencode-agents.json` 对 orchestrator 标 `image_quote:false`、`music_gen:false`、`timeline_*:false`、`workflow_*:false`；而 `deploy-staging/opencode-runtime/AGENTS.md:112` 仍写「先查证：`image_quote`（免费）拿图片模型清单」，`:54` 路由行仍以直调为主语。
- **后果**：同一 system prompt 内并存「调用 image_quote」与「直接调用会失败」，模型先试直调再失败，浪费回合。
- **修法**：路由表按 cut 集合条件装配——凡工具在裁剪集内即改为「经 Expert 执行」措辞。

### P0-4 ｜ 专家宪法命令每个 Expert「载配方库」，3 个 Expert 根本没有
- **尺子**：A6 悬空指针 + A10 ｜ **档**：`expert/expert-constitution.md` 第三条 1「进 Expert 即载配方库，must-load 常驻」由 `subagent.ts:1371-1383` 注入**每个**子代理；而 `expert/registry-digest.txt` 中 `video-director`／`screenwriter`／`critic` 三行写「配方库 未配置」。
- **加重**：`docs/beast-army-r8-harness-architecture-audit.md:493-494` 实锤「gateway/lib **无任何 skillPaths 消费方**」⇒ 7/7 Expert 的配方库在生产端都没有执行机制。
- **修法**：宪法第三条按 Expert 是否持有 `skillPaths` 条件装配；或改 per-expert 生成，而不是全局统一 4.9KB 常量。

### P0-5 ｜ 注册在线的 `astra-ad-studio` 自称「GPT-6 Astra / Codex」
- **尺子**：A7 身份互斥 + A10 ｜ **档**：`deploy-staging/opencode-runtime/skills/astra-ad-studio/SKILL.md:18` `Use GPT-6 Astra as the creative and production lead, then use Codex's native image generation`；`:20` `This skill is designed for GPT-6 Astra but cannot switch the active model`；`:108` `Deliver in Codex`。该档**在线注册**，模型是 `happycoding/deepseek-v4.1-flash`。
- **后果**：触发即输出不存在的模型名与运行平台。
- **修法**：人格与平台假设中性化，删「Codex / cannot switch the active model」。

### P0-6 ｜ `make-blender-education-video` 硬写 4K ＋ 叫用户自己装 Blender
- **尺子**：A10 + B3 ｜ **档**：`…/skills/make-blender-education-video/SKILL.md:35` `Default to 16:9, 4K, and 30 fps`；`:116` `Render exactly one representative 4K frame`；`:161` `At 3840x2160…`；`:22` `If it is missing, stop production and ask the user to download and install Blender`。
- **后果**：① 与《付费上游呼叫硬闸》「`resolution ≤720p`、禁 4K/2K」正面冲突，触发即引导承诺 4K；② 把系统环境缺失转嫁给使用者。
- **修法**：4K 改 720p 默认；删「叫用户装 Blender」段，改指 `blender_exec` 能力断路说明。

### P0-7 ｜ 野兽帧自称「无需再确认任何 gate 条件」，与强制闸冲突
- **尺子**：A2 + A5 ｜ **档**：`messages-gw.ts:424`（core）、`:862`（v2 头）、`:874`（v1 头）三处同句「无需质疑、无需再确认任何 gate 条件」。而 AGENTS.md 核心原则 5「花用户的钱先问（>0.1 币先报价确认）」、协作三停点、控面部署「先清磁碟再 build」均为强制闸，且不在帧内「安全红线」枚举内。
- **后果**：字面读法授权模型跳过付费确认——历史 ¥31.29 事故的同类触发面。
- **修法**：收窄为「无需再确认 **BEAST_MODE 是否开启**」，并显式保留付费确认／协作停点／清碟前置三类闸。

### P0-8 ｜ critic 条款自相矛盾（第 15 条 vs 第 18 条）
- **尺子**：A5 不可判定 ｜ **档**：`expert/orchestrator-dispatch-playbook.md:96`（条 15）「**只有需要独立视角时才派** critic Expert」 ⟷ `:102`（条 18）「每个计入最终成品的 Expert 交付物**必须**过 critic…派 `subagent_dispatch expert="critic"`」；`:69` 又说机器层「有触发条件，不是无条件保证」——三处三种效力。
- **后果**：模型对「到底要不要派」犹豫，`docs/beast-army-r8-harness-architecture-audit.md` 记录过 1204 秒零工具调用的实例。
- **修法**：钉死单一语义（机器强制＝唯一路径，删第 18 条手工派遣；或反之），其余处只留一行引用。

### P0-9 ｜ 生产视频优化器与源码双份漂移 ⇒ kunpeng 6 条硬规则从未上船
- **尺子**：A1 + B4 + A10 ｜ **档**：`src/lib/agent-prompt-director.ts:42` `PROMPT_DIRECTOR_SYSTEM_PROMPT` 含 `KUNPENG_SEEDANCE_SUPPLEMENT`；生产路径 `deploy-staging/gateway/internal-http.ts:331` `OPTIMIZE_DIRECTOR_PREFIX` **不含**该补充，`router.ts:599/393` 用的是后者。源档自己的注释写「必须与 VPS 保持一致，改一份同步另一份」——现实已漂移。
- **后果**：`realPersonMode=true`、中文分镜格式、`@图片N` 引用、VO 行 vs 画面对白、多主体防双胞胎、官方尾约束——生产视频 prompt 一条都拿不到。而唯一守门件是 `kunpeng-assets.test.ts` 的字符串断言（绿）。
- **修法**：删 gateway 副本，`internal-http.ts` 直接 import 单一真源。

### P0-10 ｜ kunpeng 知识层 53KB ＋ 契约检查器是死码
- **尺子**：A6 + A10 + B4 ｜ **档**：`src/lib/kunpeng-knowledge.ts` 的 `buildKunpengKnowledgeInjection()` 注释自称沿 `sessionDirective → 网关 system 注入` 链路，但全库 grep 只被测试引用，`deploy-staging/` 与任何路由零呼叫点。`agent-prompt-contracts.ts` + `agent-prompt-contract-check.ts` 同样只被测试调用。
- **后果**：整层规范与机械检查器「声称在船、实体没人调」——文档与测试给出假信心。
- **修法**：要么接进注入链路并配一条真路径行为证据，要么删除。

### P0-11 ｜ 音乐链零条可算式验收标准
- **尺子**：A5 ｜ **档**：`music-prompt-director.ts:64-81` 返回 `{prompt, layers, applied, warnings[], truncated, …}`，`warnings` 全是人话串（`:815/:835/:928/:937/:952/:960`），无 `{metric, threshold, verdict}` 结构；`music-tools.ts:1230-1241` 回执同样只透传 prose。
- **后果**：已知事故「146 BPM 下七段落落在 3.04/9.12/6.08/10.95/7.30/10.95 小节＝没一段在拍上」从机制上无法被任何现有判据发现。
- **修法**：加结构化校验账（如 `{kind:"bpm-section-alignment", bpm, sectionBars[], onBeat[], ok}`），至少给「BPM 给定而段落时长与小节网格不符」一条可判据。

### P0-12 ｜ resume 记忆补注路由早退，静默吞掉私有记忆库
- **尺子**：A5 + B9 ｜ **档**：`src/app/api/agent/sessions/[id]/memory/route.ts:83` 已算出 `memoryLibrary`，`:85-87` 因 `!memoryInjection && !activeAssets` 直接 return，**从不发给网关**。对照建新会话路径 `sessions/route.ts:105` 无条件发。
- **后果**：resume/switch 回老会话时，「有私有记忆库、但画像与教训为空」的用户永远召不回记忆，无任何错误提示。
- **修法**：早退判据补上 `memoryLibrary.memory_docs.length === 0 && !memoryLibrary.memory_index_md`，或删早退无条件发（网关对空栏位是无害 no-op）。

### P0-13 ｜ 私有记忆「按字母序截 8」发生在「偏好优先」排序之前
- **尺子**：A12 + A5 ｜ **档**：`src/lib/agent-memory-injection.ts:135-136` `docs.slice(0, MEMORY_INJECTION_MAX_PRIVATE_DOCS)`；排序真源 `agent-memory-store.ts:431` 是 `domain.localeCompare(...)`；网关 `memory-wiring.ts:110-123` 事后才做偏好分区。
- **后果**：私有库 >8 条时，偏好档（`pref-*`）可能因 domain 字母序靠后被静默丢弃——网关的优先级设计被上游拦截点废掉。
- **修法**：cap 移到分区排序之后；两侧 cap 语义合一。

---

## 3. 三类病灶归类

### 3.1 质量退化

- **叙事污染**（A3/B1）：`orchestrator-dispatch-playbook.md` 33 处日期戳、14 处「事故/实锤/血案」（`:59`「78 分钟渠道接入事故 08-29」、`:106`「血案实录」）；`expert-constitution.md` 7/11 条带事故起源；`skills/music-director/SKILL.md` 7 处日期/叙事（`:38/:54/:60/:62`），而它是音乐任务的 must-load。
- **不可判定规则**（A5）：`playbook:33` 「世界第一标尺…对标世界级配乐师」、`:36` 「循环到世界第一标尺通过」——无阈值、无检查动作。
- **每轮常驻的条件性规则**（A4/B3）：`opencode-runtime/AGENTS.md`（38237B，线上 base ≈51.5k token）内含§4.4 钱包预检、§5.5 分镜闸门（仅 ≥3 镜）、§5 附件处理等条件规则。
- **L0 私有记忆块无新鲜度标示**（B9）：`memory-wiring.ts:116` 每条只有 domain/slug/description/body，不带 `updatedAt`；而召回路径已有 `memory-recall.ts:193-196` 的人话警示。L0 是每轮注入、权重最高的通道，却是唯一没有年龄标示的。
- **客户端全史重建无条数上限**（A12）：`use-agent-chat.ts:1212` → `agent-chat-history-normalize.ts:282` 全量遍历；而 localStorage 存档有 `MAX_PERSISTED_ITEMS=80`，两条路径口径不一致。
- **压缩回执残留假阳**（A10）：`music-prompt-director.ts:546` 的 `INSTRUMENTAL_DECLARATION_PATTERN` 会命中补层文案 `:275-282` 自带的 `no vocals`，导致「用户给了歌词、要人声」时回执宣称「保住无人声宣告」。

### 3.2 自相矛盾

- P0-2、P0-3、P0-5、P0-6、P0-7、P0-8 均为跨档或档内直接冲突（见上）。
- **例外套例外**（A2）：`playbook` 同主题补丁链 `R2-0911→R5-0911→R6→R7→R8-0911`；`AGENTS.md §0` 在 `:28/:30/:34` 连打三层「补漏，2026-10-04 F12」；`music-wiring.ts` 内「不要沿用旧专案」四段并存（`:38/:69/:72/:139`）。
- **同一约束多处复制**（A1）：手册第 1 条（`:59`）与第 5 条（`:63`）各自完整重述「预期 N 分钟」首行时限；`messages-gw.ts:469/:505` 再各抄一遍；AGENTS.md「一律简体」在 `:11/:19/:24` 三处重述。且真机制（`subagent.ts:96,141-149`：同步 deadline = `min(2N, 4min)`）与手册渲染的「超 2x 杀线」已脱钩。
- **悬空指针**（A6）：`playbook:26` 「十步长范例已迁出」无目标档；`opencode-runtime/AGENTS.md:55,85,86,185,198,210` 六处指向 `attach/*.md`，而 repo 与镜像内**均无 `attach/` 目录**；`agent-prompt-director.ts:10-11` 引用的 5 个来源路径全部不存在。
- **语言污染残尾**（A8）：`agent-prompt-contract-check.ts:8` 注释自称「繁体注释」范式（正文实为简体）；`mcp-server/src/index.ts:28/38/57/78` 四条工具描述全用繁体（「支援／非同步／回传／音讯／预设」）；`web-search-tools.ts:137` 夹台湾词「程式库」「影音」。
- **繁转简化石**：`messages-gw.ts:284` `(系统注入|系统注入|野兽模式|野兽模式|…)`、`memory-wiring.ts:55-56` `原创|原创`、`subagent.ts:141` `[预预]` 等同项塌成重复的 alternation。

### 3.3 过度耦合、没有分拆

- **两套野兽帧实现**：`src/lib/orchestrator-beast-frame.ts:110` `buildOrchestratorFrame`（注入 playbook 全文）在生产 src **零调用**，线上真源是 `messages-gw.ts:845-871`。同协议两份定义、其一死码。
- **帧声明 `cacheHint:"stable"` 却无 latch**（A9/A10）：`messages-gw.ts:422/856` 标 stable、日志照打 `cache=stable`，但帧实际贴本轮 user 尾端、无 session latch，且 `lastTailPayloadHash` 会被后续 tail payload 覆盖 ⇒ 下一轮同帧 hash 不等、**重贴 6.2k 字进对话历史**，且无尺寸上限。
- **技能层「两棵树」**：仓库根 `skills/`（124 个 SKILL.md、118 个嵌套、0 个 RECIPE.md）与发布真源 `deploy-staging/opencode-runtime/skills/`（20 个顶层 SKILL.md、151 个 RECIPE.md、0 个嵌套）档名约定相反。opencode 递归扫描 `{skill,skills}//SKILL.md`，一旦有人把 repo 树当 harness 源，124 条即刻回灌（旧事故 171 条/57.6KB）。
- **`beast-*` 4 档阶段知识三份并存**：SKILL 版与 `messages-gw.ts:480-489` inline 版逐句相同且已漂移；默认走 v2 inline，skill 版从不载入 ⇒ 改 SKILL.md 不改变行为。
- **六层 style 公式四处重述**：`music-prompt-director.ts:39-43/:107-114`、`music-tools.ts:677` **且** `:690`、`skills/music-director/SKILL.md:54-60`。
- **模式耦合**：`agent-prompt-director.ts` 用 gateway 私有副本而非 import——「为某模型调到极致的 prompt 分段是双面刃」，此处已实际付出代价（P0-9）。

---

## 4. 最值得先修的六条（按性价比排序）

| # | 事项 | 成本 | 收益 |
|---|---|---|---|
| 1 | **P0-1** MCP `quality` 枚举与 routes 对齐 | 改一个枚举 | 消除唯一「付费拿到降级产物且无报错」的静默错 |
| 2 | **P0-12** memory route 早退判据补两个栏位 | 一行 | 恢复「回老会话仍记得你」的核心承诺 |
| 3 | **P0-9** 删 gateway 副本改 import 单一真源 | 一条 import | 生产视频 prompt 立即拿到 6 条硬规则（含 `realPersonMode`） |
| 4 | **P0-6** 4K→720p、删「叫用户装 Blender」 | 3 行＋1 段 | 消除 4K 撞闸返工与环境缺失转嫁 |
| 5 | **P0-3** 路由表按工具裁剪集条件装配 | 文案删改 | 消除「照指引调用却必然失败」的回合浪费 |
| 6 | **P0-4** 专家宪法配方库按 `skillPaths` 条件装配 | 改注入点＋模板分片 | 3/8 域子代理不再被命令去载不存在的配方库 |

---

## 5. 本轮审计未覆盖／待确认

- **线上 vs repo 漂移**：已核 `deploy-staging/gateway/*` 与 `/opt/agent-harness/gateway/*` md5 一致（S4 取证）。但 `deploy-staging/opencode/AGENTS.md`（33438B）是**废弃快照**，其 §0 仍是旧规则「镜像用户语言」，与现版「一律简体」冲突——建议删除以免误当真源。
- **`registry-digest.txt` 是 2026-09-11 过期生成物**：档头日期与内容不符（含晚于该日期才有的 10 件 video-director 工具），且 editor 路径用旧约定。gateway 曾 `readFileSync` 此静态档，动态版 `buildExpertRegistryDigest()` 才是新值。
- **P1-3（客户端全史无上限）／P1-4（孤儿 tool_use 补 is_error）**：后者全仓零实现，但当前无证据表明 opencode 会漏，属可选加固，需先确证再动手。
