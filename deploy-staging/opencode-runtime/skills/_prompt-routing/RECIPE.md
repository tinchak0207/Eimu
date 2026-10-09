# 路由细则（AGENTS.md §1 移出的按需载体）

> 本档是 AGENTS.md「§1 路由决策表」移出的**细则正文**（逐字保留，只改存放位置）。
> AGENTS.md 每轮只留「触发词 → 域 → 本档 §节」的指针；模型判域后**动该域前先读对应节**。
> 音乐域不外移（唯一活链路）：音乐细则在 `skill music-director`；本档 §音乐 仅保留其路由行以便对表。
> 上层手册（工作区根，与 `attach/` 同框）：`attach/workflow-video-rules.md`（影片/工作流）、
> `attach/attachment-handbook.md`（附件）、`attach/film-delivery-handbook.md`（成片）、`attach/storyboard-qc-handbook.md`（分镜门）。

## §图片

| 用户意图 | 首选路径 | 备援 |
|---|---|---|
| 画图（想法层面，无精确 prompt） | `image_generate`（报价经 `subagent_dispatch` 派对应域 Expert 执行 `image_quote`；prompt 需增强时用英文六槽 §2 自行扩写后直接喂 image_generate） | agent-pixai 免费池（**默认不选**：池长期不可用，仅 image_generate 全模型不可用时考虑） |
| 画图（用户给了完整 prompt/指定模型） | `image_generate` + model-status 确认可用 | — |
| 改图/参考图编辑 | `image_edit`（平台级，描述写英文六槽） | — |
| 放大 | `image_upscale` | — |
| 看图/读图 | `read_image` 工具（原生，一步完成：传 image_path 相对路径或 image_url，原图直接进你的上下文、由你自己看）；要打分/审美点评改用 `vision_analyze` | — |
| 写真/人像摄影 | `skill nuyoah-xiezhen-prompt`（§2 六槽英文规则） | — |
| 参考图反推 | 先用 `read_image` 工具提取可见事实，再 `skill nuyoah-image-reverse-prompt` | — |
| 广告/UGC/产品 shot 提示词 | `skill ai-ad-prompt-guide` | — |
| 选模型/模型失败找替代 | GET /v1/model-status（15s 快取内复用，不要重探） | — |
| 配音/台词语音（TTS） | `tts_speak` 工具（上游暂缺时诚实报错） | — |

## §影片

| 用户意图 | 首选路径 | 备援 |
|---|---|---|
| 复用素材/3D 场景/视频 prompt/人物动作（建模/场景/风格/视频/运镜/动作复用） | 先 `asset_search` 查库（免费）：视频/运镜/风格/prompt 类查 video-gen-prompts/seedance-prompts/nano-banana-prompts 包，命中引用原文；人物/动作类查 mhr/cmu-mocap 包；3D/素材类查 blender-3d-assets 与用户资产包；查空才自编自造，命中用 `asset_activate` 取内容注入 image_generate / workflow（3D 用途经 `subagent_dispatch` 派对应 3D/动态域 Expert 执行 `blender_exec`） | — |
| 生影片（单镜） | 报价经 `subagent_dispatch` 派 `expert:"video-director"` 执行 `video_quote`（免费）→ `image_generate` 影片用 model（/v1/videos/generations，model-status 确认；**硬规则：严禁 <10 秒短档，按 attach/workflow-video-rules.md §4b 时长最大化，seedance-2.0 选用 10–15s、seedance-2.5 选用 10–30s**） | — |
| 生影片（多镜/长片） | `workflow_*` 工具（`workflow_start`／`workflow_update_node`／`workflow_status` 已断路，经 `subagent_dispatch` 派对应域 Expert 执行；其余 workflow_* 直调）→ **先读 attach/workflow-video-rules.md** | — |
| 影片拆解（链接或上传影片：讲了什么/分镜/台词/反推提示词/翻拍/去字幕/下载） | 链接先 `video_fetch`（首次 action=prepare）落本地 → `video_analyze`（场景切点+代表帧+词级台词；提示词反推回 vlm_unavailable 时对代表帧跑 read-image 补）；只要台词稿 `video_transcribe`；去字幕 `video_desubtitle`；翻拍/换角重做 `video_remake_plan`；抽帧/切段/探针 `video_evidence`；台词折算秒数写进分镜 `video_measure` | ffmpeg 抽帧 + read-image |

## §剪辑

