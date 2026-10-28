# 支付宝智能体涌现奖：Eimu 复用地图

> **2026-10-18 用户否决记录：本报告中独立 `/merchant-studio` 填表/手动拼装方案已否决。相关 7 个本轮新增源码文件已撤回，不再作为参赛方向或已交付能力。原因是它把 Eimu 全自动 Agent 缩成需要用户搬素材的低配工作台。下方仅保留研究证据与决策历史；后续以既有全自动 Agent 为基底，完整保留自主研究→策划→工具执行→独立评审→返工→真实交付。**

更新：2026-10-18。任务边界：只读本地源码、读取指定记忆、解码已存在的本地成片；未调用生成接口、未读取凭证、未修改生产源码、未部署。本文是工程选型证据，不是官方规则核验或参赛作品验收。

## 决策

**最终主赛为支付宝智能体涌现奖 375，作品收口“小店出片”：商品原图独立图层 + 确认事实绑定 + AI 背景指令 + 多规格 PNG/可编辑工程/真实动态图导出。** 赛务核验由主代理负责：375 禁重复投递，380 身份限制使其退出本轮主线。本文下方旧物故事仅保留为候选对照，不代表继续开发。工程不另造聊天、ZIP 或付费生成服务；独立入口隔离在 `/merchant-studio`。

新增核心引擎 `src/lib/merchant-studio/{types,project,render,client}.ts`：复用 `exportShotsZip`；确认绑定当前事实及双图来源哈希，改价、换图后重新确认；PNG/JPEG/WEBP 解码前尺寸闸与实际解码/哈希核对；商品等比 contain 且受保护不被文字侵占；3 规格 PNG、完整项目 JSON 与三段 9 秒真实浏览器录制。后者是动态图，不是上游生成视频，输出扩展名按实际编码选择 WEBM/MP4。免费 `/api/agent/optimize-prompt` 只生成背景指令，usedAgent=false 如实标规则，绝不显示“AI 已生图”。作者未执行用户路径验收，留独立 Hacker 验收。

既有 `format-crops` 的生成尺寸是 1024 系列，不能冒称所需 1080×1080/1440/1920。因此新引擎按明确交付规格定义 Canvas 尺寸；没有复制裁图算法。商品层不裁图、不重绘，保留原始 data URL 与 SHA-256，但不声称缩放后像素逐位相同。

旧物故事真正新增的贡献应是：**每句叙述能回到口述时间戳或照片，未知信息明确保留未知；用户纠正一个事实后，受影响的镜头和字幕能单独更新。** 不是把照片丢进模型做一段“看起来像回忆”的视频。

小店方向的新增贡献应是：**商品保真与多规格可编辑交付可被用户核对，单一卖点变更只更新受影响的素材。** 现有模板的“零形变”文案没有提供这个保证。

## 现有因果链与证据

以下位置均相对仓库 `/home/lenovo/Desktop/image-app`。标记“读码”只证明本地实现存在，不证明当前生产运行。

