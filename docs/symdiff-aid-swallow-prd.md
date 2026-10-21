# PRD：吞下 AID 产品层单向对称差（2026-09-15）

> 定性：**能力建设**（不是修复）。
> 对象：`gzxx-2025/aid-server`（MIT，copyright 光子讯息(杭州)科技有限公司；231★/68 fork；v2.1.4 @ 2026-09-14）。
> 姿态：**少原创少错**——能直接拿就逐字拿（含授权标注），否则小改；禁止重写。
> 语言：本档正体中文；站点 UI 文案简体（PRODUCT.md 品牌规则）。
> 范围：使用者裁定的 5 项产品层单向差。**架构（私有化部署/在线升级器）与运营配套（实名/审核/公告/邀请返利）明确排除。**

---

## 使用者裁定（2026-09-15，追加）

### 刀 0 先行（已实作）

**依据**：2026-09-15 实测 `opencode.db` 1702 个真实 tool part——实装自订工具 **98 个，真被调用 43 个，零调用 55 个**。PRD 核心工具全部 0 调用（`storyboard_qc_17`／`script_scene_parse`／`timeline_master`／`editing_manifest`／`keyframe_render`／`memory_recall`）。

**三闸全漏诊断**：
1. **可达性**：`opencode.json` 显式禁用 ⇒ `storyboard_qc_17` 仅对 `screenwriter` 可达；135 次 dispatch 仅 68 次带 `expert` 栏。
2. **可知性**：`AGENTS.md` 提及 0 次的工具，调用数全为 0 或近 0。
3. **倾向性**：agent 偏好 `bash`(401) + `workflow_*`(669) 手搓，绕过封装工具。

**机制结论**：**货架必然长草，闸门与默认注入才是活路。** 唯一稳定活著的通道是 `skill`（62 次）。

**已交付**（本轮）：
- `src/lib/lens-language-library.ts`（142 条 / 12 类，MIT 逐字取自 AID `aid_prompt_lib`；9/9 契约测试绿、tsc 0 错）
- `tools/gen-lens-skill.ts`（单一真源生成 skill，禁手改两份）
- `deploy-staging/training/dao0-activation-mechanism.md`（闸门面 + 注入面落位说明 + 验收 SQL）
- `THIRD-PARTY-NOTICES.md` 追加 AID 条目

**验收判据**：部署后跑一次 ≥3 镜任务，`storyboard_qc_17` 调用数自基线 **0 → ≥1**，且 skill 载入出现 `lens-language`。**若仍 0 ⇒ 纪律层无效 ⇒ 立即转机器层**（`workflow_generate` 提交前硬跑门禁），不再加纪律文字。

### 使用者对四项候选的裁定

| 候选 | 裁定 | 理由 |
|---|---|---|
| ① `@webav` 浏览器端剪辑工具 | **不做** | 用户原话：「Eimu 卖的是 one-shot，提供在线剪片工具不仅工作量和调优负担极大，而且是打自己产品宗旨脸——AI 能做好的压根不需要人插手」 |
| ② 三级状态机（项目→剧集→分镜，7 步） | **做** | 产品信息架构，非架构 |
| ③ agent 契约运营化（27 契约） | **做** | prompt 可运营化，对应我方 7 个 persona 的演进形态 |
| ④ 素材提取僵尸回收 + 断点续传 | **撤回（我方已完整实作）** | 见 §11 更正五 |
| ⑤「容易拿的也拿」 | **做** | 纯资料资产零风险（enums、词库、schema 语义） |

**连带影响**：刀 4 的「时间轴 UI 新建」项**废除**（原 PRD §2 刀 4 与 §3.1「仅两处新建」中的 UI 一项不再成立）。刀 4 只保留**产物索引**（后端，小改）。**全 PRD 需真正新建的仅剩「运营提示词面板」（可选）。**

---

## 0. 一句话目标（可测量终态）

用户在 Emu 上能以**「作品 → 剧集 → 分镜 → 成片」四层持久实体**完成长叙事生产：剧集与分镜不再是对话里的临时状态，成片装配走既有母带导出闸；配音有可选音色库与角色绑定；镜头语言词库与 agent 契约以 AID 已验证的方法论资产入库；全程复用我方既有能力（VPS harness 8 工具 + `timeline_*` + `master` 闸 + `asset-pack` + `canvas/project-store`），**不新增第二套队列/历史/能力目录/任务系统**。

**判定成功（皆为可复验证据，非 HTTP 200）：**

1. 建一个剧集 → 有 ≥2 集 → 每集有分镜 → 重新整理/换装置后**全链仍在**（DB/Blob 查得到实体，不是前端记忆体）。
2. 分镜过 `storyboard_qc_17` 后可进成片；`timeline/master` 的 `check` 回 `ok:true`，`export` 产出 `master_*.mp4` 且 `probeRenderedVideo` 通过（解析度/时长/音轨）。
3. 角色可绑音色，`tts` 任务实际带 `voice_code` 落到 `artifact`（可查证），前端可试听。
4. 镜头语言词库（≥143 条 / 11 类）可用于分镜 prompt 组装，词条带真实出片缩略图；agent 契约文字入库且 agent 实际调用时生效（VPS 侧可 grep）。
5. **零重复扣费**：以上所有动作除正常生成扣费外无额外扣除（计费真源仍为控制面排帐）。

---

## 1. 现状（FACT / INFERENCE 标签）

### 1.1 AID 侧可拿资产（全部 FACT，已复验路径）

