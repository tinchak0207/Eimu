---
name: set-dressing
description: 面向室内外场景的陈设（Set Dressing）与环境叙事摆位，运用道具密度、叙事簇与可读性规则。
license: MIT
metadata:
  author: https://github.com/arjun988
  version: "1.0.0"
  domain: blender
  role: specialist
  triggers: set dressing, dressing, storytelling props, interior dressing, clutter, narrative placement, set decals
  related-skills: prop-artist, scene-assembly, environment-artist, horror-style, qa-review
---
<!--
来源（轮子）: https://github.com/arjun988/blender-skills — .claude/skills/set-dressing/SKILL.md
License: MIT · 原作者: arjun988 (https://github.com/arjun988)
白名单改动: ①产物路径→$BLENDER_WORK/out/（本档无输出路径） ②移除「via MCP」外部 IDE 整合表述 ③Blender 5.2 API 校正（无） ④文案译为简体（结构/表格/参数逐项保留）
-->


# 道具陈设（Set Dressing）

用摆位讲故事。克制的杂乱。可读的簇群。

## 何时使用

- 室内/外陈设阶段
- 叙事道具簇
- 避免空间过空或过满
- 模块化布局锁定之后

## 工作流

```
布局锁定 → 核心叙事道具 → 次级簇群
  → 背景填充 → 贴花/磨损 → 灯光检查 → QA
```

## 密度规则

| 区域 | 密度 |
|------|------|
| 核心交互区 | 意图明确、噪声低；每簇 3–7 件 |
| 中景 | 支撑故事的簇群；全场景簇数 ≤8 |
| 背景 | 稀疏；只看剪影；立面细节走贴图或发光条，不用细几何 |
| 行走路径 | 为玩家/相机留净空：相机 0.5m 内零几何 |

## 细节上限（摩尔纹硬闸，2026-10-22）

**立面/远景的重复细节必须用贴图或发光条，不用几千条细几何。** 交付分辨率下重复细件最小特征宽度 ≥2px；达不到改用带 mip 的贴图（anisotropy 4–8）或单面片发光条。

| 项 | 上限 / 判准 |
|---|---:|
| 陈设道具实例 | 计入 mesh 对象总预算 ≤120（不另开额度） |
| 同一陈设细件（栏杆/网/格栅/砖缝）的资产族 | 1 个，未过 QA 禁止复制 |
| 碎片/尘埃 | ≤60 实例、≤20k tris、1 材质；单片投影 <2px 直接剔除 |
| 相机净空 | 0.5m 内零几何；视线 ≥90% 首命中主体（方法见 `../qa-review/RECIPE.md` §2） |

线宽换算：1080p、主体占画高 85% 时 1px ≈ 2mm，**线宽 <4mm 的几何必然摩尔纹**（依据见仓库根 `docs/2026-10-22-blender-skill-symdiff.md` §7.4，上线前按真实场景校准）。

## 簇群方法

1. 选定一个叙事节点（吃了一半的饭、刚用过的工作台、仓皇逃离）
2. 摆放 3–7 件道具撑起该叙事
3. 加 1–2 处磨损/贴花线索
4. 停手——不要填满每个表面

## 道具来源

- 独特单品走 `prop-artist`（道具美术）
- 填充物用 kitbash / 模块化库
- 重复件用实例；旋转/缩放稍作变化

## 恐怖 / 稀疏风格

- 道具更少、语义更强
- 留白是有意为之
- 与恐怖风格配方协同（horror / psx-horror）

## 约束

### 必须做
- 灰盒导航可走通之后再陈设
- 保持玩家/相机路径畅通
- 重复网格用实例

### 禁止做
- 均匀的壁纸式杂乱
- 无叙事理由地堵死门窗
- 用细几何堆立面/背景重复细节，或把碎片铺满画面（>60 实例即违规）

## 参考指南

| 主题 | 参考 | 何时加载 |
|------|------|----------|
| 叙事簇 | `references/story-clusters.md` | 按需 |
| 密度图 | `references/density-map.md` | 按需 |
