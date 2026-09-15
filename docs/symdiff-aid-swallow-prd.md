# PRD：吞下 AID 產品層單向對稱差（2026-09-15）

> 定性：**能力建設**（不是修復）。
> 對象：`gzxx-2025/aid-server`（MIT，copyright 光子讯息(杭州)科技有限公司；231★/68 fork；v2.1.4 @ 2026-09-14）。
> 姿態：**少原創少錯**——能直接拿就逐字拿（含授權標註），否則小改；禁止重寫。
> 語言：本檔正體中文；站點 UI 文案簡體（PRODUCT.md 品牌規則）。
> 範圍：使用者裁定的 5 項產品層單向差。**架構（私有化部署/在線升級器）與運營配套（實名/審核/公告/邀請返利）明確排除。**

---

## 使用者裁定（2026-09-15，追加）

### 刀 0 先行（已實作）

**依據**：2026-09-15 實測 `opencode.db` 1702 個真實 tool part——實裝自訂工具 **98 個，真被調用 43 個，零調用 55 個**。PRD 核心工具全部 0 調用（`storyboard_qc_17`／`script_scene_parse`／`timeline_master`／`editing_manifest`／`keyframe_render`／`memory_recall`）。

**三閘全漏診斷**：
1. **可達性**：`opencode.json` 顯式禁用 ⇒ `storyboard_qc_17` 僅對 `screenwriter` 可達；135 次 dispatch 僅 68 次帶 `expert` 欄。
2. **可知性**：`AGENTS.md` 提及 0 次的工具，調用數全為 0 或近 0。
3. **傾向性**：agent 偏好 `bash`(401) + `workflow_*`(669) 手搓，繞過封裝工具。

**機制結論**：**貨架必然長草，閘門與默認注入才是活路。** 唯一穩定活著的通道是 `skill`（62 次）。

**已交付**（本輪）：
- `src/lib/lens-language-library.ts`（142 條 / 12 類，MIT 逐字取自 AID `aid_prompt_lib`；9/9 契約測試綠、tsc 0 錯）
- `tools/gen-lens-skill.ts`（單一真源生成 skill，禁手改兩份）
- `deploy-staging/training/dao0-activation-mechanism.md`（閘門面 + 注入面落位說明 + 驗收 SQL）
- `THIRD-PARTY-NOTICES.md` 追加 AID 條目

**驗收判據**：部署後跑一次 ≥3 鏡任務，`storyboard_qc_17` 調用數自基線 **0 → ≥1**，且 skill 載入出現 `lens-language`。**若仍 0 ⇒ 紀律層無效 ⇒ 立即轉機器層**（`workflow_generate` 提交前硬跑門禁），不再加紀律文字。

### 使用者對四項候選的裁定

| 候選 | 裁定 | 理由 |
|---|---|---|
| ① `@webav` 瀏覽器端剪輯工具 | **不做** | 用戶原話：「Eimu 賣的是 one-shot，提供在線剪片工具不僅工作量和調優負擔極大，而且是打自己產品宗旨臉——AI 能做好的壓根不需要人插手」 |
| ② 三級狀態機（項目→劇集→分鏡，7 步） | **做** | 產品信息架構，非架構 |
| ③ agent 契約運營化（27 契約） | **做** | prompt 可運營化，對應我方 7 個 persona 的演進形態 |
| ④ 素材提取殭屍回收 + 斷點續傳 | **撤回（我方已完整實作）** | 見 §11 更正五 |
| ⑤「容易拿的也拿」 | **做** | 純資料資產零風險（enums、詞庫、schema 語義） |

**連帶影響**：刀 4 的「時間軸 UI 新建」項**廢除**（原 PRD §2 刀 4 與 §3.1「僅兩處新建」中的 UI 一項不再成立）。刀 4 只保留**產物索引**（後端，小改）。**全 PRD 需真正新建的僅剩「運營提示詞面板」（可選）。**

---

## 0. 一句話目標（可測量終態）

用戶在 Emu 上能以**「作品 → 劇集 → 分鏡 → 成片」四層持久實體**完成長敘事生產：劇集與分鏡不再是對話裡的臨時狀態，成片裝配走既有母帶導出閘；配音有可選音色庫與角色綁定；鏡頭語言詞庫與 agent 契約以 AID 已驗證的方法論資產入庫；全程複用我方既有能力（VPS harness 8 工具 + `timeline_*` + `master` 閘 + `asset-pack` + `canvas/project-store`），**不新增第二套隊列/歷史/能力目錄/任務系統**。

**判定成功（皆為可複驗證據，非 HTTP 200）：**

1. 建一個劇集 → 有 ≥2 集 → 每集有分鏡 → 重新整理/換裝置後**全鏈仍在**（DB/Blob 查得到實體，不是前端記憶體）。
2. 分鏡過 `storyboard_qc_17` 後可進成片；`timeline/master` 的 `check` 回 `ok:true`，`export` 產出 `master_*.mp4` 且 `probeRenderedVideo` 通過（解析度/時長/音軌）。
3. 角色可綁音色，`tts` 任務實際帶 `voice_code` 落到 `artifact`（可查證），前端可試聽。
4. 鏡頭語言詞庫（≥143 條 / 11 類）可用於分鏡 prompt 組裝，詞條帶真實出片縮略圖；agent 契約文字入庫且 agent 實際調用時生效（VPS 側可 grep）。
5. **零重複扣費**：以上所有動作除正常生成扣費外無額外扣除（計費真源仍為控制面排帳）。

---

## 1. 現狀（FACT / INFERENCE 標籤）

### 1.1 AID 側可拿資產（全部 FACT，已複驗路徑）

