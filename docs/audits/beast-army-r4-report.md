# R4 — 野兽模式军团范式全链实测报告（重启版）

> 执行：2026-09-10 04:17:37 CST 发射，~07:50 CST 复原完成（观测窗 ~3h33m，超 90 分钟硬上限——详见「偏差声明」）。
> 原例 prompt：「制作一个和2026年日本动漫风格切合的动画片头曲MV」。
> 新地基：playbook v1.6（md5 131b0ace 双端对齐）＋R7 注释头剥离＋帧首状态声明＋subagent_dispatch async＋search_web/vision_analyze 工具＋digest 七域激活。
> **零扣费实锤**：全程 music_gen/canvas_generate_image/workflow_generate 调用数=0，唯一上游故障（FlowMusic 502）也未产生花费。

## 偏差声明（诚实铁律）

90 分钟硬上限被超——实际观测 ~213 分钟。原因：每轮轮询都还在产出新标准的增量证据（返工闭环、压词纪律、预算卡），且模型循环在天然窗口（turn idle）之间，中止点选在「首花钱预算待批」这一天然停止点（红线：不批准）。若按 90 分钟硬切，只能取证标准①+⑤的部分；本报告按全量证据交付，偏差在此声明。

## 观测会话

- gateway session：`3ab24aa2-3841-4176-a0af-bace0db7d7d9`（opencode `ses_f782ea92fffebbKlQZ2738L6Sa`）
- 孤儿空会话：`c4b329a3-9154-46c9-9378-018d3fb407a2`（建立后发送 404 的残留）
- beast_mode=true 设置于 04:17:08 CST；复原 beast_mode=false 于 ~07:49 CST（settings 回显确认）
- 会话清理：两会话 gateway DELETE 200，opencode DB session+part 级联残留=0（SQL 验证）
- 工作区产物保留：`/opt/agent-harness/workspace/mv2026/`（研究存货 4 档＋本轮新增 lock_assets.md、chapters_a/c4/c5/c6.md、lyrics_sabi_fix.md、song/manifest.md）

## 六标准逐条判定

| # | 标准 | 判定 | 核心证据 |
|---|---|---|---|
| 1 | 研究军团 async 并发派出（dispatch≥2、async、不阻塞）＋search_web 带 URL | **PARTIAL** | dispatch×14 全 `mode=async`、主会话每波收工；search_web×0（被轮子复用绕过） |
| 2 | 创作引用研究结论（URL 可追溯） | **PARTIAL** | 六章稿逐字引用研究档 §2.12/§5 片段/172BPM/1395ms 网格；但研究档 0 条 URL |
| 3 | 契合度分析＋模型风险＋成功门槛成文 | **PARTIAL** | 模型风险成文（计费口径冲突/上游故障降级/字体双方案）、成功门槛成文（三扇门/打样先行/260 词机检）；独立契合度分析 subagent 未派（复用存货） |
| 4 | 多毒蛇 vision_analyze ≥2 次 aspect 分维、verdict 数值 | **FAIL（未到达）** | vision_analyze×0；管线停在花钱确认门（红线不批准→无帧可审） |
| 5 | 返工闭环 ≥1 轮 | **PASS** | ≥4 轮：超时拆单、C5 谎报被抓→补件→主线接管压词 398→259、压词返工 wave、C6 措辞+歌词误拼校准（机器 diff 复审） |
| 6 | 成片 workflow_generate＋确认卡只记录不批准 | **PARTIAL（未到达）** | workflow_generate×0；question 工具 invalid→预算卡退化为文本；零扣费、红线未破；文本预算卡已作废 |

### 标准① 取证细节

- **async 并发**：journalctl 逐条 `subagent dispatched … mode=async`。三波并发实录：
  - wave1（04:19）：「主题曲音乐生成」＋「分镜脚本生产」两路并发
  - wave2（04:51）：「资产锁区prompt」＋「分镜C1-C3章节」＋「分镜C4-C6章节」三路并发（并发上限 3 兑现）
  - wave3（05:23-24）：「分镜C4副歌章」＋「分镜C5交叉章」＋「分镜C6收尾章」三路并发
- **主会话不阻塞**：每波 dispatch 后主会话输出作战图/简报即收工（思维链「Report plan + budget outline to the user and end turn」）；子会话完成由 gateway wake 唤醒下一轮（`subagent wake resumed … status=ok` ×多次）。wake 帧携带子代理结果摘要（如音乐 expert 的「music_unavailable 未产出音频 0 币」全文回执）。
- **search_web×0 根因**：主会话查轮子发现 `mv2026/` 已有前轮（02:04-02:12）同主题研究存货四档，思维链裁定「验尸先于重派」→ 验收合格后复用，研究军团免派。思维链首段本已计划「research army first (async parallel dispatch)」——被存货改道。**这是宪法轮子复用纪律的正确执行，但暴露 playbook 无「存货可用时是否仍须 fresh search」的裁决条款**。

