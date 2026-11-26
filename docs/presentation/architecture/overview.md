# Emu（eimu.dev）—— 导览式架构全览

> 这是一份「路演」文档。想像你坐在我旁边，我打开电脑，从头到尾跟你讲这个项目是怎么回事。不是技术手册，是我会说的话。

---

## 这是什么

Emu 是一个 AI 绘图平台。你打开它，可以打字出图、打字出影片、用模板批量生成、在画布上改来改去——总之，把你脑袋里的画面变成真的图片和影片。

但这不是那种「AI wrapper」。这背后藏了 8 个子系统，R1 到 R8 轮评测修复，数十小时的打磨。光 Agent 控制系统就经历了 18 个战役阶段、7 种哨兵看门狗、6 种对话状态、3 种权限层。这是一个真实的、上线的、有真实用户在烧钱的生产系统。

你以为我只是个出图网站？打开盖子会吓到你。

---

## 你进站会看到什么

你打开 www.eimu.dev，第一眼是一张 Liquid Glass 卡片——就是那种 Apple 风格的玻璃质感，有折射光、有 Spring 物理弹性、有边缘高光线。这不是贴皮的毛玻璃，这是真折射——`backdrop-filter blur + saturate(180%)` 让 UI 真正折射背后背景的颜色。

卡片正中央是一个 prompt 输入框。「写点什么，然后出图」——这是主动作。

卡片可以翻面。四张脸：generate（生图）、edit（改图）、upscale（放大）、agent（AI 助理聊天）。我们管这个叫「卡片四面」组织原则——使用者要的是卡片换一面，不是换个网站。四种模式共用的是一块底板，同一个高度锁，切换的时候 260ms 散开重组。不跳动、不重排。

你说「我什么都不会写怎么办？」——卡片底部有 AI 引导，停顿 5 秒才弹出提示，不是进站就轰炸你。输入了，有 6 种品质尾缀自动补上、有风格 chip 可以点、有正则帮你推断风格。你打一句「一个女孩在夕阳下跑步」，它会自动补成专业镜头语言。

但这只是第一层。

---

## 四条路，都能到同一张图

你从进站到出图，有四条路可以走。

### 路一：直接出

正面卡片，打字，选模型，点生成。右边出图。最简单，最快。

### 路二：AI 助理聊天

卡片翻到 agent 面，右侧直接常驻一块全屏画布。你打字说「我要一个赛博朋克风格的女孩，在雨中，穿红色雨衣」，AI 助理会理解你的意图，先问清楚参数（「模型用什么？比例 16:9？」），然后出图给你看，不满意继续改。全程不用碰任何下拉选单、滑块、参数——我们管这个叫「许愿式对话」。

助理背后藏著一套四层提示词漏斗（后面会讲），一套三层工具配置（20+ 工具），一套安全策略引擎（deny 表），还有 7 种哨兵保护你不会卡死。

### 路三：模板环形轮播

agent 面初始态，画布空且没对话，浮出一个 3D 环形轮播——八张模范成片卡绕著环旋转，卡面是真 Liquid Glass 玻璃折射，光会随著旋转移动。这不是套件，是手写的二阶弹簧物理。你拖动的时候，阻尼感、磁力落格、收尾的 ~4% overshoot「吻上去」的手感，全都是纯函数算出来的。

你选一张卡，卡面底部有个玻璃 Dock，每个环节是一个圆点——你可以全选、单选、或按住拖过一排。点选完成，卡会弹确认窗「是否使用完整模板开始创作？」。你确认，它会注入首条消息+铺 workflow 节点到画布，然后 AI 助理接手。

这里有个设计细节：送出钮如果你什么都没选，还是可以点——点击会强制播放假鼠标教学，在画面上演示「按住站0 → 拖过站1 → 松开」。我们让它保持 `aria-disabled` 而不是 `disabled`：**保持可点，点击本身就是帮助**。在你卡住的那个瞬间教你，而不是进站时预先轰炸。

### 路四：外部深链回来

你在 /history 历史页看到一张旧图，点「交给 AI 助理继续做」，或者从 wish 插件跳转回来——它会带参数 `?agent=1&q=<半句话>&session=<uuid>`，落地直开 agent 面，话填进输入框。

