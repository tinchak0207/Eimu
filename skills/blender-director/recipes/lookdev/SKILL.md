<!--
來源（輪子）: https://github.com/arjun988/blender-skills — .claude/skills/lookdev/SKILL.md
License: MIT · 原作者: arjun988 (https://github.com/arjun988)
白名單改動: ①產物路徑→$BLENDER_WORK/out/（截圖/渲染產物一律寫 $BLENDER_WORK/out/） ②移除「via MCP」外部 IDE 整合表述 ③Blender 5.2 API 校正（無） ④文案譯為簡體（結構/表格/參數逐項保留）
-->

---
name: lookdev
description: Blender 资产外观开发（Lookdev）循环，组合材质、灯光、相机与截图对比，直到着色效果达标。
license: MIT
metadata:
  author: https://github.com/arjun988
  version: "1.0.0"
  domain: blender
  role: specialist
  triggers: lookdev, look development, shading review, material lighting loop, turntable, asset presentation
  related-skills: materials, lighting, rendering, camera-cinematography, compositing, qa-review
---

# 外观开发（Lookdev）

材质 + 灯光 + 相机循环。截图对比。读得对了就停。

## 何时使用

- 导出/作品集前的资产着色定稿
- 转台 / 灰模着色检查
- 匹配材质参考
- 有意衔接材质与灯光两个环节

## 工作流

```
黏土/灰模 → 基础材质 → 中性灯架
  → 成片灯 → 截图 → 差距清单 → 迭代（≤3–5 轮）
  → 可选调色 → QA
```

每轮截图/渲染产物写入 `$BLENDER_WORK/out/`。

## 标准灯架

| 灯架 | 用途 |
|------|------|
| 中性三点光 | 公平评估材质 |
| HDRI 棚拍 | 产品 / 角色 |
| 场景现场灯 | 最终语境 |

保留可复用的 `COL_Lookdev_Lights` + `CAM_Lookdev_*`。

## 清单

- [ ] 灰度下明度关系成立
- [ ] 高光粗糙度可信
- [ ] 边缘受光（倒角/法线）
- [ ] 自发光受控
- [ ] 无纯黑/纯白陷阱（风格化除外）
- [ ] 有参考时匹配参考色板

## 迭代规则

每轮只改一个主要变量（材质 OR 灯光 OR 相机），然后截图。

## 约束

### 必须做
- 形体拿不准时先灰模再花哨贴图
- 每轮迭代截图存档
- 交付前过 `qa-review`

### 禁止做
- 只靠粗糙度贴图救建模问题
- 没有差距清单的无限微调循环

## 参考指南

| 主题 | 参考 | 何时加载 |
|------|------|----------|
| Lookdev 灯架 | `references/lookdev-rig.md` | 按需 |
| Lookdev 清单 | `references/lookdev-checklist.md` | 按需 |
