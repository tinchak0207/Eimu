# Eimu 共享记忆 Seed 清单报告

- 产出：`/tmp/eimu-seed-manifest.json`，共 **35 条**。
- 输入：本机 1448 篇 note（catalog 2026-10-19 19:39），生产共享库 399 条摘要。
- 必读记忆核对：`MEMORY.md` 与两本 pack 均读；`2026-09-28-memory-pack-refactor.md` 记录 915 篇／13 包，现为 1448 篇／13 包，属正常增长，无结论冲突。唯一口径调整：请求建议的 `delivery-qc` 不在现有英文 taxonomy 中，已用现有 `media-qc`（2 条）与 `workflow`（1 条）承载。
- 自检：slug 格式、domain 复用、description ≤120、body ≤1800、evidence 10–200、feedback 必含 Why/How、无 URL/路径/IP/价格/账号/密钥/邮箱、source_note 全部存在。全部通过。

## agent-orchestration（8）

| slug | description | source_note | 重复风险 |
|---|---|---|---|
| subagent-dispatch-timeout-resource-thrash | 子代理投递超时或 502 常源于运行容器内存顶满后的 D 态与 swap thrash，不是投递逻辑本身。 | 2026-10-17-subagent-dispatch-timeout-opencode-thrash.md | 低 |
| scope-eval-subagents-with-hard-limits | 评测或对抗子代理的任务书必须写死会话数、轮数、每轮等待与证据即时落盘四类硬限。 | 2026-10-13-eval-subagent-scope-and-evidence-retention.md | 中（现有 split-large-subagent-tasks 同类，本条增加硬限与证据落盘） |
| recover-background-subagent-results | 后台子代理结果优先从完成通知取；查询必须用完整 id，status=running 可能是陈旧值。 | 2026-10-09-subagent-result-recovery.md | 低（现有 receipt-not-evidence 讲回执不可信，本条讲结果回收） |
| suspend-resume-semantics-and-slots | 挂起态必须与失败态、运行态分开建模；挂起不占并发槽，但状态挂起不等于算力释放。 | 2026-10-14-subagent-collaboration-bus-four-pillars.md | 低 |
| subagent-findings-are-file-scoped | 子代理的『档 X 没有 Y』只对档 X 成立，外推到兄弟档会制造假缺陷并扭曲修复权重。 | subagent-findings-are-file-scoped.md | 低 |
| reuse-prior-reverse-engineering-evidence | 分析已逆向过的外部产品前先检索既有证据，只对缺口做定向取证，禁止从零重拆。 | 2026-10-19-check-memory-before-repeating-rea.md | 低 |
| scrub-must-not-replace-subagent-report | 用户可见清洗只能就地脱敏，不得把整份子代理报告替换成结论句。 | 2026-10-19-conclusion-phrase-collapses-subagent-report.md | 低 |
| nudge-retries-must-be-idempotent | 补轮重试必须幂等：撤回失败时只能追加最小提示，不能重发用户原文。 | 2026-10-19-nudge-duplicate-user-message.md | 低 |

## tool-behavior（4）

| slug | description | source_note | 重复风险 |
|---|---|---|---|
| tools-map-unlisted-means-enabled | opencode 的 agent tools map 语义是只写 false、未列默认开，不是白名单。 | 2026-10-14-opencode-tool-table-unlisted-means-on.md | 低 |
| zod-single-arg-record-crashes-registry | 工具 schema 用 z.record 单参会让整个工具注册表构造失败，所有会话每轮报错。 | 2026-10-14-opencode-zod-record-tool-registry-crash.md | 低 |
| long-commands-15s-background | 长命令应由 15 秒预算自动转后台并在结束后唤醒，不要另立更大的超时阈值。 | 2026-10-19-command-15s-background-expectation.md | 低 |
| jsonpath-dot-key-silent-noop | SQLite JSON path 遇到带点的 key 必须整体加引号，否则写入静默 no-op。 | 2026-09-11-newapi-modelprice-jsonpath-dot-pitfall.md | 低 |

