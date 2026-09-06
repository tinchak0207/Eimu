# 3D 导演（Blender Director）SKILL

> 配方库来源（轮子，License: MIT，原作者 arjun988）：
> https://github.com/arjun988/blender-skills — 94 个专业 Blender skill 的生产管线，
> 本目录取其中 11 个 + 共享 references（共 12 份配方）逐份复制，白名单改动见各档头部注释。

## 执行环境契约（先读）

1. **执行通道**：所有 bpy 脚本通过 bridge HTTP 执行 —— `POST /v1/execute`（blender-mcp 同构协议，Blender headless）。禁止在回复里口述 UI 操作步骤。
2. **产物路径**：一切产物（渲染帧、截图、导出文件、.blend 存档）必须写 `$BLENDER_WORK/out/`，禁止写其他位置。
3. **Blender 版本**：Blender 5.2 LTS。上游配方按 3.x/4.x 写的 API 差异已在配方头部以注释校正（只改 API 名，逻辑不动）。
4. **渲染器**：Eevee 是默认（快稿/previz/阶段验证）；Cycles 是品质档（lookdev/最终输出），只在该阶段配方点名时使用。

## 五阶段管线

```
①blockout → ②相机 blocking → ③灯光 → ④骨架动画 keyframe → ⑤渲染
```

每阶段：何时做 → 用哪个配方档 → 阶段完成判据。上一阶段判据未达成，禁止进入下一阶段。

---

### 阶段 ①：Blockout（灰盒布局）

- **何时做**：接到委托单/分镜表后的第一件事。只关心比例、位置、导航路径，不碰材质细节。
- **配方档**：
  - `recipes/scene-assembly/SKILL.md` — 集合结构（COL_Layout/COL_Blockout/…）、灰盒规则、性能卫生
  - `recipes/set-dressing/SKILL.md` — 布局锁定后的叙事道具簇与密度规则
- **阶段完成判据**：
  - [ ] 集合层级按命名规范建立（见 `recipes/references/naming-conventions.md`）
  - [ ] 灰盒比例正确、相机可达路径畅通
  - [ ] 场景查询确认：物体数/集合归属/包围盒合理（对照 `recipes/references/validation-checklist.md`）

### 阶段 ②：相机 blocking（分镜机位）

- **何时做**：blockout 判据达成后。把每个镜头的机位/焦距/构图定死，动画前锁机位。
- **配方档**：
  - `recipes/camera-cinematography/SKILL.md` — 焦距指南、构图清单、运镜表、DoF
  - L1 种子数据直迁：机位/运镜初值优先从 director-engine 种子映射（见 `seed-mapping.md`），再按配方精调
- **阶段完成判据**：
  - [ ] 每镜头 `CAM_[Shot]_[Angle]` 命名、入 `COL_Cameras`
  - [ ] 起幅/中点/落幅三帧构图检查通过
  - [ ] 运镜有动机且速度曲线合理（缓入缓出）

### 阶段 ③：灯光

- **何时做**：机位锁定后。Eevee 快稿先打三灯定氛围；品质档再进 HDRI/体积。
- **配方档**：
  - `recipes/lighting/SKILL.md` — 三点布光、色温表、HDRI、恐怖光、体积光
- **阶段完成判据**：
  - [ ] 每盏灯有动机，命名 `LGT_[角色]_[描述]`，入 `COL_Lights`
  - [ ] Eevee 预览帧（写 `$BLENDER_WORK/out/`）下主体剪影可读、色温一致
  - [ ] 情绪匹配美术方向

### 阶段 ④：骨架动画 keyframe

