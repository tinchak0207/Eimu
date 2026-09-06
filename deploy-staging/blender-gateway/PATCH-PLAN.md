# PATCH-PLAN — blender_* 三工具 VPS gateway 落位稿（片G，2026-09-06）

**性質：staging 稿，本片未上 VPS（零 SSH）。** 行為真源 `src/lib/blender-tools.ts`；opencode 形狀稿 `deploy-staging/blender-gateway/blender_tools.ts`（= VPS 端 `lib/blender-tools-impl.ts` 整份內容）。橋（`bridge/blender-bridge/`，片A 交付）本機已驗收，VPS 側進程管理待拍板（見 §5）。

配方依據：記憶 `opencode-autopsy-gateway-surgery-recipe`（tee 中轉→python 補丁→bun build→重啟→journalctl）、`agent-harness-deny-table-architecture`（deny 真源/gateway 60s 自讀）、`2026-09-02-director-tools-piece4-deploy`（tools+lib 落位 install 644、/tmp sftp 限制、bun 直調 smoke、restart opencode-server 才生效）。

## 0. 落位點總表（每檔放哪）

| # | staging 檔 / 內容來源 | VPS 落位路徑 | 動作 | 屬主/權限 |
|---|---|---|---|---|
| 1 | `blender_tools.ts`（整份） | `/opt/agent-harness/workspace/.opencode/lib/blender-tools-impl.ts` | 新增 | root 644 |
| 2 | adapter blender_exec | `/opt/agent-harness/workspace/.opencode/tools/blender_exec.ts` | 新增 | root 644 |
| 3 | adapter blender_render | `/opt/agent-harness/workspace/.opencode/tools/blender_render.ts` | 新增 | root 644 |
| 4 | adapter blender_export_gltf | `/opt/agent-harness/workspace/.opencode/tools/blender_export_gltf.ts` | 新增 | root 644 |
| 5 | `bridge/blender-bridge/`（4 檔：blender_addon.py / launcher.py / server.py / README.md） | `/opt/blender-bridge/`（建議；見 §5 待拍板） | 新增 | root 644 |
| 6 | env 兩鍵 | `/opt/agent-harness/.env` 追加 `BLENDER_BRIDGE_URL=http://127.0.0.1:8765`（`BLENDER_BIN` 見 §5） | 追加 | — |

- **註冊表不需要加 id**：opencode 工具註冊是目錄掃描制（`.opencode/tools/*.ts` 落檔即註冊），無 id 清單檔要改。本地 `src/lib/harness-tool-registry.ts` 已含 `blender_exec/blender_export_gltf/blender_render`（P0-4 片C 已登記，VPS 同步屬 repo deploy 流程，不在本片）。
- `.opencode/` 目錄 sftp 直接寫會 Permission denied——一律先落 `/tmp` 再 `sudo cp`（記憶 director R1）。

三個 adapter 檔內容（各 2 行，形狀同構 director_*.ts 的靜態 import + export default；交互邏輯零新增）：

```ts
// blender_exec.ts
import { blenderExecTool } from "../lib/blender-tools-impl"
export default blenderExecTool
```
```ts
// blender_render.ts
import { blenderRenderTool } from "../lib/blender-tools-impl"
export default blenderRenderTool
```
```ts
// blender_export_gltf.ts
import { blenderExportGltfTool } from "../lib/blender-tools-impl"
export default blenderExportGltfTool
```

## 1. 本地預檢（上 VPS 前做完）

```bash
# 隔離 tsc（已在本片驗證 TSC_OK；工具缺 @opencode-ai/plugin 時 stub 如實記錄）
mkdir -p /tmp/bl-tsc && cp deploy-staging/blender-gateway/blender_tools.ts /tmp/bl-tsc/
printf 'declare module "@opencode-ai/plugin/tool" {\n  export const tool: any\n}\n' > /tmp/bl-tsc/stub.d.ts
cd /tmp/bl-tsc && /home/lenovo/Desktop/image-app/node_modules/.bin/tsc --noEmit --skipLibCheck --strict \
  --target es2022 --module esnext --moduleResolution bundler --lib es2022,dom \
  --typeRoots /home/lenovo/Desktop/image-app/node_modules/@types --types node \
  blender_tools.ts stub.d.ts
```

## 2. Patch 命令稿（opencode-autopsy 配方全照；假設本地檔已在工作目錄）