这条路保证了你永远不会在站内迷路——不论你在哪个入口开始，最终都收敛到同一张卡片上。

---

## 但打开盖子，事情就复杂了

你可能觉得这就是个「AI wrapper」，调个 API 把 prompt 传过去就行了。

那我告诉你几件事：

- 生成一张图，背后有 **15 种 job 状态**、**15 种失败类别**、**4 种计费处置**。
- 同一张图可能走 8 种不同的上游供应商，从 adobe2api、PixAI、metaso、filmera 到 new-api 渠道，每种有自己的一套协议、鉴权、计费方式。
- 我们有 7 种哨兵看门狗，每种都在真实事故中救过生产。有 90 秒的 turn 看门狗、90 秒的错误看门狗、90 秒的中段停滞哨兵——它们的任务是：**如果 AI 助理卡住了，不是让用户等到天荒地老，而是自动把它救回来**。
- 我们曾经一夜之间多扣了用户 3000 倍的钱（计费 bug 把 0.001 币/张的模型扣成 3 币/张）。也发生过扣穿到负数 9.11 币无人拦截（402 事故）。还发生过工作流节点 404 三个月没人发现——因为工具宣告了能力，但引擎根本没有实作。

这些不是 bug，是教训。每一个都长成了系统的一部分。

让我带你一个一个看。

---

## 子系统 1：生成核心管线（generation-core）

这是引擎。所有生成任务的最终落脚点。

### 它是干嘛的

你提交一个任务——不管是图片、影片、还是 workflow——它会进队列、被调度、找供应商、发请求、追踪进度、处理结果、记帐、上传成品。全部非同步，全部事件驱动。

### 为什么它复杂

因为它要处理的状态太多了。一个 job 有 15 种状态：从 `queued` 到 `pending_billing` 到 `processing` 到 `completed` 到 `failed` 到 `billing_unknown`——是的，`billing_unknown` 是一个真实存在的状态，因为我们发现计费确认和非同步生成之间存在时序问题，你必须有个状态来表示「图出来了但钱还没扣清楚」。

失败有 15 种分类：`upstream_4xx`、`upstream_5xx`、`timeout`、`capacity_saturated`、`billing_quota_exhausted`、`content_filtered`、`deadline_exceeded`……每个分类对应一个确定性的决策：重试？换供应商？隔离？还是直接失败。分类器有中文模型欠费检测，有 pixai 的 NoCredits 正则——这些都是被真实事故教会的事情。

### 三层并发控制

同一个 job 可能被多个 worker 抢到——所以我们用三层租约（`SKIP LOCKED`）来仲裁。Worker A 抢到 job 1，锁住，处理；如果 worker A 挂了，job 1 的租约过期，worker B 可以拾起。这不是乐观锁，这是有过期时间的、可抢占的、写到 Postgres 的分散式锁。

### 计费四阶段

钱的问题是整站最敏感的部分。我们有 4 个阶段：**reserve**（预扣）→ **commit**（确认扣款）→ **refund**（退还未用）→ **writeoff**（坏帐冲销）。每个阶段都有 HMAC 签名，每笔帐都有 append-only 事件帐本（禁 UPDATE/DELETE）。我们还有**闸门**（quota precheck）和**投影**（billing projection，把尚未 commit 的 pending 金额也计入可用余额）。

这套系统曾经出过 3000 倍超扣、0 额漏损、145 币扣穿——每一个 bug 都对应一个修复：超扣 → 确认卡幂等锁钮；漏损 → 投影加 failed 分支；扣穿 → midBatchBudgetGate 批间预算闸。

### 失败回调 outbox

上游 callback 可能断线、乱序、重复。我们做了一个 outbox 模式：callback 先写入 `callback_outbox` 表，由 worker 消费，保证 exactly-once 语义。15 分钟内重试，15 分钟后进死信队列人工检查。

---

## 子系统 2：多供应商上游适配层

这是最「脏」的部分。8 种上游，每种有自己的协议、鉴权、限流、帐号管理、错误格式。

### 供应商矩阵

