# 代理池輪換管理 — 交付說明（adobe2api）

交付目錄：`.dsh-adobe-pool/`
- `proxy_pool.py` — 新模塊，線程安全代理池（輪換 + 失敗冷卻 + 後台健康探測）
- `adobe_client.py` — 基於 `adobe_client_current.py`（1849 行）的最小侵入修改版
- `CHANGES.md` — 本文件

基線：`.dsh-ssh/adobe_client_current.py`（sha256 見部署備份步驟）。修改後 adobe_client.py 共 2037 行，全部新增集中在文件頭部 import、`__init__` 一行、三個新私有方法、三個輔助方法簽名、六個發送站點。**Adobe 協議邏輯（URL / headers / nonce / token 選擇 / 重試編排 / should_retry_temporary_error）零改動。**

---

## 1. proxy_pool.py 公開介面

### 環境變數（全部有界，缺省即預設值）

| 變數 | 預設 | 說明 |
|---|---|---|
| `ADOBE_PROXY_POOL` | （空） | 逗號分隔代理 URL。未設/空 = **池停用**，完全向後相容 |
| `PROXY_NETWORK_COOLDOWN_SECONDS` | 90 | 網絡類失敗冷卻（1–86400） |
| `PROXY_RISK_COOLDOWN_SECONDS` | 1800 | 風控類失敗冷卻（1–86400） |
| `PROXY_RISK_STATUS_CODES` | "408,429" | 記為風控類的上游狀態碼 |
| `PROXY_MAX_FAILURES_BEFORE_COOLDOWN` | 2 | 網絡類連續失敗閾值（1–100） |
| `PROXY_HEALTH_PROBE_INTERVAL` | 300 | 後台探測週期秒（10–86400） |
| `PROXY_PROBE_TIMEOUT_SECONDS` | 5 | 探測超時（1–60） |
| `PROXY_ALLOW_DIRECT` | 0 | 池啟用時是否允許回落直連 |

### 類與方法

- `ProxyPool(proxy_urls, *, network_cooldown_seconds=90, risk_cooldown_seconds=1800, risk_status_codes={408,429}, max_failures_before_cooldown=2, health_probe_interval=300, probe_timeout_seconds=5, allow_direct=False, probe_url="https://api64.ipify.org")`
  - 屬性 `enabled: bool`（空列表 = False，一切方法 no-op）
  - `pick() -> str`：過濾 cooldown/unhealthy（unknown/healthy 可選），按 `last_used_at` 最舊優先自然輪換（pick 時即更新 `last_used_at`）；無可用時：`allow_direct=1` 返回 `""`（直連），否則返回最早解凍者並 log warning（永不回落直連）
  - `report_success(url)`：清零失敗計數、status=healthy
  - `report_network_failure(url)`：consecutive_failures++，達閾值（預設 2）進 NETWORK 冷卻
  - `report_risk_failure(url)`：立即 RISK 冷卻、risk_count++
  - `snapshot() -> list[dict]`：每代理 `{url, status, consecutive_failures, risk_count, last_used_at, last_exit_ip, cooldown_until, cooldown_remaining_seconds}`，供觀測介面
  - `shutdown()`：停止後台探測線程（best effort）
- 後台 daemon 線程（僅池啟用時啟動）：啟動時 ThreadPoolExecutor 並行探測全部代理（requests + proxies 參數，經 https://api64.ipify.org 記錄出口 IP），之後每個週期重探 unknown/unhealthy（含剛解凍者，冷卻到期在週期開始時惰性轉為 unknown）。探測成功→healthy + exit_ip，失敗→unhealthy。探測全程 try/except，**任何失敗不拋異常、不影響主流程**。
- 模塊級單例 `get_proxy_pool() -> ProxyPool`：讀環境變數惰性構建（雙檢鎖）。**import 本模塊零副作用**；未配置時返回停用池。
- 狀態機：`unknown`（初始，可選、會被探測）→ `healthy` ⇄ `cooldown`（到期轉 unknown）→ …；`unhealthy` 僅由探測失敗產生，靠探測恢復。
- 日誌：`logging.getLogger(__name__)`；pick 變化、冷卻觸發、探測結果、池耗盡兜底各一行簡潔日誌。

