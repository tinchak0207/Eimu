---
name: qa-review
description: Blender 资产生产 QA 门禁，使用视口截图、验证清单、命名审计与 ship/no-ship 裁决。
license: MIT
metadata:
  author: https://github.com/arjun988
  version: "1.0.0"
  domain: blender
  role: specialist
  triggers: QA, quality assurance, review, validation, checklist, screenshot review, ship check, art review
  related-skills: asset-optimization, export-pipeline, blender-director, lookdev
---
<!--
来源（轮子）: https://github.com/arjun988/blender-skills — .claude/skills/qa-review/SKILL.md
License: MIT · 原作者: arjun988 (https://github.com/arjun988)
白名单改动: ①产物路径→$BLENDER_WORK/out/（截图存档写 $BLENDER_WORK/out/） ②移除「via MCP」外部 IDE 整合表述 ③Blender 5.2 API 校正（无） ④文案译为简体（结构/表格/参数逐项保留）
-->


# QA 审查（QA Review）

截图实证的审查。清单门禁。明确的 ship / no-ship。

## 何时使用

- 导出或交接之前
- 建模/lookdev 大里程碑之后
- 参考匹配的最终对比
- 周期性场景健康检查

## 工作流

```
收集概算指标 → 关键角度截图 → 跑清单
  → 列缺陷（分级）→ 修复或驳回 → 复验 → 裁决
```

截图/渲染产物写入 `$BLENDER_WORK/out/`。

## 制作纪律（2026-10-22 返工教训，与判准同级）

- **先报瓶颈再打磨**：开工先写一句「这张图不达标的首要瓶颈是什么」（资产细化／光照／构图／材质）。低于瓶颈的细节（窗格节点图、天空穹顶、云噪声）一律不做；瓶颈是资产且改不动 → 立即停手报资产上限。
- **迭代预算**：单场景 ≤3 轮；每轮开头先量测上一轮的数字，不许凭观感开渲。同一特征连续 2 轮不改善 = 换方法类，第 3 轮仍不过 = 停手 `request-input`。
- **必须带视觉目标**：委托里没有参考图时，先由评审给一张参考图或 5 条可判定的视觉目标；两样都没有 → 不许做审美微调，只按数值判准收敛并声明「无视觉基准」。
- **禁止字符串补丁改生成脚本**：不许用 `str.replace` 连环修补构建脚本（状态必然漂移、旧分支留尸）；回到函数体改原值。
- **每轮只改一个变量**：一次渲染里同时动光照、材质、构图，等于没有实验。
- **禁止把「好看／60 分／电影感」当验收目标派给 agent（2026-10-22 两次实锤）**：这是不可判定目标，agent 只能自己猜，两轮都在猜（先猜「件数多＝复杂」，再猜「删干净＝达标」）。审美判断只能来自参考图或人。
  - 有参考图 → 目标是「与参考图的量化偏差」（主体 bbox IoU、明度直方图距离、色相分布），不是「像不像」。
  - 无参考图 → 不许自行迭代：一次交 3 个明显不同的定稿候选（构图/光照各不同），由人挑一个，再按挑中的那版收敛。禁止在候选之间反复微调。
  - 连参考图都没有、用户只是要「一张复杂的战斗场面」→ 先回问一句或走 `image_generate`；Blender 只在需要真几何（GLB、多角度一致、精确布局、转台）时才用。

## 证据页（delivery 档必出）

7 个固定视角，每格 384px，拼成 1 张 contact sheet（来源：ifBars/blender-agent-studio, MIT `render_evidence.py`）：

`perspective`（3/4，lens 55）/ `front` / `back` / `left` / `right` / `top` / `bottom`

- 统一 `view_transform=AgX`、`exposure=0`（诊断可 -1.0）、`look="AgX - Medium High Contrast"`。
- 每个视角都要能独立认出是同一主体、同一套材质；只有一张 hero 图不算证据。
- 脸/手/接触点另出 1 张 close-up。
- 交付图的分辨率以 PNG IHDR 实际值为准，不看文件名或回执。

## 可执行 QA 门（delivery 档：每条都能用一句话或一段脚本复算）

> 场景预算与 7 视角证据来源 ifBars/blender-agent-studio（MIT）；z-fight/漂浮/UV 容差来源 EL4CTEO/blender-skills（MIT）；相机公式形态参考 jangtrinh/design-os-3d-blender（PolyForm Shield，**仅学形态，未抄文案/代码**）。`0.5m`、`90%`、剪影填充率 `0.25–0.75`、`<2px` 为本轮按失败形态合成的推断值，上线前用 2–3 个真实场景校准。**回执缺 `effective.samples_actual` 时判 UNKNOWN，不得当 PASS。**

### 0. 双侧判准原则（2026-10-22 实锤，先于一切）

> 事故：只给上限（≤120 mesh／≤60 碎片／≤8 资产族）后，agent 用**删除**满足上限——1052 物体、满屏摩尔纹的场景被改成一男一女在空天台上对打，技术指标全过、委托内容全丢。**单侧上限必然奖励删减。**

- 每条上限必须配一条同维度下限；只有上限的门 = 无效门。
- 判准达标不能代替「委托内容还在」：交付前对照**用户原始委托**逐项点名（谁／在哪／在做什么／环境是什么／紧张感来自什么），任一项无法从成片指认 = FAIL。
- 达不到下限时禁止用光照、材质或后期掩盖；停手报「资产上限」，并给出两条路：接受降级，或追加建模预算。

### 0.1 内容下限（delivery 档，与第 1 节上限同级）

| 项 | 下限 | 复算 |
|---|---|---|
| 资产族 | ≥5 族，且非同族复制 | ledger 去重计数 |
| 深度层 | ≥3 层可见（前景／主体／中景或远景），远景层须有可辨环境剪影 | 分层 mask 各占 ≥3% 画面 |
| 尺度参照 | ≥2 个与主体同框的尺度物（窗格／栏杆／车辆／远景人物） | 逐项指出像素位置 |
| 主体细化 | 可辨的躯干与四肢分区 + ≥1 项服装或机械分区；纯胶囊体=资产不合格 | 单看主体剪影列出分区数 |
| 接触与受力 | 接触点有接触阴影；动作方向与留白方向一致 | 接触带亮度低于主体均值 ≥15% |
| 叙事三问 | 3 秒内能答出「谁打谁／在哪／为什么紧张」 | 评审盲答，缺一题 FAIL |

### 1. 场景预算（建模前填，QA 时复算）

| 项 | 上限 | 量测 |
|---|---:|---|
| 资产族（family） | 8 | 按 `SM_*` / `VFX_*` / `FX_*` 前缀去重计数 |
| mesh 物体 | 120 | `len([o for o in bpy.data.objects if o.type == "MESH"])` |
| evaluated tris | 180,000 | depsgraph 求值后逐 mesh 累加 `len(to_mesh().loop_triangles)` |
| 材质 | 24 | `len(bpy.data.materials)`（剔除 fallback 须在报告注明） |
| 受控碎片 | ≤60 实例 / ≤20,000 tris / 1 材质 | 按声明族过滤后逐项计数 |
| 单片碎片投影 | ≥2px（交付分辨率） | 相机投影 bbox 较短边像素数 |
| 未声明资产族 | 0 | ledger 前缀集合与场景前缀集合的差集 |

**每个资产族先做 1 个 representative，过 QA + 视觉评审后才允许复制**；复制时把 count 写进 ledger。一个未批准族被复制几百次 = NO-SHIP。

ledger（开工前填，随交付附上）：

| family | instances | tri budget | material | support | representative approved? | evidence |
|---|---:|---:|---|---|---|---|
| SM_Hero | 1 | 60000 | M_Suit | ground | [ ] | front/side/3q |
| VFX_Debris | ≤60 | 20000 | M_Debris | — | [ ] | isolated + context |

### 2. 相机净空与遮挡（渲染前断言，不过不渲）

| 判准 | 阈值 | 复算 |
|---|---|---|
| 相机到最近几何 | ≥0.5m | 以相机为球心做 `scene.ray_cast` 8 方向 + 最近点查询，取最小值 |
| 到头部/胸部/接触点的视线 | ≥90% 首个命中是主体 | 3 个目标点 × 3 个相机内偏移点 = 9 条 ray，统计首个 hit 属于主体 mesh 的比例 |
| 相机 0.1m 包围球与 mesh 相交 | 0 | BVH overlap |
| 主体占较紧轴 | 80–88% | 主体 bbox 8 角 `world_to_camera_view`，取 u/v 跨度较大者 |
| bbox 出画/穿后 | 0 角 | 8 角全部 `0.03 ≤ u,v ≤ 0.97` 且 `z > 0` |
| 机位距离 | `d = R / sin(fill·θ)`，`fill=0.82` | `R`=主体包围球半径，`θ=min(half_h, half_v)`；实拍距离与解算值偏差 ≤5% |
| 前景层 | 只 1 层，占画面 <15%，不遮脸/手/接触点 | 前景 mask 面积 / 总像素；与主体关键部位 mask 相交即 FAIL |

### 3. 剪影可读（二元判定，禁止只写「可读」）

1. 出主体 mask（object index pass 或 holdout 渲纯色背景）；
2. 转 1-bit，长边缩到 128px；
3. **连通域数 = 声明主体件数**（断肢/漂浮多出的连通域即 FAIL；分件按声明值）；
4. **填充率 = mask 面积 / bbox 面积，落 0.25–0.75**（<0.25 = 太散/断肢，>0.75 = 糊成一团）；
5. **命名测试**：评审只看这张剪影 ≤3 秒，写出的姿态动词必须与委托声明一致；写不出或写错 = FAIL。

### 4. 构图（与 2 的 bbox 断言同源）

| 判准 | 阈值 |
|---|---|
| 动作方向留白 | ≥5% 画面宽 |
| headroom | 3–8% 画面高 |
| 水平线倾斜 | 0° ±1°（有动机的荷兰角须在镜头表声明角度） |
| tangent merger（轮廓与背景线相切） | 0 处（剪影轮廓与背景边缘梯度相交判定） |
| 主体不居中 | bbox 中心偏离画面中心 ≥3% 画面宽，除非镜头表声明居中构图 |

### 5. 图像级 QA（渲染后跑，命中即 NO-SHIP）

| 项 | 阈值 | 复算 |
|---|---|---|
| 实际分辨率 | 与交付规格逐像素相等 | 读 PNG IHDR（`PIL.Image.open(p).size`），不看文件名/回执 |
| 位深/色彩 | 按交付声明（8-bit 或 16-bit）；sRGB 显示 | `img.mode` / PNG bit depth |
| 纯白区域 | 像素值 ≥250 的占比 ≤0.5% | numpy 直方图 |
| 死黑区域 | ≤5 的占比 ≤2%，且不得吞掉主体边缘 | 同上 + 主体 mask 边缘带 |
| 默认灰/品红 | 0 块 | 品红：R>200、B>200、G<80；默认灰：与 Blender 默认材质 0.8 灰近似且无材质名可溯 |
| 摩尔纹 | 主体区域无规则高频峰 | 100% 放大目检 + 细件投影 ≥2px 断言 |
| z-fight / 漂浮 | 共面 <1mm、缝隙 >2mm 均为 0 | EL4CTEO `qa_check.py` 同口径判定 |

任何一项不过 = NO-SHIP，不允许用「整体看起来还行」补。

### 6. 独立评审（作者 ≠ 评审；禁止全局小数分）

1. 评审前先写 critical feature 清单，每项必须可判定（例：「主角剪影可辨」「接触点有接触阴影」「相机 0.5m 净空」）。
2. 每项给具名 `PASS` / `FAIL` / `UNKNOWN`，附证明视角与反例条件。
3. 判断不了就 `UNKNOWN` 并补一张能证伪的视角，不许猜。
4. 同一 feature 失败 2 次 → 换方法类（例：从「加碎片」换成「砍到 1 个受控碎片族」），不许微调重试；累计 3 次 → 停手 `request-input`。**最多 3 轮**。
5. 修复只有在「目标改善 + 无任何历史硬门回归」时才保留，否则回滚到上一版候选。

critic ledger：

| feature | expected | proof view | verdict | falsifier |
|---|---|---|---|---|
| 主角剪影 | 动作可辨 | 3/4 | PASS | 遮住背景仍能读出姿态 |
| 接触点 | 手/脚与表面接触 | side | FAIL | 可见缝隙 >2mm |
| 镜头净空 | 无碎片遮挡脸部 | camera | UNKNOWN | 需一张无遮挡对照图 |

## 清单（按需加载）

- `../references/validation-checklist.md`
- `../references/visual-match-checklist.md`（参考图任务）
- `../references/naming-conventions.md`
- `../references/polycount-budgets.md`

## 缺陷分级

| 级别 | 含义 |
|------|------|
| Blocker | §5 图像级 QA 任一命中；场景预算任一项越界且未在 ledger 声明豁免；相机净空 <0.5m；有未声明资产族 |
| Major | 主体占屏偏离 80–88% 超过 5 个百分点；遮挡率 <90%；剪影命名测试失败；漂浮/接触失败 |
| Minor | 命名、轻微着色、缝隙（≤2mm）、单件投影 <2px 的碎片未剔除 |
| Note | 可选打磨 |

分级不看形容词：Blocker/Major 的每一条都对应上面 §1–§5 的一个数字阈值。

## 裁决模板

```markdown
## QA 裁决: [资产]

**结果:** SHIP / SHIP WITH NOTES / NO-SHIP
**档位:** previz / delivery
**场景预算:** objects [n]/120 · evaluated tris [n]/180000 · materials [n]/24 · families [n]/8 · debris [n]/60
**相机:** 净空 [m] (≥0.5) · 主体占屏 [%] (80–88) · 遮挡率 [%] (≥90) · in-frame [0/8 角出画]
**画质回执:** degraded=[true/false] · samples_actual=[n] (delivery ≥128) · 实际分辨率 [W×H]
**数值 QA:** z-fight [n] · 漂浮 [n] · 未应用缩放 [n] · 缺 UV [n] · ground_z [偏移]
**图像直方图:** 纯白 [%] (≤0.5) · 死黑 [%] (≤2)
**证据:** 7 视角 contact sheet + close-up（路径）
**独立评审:** [评审人/模型≠作者] — 逐特征 PASS/FAIL/UNKNOWN 见 critic ledger
**轮次:** [n]/3 · 同特征失败次数 [n]
**Blocker:** ...
**Major:** ...
**Minor:** ...
**回滚:** 无 / 回滚到 [候选版本]（原因）
**后续动作:** ...
```

## 约束

### 必须做
- 给出明确裁决
- 视觉结论附截图实证
- 修复后复验才翻成 SHIP

### 禁止做
- 视觉任务无截图橡皮图章
- 不经批准无视预算超支

## 参考指南

| 主题 | 参考 | 何时加载 |
|------|------|----------|
| QA 裁决模板 | `references/qa-verdict-template.md` | 按需 |
| 截图角度 | `references/screenshot-angles.md` | 按需 |