| 項 | 證據 | 授權 |
|---|---|---|
| 方法論本體 | `doc/提示词开发指南.md`（1307 行）：**27 個 agent 契約**（用途/輸入/輸出/開發要點/AI 生成指引）+ 硬規則（純 JSON、引號換「」、私有標記 `@圖片N[名稱]` 原樣保留、改提示詞不改契約） | MIT |
| 分鏡契約 | 標準版 **21 欄位**（`shotNumber`/`scriptContent`/`shotSize`/`cameraAngle`/`focalLength`/`cameraMovement`/`composition`/`atmosphere`/`colorTone`/`lighting`/`exposureBlur`/`soundEffect`…）；專業版 10 中文字段；`video_prompt_continuity_v1` 跨鏡連續性 schema（`ROOT`/`EXTERNAL_PREVIOUS`/`BATCH_PREVIOUS`） | MIT |
| 鏡頭詞庫 | `aid_prompt_lib` **143 筆 / 11 類**：構圖16、景別10、機位13、焦段9、色調15、光線24、曝光虛化16、運鏡17、攝法13、畫質保底3、負向詞2。**每筆含完整中文詳解**（例：「逆光，主光自主體正後方射入，邊緣被勾出一圈輪廓光，正面轉入柔和剪影。」） | MIT |
| 狀態機 | `CreationStepEnum` 7 步（`GLOBAL_SETTING(1)`→`PREVIEW(7)`，另 `SERIES_DEFAULT(-1)`）；`GenModeEnum`（`economy`/`performance`）；`CreationModeEnum`（`i2v`/`multi`/`pro`/`auto_grid`，分 `standard`/`advanced` 組） | MIT |
| 類型系統 | 51 個 enums；核心：`AssetTypeEnum`(8)、`AspectRatioEnum`(13)、`EpisodeStatusEnum`(6)、`ProjectStatusEnum`(6)、`ScriptTypeEnum`(2)、`VideoStyleTypeEnum`(3)、`StoryboardShotDensityEnum`(3)、`AssetSourceTypeEnum`(3)、`ProjectTypeEnum`(2) | MIT |
| 產品表 schema | `aid_comic_project`(32欄，`aid-init.sql:1084`)/`aid_comic_episode`(23欄，`:1050`)/`aid_comic_script`(`:1187`)/`aid_storyboard`(21欄+`final_image_id`/`final_video_id`/`final_audio_id`，`:2846`)/`aid_role_prop_scene`(含 `active_name_key` 去重鍵)/`aid_ai_voice_library`(`:382`)/`aid_role_voice_binding`(`:2760`)/`aid_prompt_lib`(`:2301` 起 143 筆)/`aid_episode_editor`(`timeline_json`，`:1485`)/`aid_audio_asset`(`:575`) | MIT |
| 前端狀態模型 | `stores/creation/{state,types,step3Slice,step4Slice,...}`（zustand 切片）：`currentStepIndex`/`currentProjectId`/`currentEpisodeId`/`currentProjectType`/`formData.{globalSetting,storyScript,sceneCharacter,storyboardScript}` 產品層語義 | MIT |
| 前端技術棧 | Next.js 16.3 / React 19.2 / Tailwind 4 / antd 6 / `@xyflow/react` / `@webav/av-cliper`（瀏覽器端剪輯，MIT，**我方不採用**） / zustand / quill | MIT |

### 1.2 我方現狀（FACT，subagent 全庫盤點 + 抽查複驗）

**已有（可直接拿）：**

| 能力 | owner 檔案 | 備註 |
|---|---|---|
| 時間線資料模型 + op DSL | `src/vendor-bridges/gateway/timeline.ts:68`（`Timeline{session_id,version,clips,audioTracks,audioClips,subtitles,bgm,aspect,markers,updated_at}`）、`:102`（`TimelineOp` DSL 14 種） | `TimelineClip extends EditorClip` 追加 `sceneId/shotSize/emotionTag/locked/group/costCoins/filter` |
| 母帶導出閘 | `src/vendor-bridges/gateway/master.ts:30`（`MASTER_PRESETS`）、`:67`（blockers 聚合 lint must + mix `sync_errors`）、`:99`（`ok: blockers.length===0`）；`probeRenderedVideo` 強校驗 | B6 已上線 |
| 混音/節奏/波形 | `gateway/{mix,lint,rhythm,style,waveform,beatDetect}.ts` | B5 已上線，內建 `loudnorm=I=-16:TP=-1.5:LRA=11` |
| 剪輯輪子本體 | `/home/lenovo/Desktop/kunpeng-vendor` @`872a58b`：`src/stores/editorStore.ts`(1317)、`src/lib/agent/tools/timelineTools.ts`(3997，69 工具)、`src/lib/editor/`(**12991**) | ⚠️ 在**倉外**；image-app 內經 `src/vendor-bridges/editor/`(2463) 鏡像，記帳 `vendor/kunpeng/PATCHES.md` |
| 畫布專案持久化 | `src/lib/canvas/project-store.ts`（Blob `canvas/{userId}/index-*`，世代輪替 2 代，上限 50）、`src/lib/canvas/types.ts:309` `CanvasProject`（含 `cardIds?`）、`/api/canvas/projects` | 已含 `normalizeProject` 逐欄白名單清洗範式 |
| 資產包（含 agent 注入） | `src/lib/asset-pack-store.ts:91`（Blob `asset-packs/{userId}/`）、`ITEM_KINDS` 7 類（`asset-pack-store.ts:117`）、`/api/assets` + `/api/v1/assets`、`src/lib/agent-assets.ts` | P0 已落地；`scene_3d`/`bpy_script` 是**同構追加先例** |
| 角色/場景/風格卡 | `src/lib/character-cards.ts:42`（`CharacterCard{id,name,kind,prompt,references[],negativePrompt?,loraIds?}`）、`character-card-store.ts:28` | 無 view/DNA/項目欄位 |
| 配方模板 | `recipe-templates.ts:45`（內建 10）、`recipe-template-store.ts:42`（用戶級 50） | — |
| TTS（真出聲那條） | `deploy-staging/gateway/index.ts:6939`（`TTS_UPSTREAM`）、`:7026`、路由 `:8729` `POST /agent/v1/tts` | 產物落 `TTS_AUDIO_DIR`，經 `TTS_PUBLIC_BASE` 公開 |
| 站點 TTS 骨幹 | `src/app/api/v1/tts/generations/route.ts:60-88` → `submitGenerationCommand` → 能力閘 → scheduler | **上游 adapter 缺 minimax/did handler（缺口）** |
| DB migration 機制 | `tools/migrate-generation-db.ts`（`` `NNN_snake_case.sql` ``、只增不改、sha256 校驗、advisory lock） | 最新 017，下一號 018；**用戶資料默認不加表** |
| 吞併先例範式 | `src/lib/kunpeng-prompt-templates.ts`（MIT 逐字複製 + 白名單改寫 + license/commit 標註） | 本次沿用此姿勢 |

**VPS harness 真能力（119 工具，已實地取證）：**
`storyboard_qc_17`（**17 道門禁逐條落地**：`shot_identity`/`shot_order`/`scene_binding`/`duration_bounds`/`segment_duration`/`prompt_present`/`characters_bound`/`scenes_bound`/`character_lock`/`scene_lock`/`keyframe_present`/`last_frame_present`/`audio_anchor_present`/`aspect_ratio`/`dialogue_alignment`/`continuity`/`export_readiness`）、`script_scene_parse`、`character_dna_turnaround`、`style_anchor_sref`、`editing_manifest`、`last_frame_video_chain`、`audio_first_timeline`、`delivery_assets`、`cast_asset_lock`、`keyframe_render`、`timeline_{query,ops,lint,rhythm,mix,style,restore,master}`、`image_generate/edit/upscale`、`blender_*`、`music_gen`、`tts_speak`、`vision_analyze`、`subagent_dispatch` 等。

