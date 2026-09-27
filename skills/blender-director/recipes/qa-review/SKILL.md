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
來源（輪子）: https://github.com/arjun988/blender-skills — .claude/skills/qa-review/SKILL.md
License: MIT · 原作者: arjun988 (https://github.com/arjun988)
白名單改動: ①產物路徑→$BLENDER_WORK/out/（截圖存檔寫 $BLENDER_WORK/out/） ②移除「via MCP」外部 IDE 整合表述 ③Blender 5.2 API 校正（無） ④文案譯為簡體（結構/表格/參數逐項保留）
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

## 必备截图

1. 3/4 主角角度
2. 比例关键时上正交/侧视
3. 线框或面数概览（可选但有用）
4. 材质/灯光成片
5. 与参考对比（有参考图的任务）

## 清单（按需加载）

- `../references/validation-checklist.md`
- `../references/visual-match-checklist.md`（参考图任务）
- `../references/naming-conventions.md`
- `../references/polycount-budgets.md`

## 缺陷分级

| 级别 | 含义 |
|------|------|
| Blocker | 比例错误、法线损坏、严重超预算 |
| Major | 剪影/可读性问题、轴心错误 |
| Minor | 命名、轻微着色、小缝隙 |
| Note | 可选打磨 |

## 裁决模板

```markdown
## QA 裁决: [资产]

**结果:** SHIP / SHIP WITH NOTES / NO-SHIP
**预算:** [三角面/贴图] vs 目标
**截图:** [清单]
**Blocker:** ...
**Major:** ...
**Minor:** ...
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