| 供应商 | 协议 | 鉴权 | 帐号池 | 特点 |
|--------|------|------|--------|------|
| **adobe2api** | 自订 HTTP | cookie+refresh token | 住宅代理池 | 最稳定的供应商，但有 IP 风控；我们花了一周才找出那个 408 是机房 IP 问题 |
| **PixAI** | GraphQL | JWT 7天 | Python 帐号池 | 有 Turnstile 验证码，我们用 YesCaptcha 解；帐号要每天签到领免费额度 |
| **metaso** | 自订 HTTP | 固定 key | 没有池 | MiniMax-H3 最便宜渠道，约官方 1/5 价格 |
| **filmera** | 自订 HTTP | 自注册 | 24/7 自愈 | 最复杂的适配器：我们反编译了它的 Next.js Server Action、用 Supabase 管理帐号、做纯 JS 去水印 |
| **new-api** | OpenAI 兼容 | 标准 key | 没有池 | 换血后的中控内核，08-28 把整个计费系统换了 |
| **openai_video** | OpenAI 兼容 | 标准 key | 没有池 | 影片生成走这条路 |
| **sub2api** | 自订 HTTP | 标准 key | 没有池 | 备用，fallback 角色 |
| **cangyuansuanli** | 自订 HTTP | 固定 key | 没有池 | 08-30 才接入的 Seedance 主渠道，淘宝卖家供应商 |

### 路由决策

选哪个供应商不是随机的。我们有双路由表：一个是 `generation-model-catalog`（能力驱动，告诉你哪个模型支援什么解析度、什么品质档），另一个是 `supplier-router`（健康驱动，告诉你哪个供应商现在活著、还有多少额度、排队深度）。

最终的排序键是 `supply_tier` 不是 `priority`——这个我们踩过坑。relay 级供应商永远输给 managed_pool，priority 是无效的。

### filmera 的故事

filmera 是我们最复杂的适配器。它是一个第三方平台，没有公开 API——所以我们做的是：反编译它的 Next.js 前端，找到 Server Action ID，用程式码模拟浏览器行为呼叫它。它的帐号要自己注册、初始化 project 节点、token 会过期要轮换。我们还做了纯 JS 的水印去除（反混合公式，对实心文字无效所以只能「纯插值去水印」）。

这套东西跑在 24/7 自愈架构上：token 自动轮换、context 自动恢复、帐号被封自动换。我们为它写了 `filmera-cleaner.ts` 专门处理水印。

---

## 子系统 3：AI 助理（Agent harness 网关）—— 全站最复杂的

这部分我花最多时间讲，因为它真的复杂。

### 它不是聊天后端

你会觉得「AI 助理就是一个聊天机器人，调个 LLM 就行了」。但我们的 AI 助理能做的事情太多了：生图、出影片、操作画布、管理资产、查报价、读文档、启动工作流、派遣子代理执行任务、甚至写 Python 脚本执行。

它背后是一个完整的分布式系统——不是一个 chatbot，是一个**分散式状态机 + 安全策略引擎 + 微服务网格的混合体**。

### 战役史（R1→R8）：为什么它这么复杂

这不是设计出来的，是被打出来的。我们经历了八轮评测修复战役，每一轮真实用户在真实任务上测，然后被罚俸、被骂、被纠正。

**R1**（08-26）：第一次大明成片测试，6.1/10 罚俸。静默换菜（模型偷偷换了不告诉你）、伪成功（prompt 冒充演算法成功）、黑话泄漏（内部 task_id 跑进对话）、1 币单也走 confirm。修了：turn 30s 心跳、confirm 门槛≥5 币、引擎批并行。

**R2**（08-27）：7.0/10。诚实报错有了、并行有了、心跳有了、退款帧兑现了。新问题：关键句繁体回退。

**R3**（08-28 凌晨）：4.0/10。LLM 卡死+gateway 重启斩 turn、SSE 重试历史重放。修了：**TURN_WATCHDOG_MS 90s 看门狗**、replayBuffer 剥离、N1 redrive 机制。

**R4**（08-28 下午）：5.4/10 罚俸。思维链泄漏正文、条款编号让用户看到、看门狗两个场景缺席（error 状态和 compaction 状态不会触发 watchdog）。修了：英文正文守门行级状态机、**TURN_ERROR_WATCHDOG_MS 90s**、deny 表首成架构约束。

