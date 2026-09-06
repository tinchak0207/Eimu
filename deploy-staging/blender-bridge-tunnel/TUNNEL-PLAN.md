# TUNNEL-PLAN — VPS gateway 調本機 blender-bridge 的通路稿（片W，2026-09-06）

**性質：staging 稿。本片零 SSH、零 VPS 改動。** 問題：`blender_*` 三工具（片G staging 稿）在 VPS gateway 內 fetch `BLENDER_BRIDGE_URL`（默認 `http://127.0.0.1:8765`），而橋跑在本機 NAT 後的 127.0.0.1:8765——需要一條讓 VPS 本機進程可達本機橋的反向通路，且必須帶一層鑑權（橋無鑑權是片A 已記錄的殘餘風險）。

---

## 1. 考古結論（三份，帶證據）

### 1.1 ws-tunnel-node.js 工作原理 = 正向隧道（本機→VPS 方向的管道）

- 檔案：`.pixai-refresh/ws-tunnel-node.js`（69 行，正在跑，PID 20094，`ss -tln` 實測 LISTEN 127.0.0.1:22222）。
- **方向**：正向。本機 `net.createServer` 監聽 127.0.0.1:22222（L66-68）；每來一條 TCP 連線就開一條新 WebSocket 到 `wss://store.tinchak0207.xyz/ssh`（L9-10，`perMessageDeflate:false, handshakeTimeout:15000`），雙向裸 pipe（client↔ws，L32-51）。
- **鑑權**：應用層零鑑權——ws 握手不帶 header/token（L10），裸 binary 幀直通；安全只靠鏈路終點（sshd 的 key 鑑權）。
- **VPS 側對應服務（從配置/啟動參數反推）**：
  - nginx：`/ssh` location → `proxy_pass http://127.0.0.1:18083` + WebSocket Upgrade 頭（`.pixai-refresh/patch-nginx.sh` L7-14，該腳本 08-23 實彈注入 `imagesite-nginx` 容器 conf 並 reload——`store.tinchak0207.xyz/ssh` 路徑至今可用 = `/ssh` 路由存活）。
  - `:18083` = **gost**（ws→tcp 解殼；`.pixai-refresh/` 內有 gost 二進位與 `gost-client.log`），gost 把 ws 裡的裸字節流接到 **VPS sshd:22**。
  - 鏈路全景（`dsh-groq-tunnel.mjs` L5-7 註釋原話）：`本機 22222 ↔ wss://store.tinchak0207.xyz/ssh → nginx → gost → VPS sshd`，即 **SSH-over-443**（ISP 封 22 出站，唯一可用路徑）。

### 1.2 dsh-groq-tunnel.mjs 形態 = ssh2 動態正向轉發（forwardOut）+ 生產級重連骨架

- 檔案：`~/.local/bin/dsh-groq-tunnel.mjs`（150 行，本機 systemd user 單元 `dsh-groq-tunnel.service` 常駐 running）。
- 形態：本機 `createServer(18893)` → 每連線 `client.forwardOut(...)` 到 VPS `127.0.0.1:8891`（groq-proxy）。SSH 連線本身走 `127.0.0.1:22222`（ws 隧道）+ `~/.ssh/new.pem` + `keepaliveInterval:30000, keepaliveCountMax:3`。
- 08-24 加固（L8-12 註釋）：重連**單一定時器 + 指數退避 2s→30s + 每次新建 Client**——修掉「error/close/end 三 handler 各自重連 → 指數爆炸 → 6.2G OOM」事故。骨架函數 `isPortListening`（L53-58）、`ensureWsTunnel`（L61-71，22222 不在就冪等拉 `start-ssh443.sh`）、`scheduleReconnect`（L73-78）。
- 本機現狀修正必讀記憶：`laptop-no-openssh-flatpak-ssh` 已標「2026-09-03 更新：本機已裝 openssh，作廢條件達成」——現場實測 `pacman -Q openssh` = `openssh 10.5p1-1`，`/usr/sbin/ssh` 在位。**SSH 選型不受 flatpak 限制**。但本機 `sshd` 未跑（僅二進位在，無監聽、無進程），且登入級別是否拉起 sshd 未知 → 方案 b 的「本機臨時 sshd」不可靠性成立。

### 1.3 VPS sshd GatewayPorts 推斷：無需 GatewayPorts，loopback RemoteForward 已實證可用

