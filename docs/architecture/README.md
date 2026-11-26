# 技术边界与结构说明

维护入口是[任务与职责地图](../REPOSITORY.md)。这里不再混放路演图、宣传口播和一次性上下文审计，它们分别进入 [presentation/architecture](../presentation/architecture/) 与 [evidence/context-20261011](../evidence/context-20261011/)。

| 文档 | 性质与范围 | 维护时对照 |
| --- | --- | --- |
| [viewer](viewer.md) | 赏阅系统结构说明 | `src/components/viewer/` 与 `src/lib/viewer/`；文件内的日期与行号是当时基线 |
| [generation-control-plane-p0](generation-control-plane-p0.md) | 耐久生成控制面P0目标和边界 | `src/lib/generation-core/`、`worker/generation-worker.ts`；目标表不是当前完成声明 |
| [planes](planes.md) | 文内明确“契约冻结，未接线”的三平面边界 | 设计约束，不将其当成当前全部调用关系 |
| [planes-violations](planes-violations.md) | 2026-09-28违例与修复快照 | 历史诊断依据；不能照旧行号直接打补丁 |
| [dual-truth-boundary](dual-truth-boundary.md) | 两套执行图边界的决策记录 | 按其来源理解设计取舍，当前接口以代码为准 |
| [local-first-io](local-first-io.md) | 2026-10-04本地能力分层说明 | 桌面壳源码在 `apps/desktop/`；文内未验证项保留未知 |

上述文档均未因为归类就被宣布“最新有效”。新增跨层接口先定位调用者和唯一真源，再更新涉及的说明；不要把状态快照扩写成另一份运行时配置。
