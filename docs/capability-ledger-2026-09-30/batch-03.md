# image-app repo 第 3 批（47 commit）我方能力清单

- 范围：`/tmp/cap/batch-3.hashes` 全部 47 条（2026-09-15 → 2026-09-20）
- 唯一真源：`/tmp/cap/batch-3.txt` 讯息 ＋ `git show` 补细节 ＋ 现场 grep 验是否还在
- 能力定义：使用者可见或可呼叫的行为；档名一律不当能力
- 领域标签：生成核心／模型与供应商／控制平面与计费／B端API／Agent助理／画布与工作流／创作域／帐号与增长／前端与UI／运维与观测／团队与企业

---

## 生成核心

- [生成核心] 成片导出幂等指纹 — 素材集合归一化 SHA-256 指纹（绝对／相对 URL 视为同素材），指纹相同即视为同一成片 ｜ 证据: 51631bc1
- [生成核心] 字幕分屏 — 每屏 7-12 字且切在换行 → 句末标点 → 句内停顿等语义边界，逐行移植 AID SubtitleScreenSplitter ｜ 证据: 51631bc1
- [生成核心] 成片导出后实算指纹并回填公开 URL — 导出成功且 probe 过档后回填 public_url 与 master_artifact_id，sha256/byte_size 取盘上实值，不拿 probe 缺值充数 ｜ 证据: 349150f3

## 模型与供应商

- [模型与供应商] yyds 渠道宣告 image_edit — gpt-image-2 改图能力写进 registry claims（此前只宣告 image_generate，改图能力表只剩死渠道） ｜ 证据: 15f278d8
- [模型与供应商] edit 标注与 registry claims 同源 — model-status-probe 的 edit 标注改由 registry 推导，标了才有 capability 预检行可查 ｜ 证据: 15f278d8
- [模型与供应商] 部署侧渠道目录同步 — gateway 15 档与 VPS live 同步，带入 agnes／seedance 渠道与 catalog 能力位 ｜ 证据: 75c25e24

## 控制平面与计费

- [控制平面与计费] 成片导出落帐 — 以 generation_job(kind='film_export', source='agent', status='succeeded', model_id='timeline_master', billing_amount=0) 落帐；导出免费且不经任何供应商、无 billing_operation ｜ 证据: 349150f3
- [控制平面与计费] 导出登记幂等 — 幂等键 `film_export:<session_id>:<fingerprint>`，重放导出 job 不重复、artifact 不重插（artifact_id 同值、total 不变） ｜ 证据: 349150f3
- [控制平面与计费] 成片索引 HMAC ingest 通道 — `/api/v1/internal/masters/ingest` 复用 memory-hmac 同一通道与同一把密钥，无签／错签／密钥未配置回 401 ｜ 证据: 349150f3
- [控制平面与计费] 成片索引 tenant 属主维度 — reader/ingest 两端对称改用 `web:<userId>`，避免成片按 B key id 查永远查空 ｜ 证据: 349150f3
- [控制平面与计费] 尺寸 NULL 诚实直译 — 修掉既有 Number(null)→0 的伪实测，尺寸 NULL 直译 null（禁 0 冒充） ｜ 证据: 349150f3

## B端API

- [B端API] `/v1/images/edits` durable 改图管线 — 非 pixai 模型改图回 202 + Location，任务合同与 generations 一致（不再走即时短路） ｜ 证据: 15f278d8
- [B端API] 成片索引列举 — `/api/v1/masters` 按 session／project／时间列举成片，每条带导出指纹、preset、时长、解析度与 probe 摘要 ｜ 证据: 0b2c2843
- [B端API] B 端读回成片全栏位 — 读端回 probe.verified、fingerprint、解析度、时长、job_kind=film_export 等全栏位 ｜ 证据: 349150f3

## Agent助理