**缺口（FACT）：**

| 項 | 現狀 | 性質 |
|---|---|---|
| 劇集/系列實體 | **無**（`drama-recipe.ts:67` 只有 `ep` 數字欄的純函數 DTO，無持久化） | 產品層缺 |
| 專案→分鏡→鏡頭層級 | **無**；三組互不相連平面 list（`boards-store.ts:9` IndexedDB、`director-engine/types.ts:75` gateway JSON、`shortdrama-domain:104` 純函數） | 產品層缺 |
| 成片實體 | 產物有（`master_*.mp4` 落 `$WORKSPACE_DIR`），**索引無** | 產品層缺半 |
| 音色庫（清單/試聽/標籤） | **無**；`voice` 只能字串直傳，前端零音色 UI | 產品層缺 |
| 角色↔音色綁定 | **無**（`drama-recipe.ts:88 voicePrompt` 自由文本無消費端） | 產品層缺 |
| 口型同步 | 型別枚舉 + `LIPSYNC_1_MODEL_ID` 佔位，`lint.ts:95` 明文 unsupported，**無端點** | 產品層缺（**AID 有完整實作，見下**） |
| 運營可維護提示詞庫 | **無**；`/api/canvas/prompts` 是第三方遠程聚合（GET 不鑑權、非用戶級、運營改不動）；admin 7 面板無此位 | 產品層缺 |
| 鏡頭語言中文詞庫 | 部分（`DirectorShotScale` 六級英文、`CAMERA_MOVE_TO_PROMPT`）；**無 11 類 143 條中文詳解詞庫** | 資產缺 |

### 1.3 主瓶頸（FACT，一句）

**能力層已齊（VPS 側 17 門禁 + 8 短劇工具 + 8 時間線工具 + 母帶閘全在），產品層缺「長敘事實體鏈」——用戶無法把一次生成沉澱成「作品/劇集/分鏡/成片」，因此長敘事只能停留在 agent 對話裡。**

### 1.4 因果鏈（最短主線）

```
VPS 能力齊 → 但產品層無實體承載 → 長敘事狀態留對話（易失、不可編輯、不可交接）
→ 用戶做不成「系列」 → 對手的 7 步流水線成為唯一結構化路徑
[最小干預] 擴既有 owner 承載實體（不新建系統） → 前端可視化 → 門禁/導出復用既有閘
```

---

## 2. Scope（5 刀，逐刀「直接拿 / 小改」判定）

**排序依賴**：刀1 → 刀2 → 刀3（刀3 依賴刀1/2 的實體）／刀4（依賴刀2 分鏡）／刀5 獨立可並行。

### 刀 1：作品/劇集實體鏈（`aid_comic_project`/`episode`/`script`）

**姿態：小改（擴 `CanvasProject`）**

- **輪子源檔**：
  - `aid_comic_project`（32 欄，`/tmp/aid-init.sql:1084`）/`aid_comic_episode`（23 欄，`:1050`）/`aid_comic_script`（`:1187`）schema
  - 7 步狀態機 — `aid-interface/aid-interface-main/src/main/java/com/aid/enums/CreationStepEnum.java`（**逐字拿枚舉語義**）
  - 前端狀態模型 — `frontend/web/stores/creation/state.ts`（`currentStepIndex`/`currentProjectId`/`currentEpisodeId`/`currentProjectType`）
- **白名單改寫**：schema 去掉 `del_flag`/`create_by`/`update_by`/`remark`/`pending_*` 審核欄（我方無審核隊列）；保留 `project_type`/`aspect_ratio`/`video_style_*`/`style_source`/`current_step`/`status`/`is_public`/`source_project_id`。
- **接線點**：
  - 型別：`src/lib/canvas/types.ts:309` `CanvasProject` **加 `projectType?`/`seriesId?`/`episodes?`/`script?`**（加法式，照 `normalizeProject`（`project-store.ts:53-72`）白名單範式逐欄清洗）
  - API：`/api/canvas/projects` 下開子路由（**不新建 store**）
  - 前端：canvas 側新增劇集面板（掛 `canvas-workstation`，**不新建頁面樹**）
- **後端建設**：`timeline_json`/`current_step` 無需 DB migration（**走 Blob**）；僅當要「跨用戶公開作品查詢」或進計費時才加 `018_*.sql`。
- **Agent 培訓面**：VPS `AGENTS.md` 尾部追加「作品/劇集實體」契約條（雙源同步：`/opt/agent-harness/workspace/AGENTS.md` + repo 側）；新增/修改 harness 工具後**必 restart `opencode-server.service`**（第三次實錘的坑）。
- **全鏈生效定義**：劇集實體 Blob 可讀 + canvas 面板可見 + agent 調用 `canvas_apply_ops` 寫入 episode 節點成功 + 重新整理仍在。
- **風險**：低。`CanvasProject` 是加法擴欄，既有 50 上限與世代輪替不動。

### 刀 2：分鏡實體 + 21 欄位契約（`aid_storyboard`）

**姿態：小改（掛 `CanvasNode` 通道 + 直接拿欄位契約）**

- **輪子源檔**：
  - `aid_storyboard` schema（21 欄 + `final_image_id`/`final_video_id`/`final_audio_id`）— `/tmp/aid-init.sql:2846`
  - **21 欄位分鏡契約 + 硬規則** — `doc/提示词开发指南.md`（§2「分鏡腳本與畫師鏈路」）
  - 分鏡欄位契約 — `doc/提示词开发指南.md` §2（21 欄位 + 純 JSON 硬規則）
  - 17 道門禁判據 — **我方自有資產，非 AID**：VPS `workspace/.opencode/tools/storyboard_qc_17.ts:108-124`
    （**重要更正**：AID 全倉無「17 道門禁」；其分鏡校驗是約 24 條未編號的分散 `throw`/`log.warn`，
    散在 `rps/helper/Storyboard{VisualDirectiveValidator,SceneEnvelopeParser,ShotGroupPlanParser,DirectTaskSnapshotValidator,WriterContentParser}.java`。
    17 門禁是本平台 PRD 源文 `src/lib/shortdrama-domain/index.ts` 的 `STORYBOARD_GATE_IDS`，我方權威。）
