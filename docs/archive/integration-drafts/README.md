# Blender接入落位原稿

这两组材料曾放在 `services/`，但并不是可启动的服务。原稿保留全部字节；Python、TypeScript和JSON稿增加`.txt`后缀，避免被当作当前脚本、工具或配置执行。

- `blender-director-persona/`：README和PATCH-PLAN明确写“staging稿、零SSH”；真实persona契约在 `src/lib/agent/blender-director-persona.ts`，不在这些patch脚本中。
- `blender-nodes/`：NODES-PLAN及channel文件明确写“staging稿、零src改动”；其中两个runner只消费同组草稿。

2026-11-26检查：受控的业务源码、包脚本、发布入口和代码生成入口均未导入、加载或执行这11份原稿；外部命中为历史说明/注释。真实桥保留在 `services/blender-bridge/`，现役生成器仍使用 `services/blender-gateway/`，未随本稿归档。此结论只限定这两组文件，不能推断相关功能已经废弃。

原稿里的路径、示例命令和当时判断保持历史原貌，禁止直接照旧命令落位。恢复实施应从当前调用链重建差异，不执行旧patch。