- [Agent助理] AI 助理全局记忆库（私有 + 共享）— 私有 active docs 与共享索引注入 gateway 建号与 memory-patch payload；export／ingest／retract／review 四端点 ｜ 证据: 0625d6d5
- [Agent助理] 会话级记忆追溯 — `memory-trace` 端点回某会话的记忆注入与命中轨迹（另有 sessions/:id/memory 查询） ｜ 证据: 0625d6d5
- [Agent助理] 审核官 Expert（critic）— 独立审核 persona，只驳回不产内容，轮子镜像 screenwriter-delegate ｜ 证据: ff5e6c7b
- [Agent助理] 提示词契约机械检查器 — 27 份契约（结构范式参考 AID 提示词开发指南），运营改完当场可判是否违约 ｜ 证据: ff5e6c7b
- [Agent助理] Expert 资产机械导出 — export-expert-agents 导出 persona／registry／contracts 三产物（contracts 为本批新增第三产物） ｜ 证据: ff5e6c7b
- [Agent助理] Jev 输入闸与路由权威 — TypeSafe System One 接入输入闸／expert 路由／模板判定／workflow 记忆入库闸，附阈值校准工具 ｜ 证据: 75c25e24
- [Agent助理] 判定层 Laya 兜底 — Jev 额度用尽（闭源按量计费）时自动切开源 Laya：契约逐位同构、fail-open、fallback 打 laya_fallback log 供归因；Jev 通时 Laya 完全不碰 ｜ 证据: d25aed7d
- [Agent助理] 工作流完成记忆沉淀 — 历史写入后非同步 persistWorkflowMemory（fail-open 不阻塞 202）；闸门为 prompt 非空且 ≥2 槽位、body 硬上限 2000 字 ｜ 证据: ac0dfa0d
- [Agent助理] 记忆 ownerKey 收敛 — 从 state.apiKey 算 memoryOwnerKeyHash，与 agent 侧 deriveMemoryOwnerKey 收敛到同一 ownerKey ｜ 证据: ac0dfa0d
- [Agent助理] 记忆库第五类型 workflow — TYPE_VALUES（G1 结构闸判定集）与 curator prompt output schema 两处同时扩充，缺一即静默丢弃或不提议 ｜ 证据: 8fff4595
- [Agent助理] subagent 停止闸 — 可停止在途 subagent，gateway 送 subagent.done status="stopped"，subagentParentState 兜底 ｜ 证据: 7ae66e5b, 0d3e12af
- [Agent助理] workflow 完成推送 — 工作流完成事件推给前端 ｜ 证据: 7ae66e5b
- [Agent助理] TaskStatus 单一语义表 — stopped≠失败 语义固化进 types-gateway.ts，wire 值零变更 ｜ 证据: 5a7b9a90

## 画布与工作流

- [画布与工作流] 作品／剧集／分镜三级状态机资料 — CanvasProject 带 projectType／currentStep／episodes（全 optional、向后相容），normalizeProject 单点清洗避免路由与 layout 漂移 ｜ 证据: 9d9f0483
- [画布与工作流] agent 建作品／建剧集 op — canvas op `set_project_meta` 是唯一可达专案级三栏的写入口，episodes 在写入端即做 episodeNo 去重与截断 ｜ 证据: f603864c
- [画布与工作流] 分镜节点 21 栏契约 — 画面／台词·音效／时空／摄影四组共 21 栏，读取端与上行端双白名单清洗，剔除已废的第 22 栏 sceneCode ｜ 证据: b01a1c47
- [画布与工作流] 21 栏 → storyboard_qc_17 门禁桥接 — shotId←shotNumber、order←阵列序、prompt←visualDescription、characterCardIds/sceneCardIds←referenceAssets、aspectRatio←节点 size、卡锁←project.cardIds 按 kind 分流 ｜ 证据: 49bffcd7
- [画布与工作流] 剧集状态查表由 enum 值域推导 — 改由 AID_EPISODE_STATUS 推导＋satisfies 穷尽性，AID 新增第七态时编译失败而非静默回 undefined（避免剧集整笔消失） ｜ 证据: 7a4bbcc0
- [画布与工作流] 作品类型值域单一真源 — CanvasProjectType {series, movie} 收敛全仓 8 处硬编字面值与 `=== "movie" || === "series"` 判断 ｜ 证据: 7a4bbcc0
- [画布与工作流] 画布节点事件写穿快照 — canvas.node.created/updated/connected/disconnected/generating 全数写穿 canvasStates（SSE 与快照双轨收口），updated 浅合并 last-write-wins 幂等 ｜ 证据: cef439a0
- [画布与工作流] 工作流模板注册表 6→13 — 7 模板修复到 novel_film 水准（card 补 harnessTemplateId、directive 补 workflow_start 指令、后端新建 WorkflowTemplate） ｜ 证据: d59d3976
- [画布与工作流] 打字路径骨架卡带 deliverable/gate — WorkflowNodeSpec 加两栏、expandTemplate 带进 metadata、13 模板 deliverable 100% 覆盖、R8 克隆链继承 ｜ 证据: 3525afcf
- [画布与工作流] gate 栏位双形态 — string＝骨架门禁全文／true＝DSL「需人工批准」旗标；layout 白名单对 boolean 原样保留 ｜ 证据: 95a6994e
- [画布与工作流] 工作流历史可重跑 — canHistoryEntryRerun 对 workflow 放宽，提交前剥掉前端专用 DAG 栏位再送 ｜ 证据: 06baf18e
- [画布与工作流] 模板拆档零漂移 — agent-templates(8)／agent-templates-payload(8)／workflow-templates(13) 逐模板独立档＋types＋barrel，切割前后快照 md5 逐位相同 ｜ 证据: d59d3976
- [画布与工作流] AID 37 enum 值域库 — creation(7)／generation(11)／storyboard(7)／asset(4)／billing(8) 值与中文 desc 逐字入库，供消费端以单一真源推导 ｜ 证据: c194f5f4