- **白名單改寫**：AID 用 DB 表；我方**改用 `CanvasNode` + `canvas_apply_ops`**（`src/lib/canvas/types.ts:290-298` 8-op DSL）。分鏡欄位落 node metadata，**不新建 shot 表**。
- **接線點**：
  - `CanvasNodeType` 12 型已有 `image`/`video`/`audio`/`character_card`/`scene_card`/`prompt`/`reference`/`director`/`scene_3d`；**分鏡 = `group` 節點 + 子節點 metadata**（或加一型，二選一，實作前先 diff reducer 影響面）
  - 寫入走既有 `canvas_apply_ops`；讀取走 `agent/sessions/[id]/canvas-state`
  - 壓縮器白名單：**新 metadata 欄位族必同步兩處**（`toNodeMetadata` + `compactMetadataForAgent`）——歷史教訓，漏一處則刷新後空殼
- **後端建設**：無 migration（Blob + node metadata）。
- **Agent 培訓面**：把 21 欄位契約寫進 VPS 側 `storyboard_qc_17` 的輸入 schema 與 AGENTS.md；`script_scene_parse` 輸出對齊。
- **全鏈生效定義**：agent 產出 21 欄分鏡 → `storyboard_qc_17` 回 `passed:true` 17/17 → 寫入 canvas 節點 → 前端可見 → 刷新後仍在。
- **風險**：中。`CanvasNode` 是共用型別，改前先 `grep` 所有消費端（reducer/normalize/serialize/壓縮器）。

### 刀 3：配音工作台 + 音色庫 + 角色音色綁定

**姿態：小改（`asset-pack` 加 `kind:"voice"` + 補 TTS adapter）**

- **輪子源檔**：
  - `aid_ai_voice_library`（`voice_code`/`voice_name`/`sample_url`/`sample_text`/`character_types`/`voice_styles`/`tone_tags`/`emotion_tags`/`supports_emotion|speed|pitch`/`default_speed|pitch`）— `/tmp/aid-init.sql:382`
  - `aid_role_voice_binding`（含 `reference_audio_id`/`override_speed`/`override_pitch`/`override_emotion`）— `/tmp/aid-init.sql:2760`
  - `aid_audio_asset`（`tts_text`/`voice_code`/`emotion`/`speech_rate`/`loudness_rate`/`pitch`/`audio_source`）— `/tmp/aid-init.sql:575`
  - 配音 UI 結構 — `frontend/web/components/steps/{Dubbing.tsx,edit-storyboard-dubbing/*}`、`VoiceTimbrePickerModal.tsx`
- **白名單改寫**：AID 用 DB 表 + 自家 TTS 上游；我方**音色 metadata 掛 `AssetPackItem`（`kind:"voice"`）**，聲音映射放 gateway `TTS_UPSTREAM`（`index.ts:6939`，註釋自陳「上游接入後只需改此一處」）。
- **接線點**：
  - `AssetPackItemKind` **同構追加 `"voice"`**（`asset-pack-store.ts:26` + `ITEM_KINDS:117`，照 `scene_3d`/`bpy_script` 先例）
  - 角色綁定：擴 `CharacterCard` 加 `voiceCode?`（`character-cards.ts:42`，照 `normalizeCharacterCard` 白名單範式）
  - 補 TTS adapter：`generation-core/supplier-adapter.ts:105-130` 加分支（**勿動骨幹**——`submitGenerationCommand` 計費/任務鏈已完整）
  - 試聽：前端調 gateway `/agent/v1/tts`（真出聲那條）
- **後端建設**：**無 migration**（asset-pack 走 Blob）；若 TTS 要進能力目錄，照 `009_av_pipeline_kinds.sql` 範式放寬 CHECK（注意 017 揭示的 inline 匿名約束默認名推導坑）。
- **Agent 培訓面**：`tts_speak` 工具描述加音色參數；AGENTS.md 加「角色音色綁定優先」條。
- **全鏈生效定義**：音色可選（≥5 條樣本可試聽）→ 角色綁定音色 → 生成任務 `artifact` 記錄帶 `voice_code` → 音頻可播放。
- **口型同步**：**更正**——AID **有完整可複實現作**（Vidu lip-sync），我方現為 unsupported。
  本項**待暴君裁定**（見 §9 更正登記）；輪子源檔：
  - 模型發現：`storyboard/service/impl/StoryboardLipSyncServiceImpl.java:2135-2157`
    （`capability_json.lipSync=true` 動態發現，業務層零硬編碼；無模型時明確拋「对口型未配置」）
  - 上游：`aid_ai_model` id=85 `vidu-q3-lipsync`（`api_suffix=/ent/v2/lip-sync`、`real_model_code=viduq3`）
  - 請求體：`ViduVideoProviderClient.java:417-461`（`video_url`+`audio_url` 音頻驅動；空才走文本驅動）
  - **驅動音頻補靜音**：`:2171 resolveDrivingAudio`（上游按音頻長出片，補靜音到源視頻時長，閾值 200ms）
  - 計費粒度 5 秒；SSE 進度 `PROGRESS_LIP_SYNC_BASE=60 + SPAN=40`；Redis 鎖 `storyboard:lip_sync:running:`（TTL 6h）
- **風險**：中低。TTS 上游 adapter 是缺口，但骨幹與計費不動。

### 刀 4：成片裝配層（`aid_episode_editor` 產物索引）

**姿態：直接拿（既有 B6 閘）+ 小改（加產物索引）**

> **2026-09-15 修訂**：原規劃的「時間軸 UI 新建」**廢除**（用戶裁定：Eimu 賣 one-shot，
> 提供在線剪輯工具違背產品宗旨）。本刀只做**後端產物索引**：讓成片成為可列舉、可回溯的
> 一等產物，前端沿用既有 chat 卡片與畫布節點呈現。

- **輪子源檔**：
  - `aid_episode_editor`（`timeline_json`/`final_video_url`/`final_video_fingerprint`/`pending_video_url`/`export_status`/`export_progress`/`export_task_id`/`export_fingerprint`）— `/tmp/aid-init.sql:1485`
  - **不拿**：`frontend/web/components/steps/video-preview/*`（24 檔前端時間軸 UI）、`@webav/*`（瀏覽器端剪輯）
- **我方對位（已上線，直接拿）**：
  - `Timeline` 型別 + op DSL：`src/vendor-bridges/gateway/timeline.ts:68/102`（**已含 `sceneId`/`shotSize`/`emotionTag`/`locked`/`group`/`costCoins`**）
  - 導出閘：`master.ts:30` `MASTER_PRESETS`（portrait_916/landscape_169/cinema_239）+ blockers 聚合 + `probeRenderedVideo`
