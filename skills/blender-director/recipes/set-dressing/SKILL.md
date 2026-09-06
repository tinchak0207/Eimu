<!--
來源（輪子）: https://github.com/arjun988/blender-skills — .claude/skills/set-dressing/SKILL.md
License: MIT · 原作者: arjun988 (https://github.com/arjun988)
白名單改動: ①產物路徑→$BLENDER_WORK/out/（本檔無輸出路徑） ②移除「via MCP」外部 IDE 整合表述 ③Blender 5.2 API 校正（無） ④文案譯為簡體（結構/表格/參數逐項保留）
-->

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
| 核心交互区 | 意图明确、噪声低 |
| 中景 | 支撑故事的簇群 |
| 背景 | 稀疏；只看剪影 |
| 行走路径 | 为玩家/相机留净空 |

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

## 参考指南

| 主题 | 参考 | 何时加载 |
|------|------|----------|
| 叙事簇 | `references/story-clusters.md` | 按需 |
| 密度图 | `references/density-map.md` | 按需 |
