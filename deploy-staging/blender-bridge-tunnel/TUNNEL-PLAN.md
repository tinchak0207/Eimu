# TUNNEL-PLAN — VPS gateway 调本机 blender-bridge 的通路稿（片W，2026-09-06）

**性质：staging 稿。本片零 SSH、零 VPS 改动。** 问题：`blender_*` 三工具（片G staging 稿）在 VPS gateway 内 fetch `BLENDER_BRIDGE_URL`（默认 `http://127.0.0.1:8765`），而桥跑在本机 NAT 后的 127.0.0.1:8765——需要一条让 VPS 本机进程可达本机桥的反向通路，且必须带一层鉴权（桥无鉴权是片A 已记录的残余风险）。

---

## 1. 考古结论（三份，带证据）

### 1.1 ws-tunnel-node.js 工作原理 = 正向隧道（本机→VPS 方向的管道）

- 档案：`.pixai-refresh/ws-tunnel-node.js`（69 行，正在跑，PID 20094，`ss -tln` 实测 LISTEN 127.0.0.1:22222）。
- **方向**：正向。本机 `net.createServer` 监听 127.0.0.1:22222（L66-68）；每来一条 TCP 连线就开一条新 WebSocket 到 `wss://store.tinchak0207.xyz/ssh`（L9-10，`perMessageDeflate:false, handshakeTimeout:15000`），双向裸 pipe（client↔ws，L32-51）。
- **鉴权**：应用层零鉴权——ws 握手不带 header/token（L10），裸 binary 帧直通；安全只靠链路终点（sshd 的 key 鉴权）。
- **VPS 侧对应服务（从配置/启动参数反推）**：
  - nginx：`/ssh` location → `proxy_pass http://127.0.0.1:18083` + WebSocket Upgrade 头（`.pixai-refresh/patch-nginx.sh` L7-14，该脚本 08-23 实弹注入 `imagesite-nginx` 容器 conf 并 reload——`store.tinchak0207.xyz/ssh` 路径至今可用 = `/ssh` 路由存活）。
  - `:18083` = **gost**（ws→tcp 解壳；`.pixai-refresh/` 内有 gost 二进位与 `gost-client.log`），gost 把 ws 里的裸字节流接到 **VPS sshd:22**。
  - 链路全景（`dsh-groq-tunnel.mjs` L5-7 注释原话）：`本机 22222 ↔ wss://store.tinchak0207.xyz/ssh → nginx → gost → VPS sshd`，即 **SSH-over-443**（ISP 封 22 出站，唯一可用路径）。

### 1.2 dsh-groq-tunnel.mjs 形态 = ssh2 动态正向转发（forwardOut）+ 生产级重连骨架

- 档案：`~/.local/bin/dsh-groq-tunnel.mjs`（150 行，本机 systemd user 单元 `dsh-groq-tunnel.service` 常驻 running）。
- 形态：本机 `createServer(18893)` → 每连线 `client.forwardOut(...)` 到 VPS `127.0.0.1:8891`（groq-proxy）。SSH 连线本身走 `127.0.0.1:22222`（ws 隧道）+ `~/.ssh/new.pem` + `keepaliveInterval:30000, keepaliveCountMax:3`。
- 08-24 加固（L8-12 注释）：重连**单一定时器 + 指数退避 2s→30s + 每次新建 Client**——修掉「error/close/end 三 handler 各自重连 → 指数爆炸 → 6.2G OOM」事故。骨架函数 `isPortListening`（L53-58）、`ensureWsTunnel`（L61-71，22222 不在就幂等拉 `start-ssh443.sh`）、`scheduleReconnect`（L73-78）。
- 本机现状修正必读记忆：`laptop-no-openssh-flatpak-ssh` 已标「2026-09-03 更新：本机已装 openssh，作废条件达成」——现场实测 `pacman -Q openssh` = `openssh 10.5p1-1`，`/usr/sbin/ssh` 在位。**SSH 选型不受 flatpak 限制**。但本机 `sshd` 未跑（仅二进位在，无监听、无进程），且登入级别是否拉起 sshd 未知 → 方案 b 的「本机临时 sshd」不可靠性成立。

### 1.3 VPS sshd GatewayPorts 推断：无需 GatewayPorts，loopback RemoteForward 已实证可用

