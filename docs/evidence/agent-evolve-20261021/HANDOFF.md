# Agent-evolve 全量证据接力入口

用户目标：把近三天阶段一评测的所有message、实际保存且可导出的reasoning/delta及父子会话完整提取，逐条全文阅读，再执行二、三阶段反哺harness、后端和前端。禁止仅凭部分REPORT、摘要、计数或关键词断言。cutoff固定2026-10-21T13:11:42Z。

- [本地身份、evaluator与阅读层交接](HANDOFF-evidence.md)
- [本地stream与canvas阅读交接](HANDOFF-canvas.md)
- [远端导出与原始覆盖交接](HANDOFF-remote.md)

后两份由对应代理填写；不能因链接存在就推定文件已完成。

截至交接：evaluator request28块/230unique context与50新response已全文读；DB001—100、141—280、281—390已读，下一本路101、root391，剩余101—140与391—421。root的44,869字符WPYL完整回执已补读闭合。remote远未全文读完，最新固定阅读入口是 corpus/remote/canonical/line-reading-final/manifest.json；已完整落盘且冻结，新片尚未语义读。详各路ledger与交接，不把去重完成当读完。

工程草案冻结、未提交未部署，禁止为交接继续远端操作、付费、跑测试或新增脚本。以下12文件为草案范围，其余git dirty均视既有/无关，不能混入：

- deploy-staging/gateway/canvas-cascade-state.ts
- deploy-staging/gateway/job-store.ts
- deploy-staging/gateway/media-internal-routes.ts
- deploy-staging/gateway/messages-gw-admission.ts
- deploy-staging/gateway/questions-gw.ts
- deploy-staging/gateway/session-read.ts
- deploy-staging/gateway/sessions-core.ts
- deploy-staging/gateway/subagent-runs.ts
- deploy-staging/gateway/timers-gw.ts
- src/hooks/canvas/canvas-project-sync.ts
- src/hooks/use-canvas-chat.ts
- src/lib/canvas/client.ts

现行live由主协调者记录为 f0310e62f973-20261020T053254Z；旧评测修复版本不当现在live。旧root-cause是假说草稿，不采纳最终结论。阶段二先全量阅读与read-ledger，再判归因，研究先行和独立critic不可因耗时删除。

已读的重要事实边界：b857取消后真实扣1币；A/A2采集被评测者宽pkill误杀造成假卡死；probe曾误报真生成且probe路由与真路由不同；纯分析任务被画布闸迫写；真实MP3仅VPS路径不证用户可下载；harness账本0不证平台无扣费。每项仍须按原会话/时间/来源交叉，不能拿这些局部事实筛剩余材料。

本轮skill变更位于 /home/lenovo/.agents/skills/agent-evolve/SKILL.md。记忆单一真源 /home/lenovo/.claude/memory/，经mem维护，不在本证据目录；本路未掌握本轮新增note精确真名，未编造路径。此前必读及待核背景为 notes/2026-10-21-text-deliverable-must-be-in-last-message.md、notes/2026-10-13-eval-subagent-scope-and-evidence-retention.md、notes/2026-10-19-eimu-memory-harness2-integration-plan.md、notes/harness-definition-doctrine-0915.md、notes/2026-10-06-eval-design-do-not-hold-target-constant.md。

原历史只读未改；本轮证据副本已脱敏并设mode600。旧凭证进入工具返回事实不能撤销，活性未知，不认证、不吊销、不复述。原tool内截断尚需补源，去重空洞不等缺消息，merged不等raw。处理/生成映射完成与逐字语义阅读严格分开。所有未完成与未验保留未完成、未验。

## 本路增量（2026-10-21 23:xx，接手者请连读）

- 新建全量可读层：`corpus/packs/pack-0001..0206.md`（144,988 单元去重后 26.0M 字符，按会话时间线重排；转录/文件按原始行序重建），逐单元状态见 `corpus/coverage-ledger.jsonl`，切包器 `corpus/pack_reader_corpus_v2.py`。
- 已逐字读 150/206 包，产出 `corpus/findings/pack-0001..0150.jsonl`（8,657 条带 unit_id 的证据：contradiction 604、silence 323、claim 452、delivery 307、tool_fact 2,665）。
- 未读断点：**pack-0151 – pack-0206**（56 包，含 ses_ec6728b0 后半段）。`findings/READER-BRIEF.md` 是阅读协议，可直接续派。
- 本路结论：`SYNTHESIS-phase2-3.md`（机械事实 + 四层形而上归因 + 对 12 文件草案的逐条判断 + 删/简/加速/自动化清单）。
- 关键机械事实（不依赖 reader 判断）：7,144 个唯一 tool 单元中 3,805 个（53.3%）永远 running 且回执为空；同一 (tool,input) 全等签名重复 2,790 组 / 7,092 次调用，最高 46 次。
- 草案判断：job-store/questions/timers/canvas CAS 有证据支持；messages 正则识别取消、rev 起步值、persistSessionNow 同步落盘、teardown 清画布四处属推演或有风险，未验证。
- 仍未完成：56 包、evaluator 101–140 与 391–421 块、草案真实会话回归。本轮未提交、未部署、未跑生产探针。