## 创作域

- [创作域] 镜头语言词库 142 条（12 类）— MIT 逐字取自 AID aid_prompt_lib，可多选词条插入提示词 ｜ 证据: 30f01c7d
- [创作域] 7 步创作流水线骨架 — 作品／剧集／分镜七步状态机常数，轮子源 AID CreationStepEnum，MAX_EPISODES_PER_PROJECT 收敛单一宣告处 ｜ 证据: 30f01c7d, f603864c
- [创作域] 音乐管线 yue2 — music-tools/yue2 换血＋prompt-director 升级＋staging 同源导出＋music-director skill references ｜ 证据: 75c25e24
- [创作域] shortdrama QC 时长放宽 — 单镜 2-30s、去段上限，对齐分镜秒数最大化（现场 `duration_bounds` gate 仍是 2-30s） ｜ 证据: 75c25e24
- [创作域] 模板 promptNotes 配方级 — 6 模板加厚到 32-41 条／2,067-2,534 字，每条含具体数值、工具用法与可验证判据 ｜ 证据: d59d3976

## 帐号与增长

- [帐号与增长] Google OAuth 登入 — `/api/auth/google` start＋callback 三件套与 google-auth 桥接（与 GitHub 同款、禁真实 Gmail 合成 email）＋SplitLoginButton 三段斜切钮与品牌图标 ｜ 证据: 75c25e24

## 前端与UI