| 项 | 证据 | 授权 |
|---|---|---|
| 方法论本体 | `doc/提示词开发指南.md`（1307 行）：**27 个 agent 契约**（用途/输入/输出/开发要点/AI 生成指引）+ 硬规则（纯 JSON、引号换「」、私有标记 `@图片N[名称]` 原样保留、改提示词不改契约） | MIT |
| 分镜契约 | 标准版 **21 栏位**（`shotNumber`/`scriptContent`/`shotSize`/`cameraAngle`/`focalLength`/`cameraMovement`/`composition`/`atmosphere`/`colorTone`/`lighting`/`exposureBlur`/`soundEffect`…）；专业版 10 中文字段；`video_prompt_continuity_v1` 跨镜连续性 schema（`ROOT`/`EXTERNAL_PREVIOUS`/`BATCH_PREVIOUS`） | MIT |
| 镜头词库 | `aid_prompt_lib` **143 笔 / 11 类**：构图16、景别10、机位13、焦段9、色调15、光线24、曝光虚化16、运镜17、摄法13、画质保底3、负向词2。**每笔含完整中文详解**（例：「逆光，主光自主体正后方射入，边缘被勾出一圈轮廓光，正面转入柔和剪影。」） | MIT |
| 状态机 | `CreationStepEnum` 7 步（`GLOBAL_SETTING(1)`→`PREVIEW(7)`，另 `SERIES_DEFAULT(-1)`）；`GenModeEnum`（`economy`/`performance`）；`CreationModeEnum`（`i2v`/`multi`/`pro`/`auto_grid`，分 `standard`/`advanced` 组） | MIT |
| 类型系统 | 51 个 enums；核心：`AssetTypeEnum`(8)、`AspectRatioEnum`(13)、`EpisodeStatusEnum`(6)、`ProjectStatusEnum`(6)、`ScriptTypeEnum`(2)、`VideoStyleTypeEnum`(3)、`StoryboardShotDensityEnum`(3)、`AssetSourceTypeEnum`(3)、`ProjectTypeEnum`(2) | MIT |
| 产品表 schema | `aid_comic_project`(32栏，`aid-init.sql:1084`)/`aid_comic_episode`(23栏，`:1050`)/`aid_comic_script`(`:1187`)/`aid_storyboard`(21栏+`final_image_id`/`final_video_id`/`final_audio_id`，`:2846`)/`aid_role_prop_scene`(含 `active_name_key` 去重键)/`aid_ai_voice_library`(`:382`)/`aid_role_voice_binding`(`:2760`)/`aid_prompt_lib`(`:2301` 起 143 笔)/`aid_episode_editor`(`timeline_json`，`:1485`)/`aid_audio_asset`(`:575`) | MIT |
| 前端状态模型 | `stores/creation/{state,types,step3Slice,step4Slice,...}`（zustand 切片）：`currentStepIndex`/`currentProjectId`/`currentEpisodeId`/`currentProjectType`/`formData.{globalSetting,storyScript,sceneCharacter,storyboardScript}` 产品层语义 | MIT |
| 前端技术栈 | Next.js 16.3 / React 19.2 / Tailwind 4 / antd 6 / `@xyflow/react` / `@webav/av-cliper`（浏览器端剪辑，MIT，**我方不采用**） / zustand / quill | MIT |

### 1.2 我方现状（FACT，subagent 全库盘点 + 抽查复验）

**已有（可直接拿）：**

| 能力 | owner 档案 | 备注 |
|---|---|---|
| 时间线资料模型 + op DSL | `src/vendor-bridges/gateway/timeline.ts:68`（`Timeline{session_id,version,clips,audioTracks,audioClips,subtitles,bgm,aspect,markers,updated_at}`）、`:102`（`TimelineOp` DSL 14 种） | `TimelineClip extends EditorClip` 追加 `sceneId/shotSize/emotionTag/locked/group/costCoins/filter` |
| 母带导出闸 | `src/vendor-bridges/gateway/master.ts:30`（`MASTER_PRESETS`）、`:67`（blockers 聚合 lint must + mix `sync_errors`）、`:99`（`ok: blockers.length===0`）；`probeRenderedVideo` 强校验 | B6 已上线 |
| 混音/节奏/波形 | `gateway/{mix,lint,rhythm,style,waveform,beatDetect}.ts` | B5 已上线，内建 `loudnorm=I=-16:TP=-1.5:LRA=11` |
| 剪辑轮子本体 | `/home/lenovo/Desktop/kunpeng-vendor` @`872a58b`：`src/stores/editorStore.ts`(1317)、`src/lib/agent/tools/timelineTools.ts`(3997，69 工具)、`src/lib/editor/`(**12991**) | ⚠️ 在**仓外**；image-app 内经 `src/vendor-bridges/editor/`(2463) 镜像，记帐 `vendor/kunpeng/PATCHES.md` |
| 画布专案持久化 | `src/lib/canvas/project-store.ts`（Blob `canvas/{userId}/index-*`，世代轮替 2 代，上限 50）、`src/lib/canvas/types.ts:309` `CanvasProject`（含 `cardIds?`）、`/api/canvas/projects` | 已含 `normalizeProject` 逐栏白名单清洗范式 |
| 资产包（含 agent 注入） | `src/lib/asset-pack-store.ts:91`（Blob `asset-packs/{userId}/`）、`ITEM_KINDS` 7 类（`asset-pack-store.ts:117`）、`/api/assets` + `/api/v1/assets`、`src/lib/agent-assets.ts` | P0 已落地；`scene_3d`/`bpy_script` 是**同构追加先例** |
| 角色/场景/风格卡 | `src/lib/character-cards.ts:42`（`CharacterCard{id,name,kind,prompt,references[],negativePrompt?,loraIds?}`）、`character-card-store.ts:28` | 无 view/DNA/项目栏位 |
| 配方模板 | `recipe-templates.ts:45`（内建 10）、`recipe-template-store.ts:42`（用户级 50） | — |
| TTS（真出声那条） | `deploy-staging/gateway/index.ts:6939`（`TTS_UPSTREAM`）、`:7026`、路由 `:8729` `POST /agent/v1/tts` | 产物落 `TTS_AUDIO_DIR`，经 `TTS_PUBLIC_BASE` 公开 |
| 站点 TTS 骨干 | `src/app/api/v1/tts/generations/route.ts:60-88` → `submitGenerationCommand` → 能力闸 → scheduler | **上游 adapter 缺 minimax/did handler（缺口）** |
| DB migration 机制 | `tools/migrate-generation-db.ts`（`` `NNN_snake_case.sql` ``、只增不改、sha256 校验、advisory lock） | 最新 017，下一号 018；**用户资料默认不加表** |
| 吞并先例范式 | `src/lib/kunpeng-prompt-templates.ts`（MIT 逐字复制 + 白名单改写 + license/commit 标注） | 本次沿用此姿势 |