| 链路 | 可复用实现 | 可做什么、边界 | 本轮证据级别 |
|---|---|---|---|
| 消费者入口 | `src/app/agent/page.tsx:19` | `/agent?q=` 转到首页 `?agent=1&q=`；q 最多 500 字。可用于初次引流，不能承载完整作品状态 | 读码 |
| 模板可发现入口 | `src/lib/agent-templates/index.ts:5`、`:14` | 卡片 metadata 与执行 payload 分离；新增模板需要卡片、payload 与两个索引。应复制既有形态，只改数据与文案 | 读码 |
| 创建持久会话 | `src/app/api/agent/sessions/route.ts:45`、`:113` | 解析登录用户，注入画像/有权访问的资产/记忆，代理至 gateway。不要让比赛页面把 B 端 key 下发浏览器 | 读码 |
| 附件入会话 | `src/app/api/agent/sessions/[id]/attachments/route.ts:38`、`:57`、`:71` | multipart 的多个 `file` 上传，返回文件名/path/size/mime；Vercel 单请求约 4.5MB 限制明确写在 `:18`，普通代理不适合长口述录音 | 读码 |
| 附件读取 | `src/app/api/agent/sessions/[id]/uploads-ticket/route.ts:1`、`:44` | 登录后签发读取票，由浏览器直读 gateway；不能把带票 URL 当永久公开证据链接 | 读码 |
| 大文件上传候选 | `src/app/api/uploads/sign/route.ts:1`、`:14`、`:45` | 现成两段式签发；VPS image-data backend 不支持签名会明确报错。因此不能未经现场确认就宣称解决长录音上传 | 读码 |
| 提交用户要求 | `src/app/api/agent/sessions/[id]/messages/route.ts:34`、`:59`、`:79`、`:104` | 提交 content，附 canvas_state、session_directive。directive 限 4000 字，画布摘要限 128KB；适合注入题目约束与当前项目引用 | 读码 |
| 声音到词级来源 | `deploy-staging/opencode-runtime/tools/video_transcribe.ts:7`、`:33` | 音视频本地 ASR、词级时间戳；语言要求具体代码，URL 下载有 25MB 限制，最长 1800 秒；缺失时间不造假，ASR 未启动会明确失败 | 读码，未证明现时 ASR 活着 |
| 可编辑产线声明 | `src/lib/workflow-dsl/schema.ts:21`、`:46` | steps 有稳定 id、kind、needs、tool、gate、meta；适合“证据整理→事实确认→脚本→镜头→配音→成片” | 读码 |
| DSL 写回真实画布 | `src/app/api/v1/canvas/workflow/route.ts:1`、`:42`、`:72`、`:88` | 已有 B 端写图接口，复用编译器/reducer/项目持久化；owner 命名空间隔离。站内比赛页优先现有 session 工具，外部程序才用此端点 | 读码 |
| 媒体任务收盘约束 | `deploy-staging/gateway/canvas-write-gate.ts:18`、`:109` | 已有多步媒体意图的默认骨架与 workflow_write 指令；新项目必须如实落画布，不以一份文档链接冒充流程 | 读码 |
| 单节点重做 | `src/app/api/agent/sessions/[id]/workflow-node-rerun/route.ts:30`、`:48`、`:60` | session/workflow/node 明确绑定并转发重跑；“只重跑受影响部分”还需要新项目维护事实与节点的依赖映射 | 读码 |
| 字幕、混音、成片 | `deploy-staging/gateway/workflow-gw.ts:864`、`:883`、`:904`、`:948`、`:975`、`:989`、`:996` | 已有 assembleFilmNode：只接受完成的上游 video，缺镜拒绝；从同 role 文本取字幕，导出 16:9/720p/24fps，再混音。照片本身不能直接交给它，需要图片到片段桥接或现有 timeline 路径 | 读码 + 下述旧成片独立容器证据；未跑新用户路径 |
| 多规格母带候选 | `src/vendor-bridges/opencode-tools/timeline_master.ts:20` | 现成 check/export，竖版/横版/影院版，字幕/调色/封面；说明写明 xfade 转场不烧录、public_url 不直接挂。不可将 master 的本地路径直接当交付 URL | 读码 |
| 成片公网交付桥 | `deploy-staging/opencode-runtime/tools/video_upload.ts:9`、`:39` | workspace 内成片或 URL 入库并返回 URL。不能使用沙箱私有 `/tmp`；最大 200MB | 读码 |
| 媒体下载 | `src/app/api/media-download/route.ts:30`、`:46` | 登录、源站白名单、防跳转，流式下载。声明上限 100MB，与 video_upload 200MB 不一致；比赛成片应压到 100MB 内或补统一出口 | 读码 |
| 打包下载 | `src/lib/export-zip.ts:51`、`:69` | 已有 ZIP 打包与系统保存，媒体+JSON 清单可一起交付；不等于完整可安装作品 ZIP | 读码 |
| 成片索引 | `src/lib/generation-core/master-ingest-service.ts:148` | 母带落 job + output artifact，幂等避免重复索引，可作为交付目录来源，不要另写一份假任务账本 | 读码 |

### 本轮真正检查到的已有成片

本地资产 `eval-e2e-final-cut-1002/evidence/r2/film-subtitle-1002.mp4` 存在，大小 9,895,501 字节。本轮以 `ffprobe -v error -show_entries format=duration,size:stream=codec_name,width,height,r_frame_rate -of json <文件>` 实际读取容器，得到 H.264、1280×720、24fps、AAC、30.263220 秒。它证明已有可解析影音成片，不证明本次作品效果，也不证明当前生产端到端成功；本轮没有视觉或听觉审核。