- **白名單改寫**：AID 走阿里 MPS / 騰訊 IMS 回調（**不吞**，我方走 VPS ffmpeg + Chromium 花字鏈）；只吞其**實體欄位語義**與**前端時間軸交互**。
- **接線點**：
  - 成片索引：**加產物索引條目**（非新表）——掛 `artifact`（已有表）或 canvas 節點產物引用
  - 前端：**不新建**（沿既有 chat 影片卡 + 畫布節點呈現成片；時間軸編輯仍走 agent 對話）
- **後端建設**：`timeline` 已存 `$WORKSPACE_DIR/<entity>/<sid>/` 版本樹；`export` 產物落 `master_<preset>.mp4` + probe 校驗。
- **Agent 培訓面**：`timeline_*` 8 工具已在 VPS；AGENTS.md 加「成片導出必過 master 閘，blockers 非空即拒」。
- **全鏈生效定義**：分鏡 → 時間線（clips 有 sceneId/shotSize）→ `check` `ok:true` → `export` 出 mp4 → `ffprobe` 解析度/時長/音軌符合 preset。
- **風險**：中（UI 新建）。**但後端與門禁已上線，風險集中在純前端。**

### 刀 5：方法論資產入庫（143 條鏡頭詞庫 + 27 agent 契約 + 51 enums）

**姿態：直接拿（逐字複製 + 白名單改寫 + 授權標註，沿用 kunpeng 範式）**

- **輪子源檔**：
  - `aid_prompt_lib` 143 筆 — `/tmp/aid-init.sql`（行 2301 起，每行一筆；欄位 `prompt_type`/`prompt_name`/`prompt_content`/`cover_url`/`sort_order`）
  - `doc/提示词开发指南.md`（1307 行，27 契約）
  - 51 個 enums — `aid-interface/aid-interface-main/src/main/java/com/aid/enums/*.java`
- **白名單改寫**：
  - 詞庫：`prompt_content` 逐字保留；`cover_url`（AID OSS 路徑）→ 替換為我方資源或佔位卡（同名覆蓋配方）
  - 契約：agent_code 命名空間改我方（AID `aid_*` → 我方對應）；協議標記（`@圖片N[名稱]`）**原樣保留**
  - enums：Java → TypeScript 常數（值/語義逐字對齊，含 `desc` 中文）
- **接線點**：
  - 詞庫：**沿用 `kunpeng-prompt-templates.ts` 範式**（編譯期常數 + license/commit 標註）；若要運營可維護，掛 `asset-pack kind:"prompt"` + admin 新面板（**唯一真新建項**）
  - 契約：寫進 VPS harness 側（`workspace/.opencode/`）/ AGENTS.md / playbook
  - enums：`src/lib/` 新增型別常數模組（純常數，無邏輯）
- **後端建設**：無（編譯期常數）；若要運營面板才需存檔位置。
- **Agent 培訓面**：契約文字入 VPS agent 提示詞（雙源同步）；詞庫進分鏡 prompt 組裝鏈。
- **全鏈生效定義**：詞庫可搜尋（≥143 條）→ 選中詞條注入分鏡 prompt → 生成結果可見；契約修改後 agent 實際調用行為改變（可 grep VPS）。
- **風險**：低（純資料）。`cover_url` 圖片資產需另取（AID 官方資產包**不在 Release 內**，需確認可得性——**未驗證項**）。

---

## 3. 實作方法（工程姿勢）

### 3.1 吞併三姿勢（沿用 `docs/2026-08-25-swallow-decision-list.md` 框架）

| 姿勢 | 適用 | 本 PRD 落點 |
|---|---|---|
| **直接拿** | 我方已有同構能力 或 純資料資產 | 刀4 導出閘/時間線型別、刀5 詞庫/契約/enums |
| **小改** | 我方有 owner，缺欄位/型別 | 刀1 `CanvasProject` 擴欄、刀2 node metadata、刀3 asset-pack 加 kind |
| **新建** | 我方確實沒有 | **僅一處**（可選）：運營提示詞面板（刀5） |

### 3.2 授權與歸檔紀律（沿用 kunpeng 先例）

每個抄來的檔案頭部註釋塊固定格式：

```ts
/**
 * 輪子來源：gzxx-2025/aid-server（MIT，copyright 光子讯息(杭州)科技有限公司）
 * 源檔：sql/aid-init.sql（aid_prompt_lib 段）
 * 取得日：2026-09-15 | commit: <取證時 sha>
 * 逐字保留：prompt_type / prompt_name / prompt_content
 * 白名單改寫：cover_url（AID OSS 路徑）→ 本站資源；其他欄位剔除
 */
```

- 全部改寫逐條列在檔頭，**做不到「diff 除白名單外逐行等價」= 沒交貨**。
- `THIRD-PARTY-NOTICES.md` 追加 AID 條目（MIT 要求保留 copyright）。

### 3.3 派遣與驗收

- 2+ 檔或單檔 >50 行 → 派 subagent；orchestrator 只做定位/spec/派發/驗收。
- 常態 ≥3 路並發；完工一路立刻驗收並補派。
- 每片 spec 必含「必讀記憶」節（先驗實際路徑，**記憶有兩庫**：`/home/lenovo/.codex/memories/extensions/ad_hoc/notes/` 與 `/home/lenovo/.zcode/cli/memories/projects/image-app-63c110217f682752/memory/`）+ 標準配方（copy-paste 命令）。
- 驗證預期通過的閘（tsc / 契約測試 / 真 E2E），不跑預期失敗的測試。

### 3.4 已知坑位（寫進每片 spec）

1. **opencode 工具新增/修改後必 `restart opencode-server.service`**（第三次實錘；transcript 含工具名 = 假陽性）。
2. **新 metadata 欄位族必同步兩處白名單**：`toNodeMetadata` + `compactMetadataForAgent`（漏則刷新後空殼）。
3. **`tenant` 視角**：`CanvasNode` 是共用型別，改前 grep 全部消費端。
4. **DB migration 只增不改**（sha256 校驗，改已應用檔即 throw）。
5. **`pro-workstation/` 是殘骸**（2026-08-27 移除專業入口後）——唯一活體 export 是 `workstation-constants.ts:91 REFERENCE_IMAGE_ROLES`（被 `CanvasNodeView.tsx:24` import），動它前先確認不碰。
6. **記憶衝突三處已回報**：`kunpeng-vendor` 在倉外；`src/lib/editor/` 實際 12991 行（記憶寫 8795）；`boards-store.ts` 的「唯一 owner」註釋已過期。