| 用户意图 | 首选路径 | 备援 |
|---|---|---|
| 剪辑/时间线调整（拆分/修剪/变速/重排/删除/锁定/分组/转场/加轨） | 经 `subagent_dispatch` 派 `expert:"editor"` 执行：`timeline_query(what=state)` 摸底拿真实 clip_id → `timeline_ops` 批量原子执行 → 回读返回的 diff 确认 | run_py+ffmpeg 单次直剪（仅当用户只要一个现成片段文件、无多步剪辑语境） |
| 镜头语言选择（景别／机位／焦段／光线／运镜／色调／构图／摄法） | `skill lens-language` 取词条原文，按 §2 六槽组 prompt（野兽模式：写进派给 screenwriter／video-director Expert 的 spec，指名它们取词条） | §2 自行扩写（词库无命中项时） |
| 节奏体检/剪辑质量自查 | 经 `subagent_dispatch` 派 `expert:"editor"` 执行 `timeline_rhythm`（先修 must/should 中 clip_id 明确的 flags，再按 curve 微调） | — |
| 剪辑回退/撤销 | 经 `subagent_dispatch` 派 `expert:"editor"` 执行 `timeline_query(what=versions)` 查可用版本 → `timeline_restore` | — |
| 剪辑质检/lint（黑帧/白闪/爆音/静音段/音量跳变/音画时长错位） | 经 `subagent_dispatch` 派 `expert:"editor"` 执行 `timeline_lint`（**闸门：must 级未清不得交付、不得导出**） | — |
| 混音/配乐音量平衡（voice/bgm/sfx 三轨 + ducking + 响度报告） | 经 `subagent_dispatch` 派 `expert:"editor"` 执行 `timeline_mix` | — |
| 调色/风格/转场/字卡（滤镜四滑杆、转场样式、ASS 字卡） | 经 `subagent_dispatch` 派 `expert:"editor"` 执行 `timeline_style` | — |
| 导出成片/画幅/封面（竖屏/横屏/影院比例、封面帧） | 经 `subagent_dispatch` 派 `expert:"editor"` 执行 `timeline_master`（预设 portrait_916 \| landscape_169 \| cinema_239；must 未清 export 直接 400 拒） | — |
| 剪辑清单/EDL（素材→镜头→顺序的显式清单，语义层交底） | 经 `subagent_dispatch` 派 `expert:"editor"` 执行 `editing_manifest` | — |
| 旁白/口播先行（先定音轨再让画面跟音） | 经 `subagent_dispatch` 派 `expert:"editor"` 执行 `audio_first_timeline` | — |

**工具优先级**：原生工具（image_* / canvas_* / workflow_* / tts_speak / timeline_*）> bash curl。原生工具自带探测与扣费，不用 bash 重造。剪辑纪律：改动时间线一律 query→ops→回读 diff，禁止凭记忆猜时间线状态；多步变更加进同一 ops 批次（原子语义，锁定片段整批拒绝是保护不是故障）。节奏/lint 报告只动手修 must/should 且 clip_id 明确的项；越轴/动作连续性/运动追踪/口型同步是诚实 unsupported，不许承诺。交付前必过 `timeline_lint`，`qc` 栏须为 lint/master 真实结论。**执行者**：剪辑域任务一律经 `subagent_dispatch` 的 `expert: "editor"` 派下去，主会话不得用 bash+ffmpeg 代办（时间线工具的本轮持有面与你的能力断路以系统每轮注入的【环境事实·运行时】段为准，不要凭本文件或旧记忆推测）。

## §画布

| 用户意图 | 首选路径 | 备援 |
|---|---|---|
| 工作流某个节点不满意/连错线 | 改参数 `workflow_update_node`（已断路，经 `subagent_dispatch` 派对应域 Expert 执行）→ 只重跑该节点 `workflow_rerun_node`；断开错连 `workflow_disconnect` | — |
| 画布产线：改步骤/加环节/改依赖/退回旧版（像改代码一样改工作流） | `canvas_get_state`（直调）读 `dsl`（产线的**可逆声明**）→ 改 `steps` → `workflow_write` 整份交回（全图校验→原子落图，人拖过的位置不动）；退回某步内容：`workflow_history` 查该节点版本 → `workflow_rollback` 指定 version | 规则见下方「`workflow_*` 前缀横跨两个真相世界」节。 |

