<!--
來源（輪子）: https://github.com/arjun988/blender-skills — .claude/skills/export-pipeline/SKILL.md
License: MIT · 原作者: arjun988 (https://github.com/arjun988)
白名單改動: ①輸出路徑→$BLENDER_WORK/out/ ②移除「## MCP Integration」節（外部 IDE 整合） ③Blender 5.2 API 校正（無） ④文案譯為簡體（結構/表格/參數逐項保留）
-->

---
name: export-pipeline
description: Blender 生产级导出到 FBX、GLTF、OBJ、USD 与 Alembic，含比例、轴心、旋转、法线、材质、动画与碰撞验证。
license: MIT
metadata:
  author: https://github.com/arjun988
  version: "1.0.0"
  domain: blender
  role: specialist
  triggers: export, FBX, GLTF, GLB, OBJ, USD, Alembic, Unity, Unreal, game engine import
  related-skills: asset-optimization, blender-modeler, materials
---

# 导出管线（Export Pipeline）

经过验证、引擎可用的导出。正确的比例、轴向、轴心与数据。

## 何时使用

- 最终资产交付
- 引擎导入准备
- 动画/绑定导出
- 模块化套件批量导出

## 导出前门禁

**硬性要求：** 资产优化验证 PASS 后才准导出。

## 工作流

```
验证 PASS → 导出设置 → 试导出 → 引擎验证
    → 修复问题 → 最终导出 → 文档
```

导出文件一律写 `$BLENDER_WORK/out/`。

## 格式选择

| 格式 | 最适合 |
|------|--------|
| FBX | Unreal、Unity（传统）、动画 |
| GLTF/GLB | Web、Godot、现代 Unity |
| OBJ | 静态网格交换（无绑定） |
| USD | 管线、VFX、多资产 |
| Alembic | VFX 缓存、雕刻动画 |

## FBX 设置（游戏默认）

```
Scale: 1.0
Apply Scalings: FBX All
Forward: -Z Forward
Up: Y Up
Apply Unit: ON
Mesh: ON
Armature: ON（有绑定时）
Bake Animation: ON（有动画时）
Path Mode: Copy（内嵌贴图）
```

## GLTF 设置

```
Format: GLB（单文件）或 GLTF Separate
Include: Selected Objects
Transform: +Y Up
Compression: Draco（引擎支持时）
```

## 导出验证矩阵

| 检查 | 方法 |
|------|------|
| 比例 | 在引擎里量已知尺寸 |
| 轴心 | 验证落地接触 / 握持点 |
| 前向轴 | 与引擎约定对比 |
| 法线 | 在引擎里看着色 |
| 材质 | 验证槽位数量与贴图 |
| 动画 | 在引擎里播动作 |
| 碰撞 | 单独导入 COL_ 网格 |

## 引擎专项注意

### Unreal Engine
- Scale 1.0 = UE 里 1cm（确认项目；可能需要 0.01 导出缩放）
- 导入法线与切线
- 碰撞网格单独导入
- 自动 LOD 命名：`SM_Asset_LOD0`

### Unity
- Scale 1.0 通常正确
- 现代管线偏好 GLTF
- 角色用 Humanoid 绑定映射

### Godot
- 偏好 GLTF/GLB
- 默认 +Y up

## 碰撞导出

```
1. 渲染网格与碰撞分开导出
2. 碰撞：简单凸包或盒体
3. 命名：SM_Asset_COL
4. 碰撞网格不带材质
5. 导出前应用变换
```

## 动画导出

- 每个导出文件单动作（或记录动作清单）
- 采样率：默认 30fps
- 导出前烘焙约束
- 骨架 + 蒙皮网格进同一文件
- 绑定不留未应用缩放

## 批量导出（模块化套件）

```
1. 选中 COL_Export 集合
2. 逐模块导出或按项目规格合并图集
3. 同类模块保持一致原点
4. README 记录网格吸附点
```

## 交付文档模板

```markdown
## 导出包: [资产名]

**格式:** FBX / GLTF
**比例:** 1 Blender 单位 = 1 米
**前向:** -Y / +X（记录实际值）
**文件:**
- SM_Asset.fbx
- T_Asset_BC.png, T_Asset_N.png, ...

**导入说明:**
- [引擎专项步骤]

**验证:** PASS — [日期]
```

## 约束

### 必须做
- 导出前过资产优化验证
- 导出物体应用变换
- 在目标引擎测试导入
- 记录比例与轴向约定
- 面向游戏时碰撞单独导出

### 禁止做
- 带未应用缩放导出
- 不经验证就导出
- 不留文档就把碰撞和渲染混进同一导出
- 假设默认 FBX 设置通吃所有引擎
- 不测引擎结果就把所有修改器全部导出

## 参考指南

| 主题 | 参考 | 何时加载 |
|------|------|----------|
| 引擎导入 | `references/engine-import.md` | 首次导入测试 |
| 验证 | `../references/validation-checklist.md` | 导出前门禁 |