---

## 4. 每刀的後端建設 / 培訓面 / 評測 ruler / 全鏈生效（四配套）

| 刀 | 後端建設 | Agent 培訓面（VPS 雙源） | 評測 ruler | 全鏈生效定義 |
|---|---|---|---|---|
| 1 作品/劇集 | 擴 `CanvasProject` + `/api/canvas/projects` 子路由（無 migration） | AGENTS.md 加實體契約條 | 實體持久化斷言（刷新後仍在）+ API 契約測試 | Blob 可讀 + 前端可見 + agent 寫入成功 |
| 2 分鏡 | node metadata + 壓縮器兩處白名單 | `storyboard_qc_17` 輸入 schema 對齊 21 欄 | 17 門禁 17/17 + 往返一致性測試 | agent 產 21 欄 → 門禁過 → 落節點 → 前端見 |
| 3 配音/音色 | asset-pack 加 `voice` kind + TTS adapter 分支 | `tts_speak` 參數說明 + 綁定優先條 | 音色清單 ≥5 + 綁定→artifact 帶 voice_code | 選音色 → 綁定 → 任務 → 可播放 |
| 4 成片 | `artifact` 產物索引（無新表） | `timeline_*` + master 閘規則進 AGENTS.md | `check` `ok:true` + `probeRenderedVideo` 通過 | 分鏡 → 時間線 → check → export → ffprobe 合格 |
| 5 方法論資產 | 編譯期常數（無後端）／可選運營面板 | 契約入 VPS agent 提示詞（逐字） | 詞庫 ≥143 條可搜 + 契約調用行為可 grep | 詞條注入 prompt → 生成可見；契約生效 |

---

## 5. 不吞清單（明確排除，避免範圍蔓延）

依使用者裁定 + 產品判斷排除：

| 項 | 理由 |
|---|---|
| 私有化部署 / 一鍵安裝 / Go 在線升級器 | **架構**，使用者明確不要；我方是 Vercel SaaS + VPS 控制面 |
| 實名認證 / 內容審核隊列 / 公告 FAQ 後台 / 邀請返利明細 | **運營配套**，使用者明確不要 |
| 阿里 MPS / 騰訊 IMS 特定回調 | 我方上游路徑不同（VPS ffmpeg + Chromium 花字） |
| RuoYi 後台框架 | 我方 admin 已有自己的面；RuoYi 是 AID 的技術債 |
| TokenDance OAuth 供應商接入 | 我方 `new-api` 渠道體系已覆蓋 |
| 口型同步 | **原判有誤**（見 §9 更正）；現列「待裁定」，不預設排除 |

---

## 6. 風險與未決（FACT / INFERENCE / HYPOTHESIS）

**已接受風險（有緩解）：**

1. `CanvasProject` 擴欄影響面 — 緩解：加法式 + `normalizeProject` 白名單範式 + 契約測試。
2. ~~時間軸 UI 新建成本~~（**已廢除**：用戶裁定不做在線剪輯工具）。
3. 詞庫 `cover_url` 圖片資產可能不可得（AID 官方資產包不在 Release 內）— 緩解：佔位卡同名覆蓋配方；**未驗證項**。

**開工前必須確認（阻塞實作）：**

1. 刀2「分鏡 = `group` 節點 + 子節點 metadata」vs「加第 13 種 `CanvasNodeType`」——需先 diff reducer 影響面再定。
2. ~~刀4 時間軸 UI 自繪 vs `@webav`~~（**已廢除**）。改為：刀4 產物索引掛 `artifact` 還是 canvas 節點產物引用（二選一，實作前定）。
3. 刀5 是否要做運營面板（決定是否需存檔位置 + admin nav 改動）。

**HYPOTHESIS（待驗證）：**

- 對手流水線精緻度主要來自**工序切分與契約強制**（27 契約 + 21 欄位 + 7 步狀態機 + 音色/口型鏈），而非模型能力。若成立，我方複製契約即得同等精緻度。（INFERENCE，需以我方實跑評測驗證）

---

## 7. 執行順序（排期）

| 波次 | 刀 | 並發 | 交付 |
|---|---|---|---|
| 波1 | 刀5（純資料，零依賴）+ 刀1（實體鏈起點） | 2 路 | 詞庫/契約入庫；劇集實體可持久化 |
| 波2 | 刀2（分鏡實體）+ 刀3（配音/音色） | 2 路 | 分鏡落節點；音色可選可綁 |
| 波3 | 刀4（成片產物索引，純後端） | 1 路 | check/export 全鏈 + 成片可列舉回溯 |

---

## 8. 附錄：取證座標（可複驗）

- AID 倉：`https://github.com/gzxx-2025/aid-server`（`main`）；檔案樹快取 `/tmp/aid-tree.json`（4464 檔，未截斷）
- AID init SQL：`/tmp/aid-init.sql`（1.8MB：schema + 143 詞條 + agent 提示詞初始資料）
- AID 方法論文檔：`/tmp/aid-prompt-guide.md`（1307 行，27 契約）
- AID 授權：`LICENSE`（MIT，copyright 光子讯息(杭州)科技有限公司，含 RuoYi 部分）
- 我方鏡像樹：`src/vendor-bridges/{editor,gateway,opencode-tools}/`
- 我方輪子源：`/home/lenovo/Desktop/kunpeng-vendor` @ `872a58b`
- VPS harness：`43.172.85.76:/opt/agent-harness/workspace/.opencode/tools/`（119 工具）
- 吞併先例：`docs/2026-08-25-swallow-decision-list.md`、`docs/2026-08-27-kunpeng-symmetry-survey.md`、`src/lib/kunpeng-prompt-templates.ts`

---

## 9. 更正登記（2026-09-15，AID 前端深挖後）

### 更正一：「AID 有 17 道門禁」— 撤回，此為我方資產

- **原寫**：刀 2 輪子源檔列「17 道門禁判據 — 逐條對照 AID 的 17 條」。
- **實情（FACT）**：AID 全倉（README 375 行、`deploy/README.md`、`doc/提示词开发指南.md`、
  `version/version.md`、`文件结构.txt`）**無一處**提「17 道門禁」；GitHub code search
  `17道`/`确定性门禁`/`storyboard_qc` 皆 0 命中。README 唯一的「17」是 Java 版本號。