**VPS harness 真能力（119 工具，已实地取证）：**
`storyboard_qc_17`（**17 道门禁逐条落地**：`shot_identity`/`shot_order`/`scene_binding`/`duration_bounds`/`segment_duration`/`prompt_present`/`characters_bound`/`scenes_bound`/`character_lock`/`scene_lock`/`keyframe_present`/`last_frame_present`/`audio_anchor_present`/`aspect_ratio`/`dialogue_alignment`/`continuity`/`export_readiness`）、`script_scene_parse`、`character_dna_turnaround`、`style_anchor_sref`、`editing_manifest`、`last_frame_video_chain`、`audio_first_timeline`、`delivery_assets`、`cast_asset_lock`、`keyframe_render`、`timeline_{query,ops,lint,rhythm,mix,style,restore,master}`、`image_generate/edit/upscale`、`blender_*`、`music_gen`、`tts_speak`、`vision_analyze`、`subagent_dispatch` 等。

**缺口（FACT）：**

| 项 | 现状 | 性质 |
|---|---|---|
| 剧集/系列实体 | **无**（`drama-recipe.ts:67` 只有 `ep` 数字栏的纯函数 DTO，无持久化） | 产品层缺 |
| 专案→分镜→镜头层级 | **无**；三组互不相连平面 list（`boards-store.ts:9` IndexedDB、`director-engine/types.ts:75` gateway JSON、`shortdrama-domain:104` 纯函数） | 产品层缺 |
| 成片实体 | 产物有（`master_*.mp4` 落 `$WORKSPACE_DIR`），**索引无** | 产品层缺半 |
| 音色库（清单/试听/标签） | **无**；`voice` 只能字串直传，前端零音色 UI | 产品层缺 |
| 角色↔音色绑定 | **无**（`drama-recipe.ts:88 voicePrompt` 自由文本无消费端） | 产品层缺 |
| 口型同步 | 型别枚举 + `LIPSYNC_1_MODEL_ID` 占位，`lint.ts:95` 明文 unsupported，**无端点** | 产品层缺（**AID 有完整实作，见下**） |
| 运营可维护提示词库 | **无**；`/api/canvas/prompts` 是第三方远程聚合（GET 不鉴权、非用户级、运营改不动）；admin 7 面板无此位 | 产品层缺 |
| 镜头语言中文词库 | 部分（`DirectorShotScale` 六级英文、`CAMERA_MOVE_TO_PROMPT`）；**无 11 类 143 条中文详解词库** | 资产缺 |

### 1.3 主瓶颈（FACT，一句）

**能力层已齐（VPS 侧 17 门禁 + 8 短剧工具 + 8 时间线工具 + 母带闸全在），产品层缺「长叙事实体链」——用户无法把一次生成沉淀成「作品/剧集/分镜/成片」，因此长叙事只能停留在 agent 对话里。**

### 1.4 因果链（最短主线）

```
VPS 能力齐 → 但产品层无实体承载 → 长叙事状态留对话（易失、不可编辑、不可交接）
→ 用户做不成「系列」 → 对手的 7 步流水线成为唯一结构化路径
[最小干预] 扩既有 owner 承载实体（不新建系统） → 前端可视化 → 门禁/导出复用既有闸
```

---

## 2. Scope（5 刀，逐刀「直接拿 / 小改」判定）

**排序依赖**：刀1 → 刀2 → 刀3（刀3 依赖刀1/2 的实体）／刀4（依赖刀2 分镜）／刀5 独立可并行。

### 刀 1：作品/剧集实体链（`aid_comic_project`/`episode`/`script`）

**姿态：小改（扩 `CanvasProject`）**

- **轮子源档**：
  - `aid_comic_project`（32 栏，`/tmp/aid-init.sql:1084`）/`aid_comic_episode`（23 栏，`:1050`）/`aid_comic_script`（`:1187`）schema
  - 7 步状态机 — `aid-interface/aid-interface-main/src/main/java/com/aid/enums/CreationStepEnum.java`（**逐字拿枚举语义**）
  - 前端状态模型 — `frontend/web/stores/creation/state.ts`（`currentStepIndex`/`currentProjectId`/`currentEpisodeId`/`currentProjectType`）
- **白名单改写**：schema 去掉 `del_flag`/`create_by`/`update_by`/`remark`/`pending_*` 审核栏（我方无审核队列）；保留 `project_type`/`aspect_ratio`/`video_style_*`/`style_source`/`current_step`/`status`/`is_public`/`source_project_id`。
- **接线点**：
  - 型别：`src/lib/canvas/types.ts:309` `CanvasProject` **加 `projectType?`/`seriesId?`/`episodes?`/`script?`**（加法式，照 `normalizeProject`（`project-store.ts:53-72`）白名单范式逐栏清洗）
  - API：`/api/canvas/projects` 下开子路由（**不新建 store**）
  - 前端：canvas 侧新增剧集面板（挂 `canvas-workstation`，**不新建页面树**）
- **后端建设**：`timeline_json`/`current_step` 无需 DB migration（**走 Blob**）；仅当要「跨用户公开作品查询」或进计费时才加 `018_*.sql`。
- **Agent 培训面**：VPS `AGENTS.md` 尾部追加「作品/剧集实体」契约条（双源同步：`/opt/agent-harness/workspace/AGENTS.md` + repo 侧）；新增/修改 harness 工具后**必 restart `opencode-server.service`**（第三次实锤的坑）。
- **全链生效定义**：剧集实体 Blob 可读 + canvas 面板可见 + agent 调用 `canvas_apply_ops` 写入 episode 节点成功 + 重新整理仍在。
- **风险**：低。`CanvasProject` 是加法扩栏，既有 50 上限与世代轮替不动。

### 刀 2：分镜实体 + 21 栏位契约（`aid_storyboard`）

**姿态：小改（挂 `CanvasNode` 通道 + 直接拿栏位契约）**

- **轮子源档**：
  - `aid_storyboard` schema（21 栏 + `final_image_id`/`final_video_id`/`final_audio_id`）— `/tmp/aid-init.sql:2846`
  - **21 栏位分镜契约 + 硬规则** — `doc/提示词开发指南.md`（§2「分镜脚本与画师链路」）
  - 分镜栏位契约 — `doc/提示词开发指南.md` §2（21 栏位 + 纯 JSON 硬规则）
  - 17 道门禁判据 — **我方自有资产，非 AID**：VPS `workspace/.opencode/tools/storyboard_qc_17.ts:108-124`
    （**重要更正**：AID 全仓无「17 道门禁」；其分镜校验是约 24 条未编号的分散 `throw`/`log.warn`，
    散在 `rps/helper/Storyboard{VisualDirectiveValidator,SceneEnvelopeParser,ShotGroupPlanParser,DirectTaskSnapshotValidator,WriterContentParser}.java`。
    17 门禁是本平台 PRD 源文 `src/lib/shortdrama-domain/index.ts` 的 `STORYBOARD_GATE_IDS`，我方权威。）