## canvas-workflow（4）

| slug | description | source_note | 重复风险 |
|---|---|---|---|
| canvas-snapshot-needs-rev | 画布快照上行必须做形状校验与乐观并发，否则旧标签页一次保存就能整份覆盖。 | 2026-10-18-canvas-snapshot-overwrite-no-rev.md | 低（现有 7 条 ack timeout 属另一主题） |
| auto-layout-from-real-bounds | 新节点自动排版必须按真实尺寸与已有矩形避障，不能按固定网格或固定原点。 | 2026-10-12-canvas-new-node-overlap.md | 低 |
| canvas-write-through-release-gate | 多步影音制作必须在收盘前成功写穿画布，并把覆盖率做成发版门。 | 2026-10-11-canvas-write-gate-20261011.md | 低 |
| snapshot-vs-ui-summary-channel | 画布有前端上行摘要与真实快照两条通道；无头环境摘要为空属正常，判内容必须读快照。 | 2026-10-13-canvas-chat-dsl-consistency.md | 低 |

## generation-platform（6）

| slug | description | source_note | 重复风险 |
|---|---|---|---|
| model-listing-is-not-liveness | 模型清单返回 200 不等于可调用；判活必须查清单含该模型且近 24h 有真实交付。 | 2026-10-02-image-channel-false-outage-root-causes.md | 中（现有 quote-availability-vs-deliverability 语义相近，本条落在探测实现与 24h 真交付） |
| model-routing-single-source | 多供应商路由必须只有一个有序真源，其他层 priority 只做内部选择，不能参与主调度。 | 2026-10-01-model-routes-single-source.md | 低 |
| client-timeout-shorter-than-generation | 客户端超时短于真实生成耗时会系统性丢掉最强通道，并留下孤儿任务与重复计费风险。 | 2026-10-05-yue2-client-timeout-runaway-storm.md | 低 |
| paid-model-cost-gate-at-order-time | 付费生成的成本闸必须在下令同时存在：模型白名单、参数上限、单次授权与唯一只读取证。 | 2026-09-27-video-upstream-cost-incident-and-submit-gate.md | 中低（现有条目讲用户拒绝后重试，本条讲下单时授权与参数闸） |
| artifact-download-tiered-timeout | 大产物下载必须分阶段超时：标头固定、主体按大小放大并设硬上界。 | 2026-10-01-artifact-download-tiered-timeout.md | 低 |
| capability-limits-single-source | 能力 API 必须公布批次与参考图上限，且执行端与广告值读同一个零依赖常数。 | 2026-09-29-p17-d23-model-capability-contract.md | 低 |

## video-generation（4）

| slug | description | source_note | 重复风险 |
|---|---|---|---|
| reference-images-are-not-frame-locks | 图片驱动参考不等于首帧/尾帧硬锁；不要因此截断分镜或把多张参考当连续帧。 | 2026-10-12-agent-video-keyframes-input.md | 低（现有 i2v 一致性条目主题不同） |
| deadline-exceeded-may-mask-success | 平台 job 的 deadline_exceeded 或 failed 不等于上游没成，成片可能已落在 artifact 表。 | upstream-fake-failure-recovery.md | 低 |
| video-duration-floor-and-default | 视频工具 schema 必须暴露时长下限与合法缺省，不能把短档留给模型猜。 | video-duration-5s-regression-and-gateway-crash-0921.md | 低 |
| video-artifact-recovery-use-video-surface | 视频产物回收要同时修工具权限、直链下载与尺寸校验，不能只修被观测到的一个席位。 | 2026-10-19-video-artifact-recovery-chain.md | 中（现有 video-job-query-use-video-surface 只讲查询路径，本条讲权限/直链/ACK 多点） |

## image-generation（3）

