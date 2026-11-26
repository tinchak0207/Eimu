# 进程、运行时与接入资产

这里按执行边界归属，不把每个目录都称为独立服务。本表只说明仓库里的入口和消费者；本机及线上进程当前是否启用，**未在本轮核实**，不能从目录存在推断。

| 目录 | 实际职责与入口 | 发布或消费边界 |
| --- | --- | --- |
| [gateway](gateway/README.md) | 独立Bun网关包，`index.ts`；包内`npm start`实际调用`bun run index.ts` | `deploy/vps/gateway-release.sh`发布完整源码树；会话与调度归这里 |
| [poller](poller/README.md) | 独立Bun后台轮询包，`index.ts` | 不随站点页面自动运行，部署和环境见自身README |
| `mcp/` | 独立MCP包，`src/index.ts`；构建后`dist/index.js` | 使用自己的package脚本，不把根Next构建当MCP构建 |
| `opencode-runtime/` | OpenCode扫描的工具、插件、技能和配置包；`opencode.json`、`AGENTS.md`、`tools/` | `deploy/vps/opencode-release.sh`安装到workspace与`.opencode`各自位置；自身package没有独立start脚本 |
| [blender-bridge](blender-bridge/README.md) | 本机HTTP桥`server.py`与Blender进程`launcher.py` | 执行宿主能力；工程与产物目录属于进程配置，不放源码目录 |
| `blender-bridge-tunnel/` | 桥的SSH反向隧道与进程配置 | 连接能力，不是另一个渲染实现；旧兼容路径只供既有本机进程使用 |
| [blender-modal](blender-modal/README.md) | Modal云节点`modal_app.py`与调用端`modal_worker.py` | 单独部署/付费计算边界；本表不构成执行或计费授权 |
| [laya-server](laya-server/README.md) | 判定后备服务`server.py`/`server_onnx.py` | 独立Python依赖与镜像，是否启用由消费者配置决定 |
| [flowmusic2api](flowmusic2api/README.md) | 上游服务的版本化Go补丁与`watchdog.py` | 不是完整上游Go工程；补丁消费外部上游源码，按README绑定基线 |
| `expert-gateway/` | Expert规范文本与导出资产；规范、契约、ID及派遣手册分工不同 | `tools/codegen/export-expert-agents.ts`从产品registry生成部分资产，同步到`gateway/expert`并受保护差异约束；不能整目录覆盖手工调和配置 |
| [blender-gateway](blender-gateway/README.md) | Blender工具导出落位稿与接入计划 | `tools/codegen/export-blender-tools-staging.ts`写产物；不独立启动，执行实现仍追工具真源和runtime消费者 |
| `vps-tools/` | 远端对账、安装与历史运维工具 | gateway/opencode发布入口调用其中recon脚本；不要把同目录所有旧工具当当前发布流程 |

原先的`blender-director-persona`和`blender-nodes`是无现役消费者的落位原稿，已原字节冻结至 [integration-drafts](../docs/archive/integration-drafts/README.md)。真实persona源码、模型标签和桥未因归档而删除。

一项修改的源与派生物必须分清：改业务真源，运行现有导出器，检查真实消费者，使用对应发布入口。跨服务共享的配置、类型、导出入口由一个整合者负责；各执行者在自己目录内改实现。运行状态、凭证与临时输出不成为第二套源码。