**R5**（08-28 晚）：5.9/10 罚俸，暴君人肉 11 罪状。报价单位错乱（RMB 0.25 应为 5 币/秒）、模板零回馈、表格不渲染、锚定卡「第 4621 张」。修了：**MIDTURN_STALL_MS 90s 中段停滞哨兵**、preflightBudget、videoTierPerSecond、confirm 合并、t2s 守门 469 对。

**R7**（08-29）：6.5/10 罚俸。48h 死线报价=帐单 100 倍偏差、72h 死单、failover 铁律缺失。修了：失败即翻面、**换模请旨+价差**、deadline 3 分钟/展期 15 分钟、VPS 并集合并范式。

**R8**（08-29）：44/100 罚俸→R8.5 复测 5/5 PASS。推理往返慢于执行、question 卡挂死 129s 零帧、awk 硬编码六连败。修了：**run_py 通用执行原语**（特化工具作废）、question 挂起 30s 心跳×N+turn 冻结、45s 静默 notice（45/90/135 递进）。

**五大根因**（08-29）：模型慢、提示词催问、steer=杀掉重开、image_quote 分不清图/视频、abort 当失败展示。全修了。

**deny 表放宽**（08-29）：橘猫事件——因为 `curl*` 双 deny，免费池死路，懒猫模型完全用不了。deny 表从「预设全拒长城」改成「*:allow 45 条只留主机破坏红线」。

**persona 绑模型**（08-29）：发现 persona 只是 prompt 注入，不是真绑模型。b-ai 全灭时主备用同一个供应商，同源全死。修了：efficient→deepseek-v4-flash-vision-exp、thoughtful→glm-5.3-flash reasoningEffort=high，per-message 模型切换。

**session 24h**（08-29）：原先是 30 分钟回收，第二天 session 就空了。修了：idle reaper 只清内存不删 opencode、TTL 30min→24h、GET 懒恢复。

**interaction_mode**（08-30）：协作/预设/自动三档，auto 档 confirm 自动放行但 402 闸不动。

**中控屎山 10 病灶**（08-30）：resolveNodeModel 取首个 config 而非最新、帐户无自愈、0 额漏损。全修了。

### 哨兵体系（6 种）

这 6 个哨兵，是我最自豪的部分，因为每个都是从真实事故里长出来的：

| 哨兵 | 时长 | 侦测什么 | 事故根因 |
|--------|------|----------|--------|
| TURN_WATCHDOG | 90s | turn 全程无进展 | R3 LLM 卡死 |
| TURN_ERROR_WATCHDOG | 90s | 错误状态停滞 | R4 compaction+APIError 停 5 分钟 |
| MIDTURN_STALL | 90s | 工具执行中途死亡 | R5 影片放置 12 分钟 |
| questionHeartbeat | 30s×N | question 挂起+turn 冻结 | R8 question 上游静默 |
| HEARTBEAT_DELAY | 30s | turn 心跳 | R1 零汇报 |
| ACK_DELAY | 15s | 确认延迟 | R4 收敛 |

### 状态机与权限

- **6 种 turn 状态**：active / pending_confirm / pending_question / paused_insufficient_quota / compacting / redrive。每个状态都有对应的哨兵监控。
- **3 种 interaction_mode**：collaborate（每步确认）/ preset（整包授权）/ auto（全自动，扣费确认自动放行但系统级 402 闸不动）。
- **3 层权限策略**：opencode 执行拦截（deny glob）→ gateway 拒单报因（60s 重读同一 opencode.json，改表不用重启）→ AGENTS.md bash 白名单指导。deny 表不是安全边界——它是防注入绊脚线，沙箱可以被 edit+python3 穿透，我们知道这件事。
- **5 个持久化层**：sessions.db / opencode DB / 内存 snapshot / DB 懒恢复 / localStorage 兜底，replayBuffer 200→1000 帧。

---

### 软实力①：提示词与 skill 打磨（四层漏斗）

你可能会说「提示词有什么复杂的，不就是写一段话告诉 AI 怎么做吗？」

但我们有四层。用户只输入一句人话，背后四层自动补齐成工业级 prompt：

**第一层：优化 agent 层**。跑在 VPS gateway 上，用 deepseek 模型，system prompt 是浓缩自 Higgsfield Hell Grind 95 分钟长片 pipeline + Seedance 2.0 官方规则的 PROMPT_DIRECTOR_SYSTEM_PROMPT。这层很强，但有 30 秒超时、要网路。

