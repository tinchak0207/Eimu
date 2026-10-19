---
name: rigging
description: Blender 生产级绑定，涵盖骨架（armature）、IK/FK、约束、权重绘制、机械绑定、面部绑定与驱动器（driver）。在形变资产做动画之前使用。
license: MIT
metadata:
  author: https://github.com/arjun988
  version: "1.0.0"
  domain: blender
  role: specialist
  triggers: rig, rigging, armature, bone, IK, FK, weight paint, constraint, facial rig, driver
  related-skills: animation, character-artist, blender-modeler
---
<!--
来源（轮子）: https://github.com/arjun988/blender-skills — .claude/skills/rigging/SKILL.md
License: MIT · 原作者: arjun988 (https://github.com/arjun988)
白名单改动: ①产物路径→$BLENDER_WORK/out/ ②移除「## MCP Integration」节（外部 IDE 整合） ③Blender 5.2 API 校正（无） ④文案译为简体（结构/表格/参数逐项保留）
-->


# 绑定（Rigging）

支撑目标运动的可用绑定。干净的形变。引擎兼容的骨骼层级。

## 何时使用

- 角色/生物形变绑定
- 机械约束绑定
- 面部表情绑定
- 道具绑定（门、载具、武器）
- 一切动画工作之前

## 工作流

```
骨架设计 → 骨骼摆放 → 层级 → 约束/IK
    → 权重绘制 → 形变测试 → 导出准备
```

## 骨架命名

前缀：`ARM_[资产名]`
骨骼：`[侧]_[区域]_[名]` — 如 `L_arm_upper`、`spine_01`、`jaw`

## 骨骼层级

```
ARM_Character
├── root
├── spine_01 → spine_02 → spine_03
│   ├── L_clavicle → L_arm_upper → L_arm_lower → L_hand
│   └── R_clavicle → R_arm_upper → R_arm_lower → R_hand
├── L_leg_upper → L_leg_lower → L_foot → L_toe
└── R_leg_upper → R_leg_lower → R_foot → R_toe
```

## IK vs FK

| 用 IK | 用 FK |
|-------|-------|
| 腿（接触地面） | 脊柱（柔性弧线） |
| 手臂（手部定点） | 肩部跟随 |
| 脚步落地 | 手指细节 |
| 机械伸缩 | 鞭子/尾巴 |

标准：腿用 IK、脊柱用 FK；游戏角色手臂做可切换。

## 约束

| 约束 | 用途 |
|------|------|
| IK | 肢体定位 |
| Copy Rotation | 机械同步 |
| Limit Rotation | 关节范围 |
| Stretch To | 触手、活塞 |
| Child Of | 武器挂接/卸下 |
| Shrinkwrap | 地面贴合（慎用） |

## 权重绘制

```
1. 自动权重只作起点
2. 清理权重：逐顶点归一化（最多 4 影响骨）
3. 平滑问题区域（肩、髋）
4. 测试极限姿态：T-pose、举臂、下蹲、张嘴
5. 关节处权重渐变——弯曲中心禁止硬 1.0/0.0
```

## 机械绑定

- 空物体当控制手柄
- 用约束，不用权重绘制
- 铰链限位匹配真实关节范围
- 父级层级镜像机械装配关系

## 面部绑定

| 方案 | 适用 |
|------|------|
| 骨骼驱动 | 游戏角色 |
| 形态键（shape keys） | 影视、对白 |
| 混合 | 主角级游戏角色 |

游戏面部最低配：张嘴、左右眨眼、眉毛上下。

## 驱动器（Drivers）

- 齿轮旋转同步
- 自动眨眼
- 武器上膛机构
- 程序化天线/电线运动

## 形变测试姿态

- T-pose / A-pose（绑定姿态）
- 手臂完全举高
- 深蹲
- 颈部旋转极限
- 嘴张最大（角色）

## 约束

### 必须做
- 重拓扑完成后才绑定
- 骨骼命名一致
- 每顶点影响骨限 4 个（游戏引擎）
- 动画前测试极限形变
- 为动画师记录控制方案

### 禁止做
- 主角资产自动权重不清理
- 绑定姿态缩放骨骼
- 拓扑未验证就绑定
- 四肢跳过 IK 极向目标（pole target）
- 多根骨骼混用不留文档

## 参考指南

| 主题 | 参考 | 何时加载 |
|------|------|----------|
| 人形绑定 | `references/humanoid-rig.md` | 角色 |
| 机械绑定 | `references/mechanical-rig.md` | 道具、载具 |
