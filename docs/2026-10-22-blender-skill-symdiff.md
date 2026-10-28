# Blender / 3D Agent Skill 库对称差报告

- 日期：2026-10-22
- 范围：GitHub 开源 Blender / 3D 建模 agent skill 库（含 MCP 工具库、评测/QA 库）
- 方法：`gh` 检索 → 取 `git/trees` → 用 `raw.githubusercontent.com` 逐文件读原文 → 记录行号与 commit
- 我方基线：`/home/lenovo/Desktop/image-app/deploy-staging/opencode-runtime/skills/blender-director/`
- 基线读取时点：2026-10-22 15:38；**15:55 起工作树出现并行改动**（`SKILL.md:106` 已从「Eevee 一律 samples=1」改为「单帧 still 尊重场景值 / `quality="final"`」，`lib/blender-tools-impl.ts` 已新增 `quality` 参数）。本报告缺口表以**基线版 + HEAD** 为准，并在相关行标注并行修复后的剩余差距；这些改动不是本报告作者所做。
- 约束遵守：本次只新增本文件，未修改 `deploy-staging/` 任何内容；未写测试；未编造 star / 路径 / 引文

---

## 0. 结论（先给结果）

1. **市面上没有一个单独可称「满分级」的 Blender agent skill 库。** 质量最高的能力分散在三家，必须并集：
   - **EL4CTEO/blender-skills**（MIT，378 星）：本次候选中唯一把「数值 QA 脚本 + 渲染质量 preset + 实测 PBR 值」做成可执行代码的库。
   - **ifBars/blender-agent-studio**（MIT，92 星）：本次候选中唯一把「阶段门 + 多视角证据 + 逐实例评审 + 评分封顶 + 非回归门」做成完整评测协议的库。
   - **jangtrinh/design-os-3d-blender**（PolyForm Shield，102 星）：本次候选中唯一把「执行契约 + 数字先于像素 + 相机解算 + 独立评审 + 2 次失败换方法」写成硬规则的库；**但许可证禁止竞争性 SaaS，不能抄**。
2. **star 数不代表质量，头部 star 集中在协议层。** 31,944 星的 `ahujasid/mcp-for-blender` 是协议/工具层，没有任何质量门；376 星的 `arjun988/blender-skills`（我方 11 份核心配方来源）参考文件只有 6–40 行；182 星的 `kevinbadi/blender-skills`（我方 105 个配方目录中 16 份 `RECIPE.md` 明确标注来源）甚至给出「撕掉 normal/roughness、全镜面材质」这类会直接降低真实感的手法。
3. **我方产出的根因不是配方数量不够，而是判准不可执行。** 105 个配方目录、11 份核心配方，阶段完成判据全是「剪影可读」「构图合理」这类主观句；没有一条图像级/场景级数值门。基线版 `SKILL.md:106` 把 Eevee 存活配方 `taa_render_samples=1 + use_raytracing=False` 写成无差别的执行铁律，摩尔纹、无反射、碎片云、镜头穿模都是必然结果。**注：2026-10-22 15:55 工作树已有并行修复（单帧 still 可用 `quality="final"`，samples ≥32）；但 32 spp 仍低于外部 final 档（Eevee 128 TAA 或 Cycles 512 spp），且尚未规定「最终档走 CLI 子进程」，所以差距缩小但未闭合。**
4. **蜘蛛侠战斗静帧照最严标准做，会「少而准」**：≤8 个声明资产族、≤120 个 mesh 对象、≤24 材质、≤180k evaluated tris；1 个主角剪影 + 1 个对手 + 1 个接触面 + 3 个环境锚点 + 1 个受控碎片族；35mm/24mm 镜头先定焦再解距离，主体占画面 80–88%，相机 0.5m 内无几何、到头部/胸部/接触点的视线 ≥90% 无遮挡；Cycles 512 spp / adaptive 0.01 / OIDN(albedo+normal)，或 Eevee 128 TAA + raytracing；7 视角证据页 + 独立评审逐特征 PASS/FAIL/UNKNOWN，同一特征失败 2 次换方法，最多 3 轮。**不是把 1052 个物体和 340 片碎玻璃渲得更清楚。**

---

## 1. 候选清单表

抓取时点：2026-10-22。`最后 push` 取 GitHub API `.pushed_at`；`commit` 为 `main` 最新提交前 12 位。