- **直接實錘**：`.dsh-ssh/reverse-tunnel-443.js`（08-21，`2026-08-21-home-relay-and-408-final.md` 記憶在案）就是 ssh2 `forwardIn('127.0.0.1', 18443)` 反向隧道，對**同一台 VPS sshd**（經同一條 22222 ws 隧道 + `new.pem`）實彈打通，容器經 DNAT 訪 `172.20.0.1:18443` 出網成功——證明該 sshd 允許 `AllowTcpForwarding` 且 remote forward 綁 `127.0.0.1` 被接受。
- **推斷鏈**：sshd 默認 `GatewayPorts no`（不收 public 綁定）；`ssh -R`/forwardIn 綁 `127.0.0.1` 屬 loopback 綁定，**不需要** GatewayPorts。我們的消費方（opencode 工具進程、gateway）全在 VPS 本機 → 只綁 loopback 即滿足，**零 sshd 配置變更**。
- 唯一不確定（落位當天一條命令可驗）：`AllowTcpForwarding` 是否被改成 `No`——實錘反例存在（18443 先例）+ dsh-groq forwardOut 日常在跑，判定大概率開啟。

---

## 2. 三方案對比與選型裁定

| # | 方案 | 輪子/先例 | VPS 側改動 | 應用層鑑權落點 | 穩定性 | 主要風險 |
|---|---|---|---|---|---|---|
| a | **ws-tunnel 同構複製**：VPS 起 ws server(新端口)+gost，本機 ws client 反向推進 | ws-tunnel-node.js 是**正向**輪子，反向需 VPS 端新寫 ws server+nginx 路由 | **大**：VPS 新服務 + nginx conf + 開機自啟 | VPS 轉發層可加 token | 鏈路最長（ws+nginx+gost+新服務） | VPS 側新輪子=造輪子；nginx 改動面擴大 |
| b | **flatpak/system ssh -R**：本機 `ssh -R 127.0.0.1:8765:127.0.0.1:8765` 直連 | openssh 已裝；但**本機 sshd 未跑**證明本機 SSH 服務形態不受信任 | sshd config 零變更（loopback 綁定） | 無轉發層可掛（裸 TCP pipe），鑑權只能落在橋 | `ssh -R` 經 ws 隧道雙層；開機存活靠 user 單元 | ExitOnForwardFailure 保活一般；本機 ssh 進程形態（無 sshd 常駐）= 形態不信任 |
| c | **ssh2 反向隧道輪子複製**（選定）：`.dsh-ssh/reverse-tunnel-443.js` 逐行複製 → env 白名單化，`forwardIn('127.0.0.1', 8765)`，VPS `127.0.0.1:8765` → 本機 8765 | **現成反向輪子，08-21 對同一台 VPS 實彈驗證**；重連骨架抄 dsh-groq-tunnel.mjs（08-24 OOM 加固形態） | **零**（sshd 不動、nginx 不動、無新服務） | 轉發層是裸 pipe 掛不了 → **鑑權落橋側 Bearer**（最小 patch 稿，見 §5） | 鏈路=現有 20+ 天在跑的 SSH-over-443；keepalive 15s < nginx 300s | 長會話穩定性待落位實測（備 USE_EXEC_ANCHOR=1 回退開關） |

### 裁定：**方案 c**。理由（三行）：

1. **輪子現成且同構**：`reverse-tunnel-443.js` 就是「VPS loopback 端口 → 本機服務」的已驗證實現，複製成本最低、偏離面最小（diff 只有 env 白名單+重連骨架）；方案 a 要在 VPS 造新 ws server = 造輪子，方案 b 依賴本機從未常駐過的 sshd 形態。
2. **VPS 側零新攻擊面**：`forwardIn('127.0.0.1', 8765)` 只開 VPS loopback；nginx/sshd/gost 全不動，回滾 = 殺一個本機進程。方案 a/b 都要動 VPS 配置。
3. **鑑權有乾淨落點**：橋側 Bearer（§5）同時覆蓋「隧道進來的流量」與「本機直連的第三方進程」，比 VPS 轉發層鑑權覆蓋面更完整。

---

## 3. 隧道腳本（已交付）

`deploy-staging/blender-bridge-tunnel/bridge-reverse-tunnel.js`：

