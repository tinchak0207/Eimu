---
name: rendering
description: Blender 渲染，涵盖 Cycles 与 Eevee 的采样、降噪、相机设置、渲染通道、色彩管理与渲染优化。用于最终输出与外观验证。
license: MIT
metadata:
  author: https://github.com/arjun988
  version: "1.0.0"
  domain: blender
  role: specialist
  triggers: render, Cycles, Eevee, sampling, denoise, camera, render pass, color management, output
  related-skills: lighting, materials, realistic-style, stylized-style
---
<!--
来源（轮子）: https://github.com/arjun988/blender-skills — .claude/skills/rendering/SKILL.md
License: MIT · 原作者: arjun988 (https://github.com/arjun988)
白名单改动: ①输出路径→$BLENDER_WORK/out/ ②移除「via MCP」与「## MCP Integration」节（外部 IDE 整合）
③Blender 5.2 API 校正两处（原文以「上游原文」注释保留，仅 API 名/术语变更，逻辑不动） ④文案译为简体
-->


# 渲染（Rendering）

正确的引擎选择。优化的设置。生产级渲染通道。

## 何时使用

- 最终作品集/影视渲染
- Lookdev 验证
- 合成用渲染通道输出
- 游戏资产预览渲染（转台）
- 风格验证（写实 vs 风格化）

## 引擎选择

| 引擎 | 适用 |
|------|------|
| Cycles | 最终品质、写实、作品集 |
| Eevee | 实时预览、风格化、游戏 lookdev |

<!-- 上游原文: "| Eevee Next | Improved real-time quality (Blender 4+) |"
③Blender 5.2 校正：4.2 起 Eevee Next 已合并为唯一的 Eevee，5.x 无独立「Eevee Next」条目，删除该行 -->

## 数值 preset（preview / delivery）

两档写死，**禁止用 preview 参数交 delivery 成品**。采样值来源：EL4CTEO/blender-skills（MIT）`render_batch.py` 的 preview/final 两档；adaptive 0.01/0.05 与降噪口播同出该库 `blender-rendering/SKILL.md`。

| 参数 | preview（previz/构图验证） | delivery（成品静帧） |
|---|---|---|
| 引擎 | Eevee | Eevee，或需要真实反射/折射/体积时 Cycles |
| Eevee `taa_render_samples` | 16 | 128 |
| Eevee `use_raytracing` | False | True |
| Eevee 阴影 | 关 | 开（`use_shadows=True`） |
| AO / 接触阴影 | 关 | 开（5.2 走 raytracing/Fast GI；`use_gtao` 在 4.2+ 已移除，勿调） |
| Cycles `samples` | 64 | 512 |
| Cycles `adaptive_threshold` | 0.05 | 0.01 |
| Cycles 降噪 | `use_denoising=True` | True，OIDN + `denoising_input_passes="RGB_ALBEDO_NORMAL"` |
| Cycles 弹射 | 默认 | 总 12 / glossy 4 / transmission 8–12；`sample_clamp_indirect=5`；`use_light_tree=True` |
| `resolution_percentage` | 50 | 100 |
| 分辨率 | 960×540 | 交付规格（1920×1080 或 2048×1152） |
| View Transform | AgX | AgX |
| Look | `AgX - Medium High Contrast` | `AgX - Medium High Contrast`（软调 `AgX - Base Contrast`） |
| Exposure | 0 | 0（诊断可 -1.0） |

bridge 落地：Eevee delivery 传 `quality:"final"` + `samples:128`，回执必须 `render_quality.degraded=false` 且 `effective.samples_actual ≥128`（降级链掉档 = 桥内崩过，改走 Cycles 或拆场景重渲）。**preview 的 16 spp / RT off 要写进 `.blend` 场景值**；`blender_render` 的 `quality:"preview"` 只是不强提档，不会自动改成 16。Cycles 采样无法经 `blender_render` 参数传入，必须在 `blender_exec` 里把 `scene.cycles.*` 设进 `.blend` 再存盘，然后 `render_engine:"cycles"` 渲染。turntable / 多帧动画不受本表提档，仍走 1spp + RT off 存活预设。

## 工作流

```
相机设置 → 渲染设置 → 采样测试 → 全量渲染
    → 通道输出 → 色彩管理 → 交付
```

## 相机设置

命名：`CAM_[Shot]_[Number]`
- 焦距：35mm（环境）、85mm（主角特写）、24mm（广角恐怖）
- 景深：对焦到主体距离
- 构图：三分法；引导线
- 转台：空物体父级旋转 360° 做资产预览

## Cycles 设置

| 设置 | 预览 | 生产 |
|------|------|------|
| 采样 | 64–128 | 512–2048 |
| 降噪 | OpenImageDenoise | OpenImageDenoise |
| 最大弹射 | 8 | 12 |
| 焦散 | 关（默认） | 玻璃/水体主角时开 |

## Eevee 设置

| 设置 | 值 |
|------|-----|
| 渲染采样 `taa_render_samples` | preview 16 / delivery 128 |
| 光线追踪 `use_raytracing` | preview 关 / delivery 开 |
| 屏幕空间反射 | 金属材质开（属 raytracing 档） |
| 环境光遮蔽 | 开（5.2 走 raytracing/Fast GI，无 `use_gtao`） |
| 泛光（Bloom） | 风格化/自发光场景 |
| 阴影分辨率 | 2048+ |
| 接触阴影 | 地面接触 |

## 渲染通道

| 通道 | 用途 |
|------|------|
| Combined | 最终合成 |
| Diffuse Direct/Indirect | 重打光 |
| Glossy | 反射控制 |
| Normal | 合成特效 |
| AO | 接触阴影增强 |
| Z（深度） | 合成中的景深、雾 |
| Cryptomatte | 物体遮罩 |
| Emission | 屏幕辉光特效 |

## 色彩管理

```
<!-- 上游原文: "View Transform: AgX (Blender 4+) or Filmic"
③Blender 5.2 校正：Blender 4.0 起移除 Filmic，AgX 为默认 view transform；5.x 仅 AgX / Standard。 -->
View Transform: AgX（Blender 4.0+ 默认；Filmic 已移除）
Look: AgX - Medium High Contrast（交付默认）；软调 AgX - Base Contrast；风格化 AgX - Punchy
曝光：在合成器里调，不靠灯硬轰
```

**5.2 Look 合法性（必读）**：OCIO 配置里**没有** `Medium Contrast` / `High Contrast` 这两个裸名，也没有 `AgX - Medium Contrast`；写错会抛 `TypeError`，异常被吞后等于没设 look。设置时按下面兜底，并以本机 OCIO enum 实际值为准：

```python
for look in ("AgX - Medium High Contrast", "AgX - Base Contrast", "AgX - Punchy", "None"):
    try:
        scene.view_settings.look = look
        break
    except TypeError:
        continue
```

## 渲染优化

- 用渲染区域（render region）做测试裁切
- 自适应采样（Cycles）
- 渲染层关闭不可见物体
- 有 GPU 时默认 GPU 渲染
- 动画序列开启 Persistent data

## 资产转台模板

```
1. CAM_Turntable 放 3/4 高度、45° 角
2. 资产原点放空物体 → 旋转动画 0–360°（120 帧）
3. 三点布光灯架
4. 渲染 1280×1280 或项目指定分辨率
5. 输出 PNG 序列或 MP4，写入 $BLENDER_WORK/out/
```

## 参考图验证

匹配照片/概念图时（`../references/reference-image-match.md`）：

| 设置 | 参考匹配 |
|------|----------|
| 主角相机 | 调色前先对齐参考角度 |
| AgX Look | 默认 `AgX - Medium High Contrast`；参考图更冲用 `AgX - Punchy`；平光用 `AgX - Base Contrast`（裸名 `Medium Contrast` 在 5.2 非法） |
| 曝光 | 常见 0.15–0.45；外壳要读得出，不要爆白 |
| 预览回放 | EEVEE，关运动模糊，`taa_samples` 1–8 |
| 最终静帧 | 用主角 `CAM_*` 渲染 — 与参考对比 |
| 对比工具 | 视口截图或 bpy 渲染静帧（产物写 `$BLENDER_WORK/out/`） |

交付前跑 `../references/visual-match-checklist.md`。

## 约束

### 必须做
- 渲染引擎匹配项目风格
- 提供参考图时必须**截图或渲染对比**
- Cycles 生产渲染用降噪
- 最终渲染前设好色彩管理
- 主角资产渲染验证转台
- 相机归入 `COL_Cameras`

### 禁止做
- 采样没测试就上生产渲染
- 忽视色彩管理（sRGB vs Linear）
- 无目的地超分辨率渲染
- 计划合成却跳过渲染通道
- 实时游戏预览用 Cycles

## 参考指南

| 主题 | 参考 | 何时加载 |
|------|------|----------|
| 通道合成 | `references/render-passes.md` | 多通道输出 |
| NPR/风格化渲染 | `references/npr-rendering.md` | 风格化项目 |
| 参考图匹配 | `../references/reference-image-match.md` | 附照片/概念图 |
| 视觉匹配验证 | `../references/visual-match-checklist.md` | 交付前 |
