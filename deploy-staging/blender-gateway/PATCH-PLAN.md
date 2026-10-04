# PATCH-PLAN — blender_* 三工具 VPS gateway 落位稿（片G，2026-09-06）

**性质：staging 稿，本片未上 VPS（零 SSH）。** 行为真源 `src/lib/blender-tools.ts`；opencode 形状稿 `deploy-staging/blender-gateway/blender_tools.ts`（= VPS 端 `lib/blender-tools-impl.ts` 整份内容）。桥（`bridge/blender-bridge/`，片A 交付）本机已验收，VPS 侧进程管理待拍板（见 §5）。

配方依据：记忆 `opencode-autopsy-gateway-surgery-recipe`（tee 中转→python 补丁→bun build→重启→journalctl）、`agent-harness-deny-table-architecture`（deny 真源/gateway 60s 自读）、`2026-09-02-director-tools-piece4-deploy`（tools+lib 落位 install 644、/tmp sftp 限制、bun 直调 smoke、restart opencode-server 才生效）。

## 0. 落位点总表（每档放哪）

| # | staging 档 / 内容来源 | VPS 落位路径 | 动作 | 属主/权限 |
|---|---|---|---|---|
| 1 | `blender_tools.ts`（整份，片 AJ 起由 tools/export-blender-tools-staging.ts 机械导出） | `/opt/agent-harness/workspace/.opencode/lib/blender-tools-impl.ts` | 新增 | root 644 |
| 1b | `blender_tools_adapter.ts`（整份，wrapBlenderTool 机械包装） | `/opt/agent-harness/workspace/.opencode/lib/blender-tools-adapter.ts` | 新增 | root 644 |
| 2 | adapter blender_exec | `/opt/agent-harness/workspace/.opencode/tools/blender_exec.ts` | 新增 | root 644 |
| 3 | adapter blender_render | `/opt/agent-harness/workspace/.opencode/tools/blender_render.ts` | 新增 | root 644 |
| 4 | adapter blender_export_gltf | `/opt/agent-harness/workspace/.opencode/tools/blender_export_gltf.ts` | 新增 | root 644 |
| 5 | `bridge/blender-bridge/`（4 档：blender_addon.py / launcher.py / server.py / README.md） | `/opt/blender-bridge/`（建议；见 §5 待拍板） | 新增 | root 644 |
| 6 | env 两键 | `/opt/agent-harness/.env` 追加 `BLENDER_BRIDGE_URL=http://127.0.0.1:8765`（`BLENDER_BIN` 见 §5） | 追加 | — |
| 7 | 产物回传（片 AJ，2026-09-06） | 桥 `server.py` 增 `GET /v1/artifact?path=`（out/ 白名单+binary 回传）；真源 `blender-tools.ts` 成功 result 增 `artifact_base_url`（随 §1 导出稿自动在 impl 内）；agent 以 `${artifact_base_url}?path=<rel>` 经反向隧道取回，沙箱不自持档案 | 随桥/impl 更新 | — |

- **注册表不需要加 id**：opencode 工具注册是目录扫描制（`.opencode/tools/*.ts` 落档即注册），无 id 清单档要改。本地 `src/lib/harness-tool-registry.ts` 已含 `blender_exec/blender_export_gltf/blender_render`（P0-4 片C 已登记，VPS 同步属 repo deploy 流程，不在本片）。
- `.opencode/` 目录 sftp 直接写会 Permission denied——一律先落 `/tmp` 再 `sudo cp`（记忆 director R1）。

三个 adapter 档内容（各 3 行，片 AJ 改制：impl 为 BlenderToolDef 描述符形状（机械导出），由
lib/blender-tools-adapter.ts 的 wrapBlenderTool 机械包装成 opencode tool()；args schema 从
工具自带定义读取，零手写=零漂移；交互逻辑零新增）：

