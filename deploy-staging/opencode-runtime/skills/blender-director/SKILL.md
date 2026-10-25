---
name: blender-director
description: 3D/Blender 任务路由与执行配方库入口：委托单含 previz／3D／模型／场景／机位／运镜／骨架／turntable／分镜预演 关键词时必载（走 blender_exec / blender_render / blender_export_gltf 三工具链）。
---

# 3D 导演（Blender Director）SKILL

> 配方库来源（轮子，License: MIT，原作者 arjun988）：
> https://github.com/arjun988/blender-skills — 94 个专业 Blender skill 的生产管线，
> 本目录取其中 11 个 + 共享 references（共 12 份配方）逐份复制，白名单改动见各档头部注释。

## 3D 任务路由硬规则（先于一切，T4 评测实锤）

**委托单含 previz / 3D / 模型 / 场景 / 机位 / 运镜 / 骨架 / turntable / 分镜预演 关键词时，必须走本 SKILL 的 blender_* 三工具（blender_exec / blender_render / blender_export_gltf），禁止以 gpt-image-2、seedream 等二维生成顶替 3D previz。** 报价前先核对工具清单：3D 任务预算单只允许 blender_* 工具链（或 asset_search/asset_get 复用），出现二维图像模型 = 路由错误，重读本节。

## 能力闸门（2026-10-20 现场）

本 SKILL 的五阶段是 **Blender 可用时**的权威配方；当前生产席位可能拿不到 `blender_*`，也不是每台桥主机都装了 Blender。开工前必须过这道闸：

1. **先查真实工具表**：确认 `blender_exec` / `blender_render` / `blender_export_gltf` 在当前席位真的可用（看 live 工具清单，不看本 SKILL 宣称、不看工具文件存在）；再查桥主机 `command -v blender`。
2. **不可用就不要调用 blender_\***，改走「自建几何 + 光栅渲染」兜底：用 bash（纯 Python/Node 都行）自建相机与物体几何，代码算投影后光栅化出图，产出首/中/尾关键帧、GLB，以及每帧对应的机位/动作参数。`.blend` 标缺。
3. **交付卡六栏里 `blend_path` 允许为 null**，但必须写明原因（如「本席位无 blender，.blend 未交付」）；截图/帧与 GLB 不能伪造，必须是真几何渲染产物。
4. 本节**优先于上方「3D 任务路由硬规则」**：blender_* 不可用时按本节降级，不得为了守路由而虚构 3D 能力或用二维文生图顶替。
5. 本节只加能力闸门与降级顺序，不改五阶段配方本身。

## 执行环境契约（先读）

1. **执行通道**：所有 bpy 脚本通过 bridge HTTP 执行 —— `POST /v1/execute`（blender-mcp 同构协议，Blender headless）。禁止在回复里口述 UI 操作步骤。
2. **产物路径**：一切产物（渲染帧、截图、导出文件、.blend 存档）必须写 `$BLENDER_WORK/out/`，禁止写其他位置。
3. **Blender 版本**：Blender 5.2 LTS。上游配方按 3.x/4.x 写的 API 差异已在配方头部以注释校正（只改 API 名，逻辑不动）。
4. **渲染器**：按交付档选（见下「交付级 3D 档」），不按引擎偏好选。previz 用 Eevee 低采样；delivery 用 Eevee 128 TAA + RT on，或 Cycles 512 spp。

## 交付级 3D 档（2026-10-22 起：先定档，再建模）

开工第一句先判档。档位决定场景预算、渲染参数与验收门槛，**禁止用 previz 的设置交成品**。

