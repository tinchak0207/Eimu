---
name: lighting
description: Blender 电影感与游戏灯光，涵盖三点布光、HDRI、恐怖光效、体积光、轮廓光与情绪驱动照明。用于 lookdev 与场景氛围。
license: MIT
metadata:
  author: https://github.com/arjun988
  version: "1.0.0"
  domain: blender
  role: specialist
  triggers: lighting, light, HDRI, three point, rim light, volumetric, fog, mood, cinematic, horror lighting
  related-skills: rendering, materials, realistic-style, horror-style
---
<!--
來源（輪子）: https://github.com/arjun988/blender-skills — .claude/skills/lighting/SKILL.md
License: MIT · 原作者: arjun988 (https://github.com/arjun988)
白名單改動: ①產物路徑→$BLENDER_WORK/out/ ②移除「via MCP」外部 IDE 整合表述（刪「## MCP Integration」節） ③Blender 5.2 API 校正（無） ④文案譯為簡體（結構/表格/參數逐項保留）
-->


# 灯光（Lighting）

情绪驱动的照明。引导观众视线。支撑美术方向。

## 何时使用

- 场景 lookdev
- 电影渲染与作品集镜头
- 恐怖氛围搭建
- 游戏灯光 blockout（烘焙或动态）
- HDRI 环境设置

## 工作流

```
美术方向 → 主光（Key）→ 辅光/轮廓光 → 点缀光 → 环境
    → 体积光 → 调色准备 → 验证渲染
```

## 三点布光

| 灯 | 用途 | 典型设置 |
|----|------|----------|
| 主光 Key | 主照明 | 仰角 45°、侧位 30° |
| 辅光 Fill | 柔化阴影 | 主光对面，1/2–1/4 强度 |
| 轮廓光 Rim | 主体分离 | 主体背后，亮边 |

命名：`LGT_Key_Main`、`LGT_Fill_Soft`、`LGT_Rim_Back`

## 灯光类型

| 类型 | 适用 |
|------|------|
| 太阳 Sun | 户外方向光 |
| 面光 Area | 柔光棚拍、窗户 |
| 聚光 Spot | 手电、舞台、恐怖 |
| 点光 Point | 灯泡、自发光填充 |

## 色温

| 情绪 | 开尔文 | RGB 近似 |
|------|--------|----------|
| 烛光/暖 | 1800K | 橙 |
| 钨丝灯 | 3200K | 暖白 |
| 日光 | 5500K | 中性白 |
| 阴天 | 6500K | 冷白 |
| 月光 | 8000K+ | 蓝 |

恐怖片：室内暖钨丝与室外冷月光混用。

## HDRI 工作流

```
1. 选匹配情绪的 HDRI（恐怖用阴天，主角用晴朗）
2. 旋转使最亮区域充当主光
3. 调强度（通常 0.5–2.0）
4. 用面光补主体分离
5. 若用纯色/雾背景，隐藏 HDRI 背景显示
```

## 恐怖布光

详见恐怖风格配方。关键技法：
- 高对比；深阴影
- 单一光源动机（画面内一盏可见灯）
- 强度加噪声修改器做闪烁（flicker）
- 体积雾做光柱
- 避免平淡均匀照明

## 体积光

```
世界着色器 → Volume Scatter
灯光 → 开启 Volume 贡献
密度：0.01–0.1（从微妙到浓雾）
各向异性：0.3–0.8 产生可见光柱
```

## 游戏 vs 电影

| 维度 | 游戏 | 电影 |
|------|------|------|
| 灯数量 | 最少（性能） | 不限 |
| 烘焙 | 常用光照贴图 | 路径追踪 |
| 动态 | 实时阴影 | 光线追踪 |
| 情绪 | 玩法可读性优先 | 艺术自由 |

## 约束

### 必须做
- 每盏灯有动机（可见灯具或合理光源）
- 灯光命名 `LGT_[角色]_[描述]`
- 测试玩法关键区域的可读性
- 灯光匹配风格配方（恐怖、写实等）
- 灯光集合与几何体分开

### 禁止做
- 无方向感的平面环境光
- 恐怖场景过度打光
- 忽视色温一致性
- 无目的地放置灯
- 情绪场景跳过体积光考量

## 参考指南

| 主题 | 参考 | 何时加载 |
|------|------|----------|
| 恐怖布光 | `references/horror-lighting-setups.md` | 恐怖场景 |
| 电影灯架 | `references/cinematic-light-rigs.md` | 作品集渲染 |