**第二层：规则层**。`invisible-prompt-director.ts` 里跑的纯函数，同步执行、零成本、零延迟。里面有六槽补全（把用户短 prompt 拆成六个语义槽位补齐）、anti-slop（把 beautiful 换成 striking detail）、homograph 修正（把 shoot 换成 fire 防模型读成第二种物理含义）、情感肌肉化（scared 变成 "jaw clenches, nostrils flare, shallow breath…" 14 种情绪都有对应的物理描述）、age-blind（内容过滤器一读到 minor 就收紧，所以我们用 age-blind 绕过）。

**第三层：隐形引导词**。模板卡有一个 `directive` 栏位，随首条讯息塞进 system，用户看不到。为什么？因为 directive 是「给 agent 的作业指引」——含 template_id、门禁顺序、行为规则这些工程语汇。用户不该读到，也不该被要求理解。卡片文案是给用户看的邀请，directive 是给 agent 的作业指引，两者必须物理隔离。

**第四层：帐户画像注入**。profile（用户确认过的画像）+ lessons（模型从会话提炼的教训，每条带 source_session_id + 摘要，confirmed: true 才进注入集合）。空画像时返回 null 不占上下文，lessons 上限 8 条。

这套体系不是一次建成的。R1→R8 八轮战役，每一步都在打磨：vetting 指令从「信度低就问用户」改成「先开工出骨架，只在最关键参数缺失时才问一次一道」；steer 打断后注入「不要重复上轮已说的话，不要重新开场，即刻按要求干活」；abort 文案从「aborted」改成「已按你的要求中止本轮」（中止≠失败是人话）；question 卡 ≤30 字 + 2-4 选项硬规则（因为出过一次 6 题和空壳卡的事故）。

为什么要把能力做成 skill 而不是写死？因为改 SKILL.md 一行 = 改 agent 行为，不需要重启 harness。而且 skill 可以按需加载压缩上下文——我们把 AGENTS.md 从 299 行/37KB 瘦身到 65 行，把排障配方外移，只留每次会话都改变行为的规则。**砍到 1/3 是禁手，因为底层是 deepseek 不是 GPT-4，行为规则宁多留、知识配方才外移。**

---

### 软实力②：工具配置体系（三层分离武器库）

AI 助理不是只能聊天，它在背后调用 20+ 个工具。这些工具构成了一套三层分离的武器库：

**上层（前端契约层）**：`agent-tool-contract.ts` 定义工具签名、zod schema、能力门禁、审计。每个工具的名字、参数类型、返回值、权限需求，都在这里定义。

**中层（VPS 工具层）**：`.opencode/tools/*.ts` 每个工具独立执行、独立 zod 校验。工具不直接暴露 bash，而是经 opencode 自定义工具调用 + deny 拦截 + 审计日志。

**底层（安全层）**：opencode.json 的 deny 表，定义哪些 bash 命令不能执行。

我们为什么不做一个大 API 给 agent 调用，而要拆成 20 个小工具？因为每个工具可以独立校验、独立控制权限、独立审计。代价是工具数量膨胀快，而且工具间参数契约不一致时 agent 会混淆——image_quote 故意过滤 video 但 description 没说，导致 agent 误判「平台无影片」。我们的解法不是拆防呆，而是新增一个 video_quote 对偶工具。

工具的生命周期是一个事故驱动的演进史：

- image_quote/video_quote/quote_bundle 报价三件套（video_quote 是 08-29 对偶新增的）
- canvas_get_state/apply_ops 画布操作
- workflow_start/connect/update_node/rerun/status 工作流全套（update_node 曾是空壳，08-30 才补路由真可用）
- **run_py 通用执行原语**（R8 新增，取代 doc_struct 特化工具——暴君裁定「通用执行原语 + 库层 + 行为规则」取代特化工具）
- asset_search/get/activate 资产包三件套（08-30 新增）
- subagent_dispatch 派遣子代理

最关键的设计取舍是 deny 表的哲学转向。一开始是「预设全拒 + 冗长白名单 + 内容级扫描」（连 `*|*`、`*&&*`、`*;*` 都整串 deny）。08-29 橘猫事件后——curl 双 deny 让免费池死路，model 完全不能用——我们放宽成 `*:allow` 45 条规则，只留主机破坏红线（sudo/su/chmod/chown/fdisk/mount/rm -rf / 等）。gateway 60s 重读同一文件，改 deny 表不用重启。

