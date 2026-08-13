# 2026-06-10 专业工作站 UX 分层重构

目标:把专业模式从「InvokeAI 式全功能面板」重构为「可解释、低学习成本、零装饰按钮」的单屏工作站。

## 设计原则

1. **三步心智模型**:左栏 = 输入(① 提示词 → ② 参考图 → ③ 参数),中央 = 画布/成片墙,右栏 = 产出(队列 / 图库 / 历史)。每个面板顶部有一行「这里做什么」的说明条(`pro-panel-hint`)。
2. **零装饰按钮**:所有可见控件必须改变生成请求或界面状态。
   - 局部要求(原“区域提示层”)→ 写入 `workflow.regionalPrompts`,服务端 `buildWorkflowPrompt` 合并进最终提示词。
   - 参考图强度(原“控制层”)→ `ReferenceImage.strength`,随角色一起写入 workflow 元数据与提示词。
   - 画布标注(原“画布工具”)→ 真实 canvas 绘制层,可合成原图导出为参考图(role=composition),用于局部修改指引。
   - 删除:命令侧栏(9 图标)、启动台、栅格层(由“转入素材/标注转参考图”替代)。
3. **交互式教学**:driver.js(MIT)新手引导,首次进入自动播放(localStorage `pro-workstation-tour-v1`),顶栏「新手引导」可重播;每步自动切到对应面板。
4. **Liquid Glass 对齐 design-system/MASTER.md**:卡片 blur 40px / saturate(180%) / brightness(1.08),浮层 blur 28px,顶栏 blur 48px saturate(200%),specular 顶边高光线,交互弹簧曲线 `cubic-bezier(0.34, 1.56, 0.64, 1)`。

## 数据流(无假功能验证表)

| 控件 | 落点 |
|---|---|
| 主提示词 / 上下文 / 反向 | `buildWorkflowPrompt` 服务端合并 |
| 工作流预设 | promptHint/negativeHint 注入 + 元数据 |
| 局部要求 | `workflow.regionalPrompts[]` → 提示词 Regional requirements 段 |
| 参考图 + 用途 + 强度 | multipart 上传 `/images/edits` + 元数据 + 提示词 Reference images 段 |
| 尺寸 / 质量 / 用途 / 种子 | `size` 参数 + Production profile 段 |
| 批量 / 并发 | 槽位调度(use-image-generation) |
| 标注层 | 合成 PNG → 参考图(composition)+ 上下文注记 |
| 复制/导入配置、最近任务 | workflow-recall 解析回填(含 regionalPrompts) |

Mobile should keep normal mode;No fake node execution engine。