```ts
// blender_exec.ts
import { wrapBlenderTool, blenderExecTool } from "../lib/blender-tools-adapter"
export default wrapBlenderTool(blenderExecTool)
```
```ts
// blender_render.ts
import { wrapBlenderTool, blenderRenderTool } from "../lib/blender-tools-adapter"
export default wrapBlenderTool(blenderRenderTool)
```
```ts
// blender_export_gltf.ts
import { wrapBlenderTool, blenderExportGltfTool } from "../lib/blender-tools-adapter"
export default wrapBlenderTool(blenderExportGltfTool)
```

## 1. 本地预检（上 VPS 前做完）

```bash
# 隔离 tsc（已在本片验证 TSC_OK；工具缺 @opencode-ai/plugin 时 stub 如实记录）
mkdir -p /tmp/bl-tsc && cp deploy-staging/blender-gateway/blender_tools.ts /tmp/bl-tsc/
printf 'declare module "@opencode-ai/plugin/tool" {\n  export const tool: any\n}\n' > /tmp/bl-tsc/stub.d.ts
cd /tmp/bl-tsc && /home/lenovo/Desktop/image-app/node_modules/.bin/tsc --noEmit --skipLibCheck --strict \
  --target es2022 --module esnext --moduleResolution bundler --lib es2022,dom \
  --typeRoots /home/lenovo/Desktop/image-app/node_modules/@types --types node \
  blender_tools.ts stub.d.ts
```

## 2. Patch 命令稿（opencode-autopsy 配方全照；假设本地档已在工作目录）

```bash
# 2.1 备份（工具目录现状 + .env；lib/blender-tools-impl.ts 是新增档无需备份）
vps.py run "sudo cp -a /opt/agent-harness/workspace/.opencode/tools /tmp/tools.bak-MMDD-blender"
vps.py run "sudo cp /opt/agent-harness/.env /tmp/env.bak-MMDD-blender"

# 2.2 上传到 /tmp（.opencode 下 sftp 直写会 Permission denied，必经 /tmp 中转）
vps.py put deploy-staging/blender-gateway/blender_tools.ts /tmp/blender-tools-impl.ts
vps.py put deploy-staging/blender-gateway/blender_tools_adapter.ts /tmp/blender-tools-adapter.ts
# （三个 adapter 内容极短，用 base64 单命令写入 /tmp；SSH-443 管道会卡死，禁 scp）
vps.py run "printf 'import { wrapBlenderTool, blenderExecTool } from \"../lib/blender-tools-adapter\"\nexport default wrapBlenderTool(blenderExecTool)\n' > /tmp/bl_adapter_exec.ts"
vps.py run "printf 'import { wrapBlenderTool, blenderRenderTool } from \"../lib/blender-tools-adapter\"\nexport default wrapBlenderTool(blenderRenderTool)\n' > /tmp/bl_adapter_render.ts"
vps.py run "printf 'import { wrapBlenderTool, blenderExportGltfTool } from \"../lib/blender-tools-adapter\"\nexport default wrapBlenderTool(blenderExportGltfTool)\n' > /tmp/bl_adapter_gltf.ts"
# （桥 4 档由片A 交付物同法 put 到 /tmp，命令从略——server.py/blender_addon.py/launcher.py/README.md）

# 2.3 编译验证先于落位重启（bun 不在 sudo PATH；--target=bun 铁律，记忆 director 片3 坑）
vps.py run "export PATH=\$PATH:/home/ubuntu/.bun/bin && bun build /tmp/blender-tools-impl.ts --target=bun --outfile=/tmp/bl-impl-check.js && bun build /tmp/bl_adapter_exec.ts --target=bun --outfile=/tmp/bl-exec-check.js && bun build /tmp/bl_adapter_render.ts --target=bun --outfile=/tmp/bl-render-check.js && bun build /tmp/bl_adapter_gltf.ts --target=bun --outfile=/tmp/bl-gltf-check.js && echo BUILD_OK"

# 2.4 落位（install 644 照 director 片4 范式；sudo cp 勿用 sudo cat > 重定向——会 Permission denied）
vps.py run "sudo install -m 644 /tmp/blender-tools-impl.ts /opt/agent-harness/workspace/.opencode/lib/blender-tools-impl.ts"
vps.py run "sudo install -m 644 /tmp/blender-tools-adapter.ts /opt/agent-harness/workspace/.opencode/lib/blender-tools-adapter.ts"
vps.py run "sudo install -m 644 /tmp/bl_adapter_exec.ts /opt/agent-harness/workspace/.opencode/tools/blender_exec.ts"
vps.py run "sudo install -m 644 /tmp/bl_adapter_render.ts /opt/agent-harness/workspace/.opencode/tools/blender_render.ts"
vps.py run "sudo install -m 644 /tmp/bl_adapter_gltf.ts /opt/agent-harness/workspace/.opencode/tools/blender_export_gltf.ts"

# 2.5 env 追加（幂等：grep 有则跳过）
vps.py run "grep -q BLENDER_BRIDGE_URL /opt/agent-harness/.env || echo 'BLENDER_BRIDGE_URL=http://127.0.0.1:8765' | sudo tee -a /opt/agent-harness/.env >/dev/null"

# 2.6 opencode-server 重启（工具层新档必 restart 才生效——第三次实锤的铁律）
vps.py run "sudo systemctl restart opencode-server"
vps.py run "journalctl -u opencode-server -n 50 --no-pager | grep -iE 'error|blender' ; echo journal_done"

# 2.7 活体注册确认
vps.py run "sudo bash -c 'set -a; source /opt/agent-harness/.env; set +a; curl -s -u opencode:\$OPENCODE_SERVER_PASSWORD \"\$OPENCODE_URL/experimental/tool/ids?directory=/opt/agent-harness/workspace\"'" | grep -oE 'blender_[a-z_]+' | sort -u
# 预期三行：blender_exec / blender_render / blender_export_gltf
```

