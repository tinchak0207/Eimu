# Previs Harness 解剖报告（anatomy.md）

- 日期：2026-10-22（Asia/Shanghai，UTC+8）
- 性质：只读调研；不改代码、不部署、不付费
- 仓库：`/home/lenovo/Desktop/image-app`
- 机台：archlinux（machineId `ca347797-ce97-494a-869f-61fd9b1b365f`）
- 记忆冲突处理：以现场源码为准；记忆称「只缺 SequenceShot→bpy 转换器」——对 **Blender L2 静帧交付** 成立，对用户目标「一句话→丝滑可播 3D 预演」不充分（见缺口表）
- 可选 Playwright 截图：未做（时间预算内优先写报告；无暂存路由可杀）

---

## 1. 现有管线图（文件:行号为证）

### 1.1 产品目标 vs 现状一句话

| 用户想要 | 现场实际产出 |
|---|---|
| 一句话 → agent 编排 → **实时可播、丝滑美观**的 3D 预演（真动作/运镜/光影）→ 再喂下游视频 | 一句话 → agent 写 **DirectorDoc**（白模胶囊人形 + 程序化关节角 + 起止机位插值）→ 聊天卡/画布小视口 **rAF 连播** → 「生成真实画面」截一张白模 PNG 给 `image_edit`；影片模板则要求把预演帧 URL 写入 `shot.previz.keyframes` 并进 `reference_images` |

### 1.2 数据契约（唯一真源，禁造新 schema）

```
自然语言
  │
  ▼
director_propose_plans  ──► planning-core.fallbackPlans ──► 2–3 套候选 DirectorPlan
  │                              (src/lib/director-engine/planning-core.ts:300-312)
  │                              关键词抽动作 (ACTION_KEYWORDS L64-96)，非 LLM 编排
  ▼ 用户确认
director_apply_proposal
  │
  ▼
DirectorDoc（gateway）
  elements[] / plans[].shots[] / currentTimeSec / playing
  (src/vendor-bridges/gateway/director-types.ts:89-108)
  │
  ├── DirectorSequenceShot = DirectorShot
  │     + startSec + durationSec
  │     + cameraEnd{position,target,fov,rollDeg}
  │     + cameraMove (24 枚举)
  │     + cameraKeyframes?
  │     + elementStates + actions[]
  │   (src/lib/director-engine/types.ts:214-225)
  │
  ├── DirectorActionClip + optional DirectorMotionKeyframe[]
  │     (joints 程序化 animatedJoints，非骨骼 clip)
  │   (types.ts:161-176; playback.ts:86-138)
  │
  └── POSE_PRESETS 12 / MOTION_TEMPLATES 60+ / CAMERA_TEMPLATES 24
        (poses.ts:17-63; motionTemplates.ts:21-57; cameraTemplates.ts:17-46)
```

### 1.3 播放与视口

```
GET /api/agent/sessions/<sid>/director/state
  │  (DirectorMiniViewport.tsx:176-188)
  ▼
evaluateDirectorFrame(plan, elements, t)
  │  shotAtTime 按 startSec+durationSec 切镜 (playback.ts:173-177)
  │  相机：cameraKeyframes 优先，否则 position↔cameraEnd 平滑插值 (L184-195)
  │  角色：applyAction → animatedJoints / keyframe joints lerp (L140-167)
  │  路径：pathCurve.evaluatePathSegment 三次贝塞尔 (pathCurve.ts:25-36)
  ▼
DirectorEngine.syncElements + applyCameraPose
  │  AmbientLight 0.7 + DirectionalLight 0.9 (engine.ts:107-110)
  │  Fog + 深灰背景；无 Bloom/粒子/HDRI/后期
  │  mannequin = Capsule/Sphere Group 关节树，非 SkinnedMesh (mannequin.ts:1-87)
  │  setGltfAsset 可挂 glTF 展示壳，**明确不播 AnimationClip** (assetLoader.ts:9)
  ▼
rAF：t += dt，末尾 % duration 循环 (DirectorMiniViewport.tsx:246-255)
用户见：AgentDirectorCard / 画布 Director 节点内小卡 ▶预演
```

### 1.4 Agent 写入面（17 个 director_* 工具）

真工具：`src/vendor-bridges/opencode-tools/director_*.ts`（17 个；清单见 harness-tool-ids）

| 工具 | 作用 |
|---|---|
| `director_get_state` | 读工程 + capabilities（action/camera/pose 注册表） |
| `director_propose_plans` / `director_apply_proposal` | 候选方案 → 用户确认后写入 |
| `director_manage_plan` / `director_manage_shot` / `director_upsert_action` | 方案/镜头/动作 CRUD；manage_shot 可套 `cameraPatchFromTemplate` |
| `director_set_camera_keyframe` / `director_set_motion_keyframe` | 细粒度 K 帧（影片模板 requiredTools 已列） |
| `director_create_element` / `update_element` / `delete` / `manage_group` / `select` / `set_lock` / `transport` / `project_control` | 元素与播放控制 |
| `director_prepare_export` | **只**校验 in/out 帧 + save；**不渲染、不录视频**（prepare_export.ts:9-40；capabilities.export_boundary） |

