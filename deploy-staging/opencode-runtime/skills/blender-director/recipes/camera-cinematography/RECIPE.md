---
name: camera-cinematography
description: Blender 电影感镜头工作，涵盖取景、镜头、构图、相机动画与镜头语言，超越基础渲染设置。
license: MIT
metadata:
  author: https://github.com/arjun988
  version: "1.0.0"
  domain: blender
  role: specialist
  triggers: camera, cinematography, lens, framing, composition, shot, dolly, orbit, focal length, depth of field, camera animation
  related-skills: rendering, lighting, animation, compositing, lookdev
---
<!--
來源（輪子）: https://github.com/arjun988/blender-skills — .claude/skills/camera-cinematography/SKILL.md
License: MIT · 原作者: arjun988 (https://github.com/arjun988)
白名單改動: ①產物路徑→$BLENDER_WORK/out/ ②移除「via MCP」外部 IDE 整合表述 ③Blender 5.2 API 校正（無） ④文案譯為簡體（結構/表格/參數逐項保留）
-->


# 相机电影摄影（Camera Cinematography）

有意图的取景。镜头语言。有动机的运镜。随时可拍的相机。

## 何时使用

- 有目的的电影静帧与转台（turntable）
- 动画运镜（dolly 推轨、crane 摇臂、orbit 环绕、handheld 手持）
- 匹配参考图的相机/镜头质感
- lookdev 与作品集的镜头布局

## 工作流

```
镜头意图 → 相机 + 目标空物体 → 焦距/FOV → 构图
  → 焦点/景深 → 运镜（如需动画）→ 视口检查 → 渲染/合成
```

## 命名

- `CAM_[Shot]_[Angle]`
- `EMPTY_CamTarget_[Shot]`
- 集合：`COL_Cameras`

## 焦距指南

| 质感 | 焦距（全画幅等效） | 备注 |
|------|------------------|------|
| 广角定场 | 18–28mm | 有畸变；注意边缘 |
| 叙事 / 产品 | 35–50mm | 自然 |
| 肖像 / 主角 | 85–135mm | 空间压缩 |
| 长焦戏剧 | 150mm+ | 空间扁平 |

传感器适配（sensor fit）与分辨率影响 FOV——有意地设置相机传感器。

## 构图清单

- [ ] 主体剪影可读
- [ ] 头顶空间 / 视线留白是有意的
- [ ] 地平线水平（除非有动机）
- [ ] 前景 / 中景 / 背景层次
- [ ] 避免边缘相切重合（tangent mergers）

## 相机动画

| 运镜 | 用途 |
|------|------|
| 环绕（Orbit） | 产品 / 角色展示 |
| 推进（Dolly in） | 揭示 / 张力 |
| 摇臂（Crane） | 规模感 / 定场 |
| 手持噪声 | 纪录片 / 恐怖不安感 |
| 固定机位 | 建筑可视化 / 产品纯净感 |

对相机与目标空物体做动画；偏好缓慢的缓入缓出。

## 景深（DoF）

- 对焦到主体空物体
- 光圈值定风格：主角浅景深，环境深景深
- Eevee 预览；需要时 Cycles 出最终

## 约束

### 必须做
- 相机与目标命名规范
- 画幅比匹配交付规格
- 运镜的起点、中点、终点都检查构图

### 禁止做
- 每个镜头都无脑默认 50mm
- 无动机地狂摆 FOV 动画
- 把关键剪影裁出画面

## 参考指南

| 主题 | 参考 | 何时加载 |
|------|------|----------|
| 焦距与构图 | `references/lens-and-composition.md` | 按需 |
| 运镜库 | `references/camera-move-library.md` | 按需 |
| 景深指南 | `references/dof-guide.md` | 按需 |