| 档 | 入口判据（满足任一） | 渲染参数 | 验收门槛 |
|---|---|---|---|
| `previz` | 用户明确说「预演／分镜／blocking／机位预演／白模」，且产物是喂给影片的前置 | `.blend` 内 Eevee `taa_render_samples=16` + `use_raytracing=False`，分辨率 50%，`quality:"preview"`（该参数只表示不强提档，不会自动把场景改成 16） | 构图/机位/动作可读 + 相机净空；不要求 PBR 可信度 |
| `delivery` | 用户要「建模做出来／成品图／场景／单帧画面／产品图／封面」，或交付物本身就是最终图像/模型 | Eevee：`quality:"final"` + `samples:128`（RT on、阴影开、100% 分辨率）；复杂反射/折射/体积走 Cycles：在 `.blend` 内设 `cycles.samples=512`、`adaptive_threshold=0.01`、`use_denoising=True`、`resolution_percentage=100` | 场景预算 → 数值 QA → 7 视角证据页 → 独立评审逐特征 PASS → **自己看过渲染图** |

**交付级硬闸（缺一即不得称为成品）**：

1. **画质回执**：Eevee delivery 的 `render_quality.degraded` 必须为 `false`，`effective.samples_actual ≥ 128`。降级链掉到 64/32/16/4/1 说明桥内崩过——改走 Cycles 或拆场景重渲，**不许把 1spp 图当成品交**。
2. **自己看过图**：交付前用 `read_image`（或 `vision_analyze`）真看渲染图，逐条核对 `recipes/qa-review/RECIPE.md` 的 NO-SHIP 清单；只凭回执 `public_urls` 不算交付（唯一例外：1024 单件几何快路径）。
3. **场景预算**：资产族 ≤8、mesh 对象 ≤120、evaluated tris ≤180k、材质 ≤24、受控碎片 ≤60 实例／≤20k tris／1 材质。每个资产族先做 1 个 representative，过 QA + 视觉评审后才允许复制（来源：ifBars/blender-agent-studio, MIT）。
4. **相机净空**：相机 0.5m 内零几何；到头部/胸部/接触点各 3 条 ray，≥90% 首个命中是主体；主体占较紧轴 80–88%。
5. **数值 QA**：z-fight 共面 <1mm、漂浮缝隙 >2mm、未应用缩放、缺 UV、`ground_z` 偏离 0——全部零容忍（容差来源：EL4CTEO/blender-skills, MIT）。
6. **独立评审**：作者 ≠ 评审；每个 critical feature 一行 PASS/FAIL/UNKNOWN 并附证明视角；同一特征失败 2 次换方法类，3 次停手要输入，最多 3 轮。

> **资产先于几何（2026-10-22）**：开工第一步查本地 CC0 资产库 `$BLENDER_WORK/assets/manifest.json`（免费、无网络），按 `kind`/`tags` 命中就先 `load_hdri`／`append_human_base`／`append_model`／`apply_pbr_texture`，查空才自建并在 ledger 写明理由；**人形主体必须用 `human_base` 资产，禁止胶囊体拼接**。细则与可照抄脚本 → [`recipes/asset-first/RECIPE.md`](recipes/asset-first/RECIPE.md)。

> 参数出处：`Eevee 16 / 128 TAA` 与 `Cycles 512 spp / adaptive 0.01` 取自 EL4CTEO/blender-skills（MIT）渲染 preset；场景预算取自 ifBars/blender-agent-studio（MIT）whole-scene 基准；相机解算形态参考 jangtrinh/design-os-3d-blender（PolyForm Shield，**仅学形态，未抄文案/代码**）。其中 `fill 80–88%` 由产品/角色构图迁移到动作镜头，`0.5m 净空`、`90% 视线`、`1.5× 边长变化`为按本轮失败形态合成的**推断值**，上线前用 2–3 个真实场景校准。每条判准的复算方法见 `recipes/qa-review/RECIPE.md`。

## 五阶段管线

```
①blockout → ②相机 blocking → ③灯光 → ④骨架动画 keyframe → ⑤渲染
```

每阶段：何时做 → 用哪个配方档 → 阶段完成判据。上一阶段判据未达成，禁止进入下一阶段。

---

### 阶段 ①：Blockout（灰盒布局）