## 本路增量二（2026-10-21 深夜，全量修复）

用户令「全量修复」后，按 `SYNTHESIS-phase2-3.md` 的删→简→加速→自动化清单落地代码。证据阅读未再扩展（仍 150/206 包）；本轮 oracle 是**真实模块纯函数/状态机行为脚本 + 独立 Hack**，不是测试绿灯，也没有真实生产会话回归。

新增 3 档：`tool-lifecycle.ts`（running 终态收敛：10 分钟未终态只标「未确认」，禁止改写成功；签名去重）、`claim-gate.ts`（无回执完成主张闸：证据只认 completed 的产出型工具，shell/纯读不计；只对媒体交付生效，纯文字成品以正文交付不拦）、`seat-preflight.ts`（派工前查席位工具表，缺工具只提示不阻断，缺档 fail-open）。

修改：`opencode-event-handler.ts`（idle stale 播报 + 主张闸 + 注入块过滤 + `promptText` 接线）、`events-translate-tools.ts`（登记/终态/重复通知只播一次）、`types-gateway.ts`（volatile 字段）、`messages-gw-admission.ts`（取消按工作代、新指令自动解封、裸停止词、resume 口语）、`job-store.ts`（工作控制、producer-cancel 6h TTL、删死函数）、`job-delivery.ts`（新任务 409 / 已提交幂等放行）、`session-read.ts`（控制写失败仍执行 abort，如实 `future_submissions:"unknown"`）、`subagent-runs.ts`+`subagent-messages.ts`+`subagent-recover.ts`（封条只在真 hard stop 写、resume/恢复即清）、`steer-gw.ts`（删除不可达 question 注入腿与假 dispatched，一律诚实排队）、`questions-gw.ts`（空答案不再产生同意凭据）、`timers-gw.ts`（超时只 reject、日志按真实成功数、删死文案与多余异步查询）、`canvas-cascade-state.ts`（rev 单调 CAS、`getCanvasState` 不写、删死 consumer 表、`clients.size` 回退）、`delivery-gate-critic.ts`/`delivery-gate.ts`/`subagent-finish.ts`（结构化判定冲突：括号/破折号备注与 `issues` 散文不算第二判决）、`sessions-core.ts`（落盘节流 + `flushPersistNow` + teardown 失败保留 dirty）、`canvas-write-gate.ts`（纯文字判据：带对象否定、倒装媒体请求、`只要文案`）。

前端：`src/lib/canvas/client.ts`（`fetchAgentCanvasSnapshotWithRev`）、`src/hooks/canvas/canvas-project-sync.ts`（rev 播种；409 只存本地副本 + 应用远端，**不**用旧快照 rebase）、`src/hooks/use-canvas-chat.ts`（第三参数直通）、`src/components/ImagePlayground.tsx`（rev 与 sid 绑定回填）、`src/lib/agent-chat-reducer/reduce-messages.ts`（`question.rejected` reason 中文化）。

验收口径（作者 ≠ 验收）：两路非作者独立 agent 共四轮 Hack/评审，每轮真缺陷再修再验。第 1 轮抓注入授权文案污染纯文字判定、`别急着停止生成` 误判 cancel、读旧文件 URL 当证据、死代码 `startGenerationReceipt`；第 2 轮抓取消粘性导致**永久无法再生成**、409 在登记前导致已提交产物无法入账、`VERDICT: PASS (PARTIAL)` 误拒、`[[]]` 空答案、`dispatchCanvasOps` 恒报 no_client；第 3 轮抓 `issues:` 散文「结论」误判、`bash` 读旧档绕过、409 rebase 覆盖服务端 agent 写入、steer 假 dispatched、recover 不清封条、裸「停止」不生效；第 4 轮抓倒装「视频也要」、`只要文案`、无冒号判定行。全部已修并复验。`npx tsc --noEmit -p deploy-staging/gateway/tsconfig.json` 多轮均 0 错误。

## 真会话 oracle（2026-10-21 深夜补做，报告与原始输出见 `oracle/`）