计价锚点也经历了三轮修复：R5 gateway 改批量路径、R7 工具层改单节点、R8 确立 pricing-table-is-authority 铁律——价目表是唯一权威，实扣 3 币=计费 bug 不是定价。

发布纪律是踩出来的：opencode 工具新增必 `systemctl restart opencode-server`（工具宿主是 opencode-server 不是 gateway）；工具返回契约必须含 `output:string`（缺了对 undefined 调 split 崩溃）；控制面 VPS 码源比本地 HEAD 新，部署前 md5 对账并集合并。

---

## 子系统 4：无限画布 + 专业工作站 + 领域配方

画布是 AI 助理的「视觉大脑」。助理在聊天里跟你对话，画布上展示它做的东西、让你可以拖来拖去改。

### 画布语义节点系统

10 种节点：Image、Text、Config、Video、Group、CharacterCard、SceneCard、Audio、Prompt、Reference。每个节点有四态生命周期：idle/success/loading/error。

画布操作有 8 种 DSL：add_node、update_node、delete_nodes、connect_nodes、delete_connections、select_nodes、set_viewport、run_generation。这些操作全部是纯函数 reducer 处理的——脱离 DOM 就可以测试，`node:test` 直接测。

### 模板管线四卡泳道

模板展开后，画布上会出现四种卡：头卡（模板说明）、工具卡（可用的工具）、门禁卡（需要用户确认的节点）、生成卡（实际出图的节点）。这四种卡全部盖 `workflow_id`，`replaceWorkflowNodes` 可以泳道级整体替换。

### 专业工作站

三栏布局：左三步（提示词→参考图→参数）+ 右三面板（队列→图库→历史）。工作站入口 2026-08-27 起已经从首页移除了——它现在只做独立产品面。为什么移？因为首页属于「快速出图」，工作站属于「专业创作」，两者不适合放在同一个首屏。

### 领域配方

我们有短剧（17 道确定性门禁 storyboard_qc_17）、试衣（仅 shot_grid_batch 可用，其余 unsupported+notReplacedByPrompt）、小说 IP（带 provenance sha256/license）、电商（翻译层 mapping 到 generation-core）、六槽配方模板 10 个 + 场景模板 14 条 + 风格库 106 条 + 鲲鹏知识注入。

---

## 子系统 5：B 端 API + SKU 售货 + 计费对帐

### B 端业务

B 端客户每天生成 1000 张素材，不透过 UI 跟 AI 助理聊天——他们直接调 `/v1/*` API。他们的 key 叫 biz key，一生只铸一次——sha256 存储，3 层查找（Postgres → Blob → env）。

### SKU 引擎

我们有一套「售货机」系统：SKU 定义（什么套餐、多少钱、多少额度）→ 订单（SKU + 用户）→ 扩展（把订单转成实际的额度增减）。这套系统是 stateless 的——零新表，纯函数 expand。

### 定价 live data 链

价格从 catalog → Blob overrides（不可变路径+15s 快取+3s 超时）→ PricingSync 60s 轮询+visibility 重同步 → usePricingRevision 订阅重渲染。三套餐：梦芽 ¥9.9 / 梦影 ¥29.9 highlight / 梦虹 ¥69。

---

## 子系统 6：鉴权 / 帐户 / 支付 / 管理后台

### 鉴权三层降级

Vercel 端 Postgres 是主要 session store，但冷实例有时连不上——所以我们有三层降级：Postgres → Blob → env（后备）。这就是为什么 B 端 key 偶尔 401——冷实例掉回退层时 Blob 可不可用完全看运气。

### 管理后台

`/admin` 路由，有供应商管理（查各渠道健康/额度/排队深度）、用户管理（查询/冻结/退款）、生成监控（实时任务面板）、事件日志（append-only 帐本查询）。数据来自三处：generation DB（任务状态）、new-api SQLite（余额/key）、agent-harness 日志（会话）。

---

## 子系统 7：站点 UX 与内容/行销面

### 3D 环形轮播（再讲深一点）

这是我最喜欢的元件。不是套件，是手写的 CSS transform + rAF 二阶弹簧物理。