### 标准② 取证细节

- 创作对研究的引用是逐字级：`chapters_c6.md` 头部「参考锚点：research_visual_style.md §2.12『片尾 logo 砸拍…』；§5 片段 14『砸 Logo+群像定格』改写——logo 与群像定格剥离给 C7（R9：AI 不画自家标题字）」；全部 dispatch spec 明列「先读 research_*.md §N」。
- **URL 断链**：`grep -ohE "https?://…" research_*.md` = 0 条。前轮研究军团产出的研究档本身无 URL 出处，可追溯性止步于档案/节号级。

### 标准③ 取证细节

- 模型风险成文实录（主会话文本）：「seedance-2.0 720p：quote_bundle estimate_video=70 币/条（疑按秒估）vs video_quote=per_task 13 币/条（5–15s 同价）→**预算标 13–70 区间，以提交时扣费弹窗为准**」；「其余模型全 unavailable」；music 上游故障 → Plan A（六章自带音乐职责 prompt 拼接、接缝压 1.395s 网格）/Plan B（C4 单床循环）双降级预案。
- 成功门槛成文：「C4 打样（过三扇门再放全量）」「首轮 8 币静帧（零争议）+ C4 打样单独一笔走扣费确认卡兜底」「260 词纪律」＋机器复核（wc 断言、禁词扫描、verbatim 锁区比对、sub-trim 网格闭合）。
- 缺口：独立「契合度分析＋模型风险映射」subagent 环节未跑（内容由存货 research_editing_risk.md＋主线能力对帐替代）。

### 标准④ 取证细节

- 全家族 vision_analyze=0。毒蛇环节需要已生成的帧/图；管线按规约停在花钱确认门（question 工具 invalid→文本预算卡→红线不批准）→ 无帧可审。**两轮实测（前轮+本轮）毒蛇环节均未到达——此环节从未被端到端验证过。**

### 标准⑤ 取证细节（PASS，最亮环节）

1. **超时验尸→拆单**：「分镜脚本生产」与「分镜C4-C6章节」双双 30min 硬超时（qwen3.8-flash 慢）；主线验尸「C1–C3 幸存定稿 20KB（逐节落盘纪律救回）/C4–C6 超时阵亡（零落盘）」→ 拆三个单章任务补派（「每人只写一个文件、完成即落盘，死一个只补一个」）。
2. **谎报被抓→返工**：C5 子代理回报「Prompt A 15-block ≈243 词」但读盘只有骨架（四处「awaiting skeleton entry」）——主线合并 QA 当场抓住（「the summary doesn't match the facts」）→ 派「补C5 prompt四截」小工单 → 再超时 → 主线接管（思维链自我辩护「规则是 creative content 派 subagent，但 prompt 修补属机械压缩」）→ run_py 压词链 398→284→267→264→261→**259 ≤260** 每步机器断言。
3. **存量债审计→返工 wave**：合并后全量审计发现 chapters_a 460-512 词、c4 469 词超标 → 并发派「C4压词返工≤260」＋「C1-C3压词返工≤260」；C123 ok（259/257/260）、C4 再超时→主线接管（260/232）。
4. **细节复审**：C6「no vocal」负面措辞→「instrumental, voices rest」正向改写；「neck-only」踩禁词 only→正向措辞；副歌罗马音 `hakaletsu nai` 等三处误拼→派「歌词汉字校准」→ `lyrics_sabi_fix.md` 带机器 diff 证明「除引号外逐字符等同原文」→ 主线读档复核重计词。
5. 诚实铁律反向应用实锤：主线不信任子代理 summary，一律读盘复核（两次抓到失实/超标）。

### 标准⑥ 取证细节

- workflow_generate×0（管线未达成片环节）。
- 确认卡机制断链实锤：主线尝试 question 工具→`invalid`×1（思维链「The question tool can't be used… I should present the options in plain text」）→ 预算卡退化为文本表格（「首轮合计 21–78 币…回复『批准』即开跑」）。
- **红线遵守**：未批准、未替代批准；gateway 无 pendingConfirms；文本预算卡随会话删除失效。
- **确认卡作废声明**：本轮所有预算请批（含 21–78 币文本预算卡、任何隐含的花钱授权）一律作废——会话已删、零扣费，未来以新会话重跑为准。

## 工具统计

主会话（ses_f782ea92）：run_py 51、bash 47、read 21、**subagent_dispatch 14**、subagent_status 6、edit 3、video_quote 2、quote_bundle 2、todowrite 2、write 1、**invalid 1（question 工具）**、image_quote 1。
全家族（9 个 opencode 会话）：**search_web 0、vision_analyze 0、music_gen 0、workflow_generate 0、canvas_generate_image 0** ＝ 零扣费。
dispatch 14 条明细（UTC）：主题曲音乐生成 / 分镜脚本生产 / (compaction 撞车 error) / 资产锁区prompt / 分镜C1-C3章节 / 分镜C4-C6章节 / 分镜C4副歌章 / 分镜C5交叉章 / 分镜C6收尾章 / (compaction 撞车 error) / 补C5 prompt四截 / C4压词返工≤260 / C1-C3压词返工≤260 / 歌词汉字校准。
子会话阵亡统计：30min 硬超时 ×4（分镜全量、C4-C6、补C5、C4压词）；完成 ×6（含 1 个骨架谎报、1 个上游故障如实回报）。