- **直接实锤**：`.dsh-ssh/reverse-tunnel-443.js`（08-21，`2026-08-21-home-relay-and-408-final.md` 记忆在案）就是 ssh2 `forwardIn('127.0.0.1', 18443)` 反向隧道，对**同一台 VPS sshd**（经同一条 22222 ws 隧道 + `new.pem`）实弹打通，容器经 DNAT 访 `172.20.0.1:18443` 出网成功——证明该 sshd 允许 `AllowTcpForwarding` 且 remote forward 绑 `127.0.0.1` 被接受。
- **推断链**：sshd 默认 `GatewayPorts no`（不收 public 绑定）；`ssh -R`/forwardIn 绑 `127.0.0.1` 属 loopback 绑定，**不需要** GatewayPorts。我们的消费方（opencode 工具进程、gateway）全在 VPS 本机 → 只绑 loopback 即满足，**零 sshd 配置变更**。
- 唯一不确定（落位当天一条命令可验）：`AllowTcpForwarding` 是否被改成 `No`——实锤反例存在（18443 先例）+ dsh-groq forwardOut 日常在跑，判定大概率开启。

---

## 2. 三方案对比与选型裁定

| # | 方案 | 轮子/先例 | VPS 侧改动 | 应用层鉴权落点 | 稳定性 | 主要风险 |
|---|---|---|---|---|---|---|
| a | **ws-tunnel 同构复制**：VPS 起 ws server(新端口)+gost，本机 ws client 反向推进 | ws-tunnel-node.js 是**正向**轮子，反向需 VPS 端新写 ws server+nginx 路由 | **大**：VPS 新服务 + nginx conf + 开机自启 | VPS 转发层可加 token | 链路最长（ws+nginx+gost+新服务） | VPS 侧新轮子=造轮子；nginx 改动面扩大 |
| b | **flatpak/system ssh -R**：本机 `ssh -R 127.0.0.1:8765:127.0.0.1:8765` 直连 | openssh 已装；但**本机 sshd 未跑**证明本机 SSH 服务形态不受信任 | sshd config 零变更（loopback 绑定） | 无转发层可挂（裸 TCP pipe），鉴权只能落在桥 | `ssh -R` 经 ws 隧道双层；开机存活靠 user 单元 | ExitOnForwardFailure 保活一般；本机 ssh 进程形态（无 sshd 常驻）= 形态不信任 |
| c | **ssh2 反向隧道轮子复制**（选定）：`.dsh-ssh/reverse-tunnel-443.js` 逐行复制 → env 白名单化，`forwardIn('127.0.0.1', 8765)`，VPS `127.0.0.1:8765` → 本机 8765 | **现成反向轮子，08-21 对同一台 VPS 实弹验证**；重连骨架抄 dsh-groq-tunnel.mjs（08-24 OOM 加固形态） | **零**（sshd 不动、nginx 不动、无新服务） | 转发层是裸 pipe 挂不了 → **鉴权落桥侧 Bearer**（最小 patch 稿，见 §5） | 链路=现有 20+ 天在跑的 SSH-over-443；keepalive 15s < nginx 300s | 长会话稳定性待落位实测（备 USE_EXEC_ANCHOR=1 回退开关） |

### 裁定：**方案 c**。理由（三行）：

1. **轮子现成且同构**：`reverse-tunnel-443.js` 就是「VPS loopback 端口 → 本机服务」的已验证实现，复制成本最低、偏离面最小（diff 只有 env 白名单+重连骨架）；方案 a 要在 VPS 造新 ws server = 造轮子，方案 b 依赖本机从未常驻过的 sshd 形态。
2. **VPS 侧零新攻击面**：`forwardIn('127.0.0.1', 8765)` 只开 VPS loopback；nginx/sshd/gost 全不动，回滚 = 杀一个本机进程。方案 a/b 都要动 VPS 配置。
3. **鉴权有干净落点**：桥侧 Bearer（§5）同时覆盖「隧道进来的流量」与「本机直连的第三方进程」，比 VPS 转发层鉴权覆盖面更完整。

---

## 3. 隧道脚本（已交付）

`deploy-staging/blender-bridge-tunnel/bridge-reverse-tunnel.js`：