- **何时做**：接到委托单/分镜表后的第一件事。只关心比例、位置、导航路径，不碰材质细节。
- **先查资产库**：第一步查本地 CC0 资产库 `$BLENDER_WORK/assets/manifest.json`（免费、无网络），命中即 append（细则 `recipes/asset-first/RECIPE.md`）；本地查空再 `asset_search` 查 blender-3d-assets 包与用户资产包（免费），同形/同构场景或可复用道具直接 `asset_activate` 取出，全查空才自造。（生效条件：agent.director 条目并入 VPS opencode.json 且 persona 白名单放行 asset_search/asset_get 后可用；主指令 AGENTS.md §1 路由行已先上线。）
- **配方档**：
  - `recipes/scene-assembly/RECIPE.md` — 集合结构（COL_Layout/COL_Blockout/…）、灰盒规则、性能卫生
  - `recipes/set-dressing/RECIPE.md` — 布局锁定后的叙事道具簇与密度规则
- **阶段完成判据**（每项都能用 bpy 语句复算）：
  - [ ] 集合层级按命名规范建立（见 `recipes/references/naming-conventions.md`）
  - [ ] 场景预算表已填（资产族/mesh 数/评估 tris/材质/碎片），且未超本节档位上限
  - [ ] 每个资产族已有 1 个 representative，尚未批量复制
  - [ ] 相机可达：`min(相机到各 mesh 表面的距离) ≥ 0.5m`（`scene.ray_cast` 或最近点查询）
  - [ ] 包围盒与集合归属对照 `recipes/references/validation-checklist.md`，无 `ground_z` 偏离 0

### 阶段 ②：相机 blocking（分镜机位）

- **何时做**：blockout 判据达成后。把每个镜头的机位/焦距/构图定死，动画前锁机位。
- **配方档**：
  - `recipes/camera-cinematography/RECIPE.md` — 焦距指南、构图清单、运镜表、DoF
  - L1 种子数据直迁：机位/运镜初值优先从 director-engine 种子映射（见 `seed-mapping.md`），再按配方精调
- **阶段完成判据**（构图是二元判定，不是形容词）：
  - [ ] 每镜头 `CAM_[Shot]_[Angle]` 命名、入 `COL_Cameras`
  - [ ] 主体 bbox 8 角 `world_to_camera_view` 全部 `0.03 ≤ u,v ≤ 0.97` 且 `z > 0`（无角在相机后/出画）
  - [ ] 主体占较紧轴 80–88%（`fill=0.82`）；机位距离由 `d = R / sin(fill·θ)` 解出，不是拖相机凑的
  - [ ] 相机 0.5m 内零几何；到头部/胸部/接触点各 3 条 ray，≥90% 首个命中是主体
  - [ ] 起幅/中点/落幅三帧都过上述断言；主体 bbox 中心位移方向一致（有意停顿须在镜头表写明）
  - [ ] 前景只允许 1 层声明物，占画面 <15%，不遮脸/手/接触点

### 阶段 ③：灯光

- **何时做**：机位锁定后。Eevee 快稿先打三灯定氛围；品质档再进 HDRI/体积。
- **配方档**：
  - `recipes/lighting/RECIPE.md` — 三点布光、色温表、HDRI、恐怖光、体积光
- **阶段完成判据**：
  - [ ] 每盏灯有动机，命名 `LGT_[角色]_[描述]`，入 `COL_Lights`
  - [ ] key:fill 功率比 3:1 ±20%；key 45°±10° 侧、仰角 30–40°
  - [ ] Eevee 预览帧写 `$BLENDER_WORK/out/`，直方图：≥250 的像素 ≤0.5% 画面；≤5 的像素 ≤2%，且不得吞掉主体边缘
  - [ ] 剪影判定：遮掉背景转 1-bit、长边缩到 128px，连通域数 = 声明主体件数；评审只看剪影能写出与委托一致的姿态动词（写不出 = FAIL，方法见 `recipes/qa-review/RECIPE.md`）
  - [ ] 色温一致：同组灯的色温差 ≤500K，除非分色打光已在镜头表声明

### 阶段 ④：骨架动画 keyframe