为什么不用指数逼近？指数逼近永远不会 overshoot，末端是爬到位再突然停——这就是停靠生硬的数学原因。二阶弹簧有 ~4% overshoot，会「吻上去」。磁力数学（detent）1.35 保守值——「要的是能感觉卡位阻力，不是手指拖不动」。COMMIT_MIN 0.18 格——传统 0.5 的设计正是「滑了半张又弹回去」的来源。flick 夹在 <1 格，甩动只表达方向不表达翻三张。

WebGL 玻璃折射是真 Snell 折射（IOR 1.47），光随转动移动是判断实体/贴图的首要线索。SDF 场用 squircle 连续场保证无 branch line 穿越图片。

### Liquid Glass 设计系统

我们有三级材质：lg-card（blur 40px）→ lg-float（28px）→ lg-bar（28px）→ lg-sheet（28px 但实际已经降到 28px，规格写 60px——人眼不可辨）。每个 blur 半径都有性能注释——「28px 是本设计语言里验证的上限，半径越大每帧回读重模糊区域越大，中低端 Android 掉帧来源」。

`.lg-ambient` 把 blur 烘进渐变——「观感等价，零合成层」。case-showcase 弃 preserve-3d 改每卡独立 flatten，因为 Safari 会拍平 backdrop-filter 子节点，文字会发虚。

### 设计硬规则

正文不小于 13px（DESIGN.md §4，不可突破）。黑字透明度下限 0.44（测试锁死）。双金色取舍：`--coin-gold #c9a84c` 亮底用、`#FFCE73` 暗底用——「正宗金」让位给暗底可读性。

style-chip 填充 vs 描边的审美判断：「描边胶囊 × 几十个就是分割感非常重的来源——填充让整条控制轨和画质分段控件读成同一族，分组靠留白而不是线。」

---

### 软实力③：入口交互与动效

这部分我想重点讲「减法哲学」——因为我们删掉的东西可能比新增的还多。

**删掉的东西**：/agent 独立页整页删除（改重定向回首页）、撤销条整块删除（「控件上已是现值，再画一遍被动过什么只是噪音」）、六点把手→全选 checkbox（单选转复选）、拖拽把手删除、导航栏「助理」链接删除（AI 助理是卡片上的一个 toggle，不是一个去处）、agent 面底行删除（唯一出口是 Header 收起钮）。每个删除都有裁定理由。

**减法哲学**：壳内不叠卡（lg-card 只准用在彩色页面背景顶层卡，壳内一律 iOS 内嵌面——无边框、无阴影、无 backdrop-filter）；agent 面常驻 5 层（Header → BatchProgress → transcript → 条件卡 → composer），「加新层前先想能不能并进既有层」；reasoning 默认收合；/history 首屏 6→3 层。

**聊天真空期回馈**：呈现问题到 AI 回第一个字之间，我们做了四层：思考三点（错峰 bounce）→ 思维链 `<details>` 串流无正文时自动展开 → 2px 打字游标（outline 画，永不掉行首）→ 屏读器 `role="status"` 播报。往上翻不强拉——自动贴底只在 isNearBottomRef 128px 阈值内发生。

---

### 软实力④：界面设计取舍

这是我学到最多的一课。

**性能是美学的纪律**。`.lg-bar` 的 blur 从规格 48px 降到 28px，理由三段论：「合成器每帧要回读并重模糊的背景区域越大 → 中低端 Android 掉帧 → 0.62 白底观感差异不可见」。`.lg-ambient` 把 blur 烘进渐变，零合成层。case-showcase 为文字清晰宁可手动算 z-index。这些都是「设计师懂渲染管线」的铁证。

**视觉审核闭环**。暴君 2026-08-26 裁定：「不要给我改几个代码然后自我感动，改到视觉模型都觉得无可挑剔为止」。连续六轮自己调参数全被打回——参数正确≠好看。闭环 = 改码 → Playwright 截图 → `read_image.py` 毒舌审核（「你是毒舌总监，逐条缺陷+10 分制」）→ 按批注改 → 再审 → PASS（实例：3→5.5→7.5→8.8→9.6 共五轮）。

**与「禁自我 UI 检查」互补**。功能用 1225 测试自动验证，美学外包视觉模型裁决，工程师只翻译批注——审美裁决权与功能验证权分离。

