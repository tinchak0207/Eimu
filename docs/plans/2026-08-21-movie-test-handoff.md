# HANDOFF 2026-08-21 —「秦始皇骑北极熊电影」Agent 端到端测试（进行中，被生成管线故障阻塞）

## 任务定义
用 agent-debug 服务测试 prompt「生成一个秦始皇骑北极熊的电影」。
**成功标准：本地存在产出的 .mp4 档案。**

## 已完成的前置工作（本 session 早些时候，均已固化到 memory）
1. VPS 超载修复：dreamina-pool Chrome 常驻已杀（load 16→3.8，记忆 notes/2026-08-21-vps-overload-dreamina-chrome.md）。
2. agent-debug 调试服务已完成并验证：`tools/agent-debug.ts`（记忆 notes/2026-08-21-agent-debug-service.md）。用法：
   - `npx tsx tools/agent-debug.ts --keep --json /tmp/ev.json "消息"`
   - `npx tsx tools/agent-debug.ts --resume <sid> --watch --json /tmp/ev.json`（被动监看 5 分钟）
   - `--answer "选项"` / `--confirm`；resume 自带 last_event_id=0 重放全历史 + 保留会话。

## 测试进度（会话 d5fe0fb0-e5cc-4414-a2cd-f4e44a62a5e8，已 --keep 保留）
1. 发送 prompt → agent 问两题（一张卡 request_id=que_020e302b0001uccT8tJrmbDsLG）：
   视觉风格 + 影片规模。已用 curl 直接回答：
   `curl -X POST .../agent/v1/sessions/<sid>/question -d '{"request_id":"que_...","answers":[["写实史诗电影"],["多镜头短片（推荐）"]]}'` → {"ok":true}
2. Agent 建了工作流 **wf_mt1zhs9p_12**（custom）：
   - char_ref-0、scene_ref-1（gpt-image-2）
   - shot1-2 / shot2-3 / shot3-4 / shot4-5（kling-3.0，各 8 秒，4 镜）
   - 连线：char_ref+scene_ref → shot1/shot2/shot4；char_ref → shot3
3. **阻塞点（FACT）**：char_ref-0 于 04:42:16 poll timeout、scene_ref-1 于 04:44:17 poll timeout（gateway journalctl）。
   更早的 wf_mt1xo1z4_10 五个 video 节点也全部 poll timeout → workflow failed。
   → 工作流前两个「参考图」节点失败，后续 4 个影片节点不会跑。

## 根因（2026-08-21 下午已确诊，FACT）
- **worker 日志实证**：每次迭代都崩在 `TypeError: (0 , import_routing_telemetry.emitJobRoutingEvent) is not a function`
  （worker-service.ts:67/185）→ worker 收单即抛错，任务无人执行 → deadline_exceeded → refunded。
- **版本错配**：VPS `/opt/image-control-plane/app/src/lib/routing-telemetry.ts` 是旧版（0 处 emitJobRoutingEvent），
  worker-service.ts 是新版（4 处引用）——上次同步只带了部分档案。
- **全量 diff 实证**（md5 比对 src 树）：VPS 落后本地 60 档 + 缺 45 档（含 routing-telemetry.ts、channel-registry.ts、
  provider-config.ts 等）。supplier 健康栏位全绿是因为 adobe-health.ts 两版都同步过，与执行层无关。
- **修复动作**：本地 src 全量打包（.dsh-ssh/src-sync.tgz）→ SFTP 上传 → VPS 备份旧 src 后解压覆盖 →
  `docker compose -f control-plane-compose.yml build + up -d generation-worker` 重建（进行中）。

## 2026-08-21 下午进度：五层根因全破，管线已复甦（影片差临门一脚）

### 已修复并部署（FACT，全部实证）
1. **worker 版本错配**（原根因）：VPS src 落后本地 60 档+缺 45 档，worker-service 新/routing-telemetry 旧 →
   `emitJobRoutingEvent is not a function` 每迭代崩。修复：本地 src 全量打包上传 VPS 覆盖 + 重建 worker。
2. **success_rate_5m 死锁**：adobe-health.ts 只在上游 payload 带 rate 时覆写，种子写入的死值 0 永不重算；
   scheduler 门禁 (>=0.8) 永远挡 adobe2api。修复：adobe-health 每次探测从 supplier_health_event 5 分钟窗口重算
   （窗口空→rate=1）。已部署 VPS + DB 手动重置。本地 src/lib/generation-core/adobe-health.ts 同步改。
3. **Adobe 上游 451 地区封锁（image）**：adobe2api 直连 Adobe 得 451。修复：宿主 easy_proxies 代理池
   （/opt/easy-proxies，multi_port 已改 0.0.0.0:24000-24015 rotate，UFW 放行 172.16/12）+ adobe2api env
   `ADOBE_PROXY=http://172.19.0.1:24000`（env 覆盖 config；启动日志 "proxy disabled" 是 apply_config 先序化妆品输出，
   runtime 实测 AdobeClient().proxy 已生效）。image 实测 200 OK 出图 ×4。