- **何时做**：需要角色/物体运动时。绑定在前，keyframe 在后；循环动作先验循环接缝。
- **配方档**：
  - `recipes/rigging/RECIPE.md` — 骨架命名/层级、IK vs FK、权重、形变测试
  - `recipes/animation/RECIPE.md` — 摆块→样条→打磨流程、循环验证、NLA
  - L1 种子直迁：动作关键帧初值从 director-engine 模板映射（`seed-mapping.md`：MOTION_TEMPLATES → bpy 5-KF 布局；JointName → bpy 骨骼；pathCurve → Bezier 控制柄）
- **阶段完成判据**：
  - [ ] 骨骼命名一致（`L_arm_upper` 式），无绑定姿态缩放
  - [ ] 动作 `AN_` 前缀、时长 = 镜头帧数（±0 帧）
  - [ ] 循环接缝：首/末帧同名骨骼 `matrix_world` 位置差 ≤1mm 且旋转差 ≤0.5°
  - [ ] 极限姿态（举臂/深蹲/张嘴）：相邻顶点边长变化 ≤1.5×，无负缩放
  - [ ] `frame_set` + 读 `matrix_world` 的帧采样探针确认动作真的发生（fcurves 存在 ≠ 动画生效）

### 阶段 ⑤：渲染

- **何时做**：前三阶段判据全过。previz 走 Eevee 低采样；delivery 走下方「交付级 3D 档」参数。
- **配方档**：
  - `recipes/rendering/RECIPE.md` — 引擎选择、`preview`/`delivery` 数值 preset、通道、色彩管理（AgX）、转台模板
  - `recipes/compositing/RECIPE.md` — 美板堆叠/调色/交付输出（需合成时）
  - `recipes/lookdev/RECIPE.md` — 品质档外观验证循环（Cycles 档）
  - `recipes/qa-review/RECIPE.md` — 交付前可执行 QA 门（场景预算/相机净空/证据页/独立评审）
  - `recipes/export-pipeline/RECIPE.md` — 资产需出库时（FBX/GLTF/USD）
- **阶段完成判据**：
  - [ ] 渲染帧写 `$BLENDER_WORK/out/`，`view_transform=AgX`，`look` 取合法值（`AgX - Medium High Contrast`，非法值会 TypeError）
  - [ ] 先 preview 档渲 1 帧确认构图/曝光，再上 delivery 档
  - [ ] 回执 `render_quality.degraded=false`，且 `effective.samples_actual` 达档位下限（Eevee ≥128）
  - [ ] delivery 档：7 视角证据页已出，独立评审逐特征 PASS/FAIL/UNKNOWN，裁决 SHIP / SHIP WITH NOTES / NO-SHIP
  - [ ] delivery 档：交付人已用 `read_image` 真看过最终图，NO-SHIP 清单逐条为零

## 执行环境铁律（2026-09-06 实弹实锤）

> 依据 2026-09-06 blender-bridge 实弹验证（渲染崩溃存活配方 / 全链 E2E / stdout 分道），细节与重试纪律见 `environment-notes.md`。