## 3. Smoke（桥就绪后；桥未上线则只跑 3.1 的负例）

```bash
# 3.1 负例（不依赖桥）：bun 直调，桥关闭 → 必得 bridge_unavailable 人话错误（验证错误分类层）
vps.py run "export PATH=\$PATH:/home/ubuntu/.bun/bin && cd /opt/agent-harness/workspace/.opencode && sudo env HARNESS_API_KEY=\$(sudo grep '^HARNESS_API_KEY=' /opt/agent-harness/.env | cut -d= -f2) bun -e 'const m = await import(\"/opt/agent-harness/workspace/.opencode/lib/blender-tools-impl.ts\"); const r = await m.blenderExecTool.execute({script:\"import bpy\\nprint(1)\"}, {sessionID:\"sm-bl\", abort:undefined}); const o = JSON.parse(r.output); console.log(r.title, o.ok, o.error.code)'"
# 预期输出：失败 false bridge_unavailable（若桥已起则 true）
# 坑：execute 返回 {title, output}，output 是 JSON 字串，必 JSON.parse（director 片4 坑②）

# 3.2 正例（桥已在 VPS 跑起，GET /v1/health 返回 200 后）：
#   blender_exec：cube + 骨架 keyframe 小脚本 → ok:true artifacts.length>=0
#   blender_render：eevee 单帧 → artifacts 含 png
#   blender_render：turntable=true → artifacts 含 mp4
#   blender_export_gltf：默认 glb → artifacts 含 glb
#   invalid_args 负例：render_engine="octane" → invalid_args 不发网络请求
```

## 4. deny 例外清单（从 docs/blender-bridge-notes.md §5 继承，VPS 侧表述）

deny 表唯一真源 = `/opt/agent-harness/workspace/.opencode/opencode.json` 的 `permission.bash`；gateway 每 60s 自动重读，**改表不重启 gateway**。本片结论：

