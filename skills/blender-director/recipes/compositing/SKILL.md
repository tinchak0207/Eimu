<!--
來源（輪子）: https://github.com/arjun988/blender-skills — .claude/skills/compositing/SKILL.md
License: MIT · 原作者: arjun988 (https://github.com/arjun988)
白名單改動: ①輸出路徑→$BLENDER_WORK/out/ ②移除「via MCP」外部 IDE 整合表述 ③Blender 5.2 API 校正（無） ④文案譯為簡體（結構/表格/參數逐項保留）
-->

---
name: compositing
description: Blender 合成器工作流，涵盖美板堆叠（beauty stack）、渲染通道、调色、辉光与交付输出。
license: MIT
metadata:
  author: https://github.com/arjun988
  version: "1.0.0"
  domain: blender
  role: specialist
  triggers: compositor, compositing, grade, beauty pass, render passes, cryptomatte, glare, vignette, color correction, post
  related-skills: rendering, lighting, lookdev, camera-cinematography, vfx-fx
---

# 合成（Compositing）

通道感知的美板堆叠。克制的调色。可交付的输出。

## 何时使用

- Cycles/Eevee 的最终美板合成
- 调色、辉光、暗角、微色差
- 通道重组（diffuse、glossy、volume、cryptomatte）
- 镜头交付底片

## 工作流

```
启用通道 → 渲染多层 EXR（或所需通道）
  → 合成节点图 → 调色 → 特效（glare/fog glow）
  → Output viewer + File Output → 验证曝光
```

File Output 产物一律写 `$BLENDER_WORK/out/`。

## 推荐通道

| 通道 | 用途 |
|------|------|
| Beauty / Combined | 底板 |
| DiffCol / DiffDir / DiffInd | 重打光弹性 |
| GlossDir / GlossCol | 高光控制 |
| Volume | 烟雾/火焰分离 |
| Cryptomatte Object/Material | 隔离遮罩 |
| Mist | 深度调色 / 雾 |

## 美板堆叠（默认）

```
Combined
  → Exposure / Color Balance（AgX 感知）
  → Glare（fog glow / 条纹光斑，克制）
  → 镜头畸变（微妙）
  → 暗角（微妙）
  → Output
```

## 调色规则

1. 先修曝光再谈创意调色
2. 偏好 lift/gamma/gain 或 Color Balance，不硬拉曲线压黑
3. 皮肤/产品色相保持可信
4. 与参考静帧并排对比匹配

## 输出

- `OUT_Beauty_[Shot]`
- 可选：`OUT_Alpha`、`OUT_CryptoID`
- 归档首选 EXR；审阅用 PNG/JPEG
- 所有输出文件写 `$BLENDER_WORK/out/`

## 约束

### 必须做
- 在感知 view transform 的管线（AgX）上调色
- 创意特效在节点图中保持可逆
- 记录曝光/外观设置

### 禁止做
- 压黑掩盖灯光问题
- 每个亮像素都糊辉光
- 把多层 EXR 压成 JPEG 当唯一归档

## 参考指南

| 主题 | 参考 | 何时加载 |
|------|------|----------|
| 通道堆叠 | `references/pass-stack.md` | 按需 |
| 调色预设 | `references/grade-presets.md` | 按需 |
| 交付输出 | `references/delivery-outputs.md` | 按需 |
