# 开发与维护入口

改代码从[任务与职责地图](REPOSITORY.md)进入。它列出真实入口、代码归属、共享文件和发布边界。产品介绍见[根 README](../README.md)；工程约束见 [AGENTS.md](../AGENTS.md)。

| 要找什么 | 去哪里 | 使用边界 |
| --- | --- | --- |
| 当前代码与命令 | [任务与职责地图](REPOSITORY.md) | 跟踪本地代码入口，不把它当线上发布回执 |
| 技术边界与结构说明 | [architecture](architecture/README.md) | 逐篇说明适用范围；冻结契约不等于已经接线 |
| 排障、API接入与操作 | [runbooks](runbooks/README.md) | 运行前核对目标环境；本机临时文件不是发布依赖 |
| 设计品牌规范 | [DESIGN](../DESIGN.md)、[设计系统](design-system/MASTER.md) | 对外视觉与产品品牌依据 |
| 待实施方案、PRD与决策稿 | [proposals](proposals/README.md) | 规划资产，不能拿“目标”当“已经实现” |
| 专项规格与调研组合 | [specs](specs/README.md) | 保留原有事实/设计/评测区分，接线状态逐项核对 |
| 研究与审计 | `research/`、`audits/` | 有日期和基线的调查结论，不能覆盖当前代码事实 |
| 行为回执、量测与样本 | `evidence/` | 证据按原会话/提交/环境解释，不是当前运行指南 |
| 对外讲解、口播与展示图 | [presentation](presentation/README.md)、`preview/` | 介绍材料，不能用作技术架构或当前功能验收 |
| 被明确替代的方案和冻结原稿 | [archive](archive/README.md) | 保全历史；默认维护路径不经过这里 |

`reports/`、`research/`、`evidence/` 中有未纳入 Git 的个人资料与原始样本，本轮保留原位置。`handoffs/` 和 `repository-layout/` 记录交接与迁移，不另立一套当前规范。

新增文档选上面的现有类别；文件名描述主题，日期用于同主题快照。源码的规则、常量和接口仍以源码为准，文档只链接其位置，不复制一份可漂移的注册表。