- 基底 = `.dsh-ssh/reverse-tunnel-443.js`（交互逻辑逐行保留：ssh2 connect 参数、forwardIn、'tcp connection' → accept+pipe+cleanup）。
- 白名单改动（档内头注释同文）：①常数 env 化（`SSH_HOST/SSH_PORT/SSH_USER/KEY_PATH/REMOTE_BIND_PORT/LOCAL_TARGET_PORT`）——本地自测必须可指向临时 sshd，**禁碰 VPS 的片W 铁律**；②重连骨架抄 `dsh-groq-tunnel.mjs`（单一定时器/指数退避 2s→30s/ensureWsTunnel 自愈 22222）；③移除 `exec('sleep 3600')` 会话锚与 exit-on-close（原轮子一次性设计：sleep 3600 会每小时断一次，正在渲染的 job 可达 30 分钟会被杀；存活靠 keepaliveInterval 15s），`USE_EXEC_ANCHOR=1` 时回退原轮子锚。
- 端口裁定：`REMOTE_BIND_PORT=8765`——VPS 上 `BLENDER_BRIDGE_URL` 维持 `http://127.0.0.1:8765` **一字不改**（片G PATCH-PLAN §0 表第 6 行的 env 值因此零变更，两稿天然衔接）。若落位当天 VPS 本机 8765 已被占（可能性低，桥只在笔电跑），备选 `REMOTE_BIND_PORT=18765` + env 值同步改。

## 4. 本机与 VPS 两侧启动命令稿

### 本机侧（唯一要落地的机器）

```bash
# 0) 前提自检（都应已满足；ws-tunnel 22222 正在跑 PID 20094，dsh-groq-tunnel.service running）
ss -tln | grep 22222              # ws 隧道在
ss -tln | grep 8765               # blender-bridge 在（片A 交付）

# 1) 一次性生成隧道 token（存 ~/.config/blender-bridge-tunnel.env，600；不入 git/memory/log）
mkdir -p ~/.config && umask 077
{ [ -f ~/.config/blender-bridge-tunnel.env ] || echo "BLENDER_BRIDGE_TOKEN=$(openssl rand -hex 32)" > ~/.config/blender-bridge-tunnel.env; }
cat ~/.config/blender-bridge-tunnel.env   # 记下值：VPS .env 的 BLENDER_BRIDGE_TOKEN 用同一个

# 2) 手动试跑（先看日志再挂 systemd）
node /home/lenovo/Desktop/image-app/deploy-staging/blender-bridge-tunnel/bridge-reverse-tunnel.js &
# 预期日志：SSH ready → "reverse forward established: VPS 127.0.0.1:8765 -> laptop 127.0.0.1:8765"

# 3) systemd user 单元（开机自存活；形状同构 dsh-groq-tunnel.service）
cp /home/lenovo/Desktop/image-app/deploy-staging/blender-bridge-tunnel/blender-bridge-tunnel.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now blender-bridge-tunnel
journalctl --user -u blender-bridge-tunnel -n 20 --no-pager
# 单元自带 MemoryMax=512M 兜底（08-24 OOM 教训形态）；Restart=on-failure RestartSec=10
```

### VPS 侧（零改动；仅 env 一行，归执行片）

```bash
# /opt/agent-harness/.env 追加（片G PATCH-PLAN §2.5 命令同式追加）：
#   BLENDER_BRIDGE_URL=http://127.0.0.1:8765     ← 片G 稿已含，值不变
#   BLENDER_BRIDGE_TOKEN=<cat ~/.config/blender-bridge-tunnel.env 取的值>   ← 本片新增
# 桥侧 token（执行片落 /opt/blender-bridge 时）：
#   systemd 单元 Environment=BLENDER_BRIDGE_TOKEN=<同值>
#   （或 EnvironmentFile 指向同 token 的 600 env 档；永不明文入 log/memory/commit）
```

### 本机临时占位桥（VPS 侧桥未就位时的过渡）

落位当天若桥还没搬上 VPS：VPS 进程打 `127.0.0.1:8765` 会穿隧道打到**本机桥**（本机桥本来就在 8765）——即「渲染节点=笔电」形态立即可用，无需任何额外配置；桥上 VPS 后再杀本机隧道单元切换。这正是本隧道的主用途之一。

---

## 5. 鉴权设计（桥侧 Bearer 最小 patch 稿）

**问题**：桥 `server.py` 无鉴权（现场 500 行版，do_GET/do_POST 直通，L441-469）。隧道通到 VPS 后，VPS 上任何本机进程（含被 agent 沙箱跑出的东西）都能打 `127.0.0.1:8765` → 远程执行任意 bpy 代码 = 暴露面实质扩大。**裁定：鉴权落桥侧**（方案 c 转发层是裸 pipe 挂不了；桥侧还能同时覆盖本机直连方）。

