---
name: scene-assembly
description: Blender 大型场景布局，涵盖集合（Collection）组织、链接（Linking）、重载（Overrides）、利于流式加载的结构化组织与场景组装。
license: MIT
metadata:
  author: https://github.com/arjun988
  version: "1.0.0"
  domain: blender
  role: specialist
  triggers: scene assembly, layout, linking, library override, collection instance, level layout, set assembly, outliner organization
  related-skills: environment-artist, set-dressing, blender-modeler, lighting, qa-review
---
<!--
来源（轮子）: https://github.com/arjun988/blender-skills — .claude/skills/scene-assembly/SKILL.md
License: MIT · 原作者: arjun988 (https://github.com/arjun988)
白名单改动: ①产物路径→$BLENDER_WORK/out/ ②移除「via MCP」外部 IDE 整合表述 ③Blender 5.2 API 校正（无） ④文案译为简体（结构/表格/参数逐项保留）
-->


# 场景组装（Scene Assembly）

可扩展的布局。清晰的集合。大型场景用链接/重载。

## 何时使用

- 关卡、立体模型（diorama）、影视布景
- 把模块化套件组装成完整空间
- 库链接 / 集合实例（Collection Instance）
- 团队场景的大纲（Outliner）结构

## 工作流

```
灰色盒布局（greybox）→ 模块化组装 → 道具陈设（set dressing）
  → 灯光体（lighting volumes）→ 相机 → QA 检查 → 优化可见性
```

## 集合结构

```
COL_Layout
COL_Modular_Geo
COL_SetDressing
COL_Lights
COL_Cameras
COL_FX
COL_Collision
COL_Trash / COL_Ref
```

## 链接策略

| 方式 | 何时用 |
|------|--------|
| 集合实例（Collection instance） | 重复的模块化部件 |
| 库链接 + 重载（Library link + override） | 跨场景共享的核心资产 |
| 追加（Append） | 一次性的所有权转移 |

重复套件优先使用非破坏性的链接。

## 布局规则

1. 先做灰盒比例与导航（greybox）
2. 模块化套件吸附网格
3. 陈设期间隐藏重负载集合
4. 世界原点保持有意义（关卡零点）

## 性能卫生

- 重复网格用实例（instance）
- 剔除不可见的内部结构
- 面向游戏时拆分流式加载体（streaming volumes）
- 避免每个副本都带独立高开销材质

## 立面细节与碎片上限（摩尔纹硬闸，2026-10-22）

**立面/远景的重复细节一律用贴图或发光条，不用几千条细几何。** 交付分辨率下任何重复细件（格栅、砖缝、栏杆、网纹、瓦楞）的最小特征宽度须 ≥2px；达不到就改用带 mip 的贴图（anisotropy 4–8）或单面片发光条（emission strip），不要靠加几何硬堆。

| 项 | 上限 / 判准 | 复算 |
|---|---:|---|
| 单面立面的细节 mesh | ≤50 个 | 按立面集合过滤后计数；超了就换成 1 张 albedo + 1 张 normal/roughness |
| 同一类细件的资产族 | 1 个，未过 QA 禁止复制 | 见 `../qa-review/RECIPE.md` §1 ledger |
| 碎片/尘埃族 | ≤60 实例、≤20k tris、1 材质 | 按 `VFX_*` 前缀过滤计数 |
| 单片碎片投影 | ≥2px，否则剔除（不靠景深糊） | 相机投影 bbox 较短边 |
| 相机净空 | 0.5m 内零几何；视线 ≥90% 首命中主体 | 断言方法见 `../qa-review/RECIPE.md` §2 |

线宽换算：1080p、主体占画高 85% 时 1px ≈ 2mm；**线宽 <4mm 的几何必然摩尔纹**。阈值按采样定理与本轮实测换算（依据见仓库根 `docs/2026-10-22-blender-skill-symdiff.md` §7.4），上线前用 2–3 个真实场景校准。

## 交接

- 陈设 → `set-dressing`
- 氛围 → `lighting` + 风格配方
- 门禁 → `qa-review`

## 约束

### 必须做
- 尽早建立集合层级
- 最终陈设前先过灰盒
- 相机与灯光组命名规范

### 禁止做
- 把所有东西倒进 Scene Collection
- 滥用库重载（library override）
- 复制核心网格而不使用实例
- 立面重复细节用细几何硬堆（线宽 <4mm 必摩尔纹），或复制未过 QA 的资产族

## 参考指南

| 主题 | 参考 | 何时加载 |
|------|------|----------|
| 集合模板 | `references/collection-template.md` | 按需 |
| 链接与重载 | `references/linking-overrides.md` | 按需 |
