# 百合番 OP 会话宝藏挖掘 PRD（唤醒链·能力卡·对位真源）

> version: 1.0（2026-09-20）
> 定性：【能力建设】——保守修复纪律不适用；刀 1/刀 2 动 gateway 生产件，遵守 scp→diff→`deploy.sh` 惯例，**只重启 gateway 不碰 opencode-server**。
> 证据源：eimu.dev 生产会话 `ses_f47dc630effeDRKL3e9nkcDsMH`（2026-09-19 全程 289 则，opencode DB）＋ VPS `outputs/subagent/` 落盘交付。挖掘定案见 memory `yuri-op-treasure-session-mining-0920.md`。

## 0. 一句话终态（可度量）

从该会话暴露的六个断层中，把「靠 subagent 现场撞墙才能发现」的资讯（成品在不在、模型能吃多长的 prompt、真源音频什么节奏）全部前移为机器层可查、可闸、可预检的静态资料，换模/补生/装配三类高频操作不再产生「等了一小时才知道产物早就好了」或「提交前才知道 prompt 超限」。

量化指标：

| 指标 | 现状（该会话实锤） | 终态 |
|---|---|---|
| subagent 产物落盘但唤醒丢失 | 装配方案 23:19 落盘，用户等 ~1h 才知道 | not_found 回应必带落盘路径探测结果 |
| 模型 prompt 上限/时长档/计费口径 | subagent 提交前实测才知 4000 上限/无 30s 档/28 币每秒 | 派遣前机器预检（capability gate），不符即拒派并改派 |
| 音画对位基准 | 设计 176 BPM vs 实产 169.73 BPM，对位表全作废 | 卡点对位表生成前必须吃实测 BPM，偏差 >1% 即标记 |
| 换模后任务书记忆 | compaction 后照抄旧 spec 数字（721 币/30s 档） | spec 内计费/档位数字由机器按当前模型注入，不落死字 |

## 1. 实测基线（该会话原始证据，勿重跑）

- `seedance-2.5-720p`：prompt 上限 **4000 字元**（4000→202、4001→400 `prompt_too_long`）；**28 币/秒**、时长上限 **29s 无 30s 档**；`last_24h=null` 仍标 available。
- 条1（S01–S04）六槽逐字拼装 **4861 字元**（风格锚 ~340 字元 ×4 镜 = 1360 为超限主因，且任务书禁改）；条3a 3703 / 条3b 3559 可过。
- 音频真源（`media-1789821225748-t6qbpy.m4a`，150.4854s）实测 **≈169.73 BPM**（自相关精修 169.728 / comb-filter 169.900），非规格 176；无可量测サビ能量台阶。
- 唤醒链：装配方案落盘 `outputs/subagent/deepseek-v4.1-flash-潮汐绣线OP装配方案.md`（29.6KB/408 行），`subagent_status` 返回 not_found（run 记录过期）但产物在盘上。
- 已修勿重做：402 归因谬误（shuai 欠费人话表，0919 三刀已上线）；B key 绑 117（biz-key-binding-fix-117-0919）。

## 2. 建设能力（三刀）

### 刀 1 subagent 产物探测兜底（gateway，最小刀）

- **痛点**：唤醒通知丢失 + run 记录过期 → `subagent_status` not_found → orchestrator 判「没跑完」→ 用户看到的是死气一小时。
- **后端建设**：`subagent_status`（gateway `subagent.ts`）在 run 记录 not_found 分支增加落盘路径探测——按 run id 前缀扫 `outputs/subagent/<runId前8>*.md`，命中即在回应中带 `artifact_path`＋mtime＋字节数；orchestrator 端 prompt 修一句：「not_found 且带 artifact_path 时，产物已交付，直接验收盘上档案，勿重派」。
- **评测 ruler**：模拟 run 记录过期（删 gateway 记录不删落盘档）→ 问 status → 断言回应含 artifact_path；agent-evolve 真会话验收 orchestrator 不重派。
- **全链生效定义**：一单落盘但唤醒丢失的 subagent，用户在下一轮询问时 30 秒内拿到产物路径，而非重跑。

### 刀 2 模型能力卡＋派遣预检闸（gateway＋catalog，主刀）

- **痛点**：prompt 上限/时长档位/计费口径/交付证据四项全靠 subagent 用真金白银试出来；换模后任务书还带著旧模型数字。
- **后端建设**：
  1. `src/lib/generation-model-catalog/` 每视频模型补四栏：`prompt_char_limit`、`duration_slots`（[min,max] 离散档）、`billing_basis`（per_second/per_task＋单价）、`last_24h_delivered`（探针回填）。首批只补 seedance 家族（4000/29s/28 每秒/已有探针数据），其余模型栏位空＝闸放行（fail-open，同 Jev 刀 2 范式）。
  2. `video_quote`/`subagent_dispatch` 前置预检：spec 内 prompt 拼装长度 > `prompt_char_limit` → 拒派并回「条X超限 Y 字元，建议拆条或锚串减次」；目标时长不在 `duration_slots` → 回可用档位。**只拒派不改写**——创作表述（逐字复用）的取舍留给人/orchestrator。
  3. spec 计费行改机器注入：`subagent_dispatch` 组任务书时计费/档位段按 dispatch 时的 catalog 即时值渲染，任务书模板里删掉死数字（721 币/30s 档这类），compaction 失忆自然失效。
- **评测 ruler**：重放该会话条1 场景（4861 字元 spec）→ 断言预检拒派且讯息含「超限 861」；正常 3703 字元 → 放行。
- **全链生效定义**：换模重推类任务零「提交前才发现 400」、零「任务书币价与实付差 2.36×」。

### 刀 3 音画对位真源前置（expert 培训面＋工具，轻刀）

- **痛点**：对位表基于设计规格 176 BPM 生成，真源 169.73 BPM，整表作废重做；且此断屲在装配阶段（最后一里）才被发现。
- **后端建设**：视频/剪辑类 spec 模板加硬栏 `tempo_source`（enum: `design_spec` / `measured_audio`＋实测值），`measured_audio` 缺实测值或与设计值偏差 >1% 时 catalog/qc 栏标记 `beatmap_at_risk`；editor Expert 的 qc 栏验收规则同步（骨架已在 Jev 刀 1 空壳栏位初筛上，加一条判定）。
- **Agent 培训面**：music/video/editor 三 Expert 任务书模板（`gateway/spec-templates.json`）各加一句：「卡点对位必须以真源音频实测 BPM 为准，设计规格仅作命名参考」。
- **评测 ruler**：拿该会话 m4a（169.73 BPM）重放对位任务 → 断言产出表使用实测值并带 `tempo_source=measured_audio`。

## 3. 排序与依赖

刀 2（能力卡）价值最高——它同时吃掉「4000 上限」「计费口径漂移」「compaction 失忆」三个断层；刀 1 最小可先行（单档改动）；刀 3 依赖 Jev 刀 1 的空壳栏位初筛骨架（已上线）。三刀互不阻塞，可并发。

## 4. 明示不做

- 不做 workflow 模板 vs 直调 API 的路由统一（「没有用模板」争议）——首批已扣费的历史决策不追溯，模板化路由另立 PRD 前先让暴君定产品口径。
- 不重做 402 归因与 B key 绑定（0919 已修）。
- 不改「逐字复用」创作约束本身——预检只陈述冲突（超限 Y 字元），是否拆条/锚串减次由裁决者决定。
