---
name: animation
description: Blender 游戏级动画，涵盖走/跑/待机循环、战斗、机械动画、相机动画、约束、曲线编辑器（Graph Editor）与 NLA 工作流。
license: MIT
metadata:
  author: https://github.com/arjun988
  version: "1.0.0"
  domain: blender
  role: specialist
  triggers: animation, animate, walk cycle, run cycle, idle, combat, NLA, graph editor, keyframe
  related-skills: rigging, blender-modeler, export-pipeline
---
<!--
來源（輪子）: https://github.com/arjun988/blender-skills — .claude/skills/animation/SKILL.md
License: MIT · 原作者: arjun988 (https://github.com/arjun988)
白名單改動: ①產物路徑→$BLENDER_WORK/out/ ②移除「## MCP Integration」節（外部 IDE 整合） ③Blender 5.2 API 校正（無） ④文案譯為簡體（結構/表格/參數逐項保留）
-->


# 动画（Animation）

干净关键帧的游戏级运动。运动中剪影可读。引擎兼容导出。

## 何时使用

- 角色移动（走、跑、待机）
- 战斗动画
- 机械/道具动画
- 相机动画
- 带约束的物体动画

## 工作流

```
参考 → Blocking（摆块）→ Breakdown（中间帧）→ Splining（样条）→ Polish（打磨）
    → 循环验证 → NLA 条带 → 导出
```

## 移动循环

| 循环 | 关键姿态 | 帧数（30fps） |
|------|----------|--------------|
| 走 | 触地、下沉、过渡、抬起 × 2 | 24–32 |
| 跑 | 触地、驱动、腾空、恢复 | 16–24 |
| 待机 | 呼吸、重心转移、眨眼 | 60–120 循环 |

命名：`AN_[角色]_[动作]_[变体]`

## 动画原则（应用）

1. **节奏（Timing）** — 用间距表达重量
2. **弧线（Arcs）** — 肢体自然路径
3. **重叠（Overlap）** — 次级运动错帧
4. **预备（Anticipation）** — 先蓄力再动作
5. **夸张（Exaggeration）** — 视风格而定（见风格配方）

## 机械动画

- 用约束，不用骨骼形变
- 铰链：Limit Rotation 约束
- 活塞：Stretch-to 或 Copy Location
- 齿轮：Driver 同步旋转
- 门：空物体轴心 + 旋转关键帧

## 曲线编辑器工作流

```
1. 阶跃关键帧摆块（Constant 插值）
2. 样条化：Bezier + 自动手柄
3. 缓动：加权手柄表现加减速
4. 循环：复制首末帧；验证循环接缝
5. 清理：删除冗余关键帧
```

## 游戏导出的 NLA

```
1. 动作（Action）创建并按规范命名
2. 下推为 NLA 条带（strip）
3. 循环条带设为 Repeat
4. 导出时仅单条带激活
5. 缩放 1.0；除非有意否则不做 NLA 时间重映射
```

## 相机动画

- 平滑的 Bezier 插值
- 避免突然的方向变化
- 焦距匹配主体比例
- 相机抖动：位移加噪声修改器（微妙）

## 游戏级要求

- [ ] 根运动（root motion）决策已记录（原地 vs 位移）
- [ ] 循环接缝不可见（走/待机/跑）
- [ ] 骨骼无缩放关键帧（引擎会出问题）
- [ ] 动画长度匹配引擎状态机
- [ ] 表情动画需要时放独立动作层
- [ ] 帧率：默认 30fps（确认项目规格）

## 约束

### 必须做
- 移动类动作参考实拍视频
- 样条化前先阶跃摆块
- 动作命名 `AN_` 前缀
- 导出前测试循环
- 动画风格匹配美术方向

### 禁止做
- 有机运动用线性插值
- 绑定骨骼打缩放关键帧
- 待机动画过度设计（微妙更好）
- 未推入 NLA 就导出
- 跳过根运动文档

## 参考指南

| 主题 | 参考 | 何时加载 |
|------|------|----------|
| 走循环拆解 | `references/walk-cycle.md` | 移动 |
| 战斗节奏 | `references/combat-animation.md` | 动作戏 |