- **白名单改写**：AID 用 DB 表；我方**改用 `CanvasNode` + `canvas_apply_ops`**（`src/lib/canvas/types.ts:290-298` 8-op DSL）。分镜栏位落 node metadata，**不新建 shot 表**。
- **接线点**：
  - `CanvasNodeType` 12 型已有 `image`/`video`/`audio`/`character_card`/`scene_card`/`prompt`/`reference`/`director`/`scene_3d`；**分镜 = `group` 节点 + 子节点 metadata**（或加一型，二选一，实作前先 diff reducer 影响面）
  - 写入走既有 `canvas_apply_ops`；读取走 `agent/sessions/[id]/canvas-state`
  - 压缩器白名单：**新 metadata 栏位族必同步两处**（`toNodeMetadata` + `compactMetadataForAgent`）——历史教训，漏一处则刷新后空壳
- **后端建设**：无 migration（Blob + node metadata）。
- **Agent 培训面**：把 21 栏位契约写进 VPS 侧 `storyboard_qc_17` 的输入 schema 与 AGENTS.md；`script_scene_parse` 输出对齐。
- **全链生效定义**：agent 产出 21 栏分镜 → `storyboard_qc_17` 回 `passed:true` 17/17 → 写入 canvas 节点 → 前端可见 → 刷新后仍在。
- **风险**：中。`CanvasNode` 是共用型别，改前先 `grep` 所有消费端（reducer/normalize/serialize/压缩器）。

### 刀 3：配音工作台 + 音色库 + 角色音色绑定

**姿态：小改（`asset-pack` 加 `kind:"voice"` + 补 TTS adapter）**

- **轮子源档**：
  - `aid_ai_voice_library`（`voice_code`/`voice_name`/`sample_url`/`sample_text`/`character_types`/`voice_styles`/`tone_tags`/`emotion_tags`/`supports_emotion|speed|pitch`/`default_speed|pitch`）— `/tmp/aid-init.sql:382`
  - `aid_role_voice_binding`（含 `reference_audio_id`/`override_speed`/`override_pitch`/`override_emotion`）— `/tmp/aid-init.sql:2760`
  - `aid_audio_asset`（`tts_text`/`voice_code`/`emotion`/`speech_rate`/`loudness_rate`/`pitch`/`audio_source`）— `/tmp/aid-init.sql:575`
  - 配音 UI 结构 — `frontend/web/components/steps/{Dubbing.tsx,edit-storyboard-dubbing/*}`、`VoiceTimbrePickerModal.tsx`
- **白名单改写**：AID 用 DB 表 + 自家 TTS 上游；我方**音色 metadata 挂 `AssetPackItem`（`kind:"voice"`）**，声音映射放 gateway `TTS_UPSTREAM`（`index.ts:6939`，注释自陈「上游接入后只需改此一处」）。
- **接线点**：
  - `AssetPackItemKind` **同构追加 `"voice"`**（`asset-pack-store.ts:26` + `ITEM_KINDS:117`，照 `scene_3d`/`bpy_script` 先例）
  - 角色绑定：扩 `CharacterCard` 加 `voiceCode?`（`character-cards.ts:42`，照 `normalizeCharacterCard` 白名单范式）
  - 补 TTS adapter：`generation-core/supplier-adapter.ts:105-130` 加分支（**勿动骨干**——`submitGenerationCommand` 计费/任务链已完整）
  - 试听：前端调 gateway `/agent/v1/tts`（真出声那条）
- **后端建设**：**无 migration**（asset-pack 走 Blob）；若 TTS 要进能力目录，照 `009_av_pipeline_kinds.sql` 范式放宽 CHECK（注意 017 揭示的 inline 匿名约束默认名推导坑）。
- **Agent 培训面**：`tts_speak` 工具描述加音色参数；AGENTS.md 加「角色音色绑定优先」条。
- **全链生效定义**：音色可选（≥5 条样本可试听）→ 角色绑定音色 → 生成任务 `artifact` 记录带 `voice_code` → 音频可播放。
- **口型同步**：**更正**——AID **有完整可复实现作**（Vidu lip-sync），我方现为 unsupported。
  本项**待暴君裁定**（见 §9 更正登记）；轮子源档：
  - 模型发现：`storyboard/service/impl/StoryboardLipSyncServiceImpl.java:2135-2157`
    （`capability_json.lipSync=true` 动态发现，业务层零硬编码；无模型时明确抛「对口型未配置」）
  - 上游：`aid_ai_model` id=85 `vidu-q3-lipsync`（`api_suffix=/ent/v2/lip-sync`、`real_model_code=viduq3`）
  - 请求体：`ViduVideoProviderClient.java:417-461`（`video_url`+`audio_url` 音频驱动；空才走文本驱动）
  - **驱动音频补静音**：`:2171 resolveDrivingAudio`（上游按音频长出片，补静音到源视频时长，阈值 200ms）
  - 计费粒度 5 秒；SSE 进度 `PROGRESS_LIP_SYNC_BASE=60 + SPAN=40`；Redis 锁 `storyboard:lip_sync:running:`（TTL 6h）
- **风险**：中低。TTS 上游 adapter 是缺口，但骨干与计费不动。

### 刀 4：成片装配层（`aid_episode_editor` 产物索引）

**姿态：直接拿（既有 B6 闸）+ 小改（加产物索引）**

> **2026-09-15 修订**：原规划的「时间轴 UI 新建」**废除**（用户裁定：Eimu 卖 one-shot，
> 提供在线剪辑工具违背产品宗旨）。本刀只做**后端产物索引**：让成片成为可列举、可回溯的
> 一等产物，前端沿用既有 chat 卡片与画布节点呈现。

- **轮子源档**：
  - `aid_episode_editor`（`timeline_json`/`final_video_url`/`final_video_fingerprint`/`pending_video_url`/`export_status`/`export_progress`/`export_task_id`/`export_fingerprint`）— `/tmp/aid-init.sql:1485`
  - **不拿**：`frontend/web/components/steps/video-preview/*`（24 档前端时间轴 UI）、`@webav/*`（浏览器端剪辑）