- [前端与UI] 全聊天流单层滚动 — 参数卡与参数抽屉改 overflow:clip，滚轮手势直接冒泡给最外层消息流（不再被隐形容器吃掉） ｜ 证据: dc6ef7b9
- [前端与UI] ParticleSeaWaiting 动效回退 — 回退 shadowBlur 直绘（去掉离屏 sprite 预渲染） ｜ 证据: dc6ef7b9
- [前端与UI] 作品／剧集面板 — CreationFlowPanel 挂画布左侧弹层，资料全取自 hook 既有出口，只报「已落画布 N 镜／场景计画 M 镜」不报完成进度 ｜ 证据: f603864c
- [前端与UI] 分镜节点卡渲染 — 21 栏分四组呈现、shotNumber 作卡面徽章；Group 带 storyboardScene 时显示场景名＋镜数 ｜ 证据: 84a3ce7a
- [前端与UI] 镜头词库选词入口 — 画布库面板新增「镜头词库」tab，多选后经既有 onInsertText／onUsePrompt 插入（与提示词卡同一通道） ｜ 证据: 9e438082
- [前端与UI] 工具卡中继态 — 已提交成品未到时带 task_id＋artifact_pending，显示「生成中…」金徽章＋转圈；image/video/audio.done 结 ok、image.failed 结 failed（精确 taskId 优先、FIFO 兜底） ｜ 证据: c86dd01d
- [前端与UI] 思维链预设展开 — 预设受控 open，手动收起优先于任何自动行为（作废 08-25「预设收合」契约） ｜ 证据: c86dd01d
- [前端与UI] 在途反馈 — sendPending 为单一真相源，送出钮真空期转圈不可再点（输入框空亦然）、被点模板 chip 转圈其余禁用、20s 硬保险 ｜ 证据: c86dd01d
- [前端与UI] 文字帧并批渲染 — 每 delta 一次全面板重渲染收敛到每帧一次；中止成功合成 turn.done；IME Enter 不再误送出 ｜ 证据: c86dd01d
- [前端与UI] 聊天气泡样式 — 用户灰底气泡＋助理无底气泡 ｜ 证据: eb1dcede
- [前端与UI] AgentPlanCard 计画卡 — agent 计画以卡片呈现，reducer／types／契约同步 ｜ 证据: 75c25e24
- [前端与UI] 桌面 Electron 薄壳 — desktop/ 薄壳 AppImage 可用（node_modules/dist 已 ignore） ｜ 证据: 75c25e24
- [前端与UI] 历史三档位筛选＋DAG 缩图 — 图片／影片／工作流筛选、workflow 卡取 dagThumbnailUrl、影片卡补 videoUrl 与 Play 标示（原本纯影片记录在历史隐形） ｜ 证据: 06baf18e
- [前端与UI] RerunDialog 费用显示 — 「上次实付 X 币／本次预估 Y 币」，实付缺时只显预估并明确标「预估」不冒充实付 ｜ 证据: 06baf18e
- [前端与UI] HistoryLightbox DAG 展开 — 展开工作流 DAG 节点清单＋节点合计币数 ｜ 证据: 06baf18e
- [前端与UI] 工作流缩图对齐画布节点卡 — 220px 卡、kind 色条、标签徽章、I/O 行（↳来源／→目标）、站内色票、PNG density 216 ｜ 证据: 5881aff6
- [前端与UI] 任务状态→UI 语义单表 — AgentToolCard／AgentSubagentBar／reducer 改查 AGENT_TASK_STATUS_TABLE，渲染输出逐字不变 ｜ 证据: 8b08d285
- [前端与UI] subagent 已停止态可视化 — 派遣工具卡中性结算不打脸、不显 abort 文案；SubagentBar 灰点中性徽章；ReportCard「已停止」 ｜ 证据: 0d3e12af
- [前端与UI] 节点卡「产出／门禁」渲染 — NodeBody Config/Text 分支复用 step_head 胶囊样式显示 deliverable／gate ｜ 证据: 3525afcf
- [前端与UI] Agent 模板卡 ID 可解析 — 7 模板 card 补 harnessTemplateId、art 系补 styleTemplateId（style-library 真 ID），8/8 可解析 ｜ 证据: d59d3976

## 运维与观测

- [运维与观测] gateway 生产↔git HEAD 对账 — recon 脚本部署前必跑，漂移即挡；补子目录盲区、排除 refactor-audit.ts 非运行时代码 ｜ 证据: 581a7c6a, 07e3e42e, 5a7b9a90
- [运维与观测] 成片静态服务 — `/agent/v1/masters/<sid>/master_<preset>.mp4(+_cover.jpg)`，放 Bearer 闸门前，路径 resolve＋前缀守卫（路径穿越被拒） ｜ 证据: 349150f3
- [运维与观测] 错误分类单一有序表 — 28 条 ERROR_RULES 进 error-classify.ts，humanize 表与 workflow-service RETRYABLE_NODE_ERROR 合并收编（17/17 行为全等） ｜ 证据: 5a7b9a90
- [运维与观测] opencode 接缝统一 — opencodeFetch／opencodeJson helper，批次 1+2 共 8 档 33 呼叫点机械迁移（timeout／错误处理结构逐点保留） ｜ 证据: 5a7b9a90
- [运维与观测] serverless 中文字型随程式码部署 — Noto Sans CJK SC 子集化 18.6MB→5MB 放 public/fonts/，首次渲染把 dag-fonts.conf 的 __FONT_DIR__ 替换写 /tmp 并设 FONTCONFIG_FILE ｜ 证据: 8a3a6728
- [运维与观测] sharp 隔离 — 拆出 dag-png-server.ts 隔离 sharp，workflow-png.ts 回归零依赖，避免把 sharp 拖进 browser bundle 炸整包 build ｜ 证据: 5881aff6
- [运维与观测] 部署体积守卫 — .vercelignore 排除 .next/（847MB）与 desktop/dist/，避免单档超 Vercel 100MB 上限 ｜ 证据: 5881aff6
- [运维与观测] Laya ONNX 服务可入 VPS — 无 torch（onnxruntime＋tokenizers）、RSS 1.61GB、同契约 POST /predict 与 GET /healthz、三型 choice/score/noul 校准与 torch 逐位吻合 ｜ 证据: f1d5dd98
- [运维与观测] gateway 无损切割 — index.ts 10029→8225→272 行组合根（共 32 个新模组），行多重集 7804=7804、missing 0 extra 0 审计证明零损 ｜ 证据: c8bfe4eb, bcd57a72