教学面：

- 前端模板「小说影视化 / 剧本视觉化」：`director_get_state → propose → apply → manage_shot/upsert_action`（`novel-film-pipeline.ts:17`、`shortdrama-visual-assets.ts:112-114`）
- 影片模板 previz text 节点：`director_manage_shot` + `set_camera/motion_keyframe` + `blender_exec/render`（`feature_film.ts:130-145` 等同构）
- `video-director/references/motion-first.md:66-84`：L1 白模 → L2 Blender → bash 光栅兜底
- `blender-director/SKILL.md` + `seed-mapping.md`：L1→bpy 映射文档；**声明禁止改 director-engine**，缺的是转换器而非新 schema

### 1.5 下游视频怎么取预演

```
agent 渲出首/中/尾帧 URL
  │  必须写入该镜 shot.previz.keyframes（写进节点正文不算）
  ▼
workflow-gw 并入 reference_images
  (deploy-staging/gateway/workflow-gw-submit.ts:403-412；commit 4a34357c)
  │
  ▼
视频模型参考条件（非成片像素）
同时：directVideoPrompt 强制状态变化合同 (invisible-prompt-director.ts；4a34357c / 74ebf1d1)
能力闸：kind=director 节点仍被 markDirectorSkipped；生产用 kind=text 的 previz 卡 (workflow-service.ts:334；5a6e1db3)
```

前端「生成真实画面」另一条路：小视口 `capture` → 上传 → 注入 `[导演台镜头渲染请求]` 调 `image_edit`（DirectorMiniViewport.tsx:91-161），是**单帧生图**，不是预演视频。

### 1.6 资产现状

| 位置 | 内容 | 与 director-engine 关系 |
|---|---|---|
| `.blender-work/assets/` | CC0：3 HDRI + 3 PBR 纹理 + 4 街景 GLB + `human_base_meshes`（**无骨架**） | 给 Blender L2；引擎不读 |
| `.blender-work/out/*.glb` | 历史 spider/chase 等场景导出 | 可经 `setGltfAsset` 展示，无 clip 播放 |
| `.asset-cache/kaykit-skeletons` | 已绑定+90+ 动画 FBX/gltf | **引擎未接入 AnimationMixer** |
| `.asset-cache/kaykit-adventures` / kenney | 角色/道具 | 同上 |
| `public/` | 无角色动画库 GLB | — |
| Mixamo | 无本地库；中国区账号限制（见同目录 `external.md`） | — |

---

## 2. 对照「一句话→丝滑可播预演」的分层缺口表

工作量：S ≤1 人日 · M 2–5 人日 · L 1–2 周 · XL 多周（不含审片迭代）

### 2.1 编排（LLM → 序列）

| | |
|---|---|
| **现状** | `propose_plans` 走 `fallbackPlans`：关键词正则抽动作 + 三套固定风格（克制观察/压迫跟随/运动调度），**LLM 呼叫点已切除**（planning-core.ts:44、335-336 注释）。模板教 agent 逐步调 `manage_shot`/`upsert_action`，能拼出多镜时间线，但不是「一句话自动成片级编排」。武侠连招/慢动作/粒子大招无专用动作 ID。 |
| **证据** | planning-core.ts:300-312；ACTION_KEYWORDS L64-96；types.ts DirectorActionId 无 punch/slash/vfx |
| **缺什么** | 恢复或新建 LLM→RawPlan 编排（仍落既有 DirectorSequenceShot）；打斗/特效 beat 词表或模板；多角色对抗 blocking 启发式 |
| **工作量** | L（编排恢复 + 打斗词表）；勿新造 schema |

### 2.2 角色动作

| | |
|---|---|
| **现状** | mannequin = 胶囊/球 Group 关节树（mannequin.ts:1-87）。播放时 `animatedJoints` 用 sin/ease 改 11 关节角（playback.ts:86-138）；可有 5-KF `createMotionKeyframes`（motionTemplates.ts:67-78）。**无 AnimationMixer、无骨骼 clip、无 IK、无武器约束。** `setGltfAsset` 明确「动画 clip 本片不播放」（assetLoader.ts:9）。 |
| **证据** | mannequin.ts；playback.ts；assetLoader.ts:9；全仓 director-engine 无 AnimationMixer |
| **缺什么** | 蒙皮角色 + clip 库（Kaykit/Quaternius CC0 已在盘/可引，见 external.md）接到元素；或至少把 clip 名映射进 ActionClip 并由 mixer 驱动；打斗 clip 集 |
| **工作量** | L–XL（接入 mixer + 重定向 + 动作挑选）；胶囊程序化再打磨 **达不到** 标杆丝滑 |