- **我方对位（已上线，直接拿）**：
  - `Timeline` 型别 + op DSL：`src/vendor-bridges/gateway/timeline.ts:68/102`（**已含 `sceneId`/`shotSize`/`emotionTag`/`locked`/`group`/`costCoins`**）
  - 导出闸：`master.ts:30` `MASTER_PRESETS`（portrait_916/landscape_169/cinema_239）+ blockers 聚合 + `probeRenderedVideo`
- **白名单改写**：AID 走阿里 MPS / 腾讯 IMS 回调（**不吞**，我方走 VPS ffmpeg + Chromium 花字链）；只吞其**实体栏位语义**与**前端时间轴交互**。
- **接线点**：
  - 成片索引：**加产物索引条目**（非新表）——挂 `artifact`（已有表）或 canvas 节点产物引用
  - 前端：**不新建**（沿既有 chat 影片卡 + 画布节点呈现成片；时间轴编辑仍走 agent 对话）
- **后端建设**：`timeline` 已存 `$WORKSPACE_DIR/<entity>/<sid>/` 版本树；`export` 产物落 `master_<preset>.mp4` + probe 校验。
- **Agent 培训面**：`timeline_*` 8 工具已在 VPS；AGENTS.md 加「成片导出必过 master 闸，blockers 非空即拒」。
- **全链生效定义**：分镜 → 时间线（clips 有 sceneId/shotSize）→ `check` `ok:true` → `export` 出 mp4 → `ffprobe` 解析度/时长/音轨符合 preset。
- **风险**：中（UI 新建）。**但后端与门禁已上线，风险集中在纯前端。**

### 刀 5：方法论资产入库（143 条镜头词库 + 27 agent 契约 + 51 enums）

**姿态：直接拿（逐字复制 + 白名单改写 + 授权标注，沿用 kunpeng 范式）**

- **轮子源档**：
  - `aid_prompt_lib` 143 笔 — `/tmp/aid-init.sql`（行 2301 起，每行一笔；栏位 `prompt_type`/`prompt_name`/`prompt_content`/`cover_url`/`sort_order`）
  - `doc/提示词开发指南.md`（1307 行，27 契约）
  - 51 个 enums — `aid-interface/aid-interface-main/src/main/java/com/aid/enums/*.java`
- **白名单改写**：
  - 词库：`prompt_content` 逐字保留；`cover_url`（AID OSS 路径）→ 替换为我方资源或占位卡（同名覆盖配方）
  - 契约：agent_code 命名空间改我方（AID `aid_*` → 我方对应）；协议标记（`@图片N[名称]`）**原样保留**
  - enums：Java → TypeScript 常数（值/语义逐字对齐，含 `desc` 中文）
- **接线点**：
  - 词库：**沿用 `kunpeng-prompt-templates.ts` 范式**（编译期常数 + license/commit 标注）；若要运营可维护，挂 `asset-pack kind:"prompt"` + admin 新面板（**唯一真新建项**）
  - 契约：写进 VPS harness 侧（`workspace/.opencode/`）/ AGENTS.md / playbook
  - enums：`src/lib/` 新增型别常数模组（纯常数，无逻辑）
- **后端建设**：无（编译期常数）；若要运营面板才需存档位置。
- **Agent 培训面**：契约文字入 VPS agent 提示词（双源同步）；词库进分镜 prompt 组装链。
- **全链生效定义**：词库可搜寻（≥143 条）→ 选中词条注入分镜 prompt → 生成结果可见；契约修改后 agent 实际调用行为改变（可 grep VPS）。
- **风险**：低（纯资料）。`cover_url` 图片资产需另取（AID 官方资产包**不在 Release 内**，需确认可得性——**未验证项**）。

---

## 3. 实作方法（工程姿势）

### 3.1 吞并三姿势（沿用 `docs/2026-08-25-swallow-decision-list.md` 框架）

| 姿势 | 适用 | 本 PRD 落点 |
|---|---|---|
| **直接拿** | 我方已有同构能力 或 纯资料资产 | 刀4 导出闸/时间线型别、刀5 词库/契约/enums |
| **小改** | 我方有 owner，缺栏位/型别 | 刀1 `CanvasProject` 扩栏、刀2 node metadata、刀3 asset-pack 加 kind |
| **新建** | 我方确实没有 | **仅一处**（可选）：运营提示词面板（刀5） |

### 3.2 授权与归档纪律（沿用 kunpeng 先例）

每个抄来的档案头部注释块固定格式：

```ts
/**
 * 轮子来源：gzxx-2025/aid-server（MIT，copyright 光子讯息(杭州)科技有限公司）
 * 源档：sql/aid-init.sql（aid_prompt_lib 段）
 * 取得日：2026-09-15 | commit: <取证时 sha>
 * 逐字保留：prompt_type / prompt_name / prompt_content
 * 白名单改写：cover_url（AID OSS 路径）→ 本站资源；其他栏位剔除
 */
```

- 全部改写逐条列在档头，**做不到「diff 除白名单外逐行等价」= 没交货**。
- `THIRD-PARTY-NOTICES.md` 追加 AID 条目（MIT 要求保留 copyright）。

### 3.3 派遣与验收

- 2+ 档或单档 >50 行 → 派 subagent；orchestrator 只做定位/spec/派发/验收。
- 常态 ≥3 路并发；完工一路立刻验收并补派。
- 每片 spec 必含「必读记忆」节（先验实际路径，**记忆有两库**：`/home/lenovo/.codex/memories/extensions/ad_hoc/notes/` 与 `/home/lenovo/.zcode/cli/memories/projects/image-app-63c110217f682752/memory/`）+ 标准配方（copy-paste 命令）。
- 验证预期通过的闸（tsc / 契约测试 / 真 E2E），不跑预期失败的测试。

### 3.4 已知坑位（写进每片 spec）

1. **opencode 工具新增/修改后必 `restart opencode-server.service`**（第三次实锤；transcript 含工具名 = 假阳性）。
2. **新 metadata 栏位族必同步两处白名单**：`toNodeMetadata` + `compactMetadataForAgent`（漏则刷新后空壳）。
3. **`tenant` 视角**：`CanvasNode` 是共用型别，改前 grep 全部消费端。
4. **DB migration 只增不改**（sha256 校验，改已应用档即 throw）。
5. **`pro-workstation/` 是残骸**（2026-08-27 移除专业入口后）——唯一活体 export 是 `workstation-constants.ts:91 REFERENCE_IMAGE_ROLES`（被 `CanvasNodeView.tsx:24` import），动它前先确认不碰。
6. **记忆冲突三处已回报**：`kunpeng-vendor` 在仓外；`src/lib/editor/` 实际 12991 行（记忆写 8795）；`boards-store.ts` 的「唯一 owner」注释已过期。