---

## 子系统 8：部署 / 维运 / 监控 / 上游桥

### 部署拓扑

两朵云。Vercel 跑前端/边缘，VPS 跑控制面/生成器/new-api/nginx。Vercel 的 `beforeFiles` rewrite 把 `/v1/*` 全代理到 VPS，所以 repo 内的 `/api/v1` 路径对 Vercel 而言是死路。改 `/v1` 行为要改控制面并 rebuild+restart nginx。

### 资料库演进（15 个迁移的业务叙事）

从「能出图」到「每一笔钱、每一次失败都有帐可查」：001 任务/供应商/计费全套 → 006 LoRA 收藏 → 007 B 端密钥迁 Postgres（曾因 Blob 被 block 导致 401 事故）→ 012 换血 new-api（biz_key_newapi_token）→ 013 append-only 事件帐本（禁 UPDATE/DELETE）→ 015 writeoff 亏空记帐。

### pixai-pool 帐号池

最独立的自愈系统。Python 写的，跑了 YesCaptcha 解验证码、随机 outlook 邮箱注册、JWT 7 天、每天签到领 10000 点、token 到期前 24h 重登入、生成 GraphQL createGenerationTask 轮询 PUBLIC URL。存储是 pool.json 原子替换（`.tmp` 副档名防写入中断）。bridge 三层重试 + 全局 asyncio 锁 + `/v1/pool-sync` 热替换不需重启。

---

## 所以，复杂度到底在哪

一句话：**四轴同时拉满**。

**第一轴：状态空间**。15 种 job 状态 × 15 种失败类别 × 4 种计费处置 × 4 种 tier × 6 种 turn 状态 × 7 种哨兵 × 3 种 interaction_mode——已经超过单一人心智模型能覆盖的阈值。

**第二轴：并发模型**。三层租约 + SKIP LOCKED 队列 + 分散式限流 + agent 并发上限实测漂移（1→2→5）。

**第三轴：计费闭环**。外部 relay（HMAC）+ 本地 ledger + gate 投影 + zombie 回收，四套路径在一 job 上交错。3000 倍超扣、0 额漏损、145 币扣穿事故皆出于此。

**第四轴：软实力**。提示词四层漏斗 + R1→R8 八轮战役打磨（每条规则附生产事故注脚）；工具配置三层分离 + 20+ 工具由 6 轮事故驱动演进 + deny 表从长城到红线的哲学转向；入口交互四层渐进 + 手写二阶弹簧物理 + 四层真空期回馈 + 强制教学式引导；界面设计取舍（可工程化的 Liquid Glass 美学系统 + 渲染性能量化纪律 + 视觉审核外包闭环 + 减法哲学）。每一轴都有代码基线、测试锁定和真实事故根因，与前三轴正交叠加。

---

## 附录：踩过的坑（你要是改这个专案，先看这几条）

1. `src/components/ProfessionalWorkstation.tsx` **不存在**。真实入口是 `pro-workstation/InvokeInspiredWorkstation.tsx`。2026-08-27 起工作站入口已从首页移除。

2. `src/app/api/v1/*` 真源 = **VPS 控制面**。Vercel beforeFiles 全代理。repo 内的 /api/v1 路径对 Vercel 是死路。

3. **opencode 工具新增后必 restart opencode-server**。工具宿主是 opencode-server 不是 agent-gateway。改 deny 表不用重启，改工具要。

4. `.vercel/output` 残留 = 上传过期 prebuilt，可能覆盖真部署。

5. `channelConcurrency` 硬编码在 seed 工具（metaso=6/pixai=2），改 DB 被 worker 重启冲回。

6. deny 表是**防注入绊脚线不是安全边界**。沙箱可被 edit+python3 穿透。

7. 记忆标记「作废」≠档案可删。scheduler.ts lease、adobe-health.ts、supplier-channels.config.ts、tools/add-supplier-channel.ts、metaso-upstream.ts 全被 worker/adapter 引用。砍前必 `grep -rn` 验证。

8. Vercel 端 `vercel.json` 不要加 crons——Hobby 限每日一次，且 VPS 表它够不到。真实 cron 在 VPS crontab。

9. `job_events.detail` 是 jsonb 包字串，要双重解析。