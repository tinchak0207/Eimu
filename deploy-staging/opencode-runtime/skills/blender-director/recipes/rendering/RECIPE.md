---
name: rendering
description: Blender 渲染，涵盖 Cycles 与 Eevee 的采样、降噪、相机设置、渲染通道、色彩管理与渲染优化。用于最终输出与外观验证。
license: MIT
metadata:
  author: https://github.com/arjun988
  version: "1.0.0"
  domain: blender
  role: specialist
  triggers: render, Cycles, Eevee, sampling, denoise, camera, render pass, color management, output
  related-skills: lighting, materials, realistic-style, stylized-style
---
<!--
來源（輪子）: https://github.com/arjun988/blender-skills — .claude/skills/rendering/SKILL.md
License: MIT · 原作者: arjun988 (https://github.com/arjun988)
白名單改動: ①輸出路徑→$BLENDER_WORK/out/ ②移除「via MCP」與「## MCP Integration」節（外部 IDE 整合）
③Blender 5.2 API 校正兩處（原文以「上游原文」註釋保留，僅 API 名/術語變更，邏輯不動） ④文案譯為簡體
-->


# 渲染（Rendering）

正确的引擎选择。优化的设置。生产级渲染通道。

## 何时使用

- 最终作品集/影视渲染
- Lookdev 验证
- 合成用渲染通道输出
- 游戏资产预览渲染（转台）
- 风格验证（写实 vs 风格化）

## 引擎选择

| 引擎 | 适用 |
|------|------|
| Cycles | 最终品质、写实、作品集 |
| Eevee | 实时预览、风格化、游戏 lookdev |

<!-- 上游原文: "| Eevee Next | Improved real-time quality (Blender 4+) |"
③Blender 5.2 校正：4.2 起 Eevee Next 已合併為唯一的 Eevee，5.x 無獨立「Eevee Next」條目，刪除該行 -->

## 工作流

```
相机设置 → 渲染设置 → 采样测试 → 全量渲染
    → 通道输出 → 色彩管理 → 交付
```

## 相机设置

命名：`CAM_[Shot]_[Number]`
- 焦距：35mm（环境）、85mm（主角特写）、24mm（广角恐怖）
- 景深：对焦到主体距离
- 构图：三分法；引导线
- 转台：空物体父级旋转 360° 做资产预览

## Cycles 设置

| 设置 | 预览 | 生产 |
|------|------|------|
| 采样 | 64–128 | 512–2048 |
| 降噪 | OpenImageDenoise | OpenImageDenoise |
| 最大弹射 | 8 | 12 |
| 焦散 | 关（默认） | 玻璃/水体主角时开 |

## Eevee 设置

| 设置 | 值 |
|------|-----|
| 屏幕空间反射 | 金属材质开 |
| 环境光遮蔽 | 开 |
| 泛光（Bloom） | 风格化/自发光场景 |
| 阴影分辨率 | 2048+ |
| 接触阴影 | 地面接触 |

## 渲染通道

| 通道 | 用途 |
|------|------|
| Combined | 最终合成 |
| Diffuse Direct/Indirect | 重打光 |
| Glossy | 反射控制 |
| Normal | 合成特效 |
| AO | 接触阴影增强 |
| Z（深度） | 合成中的景深、雾 |
| Cryptomatte | 物体遮罩 |
| Emission | 屏幕辉光特效 |

## 色彩管理

```
<!-- 上游原文: "View Transform: AgX (Blender 4+) or Filmic"
③Blender 5.2 校正：Blender 4.0 起移除 Filmic，AgX 為默認 view transform；5.x 僅 AgX / Standard。 -->
View Transform: AgX（Blender 4.0+ 默認；Filmic 已移除）
Look: Medium Contrast（默认）或 High Contrast（戏剧感）
曝光：在合成器里调，不靠灯硬轰
```

## 渲染优化

- 用渲染区域（render region）做测试裁切
- 自适应采样（Cycles）
- 渲染层关闭不可见物体
- 有 GPU 时默认 GPU 渲染
- 动画序列开启 Persistent data

## 资产转台模板

```
1. CAM_Turntable 放 3/4 高度、45° 角
2. 资产原点放空物体 → 旋转动画 0–360°（120 帧）
3. 三点布光灯架
4. 渲染 1280×1280 或项目指定分辨率
5. 输出 PNG 序列或 MP4，寫入 $BLENDER_WORK/out/
```

## 参考图验证

匹配照片/概念图时（`../references/reference-image-match.md`）：

| 设置 | 参考匹配 |
|------|----------|
| 主角相机 | 调色前先对齐参考角度 |
| AgX Look | 默认 Medium Contrast；参考图冲就 High Contrast |
| 曝光 | 常见 0.15–0.45；外壳要读得出，不要爆白 |
| 预览回放 | EEVEE，关运动模糊，`taa_samples` 1–8 |
| 最终静帧 | 用主角 `CAM_*` 渲染 — 与参考对比 |
| 对比工具 | 视口截图或 bpy 渲染静帧（產物寫 `$BLENDER_WORK/out/`） |

交付前跑 `../references/visual-match-checklist.md`。

## 约束

### 必须做
- 渲染引擎匹配项目风格
- 提供参考图时必须**截图或渲染对比**
- Cycles 生产渲染用降噪
- 最终渲染前设好色彩管理
- 主角资产渲染验证转台
- 相机归入 `COL_Cameras`

### 禁止做
- 采样没测试就上生产渲染
- 忽视色彩管理（sRGB vs Linear）
- 无目的地超分辨率渲染
- 计划合成却跳过渲染通道
- 实时游戏预览用 Cycles

## 参考指南

| 主题 | 参考 | 何时加载 |
|------|------|----------|
| 通道合成 | `references/render-passes.md` | 多通道输出 |
| NPR/风格化渲染 | `references/npr-rendering.md` | 风格化项目 |
| 参考图匹配 | `../references/reference-image-match.md` | 附照片/概念图 |
| 视觉匹配验证 | `../references/visual-match-checklist.md` | 交付前 |