## 团队与企业

- （本批 47 commit 无新增能力）

---

## 非程式码能力

- VPS／生产对账落库 — 三度以 VPS 生产实体重建 repo 基线（84952257 md5 4664e5bb；f22dd523 重立至 VPS live b65e5966 并拉齐全量源码树；7ae66e5b 逐档 diff 后收编 09-20 十二档已部署改动），终结「未 commit 部署＝生产分叉」
- VPS／repo 镜像内容（背景，非本批新增）— f22dd523 把 director-engine／editor／delivery-gate／beatDetect 等 VPS 既有能力拉进 repo；能力面本已存在于 VPS，本批只建镜像
- 部署纪律（runbook）— 改 registry 后必须同时 restart opencode-server 与 agent-gateway：只重启前者会让 gateway /event SSE 悬挂到 fetch 超时（实测 4 分 21 秒），期间模型照常推理出图、DB 正文齐全但前端看不到任何 delta，watchdog 还会误判零文本重发 ｜ 证据: 3ca62d82
- DB 迁移 — migration 018 已套生产 DB：generation_job kind 扩 'film_export'、source 扩 'agent'；supplier_capability.kind 刻意不动 ｜ 证据: 349150f3
- 外部服务 — Laya 自架服务（Python HTTP 包装 multilingual checkpoint ＋ Dockerfile ＋ runbook；RSS ~2.8GB 禁与 opencode-server 同机） ｜ 证据: d25aed7d, f1d5dd98
- 运营流程 — 派遣手册第 20 条「研究是决策输入，不是创作素材」进真源 orchestrator-dispatch-playbook.md，并以 15 例锚点测试锁住关键词在场、编号连续（19 后即 20 不跳号）、11-19 与 L152 原文零删 ｜ 证据: 9a1cbf6d
- 运营流程 — 提示词契约运营化：27 份契约目录＋机械检查器，运营改完当场可判（不再靠人工复核） ｜ 证据: ff5e6c7b
- 运营流程 — 历史教训资料迁移工具 tools/migrate-agent-lessons ｜ 证据: 0625d6d5
- 运营流程 — skill 单一真源生成 tools/gen-lens-skill（禁手改两份） ｜ 证据: 30f01c7d
- 文档／合规 — THIRD-PARTY-NOTICES 追加 AID 引入记录（含逐条改写说明与剔除项，如 AID OSS 不可达、voice 塌缩实测边界） ｜ 证据: 90e7df76
- 验收纪律 — PRD §11 修正：tsconfig exclude 掉 src/vendor-bridges、deploy-staging 与全部 *.test.ts，标准验收命令回 0 不代表 0 错；改为「主库 + 隔离检查 + 真跑测试」三条并跑 ｜ 证据: 90e7df76
- 审计文档 — 「只做一半」审计（系统性模式：每刀停在型别＋清洗＋单测、消费端一律缺席）＋前端对称差报告（我方强项＝能力表达：3D 导演台 39,251 行 vs AID 5,150；45 个 agent 模板，AID 无对应物） ｜ 证据: 7fd7bb0f
- 协作纪律 — 两线并行工作共用同一工作区时以「联集落库」避免干净 HEAD 树部署互抹（部署史实锤 03:41/03:48 有帧批、03:52-03:59 被回退） ｜ 证据: c86dd01d

---

## 边界与拒绝