- **何时做**：需要角色/物体运动时。绑定在前，keyframe 在后；循环动作先验循环接缝。
- **配方档**：
  - `recipes/rigging/SKILL.md` — 骨架命名/层级、IK vs FK、权重、形变测试
  - `recipes/animation/SKILL.md` — 摆块→样条→打磨流程、循环验证、NLA
  - L1 种子直迁：动作关键帧初值从 director-engine 模板映射（`seed-mapping.md`：MOTION_TEMPLATES → bpy 5-KF 布局；JointName → bpy 骨骼；pathCurve → Bezier 控制柄）
- **阶段完成判据**：
  - [ ] 骨骼命名一致（`L_arm_upper` 式），无绑定姿态缩放
  - [ ] 动作 `AN_` 前缀、时长匹配镜头、循环接缝不可见
  - [ ] 极限姿态形变测试通过（举臂/深蹲/张嘴）

### 阶段 ⑤：渲染

- **何时做**：前三阶段判据全过。快稿走 Eevee，最终走 Cycles。
- **配方档**：
  - `recipes/rendering/SKILL.md` — 引擎选择、采样表、通道、色彩管理（AgX）、转台模板
  - `recipes/compositing/SKILL.md` — 美板堆叠/调色/交付输出（需合成时）
  - `recipes/lookdev/SKILL.md` — 品质档外观验证循环（Cycles 档）
  - `recipes/qa-review/SKILL.md` — 交付前门禁（截图实证 + 裁决模板）
  - `recipes/export-pipeline/SKILL.md` — 资产需出库时（FBX/GLTF/USD）
- **阶段完成判据**：
  - [ ] 渲染帧写 `$BLENDER_WORK/out/`，色彩管理已设（AgX）
  - [ ] 生产渲染前有采样测试
  - [ ] QA 裁决 SHIP / SHIP WITH NOTES（附截图）

## 执行环境铁律（2026-09-06 实弹实锤）

> 依据 2026-09-06 blender-bridge 实弹验证（渲染崩溃存活配方 / 全链 E2E / stdout 分道），细节与重试纪律见 `environment-notes.md`。

1. **渲染存活配方**：Eevee previz 必设 `scene.eevee.taa_render_samples = 1` + `scene.eevee.use_raytracing = False`（渲染负载越高崩率越高）。**单帧渲染是安全单位**——单次 execute 内禁止跑多帧渲染循环（动画/turntable 一律逐帧多次调用，由上层逐帧编排；桥内多帧循环第 8-12 帧稳定 native 崩，samples=1 也逃不掉）。
2. **诊断纪律**：错误诊断信息落 artifact 文件（写 `$BLENDER_WORK/out/` 下 .json/.txt），不依赖 print——stdout_tail 可能被引擎日志挤占（桥已预算制修复，artifact 仍更可靠）。
3. **5.2 API 雷区**：fcurves 走 `action.layers[*].strips[*].channelbags[*].fcurves`（5.2 slotted action 无 `action.fcurves`）；视频输出勿用 `file_format="FFMPEG"`（enum 已死，走 `image_settings.media_type="VIDEO"` 或 PNG 序列 + host ffmpeg）；Eevee enum 只有 `BLENDER_EEVEE`（EEVEE_NEXT 在 5.2 已死）。
4. **产物落盘**：所有输出写 `$BLENDER_WORK/out/`，文件名带语义前缀（`分镜号_内容`，如 `sh02_turntable_f0001.png`），禁止写 /tmp 或依赖 cwd。

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

## 配方總線索引（2026-09-07 對稱差擴容後）

配方庫已從 12 份擴容到 105 個目錄（六批次：工藝資產/風格mood/產品運鏡/擬合管線/特效+首批基礎）。**接委託單後先查 `recipes/INDEX.md` 選配方**：按「工藝→風格→運鏡→擬合→特效」對口取用；每份配方檔頭自帶來源/License/5.2 雷區註釋塊，上游按 3.x/4.x 編寫的 API 命中雷區時以檔頭為準。姐妹域（教育視頻全鏈/動態設計/Astra 廣告/Three.js 網頁 3D/agent 執行合同）見 INDEX.md 尾節。
