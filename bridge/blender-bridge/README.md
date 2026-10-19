# blender-bridge（headless Blender 沙箱执行器）

Image Studio 3D 导演工作站 P0-2。轮子：[ahujasid/blender-mcp](https://github.com/ahujasid/blender-mcp)（27k★）addon 逐行复制改白名单（见 `blender_addon.py` 内 `[image-studio bridge whitelist …]` 标注），socket 服务/线程模型/JSON 协议一行未动。

## 档案

- `blender_addon.py` — blender-mcp addon 整份复制（基准 4164 行），白名单外唯一偏离：`start()` 的 `bpy.app.background` 挡刀注释化（实测 Blender 5.2.1 `-b` 模式 `bpy.app.timers` 零触发，改由 bootstrap 主线程直接帮浦 `_drain_command_queue`，语义等价）
- `launcher.py` — 起 `blender --background --factory-startup`（优先 `unshare -rn` 网路隔离），等 socket 握手，可单独跑：`python3 bridge/blender-bridge/launcher.py`
- `server.py` — stdlib ThreadingHTTPServer，127.0.0.1:8765，HTTP 契约见下

## 一行起全栈

```bash
python3 /home/user/Desktop/image-app/bridge/blender-bridge/server.py
```

（server 内建 supervisor：首个请求自动拉起 Blender；也可先手动 `python3 …/launcher.py` 预热）

环境变数：

| 变数 | 默认 | 说明 |
|---|---|---|
| `BLENDER_BIN` | 抓 `/home/user/Applications/blender-5.2*-linux-x64/blender` | blender 执行档 |
| `BLENDER_WORK` | repo 根 `.blender-work/`（已入 `.gitignore`） | job 工作目录 / `out/` 产物根 / `blender.log`（引擎日志，launch 时轮转留一代 `.1`）与 `job-output.log`（Python 层输出）所在 |
| `BLENDER_BRIDGE_CONCURRENCY` | `1` | 执行槽数（同时跑几个脚本；>1 时多 job 会打进同一 blender 进程，addon 帮浦单线程天然串行，健康检查/GPU 探针会与执行互抢，建议保持 1） |
| `BLENDER_BRIDGE_QUEUE_DEPTH` | `16` | 排队深度上限，满了立即 429 `queue_full` |

## 健康检查

```bash
curl -s http://127.0.0.1:8765/v1/health
# → {"ok": true, "blender_version": "5.2.1", "gpu": "egl"|"cpu", "workdir": "…/.blender-work",
#    "queue_depth": 0, "concurrency": 1}
```

`gpu` 判法：在 Blender 内 `import gpu` + 建 16x16 GPUOffScreen 成功 = `egl`（RTX 5070 EGL headless），失败 = `cpu`。`queue_depth` = 正在排队的 job 数（执行中不计）；`concurrency` = 执行槽数（env）。

## 执行脚本

```bash
curl -s -X POST http://127.0.0.1:8765/v1/execute \
  -H 'Content-Type: application/json' \
  -d '{"script":"import bpy\nprint(\"hi\")","timeout_ms":120000}'
```

- 脚本 CWD = `$BLENDER_WORK`；产物落 `$BLENDER_WORK/out/`（job 起始时对 out/ 做快照、结束时 diff——新增或 mtime 变化才算本 job 产物，无任何时间戳容差；kind 按副档名：blend/png/mp4/glb/other）
- `stdout_tail` ≤2000 字：**脚本 print 输出（走 `execute_code` 的 stdout 捕获，保证占有窗口，不会被挤掉）+ 剩余预算的本 job Python 层输出增量**（`$BLENDER_WORK/job-output.log`，从 job 起始 offset 读起；job 无新增输出时回退 `blender.log` 尾段）
- 日志分道：`blender.log` 只收 Blender C 层引擎输出（含 native crash dump），每次 blender (re)launch 轮转为 `blender.log.1`（只留一代，保留上次崩溃证据）；Python 层输出（bootstrap 标记、帮浦错误、逃出捕获的 print）走 `$BLENDER_WORK/job-output.log`
- 成功回应新增栏位：`queued`（是否排过队）+ `queue_position`（入队瞬间的 1-based 位次；未排队 = 0）
- timeout 到点 SIGKILL 整个进程组（blender+子进程），回 500；下次请求自动重启全新 factory-startup 实例

## 执行伫列（P1-1）

语义同构自 generation worker 并发池（`GENERATION_WORKER_CONCURRENCY` 轮子）：

```
POST /v1/execute
  → 伫列深度 < CONCURRENCY + QUEUE_DEPTH ？
      否 → 立即 429 {"ok":false,"error":"queue_full"}（不占位）
      是 → 入 FIFO 队尾，等执行槽
  → 拿到槽 → 执行（timeout_ms 只管执行段）→ 200/500
```

- **FIFO 严格**：槽释放时只有队头能被晋升（`notify_all` + 头位断言，唤醒谁都改变不了顺序）
- **超时双层**：`timeout_ms` 只预算执行段；排队等待不扣。总等待（排队+执行）超过 `timeout_ms × 2` 硬杀：还在排队的 job 直接出队回 500 `queue hard deadline`（`queued:true`），没跑过就不会杀 blender；已开跑的照旧 SIGKILL 进程组回 500
- **失败自愈**：blender 进程死（被杀/崩溃）→ 执行中 job 回 500 `blender connection lost` 并释放槽，后面的 job 由 `ensure_blender` 自动重启后照常执行，伫列不阻塞
- **429 即答**：满队（running+waiting 达上限）的请求立即 429，不入队不占位

### 已知限制（片 A 存量，非伫列引入）

- **~~>5s 的脚本会在 addon 侧断连~~（已根治，片 O 2026-09-06）**：真因不在 addon，是 launcher bootstrap 的 unix→TCP 转发器 `socket.create_connection(..., timeout=5)`——该 timeout 持久化在 socket 上，execute_code 主线程静默 >5s 时转发器 pipe 线程 recv 抛 timeout → `shutdown(SHUT_WR)` → supervisor 收到精确 5.0s EOF。修复＝addon 模组载入时（bootstrap 先 import addon 再起转发器）对连向 addon 自身 loopback 端口的 create_connection 解除超时（`blender_addon.py` 顶部 `[image-studio bridge patch ⑤]`，纯加法 +56 行）。A/B 实锤：原版 8s 脚本 5.01s EOF；修补版 8s/15s/30s 全过（HTTP 实弹 15.62s/30.10s 含 MARK）。主线程帮浦阻塞行为不变（bridge 伫列并发=1 下无影响）
- `BLENDER_BRIDGE_CONCURRENCY > 1` 时多 job 打进同一 blender 进程，addon 帮浦单线程天然串行，不会真并行加速（保留 env 是为语义齐全；健康检查/GPU 探针会与执行互抢主线程，建议保持 1）

## 隔离模型与已知限制

- `unshare -rn`（user+netns）可用时：Blender 无外网；addon 9876 在 netns 内，经 `$BLENDER_WORK/bridge.sock`（unix socket，mode 600）跨界转发到 host。本机实测三关全过：`unshare -rn true` OK、netns 内 lo 可 SIOCSIFFLAGS 拉起、unix→TCP 双向转发通。
- **残余风险（隔离模式下）**：无 filesystem 隔离——脚本仍可写 host 任何用户可写路径（如 /tmp）；无 GPU 隔离。低信任脚本勿直接入此通道。
- `unshare` 不可用的机器上自动裸起（无网路隔离），health 的 workdir 不变，报告需另标。
- `--factory-startup`：每次启动干净偏好/插件；脚本间不共享状态（进程被 timeout 杀掉后更是全新实例）。
- blender-mcp 的资产站命令（Poly Haven/Sketchfab/Hyper3D 等）保留原样，隔离模式下会因无网失败——属预期行为。