指定记忆 `2026-10-02-film-subtitle-title-burnin-wiring.md` 记录过同一成片的实际字幕帧证据；`2026-10-02-e2e-final-cut-eval-and-residual-repair-round.md` 还记录响度、尾帧冻结、报价与实扣差异、长排队和唤醒失败。不能只引用成功容器而抹去这些历史限制，也不能凭历史故障断言现时仍坏。

## 方向一：旧物故事档案馆

### 复用形态

输入 3–8 张旧物/家庭照片，加短口述或文字。输出 60–90 秒家庭微纪录片、可纠正的时间线、逐句来源清单和可下载归档包。原图/原声是史料，AI 修复/重建画面必须明确标注为生成演绎，不能把生成物装成历史照片。

最短链：附件上传 → ASR/文字整理 → 事实卡（照片/原声时间戳支撑，日期未知允许未知）→ 用户确认 → 脚本和镜头 DSL → 复用剪辑/字幕/混音 → 公网媒体 URL → MP4 + 原始来源清单 + 可编辑工程 JSON。

### 真缺口与最小实现规格

1. **独立入口，而不改聊天组件。** 新目录 `src/app/old-things/page.tsx`、`src/components/old-things/`、`src/lib/old-things/`。复用已有登录与 session API，页面只承担上传、事实确认、产物与来源浏览。不能把老聊天组件复制进来修一套。
2. **故事来源契约。** 独立 `StorySource`（来源 id、照片/口述、相对路径或受控媒体引用、音频时间区间）、`StoryClaim`（原句、来源 id、确定/待确认/生成演绎、用户修订）、`StoryShot`（claimIds、sourceIds、workflowNodeId、版本）。首次只做家庭内一次作品，不先造组织/全局记忆系统。
3. **真正的事实纠正流。** 修改 claim 要保留旧版本，标脏依赖它的字幕/镜头/成片，复用节点更新和重跑。改一个年代不得无理由重做全部图像、重新付费。
4. **口述到照片的证据绑定。** `video_transcribe` 提供词时间戳，但“这句指的是哪张照片”没有现成可靠契约。让用户选图并对照原声确认；低置信度必须待确认，不能让模型随便猜年份和亲属关系。
5. **照片到时间线片段桥接。** `assembleFilmNode` 只吃 video。需要复用现有 timeline/FFmpeg 轮子把真实照片变成可剪辑片段，再接已有装配。照片缓慢运动可作为档案片风格，但成片规格若宣称生成镜头必须真的有生成镜头，不能拿静帧冒充。
6. **归档与权限。** `asset_provenance_archive` 不是家庭史证据库；上传票不是永久链接。为 project 保存来源清单，导出给用户时按授权带原图/原声。比赛展示样例必须有所有者许可并做姓名/住址等去标识，不能默认公开家庭资料。

### 能力边界

`deploy-staging/opencode-runtime/tools/asset_provenance_archive.ts:27` 的来源只含 prompt/model/seed/created_at/version/related_job，`:118` 对直给 URL 全记 missing。它回答“AI 素材怎么生成”，不回答“这段家族史凭什么为真”。后者是本作品真正要增加的能力。

### 完成的真实判据

一个独立 Hacker 使用获准照片与真实口述，从入口完成上传、事实纠正、成片下载；任抽三句旁白能点回对应原声/照片；故意输入相互冲突年代时作品保留冲突并要求核实；修改一句后旧版仍可找回，未受影响素材不重复生成；导出 MP4 真能播放且来源包完整。这些须产生真实输出，不新增测试脚本代替。

## 方向二：小店可控一致性营销套件

### 已有轮子和误读风险