### 2.3 镜头与剪辑

| | |
|---|---|
| **现状** | 多镜时间线连播：`shotAtTime` + planDuration（playback.ts:169-177）；小视口整 plan 循环。运镜：24 种模板生成 cameraKeyframes，或退化为起止 lerp + ease（cameraTemplates.ts:62-111；playback.ts:184-200）。handheld 有 sin 抖动。有越轴/碰撞健康检查（inspectDirectorPlan L230-301）。**无剪辑点特效（闪白/震屏/切镜 ease）、无多机位 A/B 卷、无慢动作时间重映射字段。** |
| **证据** | playback.ts:169-200；DirectorMiniViewport.tsx:246-255 |
| **缺什么** | shot 级 timeScale/慢动作；切镜过渡；agent 更常用 set_camera_keyframe（工具在，模板已列，编排层少主动写复杂路径） |
| **工作量** | M（慢动作+切镜）；复杂弧线运镜已有样条，主要是编排利用率 |

### 2.4 渲染美观

| | |
|---|---|
| **现状** | Ambient+单 Directional、Fog、灰网格地面、MeshStandard 素色（engine.ts:92-132）。无环境贴图/PMREM、无阴影级联、无后期（Bloom/AO/运动模糊）、无粒子。panorama 可设等距背景（setPanorama）。Blender L2 有 HDRI/PBR 资产与 delivery 档，但是**离线静帧/turntable**，不是实时预演视口。 |
| **证据** | engine.ts:92-110；无 EffectComposer；.blender-work/assets/manifest |
| **缺什么** | 实时：HDRI + contact shadow + 轻量 bloom/粒子（three.quarks 等，见 external.md）；或接受「预演=调度正确、美观靠下游」的产品分层 |
| **工作量** | M（实时好看一档）；XL 若要对齐 30s 成片级粒子大招 |

### 2.5 播放流畅

| | |
|---|---|
| **现状** | rAF + 每帧 CPU 重算 joints/lerp，场景极简，同屏 WebGL ≤2（DirectorMiniViewport.tsx:43）。性能对白模够用。卡顿感主要来自**内容**：动作是三角函数摆腿、无惯性/落地、切镜硬切、无运动模糊。 |
| **证据** | DirectorMiniViewport 播放循环；animatedJoints sin 驱动 |
| **缺什么** | 骨骼 clip 插值本身带来流畅；可选 fixed-step 与 monitor 机位主视角（attachMonitor 已有，小卡未默认用 shotCamera 全屏） |
| **工作量** | S–M（播 shotCamera 全屏预览）；流畅度主瓶颈在 2.2 |

### 2.6 导出下游

| | |
|---|---|
| **现状** | 引擎有 `captureShot`/`captureTransparent`/`captureTopView` → PNG dataURL（engine.ts:798-845）。类型枚举含 `previs-video`（types.ts:237）但 **无 MediaRecorder/逐帧录 MP4 实现**。`director_prepare_export` 明确不导出（prepare_export.ts:9-40）。下游靠：① 人工/agent 截关键帧写 `shot.previz.keyframes`；② 「生成真实画面」单帧 image_edit；③ Blender `blender_render` 多帧。 |
| **证据** | types.ts:237；prepare_export.ts；workflow-gw-submit.ts:403-412 |
| **缺什么** | 一键：按 plan 逐帧 capture → ffmpeg 或 MediaRecorder → 上传 URL 自动填 previz.keyframes；SequenceShot→bpy 转换器（记忆缺口，约 150 行）供 L2 |
| **工作量** | M（浏览器录制+填 URL）；M（bpy 转换器，勿新 schema） |

---

## 3. 可直接复用的轮子清单（禁止重造）

### 3.1 契约与播放核（必须复用）

| 轮子 | 路径 | 用途 |
|---|---|---|
| 类型契约 | `src/lib/director-engine/types.ts` | DirectorDoc/SequenceShot/ActionClip/Keyframe；**禁第二套 shot spec** |
| 播放求值 | `playback.ts` | 多镜连播、缓动、关节动画、健康检查 |
| 路径样条 | `pathCurve.ts` | 三次贝塞尔 pathIn/pathOut |
| 姿势/动作/运镜库 | `poses.ts` / `motionTemplates.ts` / `cameraTemplates.ts` | 12 pose · 60+ action · 24 cameraMove + KF 生成器 |
| 规划核 | `planning-core.ts` | fallbackPlans / 关键词动作 / RawPlan→DirectorPlan |
| 引擎 | `engine.ts` + `mannequin.ts` | three 场景、截图、gizmo、monitor、setGltfAsset |
| 资产载入 | `assetLoader.ts` | glTF 归一化落地（扩 clip 时在此延伸，勿另起 loader） |
| 小视口 | `src/components/director-mini/DirectorMiniViewport.tsx` | 生产播放 UI + 生图注入 |
| 聊天卡 | `AgentDirectorCard.tsx` | 会话内展示 |