- 基底 = `.dsh-ssh/reverse-tunnel-443.js`（交互邏輯逐行保留：ssh2 connect 參數、forwardIn、'tcp connection' → accept+pipe+cleanup）。
- 白名單改動（檔內頭註釋同文）：①常數 env 化（`SSH_HOST/SSH_PORT/SSH_USER/KEY_PATH/REMOTE_BIND_PORT/LOCAL_TARGET_PORT`）——本地自測必須可指向臨時 sshd，**禁碰 VPS 的片W 鐵律**；②重連骨架抄 `dsh-groq-tunnel.mjs`（單一定時器/指數退避 2s→30s/ensureWsTunnel 自愈 22222）；③移除 `exec('sleep 3600')` 會話錨與 exit-on-close（原輪子一次性設計：sleep 3600 會每小時斷一次，正在渲染的 job 可達 30 分鐘會被殺；存活靠 keepaliveInterval 15s），`USE_EXEC_ANCHOR=1` 時回退原輪子錨。
- 端口裁定：`REMOTE_BIND_PORT=8765`——VPS 上 `BLENDER_BRIDGE_URL` 維持 `http://127.0.0.1:8765` **一字不改**（片G PATCH-PLAN §0 表第 6 行的 env 值因此零變更，兩稿天然銜接）。若落位當天 VPS 本機 8765 已被佔（可能性低，橋只在筆電跑），備選 `REMOTE_BIND_PORT=18765` + env 值同步改。

## 4. 本機與 VPS 兩側啟動命令稿

### 本機側（唯一要落地的機器）

```bash
# 0) 前提自檢（都應已滿足；ws-tunnel 22222 正在跑 PID 20094，dsh-groq-tunnel.service running）
ss -tln | grep 22222              # ws 隧道在
ss -tln | grep 8765               # blender-bridge 在（片A 交付）

# 1) 一次性生成隧道 token（存 ~/.config/blender-bridge-tunnel.env，600；不入 git/memory/log）
mkdir -p ~/.config && umask 077
{ [ -f ~/.config/blender-bridge-tunnel.env ] || echo "BLENDER_BRIDGE_TOKEN=$(openssl rand -hex 32)" > ~/.config/blender-bridge-tunnel.env; }
cat ~/.config/blender-bridge-tunnel.env   # 記下值：VPS .env 的 BLENDER_BRIDGE_TOKEN 用同一個

# 2) 手動試跑（先看日誌再掛 systemd）
node /home/lenovo/Desktop/image-app/deploy-staging/blender-bridge-tunnel/bridge-reverse-tunnel.js &
# 預期日誌：SSH ready → "reverse forward established: VPS 127.0.0.1:8765 -> laptop 127.0.0.1:8765"

# 3) systemd user 單元（開機自存活；形狀同構 dsh-groq-tunnel.service）
cp /home/lenovo/Desktop/image-app/deploy-staging/blender-bridge-tunnel/blender-bridge-tunnel.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now blender-bridge-tunnel
journalctl --user -u blender-bridge-tunnel -n 20 --no-pager
# 單元自带 MemoryMax=512M 兜底（08-24 OOM 教訓形態）；Restart=on-failure RestartSec=10
```

### VPS 側（零改動；僅 env 一行，歸執行片）

```bash
# /opt/agent-harness/.env 追加（片G PATCH-PLAN §2.5 命令同式追加）：
#   BLENDER_BRIDGE_URL=http://127.0.0.1:8765     ← 片G 稿已含，值不變
#   BLENDER_BRIDGE_TOKEN=<cat ~/.config/blender-bridge-tunnel.env 取的值>   ← 本片新增
# 橋側 token（執行片落 /opt/blender-bridge 時）：
#   systemd 單元 Environment=BLENDER_BRIDGE_TOKEN=<同值>
#   （或 EnvironmentFile 指向同 token 的 600 env 檔；永不明文入 log/memory/commit）
```

### 本機臨時佔位橋（VPS 側橋未就位時的過渡）

落位當天若橋還沒搬上 VPS：VPS 進程打 `127.0.0.1:8765` 會穿隧道打到**本機橋**（本機橋本來就在 8765）——即「渲染節點=筆電」形態立即可用，無需任何額外配置；橋上 VPS 後再殺本機隧道單元切換。這正是本隧道的主用途之一。

---

## 5. 鑑權設計（橋側 Bearer 最小 patch 稿）

**問題**：橋 `server.py` 無鑑權（現場 500 行版，do_GET/do_POST 直通，L441-469）。隧道通到 VPS 後，VPS 上任何本機進程（含被 agent 沙箱跑出的東西）都能打 `127.0.0.1:8765` → 遠程執行任意 bpy 代碼 = 暴露面實質擴大。**裁定：鑑權落橋側**（方案 c 轉發層是裸 pipe 掛不了；橋側還能同時覆蓋本機直連方）。