```bash
# 2.1 備份（工具目錄現狀 + .env；lib/blender-tools-impl.ts 是新增檔無需備份）
vps.py run "sudo cp -a /opt/agent-harness/workspace/.opencode/tools /tmp/tools.bak-MMDD-blender"
vps.py run "sudo cp /opt/agent-harness/.env /tmp/env.bak-MMDD-blender"

# 2.2 上傳到 /tmp（.opencode 下 sftp 直寫會 Permission denied，必經 /tmp 中轉）
vps.py put deploy-staging/blender-gateway/blender_tools.ts /tmp/blender-tools-impl.ts
# （三個 adapter 內容極短，用 base64 單命令寫入 /tmp；SSH-443 管道會卡死，禁 scp）
vps.py run "printf 'import { blenderExecTool } from \"../lib/blender-tools-impl\"\nexport default blenderExecTool\n' > /tmp/bl_adapter_exec.ts"
vps.py run "printf 'import { blenderRenderTool } from \"../lib/blender-tools-impl\"\nexport default blenderRenderTool\n' > /tmp/bl_adapter_render.ts"
vps.py run "printf 'import { blenderExportGltfTool } from \"../lib/blender-tools-impl\"\nexport default blenderExportGltfTool\n' > /tmp/bl_adapter_gltf.ts"
# （橋 4 檔由片A 交付物同法 put 到 /tmp，命令從略——server.py/blender_addon.py/launcher.py/README.md）

# 2.3 編譯驗證先於落位重啟（bun 不在 sudo PATH；--target=bun 鐵律，記憶 director 片3 坑）
vps.py run "export PATH=\$PATH:/home/ubuntu/.bun/bin && bun build /tmp/blender-tools-impl.ts --target=bun --outfile=/tmp/bl-impl-check.js && bun build /tmp/bl_adapter_exec.ts --target=bun --outfile=/tmp/bl-exec-check.js && bun build /tmp/bl_adapter_render.ts --target=bun --outfile=/tmp/bl-render-check.js && bun build /tmp/bl_adapter_gltf.ts --target=bun --outfile=/tmp/bl-gltf-check.js && echo BUILD_OK"

# 2.4 落位（install 644 照 director 片4 範式；sudo cp 勿用 sudo cat > 重定向——會 Permission denied）
vps.py run "sudo install -m 644 /tmp/blender-tools-impl.ts /opt/agent-harness/workspace/.opencode/lib/blender-tools-impl.ts"
vps.py run "sudo install -m 644 /tmp/bl_adapter_exec.ts /opt/agent-harness/workspace/.opencode/tools/blender_exec.ts"
vps.py run "sudo install -m 644 /tmp/bl_adapter_render.ts /opt/agent-harness/workspace/.opencode/tools/blender_render.ts"
vps.py run "sudo install -m 644 /tmp/bl_adapter_gltf.ts /opt/agent-harness/workspace/.opencode/tools/blender_export_gltf.ts"

# 2.5 env 追加（冪等：grep 有則跳過）
vps.py run "grep -q BLENDER_BRIDGE_URL /opt/agent-harness/.env || echo 'BLENDER_BRIDGE_URL=http://127.0.0.1:8765' | sudo tee -a /opt/agent-harness/.env >/dev/null"

# 2.6 opencode-server 重啟（工具層新檔必 restart 才生效——第三次實錘的鐵律）
vps.py run "sudo systemctl restart opencode-server"
vps.py run "journalctl -u opencode-server -n 50 --no-pager | grep -iE 'error|blender' ; echo journal_done"

# 2.7 活體註冊確認
vps.py run "sudo bash -c 'set -a; source /opt/agent-harness/.env; set +a; curl -s -u opencode:\$OPENCODE_SERVER_PASSWORD \"\$OPENCODE_URL/experimental/tool/ids?directory=/opt/agent-harness/workspace\"'" | grep -oE 'blender_[a-z_]+' | sort -u
# 預期三行：blender_exec / blender_render / blender_export_gltf
```

## 3. Smoke（橋就緒後；橋未上線則只跑 3.1 的負例）

```bash
# 3.1 負例（不依賴橋）：bun 直調，橋關閉 → 必得 bridge_unavailable 人話錯誤（驗證錯誤分類層）
vps.py run "export PATH=\$PATH:/home/ubuntu/.bun/bin && cd /opt/agent-harness/workspace/.opencode && sudo env HARNESS_API_KEY=\$(sudo grep '^HARNESS_API_KEY=' /opt/agent-harness/.env | cut -d= -f2) bun -e 'const m = await import(\"/opt/agent-harness/workspace/.opencode/lib/blender-tools-impl.ts\"); const r = await m.blenderExecTool.execute({script:\"import bpy\\nprint(1)\"}, {sessionID:\"sm-bl\", abort:undefined}); const o = JSON.parse(r.output); console.log(r.title, o.ok, o.error.code)'"
# 預期輸出：失败 false bridge_unavailable（若橋已起則 true）
# 坑：execute 返回 {title, output}，output 是 JSON 字串，必 JSON.parse（director 片4 坑②）

# 3.2 正例（橋已在 VPS 跑起，GET /v1/health 返回 200 後）：
#   blender_exec：cube + 骨架 keyframe 小腳本 → ok:true artifacts.length>=0
#   blender_render：eevee 單幀 → artifacts 含 png
#   blender_render：turntable=true → artifacts 含 mp4
#   blender_export_gltf：默認 glb → artifacts 含 glb
#   invalid_args 負例：render_engine="octane" → invalid_args 不發網絡請求
```