环境：**真 gateway 进程**（`deploy-staging/gateway/index.ts`，bun）、**真 HTTP 路由**、**真 SQLite**、**真实生产记录的事件体**（`corpus/remote/canonical/reading-units.jsonl` 逐字取，报告里列了 unit_id）。只有 opencode 与计费平台是本地 HTTP 替身（`oracle/harness/fake*.mjs`），不连真实上游、不付费。复现材料：`oracle/REPORT.md`、`REPORT2.md`、`REPORT3.md`，原始 SSE/HTTP/DB 输出在 `oracle/raw/`。

已验证（每项都有原始帧，不是函数级脚本）：

| 场景 | 结果 | 关键证据 |
|---|---|---|
| S1 无终态工具 | PASS | 真实等满 603s（`STALE_TOOL_MS` 未改）后 `tool.stale` + 「（系统核验）…未确认」，全程无成功帧 |
| S2 零证据完成主张 | PASS | 「（系统核验）本轮交付凭据尚缺」+ 无 `turn.done`；nudge 的 `prompt_async` body 被替身记录 |
| S3 纯文字豁免 | PASS | `帮我写一首歌词，只要词` + 「歌词已完成」+ 真实歌词 → 无拦截、收到 `turn.done` |
| S4 有回执 | PASS | 真实 completed `image_get_result`（真实 URL）→ 无拦截、`image.done`、`turn.done` |
| S5 停止按钮 | PASS | abort 200 → 新 task register 409 → 新消息 202 → register 200；DB 取消标记被 `new_user_prompt` 解除 |
| S6 画布 CAS | PASS | rev0→1、重复 rev0→409、GET 读回 rev1 |
| S7 重复通知 | PASS | 同签名 46 次注入 → `tool.duplicate` 恰 1 帧 |
| A 文本取消 | PASS | 「停止生成」202 → 409；「继续」202 → 200；「别停止生成」不写标记、200 |
| B nudge 不循环 | PASS | 两次 idle 只 1 条系统核验 + 1 条 block/1 条 nudge，第二次 idle 收到 `turn.done` |
| C 已提交任务 | PASS | abort 后同 task 重登记 200、completion 200 入账 succeeded；新 task 409 |
| D steer/question | PASS | `question.request` 出现；steer 200 `queued/applied_in_turn:false`；`[[]]`→400；`[["A"]]`→200；下一回合 `prompt_async` 含指引 |
| Z 零正文回合 steer | PASS | 修前会卡 queued；修后重投 body 含指引 1 次、`steer.status=applied`、无重复；竞态 A（abort）落 `aborted`、竞态 B（新消息）落 `applied` 到新回合 |

本轮 oracle **新抓到并已修**：零正文/上游错误重投腿在 `session.idle` 里 `break`，到不了 `flushPendingSteers`，用户回合中追加的指引要等下一次正常收尾；现改为把指引并入同一回合的重投 body（`takePendingSteersForRetry` / `settleSteerRetryInjection`），并按「先持久标记再离队、标记失败当场落 failed」修掉一个窄竞态。独立复验 1–4 全 PASS，故障注入 A/B/C 全 PASS。

仍未证：真实上游生成（模型/付费）、浏览器端 E2E（前端 rev 播种只在构建与 stub 级验过）、部署；S1 的 10 分钟静默期间 watchdog 会先收口，stale 在阈值后的那次 idle 发出；question 内容无生产 unit，由替身按 `questions-gw` 契约提供。

剩余（接手者续做）：① pack-0151–0206、evaluator 101–140/391–421 未读；② canvas/claim 两条 nudge 腿不消费 steer（只延迟到下一次正常收尾，未单独计时）；③ abort 回执字段仍无前端消费者；④ 问题卡 pending 时 steer 最长约 3 分钟才投递；⑤ `AgentTemplateCarousel.test.ts` 源码断言失配（按项目规则不修红灯、不当闸门），根 `tsc` 因未跟踪 `miniapp/` 有 3 条既有错误；⑥ 409 真冲突仍远端胜，无内容级合并；⑦ producer-cancel TTL 6 小时，解封主路径是 resume/恢复；⑧ 真实上游与部署未做。

工作树边界：本批只含 `deploy-staging/gateway/*`、`src/hooks/canvas/*`、`src/hooks/use-canvas-chat.ts`、`src/lib/canvas/client.ts`、`src/lib/agent-chat-reducer/reduce-messages.ts`。无关改动（`desktop/*`、`src/vendor-bridges/lib/client.ts`、`README*`、`.github/workflows/ci.yml`、`.vercelignore`、`.memory-queue/`、`miniapp/`、`docs/*`）**不得混入同一提交**；desktop full 模式放宽 allowlist 需独立安全评审。本轮未提交、未部署。