| slug | description | source_note | 重复风险 |
|---|---|---|---|
| upscale-4k-delivery-gates | 4K 超分交付要同时过请求体大小、下载超时与真实尺寸验证三关。 | 2026-10-01-upscale-4k-delivered.md | 低 |
| reference-images-cache-key-fold | 给生图工具加参考图时必须把参考图折进去重缓存键，否则会命中无参考图的旧缓存。 | 2026-09-25-a1-image-generate-reference-images.md | 低 |
| cors-cache-poisoning-download | 资源长缓存加按 Origin 动态 CORS 头时，浏览器会复用 no-cors 副本，下载必须带缓存破坏。 | 2026-09-06-image-download-cors-cache-poisoning.md | 低 |

## billing（3）

| slug | description | source_note | 重复风险 |
|---|---|---|---|
| cancel-does-not-stop-upstream-billing | 『已取消』要拆成 run 停、job 停、钱退三件事；停子代理不等于停上游计费。 | 2026-10-19-cancel-does-not-stop-billing.md | 低 |
| skipped-budget-card-is-not-consent | 预算问卡被新消息跳过不等于用户同意付费；授权必须有显式同意并绑定金额与次数。 | 2026-10-19-budget-card-skip-treated-as-consent.md | 低 |
| zero-spend-oracle-is-ledger-hits | 判『这一轮有没有花钱』的 oracle 是账本按 session_id 的命中数，不是 SSE 工具字串。 | 2026-10-08-zero-spend-oracle-gateway-ledger.md | 低 |

## 交付质检（media-qc 2 + workflow 1）

| domain | slug | description | source_note | 重复风险 |
|---|---|---|---|---|
| media-qc | no-delete-promise-for-generated-takes | 平台存储没有删除已生成音频的端点，不得承诺『删掉其余版本』，只能说不采用。 | 2026-10-10-music-takes-not-deletable.md | 低 |
| media-qc | visual-audit-when-model-cannot-see | 模型图像输入被丢弃时必须明说，并用本地视觉审计与几何测量闭环后才可宣称完成。 | vision-audit-before-claiming.md | 低 |
| workflow | delivered-links-from-receipt-and-curl | 交付链接必须从回执原文复制并用匿名请求验证可达，不得凭记忆拼域名。 | 2026-10-13-delivered-link-domain-typo.md | 低 |

## 被排除的高价值候选（人工复核用）

1. `2026-10-10-cross-canvas-dsl-writeback-parallel-nodes.md` — 与现有 `workflow-write-confirm-new-line-gate` 语义重复（同判据、同确认项），按规则 5 跳过。
2. `2026-10-06-music-duration-take-contract-and-delivery-verification.md` — 时长不可控与多 take 在现有库已有多条；ffprobe 核验已有 `trust-ffprobe-over-upstream-duration`。
3. `2026-10-18-dmc-auto-hd-channel-blocker.md` — 已被 `model-listing-is-not-liveness` 覆盖，且绑定单一供应商与档位，易过时。
4. `2026-10-18-opencode-dotopencode-agents-not-loaded.md` — 结论是推断、未做真实注入抓包，不满足「准确」硬标准；待实测后再收。
5. `2026-10-18-canvas-editability-billing-eval.md` — 评测快照，结论已拆进授权与账本条目；原文还含具体会话与金额。
6. `2026-10-10-music-one-coin-billing.md` — 单价/币值强绑定，违反无价格约束；机制部分已被计费条目覆盖。
7. `2026-10-19-subagent-peek-live-transcript.md` — 功能上线状态与端点实现，属项目快照，换项目不成立。
8. `2026-10-19-durable-inbox-media-kind-deadlock.md` — 与视频产物回收条目同源（媒体类型错配），修复细节绑定具体收件箱；留作排障参考。
9. `2026-10-13-harness-prompt-cross-session-copyright-discipline.md` — 版权与跨会话产品政策，不是运行时机制，且含产品策略判断。
10. `2026-10-05-music-prompt-chain-observability-and-loss.md` — 提示词链观测价值高，但与本批客户端超时、时长契约重叠，且大量绑定本机音乐管线。