### 3.2 Agent / Gateway（必须复用）

| 轮子 | 路径 |
|---|---|
| 17× director_* 工具 | `src/vendor-bridges/opencode-tools/director_*.ts` |
| DirectorDoc 存储/ops | `gateway/director-types.ts` · `director-store.ts` · `director-ops.ts` · `director-proposals.ts` |
| capabilities 暴露 | director-types.ts:44-67（agent 勿再 bash 翻档） |
| L1→bpy 映射文档 | `deploy-staging/opencode-runtime/skills/blender-director/seed-mapping.md` |
| 影片预演纪律 | `skills/video-director/references/motion-first.md` |
| previz→reference_images | `workflow-gw-submit.ts` + 三影片模板 previz 节点 |
| Blender 三工具 | `src/lib/blender-tools.ts`（真源；staging 为导出物） |

### 3.3 本机资产（可挂，勿重下同质）

| 资产 | 路径 |
|---|---|
| CC0 场景库 | `.blender-work/assets/`（manifest.json 11 条） |
| 人体基模（无骨） | `.blender-work/assets/humans/human-base-meshes.blend` |
| 已绑定动画包 | `.asset-cache/kaykit-skeletons`（90+ anim） |
| 冒险角色包 | `.asset-cache/kaykit-adventures` |
| 外部对称差（动作库/后期/粒子候选） | `docs/evidence/previs-harness-20261022/external.md`（Quaternius CC0、three.quarks、theatre core 等） |

### 3.4 明确不要重造

- 新 shot JSON / previs_compile schema（2026-10-22 已删 665 行，记忆 `director-sequence-shot-is-previz-contract`）
- 新坐标约定（用 seed-mapping.md §4：Y-up→Z-up）
- 新 pose 库替代 POSE_PRESETS（可**追加** id，勿平行第二套）
- 用 Blender 静帧采样冒充「实时丝滑预演 harness」的主路径（那是 L2 交付/参考帧，不是播放层）

---

## 4. 对六个必答问题的直接答复

1. **现在实际能做到什么**  
   生产上 agent 产出 **DirectorDoc**（白模工程），用户在聊天/画布小卡里 ▶ 连播预演；可截帧喂 `image_edit` 或把帧 URL 写入 `shot.previz.keyframes` 进视频参考。Blender 是并行 L2（静帧/turntable/GLB），常被用来「建模做出来」，不是小卡实时播放后端。

2. **播放层**  
   支持多镜头时间线连播与循环；插值有 hold/linear/smooth/ease-in/out + 路径贝塞尔；角色随时间变（程序化关节，不是静态单 pose）。帧率=显示器 rAF；场景轻，性能通常够。

3. **角色**  
   胶囊体关节 Group，**不是**蒙皮骨骼；无 AnimationMixer/clip 能力（glTF 仅展示壳）。

4. **视觉**  
   双灯+雾+素模；无粒子/电影后期/环境光探头。美观上限远低于 30s 武侠标杆。

5. **Agent 接口**  
   17 个 director_*；capabilities 已列模板。常用 propose/manage_shot/upsert_action；`set_*_keyframe`、复杂 cameraKeyframes、joints 细调、prepare_export 利用率低。prompt/skill **有**教序列编排（模板纪律 + motion-first），但 propose 核是规则 fallback 非 LLM 导演。

6. **导出**  
   能截 PNG；类型预留 previs-video 但无实现；工具面不录视频。下游靠关键帧 URL / Blender 渲染，无「预演 MP4 一键出」。

---

## 5. 建议切入顺序（调研结论，非施工）

1. **承认分层**：L1 实时预演（director-engine）解决 blocking/节奏可读；「成片级美」在 L2/视频模型——不要用 Blender 判准打磨胶囊体。  
2. **最大杠杆**：Kaykit/Quaternius clip → `AnimationMixer` 挂到元素（复用 assetLoader/setGltfAsset），ActionId 映射 clip；不动 DirectorSequenceShot 字段形状。  
3. **第二杠杆**：plan 逐帧 capture → 自动填 `previz.keyframes`（打通 4a34357c 已铺的网关）。  
4. **第三**：SequenceShot→bpy 转换器（记忆缺口）服务 L2，仍禁止新 schema。  
5. **编排**：再考虑恢复 LLM→RawPlan；在动作库不够前，LLM 只会更漂亮地调度空动作。