---

## 4. 每刀的后端建设 / 培训面 / 评测 ruler / 全链生效（四配套）

| 刀 | 后端建设 | Agent 培训面（VPS 双源） | 评测 ruler | 全链生效定义 |
|---|---|---|---|---|
| 1 作品/剧集 | 扩 `CanvasProject` + `/api/canvas/projects` 子路由（无 migration） | AGENTS.md 加实体契约条 | 实体持久化断言（刷新后仍在）+ API 契约测试 | Blob 可读 + 前端可见 + agent 写入成功 |
| 2 分镜 | node metadata + 压缩器两处白名单 | `storyboard_qc_17` 输入 schema 对齐 21 栏 | 17 门禁 17/17 + 往返一致性测试 | agent 产 21 栏 → 门禁过 → 落节点 → 前端见 |
| 3 配音/音色 | asset-pack 加 `voice` kind + TTS adapter 分支 | `tts_speak` 参数说明 + 绑定优先条 | 音色清单 ≥5 + 绑定→artifact 带 voice_code | 选音色 → 绑定 → 任务 → 可播放 |
| 4 成片 | `artifact` 产物索引（无新表） | `timeline_*` + master 闸规则进 AGENTS.md | `check` `ok:true` + `probeRenderedVideo` 通过 | 分镜 → 时间线 → check → export → ffprobe 合格 |
| 5 方法论资产 | 编译期常数（无后端）／可选运营面板 | 契约入 VPS agent 提示词（逐字） | 词库 ≥143 条可搜 + 契约调用行为可 grep | 词条注入 prompt → 生成可见；契约生效 |

---

## 5. 不吞清单（明确排除，避免范围蔓延）

依使用者裁定 + 产品判断排除：

| 项 | 理由 |
|---|---|
| 私有化部署 / 一键安装 / Go 在线升级器 | **架构**，使用者明确不要；我方是 Vercel SaaS + VPS 控制面 |
| 实名认证 / 内容审核队列 / 公告 FAQ 后台 / 邀请返利明细 | **运营配套**，使用者明确不要 |
| 阿里 MPS / 腾讯 IMS 特定回调 | 我方上游路径不同（VPS ffmpeg + Chromium 花字） |
| RuoYi 后台框架 | 我方 admin 已有自己的面；RuoYi 是 AID 的技术债 |
| TokenDance OAuth 供应商接入 | 我方 `new-api` 渠道体系已覆盖 |
| 口型同步 | **原判有误**（见 §9 更正）；现列「待裁定」，不预设排除 |

---

## 6. 风险与未决（FACT / INFERENCE / HYPOTHESIS）

**已接受风险（有缓解）：**

1. `CanvasProject` 扩栏影响面 — 缓解：加法式 + `normalizeProject` 白名单范式 + 契约测试。
2. ~~时间轴 UI 新建成本~~（**已废除**：用户裁定不做在线剪辑工具）。
3. 词库 `cover_url` 图片资产可能不可得（AID 官方资产包不在 Release 内）— 缓解：占位卡同名覆盖配方；**未验证项**。

**开工前必须确认（阻塞实作）：**

1. 刀2「分镜 = `group` 节点 + 子节点 metadata」vs「加第 13 种 `CanvasNodeType`」——需先 diff reducer 影响面再定。
2. ~~刀4 时间轴 UI 自绘 vs `@webav`~~（**已废除**）。改为：刀4 产物索引挂 `artifact` 还是 canvas 节点产物引用（二选一，实作前定）。
3. 刀5 是否要做运营面板（决定是否需存档位置 + admin nav 改动）。

**HYPOTHESIS（待验证）：**

- 对手流水线精致度主要来自**工序切分与契约强制**（27 契约 + 21 栏位 + 7 步状态机 + 音色/口型链），而非模型能力。若成立，我方复制契约即得同等精致度。（INFERENCE，需以我方实跑评测验证）

---

## 7. 执行顺序（排期）

| 波次 | 刀 | 并发 | 交付 |
|---|---|---|---|
| 波1 | 刀5（纯资料，零依赖）+ 刀1（实体链起点） | 2 路 | 词库/契约入库；剧集实体可持久化 |
| 波2 | 刀2（分镜实体）+ 刀3（配音/音色） | 2 路 | 分镜落节点；音色可选可绑 |
| 波3 | 刀4（成片产物索引，纯后端） | 1 路 | check/export 全链 + 成片可列举回溯 |

---

## 8. 附录：取证座标（可复验）

- AID 仓：`https://github.com/gzxx-2025/aid-server`（`main`）；档案树快取 `/tmp/aid-tree.json`（4464 档，未截断）
- AID init SQL：`/tmp/aid-init.sql`（1.8MB：schema + 143 词条 + agent 提示词初始资料）
- AID 方法论文档：`/tmp/aid-prompt-guide.md`（1307 行，27 契约）
- AID 授权：`LICENSE`（MIT，copyright 光子讯息(杭州)科技有限公司，含 RuoYi 部分）
- 我方镜像树：`src/vendor-bridges/{editor,gateway,opencode-tools}/`
- 我方轮子源：`/home/lenovo/Desktop/kunpeng-vendor` @ `872a58b`
- VPS harness：`43.172.85.76:/opt/agent-harness/workspace/.opencode/tools/`（119 工具）
- 吞并先例：`docs/2026-08-25-swallow-decision-list.md`、`docs/2026-08-27-kunpeng-symmetry-survey.md`、`src/lib/kunpeng-prompt-templates.ts`

---

## 9. 更正登记（2026-09-15，AID 前端深挖后）

### 更正一：「AID 有 17 道门禁」— 撤回，此为我方资产

- **原写**：刀 2 轮子源档列「17 道门禁判据 — 逐条对照 AID 的 17 条」。
- **实情（FACT）**：AID 全仓（README 375 行、`deploy/README.md`、`doc/提示词开发指南.md`、
  `version/version.md`、`文件结构.txt`）**无一处**提「17 道门禁」；GitHub code search
  `17道`/`确定性门禁`/`storyboard_qc` 皆 0 命中。README 唯一的「17」是 Java 版本号。
