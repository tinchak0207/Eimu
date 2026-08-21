# HANDOFF 2026-08-21 —「秦始皇騎北極熊電影」Agent 端到端測試（進行中，被生成管線故障阻塞）

## 任務定義
用 agent-debug 服務測試 prompt「生成一個秦始皇騎北極熊的電影」。
**成功標準：本地存在產出的 .mp4 檔案。**

## 已完成的前置工作（本 session 早些時候，均已固化到 memory）
1. VPS 超載修復：dreamina-pool Chrome 常駐已殺（load 16→3.8，記憶 notes/2026-08-21-vps-overload-dreamina-chrome.md）。
2. agent-debug 調試服務已完成並驗證：`tools/agent-debug.ts`（記憶 notes/2026-08-21-agent-debug-service.md）。用法：
   - `npx tsx tools/agent-debug.ts --keep --json /tmp/ev.json "消息"`
   - `npx tsx tools/agent-debug.ts --resume <sid> --watch --json /tmp/ev.json`（被動監看 5 分鐘）
   - `--answer "選項"` / `--confirm`；resume 自帶 last_event_id=0 重放全歷史 + 保留會話。

## 測試進度（會話 d5fe0fb0-e5cc-4414-a2cd-f4e44a62a5e8，已 --keep 保留）
1. 發送 prompt → agent 問兩題（一張卡 request_id=que_020e302b0001uccT8tJrmbDsLG）：
   視覺風格 + 影片規模。已用 curl 直接回答：
   `curl -X POST .../agent/v1/sessions/<sid>/question -d '{"request_id":"que_...","answers":[["寫實史詩電影"],["多鏡頭短片（推薦）"]]}'` → {"ok":true}
2. Agent 建了工作流 **wf_mt1zhs9p_12**（custom）：
   - char_ref-0、scene_ref-1（gpt-image-2）
   - shot1-2 / shot2-3 / shot3-4 / shot4-5（kling-3.0，各 8 秒，4 鏡）
   - 連線：char_ref+scene_ref → shot1/shot2/shot4；char_ref → shot3
3. **阻塞點（FACT）**：char_ref-0 於 04:42:16 poll timeout、scene_ref-1 於 04:44:17 poll timeout（gateway journalctl）。
   更早的 wf_mt1xo1z4_10 五個 video 節點也全部 poll timeout → workflow failed。
   → 工作流前兩個「參考圖」節點失敗，後續 4 個影片節點不會跑。

## 根因（2026-08-21 下午已確診，FACT）
- **worker 日誌實證**：每次迭代都崩在 `TypeError: (0 , import_routing_telemetry.emitJobRoutingEvent) is not a function`
  （worker-service.ts:67/185）→ worker 收單即拋錯，任務無人執行 → deadline_exceeded → refunded。
- **版本錯配**：VPS `/opt/image-control-plane/app/src/lib/routing-telemetry.ts` 是舊版（0 處 emitJobRoutingEvent），
  worker-service.ts 是新版（4 處引用）——上次同步只帶了部分檔案。
- **全量 diff 實證**（md5 比對 src 樹）：VPS 落後本地 60 檔 + 缺 45 檔（含 routing-telemetry.ts、channel-registry.ts、
  provider-config.ts 等）。supplier 健康欄位全綠是因為 adobe-health.ts 兩版都同步過，與執行層無關。
- **修復動作**：本地 src 全量打包（.dsh-ssh/src-sync.tgz）→ SFTP 上傳 → VPS 備份舊 src 後解壓覆蓋 →
  `docker compose -f control-plane-compose.yml build + up -d generation-worker` 重建（進行中）。

## 2026-08-21 下午進度：五層根因全破，管線已復甦（影片差臨門一腳）

### 已修復並部署（FACT，全部實證）
1. **worker 版本錯配**（原根因）：VPS src 落後本地 60 檔+缺 45 檔，worker-service 新/routing-telemetry 舊 →
   `emitJobRoutingEvent is not a function` 每迭代崩。修復：本地 src 全量打包上傳 VPS 覆蓋 + 重建 worker。
2. **success_rate_5m 死鎖**：adobe-health.ts 只在上游 payload 帶 rate 時覆寫，種子寫入的死值 0 永不重算；
   scheduler 門禁 (>=0.8) 永遠擋 adobe2api。修復：adobe-health 每次探測從 supplier_health_event 5 分鐘窗口重算
   （窗口空→rate=1）。已部署 VPS + DB 手動重置。本地 src/lib/generation-core/adobe-health.ts 同步改。
3. **Adobe 上游 451 地區封鎖（image）**：adobe2api 直連 Adobe 得 451。修復：宿主 easy_proxies 代理池
   （/opt/easy-proxies，multi_port 已改 0.0.0.0:24000-24015 rotate，UFW 放行 172.16/12）+ adobe2api env
   `ADOBE_PROXY=http://172.19.0.1:24000`（env 覆蓋 config；啟動日誌 "proxy disabled" 是 apply_config 先序化妝品輸出，
   runtime 實測 AdobeClient().proxy 已生效）。image 實測 200 OK 出圖 ×4。