4. **worker→adobe2api 走外部域名被 nginx 300s 切**：base_url 原为 https://store.tinchak0207.xyz/adobe2api/v1，
   nginx 在 300s 切断长连线（attempt latency 精确 300727ms "fetch failed"）。修复：
   DB `UPDATE supplier SET base_url='http://adobe2api:6001/v1'` + `/opt/image-control-plane/.env.control-plane`
   ADOBE2API_BASE_URL 同步改（防 seed 回滚）+ worker 重建。
5. **超时链全面放宽**：supplier-adapter.ts fetch 超时 video_generate 600s / image 100s（原单一 100s 必杀影片）；
   adobe2api ADOBE_GENERATE_TIMEOUT=600；gateway poll 预算 video 200×3s=600s / image 60×3s=180s + 每节点
   15s 进度事件（canvas.node.updated patch.progress={elapsed_seconds,eta_seconds,percent}，percent 封顶 95%）。
6. **agent 引擎模型**：deepseek-v4-flash-free 免费促销结束 → 换 opencode/x-preview-f-free（Ox Alpha Free），
   /opt/agent-harness/workspace/.opencode/opencode.json + restart opencode-server。Ox Alpha 建工作流质量良好。
   （opencode 模型清单：GET 4096/api/model，Basic auth opencode:harness-secret-2026）

### 影片最终结论（FACT，2026-08-21 晚定论）：Adobe 上游 408，本地无可修
- 容器内直接调 AdobeClient.generate_video（正确 catalog conf + 代理 + 健康帐号）：
  submit 持续即时 408 `{"error_code":"timeout_error","message":"system under load"}`（6 次实测）。
- 对比 image 同帐号同代理稳定 200 OK → **Adobe Firefly 3P 影片服务端负载/限流**。
- 早前的 300s timeout 已被超时修复排除；prompt_unsafe 451 已被去武器化 prompt 排除（安全 prompt 拿到过 upstream_job_id）。
- **结构性风险：全平台 video 模型只挂 env:adobe2api 单点**——Adobe 408 期间无任何影片能力。
- 动态实验脚本 .dsh-ssh/video-exp.py（docker cp 进容器跑，比读代码快）。

### 恢复步骤（下一 session 从这里接）
1. 先探 Adobe 影片是否恢复：`sudo docker exec adobe2api python3 /tmp/video-exp.py`（已在容器内）
   ——若仍 408 则 Adobe 端未恢复，等或换供应商；若 submit 成功会打印 SUCCESS + 耗时。
2. Adobe 恢复后：agent 会话 0d30c7fb-ea38-4af7-a9af-c068a77a2208（若 gateway 未重启仍在）resume；
   否则开新会话，prompt 要求镜头去武器化（无剑/无冲锋词）。
3. 下载 mp4：URL 相对路径前缀 https://image.tinchak0207.xyz → `curl -o qinshihuang-polar-bear.mp4 <url>`
4. 成功标准不变：本地存在非零 .mp4
5. 长期项：新增第二 video 供应商渠道去单点（PM 决策）

### 排障新增坑（本轮实测）
- `node` 不在默认 PATH：每条命令带 `export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"`
- /tmp 在 bash 调用间不持久，落盘用工作区 .dsh-ssh/
- 远端 nohup 后台进程随 SSH session 退出被杀：`sudo sh -c "setsid nohup ... < /dev/null &"`
- adobe2api 详错在 /opt/adobe2api/data/request_errors.jsonl（比 docker logs 信息全）
- health 的 accounts[] 每帐号有 cooldown_remaining_seconds / last_failure_category
- easy_proxies 池健康 4/13 可用（rotate 自动避坏节点）；管理面板 127.0.0.1:9091

## 环境坑（本 session 实测）
- SSH-over-443 隧道反覆 gost 卡死（Connection lost before handshake）：
  `pkill -f 'ssh.*22222'; bash .pixai-refresh/start-ssh443.sh; sleep 4; node .dsh-ssh/exec-443.js 'echo OK'`，
  不行就等 30-60s 重试；**多条命令合并进一次 exec** 减少往返。
- 22443 旧通道同样症状，别浪费时间。
- bash 工具间歇回 "clean — nothing to commit" / run_code "Expected ',', got '<eof>'"：
  重试＋简化 description＋带 workdir。
- gateway SSE 重放：events?ticket=X&last_event_id=0（支援，index.ts:594/2632）。
- gateway workflow poll 语义（index.ts ~L440-505）：提交 30s 超时；轮询 3s 间隔；
  image 预算 40 次=120s、video 100 次=300s；succeeded 取 data[0].url||result_url||url。
- gateway workflow status API：GET /agent/v1/workflow/status?workflow_id=（要 Bearer 真实 key，internal 无效）。

## 本 session 产物
- tools/agent-debug.ts（新，tsc 干净，冒烟通过）
- 记忆：notes/2026-08-21-vps-overload-dreamina-chrome.md、notes/2026-08-21-agent-debug-service.md、本档
- /tmp/qinsh*.log、/tmp/qinsh-events*.json（事件流存档）