> **`workflow_*` 前缀横跨两个真相世界，不可混用**：
> - **world2 后端执行图**（打 `/internal/workflow/*`）：`workflow_start`／`workflow_add_node`／`workflow_connect`／`workflow_generate`／`workflow_status`／`workflow_update_node`／`workflow_rerun_node`／`workflow_disconnect`——「某节点不满意／连错线」走这族（其中 `workflow_start`／`workflow_status`／`workflow_update_node` 已断路，经 `subagent_dispatch` 派对应域 Expert 执行；其余直调）。
> - **world1 画布产线**（画布上看得到的产线，节点 id 形如 `wf-…`／`tpl-…`）：改步骤／加环节／改依赖／退版走 DSL 三件——`canvas_get_state`（直调）读 `dsl` → `workflow_write`；退版 `workflow_history` → `workflow_rollback`。**虽挂 `workflow_` 前缀，属 world1，别拿 world2 的 `add_node` 去改它。**`dsl` 已自动覆盖存量画布产线节点（含未带产线身份键的提示词节点与生成配置节点），读到就是骨架、直接改 `steps` 整份交回、`meta._origin_node_id` 原样带回；**`dsl` 为空**有两种原因：①画布上确实没有任何产线节点；②画布太大、骨架超出快照预算——此时摘要带 `dsl_omitted: "budget"`（**不代表没有产线**）；两种情况都先看节点清单：用 `canvas_apply_ops` 逐节点改，或按画布现状写整份 source 收编（**别另建平行节点**）。
> - **改画布产线（节点在 `dsl` 里）→ 一律 `workflow_write`**（幂等；读 `dsl`→改 `steps`→整份交回）。单步或多步、改 prompt 或改结构，都是它。**`dsl` 已自动覆盖存量画布上的产线节点（含未带产线身份键的提示词节点与生成配置节点），每步的 `meta._origin_node_id` 由读面自动填好——原样带回即可，不要自己发明。**改提示词要改「生成步」（kind=image/video 的那一步）的 `prompt`**——生成面板与重跑读的是生成节点自身的 `metadata.prompt`；若上游另有「提示词节点步」持有同一段提示词（画布把提示词存了两份），把两处改成同一段：只改提示词步不会改变生成输入。节点不在 `dsl` 里，或要动 DSL 表达不到的栏位（位置／尺寸／手调连线）→ 才用 `canvas_apply_ops`（`update_node`／`connect_nodes`／`delete_connections`）。**禁手拼 `add_node`＋`connect_nodes` 搭整条产线结构**（绕过编译器、破坏可逆性）。**
> - **禁手拼 `add_node`＋`connect_nodes` 搭整条产线结构**（绕过编译器、破坏可逆性）。

## 1.6 画布产线分流（world1 画布链；先看这张表）


| 你要做什么 | 工具链（照抄，别换） |
|---|---|
| 改步骤内容或结构（**单步微调也算**） | `canvas_get_state`（直调）读 `dsl` → 改 `steps` → **`workflow_write`** 整份交回 |
| **退回某步旧内容** | `canvas_get_state`（直调）／**`workflow_history`** 拿节点与版本 → **`workflow_rollback`** 指定 version |
| 只动位置／尺寸／手调连线，或节点不在 `dsl` 里 | `canvas_apply_ops`（已断路，经 `subagent_dispatch` 派对应域 Expert 执行；`update_node`／`connect_nodes`／`delete_connections`） |
| **禁** | 手拼 `add_node`＋`connect_nodes` 搭整条产线 |

拿不到画布状态（`no_canvas_state`）时，先请用户打开画布；**这不改变工具选择**——别因为读不到状态就换别的工具。


## §3D

| 用户意图 | 首选路径 | 备援 |
|---|---|---|
| 3D/建模/搭场景/产品转台/白模/等距 3D 图标/室内建筑/机位预演 | `skill blender-director` 取配方 → 经 `subagent_dispatch` 派对应 3D/动态域 Expert 执行 `blender_exec` 建模（先 `asset_search` 查 blender-3d-assets 现成件）→ `blender_render`（eevee 快稿；**转台/360° 直接传 `turntable: true` 出 mp4**，别翻 .opencode 源码或本机找 blender 二进位——渲染在远端桥上）→ 交付返回的 `public_urls`；要网页可交互预览加 `blender_export_gltf`。**主动选用**：画图需求要「精确几何／同一物体多角度一致／空间布局／产品 360°」时文生图做不稳，直接走 Blender（本机渲染，零扣费），渲染图可再 `image_edit` 风格化 | image_generate（只要氛围图、不在意几何时） |

## §商品图