1. **渲染画质分档（2026-10-22 起）**：**单帧 still** 尊重 `.blend` 里已有的 `scene.eevee.taa_render_samples` / `use_raytracing`（要品质档传 `blender_render` 的 `quality="final"`：强制 RT on + 阴影开 + samples ≥32；显式 `samples` 优先，皆不传则用场景值）；**delivery 档按上表再显式 `samples:128`，并校验回执 `degraded=false` / `samples_actual ≥128`**。**turntable / 多帧动画**仍强制 `scene.eevee.taa_render_samples = 1` + `scene.eevee.use_raytracing = False` 存活预设（渲染负载越高崩率越高）。排障需恢复旧行为时设 `BLENDER_EEVEE_SURVIVAL_PRESET=1`（全部强压 1spp + RT off）。**单帧渲染是安全单位**——单次 execute 内禁止跑多帧渲染循环（动画/turntable 一律逐帧多次调用，由上层逐帧编排；桥内多帧循环第 8-12 帧稳定 native 崩，samples=1 也逃不掉）。
2. **诊断纪律**：错误诊断信息落 artifact 文件（写 `$BLENDER_WORK/out/` 下 .json/.txt），不依赖 print——stdout_tail 可能被引擎日志挤占（桥已预算制修复，artifact 仍更可靠）。
3. **5.2 API 雷区**：fcurves 走 `action.layers[*].strips[*].channelbags[*].fcurves`（5.2 slotted action 无 `action.fcurves`）；视频输出勿用 `file_format="FFMPEG"`（enum 已死，走 `image_settings.media_type="VIDEO"` 或 PNG 序列 + host ffmpeg）；Eevee enum 只有 `BLENDER_EEVEE`（EEVEE_NEXT 在 5.2 已死）。
4. **产物落盘**：所有输出写 `$BLENDER_WORK/out/`，文件名带语义前缀（`分镜号_内容`，如 `sh02_turntable_f0001.png`），禁止写 /tmp 或依赖 cwd。
5. **共享实例互踩**（T3 实锤）：桥的 Blender 实例是共享的，并发任务的脚本会重置你的场景。长链任务每帧渲染前 `bpy.ops.wm.open_mainfile(filepath=...)` 重开自己的 mainfile，或开工前 `save_as` 快照、每阶段先重开再续做；发现「场景里多了/少了东西」= 被互踩，重开 mainfile 自愈。
6. **桥主机 ≠ 沙箱**（T1 实锤）：产物落在桥主机 `out/`，agent 沙箱（VPS）看不到这些文件——**沙箱不自持文件，禁止在沙箱 ls/find 等产物文件**。blender_exec/blender_render 成功 result 带 `artifact_base_url`，用 `${artifact_base_url}?path=${encodeURIComponent(artifact.path)}` 逐文件取回字节（artifact.path 是 result.artifacts 里的相对路径）。
7. **动画写入两坑**（T3 实锤，均为 bpy 语义雷）：① pose 逐骨刷新——写 `pose_bone.matrix`/`rotation_euler` 后必须立刻 `bpy.context.view_layer.update()` 再写下一根父骨受影响的子骨，否则父骨陈旧求值污染子骨；② 装配修正矩阵乘序是 `basis @ w⁻¹ @ target`（basis 修正 × 逆世界 × 目标），写反顺序装配 dev_max 永不为 0。关键帧写完用帧采样探针（frame_set + 读 matrix_world）验证动作真的发生，fcurves 存在 ≠ 动画生效（5.2 slotted action 133 条恒值 fcurves 实锤）。

---

## 共享参考（recipes/references/）

| 档 | 用途 |
|----|------|
| `asset-pipeline.md` | 全程资产管线主参考 |
| `naming-conventions.md` | 全程命名规范 |
| `validation-checklist.md` | 阶段门禁验证清单 |
| `polycount-budgets.md` | 面数预算 |
| `mcp-tools.md` | blender-mcp 工具目录（bridge 同构协议参考） |
| `mcp-integration.md` | 执行协议规则（已按白名单②移除外部 IDE 配置段） |
| `reference-image-match.md` 等 | 参考图对齐流程（委托单附概念图时用） |

## L1 种子直迁

director-engine（three.js 白模 previz，已上生产）的机位/运动/路径数据是免费的 blocking 初值。
Blender 侧落地映射表：`seed-mapping.md`。原则：L1 出初值（免费即时）→ Blender 精修（真 CG）。

---

## 配方总线索引（2026-09-07 对称差扩容后）

配方库已从 12 份扩容到 105 个目录（六批次：工艺资产/风格mood/产品运镜/拟合管线/特效+首批基础）。**接委托单后先查 `recipes/INDEX.md` 选配方**：按「工艺→风格→运镜→拟合→特效」对口取用；每份配方档头自带来源/License/5.2 雷区注释块，上游按 3.x/4.x 编写的 API 命中雷区时以档头为准。姐妹域（教育视频全链/动态设计/Astra 广告/Three.js 网页 3D/agent 执行合同）见 INDEX.md 尾节。
