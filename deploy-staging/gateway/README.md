# agent-gateway

## 环境变数

| 变数 | 默认 | 说明 |
|---|---|---|
| `EIMU_OPENUI` | 关闭 | 设 `1` 时，网关把同目录 `openui-system-prompt.txt`（OpenUI 语法与组件说明）连同触发政策注入 system prompt 的静态段，允许模型用 ` ```openui ` 围栏输出交互界面程序。档案缺失或为空时只记一条 warn，功能关闭，不影响网关启动。 |

环境由部署时的 systemd `EnvironmentFile` 提供（gateway 本身不读取 `.env` 档）。