4. **worker→adobe2api 走外部域名被 nginx 300s 切**：base_url 原為 https://store.tinchak0207.xyz/adobe2api/v1，
   nginx 在 300s 切斷長連線（attempt latency 精確 300727ms "fetch failed"）。修復：
   DB `UPDATE supplier SET base_url='http://adobe2api:6001/v1'` + `/opt/image-control-plane/.env.control-plane`
   ADOBE2API_BASE_URL 同步改（防 seed 回滾）+ worker 重建。
5. **超時鏈全面放寬**：supplier-adapter.ts fetch 超時 video_generate 600s / image 100s（原單一 100s 必殺影片）；
   adobe2api ADOBE_GENERATE_TIMEOUT=600；gateway poll 預算 video 200×3s=600s / image 60×3s=180s + 每節點
   15s 進度事件（canvas.node.updated patch.progress={elapsed_seconds,eta_seconds,percent}，percent 封頂 95%）。
6. **agent 引擎模型**：deepseek-v4-flash-free 免費促銷結束 → 換 opencode/x-preview-f-free（Ox Alpha Free），
   /opt/agent-harness/workspace/.opencode/opencode.json + restart opencode-server。Ox Alpha 建工作流質量良好。
   （opencode 模型清單：GET 4096/api/model，Basic auth opencode:harness-secret-2026）

### 影片最終結論（FACT，2026-08-21 晚定論）：Adobe 上游 408，本地無可修
- 容器內直接調 AdobeClient.generate_video（正確 catalog conf + 代理 + 健康帳號）：
  submit 持續即時 408 `{"error_code":"timeout_error","message":"system under load"}`（6 次實測）。
- 對比 image 同帳號同代理穩定 200 OK → **Adobe Firefly 3P 影片服務端負載/限流**。
- 早前的 300s timeout 已被超時修復排除；prompt_unsafe 451 已被去武器化 prompt 排除（安全 prompt 拿到過 upstream_job_id）。
- **結構性風險：全平台 video 模型只掛 env:adobe2api 單點**——Adobe 408 期間無任何影片能力。
- 動態實驗腳本 .dsh-ssh/video-exp.py（docker cp 進容器跑，比讀代碼快）。

### 恢復步驟（下一 session 從這裡接）
1. 先探 Adobe 影片是否恢復：`sudo docker exec adobe2api python3 /tmp/video-exp.py`（已在容器內）
   ——若仍 408 則 Adobe 端未恢復，等或換供應商；若 submit 成功會打印 SUCCESS + 耗時。
2. Adobe 恢復後：agent 會話 0d30c7fb-ea38-4af7-a9af-c068a77a2208（若 gateway 未重啟仍在）resume；
   否則開新會話，prompt 要求鏡頭去武器化（無劍/無衝鋒詞）。
3. 下載 mp4：URL 相對路徑前綴 https://image.tinchak0207.xyz → `curl -o qinshihuang-polar-bear.mp4 <url>`
4. 成功標準不變：本地存在非零 .mp4
5. 長期項：新增第二 video 供應商渠道去單點（PM 決策）

### 排障新增坑（本輪實測）
- `node` 不在默認 PATH：每條命令帶 `export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"`
- /tmp 在 bash 調用間不持久，落盤用工作區 .dsh-ssh/
- 遠端 nohup 後台進程隨 SSH session 退出被殺：`sudo sh -c "setsid nohup ... < /dev/null &"`
- adobe2api 詳錯在 /opt/adobe2api/data/request_errors.jsonl（比 docker logs 信息全）
- health 的 accounts[] 每帳號有 cooldown_remaining_seconds / last_failure_category
- easy_proxies 池健康 4/13 可用（rotate 自動避壞節點）；管理面板 127.0.0.1:9091

## 環境坑（本 session 實測）
- SSH-over-443 隧道反覆 gost 卡死（Connection lost before handshake）：
  `pkill -f 'ssh.*22222'; bash .pixai-refresh/start-ssh443.sh; sleep 4; node .dsh-ssh/exec-443.js 'echo OK'`，
  不行就等 30-60s 重試；**多條命令合併進一次 exec** 減少往返。
- 22443 舊通道同樣症狀，別浪費時間。
- bash 工具間歇回 "clean — nothing to commit" / run_code "Expected ',', got '<eof>'"：
  重試＋簡化 description＋帶 workdir。
- gateway SSE 重放：events?ticket=X&last_event_id=0（支援，index.ts:594/2632）。
- gateway workflow poll 語義（index.ts ~L440-505）：提交 30s 超時；輪詢 3s 間隔；
  image 預算 40 次=120s、video 100 次=300s；succeeded 取 data[0].url||result_url||url。
- gateway workflow status API：GET /agent/v1/workflow/status?workflow_id=（要 Bearer 真實 key，internal 無效）。

## 本 session 產物
- tools/agent-debug.ts（新，tsc 乾淨，冒煙通過）
- 記憶：notes/2026-08-21-vps-overload-dreamina-chrome.md、notes/2026-08-21-agent-debug-service.md、本檔
- /tmp/qinsh*.log、/tmp/qinsh-events*.json（事件流存檔）
