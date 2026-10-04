# R7 — 野兽模式提示词系统全面探测与根治（注入管线审计）

日期：2026-09-10。暴君裁定「底层有问题，到处都有问题」，本片为注入管线的系统性深挖，不是打补丁。
执行范围：VPS `/opt/agent-harness/gateway/`（index.ts / subagent.ts / expert/）＋本地契约 `src/lib/orchestrator-beast-frame.ts`＋真源 `deploy-staging/expert-gateway/orchestrator-dispatch-playbook.md`。

## 0. 起点根因链（前情，已实锤）

beast ON 发大电影 prompt，模型思维链：「Orchestrator manual says use subagents... But that's gated on BEAST_MODE=ON. There's no explicit indication BEAST_MODE=ON」→ 走保守路径不派研究军团。

## 1. 探测结论（逐项证据）

### 1.1 注入管线全貌

| 注入点 | 位置 | R7 前行为 | 判定 |
|---|---|---|---|
| 主 prompt（playbook+digest） | `index.ts` beast 段（L4183-4208） | `readFileSync` 原文注入，`[playbook.trimEnd(), digest.trimEnd(), "---", system]` 拼接 | **无注释剥离、无状态声明** |
| 子会话任务书（宪法） | `subagent.ts` dispatchAttempt（L280-288） | `readFileSync` 原文前缀＋`---` | **同样无剥离无状态声明** |
| digest 生成器 | 本地 `buildExpertRegistryDigest()` | 头行仅「Expert 注册表（能力断路真源…）」 | 生成器本身**无**元数据头 |
| digest 落地档 | VPS `expert/registry-digest.txt` | 头部第二行「生成日期 2026-09-10（由…生成…）」 | **上传时手加的元数据污染**（生成器从不写这行） |

DB 实锤（修复前）：`opencode.db` msg_087b3a3f（10507 字 system）**开头即 HTML 注释**：`version: 1.5 / source / injection / gate: 仅在 BEAST_MODE=ON 时由 VPS gateway 注入；BEAST_MODE=OFF 本档完全不生效`。开发者元数据对模型是毒：模型看到 gate 声明但 prompt 里无处声明「当前就是 ON」→ 合理怀疑 gate 未满足 → 保守直调。

### 1.2 opencode 显示层副作用（记录，不修）

R1 实锤「上游只回传了参数摘要，可能不完整」＝前端把 dispatch 的 prompt 截断显示给用户（暴君看到的「画面描述」卡）。UI 层问题，运行时语义正确，本片不改。

### 1.3 多系统 prompt 源冲突（四源逐条）

| 源 | 注入位置 | 内容性质 | 冲突点 |
|---|---|---|---|
| workspace AGENTS.md（22874 字） | opencode 原生 instructions | 路由表（生影片→`workflow_*` 直调）、§3.8.6 Orchestrator 律令（必派 subagent、**并发上限 3**）、诚实三铁律、扣费规则 | 路由表教「video 直调 workflow_*」，playbook 教「一切派遣」——模型无裁决依据 |
| playbook v1.6（派遣手册） | system 头部（beast ON） | 军团范式、三军 spec 模板、**常态 ≥3 并发** | 与 AGENTS.md 无职能边界声明；R7 前其 HTML 头还携带 gate 毒点 |
| 宪法（Expert 六条） | 子会话任务书头部（beast ON dispatch） | 诚实铁律/工具域断路/配方优先/记忆纪律/停止上报/自检门禁 | 与 AGENTS.md 诚实条款同源一致，无实冲突 |
| registry-digest | system 头部（playbook 之后） | 七行 Expert 路由表 | 静态稿漂移（见 1.5）；「能力断路真源」声明与物理现状不符（见 1.4） |

R7 前模型的实际裁决规则＝「看 digest 未启用就直调」——静态稿说了算，是错的。R7 后：playbook 头部新增「职能边界」裁决段（见 §2.4）。

### 1.4 诚实铁律冲突点

- 「注册无上游真名可映射（硬映射=造假名）」的行为来源＝宪法第一条（不宣称未验证的成功；橘猫事故/假壳事故逐字在案）＋第五条（停止与上报）。这是**正确泛化**。
- 过度泛化检查：本次实弹思维链显示模型主动查轮子（mv2026 既有研究素材「可复用…指定为 wheel-source」）、派 wave 1、对缺记忆库如实声明「此节豁免」——**没有**泛化成「拒绝一切不确定」。不确定处理遵循「标未实证降级使用」。
- 真正的不实声明在注入帧自己：digest 头行「域外工具不存在于该 Expert 的工具表」——gateway 现阶段无 per-subagent 工具白名单挂点（index.ts 注释自认「物理断路留桩，先靠 prompt 约束」）。属契约宣言而非事实描述，已列入【工具语义】工单不动正文（改了会动 expert-registry 契约，禁碰清单）。

### 1.5 提示词系统结构问题清单（五类归档）

