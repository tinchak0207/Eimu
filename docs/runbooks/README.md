# 操作与接入

| 任务 | 入口 | 执行边界 |
| --- | --- | --- |
| 选择同步/异步 API 接法 | [biz-api](biz-api.md) | 协议说明；参数与价格以当前接口及权威目录为准 |
| 异步 API 接入 | [biz-api-guide](biz-api-guide.md) | 避免把旧示例当当前报价 |
| 排障和环境访问 | [infra-debugging](infra-debugging.md) | 排障附件；本机 `.local` 诊断材料不是部署所需源码 |
| 恢复渠道历史偏置 | [bias-refresh](bias-refresh.md) | 包含状态写入，执行前核实目标与授权 |
| Blender工具与桥接口 | [blender-bridge-notes](blender-bridge-notes.md) | 启动方式以 `services/blender-bridge/` 实作为准 |
| Harness移植的接线与回滚记录 | [2026-10-18移植记录](2026-10-18-cc-2.1.302-harness-port.md) | 绑定文内基线；线上版本按实际release确认 |

发布入口集中在 [deploy](../../deploy/)，按[任务地图](../REPOSITORY.md#发布入口)定位。复制几份文件到新release不构成完整候选，健康响应也不能证明新内容已经运行。