- **AID 实际有的是**：约 **24 条未编号的分散校验**（`throw ServiceException` 阻断 +
  `log.warn("分镜内容质量告警: issue=...")` 告警），散在 5 个 helper：
  `StoryboardVisualDirectiveValidator`（有效正文覆盖 7 条，含 4 态决策
  `EQUIVALENT/WARNING/EMPTY/CATASTROPHIC_TRUNCATION`）、`StoryboardSceneEnvelopeParser`（结构契约）、
  `StoryboardShotGroupPlanParser`（镜头组拆分 10 条，含 C5「模型输出必须是原文子串」+ 命中后回填原文
  杜绝标点漂移）、`StoryboardDirectTaskSnapshotValidator`、`StoryboardWriterContentParser`（十字段闭包）。
- **「17 门禁」真源是我方**：`src/lib/shortdrama-domain/index.ts` 的 `STORYBOARD_GATE_IDS`
  （VPS `storyboard_qc_17.ts:108-124` 已逐条移植）。**本项变更性质**：从「吞 AID」改为
  「我方自有资产接入产品层」。
- **意外收获（值得小改拿）**：C5 的「**命中后用原文区间回填**」手法——直接消除模型标点漂移入库。
  低成本、高价值，建议纳入刀 2。

### 更正二：「AID 口型同步未实作」— 撤回，AID 有完整实作

- **原写**：不吞清单列「口型同步：业界无可复现轮子；维持诚实 unsupported（AID 亦未实作）」。
- **实情（FACT）**：AID **全链路完整实作**，且是全案最值得搬的设计之一：
  - **模型动态发现**（`StoryboardLipSyncServiceImpl.java:2135-2157`）：查 `aid_ai_model`
    的 `capability_json.lipSync=true`，**业务层零硬编码模型名**；找不到明确抛「对口型未配置」。
    这与我方 `supplier-channels` registry claim 范式**同构**，但粒度更细（布林能力位）。
  - **上游**：Vidu `viduq3`（`/ent/v2/lip-sync`），音频驱动；空 `audio_url` 才走文本驱动。
  - **驱动音频补静音**（`:2171`）：上游按音频长度出片（15 秒源视频出 3 秒成片），
    故提交前补静音到源视频时长（阈值 200ms）。
  - **计费粒度 5 秒**；SSE 进度 `PROGRESS_LIP_SYNC_BASE=60 + SPAN=40`（step id `lipSync`）。
  - **并发保护**：Redis 锁 `storyboard:lip_sync:running:`（TTL 6h）+ workflow 锁。
  - 能力约束（`sql/v2.1.0.sql:2100-2120`）：输入视频 1–600 秒、mp4/mov/avi、≤5120MB、单边 360–4096px。
- **连带影响**：我方 `lint.ts:95` 的「口型同步：语义层，当前行业无可复现检测，诚实跳过」——
  该句指的是「**检测/审核**」而非「合成」。合成有轮子，检测仍无。**两者需分开表述，不可混为一谈。**
- **状态**：列入待裁定（本轮不实作，因涉及新上游接入与计费，非「小改」）。

### 更正三：任务书前提「create/ 下 13 个页面」— 实为 11 个

FACT：`frontend/web/app/create/` 下 **10 个子目录 / 11 个 `page.tsx`**（根 `page.tsx` +
dubbing、global-setting、preview、scene-character、series-episode-list、series-script-upload、
story-script、storyboard-script、storyboard-video、studio）。先前「13 页」记述错误。

### 更正四：文档与 DB 的词库项数冲突 — 以 DB 为准

FACT：`doc/提示词开发指南.md:820-826` 称 composition 15 项、focal_length 8 项、exposure_blur 8 项；
`aid_prompt_lib` DB 实际为 **16 / 9 / 16**。**已按 DB 取值**（我方 `lens-language-library.ts` 142 条
即以 DB 为源，且已过契约测试锁定）。**教训**：搬字典只信 DB，不信文档。

---

## 10. 新增可搬资产（解剖后补，全部 FACT）

| 资产 | 座标 | 价值 | 姿势 |
|---|---|---|---|
| 步骤完成判据（后端） | `CreationStepServiceImpl.java:205-350`（每步一个 `check*OrThrow`） | 7 步各自明确完成条件，不满足直接抛 | 小改 |
| 前置未完成文案表 | 同上（「请先设置画面比例」等） | 错误讯息可教学化 | 直接拿 |
| 跨组切换语义 | `CreationModeEnum.isCrossGroupSwitch()` | i2v/multi（standard）↔ pro/auto_grid（advanced）切换需清空项目级生成配置 | 直接拿 |
| 枚举注册表 | `prompt/constant/EnumDictRegistry.java:43-65`（白名单注册 23 枚举）+ `POST /api/user/dict/enum/list` | **前端不写死常量**，枚举后端可运营 | 小改 |
| `timeline_json` 结构 | `compose/dto/timeline/TimelineData.java` + TS 镜像 `types/business-api.ts:2411-2481` | **「段 × 轨」**：`segments[]` 每段挂 `video`/`voice`/`subtitle` **恒不为 null**；`@JsonInclude(ALWAYS)` 使出参结构恒定 | 直接拿 |
| **export 幂等指纹** | `VideoComposeServiceImpl.java:685-706`（`computeExportFingerprint():979`） | 素材归一化 SHA-256（URL 转相对路径）；指纹相同且已成功 → **直接复用，不再合成不再扣费**，回 `reused:true` | 直接拿 |
| **待审/正式双槽** | `final_video_*` / `pending_video_*` 双指纹 + `ComposeResultListener.java:117-190` 四分支 | 「已公开内容重导出先落待审槽、旧片继续展示、过审后转正」 | 直接拿（若做审核） |
| **对齐策略 AUDIO** | `ComposeConstants.ALIGN_STRATEGY_AUDIO` + `buildTracks():201-306` | 段长取视频/配音较长者；**视频不足自动循环补画面**（防成片中段黑屏 + 后续段音画错位） | 直接拿 |
| 导出前 8 道结构校验 | `VideoComposeServiceImpl.java:516-535`、`validateExportGroups():1199` | 分组≤500、分辨率合法集、URL 等长、`rejectForbiddenUrl`（拒 `blob:`/`data:`/嵌套协议） | 直接拿 |
| 字幕分屏算法 | `SubtitleScreenSplitter.java:22-28` | 7–12 字/屏；切分优先级 换行 → 句末标点 → 句内停顿 → 均分硬切 | 直接拿 |
| 试听设计 | `VoicePreviewController.java:14-45` + `VoicePreviewLimitService` | **同步、免费、不落库**；provider 回 base64 不过 OSS；10 次/60 秒频控；秒数×4.5 字/秒折算上限 | 直接拿 |
| 音色库种子 | `aid-init.sql:426-428`（63 笔，`model_id=42` 火山 bigtts） | `character_types`/`voice_styles`/`tone_tags`/`emotion_tags` 四维 JSON 标签 + 55 笔 `aid_ai_voice_tag` 字典 | 直接拿（资料） |
| 口型驱动音频补静音 | `StoryboardLipSyncServiceImpl.java:2171` | 上游按音频长出片 → 补静音对齐 | 待裁定 |

