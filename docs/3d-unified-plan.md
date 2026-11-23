# 3D 统一整合方案（2026-11-23，取代 3d-director-workstation-prd / director-console-integration-spec 的二期设想）

## 0. 现状事实（2026-11-23 实查）

- 零散实现：`model3d_generate`（混元3D 3.1 / TRELLIS.2，GLB）、`world_generate`（Marble splat）、`blender_*`（桌面桥，exec/render/export_gltf）、`director_*` 17 件 + 10-22 预演 harness（`5ee57e5a2`：mixer、金样、timeScale、`director_capture_previz`、`previs-director` 技能）、`game_project`/`ue_editor`、画布 `scene_3d` 卡、赏阅 `Scene3dSurface`、聊天 `AgentDirectorCard`、本机 GLB 导入与桌面 Blender 导出。
- **导演台为什么「废弃」**：没删，是被关了。`opencode.json` 里所有席位的 `director_*` 工具全部 `false`（build 仅开 `director_get_state`；director3d 席位零个 director 工具）；10-22 新增的 `director_capture_previz` 从未在任何席位开过 `true`。10-18「裁工具面」起 agent 就够不到导演台，工具文件和技能都在，所以看起来像废弃。
- 全屏导演台页面（`DirectorStage`）在原 spec 里一直标「二期不搬」，从未落地；`AgentDirectorCard` 的「全屏开启」至今是 disabled。
- 聊天里没有 GLB 成品预览：`model3d_generate` 回执的 `glb_url` 只是文本链接；blender `public_urls` 是本机桥的鉴权地址。
- 渲染器已基本收敛：`Scene3dGltfViewport`、`DirectorMiniViewport`、赏阅 `Scene3dSurface` 都基于 `src/lib/director-engine/engine.ts`。

## 1. 终态（一句话）

用户说「做一个3D模型」，聊天里出现可旋转的 3D 卡；点「赏阅」「放到画布」「进导演台」都打开同一份资产；agent 的镜头预演、单件资产、Blender 产物、世界场景走同一条事件和同一张卡。

## 2. 后端

1. **唯一真源**：网关导演场景文档（`director-types.ts` / `director-store.ts`）。`model` 元素承载 `model3d_generate` GLB、`blender_export_gltf` GLB、本机导入、桌面导出，字段：`glb_url`、`sha256`、`triangles`、`bbox`、`source`、`cost_coins`；`world` 元素承载 splat+碰撞网格。`director_*` 继续编辑同一份文档。
2. **一个事件** `scene3d.updated { scene_id, element_id, kind: "model"|"world"|"previz", glb_url, poster_url?, meta }`：任何 3D 回执或 `director_*` 变更后由网关发出；聊天、画布、赏阅只监听它。沿用 `director-emit.ts` 的 `emitToSession` 通路，不新造通道。
3. **转存**：GLB／渲染图回执时一律转存 image-data（`model3d_generate` 已做；blender 产物补做），预览不依赖笔记本。
4. **海报图**：用同一个 `engine.ts` 的 `captureShot` 出一帧（复用 capture_previz 路径）。

## 3. 前端

1. 渲染器只留 `director-engine/engine.ts`；`Scene3dGltfViewport`、`DirectorMiniViewport`、`Scene3dSurface` 全部是它的薄壳，不再各自加载逻辑。
2. **聊天新增 `Agent3DCard`**（与图片卡、视频卡并列）：先海报，点击才挂实时视口（可旋转）；按钮：赏阅（scene3d 视图）、放到画布（走 `scene-3d-reference`）、进导演台。
3. **全屏导演台 `/director/[sceneId]`**：补上 spec 一直没做的二期页面，读写同一份场景文档；`AgentDirectorCard` 的「全屏开启」接到这一页；agent 的 `director_*` 改动经 `scene3d.updated` 实时刷新。
4. 小程序只给海报和链接，不上 three.js。

## 4. Agent 路由（RECIPE §3D 只保留这一张表）

| 意图 | 路径 |
|---|---|
| 单件造型资产（「做一个3D模型」） | `model3d_generate`（默认；orchestrator、creator、director3d 直接调；**不走 beast 调研流程**） |
| 精确尺寸、转台、白模 | `blender_*`；桥不在线就如实说 |
| 镜头预演、动作走位 | `director_*` + `director_capture_previz`（`previs-director`） |
| 整片环境 | `world_generate` |
| 游戏 | `game_project` / `ue_editor`，不进 Web 预览 |

席位：`director3d` 是唯一 3D 专家席，`director_*` 全部挂上（含 `director_capture_previz`）；orchestrator／creator 只直接调 `model3d_generate`，其余派给 director3d。

## 5. 分期与验收（每期都过交付闸：原话真会话＋真浏览器截图）

- **P0（先做）**：`model3d_generate` 回执发 `scene3d.updated`；`Agent3DCard`；赏阅接通；单件 3D 不走 beast 调研。验收：原话「做一个3D模型」→ 聊天出现可旋转 3D 卡 → 赏阅能打开。
- **P1**：director3d 席位挂回 `director_*` 与 `director_capture_previz`（一刀改 opencode.json，同 `e1bd0e9ed` 做法）；blender 导出、本机导入、桌面导出走同一事件同一张卡；blender 产物转存。
- **P2**：全屏导演台页面；卡上「进导演台」；capture_previz 与该页共用渲染。验收：复跑 10-22 e2e-wuxia 原话，与 `docs/evidence/previs-harness-20261022/e2e-wuxia/01-03` 逐张对照。
- **P3**：world splat 预览，用户要了再做。