1. **本工具族零 deny 变更**：opencode 工具执行是 node 进程内 fetch（127.0.0.1:8765），不经 bash permission 表。
2. **不新增任何 deny**：blender 工具族无需收紧的 bash 面；主机破坏红线（sudo/dd/systemctl 等）维持现状。
3. **条件项（仅当回退「预设 deny + 白名单」时才加）**：agent 用 bash 直跑 Blender CLI 需 `"blender *": "allow"`，并确认 `*blender-bridge*` 启动命令放行。现行 live 表（08-29 后预设 allow + 红线 deny）下无需动作。落位验收时照 notes §6 对账一次 live opencode.json 防漂移。
4. 桥侧安全（绑 127.0.0.1 禁 0.0.0.0、bpy blocklist）属片A 桥施工职责，非 deny 表条目。

## 5. 桥的 VPS 侧依赖声明

- **桥代码**：`bridge/blender-bridge/` 四档（blender_addon.py 4164 行 blender-mcp 白名单版 / launcher.py / server.py / README.md）→ 建议落 `/opt/blender-bridge/`。本机验收事实：health 5.2.1+egl、Eevee PNG 3.7s、timeout killpg 自动重启、netns 拦 urllib。
- **Blender 二进制**：VPS 需 Blender 5.2.1 LTS（本机路径 `~/Applications/blender-5.2*-linux-x64/`，server.py 经 `BLENDER_BIN` env 抓位址）。**VPS 安装法（压缩包/系统包）待拍板**，不擅自装。
- **GPU 节点**：VPS（腾讯云）大概率无 NVIDIA EGL headless 条件，health 会回 `gpu:"cpu"`，cycles 档基本不可用（eevee CPU 快稿可跑但慢）。**是否要独立 GPU 节点（何机/如何接入/BLENDER_BRIDGE_URL 指向哪）列为待拍板不解决**。
- **桥进程管理**（本片最大缺口，待拍板）：`server.py` 目前是裸 `python3` 前台进程。VPS 侧方案候选：systemd 单元（如 `blender-bridge.service`，`Restart=on-failure`，`Environment=BLENDER_BIN=… BLENDER_WORK=/opt/blender-bridge/work`）或 tmux 常驻——**按何种方式跑、`BLENDER_WORK` 放哪、是否 `unshare -rn`（VPS 内核 user-namespace 可用性未验证）均待拍板**。拍板前 smoke 只能跑 §3.1 负例。
- **端口**：8765（桥 HTTP，必绑 loopback）+ 9876（addon，netns 内）；皆 localhost only，无鉴权，不对外开。
- **恢复语义**：桥 timeout 杀 blender 后下次请求自动重启全新 factory-startup 实例；工具层无状态，无需跨进程恢复。

## 6. 回滚稿

```bash
# 一行还原（MMDD 换 2.1 实际日期戳）：删四新档 + 还原 .env + 重启 opencode-server
vps.py run "sudo rm -f /opt/agent-harness/workspace/.opencode/tools/blender_exec.ts /opt/agent-harness/workspace/.opencode/tools/blender_render.ts /opt/agent-harness/workspace/.opencode/tools/blender_export_gltf.ts /opt/agent-harness/workspace/.opencode/lib/blender-tools-impl.ts && sudo cp /tmp/env.bak-MMDD-blender /opt/agent-harness/.env && sudo systemctl restart opencode-server && journalctl -u opencode-server -n 20 --no-pager | tail -5"
# 桥侧回滚：sudo systemctl stop blender-bridge（或杀 tmux/python3 进程）+ sudo rm -rf /opt/blender-bridge
# tools 目录整体还原（若 adapter 之外有意外改动）：sudo rm -rf .opencode/tools && sudo cp -a /tmp/tools.bak-MMDD-blender .opencode/tools
```

## 7. 验收对账（上线当天照 docs/blender-bridge-notes.md §6 跑）

- [ ] 桥 GET /v1/health 200 且 gpu 栏位非空
- [ ] 三档落位 + opencode-server 重启 journalctl 零错
- [ ] `/experimental/tool/ids` 列出三 id
- [ ] bun 直调 smoke 负例（bridge_unavailable）+ 正例三工具真产物
- [ ] live opencode.json deny 对账