**新发现的 AID 缺口（我方可超越处，FACT）**：`CreationStepServiceImpl` 中 **step 5/6 的完成判据
与 step 4 完全相同**（皆 `aid_storyboard count > 0`），注解自陈「不校验是否已选定视频」——
「视频已选定／配音已选定」**未被后端强制**，仅靠前端按钮 `disabled`。**这是 AID 的结构漏洞，
我方若做状态机，闸门应真正校验该步产物，而非沿用其宽松判据。**

### 更正五：「④ 僵尸回收」— 撤回，我方已完整实作

- **原写**：PRD 与回报把「素材提取僵尸回收 + 断点续传」列为我方缺口，建议从 AID 吞。
- **实情（FACT，已逐档验证）**：我方**已有且更完整**：
  - `src/lib/generation-core/job-repository.ts:831` `recoverExpiredGenerationLeases()`：
    ① `status='leased' AND lease_expires_at < now()` → 回到 `queued`（重排）；
    ② `status IN ('submitting','running') AND lease_expires_at < now()` → 转 `submit_unknown`
    并**补排上游对帐**（`provider_next_poll_at` + 24h 对帐窗口）；
    ③ 顺带清 `supplier_lease` 过期列。
  - `src/lib/generation-core/worker-service.ts:437 / :501`：主维护循环**每 30 秒**呼叫，且
    `runGenerationMaintenanceOnce()` 供长驻/一次性两种模式共用。
  - `src/lib/generation-core/billing-ledger.ts:578` `reclaimStaleBillingZombies()`：
    另有**计费态**僵尸回收（`pending_billing`/`billing_unknown`），走 `ZOMBIE_RECLAIM_BATCH` 批次。
  - 事件可审计：`emitJobEvent`（`job_events` append-only 账本）。
- **对比 AID**：AID 的 `ExtractZombieReclaimTask` 是「超时标 FAILED + 退款 + 释放锁」；
  我方是「回 queued 重排 或 转 submit_unknown 走上游对帐查真相」——**后者更诚实**（不假设失败，
  先查上游真相再结算）。我方版本**不需要吞 AID**。
- **教训**：本次两轮把「我方已有」误判为缺口（③ 条目类似）。**根治动作已记**：列缺口前必先
  `grep -rn` 关键词（`reclaim|zombie|lease|heartbeat`）验证，不得凭功能名推论。

### 更正六：真缺口替换（由「容易拿的」补上）

④ 撤回后，位置由**已验证为真缺口**的三项取代（本轮施工中）：
`master.ts` 无**导出指纹（幂等）**、无 **URL 守卫**、无**字幕分屏**（已 grep 全 gateway 确认无命中）。
来源见 §10（AID 的 `computeExportFingerprint` / `MaterialUrlGuard` / `SubtitleScreenSplitter`）。

---

## 11. 验收纪律修正：tsc 覆盖范围漏洞（2026-09-15 实锤）

### 漏洞（FACT）

`tsconfig.json:38-47` 的 `exclude` 排除了 **`src/vendor-bridges`**、`deploy-staging`、`staging`、
`mcp-server`、`plugins`、`eval-*`，以及**全部 `**/*.test.ts` / `**/*.test.tsx`**。

**后果**：专案标准验收命令 `npx tsc --noEmit -p tsconfig.json | grep -c "error TS"` 回 0，
**不代表 0 错，而是「这些目录根本没被检查」**。本次刀 0 的 `lens-language-library.ts`（`src/lib/`，在覆盖内）
与刀 1 的 `creation-flow-steps.ts`（`src/lib/`，在覆盖内）**受检**；但
`src/vendor-bridges/gateway/material-fingerprint.ts` / `subtitle-splitter.ts`（本次新增）**完全不受检**。

### 修正后的验收命令（三条并跑，全部要过）

```bash
# ① 主库型别（既有命令，覆盖 src/lib、src/app、src/components）
npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c "error TS"          # 必须 0

# ② 被 exclude 目录的隔离检查（本次新增/改动档逐个列出）
npx tsc --noEmit --skipLibCheck --target es2022 --module esnext \
  --moduleResolution bundler --strict --types node \
  <新增档1> <新增档2> ...                                              # 必须 0

# ③ 测试——tsc 不管测试档，只有真跑才算验证
npx --yes tsx --test <测试档>                                         # 必须全绿
```

### 既有基线（勿误判为本次引入）

`src/vendor-bridges/gateway/` 在隔离检查下有 **既有型别错误**（本次改动前即存在）：
- `gateway/*.ts` 进口 `./editor/...`，但 `editor/` 实际在 **`src/vendor-bridges/editor/`**（`gateway/` 的**上层**），
  路径应为 `../editor/...` → 78+38+26+4+4 条 `TS2307`/`TS2339`（`timeline.ts` 78、`lint.ts` 38、`master.ts` 26、`style.ts` 4、`mix.ts` 4）
- 成因：该目录为 VPS 执行码的本地写入副本，**不走 Next.js 建置**，故长期未被 tsc 覆盖
- **本次新增的 `material-fingerprint.ts` / `subtitle-splitter.ts` 隔离检查为 0 错**（已复验）

### 铁律（新增）

1. **宣告「tsc 0 错」前，必先确认被检查档案在 `tsconfig.include` 内**；不在就补隔离检查，并在回报中注明「0 是空集合还是真空集」。
2. **测试档永远不受 tsc 覆盖**——「型别过」不等于「测试过」，两者必须分别执行、分别回报。
3. 既有基线错误与本次引入错误必须分开计数（方法：`git stash` 后重跑对比，或按档归属统计）。