- **AID 實際有的是**：約 **24 條未編號的分散校驗**（`throw ServiceException` 阻斷 +
  `log.warn("分镜内容质量告警: issue=...")` 告警），散在 5 個 helper：
  `StoryboardVisualDirectiveValidator`（有效正文覆蓋 7 條，含 4 態決策
  `EQUIVALENT/WARNING/EMPTY/CATASTROPHIC_TRUNCATION`）、`StoryboardSceneEnvelopeParser`（結構契約）、
  `StoryboardShotGroupPlanParser`（鏡頭組拆分 10 條，含 C5「模型輸出必須是原文子串」+ 命中後回填原文
  杜絕標點漂移）、`StoryboardDirectTaskSnapshotValidator`、`StoryboardWriterContentParser`（十字段閉包）。
- **「17 門禁」真源是我方**：`src/lib/shortdrama-domain/index.ts` 的 `STORYBOARD_GATE_IDS`
  （VPS `storyboard_qc_17.ts:108-124` 已逐條移植）。**本項變更性質**：從「吞 AID」改為
  「我方自有資產接入產品層」。
- **意外收穫（值得小改拿）**：C5 的「**命中後用原文區間回填**」手法——直接消除模型標點漂移入庫。
  低成本、高價值，建議納入刀 2。

### 更正二：「AID 口型同步未實作」— 撤回，AID 有完整實作

- **原寫**：不吞清單列「口型同步：業界無可複現輪子；維持誠實 unsupported（AID 亦未實作）」。
- **實情（FACT）**：AID **全鏈路完整實作**，且是全案最值得搬的設計之一：
  - **模型動態發現**（`StoryboardLipSyncServiceImpl.java:2135-2157`）：查 `aid_ai_model`
    的 `capability_json.lipSync=true`，**業務層零硬編碼模型名**；找不到明確拋「对口型未配置」。
    這與我方 `supplier-channels` registry claim 範式**同構**，但粒度更細（布林能力位）。
  - **上游**：Vidu `viduq3`（`/ent/v2/lip-sync`），音頻驅動；空 `audio_url` 才走文本驅動。
  - **驅動音頻補靜音**（`:2171`）：上游按音頻長度出片（15 秒源視頻出 3 秒成片），
    故提交前補靜音到源視頻時長（閾值 200ms）。
  - **計費粒度 5 秒**；SSE 進度 `PROGRESS_LIP_SYNC_BASE=60 + SPAN=40`（step id `lipSync`）。
  - **併發保護**：Redis 鎖 `storyboard:lip_sync:running:`（TTL 6h）+ workflow 鎖。
  - 能力約束（`sql/v2.1.0.sql:2100-2120`）：輸入視頻 1–600 秒、mp4/mov/avi、≤5120MB、單邊 360–4096px。
- **連帶影響**：我方 `lint.ts:95` 的「口型同步：語義層，當前行業無可復現檢測，誠實跳過」——
  該句指的是「**檢測/審核**」而非「合成」。合成有輪子，檢測仍無。**兩者需分開表述，不可混為一談。**
- **狀態**：列入待裁定（本輪不實作，因涉及新上游接入與計費，非「小改」）。

### 更正三：任務書前提「create/ 下 13 個頁面」— 實為 11 個

FACT：`frontend/web/app/create/` 下 **10 個子目錄 / 11 個 `page.tsx`**（根 `page.tsx` +
dubbing、global-setting、preview、scene-character、series-episode-list、series-script-upload、
story-script、storyboard-script、storyboard-video、studio）。先前「13 頁」記述錯誤。

### 更正四：文檔與 DB 的詞庫項數衝突 — 以 DB 為準

FACT：`doc/提示词开发指南.md:820-826` 稱 composition 15 項、focal_length 8 項、exposure_blur 8 項；
`aid_prompt_lib` DB 實際為 **16 / 9 / 16**。**已按 DB 取值**（我方 `lens-language-library.ts` 142 條
即以 DB 為源，且已過契約測試鎖定）。**教訓**：搬字典只信 DB，不信文檔。

---

## 10. 新增可搬資產（解剖後補，全部 FACT）

| 資產 | 座標 | 價值 | 姿勢 |
|---|---|---|---|
| 步驟完成判據（後端） | `CreationStepServiceImpl.java:205-350`（每步一個 `check*OrThrow`） | 7 步各自明確完成條件，不滿足直接拋 | 小改 |
| 前置未完成文案表 | 同上（「请先设置画面比例」等） | 錯誤訊息可教學化 | 直接拿 |
| 跨組切換語義 | `CreationModeEnum.isCrossGroupSwitch()` | i2v/multi（standard）↔ pro/auto_grid（advanced）切換需清空項目級生成配置 | 直接拿 |
| 枚舉註冊表 | `prompt/constant/EnumDictRegistry.java:43-65`（白名單註冊 23 枚舉）+ `POST /api/user/dict/enum/list` | **前端不寫死常量**，枚舉後端可運營 | 小改 |
| `timeline_json` 結構 | `compose/dto/timeline/TimelineData.java` + TS 鏡像 `types/business-api.ts:2411-2481` | **「段 × 軌」**：`segments[]` 每段掛 `video`/`voice`/`subtitle` **恆不為 null**；`@JsonInclude(ALWAYS)` 使出參結構恆定 | 直接拿 |
| **export 幂等指紋** | `VideoComposeServiceImpl.java:685-706`（`computeExportFingerprint():979`） | 素材歸一化 SHA-256（URL 轉相對路徑）；指紋相同且已成功 → **直接複用，不再合成不再扣費**，回 `reused:true` | 直接拿 |
| **待審/正式雙槽** | `final_video_*` / `pending_video_*` 雙指紋 + `ComposeResultListener.java:117-190` 四分支 | 「已公開內容重導出先落待審槽、舊片繼續展示、過審後轉正」 | 直接拿（若做審核） |
| **對齊策略 AUDIO** | `ComposeConstants.ALIGN_STRATEGY_AUDIO` + `buildTracks():201-306` | 段長取視頻/配音較長者；**視頻不足自動循環補畫面**（防成片中段黑屏 + 後續段音畫錯位） | 直接拿 |
| 導出前 8 道結構校驗 | `VideoComposeServiceImpl.java:516-535`、`validateExportGroups():1199` | 分組≤500、分辨率合法集、URL 等長、`rejectForbiddenUrl`（拒 `blob:`/`data:`/嵌套協議） | 直接拿 |
| 字幕分屏算法 | `SubtitleScreenSplitter.java:22-28` | 7–12 字/屏；切分優先級 換行 → 句末標點 → 句內停頓 → 均分硬切 | 直接拿 |
| 試聽設計 | `VoicePreviewController.java:14-45` + `VoicePreviewLimitService` | **同步、免費、不落庫**；provider 回 base64 不過 OSS；10 次/60 秒頻控；秒數×4.5 字/秒折算上限 | 直接拿 |
| 音色庫種子 | `aid-init.sql:426-428`（63 筆，`model_id=42` 火山 bigtts） | `character_types`/`voice_styles`/`tone_tags`/`emotion_tags` 四維 JSON 標籤 + 55 筆 `aid_ai_voice_tag` 字典 | 直接拿（資料） |
| 口型驅動音頻補靜音 | `StoryboardLipSyncServiceImpl.java:2171` | 上游按音頻長出片 → 補靜音對齊 | 待裁定 |