**设计**：`BLENDER_BRIDGE_TOKEN` env；非空时所有请求（含 /v1/health）要求 `Authorization: Bearer <token>`，`hmac.compare_digest` 恒时比较；**空 = 行为完全不变**（本机 20 片交付工作流直接打 localhost 零冲击，向后兼容）。最小 diff 稿全文见 `patch-blender-auth.py` 头注释，要点：

- 三段锚点补丁（常数区/`_authorized()` 方法/do_GET+do_POST 入口 401 守卫），每段 `assert src.count(anchor)==1` 防误伤（opencode-autopsy 配方），自动备份 `.bak-auth-<ts>`。
- 基于现场 500 行版（片K 伫列/片N 分道/片Q 快照 diff 全在位）；执行片落位时若 server.py 又有新改动，锚点断言会拒绝补丁而不是错补。

**工具层同步（一句）**：桥启用 token 后，片G `blender_tools.ts` 的两处 fetch（`blenderExecute` 的 execute 与 health 探测）需加 `Authorization` header（值取 `process.env.BLENDER_BRIDGE_TOKEN`）——归片G 执行片的最小增补，**不改传输契约**，`blender-tools.ts`（本地直连形态）不动。

## 6. 与 blender-gateway/PATCH-PLAN.md 的衔接点

| 衔接点 | 本片提供 | 片G 稿现状 | 执行片动作 |
|---|---|---|---|
| `BLENDER_BRIDGE_URL` | **值不变** `http://127.0.0.1:8765`（远端绑定端口刻意同构） | §0 表第 6 行已写 | 零动作 |
| `BLENDER_BRIDGE_TOKEN` | 本片新增键 | 稿中无 | §2.5 式追加到 `/opt/agent-harness/.env`；blender_tools.ts 两 fetch 加 header |
| 桥 systemd（PATCH-PLAN §5「最大缺口待拍板」） | 本机形态=本片 user 单元（§4）；VPS 形态仍待拍板 | §5 明言不擅自装 | 不变，本片不代拍板 |
| smoke（§3.1 负例） | 隧道起来后负例会从 bridge_unavailable 变成真连接 | §3.1 预期「桥未启动→bridge_unavailable」 | **顺序提醒**：先跑 §3.1 负例（隧道未启时）验错误分类层，再起隧道跑正例 |

## 7. 回滚

```bash
# 本机（唯一常驻面）：一行
systemctl --user disable --now blender-bridge-tunnel && rm ~/.config/systemd/user/blender-bridge-tunnel.service
# 进程残留：pkill -f bridge-reverse-tunnel.js
# VPS：无任何本片改动，零回滚。若临时验证连了隧道，断开即恢复（forwardIn 随会话消失，不残留端口）。
# 桥 token 回退：VPS/桥 env 清掉 BLENDER_BRIDGE_TOKEN + 重启桥 → 恢复无鉴权原样（patch 脚本留 .bak-auth-*）。
```

## 8. 测试验证记录（2026-09-06 21:07-21:20 实测，命令输出原样摘录；未测边界如实标 §8.4）

### 8.1 鉴权 patch 实测（测试副本 /tmp/bl-w-test/，现场 server.py 零改动）

- 副本四档（server/launcher/blender_addon，端口改 18766）+ `python3 patch-blender-auth.py /tmp/bl-w-test/server.py` → `PATCH_OK backup=server.py.bak-auth-20260906-210653`，`py_compile` 过。
- **diff 白名单验证**（过滤 token 行后对比原版）：仅余「端口 8765→18766（测试用）+ 6 处 token 行（注释 3/方法 4/守卫 2）」——patch 无任何白名单外改动，交互逻辑（伫列/snapshot/超时）零偏离。

**token 空（向后兼容，本机 20 片工作流场景）**：

```
GET /v1/health → 200 {"ok": true, "blender_version": "5.2.1 LTS", "gpu": "egl",
                      "workdir": "/tmp/bl-w-test/work", "queue_depth": 0, "concurrency": 1}
POST /v1/execute {}（无头）→ 400 {"ok": false, "error": "bad request: body.script must be a non-empty string"}
```

**BLENDER_BRIDGE_TOKEN=tok12345（隧道模式三态）**：

```
无 Authorization        → HTTP 401 {"ok": false, "error": "unauthorized"}
Bearer WRONG            → HTTP 401 {"ok": false, "error": "unauthorized"}
Bearer tok12345 health  → HTTP 200（同上形状）
Bearer tok12345 execute → HTTP 200 {"ok": true, "artifacts": [], "scene_summary": "scene:Scene objects:3 …",
                           "stdout_tail": "…CUBE_V 3", "duration_ms": 36, "queued": false}
POST /v1/execute（无头）→ HTTP 401
```