| repo | star | license | 最后 push | commit | 一句话定位 | 是否入选解剖 |
|---|---:|---|---|---|---|---|
| [ahujasid/mcp-for-blender](https://github.com/ahujasid/mcp-for-blender) | 31,944 | MIT | 2026-10-20 | `5a3618fccb2d` | 最大的 Blender MCP 协议实现，含 `look` 多视角视觉回看和 8 篇工作流 guide；无质量门 | 是（作为协议层对照） |
| [DLR-RM/BlenderProc](https://github.com/DLR-RM/BlenderProc) | 3,760 | GPL-3.0 | 2026-10-22 | 未取（非 skill 库） | 程序化真实感渲染管线，含 adaptive sampling / denoiser / 光路参数；非 agent skill | 仅引渲染参数 |
| [EL4CTEO/blender-skills](https://github.com/EL4CTEO/blender-skills) | 378 | MIT | 2026-10-19 | `71d031dab8bc` | 22 个 Blender 5.2 skill + 可执行 `qa_check.py` / `scene_audit.py` / `render_batch.py` / 实测 PBR 表 | **是（主对标）** |
| [arjun988/blender-skills](https://github.com/arjun988/blender-skills) | 376 | MIT | 2026-07-10 | `8f778d2405a2` | 95 个 skill、269 个文件的「宽度型」库；我方 11 份核心配方来源，references 极薄 | **是（我方上游）** |
| [kevinbadi/blender-skills](https://github.com/kevinbadi/blender-skills) | 182 | **无 LICENSE** | 2026-04-04 | `b2f0f816d320` | 产品运镜/PolyHaven/图转 3D 的 15 个 skill；我方 16 份配方来源；手法偏「快出片」 | **是（我方另一上游，风险）** |
| [jangtrinh/design-os-3d-blender](https://github.com/jangtrinh/design-os-3d-blender) | 102 | **PolyForm Shield 1.0.0** | 2026-10-20 | `7d6bc7e268ee` | AGENT_OK 执行契约、数字先于像素、相机解算、独立评审、生产门；含大量真实 build 证据 | **是（最严纪律）** |
| [ifBars/blender-agent-studio](https://github.com/ifBars/blender-agent-studio) | 92 | MIT | 2026-10-22 | `6ff97fad06d0` | 12 个 skill + benchmark/evaluator：阶段门、7 视角证据棚、逐实例评审、评分封顶、非回归门 | **是（最严评测）** |
| [seehiong/blender-mcp-bridge](https://github.com/seehiong/blender-mcp-bridge) | 79 | MIT | 2026-09-13 | `e1cdb2c93804` | 98 个工具、3D 打印校验、可视 record/replay；广度大，艺术质量门少 | 简评 |
| [ProfRino/Blender-MCP-Assembly-Skill](https://github.com/ProfRino/Blender-MCP-Assembly-Skill) | 78 | **无 LICENSE** | 2026-05-25 | `afad3b1874c8` | 单文件 222 行的装配纪律：连接图、`size=2`、5mm 重叠、边界校验 | **是（几何装配）** |
| [sandraschi/blender-mcp](https://github.com/sandraschi/blender-mcp) | 62 | MIT | 2026-10-13 | 未深读 | 41 个 FastMCP 工具、150+ 操作；工程整合型 | 不入选 |
| [VxASI/blender-mcp-vxai](https://github.com/VxASI/blender-mcp-vxai) | 300 | MIT | 2025-03-21 | 未深读 | 早期 MCP 变体，2025 停更；README 仅功能清单 | 不入选（停更） |

**检索覆盖关键词**：`blender-mcp`、`blender agent skills`、`claude skills blender`、`blender python skill`、`3d asset generation agent`、`blender addon mcp`、`text-to-3d agent`、`blender scene generation`、`blender python automation`、`render quality gate blender`、`aesthetic scoring 3d render`、`BlenderGym`。

**一个检索事实**：`gh search repos "claude skills blender"`、`"render quality gate blender"`、`"aesthetic scoring 3d render"` 均返回空。说明「给 agent 的 Blender 质量判准」还不是一个成熟生态，质量集中在少数几个手工维护的 skill 库里，而不是搜索热词覆盖的区域。

---

## 2. 入选仓库实作解剖

### 2.1 EL4CTEO/blender-skills（MIT，主对标）

#### 文件树（压缩）

```
blender-skills/
├── README.md
├── CLAUDE.md / AGENTS.md
├── install/install.sh|ps1
├── shared/_bpyx.py                 # 所有脚本共用的 bpy 兼容层
└── skills/                         # 22 个 skill，89 个文件
    ├── blender-core/SKILL.md + scripts/run_in_blender.py
    ├── blender-scene-setup/SKILL.md + scripts/scene_audit.py
    ├── blender-rendering/SKILL.md + scripts/render_batch.py
    ├── blender-lighting-lookdev/SKILL.md + scripts/turntable.py
    ├── blender-pbr-materials/SKILL.md + references/pbr-values.md + scripts/build_pbr_material.py
    ├── blender-asset-qa/SKILL.md + scripts/qa_check.py + scripts/review_shots.py
    ├── blender-workflow-recipes/SKILL.md
    └── ...（animation / rigging / sculpting / retopology-uv / baking / export / weather / time-of-day 等）
```

组织形态：**每个 skill 一个目录 + 一份 SKILL.md + 可选 scripts/references**。与 arjun988 的「纯文档」不同，EL4CTEO 的关键能力都落在可执行 `.py`。

#### 关键实作与逐字引文

**(a) 渲染质量 preset：预览/最终/产品三档写死在代码里**

> 来源：`https://raw.githubusercontent.com/EL4CTEO/blender-skills/main/skills/blender-rendering/SKILL.md` L20
>
> "Presets: `preview` (Cycles 64 spp, threshold 0.05, 50% res; EEVEE 16), `final` (512 spp, 0.01; EEVEE 128 + raytracing), `product` (1024 spp, transparent background). GPU is picked automatically (OptiX > CUDA > HIP > Metal > oneAPI), and the denoiser matches (OptiX or OpenImageDenoise)."

对应代码（同 repo `skills/blender-rendering/scripts/render_batch.py` L22-29）：

```python
PRESETS = {
    "preview": {"cycles": dict(samples=64, adaptive_threshold=0.05, use_denoising=True),
                "eevee": dict(taa_render_samples=16, use_raytracing=False), "percent": 50},
    "final":   {"cycles": dict(samples=512, adaptive_threshold=0.01, use_denoising=True),
                "eevee": dict(taa_render_samples=128, use_raytracing=True), "percent": 100},
    "product": {"cycles": dict(samples=1024, adaptive_threshold=0.005, use_denoising=True),
                "eevee": dict(taa_render_samples=256, use_raytracing=True), "percent": 100,
                "transparent": True},
}
```

**(b) 质量杠杆排序：adaptive + denoise 优先于堆采样**

> 同文件 L31-36
>
> "1. **Adaptive sampling** (`adaptive_threshold` 0.01 final / 0.05 preview) + **denoise** (OIDN with albedo+normal passes, `denoising_input_passes="RGB_ALBEDO_NORMAL"`). Raising samples alone is the least efficient fix.
> 2. **Light paths**: interiors need diffuse bounces ≥ 4. Product shots: total 12, glossy 4, transmission 8–12 for glass. Clamp indirect 5–10 kills fireflies at a small energy cost.
> 3. **Light tree** (`use_light_tree`, on) for many lights. **Path guiding** (CPU only) for difficult indirect light.
> 4. Fewer, larger lights beat many small ones. Emissive meshes are noisier than area lights."

**(c) 资产 QA：先数字，再眼睛；数值容差写进 CLI**

> 来源：`.../skills/blender-asset-qa/SKILL.md` L12、L18
>
> "Never assume a generated or edited mesh is correct. Check it with numbers, then look at it."
>
> "2. **Fix every `errors` entry** (table below), then re-run until `"pass": true`. Each warning must be either fixed or explicitly accepted, with the reason reported to the user."

`qa_check.py` 的 profile 与容差（L25-32、L350-351）：

```python
PROFILES = {
    "game":   dict(zf="e", fl="e", inv="e", inc="e", nm="w", bd=None, dg="e", dup="w", ng="w", sc="e", uv="e", wt="e"),
    "render": dict(zf="e", fl="e", inv="w", inc="w", nm=None, bd=None, dg="w", dup="w", ng=None, sc="w", uv="w", wt="w"),
    "print":  dict(zf="e", fl="e", inv="e", inc="e", nm="e", bd="e", dg="e", dup="e", ng=None, sc="w", uv=None, wt=None),
    "roblox": dict(zf="e", fl="e", inv="e", inc="e", nm="w", bd="w", dg="e", dup="w", ng="e", sc="e", uv="e", wt="e"),
}
# ...
p.add_argument("--eps", type=float, default=0.001, help="z-fight plane distance (m)")
p.add_argument("--tol", type=float, default=0.002, help="contact tolerance for detached parts (m)")
```

`qa_check.py` 还实现了：z-fighting 共面三角形对（法线点积 `abs(d) >= 0.999`）、漂浮岛（KD-tree/BVH 接触容差）、包围体一致性、反向法线岛、UV 越界/零面积/重叠、>`5%` UV 重叠告警、`ground_z` 非 0 告警、>300k tris 时跳过 z-fight/floating 检查。**这是本次候选里唯一能直接跑出 pass/fail 的资产级 QA。**

**(d) 实测 PBR 值与 sanity check**

> 来源：`.../skills/blender-pbr-materials/references/pbr-values.md` L42-47
>
> "- Average base color luminance for dielectrics: sRGB 50–200 (mean ~120). Pure black (0) or pure white (255) pixels on dielectrics are almost always wrong.
> - Metal base color below sRGB 180: the metallic mask or albedo is wrong (it's probably dirt that should be dielectric).
> - Roughness map near-uniform (std dev < 0.02): add variation.
> - Normal map average ≈ (128, 128, 255). If the average blue is < 200 or the RGB is far off, the color space is wrong, or it's a height map labeled as normal."

**(e) 构图/镜头：只有规则，没有解算**

`blender-lighting-lookdev/SKILL.md` L24、L36-38：

> "Asset / product review | 3-point: key 45° side, 30–40° up; fill opposite at ⅓ power and lower; rim behind for silhouette. Large soft area lights (size ≈ object), neutral grey backdrop, Khronos PBR Neutral view"
>
> "Focal length: 24–35 mm environments/interiors ... 50 mm natural, **85–135 mm products and portraits** ... 200 mm+ compressed telephoto."
>
> "Composition: rule of thirds / centered symmetric for products, horizon off-center, leading lines, headroom. Show the silhouette (3/4 view at slight elevation 10–25°)."

**评价**：数值 QA 与渲染 preset 是满分候选里最强的；**短板是没有动作/战斗构图、没有场景级复杂度预算、没有独立评审与评分封顶**。它的 QA 是「资产级」，不是「画面级」。

---

### 2.2 ifBars/blender-agent-studio（MIT，最严评测）

#### 文件树（压缩）

```
blender-agent-studio/
├── SKILL.md
├── docs/
│   ├── plugin-quality-evidence.md          # 配对实验：baseline vs skills，技术分/盲评/耗时
│   ├── whole-scene-benchmark.md            # 21 资产族 / 45 实例 / 180k tri / 24 材质
│   ├── scene-character-benchmarks.md
│   └── spatial-benchmarks.md
└── plugins/blender-agent-studio/
    ├── mcp/server.ts                       # MCP server
    └── skills/                             # 12 个 skill
        ├── blender-art-direction-intake/SKILL.md
        ├── blender-modeling-workflow/SKILL.md + references/{modeling-contract,staged-quality-workflow,whole-scene-workflow}.md
        ├── blender-asset-validation/SKILL.md
        │   ├── references/quality-gates.md
        │   └── scripts/{inspect_asset,render_evidence,evidence_settings,compare_reference,diagnose_topology}.py
        ├── blender-rendering-workflow/SKILL.md + scripts/render_scene.py
        ├── blender-iterative-refinement/SKILL.md
        ├── blender-agent-benchmark/
        │   ├── references/{methodology.md,quality-suites.md}
        │   └── scripts/{score.ts,quality-tasks.ts,...}
        └── ...（animation / character / procedural / simulation / MCP integration / signage）
```

#### 关键实作与逐字引文

**(a) 阶段门：完成 = 证据可见或可测，不是「我觉得行」**

> 来源：`https://raw.githubusercontent.com/ifBars/blender-agent-studio/main/plugins/blender-agent-studio/skills/blender-modeling-workflow/references/staged-quality-workflow.md` L3-4
>
> "Use these stages for finished asset work. A stage is complete only when its exit criteria are visible in evidence or measurable in the scene."

七个阶段：contract/references → graybox/proportion → primary/secondary forms → structural refinement → UV/materials → tertiary polish → export/fresh-import。每阶段都有 Exit 条件（L17、L29-30、L39-40、L50-51、L60-61、L70-71、L81-82）。

**(b) 质量门：把「灰模冒充成品」「漂浮装饰」列为强告警**

> 来源：`.../skills/blender-asset-validation/references/quality-gates.md` L39-46
>
> "- a polished or game-ready request with almost entirely flat-shaded curved
>   surfaces, no UV-bearing visible meshes, and no visible refinement evidence;
> - a result dramatically below its permitted geometry budget while still
>   reading as a graybox or generic primitive assembly;
> - missing-magenta, crushed-black, or default-gray visible surfaces;
> - coplanar or nearly coplanar surfaces likely to z-fight in a game engine;
> - final decoration that floats, penetrates walls, or has no structural or
>   compositional role."

视觉评审问题（L48-62）：

> "- Can the object be identified from silhouette alone?
> - Are primary, secondary, and tertiary forms proportionate?
> - Does the result read as the requested final stage, or is blockout geometry
>   still being presented as complete?
> ...
> - Does the asset remain readable in front, side, top, and perspective views?
> - Does it look correct at the intended in-game or icon scale?"

**(c) 复杂场景的正式定义：资产族 × 实例 × 预算 × 逐实例评审**

> 来源：`https://raw.githubusercontent.com/ifBars/blender-agent-studio/main/docs/whole-scene-benchmark.md` L3-13
>
> "`--suite whole_scene` selects `low_poly_courier_depot`: a complete 20 × 16 m environment with **21 asset families and 45 instances**. ... The public brief defines instance names, counts, per-instance triangle budgets, a 180,000-triangle scene ceiling, 24-material ceiling, unit scale, orientation, placement anchors and an unobstructed approach lane. Every instance is its own critical visual criterion. A polished building cannot offset an unfinished bench or background tree."

评审方式（L29-35）：

> "Then it renders perspective, front and rear evidence of **all 45 individual instances**, not just a representative of each family. Each instance gets an isolated art-review sheet and a focused sheet with surrounding scene geometry retained. Isolated images cannot prove scene contact. The per-instance verdict requires both finished art and credible visible integration in the context views; occluded contacts remain unclear."

工作流纪律（`docs/whole-scene-guidance.md` L13-20）：

> "Then build one representative of each family, in dependency order ... Do not replicate an unfinished asset across the scene. ... Place approved instances with deliberate rotation and variation, checking their actual support surfaces."

**这句话直接解释了我方 340 片碎玻璃：不是「碎片太多」，而是「一个未经批准的资产族被复制了 340 次」。**

**(d) 评测评分：权重 + 严重度封顶 + 非回归门**

> 来源：`.../skills/blender-agent-benchmark/references/methodology.md` L64-72
>
> "Suggested reader-facing dimensions for static assets:
> - specification compliance: 25;
> - multiview visual quality and final-stage completeness: 20;
> - geometry and game-readiness: 15;
> - physical/assembly plausibility: 15;
> - materials, textures, surface finish, and presentation: 15;
> - context/export correctness: 10;
> - reproducibility: 5."

> 同文件 L105-108
>
> "Apply severity caps before reporting the result: 49 after a hard-gate failure,
> 84 when any critical criterion lacks a passing majority, 94 when any criterion
> lacks a passing majority, and 99 unless deterministic scoring is perfect,
> every judge passes every criterion, and every broad dimension is exceptional."

非回归门（L115-124）：任一历史硬门从 pass 变 fail、任一配对任务确定性分数下降、baseline 赢多数盲评、critical 特征从多数 pass 变多数不 pass → 整轮不接受，不能用其他任务的提升来平均掉回归。

**(e) 标准化证据棚：可重复的数值灯光/相机**

> 来源：`.../skills/blender-asset-validation/scripts/evidence_settings.py` L24-45
>
> `powers = (400.0, 160.0, 600.0)`（诊断档 `(140.0, 65.0, 110.0)`）；`camera_distance = extent * 2.3`；`ortho_scale = extent * 1.45`；`clip_start = extent * 0.001`；`clip_end = extent * 1000.0`。三盏灯能量按 `power * extent ** 2` 缩放。

`render_evidence.py` L182-199：

> `scene.view_settings.view_transform = "AgX"`；`exposure = -1.0 if diagnostic else 0.0`；`look = "AgX - Medium High Contrast"`；世界背景 `(0.035, 0.045, 0.06)`、strength `0.35`；地面 roughness `0.82`；key/fill/rim 位置按 extent 倍数（`2.2,-2.4,2.8` / `-2.5,-0.6,1.4` / `0.4,2.5,2.0`），灯尺寸 `2.0/2.4/1.7 × extent`。

7 个固定视角（L361-369）：`perspective (1.4,-1.7,1.2)`、`front`、`back`、`left`、`right`、`top`、`bottom`；透视镜头 `lens = 55`，正交 `ortho_scale`；输出 384px（可 128–1024）；合成 contact sheet。

**(f) 独立评审与「保留修复」的条件**

> 来源：`.../skills/blender-iterative-refinement/SKILL.md` L26-35
>
> "Separate critique from editing: freeze the candidate and judge its evidence before choosing a repair. ... Open the preserved images with an image-viewing tool. Before editing, write a `pass`, `fail`, or `unclear` ledger for every critical requirement and cite the view or frame that proves the judgment. Names, source code, hierarchy, and metrics cannot make an absent, occluded, or unreadable subject a visual pass."

保留条件（L81-92）：

> "- the targeted failure improves or passes;
> - every critical visible requirement passes in actual final evidence;
> - no previous hard gate, task limit, or critical requirement regresses;
> - aggregate `scene.bounds.dimensions`, not only the largest mesh, satisfies any global size limit;
> - any deliberate tradeoff was accepted by the user.
> Otherwise restore the preserved candidate and report why the repair was rejected."

**评价**：这是最接近「满分级评测」的库；但它对**画面构图**仍以人评问题为主，没有把「相机净空」「碎片像素尺寸」写成脚本。它的价值在流程与评分，不在单个 bpy 片段。

---

### 2.3 jangtrinh/design-os-3d-blender（PolyForm Shield，最严纪律）

#### 文件树（压缩）

```
design-os-3d-blender/
├── LICENSE                              # PolyForm Shield 1.0.0（禁竞争）
├── AGENTS.md / .project-agent.md
├── .agents/skills/
│   ├── blender-agent-core/SKILL.md
│   │   └── references/{hard-rules,recipes,assembly-sequences}.md
│   ├── blender-image-to-3d/SKILL.md
│   │   └── references/review-rubric.md
│   ├── blender-knowledge-workbench/SKILL.md
│   └── img2threejs/                     # 含 forge/ 脚本、review-gates.md
├── knowledge/
│   ├── 00-foundations/{blender-version-matrix,bpy-scripting-core,agent-workflow-loop}.md
│   └── 60-pipeline/{product-viz-and-shots,native-render-delivery,native-agent-iteration}.md
├── scripts/{agent_runtime.py,production-gate.py,native-review.py,native-pipeline.py,...}
├── builds/                              # 真实 build 证据（reference-keyboard、robot-arm 等）
└── docs/{product-workflow-template.md,reviews/,...}
```

#### 关键实作与逐字引文

**(a) 执行契约：AGENT_OK / AGENT_FAIL 最后一行决定成败**

> 来源：`.agents/skills/blender-agent-core/SKILL.md` L36-44
>
> "1. **Contract first** — purpose first (render-only / print / both, default `both`), then spec.json for a production part; fidelity contract for a reference; missing numbers → `request-input`.
> 2. **Decompose** — scene graph → one file per pass, ≤ ~80 lines, one purpose.
> 3. **Assert every step** — a pass ends with `rt.emit_ok(step, **postconditions)`; the postcondition must FAIL if the step silently no-ops; operator return must be `{'FINISHED'}`.
> ...
> 6. **2 failures on the same step → change the CLASS of approach; 3 failures → `request-input`.**"

**(b) 验证阶梯：数字先于像素**

> 同文件 L61-72
>
> "1. Numbers: `assert_exists`, `tri_count`, `world_bbox`, `has_material`, fcurve keys — plus the postconditions in `AGENT_OK`. ...
> 2. Assert `framing(obj)['in_frame']` (image bounds plus front/near/far depth) → `preview_render(engine="EEVEE"|"CYCLES")` (≈0.1–0.2 s at 128–256px on a small scene, restores state) → `frame_stats()` (stdev < 0.01 = flat frame, needs diagnosis). ...
> 3. Viewport screenshot (MCP) — composition, "does it look like it".
> 4. Low-sample Cycles preview — real material/lighting.
> 5. Comparison sheet ... when a reference image exists.
> 6. Turntable ... guards against the "cardboard cutout" look.
> 7. **Part production:** `production-gate.py ...` exit 0."

**(c) 相机是解出来的，不是试出来的**

> 来源：`knowledge/60-pipeline/product-viz-and-shots.md` L41-44、L198-212
>
> "Focal length is a *storytelling* control, not a framing control. It sets how much perspective distortion the subject gets. Once focal length is chosen, distance is determined by the framing requirement, and the math is closed-form: it is a bounding-sphere-versus-half-FOV problem."
>
> `d = R / sin(fill * theta)`，其中 `theta = min(half_h, half_v)`，`fill` 是角向占比。

参数表（L651-660）：product `lens 85–135`、`fstop 5.6–16`、`fill 0.80–0.88`；game/realtime `lens 50–60`、`fill 0.7`；character full body `50`、`fill 0.75`；action `16–24` 近距离。

**(d) 预览→自评→修复→最终的固定回路**

> 同文件 L580-601
>
> "1. **Assert the shot is renderable.** ...
> 2. **Numeric framing check** ... catches "subject off screen" before any pixels are rendered.
> 3. **Preview render** at 16 samples / 40% ...
> 4. **Self-critique the image** against a fixed checklist:
>    - Is the subject fully inside the frame with intentional margin?
>    - Is there a clear key light, and is the key side readable?
>    - Are there blown highlights (pure white regions) or crushed blacks?
>    - Is the horizon/backdrop seam visible where it should be seamless?
>    - Is the focus on the subject's most important feature?
>    - Are there black facets (flipped normals) or magenta squares (missing textures)?
>    - Does the composition put the subject on a third, not dead centre, unless centring is intentional?
> 5. **Fix one thing at a time** and re-preview. ...
> 6. **Final render** only when the preview is right ..."

**(e) 独立评审：逐特征 PASS/FAIL/UNKNOWN，禁止全局分数**

> 来源：`.agents/skills/blender-image-to-3d/references/review-rubric.md` L21-29
>
> "1. Write the expected critical features before opening the candidate.
> 2. Review the primary image, every supplied close-up, and a corroborating 3/4 or opposing view where it can falsify the construction.
> 3. Give every critical feature a named `PASS`, `FAIL`, or `UNKNOWN` verdict with its proof view and falsifier. Do not substitute a global score or invented decimal fidelity number.
> ...
> If a judgment is uncertain, obtain a discriminating view or keep it `UNKNOWN`."

**(f) 失败升级：2 次同因失败换「方法类」，3 次停手要输入**

> 来源：`.agents/rules/blender-agent-operating-rules.md` L92-95
>
> "Two failures at the same step on the same approach: change the approach's CLASS (e.g. stop retrying `bpy.ops` and switch to the data API), do not repeat the same fix with small tweaks. Three failures total on the same problem: verdict is `request-input` — stop iterating alone."

**评价**：纪律最严、相机数学最完整；**但许可证禁止竞争性产品**，且知识库体量巨大（161MB repo）。只能学形态，不能抄文本/代码。

---

### 2.4 arjun988/blender-skills（MIT，我方 11 份核心配方上游）

#### 文件树（压缩）

```
blender-skills/
├── .claude/skills/                # 95 个 skill 目录，269 个文件
│   ├── blender-director/SKILL.md
│   ├── camera-cinematography/{SKILL.md,references/{lens-and-composition,dof-guide,camera-move-library}.md}
│   ├── lighting/{SKILL.md,references/{cinematic-light-rigs,horror-lighting-setups}.md}
│   ├── rendering/{SKILL.md,references/{render-passes,npr-rendering}.md}
│   ├── lookdev/{SKILL.md,references/{lookdev-rig,lookdev-checklist}.md}
│   ├── qa-review/{SKILL.md,references/{qa-verdict-template,screenshot-angles}.md}
│   ├── materials/SKILL.md
│   └── ...（94 个 specialist skill）
├── .cursor/skills/                # 镜像
└── site/                          # 文档站
```

#### 关键实作与逐字引文

**(a) 构图参考文件只有 10 行**

> 来源：`https://raw.githubusercontent.com/arjun988/blender-skills/main/.claude/skills/camera-cinematography/references/lens-and-composition.md` L3-10
>
> "| Intent | Lens | Notes |
> | Establish | 18–28 | Watch edge stretch |
> | Scene / product | 35–50 | Default story |
> | Hero portrait | 85–135 | Compression |
> | Surveillance / long | 150+ | Flat space |
>
> Checklist: lead room, headroom, horizon, depth planes, no edge tangents."

这就是我方 `camera-cinematography/references/lens-and-composition.md` 的全部内容级别。**没有 fill 比例、没有距离解算、没有 in-frame 断言。**

**(b) 灯光参考有数字，但只是「起手值」**

> 来源：`.../lighting/references/cinematic-light-rigs.md` L5-9、L38-40
>
> "LGT_Key: Area 1m², 45° elevation, 30° azimuth, 5500K, strength 500W
> LGT_Fill: Area 2m², opposite side, 5500K, strength 150W (30% key)
> LGT_Rim: Spot, behind subject 135°, 3200K warm, strength 300W"
>
> "Cycles 256+ samples, Denoise ON, AgX view transform, Medium Contrast look."

注意最后一句：`Medium Contrast` 在 Blender 5.2 的 OCIO 配置里**不是合法 look**（见 2.3 与 4. 的缺口表）。

**(c) 材质有 PBR 区间与材质数预算**

> 来源：`.../materials/SKILL.md` L48-61、L70-78
>
> 表：Polished metal `1.0 / 0.1–0.3`、Brushed metal `1.0 / 0.4–0.6`、Painted metal `0.0 / 0.3–0.5`、Rubber `0.0 / 0.7–0.9`、Concrete `0.0 / 0.8–0.95`、Skin `0.0 / 0.4–0.6 + Subsurface 0.1–0.3`。
>
> 材质数预算：Hero prop `3–5`、Standard prop `1–2`、Modular piece `1`、Character `3–8`、Environment module `1–2`。

**(d) QA 只有分级词，没有阈值**

> 来源：`.../qa-review/SKILL.md` L55-62
>
> "| Blocker | 比例错误、法线损坏、严重超预算 |
> | Major | 剪影/可读性问题、轴心错误 |
> | Minor | 命名、轻微着色、小缝隙 |
> | Note | 可选打磨 |"

**评价**：宽度够、结构清楚、MIT 可商用；**但 95 个 skill 里几乎没有一条可执行阈值**。它适合做「配方索引」，不适合做「质量闸门」。我方直接继承了这个弱点。

---

### 2.5 ProfRino/Blender-MCP-Assembly-Skill（无 LICENSE，几何装配最实用）

单文件 222 行，专门解决「模型看起来炸开」的三个几何 bug：cube size 数学、Euler 旋转圆柱、不可见缝隙。

> 来源：`https://raw.githubusercontent.com/ProfRino/Blender-MCP-Assembly-Skill/main/SKILL.md` L21-22
>
> "For each joint, write:
> - The two parts that connect
> - Which face/edge of each meets the other
> - The target overlap (minimum 0.005m / 5mm)"

> L34-38
>
> "A cube with `size=S` has vertices at `±S/2`. After `scale=K`, the half-extent is `K * S/2` — **not** `K`.
> **Always use `size=2`.** With `size=2`, vertices are at ±1, so after `scale=K` the half-extent equals `K` directly."

> L137-141
>
> "**Extend geometry 10–15% past the target boundary** before applying subsurf, then verify"

> L176
>
> "Run `verify_overlap` for **every joint** in your connection map before moving to the next part. If it shows a gap, fix the position before continuing."

**评价**：对「零件悬空/炸开」极有效，规则可直接改写成我方 bpy 纪律；**无 LICENSE，不能抄原文/代码**，只能学「连接图 + 5mm 重叠 + 每件验边界」的形态。

---

### 2.6 ahujasid/mcp-for-blender（MIT，31.9k 星，协议层）

#### 文件树（压缩）

```
mcp-for-blender/
├── addon.py                    # Blender addon（6785 行）
├── main.py
├── src/blender_mcp/
│   ├── server.py               # MCP server（2257 行）
│   ├── guides/{scene,materials,level-design,animation,bpy,retopology,rigging}.md
│   ├── blender_scripts.py
│   └── safe_mode.py
├── integrations/codex/...
└── README.md                   # 899 行
```

#### 关键实作与逐字引文

**(a) 有视觉回看工具，但没有「什么算通过」**

> 来源：`https://raw.githubusercontent.com/ahujasid/mcp-for-blender/main/README.md` L654
>
> "| `look` | See the result from the `viewport`, `camera`, `angles` (auto-framed multi-view sheet, any direction) or `frames` (animation strip), drawn `solid`, `material`, `rendered`, `wireframe` or `xray`; or show a render or image file |"

**(b) 场景 guide 的构图/灯光规则**

> 来源：`.../src/blender_mcp/guides/scene.md` L15-16、L44-59
>
> "5. Judge the image, not your intentions: is anything floating, clipping, the wrong size, or hidden from camera?"
>
> "## Composition
> - Decide the camera early and compose for it; set `scene.camera`, focal length 35–50 mm for natural views, 85 mm+ for product shots, 24 mm or wider for interiors.
> - Foreground, midground, background. Leave negative space. Rule of thirds for the subject.
> - Vary scale and rotation of repeated props slightly; perfect grids read as fake.
> - Ground contact sells realism: props sit on surfaces, small things cluster against larger ones."
>
> "## Lighting
> - Start with an HDRI from Poly Haven ... set its strength (0.5–1.5), then add a key light ...
> - Check with `look(mode="camera", shading="rendered")`. Blown-out white or pure black areas mean exposure or light power is off; fix light power before touching exposure."

**评价**：工具层最成熟，`look(angles/wireframe/xray)` 正好补我方「沙箱看不到产物」的短板；**但它没有质量门，也没有数值判准**。31.9k 星证明的是协议生态，不是作品质量。

---

### 2.7 kevinbadi/blender-skills（无 LICENSE，我方 105 个配方目录中 16 份 RECIPE.md 来源）

#### 文件树（压缩）

```
blender-skills/
├── blender-toolkit/SKILL.md
├── crane-shot/SKILL.md
├── dolly-rotate/SKILL.md
├── dynamic-full-loop/SKILL.md
├── image-to-3d/SKILL.md
├── multi-image-to-3d/SKILL.md
├── perfect-loop/SKILL.md
├── product-polish/{SKILL.md,scripts/blender-product-polish.js}
├── polyhaven-{hdri-showcase,material-swap,scene-builder,studio-setup,texture-apply}/{SKILL.md,scripts/*.js}
├── slow-zoom/SKILL.md
├── threejs-export/{SKILL.md,scripts/*.js}
├── turntable/SKILL.md
└── README.md
```

#### 关键实作与逐字引文

> 来源：`https://raw.githubusercontent.com/kevinbadi/blender-skills/main/product-polish/SKILL.md` L36-40
>
> "3. **Strips noisy normal/roughness maps** from Meshy AI exports (these cause dotty reflections)
> 4. **Applies a glass-like material** — ultra-low roughness, full clearcoat, high IOR
> 5. **Adds 4-point studio lighting** — key, fill, rim, and bounce lights
> 6. **Switches to EEVEE with ray tracing** for smooth real-time reflections (no pixelation during camera movement)"

> 同文件 L51-52
>
> "- Meshy AI exports often include normal maps and roughness textures that look pixelated/dotty under strong lighting. This skill disconnects those and uses flat material values instead.
> - The skill uses EEVEE (not Cycles) to avoid progressive sampling noise during viewport navigation."

**评价**：这是「产品展示快出片」思路，不是「物理可信」。撕 normal/roughness、全镜面、统一 roughness，会把所有材质压成同一种塑料；在战斗静帧里会直接毁掉布料/皮肤/金属的可区分性。它没有 LICENSE，默认保留全部权利。

---

### 2.8 seehiong/blender-mcp-bridge（MIT，98 工具，简评）

README L446-456 列出工具分组：3D Print Preparation 7 个（`check_mesh_for_printing`、`repair_mesh`、`apply_voxel_remesh`、`add_model_base`）、Rendering 4 个（含 `generate_views` 一次出 top/front/side/iso）、Design Rules 3 个。L64 明确："rules are advisory — they do not check your geometry. `check_mesh_for_printing` verifies a ..."。

**评价**：工具广度大，3D 打印校验可用；艺术质量/构图/场景预算不在范围内。适合作为「工具面参考」，不适合作为质量对标。

---

### 2.9 BlenderProc（GPL-3.0，非 agent skill，仅引渲染参数）

> 来源：`https://raw.githubusercontent.com/DLR-RM/BlenderProc/main/blenderproc/python/renderer/RendererUtility.py` L150-163
>
> "Configures the adaptive sampling, the noise threshold is typically between 0.1 and 0.001. Adaptive sampling automatically decreases the number of samples per pixel based on estimated level of noise."
>
> `set_denoiser` 支持 `OPTIX` / `INTEL`；Intel 路径用 compositor Denoise 节点并接 `DiffCol` / `Normal`。

**用途**：为「adaptive threshold 0.01 final / 0.05 preview」提供第二个独立来源。**GPL-3.0，不可把代码抄进 SaaS。**

---

## 3. 满分作品靠什么成立（可执行判准）

> 说明：以下每条都尽量落到参数或判定规则。标「来源」的是原文/代码；标「推断」的是我基于多家规则合成的、尚未在任何仓库看到逐字写死的判准，落地前应按我方场景实测校准。

### 3.1 一条主结论

满分不是「模型更细」，而是**先缩小问题，再把剩下的每个对象都审到位**。ifBars 的 whole-scene 是最清楚的证据：21 个资产族、45 个实例、180k tris、24 材质，**每个实例单独出图、单独判定**。EL4CTEO 的 QA 则证明：资产级 pass 需要 z-fight 1mm、漂浮 2mm、UV 重叠 5% 这些数字。jangtrinh 证明：相机、评审、失败升级都可以写死。

### 3.2 十二条可执行判准

| # | 判准 | 可执行阈值 / 判定规则 | 来源 |
|---|---|---|---|
| 1 | **合同先于几何** | 开工前声明 purpose（render-only / print / both）、必需部件、尺度、交付视图；缺关键数字 → `request-input`，不猜 | jangtrinh core L36-37；ifBars intake L72-77 |
| 2 | **复杂度按「资产族 × 实例 × 支撑关系」定义，不按物体数** | 场景级：≤180k evaluated tris、≤24 材质；每个实例有独立 tri 预算；每个实例都要 isolated + context 两张图；每个实例都是独立评审项 | ifBars whole-scene L3-13、L29-35 |
| 3 | **未批准的资产不得复制** | 每个 family 先做 1 个 representative；它通过 QA + 视觉评审后才允许复制；复制时记录 count / 支撑面 | ifBars guidance L13-20 |
| 4 | **阶段门必须可测** | 每阶段 Exit 条件 = 证据可见或场景可测；灰模不得当成品；silhouette 不过不得进细节 | ifBars staged L3-4、L29-40 |
| 5 | **相机先定焦，再解距离** | `d = R / sin(fill·θ)`；product fill 0.80–0.88、character 0.75、game 0.7；35mm 全身 / 24mm 动作 / 85–135mm 产品；`world_to_camera_view` 断言 bbox 在 [0,1] 且 z>0 | jangtrinh product-viz L198-212、L651-660 |
| 6 | **构图是二元问题，不是形容词** | 剪影可辨；前/中/后三层；主体不在正中除非有意；水平线不歪除非有动机；无 tangent merger；四向视图都可读 | arjun988 camera ref L10；ifBars quality-gates L48-62 |
| 7 | **灯光有物理量级** | key 45° 侧 / 30–40° 仰、fill 对侧 1/3、rim 背后；灯尺寸 ≈ 主体；能量按 `power × extent²` 缩放；世界 HDRI 0.5–1.5 | EL4CTEO lighting L24、L30-32；ifBars evidence_settings L29 |
| 8 | **材质必须过 sanity check** | metallic 0/1；dielectric albedo sRGB 30–240（均值 ~120）；metal albedo ≥180；roughness 变化 ≥0.1–0.2（std ≥0.02）；normal map 均值 ≈(128,128,255)；无纯黑/纯白、无默认灰、无品红 | EL4CTEO pbr-values L42-47 |
| 9 | **预览与最终分档，禁止用 previz 设置交终稿** | preview：Cycles 64 spp / threshold 0.05 / 50%，或 Eevee 16 TAA；final：Cycles 512 spp / 0.01，或 Eevee 128 TAA + raytracing；product：1024 spp / 0.005 | EL4CTEO render L20 + render_batch L22-29 |
| 10 | **降噪与光路是质量的一部分** | OIDN High / Accurate prefilter / Color+Albedo+Normal；总弹射 12、glossy 4、transmission 8–12；`clamp indirect 5–10`；`use_light_tree=True`；少而大的灯优于多而小的灯 | EL4CTEO render L31-36；ifBars rendering L98-100 |
| 11 | **QA 要有数字容差与 profile** | z-fight `eps=0.001m`；漂浮接触 `tol=0.002m`；UV 重叠 >5% 告警；`ground_z` 偏离 0 告警；>300k tris 时按部件拆分再查；game/render/print/roblox 四套严重度 | EL4CTEO `qa_check.py` L25-32、L350-351；`SKILL.md` L55 |
| 12 | **独立评审 + 失败升级 + 回滚** | 逐 critical feature 给 PASS/FAIL/UNKNOWN 并附证明视角；禁止全局小数分；同一特征失败 2 次换方法类，3 次 `request-input`；最多 3 轮；修复只有在目标改善且无回归时才保留，否则回滚 | jangtrinh review-rubric L21-29、core L42、operating L92-95；ifBars iterative L81-92 |

### 3.3 「满分」的评分定义（ifBars）

- 维度权重：spec 25 / multiview 20 / geometry 15 / physical 15 / materials 15 / context-export 10 / reproducibility 5。
- 封顶：硬门失败 49；任一 critical criterion 未过半 84；任一 criterion 未过半 94；除非确定性评分满分 + 每个 judge 全过 + 每个 broad dimension 都 exceptional，否则不高于 99。
- 因此「满分静帧」不是主观 10/10，而是：**硬门全过 + 确定性评分满分 + 独立评审每个 critical 特征全过 + 每个维度都 exceptional**。任何一项缺失，分数直接掉到 94/84/49。

### 3.4 迭代回路的共识

三家一致的最小回路：

```
契约 → 低样本预览（16–64 spp / 40–50%）→ 打开图 → 固定清单自评
→ 一次只改一个变量 → 复预览 → 最终档（512 spp / 128 TAA）
→ 7 视角证据页 → 独立评审逐特征 PASS/FAIL/UNKNOWN
→ 通过则交付；同一特征失败 2 次换方法；3 次停手要输入；最多 3 轮
```

我方差的是后半段：有阶段、有 QA 分级，但没有「谁看、看什么、什么算不通过、几次停手、不过怎么回滚」。

---

## 4. 我方缺口表

基线文件：`/home/lenovo/Desktop/image-app/deploy-staging/opencode-runtime/skills/blender-director/`
（下表路径相对该目录；行号为当前文件实际行号）

| # | 决策点 | 我方现状（file:line） | 他们怎么做（file:line） | 差距后果 |
|---|---|---|---|---|
| 1 | **最终档定义** | 基线/HEAD `SKILL.md:106` 规定 Eevee previz 必设 `taa_render_samples=1` + `use_raytracing=False`；`SKILL.md:90-100` 只说「快稿 Eevee，最终 Cycles」，没有最终档参数。**15:55 并行改动已改为单帧 still 可 `quality="final"`（RT on + 阴影开 + samples ≥32）** | EL4CTEO `skills/blender-rendering/SKILL.md:20`：final = Cycles 512 spp / 0.01 或 Eevee 128 TAA + raytracing | 基线版必然摩尔纹；并行修复后仍有三个缺口：32 spp 低于 128 TAA/512 spp、未规定 CLI 最终档、Cycles 最终档未接入 |
| 2 | **预览/最终分流** | `SKILL.md:39` 只有「阶段判据」，没有 preview/final preset 概念；`recipes/rendering/RECIPE.md:60-75` 有采样表但未被阶段门引用 | EL4CTEO `render_batch.py:22-29` 三档 preset；ifBars `render_scene.py` 的 `--samples` 与 `--denoise preview/final` | Agent 用 previz 设置交终稿，且没有「最终档必须 100% 分辨率」断言 |
| 3 | **场景复杂度** | 无场景级预算；`recipes/references/validation-checklist.md:46-52` 只有「polycount within budget」，`polycount-budgets.md` 是单资产游戏预算，不是场景预算 | ifBars `docs/whole-scene-benchmark.md:3-13`：180k tris、24 材质、21 family / 45 instances、每实例预算 | 1052 物体/340 碎片无人拦；「complex scene」被误解成「堆得多」 |
| 4 | **资产族与实例台账** | `recipes/scene-assembly/RECIPE.md:38-73` 只有集合结构与「重复用 instance」，没有 family/instance/count/representative 概念 | ifBars `docs/whole-scene-guidance.md:13-20`：asset ledger；先 representative，后复制；未批准不得复制 | 340 片碎玻璃 = 一个未批准资产族被复制 340 次；没有「代表性碎片先过审」 |
| 5 | **相机解算** | `recipes/camera-cinematography/RECIPE.md:44-53` 只有焦距表；`:55-61` 构图 checklist；无距离/填充率/in-frame 公式 | jangtrinh `knowledge/60-pipeline/product-viz-and-shots.md:198-212`：`d=R/sin(fill·θ)`；`:651-660` fill 0.80–0.88；`world_to_camera_view` 断言 | 主体过小/过大、裁切、镜头离主体过近，全靠目测 |
| 6 | **相机净空/遮挡** | 无。`recipes/set-dressing/RECIPE.md:45` 只有一句「为玩家/相机留净空」，无判定 | jangtrinh `product-viz-and-shots.md:626` 把「camera inside geometry」列为 failure mode；ifBars `whole-scene-benchmark.md:29-35` 用 isolated + context 双图查遮挡 | **镜头插在碎片云里**：没有「相机 0.5m 内无几何」「到头部/胸部无遮挡」的断言 |
| 7 | **构图判定** | `camera-cinematography/RECIPE.md:55-61` 是二元 checklist，但没有「占画面多少」「margin 多少」「几层」的数值 | jangtrinh `product-viz-and-shots.md:589-597` 固定自评清单；ifBars `quality-gates.md:48-62` 六问 | 评审无法复验；同一张图两个人给不同结论 |
| 8 | **灯光量级** | `recipes/lighting/RECIPE.md:39-47` 有角度与 1/2–1/4 强度，但没有功率/距离/尺寸缩放；`:70-84` HDRI 只有流程 | EL4CTEO `lighting-lookdev/SKILL.md:24、30-32`：key/fill/rim、灯尺寸 ≈ 主体、功率按 extent²；ifBars `evidence_settings.py:29` 400/160/600 | 能量随机，爆白或全黑；同一场景换尺寸就变味 |
| 9 | **色彩管理** | `recipes/rendering/RECIPE.md:95-96` 与 `:125` 写 `Medium Contrast` / `High Contrast`；`recipes/lighting/references/cinematic-light-rigs.md:40` 同样写法 | jangtrinh `product-viz-and-shots.md:428-431`：5.2 合法 look 是 `None` / `AgX - Punchy` / `AgX - Medium High Contrast` / `AgX - Base Contrast` …；`AgX - Medium Contrast` **不存在**，设置会 `TypeError` | Agent 设 look 抛错后被吞，最终用默认；画面对比度不可控 |
| 10 | **材质可信度** | `recipes/materials` 我们未收录独立 skill；`arjun988 materials:48-61` 只有区间，无实测值/无 sanity check | EL4CTEO `references/pbr-values.md:42-47`：dielectric 50–200、metal ≥180、roughness std ≥0.02、normal 均值 (128,128,255) | 平光、纯黑/纯白、全镜面；布料/皮肤/金属不可区分 |
| 11 | **QA 数值门** | `recipes/qa-review/RECIPE.md:55-62` 只有 Blocker/Major/Minor/Note 分级；`:64-75` 只有裁决模板；无脚本 | EL4CTEO `qa_check.py`（355 行脚本）：z-fight/浮岛/法线/非流形/UV/权重/ground_z；`review_shots.py` 7 视角 | 「剪影/可读性问题」只能靠眼睛；z-fight、漂浮、漏 UV 无法稳定发现 |
| 12 | **独立评审** | 无。`qa-review/RECIPE.md:64-75` 的裁决由作者自己写 | jangtrinh `review-rubric.md:21-29` 逐特征 PASS/FAIL/UNKNOWN；ifBars `iterative-refinement/SKILL.md:26-35` 独立 critic ledger | 作者自验；AGENTS.md 的「作者≠Hacker」在这条链上没有落实 |
| 13 | **迭代上限与失败升级** | 无 max rounds、无 verdict 词汇；`qa-review` 只说「修复后复验」 | jangtrinh `blender-agent-core/SKILL.md:42`：2 次失败换方法类、3 次 request-input；`native-agent-iteration` max_rounds ≤3；ifBars iterative 保留/回滚条件 | 无限微调；同一错误反复换参数；没有回滚 |
| 14 | **交付验证** | 无。`qa-review` 没有 PNG 头/分辨率/解码检查 | jangtrinh `native-render-delivery.md:113-130`：PNG 实际尺寸、ffprobe `nb_read_frames`、完整解码；ifBars `rendering-workflow/SKILL.md:190-203` completion gate | 4:3 预览冒充 16:9、缩略图冒充 1080p、文件存在当成功 |
| 15 | **参考图门** | `recipes/references/visual-match-checklist.md:5`：≥8/10 类别 Match/Close；`:12` max 3 iterations；但只在「有参考图」时启用（`:3`）。另：`recipes/text-to-blender/RECIPE.md:60-72` 有强制视觉检查点，但只在那一条配方内生效，未上升为 SKILL 阶段门 | ifBars `reference` suite、jangtrinh 相机匹配；无参考时也有 staged gate + 7 视角 | 无参考图的委托（如蜘蛛侠战斗）除 text-to-blender 路线外不触发任何视觉门 |
| 16 | **依赖与可执行性** | `camera-cinematography/RECIPE.md:97-99` 指向的 3 个参考文件均存在但极薄（326/177/355 bytes）；核心阶段判据仍是文字 | EL4CTEO 每个判准都有 `.py`；ifBars 有 `render_evidence.py` / `inspect_asset.py` | 判准无法被执行，只能被「理解」；不同 agent 理解不同 |

**我方仍然有的优势（不要丢）**：
- 105 个配方目录的覆盖广度（风格/mood/运镜/拟合/特效）远大于 EL4CTEO 的 22 个、ifBars 的 12 个。
- `SKILL.md:102-112` 的桥接实弹经验（5.2 slotted action、FFMPEG enum、共享实例互踩、artifact_base_url）是别家没有的生产知识。
- `seed-mapping.md` 的 L1 种子直迁是低成本 blocking 初值，别家没有。
- `SKILL.md:12-14` 的 3D 路由硬规则能阻止二维模型顶替 previz。

**结论：不要重写配方库；在现有 105 份之上加一层「可执行质量门」，并修正最终档定义。**

---

## 5. 可直接抄的配方

> License 标注为「可抄」的，复制时保留版权声明与 MIT 全文；标「只学形态」的不得复制原文/代码。

### 5.1 渲染三档 preset（可抄，MIT，EL4CTEO）

```python
# 来源：EL4CTEO/blender-skills, skills/blender-rendering/scripts/render_batch.py L22-29
# License: MIT, Copyright (c) 2026 EL4CTEO
PRESETS = {
    "preview": {"cycles": dict(samples=64,  adaptive_threshold=0.05, use_denoising=True),
                "eevee":  dict(taa_render_samples=16,  use_raytracing=False), "percent": 50},
    "final":   {"cycles": dict(samples=512, adaptive_threshold=0.01, use_denoising=True),
                "eevee":  dict(taa_render_samples=128, use_raytracing=True),  "percent": 100},
    "product": {"cycles": dict(samples=1024, adaptive_threshold=0.005, use_denoising=True),
                "eevee":  dict(taa_render_samples=256, use_raytracing=True),  "percent": 100,
                "transparent": True},
}
```

**我方落地要点**：基线 `SKILL.md:106` 的 `samples=1` 只能用于 bridge 内 previz；**最终静帧必须走 CLI 子进程**（`environment-notes.md` 已记录「同 blend 直连 CLI 任意渲染 exit 0」）。15:55 并行改动已加 `quality="final"`，但它只保证 `samples >= 32`，仍低于外部 final 档的 128 TAA / 512 spp，且未解决 bridge 内高负载 crash。两个前提：① EL4CTEO 脚本依赖同目录 `_bpyx.py`，只拷 `render_batch.py` / `qa_check.py` 会 import 失败；② Eevee 后台渲染仍需要 GPU context，桥主机无 GPU 时优先 Cycles CPU/GPU。例如：

```bash
# 我方建议（非外部原文）：bridge 只跑 previz，最终档走 CLI，规避 native crash
blender -b "$BLEND" -E CYCLES --python-expr "
import bpy
s=bpy.context.scene
s.cycles.samples=512
s.cycles.use_adaptive_sampling=True
s.cycles.adaptive_threshold=0.01
s.cycles.use_denoising=True
s.cycles.denoising_input_passes='RGB_ALBEDO_NORMAL'
s.render.resolution_percentage=100
s.view_settings.view_transform='AgX'
s.view_settings.look='AgX - Medium High Contrast'
" -o "$OUT/final_####" -F PNG -f 1
```

### 5.2 Cycles 质量杠杆（可抄，MIT，EL4CTEO）

```python
# 来源：EL4CTEO/blender-skills, skills/blender-rendering/SKILL.md L31-36（改写为 bpy）
s.cycles.use_adaptive_sampling = True
s.cycles.adaptive_threshold = 0.01          # final；preview 0.05
s.cycles.use_denoising = True
s.cycles.denoising_input_passes = 'RGB_ALBEDO_NORMAL'
s.cycles.max_bounces = 12                   # interior diffuse >= 4
s.cycles.glossy_bounces = 4
s.cycles.transmission_bounces = 8           # glass 8-12
s.cycles.sample_clamp_indirect = 5          # 5-10 kills fireflies
s.cycles.use_light_tree = True
```

### 5.3 资产 QA 容差（可抄，MIT，EL4CTEO）

```bash
# 来源：EL4CTEO/blender-skills, skills/blender-asset-qa/scripts/qa_check.py
blender -b scene.blend -P qa_check.py -- \
  --objects SM_Hero SM_Debris --profile render \
  --eps 0.001 --tol 0.002 --max-tris 300000
```

关键判定：
- `zf="e"`：共面重叠 >1mm → error；
- `fl="e"`：岛与所有其他部件距离 >2mm → error（漂浮）；
- `sc="e"`：未应用/负缩放 → error；
- `uv_overlap_pct > 5` → warning；
- `ground_z` 偏离 0 超过 `max(tol,1e-3)` → warning；
- >300k tris：跳过 z-fight/floating，按部件拆分再查（`blender-asset-qa/SKILL.md` L55）。

### 5.4 PBR sanity check（可抄，MIT，EL4CTEO）

```python
# 来源：EL4CTEO/blender-skills, references/pbr-values.md L42-47（改写为伪代码）
# dielectric albedo：sRGB 50–200，均值 ~120；纯 0/255 几乎一定错
# metal base color：sRGB >= 180，低于则 metallic mask/albedo 可疑
# roughness：std dev < 0.02 视为过于均匀，需加变化
# normal map：均值 ≈ (128,128,255)；blue < 200 或 RGB 偏离 → 色彩空间错/把 height 当 normal
```

### 5.5 场景预算与实例台账（可抄形态，MIT，ifBars）

```markdown
# 来源：ifBars/blender-agent-studio, docs/whole-scene-benchmark.md L3-13 / whole-scene-guidance.md L13-20
## Scene ledger（开工前填）
| family | instances | tri budget | material | support | representative approved? | evidence |
|---|---:|---:|---|---|---|---|
| SM_Hero | 1 | 60000 | M_Suit, M_Lens | ground | [ ] | front/side/3q |
| SM_Antagonist | 1 | 40000 | M_Suit2 | ground | [ ] | ... |
| SM_ContactSurface | 1 | 5000 | M_Concrete | ground | [ ] | ... |
| SM_Env_Anchor | 3 | 20000 | M_Metal, M_Concrete | wall/ground | [ ] | ... |
| VFX_Debris | ≤60 | 20000 | M_Debris | — | [ ] | isolated + context |

## 硬上限
- scene evaluated tris ≤ 180,000
- materials ≤ 24
- 每个 family 先 1 个 representative 过 QA + 视觉评审，才允许复制
- 每个 instance 都要 isolated 图 + context 图
```

### 5.6 标准化证据棚（可抄，MIT，ifBars）

```python
# 来源：ifBars/blender-agent-studio, evidence_settings.py L24-45 + render_evidence.py L182-199
# 以主体最大边 extent 为尺度
powers = (400.0, 160.0, 600.0)       # key/fill/rim，诊断档 (140,65,110)
camera_distance = extent * 2.3
ortho_scale = extent * 1.45
light_power = [p * extent**2 for p in powers]
key_loc  = center + Vector(( extent*2.2, -extent*2.4,  extent*2.8))
fill_loc = center + Vector((-extent*2.5, -extent*0.6,  extent*1.4))
rim_loc  = center + Vector(( extent*0.4,  extent*2.5,  extent*2.0))
light_size = (extent*2.0, extent*2.4, extent*1.7)

scene.view_settings.view_transform = 'AgX'
scene.view_settings.exposure = 0.0
scene.view_settings.look = 'AgX - Medium High Contrast'
world_bg = (0.035, 0.045, 0.06, 1.0); world_strength = 0.35
floor_roughness = 0.82

# 7 视角：perspective/front/back/left/right/top/bottom；透视 lens=55
# 输出 384px，contact sheet
```

### 5.7 相机解算 + 净空（只学形态，PolyForm Shield；代码为我方重写）

```python
# 数学关系参考 jangtrinh product-viz-and-shots.md L198-212；以下为我方独立实现
import math
from mathutils import Vector

def half_fovs(cam_data, scene):
    r = scene.render
    aspect = (r.resolution_x * r.pixel_aspect_x) / (r.resolution_y * r.pixel_aspect_y)
    f, sw, sh = cam_data.lens, cam_data.sensor_width, cam_data.sensor_height
    if cam_data.sensor_fit == 'VERTICAL' or (cam_data.sensor_fit == 'AUTO' and aspect < 1):
        hv = math.atan((sh * 0.5) / f) if cam_data.sensor_fit == 'VERTICAL' else math.atan((sw * 0.5) / f)
        hh = math.atan(math.tan(hv) * aspect)
    else:
        hh = math.atan((sw * 0.5) / f)
        hv = math.atan(math.tan(hh) / aspect)
    return hh, hv

def frame_distance(cam_data, scene, radius, fill=0.82):
    hh, hv = half_fovs(cam_data, scene)
    theta = min(hh, hv)
    return radius / math.sin(fill * theta)

# 判定：bbox 8 角 world_to_camera_view 全部 0<=u,v<=1 且 z>0
# 判定：相机到头部/胸部/接触点各 3 条 ray，>=90% 首个命中是主体；最近表面 >=0.5m
```

### 5.8 装配纪律（只学形态，无 LICENSE，ProfRino）

```python
# 形态来源：ProfRino/Blender-MCP-Assembly-Skill L34-38、L137-141、L176
# 不要复制原文；以下为我方按同形态重写
bpy.ops.mesh.primitive_cube_add(size=2, location=loc)   # scale = 半边长，避免 ×2 错误
obj.scale = (half_w, half_d, half_h)
bpy.ops.object.transform_apply(scale=True)               # 每次设完立刻 apply

# 每个 joint 必须 verify_overlap >= 0.005 m
# subsurf 结构件目标外扩 10-15%，apply 后重新量 bounds
```

### 5.9 评审与失败升级（只学形态，PolyForm Shield）

```markdown
# 形态来源：jangtrinh review-rubric.md L21-29 + blender-agent-core/SKILL.md L42
## Critic ledger（每个 critical feature 一行）
| feature | expected | proof view | verdict | falsifier |
|---|---|---|---|---|
| 主角剪影 | 动作可辨 | 3/4 | PASS | 遮住背景仍能读出姿态 |
| 接触点 | 手/脚与表面接触 | side | FAIL | 有可见缝隙 > 2mm |
| 镜头净空 | 无碎片遮挡脸部 | camera | UNKNOWN | 需要一张无遮挡对照图 |

规则：禁止全局小数分；同一特征 2 次失败换方法类；3 次 request-input；最多 3 轮。
```

---

## 6. License 风险（我方是 SaaS，必须点名）

| repo | license | 风险判定 | 建议 |
|---|---|---|---|
| EL4CTEO/blender-skills | MIT | 可商用、可修改、可再分发；保留版权与许可文本 | 可抄脚本与 preset；在文件头保留 `MIT, Copyright (c) 2026 EL4CTEO` |
| ifBars/blender-agent-studio | MIT | 可商用；保留版权与许可文本 | 可抄 quality gates / evidence settings / 评分结构 |
| arjun988/blender-skills | MIT | 可商用；我方现有配方头已标注来源 | 可继续用；补齐版权声明 |
| ahujasid/mcp-for-blender | MIT | 可商用 | 可参考 guide；保留声明 |
| seehiong/blender-mcp-bridge | MIT | 可商用 | 工具面可参考 |
| **jangtrinh/design-os-3d-blender** | **PolyForm Shield 1.0.0** | **禁止竞争**：L35 "Any purpose is a permitted purpose, except for providing any product that competes with the software or any product the licensor or any of its affiliates provides using the software."；L39 "Goods and services compete even when they provide functionality through different kinds of interfaces or for different technical platforms. ... If you market a product as a practical substitute for the software or another product, it definitely competes." | **不要抄任何代码/文本**。Eimu 是 SaaS 3D 创作产品，若被认定与 design-os 竞争，连「使用」都可能受限。只可读其公开规则后**用自己的话重写**，且不要复制其脚本/知识库；上线前让法务确认 |
| **kevinbadi/blender-skills** | **无 LICENSE** | 默认保留全部权利，无复制许可。我方 16 份配方已来自该库（本地头注写「仅内部使用，不对外散布」） | **SaaS 对外分发前必须替换或重写这 16 份**；至少不要把其原文随 skill 包发给用户。注意 `product-polish` 的手法本身也会降低质量 |
| **ProfRino/Blender-MCP-Assembly-Skill** | **无 LICENSE** | 默认保留全部权利 | 只学形态，不抄原文/代码 |
| **DLR-RM/BlenderProc** | **GPL-3.0** | 代码进入 SaaS 可能触发 GPL 义务 | 只引参数概念，不复制代码 |
| VxASI/blender-mcp-vxai | MIT | 可商用，但 2025 停更 | 不建议依赖 |

**额外风险**：我方 105 个配方中 16 个来自 kevinbadi（`grep -rl kevinbadi` 计数），其余 88 份头注为 MIT。若把 skill 包作为产品的一部分交付给用户，**无 LICENSE 的 16 份是明确的复制风险**，应优先清理。

---

## 7. 蜘蛛侠战斗静帧：照最严标准应长什么样

> 以下把第 3 节的判准落到一个具体委托。数值来自引文；标「推断」的是我方合成规则，落地前需在 bridge 上实测。

### 7.1 交付物

| 项 | 规格 |
|---|---|
| 主图 | 1920×1080（或 2048×1152）PNG，16-bit，100% 分辨率，sRGB 显示 |
| 证据页 | 7 视角 contact sheet：perspective / front / back / left / right / top / bottom，384px/格 |
| 场景 | `.blend` + `metrics.json`（tris、materials、objects、bbox、ground_z、QA pass） |
| 评审 | `critic_ledger.md`：每个 critical feature 一行 PASS/FAIL/UNKNOWN + 证明视角 |
| 渲染 | Cycles 512 spp / adaptive 0.01 / OIDN(albedo+normal)，或 Eevee 128 TAA + raytracing |

### 7.2 场景合同（先写，后建模）

- **资产族 ≤ 8**：`SM_SpiderHero`（1）、`SM_Antagonist`（1）、`SM_ContactSurface`（1，墙/地/车顶）、`SM_Env_Anchor`（3，管道/箱体/栏杆）、`VFX_Debris`（1 族，≤60 实例）、`VFX_Dust`（1）、`FX_Emissive`（可选，1）。
- **硬上限（推断，按 ifBars 场景预算缩放）**：evaluated tris ≤ 180k；materials ≤ 24；mesh objects ≤ 120；每个 family 先做 1 个 representative，过 QA + 视觉评审后才允许复制。
- **碎片**：≤60 片，≤20k tris 总量，1 个材质；单片在最终画面 ≥2px；相机 0.5m 内不得有碎片；不得有碎片与主角胶囊体相交；低于 2px 的碎片直接剔除，不靠景深糊掉。
- **禁止**：1052 个对象、340 片碎玻璃、无主的重复小件、每个副本独立材质。

### 7.3 相机与构图

| 项 | 判准 |
|---|---|
| 焦距 | 全身动作 35mm；近距离压迫 24mm；85mm 只用于产品/肖像，不用于全身战斗 |
| 填充率 | `fill=0.82`（0.80–0.88）；主体 bbox 占较紧轴 80–88% |
| 距离 | `d = R / sin(fill·θ)`；1.8m 主角、R≈1.0m、35mm、16:9 时 d≈4.3m；24mm 时 d≈3.1m（推断，按标准 pinhole 计算） |
| 机位高度 | 10–25° 仰角（EL4CTEO 的 3/4 产品角规则迁移；战斗可用 5–20°） |
| 画面内 | bbox 8 角 `world_to_camera_view` 全部 `0.03 ≤ u,v ≤ 0.97`，`z > 0`；不得有角在相机后 |
| 净空 | 相机 0.5m 内无几何；相机到头部/胸部/接触点各 3 条 ray，≥90% 首个命中是主体；不得有环境件挡在脸/手/接触点前（推断） |
| 构图 | 剪影可辨；前/中/后三层；动作方向留白 ≥5% 画面；headroom 3–8%；水平线不歪除非有动机；无 tangent merger |
| 前景 | 只允许 1 层声明的前景，占画面 <15%，不得遮住脸/接触点；否则视为遮挡失败（推断） |

### 7.4 灯光与材质

- 三点：key 45° 侧、30–40° 仰、尺寸 ≈ 主角；fill 对侧 1/3 功率、略低；rim 背后做轮廓分离。
- 能量按 `power × extent²` 缩放；参考 ifBars：key/fill/rim = 400/160/600 × extent²。
- AgX + `AgX - Medium High Contrast`；exposure 0；不得有纯白大面积（>0.5% 画面，推断）或压死黑导致剪影丢失。
- 接触阴影必须在脚/手/接触面出现；漂浮即 NO-SHIP。
- 材质：metallic 0/1；dielectric albedo sRGB 30–240；metal ≥180；roughness 有 ±0.1–0.2 变化；normal map Non-Color；无默认灰/品红；布料、皮肤、金属、混凝土必须可区分。
- 蜘蛛网纹/背景格栅是高频细节：在 1080p、主角占 85% 画高时，1px ≈ 2mm（1.8m/918px）；**线宽 <4mm 的几何或纹理必然摩尔纹**（推断，按采样定理与像素 footprint 计算）。要么加粗到 ≥2px，要么改用带 mip 的贴图，要么在最终档用足采样 + 降噪。

### 7.5 渲染与 QA

1. **先跑 qa_check（profile=render）**：z-fight 1mm、漂浮 2mm、未应用缩放、UV 缺失、ground_z 必须过；>300k tris 按部件拆分。
2. **低样本预览**：Cycles 64 spp / 0.05 / 50%，或 Eevee 16 TAA；逐条过 7 问清单。
3. **最终档**：Cycles 512 spp / 0.01 / OIDN High + Albedo/Normal；总弹射 12、glossy 4、transmission 8；clamp indirect 5；light tree on。
4. **7 视角证据页**：AgX、exposure 0（诊断可 -1）、Medium High Contrast、384px、contact sheet。
5. **独立评审**：每个 critical feature 一行 PASS/FAIL/UNKNOWN；证明视角必须写；禁止全局小数分。
6. **失败升级**：同一特征 2 次失败 → 换方法类（例如从「加更多碎片」换成「减少到 1 个受控碎片族」）；3 次 → 停手要输入；最多 3 轮。
7. **保留/回滚**：只有目标改善且无回归才保留修复，否则回到上一版候选。

### 7.6 这张图应该「长什么样」（文字验收）

- 一眼能读出：主角在画面中景偏一侧，身体形成清晰的攻击弧线；对手/目标在接触点附近；接触点有可见的力反馈（压缩、尘、形变），不是两个模型贴着。
- 背景只有 3 个可辨识锚点（管道、箱体、栏杆），不抢主体；前景最多一层薄尘/碎片，且不挡脸。
- 碎片是「少量、有方向、有大小层次」的 20–60 片，不是均匀铺满的 340 片噪声；每片都能看出是碎片，不是 1–2px 的噪点。
- 主角边缘有 rim 分离；暗部仍有布料/皮肤层次；高光不爆；金属镜头有环境反射而不是死白。
- 放大到 100%：没有摩尔纹、没有 z-fight 闪面、没有漂浮零件、没有品红/默认灰、没有锯齿边缘。
- 7 视角证据页里，front/back/left/right 都能认出是同一个人、同一套材质；top/bottom 不出现破面或空洞。

### 7.7 NO-SHIP 清单（任一命中即不交付）

- 相机 0.5m 内有几何，或脸/手/接触点被碎片遮挡。
- 画面里出现 >120 个 mesh 对象，或碎片 >60 片，或存在未声明资产族。
- 最终档仍是 Eevee `taa_render_samples=1` / raytracing off。
- 有 z-fight（共面 <1mm）、漂浮件（>2mm 缝隙）、未应用缩放、缺 UV。
- 纯黑/纯白大面积、默认灰、品红、材质不可区分。
- 只有一张 hero 图，没有 7 视角证据页，没有独立评审 ledger。
- 交付图不是 1920×1080 实际头信息（用 4:3 或缩略图冒充）。

---

## 8. 建议的最小改动集（本次不落地，遵守约束）

> 只写建议，不改 `deploy-staging/`。按优先级排序。

| 优先级 | 改动 | 落点 | 具体内容 |
|---|---|---|---|
| P0 | 最终档与 previz 分离 | `blender-director/SKILL.md:90-106`（并行改动已加 `quality="final"`，仍未闭合） | 明确：previz 可用 1 spp；最终静帧必须 **Cycles 512 spp / adaptive 0.01** 或 **Eevee 128 TAA + RT on**（不是 32）；最终档走 CLI 子进程；禁止用 previz 设置交终稿 |
| P0 | 修正非法 AgX look | `recipes/rendering/RECIPE.md:96,125`、`recipes/lighting/references/cinematic-light-rigs.md:40` | `Medium Contrast` → `AgX - Medium High Contrast`（或 `AgX - Base Contrast`）；设置前先读 enum，捕获 TypeError |
| P0 | 加场景预算与资产台账 | 新建 `references/scene-budget.md`（建议）并在 `SKILL.md:50-53` 引用 | 180k tris / 24 材质 / ≤8 family / ≤120 objects / 碎片 ≤60；每 family 先 representative 后复制 |
| P1 | 加相机解算 + 净空断言 | 新建 `references/camera-solve.md` 并改 `recipes/camera-cinematography/RECIPE.md:55-61` | `d=R/sin(fill·θ)`；fill 0.80–0.88；bbox in-frame 断言；相机 0.5m 净空 + 3×3 ray 遮挡测试 |
| P1 | 加数值 QA 脚本 | 新建 `verify/verify_scene_qa.py`（参考 EL4CTEO MIT，保留声明） | z-fight 0.001、floating 0.002、UV overlap 5%、ground_z、object/family count、material count、tri count |
| P1 | 加独立评审与失败升级 | `recipes/qa-review/RECIPE.md:55-75` | 逐 critical feature PASS/FAIL/UNKNOWN；作者≠评审；2 次失败换方法类；3 次 request-input；max 3 轮；保留/回滚 |
| P2 | 加 7 视角证据页 | `recipes/qa-review/RECIPE.md:38-46` | perspective/front/back/left/right/top/bottom；384px；contact sheet；AgX / exposure 0 |
| P2 | 参考图门扩展到无参考任务 | `recipes/references/visual-match-checklist.md:3-12` | 无参考图时用「合同声明的 critical feature」代替参考类别，仍执行 8/10 与 max 3 轮 |
| P2 | 清理无 LICENSE 配方 | `recipes/*/RECIPE.md` 中 16 份 kevinbadi 来源 | SaaS 对外分发前重写或替换；不要把原文随包发 |

---

## 9. 未取到 / 不确定项

- `DLR-RM/BlenderProc` 的 commit SHA 未取（非 skill 库，只引参数）；star 3,760 / GPL-3.0 / pushed 2026-10-22 来自 `gh search repos`。
- `VxASI/blender-mcp-vxai`、`sandraschi/blender-mcp` 未逐文件解剖（前者 2025 停更，后者偏工程整合）；不计入主结论。
- `ifBars` 的 12 个 skill 未全量读完；已读 `asset-validation`、`modeling-workflow`、`rendering-workflow`、`iterative-refinement`、`art-direction-intake`、`benchmark` 六组。
- `jangtrinh` 的 `knowledge/` 体量很大（719 行单文件、161MB repo），已读 `product-viz-and-shots`、`native-render-delivery`、`native-agent-iteration`、`review-rubric`、`hard-rules`、`operating-rules`；未读全部 `docs/reviews/`。
- 第 7 节中标「推断」的阈值（≤120 objects、≤60 shards、0.5m 净空、≥90% ray、线宽 ≥4mm、纯白 >0.5% 画面）不是任何仓库原文，是按外部规则与我方失败形态合成的；上线前应在 bridge 上用 2–3 个真实场景校准。
- **并行改动冲突**：本报告读取基线后（15:38），工作树在 15:55 被并行会话修改了 `deploy-staging/opencode-runtime/skills/blender-director/SKILL.md:106` 与 `deploy-staging/opencode-runtime/lib/blender-tools-impl.ts`（新增 `quality` 参数）。这些改动不是本报告作者所做；缺口表已按「基线 / 并行修复后」双栏标注。若并行改动继续演进，以现场为准并重新核对第 4 节第 1 行与第 8 节 P0。

---

## 10. 引文索引（raw URL + 行号）

| 引文 | raw URL | 行 |
|---|---|---|
| EL4CTEO render presets | `https://raw.githubusercontent.com/EL4CTEO/blender-skills/71d031dab8bc/skills/blender-rendering/SKILL.md` | 20 |
| EL4CTEO quality levers | 同上 | 31-36 |
| EL4CTEO QA philosophy | `https://raw.githubusercontent.com/EL4CTEO/blender-skills/71d031dab8bc/skills/blender-asset-qa/SKILL.md` | 12、18 |
| EL4CTEO qa_check profiles | `https://raw.githubusercontent.com/EL4CTEO/blender-skills/71d031dab8bc/skills/blender-asset-qa/scripts/qa_check.py` | 25-32、350-351、55 |
| EL4CTEO PBR sanity | `https://raw.githubusercontent.com/EL4CTEO/blender-skills/71d031dab8bc/skills/blender-pbr-materials/references/pbr-values.md` | 42-47 |
| EL4CTEO camera rules | `https://raw.githubusercontent.com/EL4CTEO/blender-skills/71d031dab8bc/skills/blender-lighting-lookdev/SKILL.md` | 24、30-38 |
| ifBars staged gate | `https://raw.githubusercontent.com/ifBars/blender-agent-studio/6ff97fad06d0/plugins/blender-agent-studio/skills/blender-modeling-workflow/references/staged-quality-workflow.md` | 3-4、17-82 |
| ifBars quality gates | `https://raw.githubusercontent.com/ifBars/blender-agent-studio/6ff97fad06d0/plugins/blender-agent-studio/skills/blender-asset-validation/references/quality-gates.md` | 39-62 |
| ifBars whole scene | `https://raw.githubusercontent.com/ifBars/blender-agent-studio/6ff97fad06d0/docs/whole-scene-benchmark.md` | 3-13、29-35 |
| ifBars scene guidance | `https://raw.githubusercontent.com/ifBars/blender-agent-studio/6ff97fad06d0/docs/whole-scene-guidance.md` | 13-20 |
| ifBars scoring/caps | `https://raw.githubusercontent.com/ifBars/blender-agent-studio/6ff97fad06d0/plugins/blender-agent-studio/skills/blender-agent-benchmark/references/methodology.md` | 64-72、105-124 |
| ifBars evidence settings | `https://raw.githubusercontent.com/ifBars/blender-agent-studio/6ff97fad06d0/plugins/blender-agent-studio/skills/blender-asset-validation/scripts/evidence_settings.py` | 24-45 |
| ifBars render evidence | `https://raw.githubusercontent.com/ifBars/blender-agent-studio/6ff97fad06d0/plugins/blender-agent-studio/skills/blender-asset-validation/scripts/render_evidence.py` | 182-199、361-369 |
| ifBars iterative review | `https://raw.githubusercontent.com/ifBars/blender-agent-studio/6ff97fad06d0/plugins/blender-agent-studio/skills/blender-iterative-refinement/SKILL.md` | 26-35、81-92 |
| ifBars rendering gate | `https://raw.githubusercontent.com/ifBars/blender-agent-studio/6ff97fad06d0/plugins/blender-agent-studio/skills/blender-rendering-workflow/SKILL.md` | 98-100、190-203 |
| jangtrinh core loop | `https://raw.githubusercontent.com/jangtrinh/design-os-3d-blender/7d6bc7e268ee/.agents/skills/blender-agent-core/SKILL.md` | 36-44、61-72 |
| jangtrinh camera math | `https://raw.githubusercontent.com/jangtrinh/design-os-3d-blender/7d6bc7e268ee/knowledge/60-pipeline/product-viz-and-shots.md` | 41-44、198-212、580-601、651-660 |
| jangtrinh review rubric | `https://raw.githubusercontent.com/jangtrinh/design-os-3d-blender/7d6bc7e268ee/.agents/skills/blender-image-to-3d/references/review-rubric.md` | 21-29 |
| jangtrinh fail escalation | `https://raw.githubusercontent.com/jangtrinh/design-os-3d-blender/7d6bc7e268ee/.agents/rules/blender-agent-operating-rules.md` | 92-95 |
| jangtrinh license | `https://raw.githubusercontent.com/jangtrinh/design-os-3d-blender/7d6bc7e268ee/LICENSE` | 33-39 |
| arjun988 camera ref | `https://raw.githubusercontent.com/arjun988/blender-skills/8f778d2405a2/.claude/skills/camera-cinematography/references/lens-and-composition.md` | 3-10 |
| arjun988 light rig | `https://raw.githubusercontent.com/arjun988/blender-skills/8f778d2405a2/.claude/skills/lighting/references/cinematic-light-rigs.md` | 5-9、38-40 |
| arjun988 materials | `https://raw.githubusercontent.com/arjun988/blender-skills/8f778d2405a2/.claude/skills/materials/SKILL.md` | 48-61、70-78 |
| arjun988 qa review | `https://raw.githubusercontent.com/arjun988/blender-skills/8f778d2405a2/.claude/skills/qa-review/SKILL.md` | 55-62 |
| ProfRino assembly | `https://raw.githubusercontent.com/ProfRino/Blender-MCP-Assembly-Skill/afad3b1874c8/SKILL.md` | 21-22、34-38、137-141、176 |
| ahujasid look tool | `https://raw.githubusercontent.com/ahujasid/mcp-for-blender/5a3618fccb2d/README.md` | 654 |
| ahujasid scene guide | `https://raw.githubusercontent.com/ahujasid/mcp-for-blender/5a3618fccb2d/src/blender_mcp/guides/scene.md` | 15-16、44-59 |
| kevinbadi product polish | `https://raw.githubusercontent.com/kevinbadi/blender-skills/b2f0f816d320/product-polish/SKILL.md` | 36-40、51-52 |
| BlenderProc adaptive | `https://raw.githubusercontent.com/DLR-RM/BlenderProc/main/blenderproc/python/renderer/RendererUtility.py` | 150-163 |

---

## 11. 一句话交付

**照最严的那套做，蜘蛛侠战斗静帧不是「更细的碎片云」，而是：8 个声明资产族、≤120 个对象、≤60 片受控碎片、35mm 解算机位、0.5m 相机净空、512 spp + OIDN、7 视角证据页、独立评审逐特征全过。任何一项缺失，就按 ifBars 的封顶规则从 99 掉到 94/84/49，不允许用「整体看起来还行」补回来。**