**新發現的 AID 缺口（我方可超越處，FACT）**：`CreationStepServiceImpl` 中 **step 5/6 的完成判據
與 step 4 完全相同**（皆 `aid_storyboard count > 0`），註解自陳「不校验是否已选定视频」——
「視頻已選定／配音已選定」**未被後端強制**，僅靠前端按鈕 `disabled`。**這是 AID 的結構漏洞，
我方若做狀態機，閘門應真正校驗該步產物，而非沿用其寬鬆判據。**

### 更正五：「④ 殭屍回收」— 撤回，我方已完整實作

- **原寫**：PRD 與回報把「素材提取殭屍回收 + 斷點續傳」列為我方缺口，建議從 AID 吞。
- **實情（FACT，已逐檔驗證）**：我方**已有且更完整**：
  - `src/lib/generation-core/job-repository.ts:831` `recoverExpiredGenerationLeases()`：
    ① `status='leased' AND lease_expires_at < now()` → 回到 `queued`（重排）；
    ② `status IN ('submitting','running') AND lease_expires_at < now()` → 轉 `submit_unknown`
    並**補排上游對帳**（`provider_next_poll_at` + 24h 對帳窗口）；
    ③ 順帶清 `supplier_lease` 過期列。
  - `src/lib/generation-core/worker-service.ts:437 / :501`：主維護循環**每 30 秒**呼叫，且
    `runGenerationMaintenanceOnce()` 供長駐/一次性兩種模式共用。
  - `src/lib/generation-core/billing-ledger.ts:578` `reclaimStaleBillingZombies()`：
    另有**計費態**僵屍回收（`pending_billing`/`billing_unknown`），走 `ZOMBIE_RECLAIM_BATCH` 批次。
  - 事件可審計：`emitJobEvent`（`job_events` append-only 賬本）。
- **對比 AID**：AID 的 `ExtractZombieReclaimTask` 是「超時標 FAILED + 退款 + 釋放鎖」；
  我方是「回 queued 重排 或 轉 submit_unknown 走上游對帳查真相」——**後者更誠實**（不假設失敗，
  先查上游真相再結算）。我方版本**不需要吞 AID**。
- **教訓**：本次兩輪把「我方已有」誤判為缺口（③ 條目類似）。**根治動作已記**：列缺口前必先
  `grep -rn` 關鍵詞（`reclaim|zombie|lease|heartbeat`）驗證，不得憑功能名推論。

### 更正六：真缺口替換（由「容易拿的」補上）

④ 撤回後，位置由**已驗證為真缺口**的三項取代（本輪施工中）：
`master.ts` 無**導出指紋（幂等）**、無 **URL 守衛**、無**字幕分屏**（已 grep 全 gateway 確認無命中）。
來源見 §10（AID 的 `computeExportFingerprint` / `MaterialUrlGuard` / `SubtitleScreenSplitter`）。

---

## 11. 驗收紀律修正：tsc 覆蓋範圍漏洞（2026-09-15 實錘）

### 漏洞（FACT）

`tsconfig.json:38-47` 的 `exclude` 排除了 **`src/vendor-bridges`**、`deploy-staging`、`staging`、
`mcp-server`、`plugins`、`eval-*`，以及**全部 `**/*.test.ts` / `**/*.test.tsx`**。

**後果**：專案標準驗收命令 `npx tsc --noEmit -p tsconfig.json | grep -c "error TS"` 回 0，
**不代表 0 錯，而是「這些目錄根本沒被檢查」**。本次刀 0 的 `lens-language-library.ts`（`src/lib/`，在覆蓋內）
與刀 1 的 `creation-flow-steps.ts`（`src/lib/`，在覆蓋內）**受檢**；但
`src/vendor-bridges/gateway/material-fingerprint.ts` / `subtitle-splitter.ts`（本次新增）**完全不受檢**。

### 修正後的驗收命令（三條並跑，全部要過）

```bash
# ① 主庫型別（既有命令，覆蓋 src/lib、src/app、src/components）
npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c "error TS"          # 必須 0

# ② 被 exclude 目錄的隔離檢查（本次新增/改動檔逐個列出）
npx tsc --noEmit --skipLibCheck --target es2022 --module esnext \
  --moduleResolution bundler --strict --types node \
  <新增檔1> <新增檔2> ...                                              # 必須 0

# ③ 測試——tsc 不管測試檔，只有真跑才算驗證
npx --yes tsx --test <測試檔>                                         # 必須全綠
```

### 既有基線（勿誤判為本次引入）

`src/vendor-bridges/gateway/` 在隔離檢查下有 **既有型別錯誤**（本次改動前即存在）：
- `gateway/*.ts` 進口 `./editor/...`，但 `editor/` 實際在 **`src/vendor-bridges/editor/`**（`gateway/` 的**上層**），
  路徑應為 `../editor/...` → 78+38+26+4+4 條 `TS2307`/`TS2339`（`timeline.ts` 78、`lint.ts` 38、`master.ts` 26、`style.ts` 4、`mix.ts` 4）
- 成因：該目錄為 VPS 執行碼的本地寫入副本，**不走 Next.js 建置**，故長期未被 tsc 覆蓋
- **本次新增的 `material-fingerprint.ts` / `subtitle-splitter.ts` 隔離檢查為 0 錯**（已複驗）

### 鐵律（新增）

1. **宣告「tsc 0 錯」前，必先確認被檢查檔案在 `tsconfig.include` 內**；不在就補隔離檢查，並在回報中註明「0 是空集合還是真空集」。
2. **測試檔永遠不受 tsc 覆蓋**——「型別過」不等於「測試過」，兩者必須分別執行、分別回報。
3. 既有基線錯誤與本次引入錯誤必須分開計數（方法：`git stash` 後重跑對比，或按檔歸屬統計）。