= 真实 Blender 进程在 token 守卫后执行成功（非 mock），401 守卫先于业务分派。

### 8.2 隧道转发穿透实测（本机临时 sshd 2288 → 临时桥 18766）

- 临时 sshd（自建 host key `/tmp/sshd-w-hostkey`，仅 ed25519 pubkey）：`/usr/sbin/sshd -p 2288 -o ListenAddress=127.0.0.1 -o AllowTcpForwarding=yes …` → `Server listening on 127.0.0.1 port 2288`。
- 隧道：`SSH_PORT=2288 SSH_USER=lenovo KEY_PATH=~/.ssh/id_ed25519 REMOTE_BIND_PORT=18765 LOCAL_TARGET_PORT=18766 node bridge-reverse-tunnel.js` →
  `SSH ready` → `reverse forward established: VPS 127.0.0.1:18765 -> laptop 127.0.0.1:18766`（`ss -tln`：`127.0.0.1:18765 users:(("sshd-session",…))` 实锤 sshd 占位）。

**穿隧道三态（curl 打 127.0.0.1:18765）**：

```
无头            → HTTP 401 {"ok": false, "error": "unauthorized"}
Bearer tok12345 → HTTP 200 {"ok": true, "blender_version": "5.2.1 LTS", "gpu": "egl", …}
Bearer tok12345 execute {"script":"import bpy\nprint(\"TUNNEL_OK\", bpy.app.version_string)"}
                → HTTP 200 {"ok": true, "stdout_tail": "…TUNNEL_OK 5.2.1 LTS", "duration_ms": 43, …}
```

隧道日志同步印 `incoming tunnel connection from VPS (127.0.0.1:46xxx)` / `piped to local bridge`——accept+pipe 数据通路实证（原轮子「只 accept 不 pipe=黑洞」坑未复发）。**与生产链路唯一差异 = 中段是本机 sshd 而非 VPS sshd**（协议同构；VPS sshd 收 loopback forwardIn 已由 08-21 reverse-tunnel-443 实锤）。

### 8.3 自愈重连实测（模拟链路断）

- 杀 sshd 会话子进程（`sshd-session` postauth 两进程）→ 隧道日志：
  `disconnected (end), retry in 2000ms` → `disconnected (close), retry in 4000ms` → `SSH connect …` → `SSH ready` → `reverse forward established`——**指数退避重连+forward 重建全自动**（2s 退避起，无级联）。
- 自愈后再验：`curl -H "Authorization: Bearer tok12345" http://127.0.0.1:18765/v1/health` → HTTP 200。

### 8.4 片W 自伤事故（如实记录，现场已恢复）

- 清理测试进程时 `pkill -f "python3 server.py"` 把**正式桥一起杀了**（模式宽匹配撞上生产 cmdline；同场再加一锤：`pkill -f`/`pgrep -f` 的模式会匹配执行命令的 shell 自身，前轮已导致测试脚本静默不执行——与记忆「pgrep -f 自我匹配误报」同族）。
- 立即按 README 惯例重启正式桥并验证：`127.0.0.1:8765` 回到 LISTEN，`GET /v1/health` → `{"ok": true, "blender_version": "5.2.1 LTS", "gpu": "egl", "workdir": "/home/lenovo/Desktop/image-app/.blender-work", "queue_depth": 0, "concurrency": 1}`——**正式环境已恢复原状**（注意：恢复进程由本次会话手动拉起，非 systemd；若此前有其他守护方式请按原方式接管）。
- 测试副本与全部测试进程（2288/18765/18766）已清，正式 22222 隧道全程未动。

### 8.5 未测边界（留落位日）

1. **VPS sshd 真机 forwardIn 8765**：协议同构+08-21 先例+本轮 sshd-session 实证，但未对 VPS 实测（片W 禁 SSH）。落位第一条命令：`vps.py run "ss -tlnp | grep 8765"` 验 VPS 侧端口出现。
2. **长会话稳定性**（nginx /ssh `proxy_read_timeout 300s` 下数小时存活）：keepalive 15s 应覆盖（dsh-groq 同链 08-24 起长跑），无本脚本长跑数据；若 10-20 分钟被断，`USE_EXEC_ANCHOR=1` 回退原轮子锚再观察。
3. **片G blender_tools.ts 加 header 后的 VPS 端 fetch 行为**：属片G 执行片，本片只给增补语义（§5）。