---

## 2. adobe_client.py 逐處修改點

（行號為修改後文件行號；基線行號 = 修改前行號）

| # | 位置（新行號） | 修改內容 |
|---|---|---|
| a | L23–30（基線 L21 後新增） | 頭部容錯導入：先嘗試 `from proxy_pool import get_proxy_pool`，ImportError 再嘗試 `from .proxy_pool import get_proxy_pool`，仍失敗置 `get_proxy_pool = None`（缺失模塊時行為與原版完全一致） |
| b1 | L139（基線 L130 後新增一行） | `__init__` 增加 `self.pool_risk_status_codes = self._parse_pool_risk_status_codes()`（從 `PROXY_RISK_STATUS_CODES` 解析一次，默認 {408,429}，越界/非法項丟棄，全非法回退默認） |
| b2 | L284–318（基線 L275 前新增三方法） | `_parse_pool_risk_status_codes()`；\_pool_pick()\_（池啟用→`pool.pick() or self.proxy`；未啟用/異常→`self.proxy`）；\_pool_report(proxy_url, ok, kind="network", status_code=None)\_（僅當池啟用且 proxy_url 非空且 ≠ 靜態 `self.proxy` 才上報；ok=True→report_success，kind="risk"→report_risk_failure，否則 report_network_failure；全程 try/except 不影響主流程） |
| c1 | L346–349（基線 L275–278） | `_requests_proxies(self, proxy: str = "")`：內部 `effective_proxy = proxy or self.proxy`，無參調用行為不變 |
| c2 | L349–373（基線 L280–303） | `_session(self, proxy: str = "")`：簽名鍵與 `kwargs["proxies"]` 均改用 `effective_proxy`（代理變更仍自動重建 thread-local 會話） |
| c3 | L375–386（基線 L305–317） | `_requests_session(self, proxy: str = "")`：簽名鍵與 `session.proxies` 均改用 `effective_proxy` |
| d1 | L473–572（基線 L402–465） | **\_post_json\_**：首行 `proxy = self._pool_pick()`；全部 `self._session()`→`self._session(proxy)`、`self._requests_proxies()`→`(proxy)`、`self._requests_session()`→`(proxy)`（含 451 回退分支，共 2 處 requests 調用）；主 curl 路徑拿到 resp 後、**451 分支前**插入上報 `ok=(resp.status_code<400)`、kind=風控碼判斷；451 回退 requests 的返回值也捕獲 resp 並上報（成功即清失敗計數）；4 個 requests except 分支（timeout/proxy/connection/network）與主 curl except 分支（\_classify_network_error_type）均在 raise 前上報 |
| d2 | L568–627（基線 L467–501） | **\_post_bytes\_**：同 d1 模式（無 451 分支）；主路徑 return resp 前上報；兩類 except 各上報 |
| d3 | L623–681（基線 L503–537） | **\_put_bytes\_**：同 d1 模式 |
| d4 | L678–735（基線 L539–572） | **\_get\_**：同 d1 模式（\_get_json\_ 內部調 `_get`，故此層上報即覆蓋全部輪詢路徑；408/429 響應在此層以 kind="risk" 上報） |
| d5 | L732–789（基線 L574–607） | **\_delete\_**：同 d1 模式 |
| d6 | L813–859（基線 L628–665） | **\_download_to_file\_**：首行 pick；`_requests_session(proxy).get(..., proxies=self._requests_proxies(proxy), stream=True)`；成功下載完成後上報 ok=True；4 個 except 分支在 raise 前上報（RequestException 分支從 `exc.response.status_code` 提取狀態碼判斷風控） |

統計：`_pool_pick()` 調用 6 處、`_pool_report(...)` 調用 46 處、`_session(proxy)` 12 處、`_requests_proxies(proxy)` 7 處、`_requests_session(proxy)` 7 處。