- 素材 URL 守卫 fail-closed（边界语义）— 成片导出 check 端以 blocker 拒绝 blob:／data:／嵌套协议／非 http(s) 素材 ｜ 证据: 51631bc1
- 不做在线剪辑（明确不做）— 不提供时间轴 UI、不接 @webav（Eimu 卖 one-shot）；不新增前端页面，沿用既有 chat 影片卡与画布节点；不吞 AID 的 pending_video_* 双槽（我方无审核队列） ｜ 证据: 0b2c2843
- storyboard_qc 缺值语义（fail-closed）— 缺栏回 missing[]＋complete:false，不补假值；hasUsableQcValue 对齐门禁自身正规化，空串／纯空白／NaN／空卡 id 全进 missing（修掉 production 空值被误判 complete=true 的「谎报可过」） ｜ 证据: b01a1c47, 49bffcd7
- 无来源栏位绝不臆造（诚实留 missing）— durationSeconds（三把尺冲突且需自造台词解析）、sceneId、keyframeId／lastFrameId／audioAnchorId、segmentDurationSeconds 全留 missing ｜ 证据: 49bffcd7
- 不在 21 栏契约内的栏位不显示 — durationSeconds 只在 StoryboardQcProductionFields，显示就是编造 ｜ 证据: 84a3ce7a
- set_project_meta 非法值省略该键 — 模型打错一个 enum 不清掉用户已填的剧集清单；代价：agent 无法借此清空栏位（已诚实标注） ｜ 证据: f603864c
- ingest 诚实语义 — 栏位缺失／非法逐栏 422 回报，不补预设值（metadata 会被读端当事实转录给 B 端）；登记失败不反悔导出（档案已在盘上、静态路由已可服务），只诚实记 note ｜ 证据: 349150f3
- 假能力拒绝（白名单外拒收）— supplier_capability.kind 刻意不加 film_export（该表语义是「供应商能承接什么」，导出不经供应商，加了反而是假能力） ｜ 证据: 349150f3
- AID 语音库整支撤回（功能地基不成立）— 63 笔火山 bigtts 音色码全不含冒号，撞上本站网关 /opt/edge-tts/tts-proxy.js:41 `if (!voice.includes(':')) voice = `${model}:alex`` ⇒ 全部塌缩成同一个 alex 音而 HTTP 200 完全掩盖；判据修正：SF 输出非确定，sha256 差异不能证明音色不同，唯一可靠判据是 MP3 frame header 采样率（32k=SF 主路／24k=edge 降级），故只认实测可播的 8 条 SiliconFlow preset，移除 voice-library／tts-upstream adapter／AssetPackItemKind "voice"／CharacterCard.voiceCode／artifact voice_code 透传链 ｜ 证据: 95c32abb, 0c418b53
- 只埋桩不注册（注册即虚报能力）— tts_speech adapter 未进 supplier_adapter_type_check 白名单、未注册 TTS 渠道 ｜ 证据: 95c32abb
- enum 假对位拒接 — AID_MEDIA_TYPE {image,video} 是我方 MediaKind {image,video,audio} 的子集（接上会让我方独有 audio 失去型别来源）；AID_MEDIA_TASK_STATUS 8 态与我方含计费态的 11 态是不同生命周期；AID_CREATION_STEP 刻意保留字面值以维持 aid-enums.test.ts 的真交叉检查（改推导会退化成自我比对） ｜ 证据: 7a4bbcc0
- art-style 模板保持 unsupported 诚实口径 ｜ 证据: d59d3976
- Laya 校准陷阱 — HF 公开 demo Space 校准已坏（benign 判 0.9999）不可用；root 英文 checkpoint 中文崩坏，必用 multilingual 版本 ｜ 证据: d25aed7d
- 缩图／字型失败不挡渲染 — 宁可方框不让历史写入陪葬（与缩图失败同款语义）；已知取舍：动态 title 出现 U+9FA6 之后罕用字会落 notdef 方框 ｜ 证据: 8a3a6728
- 记忆沉淀 fail-open — 沉淀失败只影响记忆库、不影响已落地历史；不阻塞 202 回应 ｜ 证据: ac0dfa0d
- Bun 陷阱（边界语义）— Bun 的 node:crypto `Hash.update` 只吃 string/Buffer/TypedArray/DataView，裸 ArrayBuffer 会抛错；成片索引登记因此整条静默失败而导出照样成功（手签 ingest 的 E2E 4/4 完全看不到此洞） ｜ 证据: f9660201
- 未知状态保守判失败 — AGENT_TASK_STATUS_TABLE 未知值 fallback 保守判失败 ｜ 证据: 8b08d285
- 「完成」的判准不灌水 — 只建供给侧不算完成：型别可写＋测试绿是可机器验证的，前端可见需真开浏览器，不能因此跳过 ｜ 证据: 7fd7bb0f

