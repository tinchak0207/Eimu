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
來源（輪子）: https://github.com/arjun988/blender-skills — .claude/skills/scene-assembly/SKILL.md
License: MIT · 原作者: arjun988 (https://github.com/arjun988)
白名單改動: ①產物路徑→$BLENDER_WORK/out/ ②移除「via MCP」外部 IDE 整合表述 ③Blender 5.2 API 校正（無） ④文案譯為簡體（結構/表格/參數逐項保留）
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

## 参考指南

| 主题 | 参考 | 何时加载 |
|------|------|----------|
| 集合模板 | `references/collection-template.md` | 按需 |
| 链接与重载 | `references/linking-overrides.md` | 按需 |