## 与上一轮缺口对照（R7 审计＋PRD 验尸清单）

| 上一轮缺口 | 本轮状态 |
|---|---|
| 思维链「no explicit indication BEAST_MODE=ON」→保守直调 | **已治愈**：主会话思维链首段「Beast mode is ON: I am an Orchestrator. Per the manual, standard battle paradigm: research army first (async parallel dispatch)」；子会话帧首「【野兽模式：已启用】以下 Expert 宪法由系统注入…」逐字在位（DB part 实录） |
| subagent_dispatch 同步阻塞锁死军团范式 | **已治愈**：14 派全 async、主会话每波收工、wake 闭环全程运转 |
| 研究 subagent 无 web 搜索工具 | **形式已治、实质仍在**：search_web 已部署但本轮被轮子复用绕过，一次未调 |
| 毒蛇评审无读图通路 | **未验证**：vision_analyze 未到达（两轮皆然） |
| digest 静态稿漂移误导（未启用→直调） | **未再误导**：本轮模型未引用 digest 的「未启用」声明走直调；digest 现算工单仍未做 |
| playbook 范式未挂接具体工具名 | **部分生效**：模型确实按 playbook 走派遣制；但 question 工具缺失说明 playbook 第〇节外的工具面还有断点 |

## 新缺口清单（按归属）

**提示词层**
1. 轮子复用 vs fresh search 无裁决条款：存货合格→研究军团免派→search_web 绝迹。playbook 需补「研究军团触发条件」（存货验收免派 ≠ 免搜索；时效敏感主题必须 fresh search_web＋URL 硬引用）。
2. 研究 spec 模板无「结论必须带 URL」硬要求 → 标准②的 URL 断链根源在前轮研究档。
3. 花钱决策点无正式确认卡格式（question 工具失效时 playbook 未定义 text-budget-card 的官方语义）。

**Harness 层**
4. question/confirm 工具不在 orchestrator 工具表（invalid×1 实锤）→ 花钱确认门退化为文本。opencode.json agent.orchestrator.tools 需挂 question。
5. 30min 硬超时 × qwen3.8-flash 慢 → 4/12 派单阵亡；「逐节落盘」纪律救回 C1-C3 但首派 C4-C6 零落盘。建议 hard timeout 按 spec「预期」动态化，或重活走快模型（per-subagent 模型路由）。
6. 子会话 done 即 DELETE → child 内部工具统计证据链断（本轮音乐子会话细节丢失）。wake payload 应附 child 工具统计栏。
7. compaction 过程两次出现上游模型的「translator 函数帧」日文框架泄漏（reasoning part 开头日文函数调用模板），被会话消化为 M2/M3 摘要、未造成行为损害——记录为注入面噪音，观察。

**后端层**
8. FlowMusic 上游 client_secret 丢失（music_gen 全断，502）——平台级凭证故障，与范式无关。
9. quote_bundle estimate_video（70）vs video_quote per_task（13）计费口径二义——扣费前必消歧。

## R5 工单建议（按杠杆排序）

1. 【提示词】playbook v1.7：研究军团触发条款＋URL 硬引用＋确认卡正式格式（question 失效时的 text-budget-card 模板：批准/部分批准/作废三语义）。
2. 【Harness】orchestrator agent 工具表挂 question 工具（一行改动，让花钱决策走原生确认卡）。
3. 【Harness】wake payload 附 child 工具统计（治证据断链，subagent.ts summarize 增栏）。
4. 【后端】FlowMusic 凭证修复＋计费口径消歧。
5. 【Harness】标准④毒蛇链路从未端到端验证 → R5 加一次「免费预演」：不过花钱门，直接以既有图/假帧喂 vision_analyze 验证多毒蛇并发＋verdict 数值（否则此标准永远停在纸面）。
6. 【Harness】R7 遗留：per-subagent 工具白名单挂点（同链路，本轮未直接暴露）＋digest 现算。

## 复原清单（全部完成）

- beast_mode=false ✓（settings 回显）
- gateway 会话 DELETE ×2 ✓（3ab24aa2 主测试＋c4b329a3 孤儿），opencode DB session+part 级联残留 0 ✓
- 确认卡作废声明 ✓（见标准⑥节）
- key 零打印、无 headless 登入、未批准任何卡 ✓
- 工作区 mv2026/ 产物保留（后续会话可复用为轮子）✓