| 类别 | 问题 | 根治状态 |
|---|---|---|
| 【注入管线】 | 两个注入点 readFileSync 原文注入，无剥离、无当前状态声明 | **R7 已修**（index.ts＋subagent.ts 同款 strip＋状态行） |
| 【元数据污染】 | 档头 HTML 注释（version/source/gate）原样进上下文；digest 日期行手加污染 | **R7 已修**（注入前剥离＋digest 头收进注释）；治本＝元数据只存档头注释，注入端永不透传 |
| 【源冲突】 | AGENTS.md 路由表 vs playbook 派遣制无裁决；并发语义两源各说（上限 3 vs ≥3 常态，实为相容但无声明） | **R7 已修**（playbook 职能边界裁决段：执行细节听 AGENTS.md 配方，指挥权听本手册） |
| 【工具语义】 | ① subagent_dispatch 同步阻塞锁死军团范式（R4 实锤）② digest「物理断路」声明无白名单挂点撑腰 ③ 前端 dispatch prompt 截断显示 | ① R6 已修（async=true＋终态唤醒，本次实弹实证 async wave 1 并发 3）② 工单（per-subagent 工具表挂点，动 expert-registry 禁碰范围）③ UI 层记录不修 |
| 【静态稿漂移】 | digest 静态档与 EXPERT_REGISTRY 漂移（R4 实锤「video-director 未启用→直调」误导） | 本片重生成七行全激活（R4 已做）；**治本工单（R5 候选）：gateway 每次注入前从 registry 现算 digest，废静态档** |

## 2. 修复清单（全部落地＋验证）

1. **index.ts beast 段**：新增 `stripProvenanceHeader`（剥档头 HTML 注释，剥后空档同样 503 拒裸奔）＋主 prompt 帧首插入状态声明：「【野兽模式：已启用】…BEAST_MODE 现在就是 ON，以下全部条款立即生效，无需质疑、无需再确认任何 gate 条件。」
2. **subagent.ts 宪法注入段**：同款 strip＋子会话状态声明行。
3. **registry-digest.txt**：「生成日期…」元数据行收进 HTML 注释头（磁盘保留溯源，注入端剥离）。
4. **playbook v1.6 + R7 裁决段**（双端 md5 `131b0ace7fffeffb7eec797f1aa11b07`）：「职能边界（与 AGENTS.md 的分工裁决）…执行细节听 AGENTS.md 配方，指挥权听本手册。」
5. **本地契约同步**：`orchestrator-beast-frame.ts` 导出 `stripProvenanceHeader`/`BEAST_MODE_STATE_LINE`，`buildOrchestratorFrame` 同构（状态行→剥离后 playbook→digest→---→原文）；测试 8/8 绿（含 gate 元数据绝迹断言）。

## 3. 实弹验证取证（2026-09-10 04:03-04:05 CST）

- 部署：bun build 门禁 EXIT=0 → `systemctl restart agent-gateway opencode-server` → 双 active＋SSE connected。
- 流程：beast_mode=true（settings API）→ 新会话发「秦始皇骑北极熊穿越赛博东京的大电影（2026日本动漫风格片头曲MV规格）」→ 取证 → abort → DELETE（part 级联清零）→ beast_mode=false 复原。
- **system 六项检查**（10677 字，v1.5 时代为 10507）：
  `HTML-comment:0 gate-clause:0 date-meta:0 state-line:1 arbitration:1 version-meta:0`＋digest 头在位。帧首逐字＝状态声明行。
- **模型思维链第一段**：「This is exactly the kind of OP beast-mode scenario — the standard operational paradigm in the orchestrator manual is literally written for… I'm the orchestrator: I write the spec and assemble the expert army via subagent_dispatch (async, concurrent, cap 3). I don't generate content myself.」→「no explicit indication BEAST_MODE=ON」**绝迹**；行为链：查轮子（mv2026 素材指定 wheel-source）→ 建项目目录 → wave 1 async 并发派遣。

## 4. 并发事件记录

R6（agent_c7d8e8ed，subagent async 手术）于本片探测与修复之间（03:56 CST）完成部署（playbook v1.6 双端同 md5、subagent async、index.ts wakeParent×3、服务重启）。本片备份 .bak-r7-0910 已**重拍**捕获 R6 后基线（md5：index `1a37b4c6` / subagent `2410ee27`），R7 补丁锚点在 R6 后代码上验证唯一命中。

## 5. 回滚方法

- `sudo cp /opt/agent-harness/gateway/{index,subagent}.ts.bak-r7-0910 <原档>`＋`registry-digest.txt.bak-r7-0910` → bun build → restart。
- playbook 回滚＝删除「**职能边界（与 AGENTS.md 的分工裁决，R7）**」整段（锚点唯一）。
- 本地：`git checkout src/lib/orchestrator-beast-frame.ts src/lib/orchestrator-beast-frame.test.ts deploy-staging/expert-gateway/orchestrator-dispatch-playbook.md`。

## 6. 遗留工单（未动，等裁决）

1. digest 改为 gateway 注入时从 registry 现算（治静态稿漂移本）。
2. per-subagent 工具白名单挂点（让 digest「能力断路」声明从 prompt 约束升级为物理事实）。
3. 前端 dispatch prompt 截断显示（UI 层）。