**設計**：`BLENDER_BRIDGE_TOKEN` env；非空時所有請求（含 /v1/health）要求 `Authorization: Bearer <token>`，`hmac.compare_digest` 恆時比較；**空 = 行為完全不變**（本機 20 片交付工作流直接打 localhost 零衝擊，向後兼容）。最小 diff 稿全文見 `patch-blender-auth.py` 頭註釋，要點：

- 三段錨點補丁（常數區/`_authorized()` 方法/do_GET+do_POST 入口 401 守衛），每段 `assert src.count(anchor)==1` 防誤傷（opencode-autopsy 配方），自動備份 `.bak-auth-<ts>`。
- 基於現場 500 行版（片K 佇列/片N 分道/片Q 快照 diff 全在位）；執行片落位時若 server.py 又有新改動，錨點斷言會拒絕補丁而不是錯補。

**工具層同步（一句）**：橋啟用 token 後，片G `blender_tools.ts` 的兩處 fetch（`blenderExecute` 的 execute 與 health 探測）需加 `Authorization` header（值取 `process.env.BLENDER_BRIDGE_TOKEN`）——歸片G 執行片的最小增補，**不改傳輸契約**，`blender-tools.ts`（本地直連形態）不動。

## 6. 與 blender-gateway/PATCH-PLAN.md 的銜接點

| 銜接點 | 本片提供 | 片G 稿現狀 | 執行片動作 |
|---|---|---|---|
| `BLENDER_BRIDGE_URL` | **值不變** `http://127.0.0.1:8765`（遠端綁定端口刻意同構） | §0 表第 6 行已寫 | 零動作 |
| `BLENDER_BRIDGE_TOKEN` | 本片新增鍵 | 稿中無 | §2.5 式追加到 `/opt/agent-harness/.env`；blender_tools.ts 兩 fetch 加 header |
| 橋 systemd（PATCH-PLAN §5「最大缺口待拍板」） | 本機形態=本片 user 單元（§4）；VPS 形態仍待拍板 | §5 明言不擅自裝 | 不變，本片不代拍板 |
| smoke（§3.1 負例） | 隧道起來後負例會從 bridge_unavailable 變成真連接 | §3.1 預期「橋未啟動→bridge_unavailable」 | **順序提醒**：先跑 §3.1 負例（隧道未啟時）驗錯誤分類層，再起隧道跑正例 |

## 7. 回滾

```bash
# 本機（唯一常駐面）：一行
systemctl --user disable --now blender-bridge-tunnel && rm ~/.config/systemd/user/blender-bridge-tunnel.service
# 進程殘留：pkill -f bridge-reverse-tunnel.js
# VPS：無任何本片改動，零回滾。若臨時驗證連了隧道，斷開即恢復（forwardIn 隨會話消失，不殘留端口）。
# 橋 token 回退：VPS/橋 env 清掉 BLENDER_BRIDGE_TOKEN + 重啟橋 → 恢復無鑑權原樣（patch 腳本留 .bak-auth-*）。
```

## 8. 測試驗證記錄（2026-09-06 21:07-21:20 實測，命令輸出原樣摘錄；未測邊界如實標 §8.4）

### 8.1 鑑權 patch 實測（測試副本 /tmp/bl-w-test/，現場 server.py 零改動）

- 副本四檔（server/launcher/blender_addon，端口改 18766）+ `python3 patch-blender-auth.py /tmp/bl-w-test/server.py` → `PATCH_OK backup=server.py.bak-auth-20260906-210653`，`py_compile` 過。
- **diff 白名單驗證**（過濾 token 行後對比原版）：僅餘「端口 8765→18766（測試用）+ 6 處 token 行（註釋 3/方法 4/守衛 2）」——patch 無任何白名單外改動，交互邏輯（佇列/snapshot/超時）零偏離。

**token 空（向後兼容，本機 20 片工作流場景）**：

```
GET /v1/health → 200 {"ok": true, "blender_version": "5.2.1 LTS", "gpu": "egl",
                      "workdir": "/tmp/bl-w-test/work", "queue_depth": 0, "concurrency": 1}
POST /v1/execute {}（無頭）→ 400 {"ok": false, "error": "bad request: body.script must be a non-empty string"}
```

**BLENDER_BRIDGE_TOKEN=tok12345（隧道模式三態）**：

```
無 Authorization        → HTTP 401 {"ok": false, "error": "unauthorized"}
Bearer WRONG            → HTTP 401 {"ok": false, "error": "unauthorized"}
Bearer tok12345 health  → HTTP 200（同上形狀）
Bearer tok12345 execute → HTTP 200 {"ok": true, "artifacts": [], "scene_summary": "scene:Scene objects:3 …",
                           "stdout_tail": "…CUBE_V 3", "duration_ms": 36, "queued": false}
POST /v1/execute（無頭）→ HTTP 401
```