## 4. deny 例外清單（從 docs/blender-bridge-notes.md §5 繼承，VPS 側表述）

deny 表唯一真源 = `/opt/agent-harness/workspace/.opencode/opencode.json` 的 `permission.bash`；gateway 每 60s 自動重讀，**改表不重啟 gateway**。本片結論：

1. **本工具族零 deny 變更**：opencode 工具執行是 node 進程內 fetch（127.0.0.1:8765），不經 bash permission 表。
2. **不新增任何 deny**：blender 工具族無需收緊的 bash 面；主機破壞紅線（sudo/dd/systemctl 等）維持現狀。
3. **條件項（僅當回退「預設 deny + 白名單」時才加）**：agent 用 bash 直跑 Blender CLI 需 `"blender *": "allow"`，並確認 `*blender-bridge*` 啟動命令放行。現行 live 表（08-29 後預設 allow + 紅線 deny）下無需動作。落位驗收時照 notes §6 對賬一次 live opencode.json 防漂移。
4. 橋側安全（綁 127.0.0.1 禁 0.0.0.0、bpy blocklist）屬片A 橋施工職責，非 deny 表條目。

## 5. 橋的 VPS 側依賴聲明

- **橋代碼**：`bridge/blender-bridge/` 四檔（blender_addon.py 4164 行 blender-mcp 白名單版 / launcher.py / server.py / README.md）→ 建議落 `/opt/blender-bridge/`。本機驗收事實：health 5.2.1+egl、Eevee PNG 3.7s、timeout killpg 自動重啟、netns 攔 urllib。
- **Blender 二進制**：VPS 需 Blender 5.2.1 LTS（本機路徑 `~/Applications/blender-5.2*-linux-x64/`，server.py 經 `BLENDER_BIN` env 抓位址）。**VPS 安裝法（壓縮包/系統包）待拍板**，不擅自裝。
- **GPU 節點**：VPS（騰訊雲）大概率無 NVIDIA EGL headless 條件，health 會回 `gpu:"cpu"`，cycles 檔基本不可用（eevee CPU 快稿可跑但慢）。**是否要獨立 GPU 節點（何機/如何接入/BLENDER_BRIDGE_URL 指向哪）列為待拍板不解決**。
- **橋進程管理**（本片最大缺口，待拍板）：`server.py` 目前是裸 `python3` 前台進程。VPS 側方案候選：systemd 單元（如 `blender-bridge.service`，`Restart=on-failure`，`Environment=BLENDER_BIN=… BLENDER_WORK=/opt/blender-bridge/work`）或 tmux 常駐——**按何種方式跑、`BLENDER_WORK` 放哪、是否 `unshare -rn`（VPS 內核 user-namespace 可用性未驗證）均待拍板**。拍板前 smoke 只能跑 §3.1 負例。
- **端口**：8765（橋 HTTP，必綁 loopback）+ 9876（addon，netns 內）；皆 localhost only，無鑑權，不對外開。
- **恢復語義**：橋 timeout 殺 blender 後下次請求自動重啟全新 factory-startup 實例；工具層無狀態，無需跨進程恢復。

## 6. 回滾稿

```bash
# 一行還原（MMDD 換 2.1 實際日期戳）：刪四新檔 + 還原 .env + 重啟 opencode-server
vps.py run "sudo rm -f /opt/agent-harness/workspace/.opencode/tools/blender_exec.ts /opt/agent-harness/workspace/.opencode/tools/blender_render.ts /opt/agent-harness/workspace/.opencode/tools/blender_export_gltf.ts /opt/agent-harness/workspace/.opencode/lib/blender-tools-impl.ts && sudo cp /tmp/env.bak-MMDD-blender /opt/agent-harness/.env && sudo systemctl restart opencode-server && journalctl -u opencode-server -n 20 --no-pager | tail -5"
# 橋側回滾：sudo systemctl stop blender-bridge（或殺 tmux/python3 進程）+ sudo rm -rf /opt/blender-bridge
# tools 目錄整體還原（若 adapter 之外有意外改動）：sudo rm -rf .opencode/tools && sudo cp -a /tmp/tools.bak-MMDD-blender .opencode/tools
```

## 7. 驗收對賬（上線當天照 docs/blender-bridge-notes.md §6 跑）

- [ ] 橋 GET /v1/health 200 且 gpu 欄位非空
- [ ] 三檔落位 + opencode-server 重啟 journalctl 零錯
- [ ] `/experimental/tool/ids` 列出三 id
- [ ] bun 直調 smoke 負例（bridge_unavailable）+ 正例三工具真產物
- [ ] live opencode.json deny 對賬