- 现有卡片 `src/lib/agent-templates/ecommerce-launch-pack.ts:3`，harnessTemplateId 为 `ecom_launch`，有产品锁、场景包、模特、主视觉、多画幅和交付。
- 执行模板 `src/lib/agent-templates-payload/ecommerce-launch-pack.ts:16` 要求真商品原图，`:17` 明写“纯 image/text，无 audio/film”。它不能直接被宣传为一键海报+视频。
- `deploy-staging/opencode-runtime/tools/product_lock.ts:12`、`:21`、`:49`：VLM 抽 DNA 后文字重绘白底参考，seed=null；不是像素级商品锁定。
- `deploy-staging/opencode-runtime/tools/product_conditioned_generation.ts:12`、`:22`、`:52`、`:62`：优先 edits，失败回退文字锚定；返回实际机制与 VLM pass/warn，不保证绝对零形变。严格商品保真交付必须拒绝把这个回退当无损成功。
- `src/lib/canvas/format-crops.ts:21`、`:45` 已有多规格裁切/扩图规划；`src/lib/canvas/format-crops-exec.ts:48` 已有 sharp 裁图。不是每个画幅都需要重新生成，但裁切可能损失内容，不能说“自动重排”已经实现。

### 最小新增

独立 `src/app/shop-kit/page.tsx` 与 `src/lib/shop-kit/`，复用原图上传、商品编辑工具、现有版位/字幕排版/剪辑/ZIP。用户先确认商品不可变部分与卖点来源；保真主图直接复用原图抠图合成，生成只作用于背景/装饰；产出一组图片 + 一支 15–30 秒真实成片 + 版本化文案/版位清单。对涉及商品变形的结果明确拒交或转人工确认。

**比旧物方向短的地方**：已有电商模板和图像管线；**更难赢的地方**：通用营销工具供给多，必须用真实店主、真实 SKU、独立盲评和省时/改稿证据证明价值，不拿 Eimu 内部账号或历史流量包装商业落地。

## 其他强复用方向

| 方向 | 现成轮子 | 为什么不优先 |
|---|---|---|
| 小说/角色 IP 概念预告片 | `src/lib/agent-templates-payload/novel-film-pipeline.ts:16`，结构化剧本/角色/美术/分镜 + 现有成片管线 | 角色一致性、连续视频成本和版权材料授权要求高；旧模板 `:17` “成片未通”的话与现有装配实现冲突，必须按运行证据裁决 |
| 短剧海报与宣发素材 | `src/lib/agent-templates/shortdrama-poster-line.ts`、同名 payload | 易复用，但同样接近已有营销能力，需真实垂类需求与显著实质更新 |
| 纯愿望生图/宠物模拟 | 现有通用生成与编辑 | 最短 demo，但不能仅凭能出图证明技术贡献或需求闭环；不是当前最强升学叙事候选 |

## 记忆与现场冲突

1. 旧模板声称配音/成片不可用，当前本地 `workflow-gw.ts:864` 已有成片实现，且已有可解析历史成片。应更新入口文案与接线认知，不能据旧话重写管线，也不能据本地源码声称生产已部署。
2. “可执行、可评价、可迁移工作流是护城河”来自 `2026-10-03-eimu-moat-arc-and-history-deliverable.md`，其中 30 条高质量 workflow 与 15% 复用目标未有达成记录。比赛材料应只引用本作品能演示的纠正/复用行为。
3. `2026-10-04-eimu-real-demand-baseline.md` 的真实流量/付款边界必须保留；后端零付款行不证明零收入，历史平台账号和生成量也不等于本参赛题目真实用户。
4. `2026-10-09-agents-subagent-dispatch-by-host-env.md` 已将旧“全部 DeepSeek”改为按宿主环境原生派工；本任务按当前环境独立代理执行。

## 下一片可直接派发的实现规格

选题确认后，首片应是**独立入口 + 来源/claim/shot 数据契约 + 本地用户可编辑状态 + 现有 session 接线**，只新增所选方向目录；禁止修改当前有未提交改动的 `AgentChatPanel.tsx`、`AgentMarkdown.tsx`、`AgentMessageBubble.tsx`、artifact-files 及 package 文件。原料必须使用有明确授权的样例，不从私人家庭相册任取材料。

后片接上来源引用的 DSL 和现有成片轮子，随后换手 Hacker 跑真用户路径。没有真实口述/素材和独立用户证据前，只能报告“实现候选/已有轮子”，不能报告“可参赛成品”“得到冠军保证”或“已证明社会效益”。