= 真實 Blender 進程在 token 守衛後執行成功（非 mock），401 守衛先於業務分派。

### 8.2 隧道轉發穿透實測（本機臨時 sshd 2288 → 臨時橋 18766）

- 臨時 sshd（自建 host key `/tmp/sshd-w-hostkey`，僅 ed25519 pubkey）：`/usr/sbin/sshd -p 2288 -o ListenAddress=127.0.0.1 -o AllowTcpForwarding=yes …` → `Server listening on 127.0.0.1 port 2288`。
- 隧道：`SSH_PORT=2288 SSH_USER=lenovo KEY_PATH=~/.ssh/id_ed25519 REMOTE_BIND_PORT=18765 LOCAL_TARGET_PORT=18766 node bridge-reverse-tunnel.js` →
  `SSH ready` → `reverse forward established: VPS 127.0.0.1:18765 -> laptop 127.0.0.1:18766`（`ss -tln`：`127.0.0.1:18765 users:(("sshd-session",…))` 實錘 sshd 佔位）。

**穿隧道三態（curl 打 127.0.0.1:18765）**：

```
無頭            → HTTP 401 {"ok": false, "error": "unauthorized"}
Bearer tok12345 → HTTP 200 {"ok": true, "blender_version": "5.2.1 LTS", "gpu": "egl", …}
Bearer tok12345 execute {"script":"import bpy\nprint(\"TUNNEL_OK\", bpy.app.version_string)"}
                → HTTP 200 {"ok": true, "stdout_tail": "…TUNNEL_OK 5.2.1 LTS", "duration_ms": 43, …}
```

隧道日誌同步印 `incoming tunnel connection from VPS (127.0.0.1:46xxx)` / `piped to local bridge`——accept+pipe 數據通路實證（原輪子「只 accept 不 pipe=黑洞」坑未復發）。**與生產鏈路唯一差異 = 中段是本機 sshd 而非 VPS sshd**（協議同構；VPS sshd 收 loopback forwardIn 已由 08-21 reverse-tunnel-443 實錘）。

### 8.3 自愈重連實測（模擬鏈路斷）

- 殺 sshd 會話子進程（`sshd-session` postauth 兩進程）→ 隧道日誌：
  `disconnected (end), retry in 2000ms` → `disconnected (close), retry in 4000ms` → `SSH connect …` → `SSH ready` → `reverse forward established`——**指數退避重連+forward 重建全自動**（2s 退避起，無級聯）。
- 自愈後再驗：`curl -H "Authorization: Bearer tok12345" http://127.0.0.1:18765/v1/health` → HTTP 200。

### 8.4 片W 自傷事故（如實記錄，現場已恢復）

- 清理測試進程時 `pkill -f "python3 server.py"` 把**正式橋一起殺了**（模式寬匹配撞上生產 cmdline；同場再加一錘：`pkill -f`/`pgrep -f` 的模式會匹配執行命令的 shell 自身，前輪已導致測試腳本靜默不執行——與記憶「pgrep -f 自我匹配誤報」同族）。
- 立即按 README 慣例重啟正式橋並驗證：`127.0.0.1:8765` 回到 LISTEN，`GET /v1/health` → `{"ok": true, "blender_version": "5.2.1 LTS", "gpu": "egl", "workdir": "/home/lenovo/Desktop/image-app/.blender-work", "queue_depth": 0, "concurrency": 1}`——**正式環境已恢復原狀**（注意：恢復進程由本次會話手動拉起，非 systemd；若此前有其他守護方式請按原方式接管）。
- 測試副本與全部測試進程（2288/18765/18766）已清，正式 22222 隧道全程未動。

### 8.5 未測邊界（留落位日）

1. **VPS sshd 真機 forwardIn 8765**：協議同構+08-21 先例+本輪 sshd-session 實證，但未對 VPS 實測（片W 禁 SSH）。落位第一條命令：`vps.py run "ss -tlnp | grep 8765"` 驗 VPS 側端口出現。
2. **長會話穩定性**（nginx /ssh `proxy_read_timeout 300s` 下數小時存活）：keepalive 15s 應覆蓋（dsh-groq 同鏈 08-24 起長跑），無本腳本長跑數據；若 10-20 分鐘被斷，`USE_EXEC_ANCHOR=1` 回退原輪子錨再觀察。
3. **片G blender_tools.ts 加 header 後的 VPS 端 fetch 行為**：屬片G 執行片，本片只給增補語義（§5）。