### 未改動（明確列出）
- submit/poll/download 的 URL、headers 構造、nonce（\_build_submit_nonce）、token 選擇邏輯：零改動
- `should_retry_temporary_error` 與 `retry_on_status_codes` 默認值：零改動（408/429 重試由配置層控制，本次不動）
- `apply_config` / 環境變數 ADOBE_PROXY 靜態代理語義：零改動（池停用時 `_pool_pick()` 恰等於 `self.proxy`）

### 順手清理（偏離規格項之一）
- 基線副本尾部帶採集殘渣 `\nEXIT 0\n`（exec 腳本輸出尾巴），已刪除；行尾 CRLF 正規化為 LF。Python 語義不受影響。

---

## 3. 部署步驟（VPS）

0. 隧道：`bash .pixai-refresh/start-ssh443.sh`（本機），之後所有 VPS 命令經 `node .dsh-ssh/exec-443.js "<cmd>"`；文件傳輸用 `scp -P 22222 <file> <user>@127.0.0.1:<vps路徑>`
1. 定位 adobe2api 源碼目錄（若未記錄）：
   `sudo docker inspect adobe2api --format '{{json .Config.Labels}}' | grep -o 'com.docker.compose.project.working_dir[^,]*'`
   adobe_client.py 在該 compose 項目的應用源碼內（與 `core/` 包同級或其內，視項目結構）。
2. 備份原文件：
   `cp <源碼目錄>/adobe_client.py <源碼目錄>/adobe_client.py.bak-$(date +%Y%m%d-%H%M%S)`
   並記錄 `sha256sum <源碼目錄>/adobe_client.py`（回滾校驗用）。
3. 上傳替換：把 `.dsh-adobe-pool/adobe_client.py` 與 `.dsh-adobe-pool/proxy_pool.py` 傳到 adobe_client.py **同目錄**（proxy_pool.py 必須與 adobe_client.py 同級，或位於容器 PYTHONPATH 上；導入已做容錯，缺失時僅池停用、不報錯）。
4. 配置環境變數（adobe2api 的 compose/env 文件）：
   `ADOBE_PROXY_POOL=http://172.19.0.1:24000,http://172.19.0.1:24001,http://172.19.0.1:24002,http://172.19.0.1:24003,http://172.19.0.1:24004,http://172.19.0.1:24005,http://172.19.0.1:24006,http://172.19.0.1:24007,http://172.19.0.1:24008,http://172.19.0.1:24009,http://172.19.0.1:24010,http://172.19.0.1:24011,http://172.19.0.1:24012`
   其餘 `PROXY_*` 可不配（全部有默認值）。注意代理網段 172.19.0.1 需與 adobe2api 容器所在 docker 網絡的網關一致，部署前用 `sudo docker exec adobe2api python3 -c "import urllib.request;print(urllib.request.urlopen('http://172.19.0.1:24000',timeout=3).status)"` 之類探一次可達性。
5. 重建：
   `cd <compose 目錄>; sudo docker compose build adobe2api; sudo docker compose up -d adobe2api`
6. 驗證：
   - 容器日誌出現 `proxy pool enabled with 13 proxies ...` 與逐個 `proxy http://172.19.0.1:240xx probe ok (exit_ip=...)`（出口 IP 應各不相同且隨輪換變化）：
     `sudo docker logs --tail 100 adobe2api 2>&1 | grep -E 'proxy pool|probe'`
   - 健康端點仍 200：`sudo docker exec adobe2api python3 -c "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:6001/api/v1/health',timeout=5).status)"`
   - 端到端：用 B 端 key 提交一個 gpt-image-2 任務，確認 succeeded 且日誌中出現 `proxy pool pick -> http://172.19.0.1:240xx` 輪換。

## 4. 回滾方法

- **軟回滾（秒級，不動文件）**：從 compose/env 刪除 `ADOBE_PROXY_POOL` 後 `docker compose up -d adobe2api` 重建——池立即停用，`_pool_pick()` 恢復 `self.proxy` 靜態語義，代碼路徑等同原版（已由自檢驗證）。
- **硬回滾**：用步驟 2 的備份覆蓋 `adobe_client.py`（`sha256sum` 對照），刪除 `proxy_pool.py`（可留著，容錯導入會置 None），再 build + up -d。