---

## 存疑

- 0625d6d5 共享库注入的实际生效 — 端点与注入 payload 在 repo 可验，但共享索引注入 gateway 建号的效果端在 VPS，本批无 VPS 侧证据；缺「注入后 agent 行为差异」的实测。
- 75c25e24「Jev 权威三刀」的具体三刀 — 讯息只说输入闸／路由权威接入＋阈值校准工具，细节在 PRD/评估文档；缺逐刀 diff 级证据（另同 commit 的 gateway 15 档同步内容未逐档核）。
- 349150f3 的 resolve-owner（+user_id）部署状态 — 讯息明说「待 Vercel 部署 resolve-owner 后索引归属才自动生效，此前以 note 标注跳过原因」；本批无法确认该部署是否已完成，缺部署证据。
- 7ae66e5b「VPS 对账逐档一致」— 仅 commit 讯息声明（除 router.ts 注释文字外全部一致），未独立复验。
- f22dd523 带入的 gateway 模组（director-engine／editor／delivery-gate／beatDetect 等）使用者可见行为面 — 本批只证明它们进了 repo，未展开其入口与验收；若清单要涵盖这些能力须另批处理。
- 581a7c6a 附带删除 src/lib/agent-templates.ts／agent-templates-payload.ts（-2505 行）— 现场已存在同名目录（拆档后形态），判断为清理拆档前残留平档；但 commit 讯息未说明，缺 diff 级确认其非能力移除。

---

## 逐条对帐（47/47）