| 用户意图 | 首选路径 | 备援 |
|---|---|---|
| 商品图（换场景/白底/抠图/详情页/主视觉/多平台尺寸/拼图） | 商品保形换场景 `product_conditioned_generation`；一个商品出多场景套图 `product_lock` → `scene_pack_batch`；抠图/透明底 `background_remove`；详情页排版 `detail_page_manifest`（卖点对图核验 `detail_page_evidence_map`）；主视觉 KV `canonical_key_art_lock`；一图出小红书/抖音/IG/X 尺寸 `platform_reflow`（自定比例 `multi_aspect_reflow`，多图批量 `aspect_reflow`）；九宫格/拼图封面 `shot_grid_batch`；展会物料规格 `exhibition_delivery_manifest` | image_edit |

## §服装

| 用户意图 | 首选路径 | 备援 |
|---|---|---|
| 服装/穿搭/模特试穿 | 平铺图提取单品 `garment_extract` → 锁版型 `garment_dna_lock` → 锁模特脸 `model_identity_lock` → `virtual_tryon`；手部崩坏 `hand_contact_repair` | image_edit |

## §产线

| 用户意图 | 首选路径 | 备援 |
|---|---|---|
| 照这张图的风格/统一风格出一组/情绪板找方向 | 风格锚 `style_anchor_sref` → 经 `subagent_dispatch` 派 `expert:"video-director"` 执行 `style_aligned_batch`（给用户看风格解构表用 `style_dna_extract`）；方向未定出情绪板 `moodboard_diverge_converge`（按情绪关键词出矩阵 `emotion_board_matrix`）；一组图查谁跑偏 `outlier_audit_regenerate`；草图先压线稿看构图 `sketch_lock` | §2 自行扩写 |
| 同一角色出多张/角色设定/三视图 | `character_dna_turnaround`（多角色 `cast_asset_lock`）→ `character_card_save` 存卡，后续生成注入 DNA 后缀；逐镜首尾帧经 `subagent_dispatch` 派 `expert:"motion-director"` 执行 `keyframe_render` | — |
| 小说/剧本/设定文本入场 | 经 `subagent_dispatch` 派 `expert:"screenwriter"` 执行：世界观 `world_bible_extract`；剧本场次表 `script_scene_parse`；长文分章 `doc_struct` | — |

## §其它

| 用户意图 | 首选路径 | 备援 |
|---|---|---|
| 交付/打包/要高清版 | 汇总成品链接 `delivery_assets`；放大并逐张验细节 `upscale_audit` | image_upscale |
| 选模型/模型失败找替代 | GET /v1/model-status（15s 快取内复用，不要重探） | — |

## §音乐（唯一活链路；细则在 `skill music-director`）

| 用户意图 | 首选路径 | 备援 |
|---|---|---|
| 作曲/配乐/主题曲/MV 主题歌/片头曲 OP/插曲/器乐 BGM/作词/哼唱/翻唱改编（音乐 prompt 与音乐单派工口径） | `skill music-director`（先载取口径：通路优先序＋时长硬约束前置揭露＋六层 style 公式 GENRE→MOOD→INSTRUMENTATION→VOCAL→STRUCTURE→PRODUCTION＋多版本偏好闸＋交付契约字段；纯音乐体检/交付装配单也先载） | — |

## §检索

## 1.5 检索分流（先看这张表）

| 你要查什么 | 用哪个工具 |
|---|---|
| 人物／新闻／公司／概念／事实查证／一般资料 | `search_web`（通用网页，**预设首选**；已断路，经 `subagent_dispatch` 派研究子代理执行，不填 expert） |
| B站中文影音／GitHub 开源专案／Reddit 英文社群口碑 | `search_aggregate`（平台站内，**必须指名平台**；英文平台用英文关键词） |
| 某一页的全文 | `smart_search` intent=`page` |
| 某程式库／框架的官方文档 | `smart_search` intent=`docs` |

- `search_aggregate` **只**涵盖 bilibili／github／reddit 三个平台的**站内**内容，不涵盖通用网页；其 `platforms` 默认值 `bilibili,github` 只是预设值，**不代表查询涵盖这两个平台**。人物／新闻／公司／概念类查询丢进平台工具＝搜索系统白跑（实例：查「澳门 陈天泽」人物名、只给 `platforms=bilibili`，会回一堆澳门交通／观光影片，与人物全无关系）。
- **除非用户明确要求某平台（B站／GitHub／Reddit）的站内内容，否则不要先挑平台工具**；通用网页一律先 `search_web`（经 `subagent_dispatch` 派研究子代理执行）。
- 三者结论都必须带 URL 出处，禁止只凭内部知识作答。
- **硬规则：通用网页意图不要用 `search_aggregate`；要平台站内内容不要用 `search_web`。禁止为了「比较哪个搜寻工具」而派子代理——照这张表选就好。**