| hash | 贡献的能力（或无） |
|---|---|
| 0625d6d5 | AI 助理全局记忆库（私有＋共享）＋四端点＋memory-trace；HMAC raw-body 验签；migrate-agent-lessons 工具 |
| ff5e6c7b | 审核官 Expert（只驳不产）；27 份提示词契约＋机械检查器；Expert 导出三产物 |
| 30f01c7d | 镜头语言词库 142 条；7 步创作流程骨架；gen-lens-skill 单源生成 |
| 51631bc1 | 成片导出幂等指纹＋URL 守卫 blocker；字幕分屏 7-12 字 |
| 15f278d8 | /v1/images/edits durable 改图（202＋Location）；yyds 补 image_edit claim；edit 标注与 claims 同源 |
| 9d9f0483 | 作品／剧集／分镜三级状态机资料层（projectType/currentStep/episodes） |
| dc6ef7b9 | 全聊天流单层滚动（参数卡不吞手势）；ParticleSeaWaiting 回退直绘 |
| 9a1cbf6d | 纯测试（钉死派遣手册第 20 条）；能力属非程式码（运营规则） |
| b01a1c47 | 分镜 21 栏契约＋双白名单；缺栏回 missing[]+complete:false |
| c194f5f4 | AID 37 enum 值域库入库（纯常量，尚无消费端） |
| 0b2c2843 | 成片产物索引（可列举可回溯）；明确不做在线剪辑／时间轴 UI／@webav |
| 95c32abb | 曾交付配音音色库＋TTS adapter（同批 0c418b53 全数移除）；遗留边界语义：63 音色在网关塌缩成 alex |
| 90e7df76 | 文档：NOTICES 追加刀 2/刀 3 引入记录；验收纪律修正为三条并跑 |
| 0c418b53 | 移除 95c32abb 全部内容（语音库／adapter／voiceCode／透传链）；净新增能力＝0 |
| f603864c | agent op set_project_meta（建作品／建剧集）；作品／剧集面板 CreationFlowPanel |
| 84a3ce7a | 分镜节点卡渲染（21 栏四组、shotNumber 徽章、Group 场景名＋镜数） |
| 9e438082 | 画布「镜头词库」选词入口（多选插入提示词） |
| 49bffcd7 | 21 栏→storyboard_qc_17 桥接；hasUsableQcValue 修掉谎报可过 |
| 7fd7bb0f | 文档：「只做一半」审计＋前端对称差报告（无新可呼叫能力） |
| 7a4bbcc0 | aid-enums 消费端接线：剧集状态推导＋作品类型值域单一真源；拒接 3 个假对位 |
| 349150f3 | 成片导出闭环：gateway 登记、HMAC ingest、film_export 落帐、幂等键、静态服务、migration 018、tenant 属主维度 |
| f9660201 | 修复：Bun Hash.update 不吃 ArrayBuffer；边界语义（登记静默失败而导出成功） |
| c86dd01d | 工具卡中继态；思维链预设展开；在途反馈；文字帧并批；中止合 turn.done；IME Enter 修正 |
| 3ca62d82 | 文档：单独重启 opencode-server 令 gateway 盲眼 4 分 21 秒（部署纪律） |
| 84952257 | 纯同步：以 VPS 生产镜像作重构基线（无新能力） |
| f22dd523 | 纯同步：重立基线至 VPS live b65e5966＋拉齐全量源码树（含 director-engine/editor 等既有能力的镜像，非新增） |
| c8bfe4eb | 纯重构：gateway 第一阶段无损切割（10029→8225 行，7 模组） |
| bcd57a72 | 纯重构：第二阶段无损切割（8225→272 行组合根，18 模组）；行为零变更 |
| eb1dcede | 用户／助理气泡样式对调（灰底用户＋无底助理） |
| 75c25e24 | Google OAuth 登入；Jev 输入闸／路由权威；音乐 yue2 管线；桌面 Electron 薄壳；AgentPlanCard；shortdrama QC 时长放宽；gateway 渠道同步 |
| d25aed7d | Jev 额度断路保险：Laya 兜底判定层（fail-open）＋laya-server Python／Dockerfile |
| f1d5dd98 | Laya ONNX 轻量版服务（无 torch、RSS 1.61GB、契约同构、校准逐位吻合） |
| ac0dfa0d | 工作流完成记忆沉淀回路（persistWorkflowMemory＋闸门＋ownerKey 收敛） |
| 06baf18e | 工作流历史卡＋DAG 缩图＋三档位筛选＋RerunDialog 费用显示＋Lightbox 节点币数＋工作流可重跑 |
| 8fff4595 | 记忆库第五类型 workflow（TYPE_VALUES＋curator prompt 两处同步） |
| 5881aff6 | 缩图重写对齐画布节点卡；sharp 隔离 dag-png-server；.vercelignore 部署体积守卫 |
| 8a3a6728 | serverless 中文字型随程式码部署（子集 5MB＋fontconfig 于 /tmp）；失败不挡 |
| 7ae66e5b | 收编 09-20 已部署改动（subagent 停止闸、workflow 完成推送、模板骨架等 12 档） |
| 581a7c6a | 部署前对账脚本（漂移即挡）；附带清理拆档前残留平档（无新能力） |
| 5a7b9a90 | TaskStatus 单一语义表；28 条 ERROR_RULES 单表；opencode 接缝 helper 迁移；recon 补子目录盲区 |
| 8b08d285 | 任务状态→UI 语义单表（未知值保守判失败） |
| 0d3e12af | 补实装 stopped 状态（SSE 契约与三处 union；中性结算；灰点徽章；已停止） |
| cef439a0 | 画布节点事件写穿 canvasStates 快照（双轨收口、last-write-wins 幂等） |
| 07e3e42e | 纯运维修正：recon VPS 侧排除 refactor-audit.ts |
| d59d3976 | 工作流模板注册表 6→13（7 模板齐平 novel_film）；拆档零漂移；模板卡 ID 可解析；promptNotes 配方级 |
| 3525afcf | 打字路径骨架卡富化（deliverable/gate 贯通后端模板→SSE→画布）＋节点卡胶囊渲染 |
| 95a6994e | gate 栏位双形态 string\|boolean 修撞名；NodeBody 分流渲染；白名单保留 boolean |