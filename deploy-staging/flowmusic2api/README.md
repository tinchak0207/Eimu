# flowmusic2api — repo 真源（憑證鏈修復 ＋ 看門狗）

本目錄是 FlowMusic 帳號池服務（VPS `/opt/flowmusic2api`，容器 `flowmusic2api`）
**程式碼補丁與看門狗的唯一真源**。此前這兩樣只存在於本機 `/tmp` 與 VPS，
沒有任何 repo 真源、沒有文件——與 `agent-poller` 同型的「無真源、bug 長存」陷阱
（見記憶 `2026-10-02-poller-unversioned-daemon-adopted`）。自本目錄起收斂。

## 檔案

| 檔 | 說明 | md5 |
|---|---|---|
| `fix-p1p2-20261003.patch` | Go 樹（upstream `internal/`）的 P1+P2 修復補丁，311 行 | `0bb86878dfa5436d28ecbbdfb77b6a82` |
| `watchdog.py` | VPS `/opt/flowmusic2api/watchdog.py` 真源；本次新增 revoked 訊號判讀 | — |
| `test_watchdog_classify.py` | `classify_session` 純函數真值表（8 例），`python3 test_watchdog_classify.py` | — |

`watchdog.py` 收進本目錄時與 VPS 原檔**逐位元相同**（`md5 ed7af9a75f6f9d103a49447d85a505c8`，
2026-10-03 以 `sudo md5sum` 對 `sudo base64` 取回比對）；之後才在本 repo 版本上加分類器修復。

---

## 真根因（2026-10-03 定案）

**Supabase refresh token 被 reuse detection 連坐吊銷**——同一個 Supabase session 的
refresh token 被 **第二個消費者**（VPS 之外的瀏覽器 profile，換血時導出 cookie 的那個）
也拿去輪換，Supabase 判定 reuse 後**把整個 token family 吊銷**；family 死後連 token
記錄都被清掉，之後 refresh 回 `HTTP 400 {"code":"refresh_token_not_found"}`。

VPS 側已逐一排除第二消費者：看門狗不打 grant、有 per-account 鎖、harness 近 3 日
0 次戳、容器只綁 loopback。**結論是鏈外（瀏覽器）的第二消費者。**

> **它不是什麼：不是 `provider_token` 過期。** `provider_token` 只是 FlowMusic 網頁
> API 的 bearer，Supabase JWT 才是生成的鑑權憑證；把死因讀成 provider bearer 401
> 是 2026-09 起連續誤判的來源（見下「P1 缺陷」）。

## 兩個程式碼缺陷（補丁修了什麼）

### P1 — 真錯誤被 provider 401 覆蓋（`internal/service/accounts.go`，原 413–446）
`refreshAccountByAvailableCredentials` 先做 Supabase refresh，失敗後落 provider
fallback；**fallback 的錯誤（`SaveGoogle` 401）直接覆蓋掉 Supabase 的真錯誤**再回報
⇒ `last_refresh_result` 永遠是「provider bearer 401」這個假線索，導致連續誤判為
provider token 問題（真死因是 Supabase family 被吊銷）。
- **修法**：保留 Supabase 原錯誤，與 provider 錯誤**串接**（`supabase refresh failed: %w; provider fallback failed: %v`）後回報。
- 同檔 106–115 一併補上：refresh 成功時把**輪換後的 cookies 持久化**。

### P2 — 早退丟掉剛輪換出的 Supabase JWT（`internal/service/flowmusic.go` `RefreshSupabase`）
Supabase refresh 成功、但 `provider_token` 缺失時，程式在**重建 Supabase JWT cookie
之前就早退**，把剛輪換出的 JWT 丟掉；錯誤分支也不持久化 cookie；`FlowBearer` 還會被
空字串覆蓋。
- **修法**（patch `@@ -162`／`@@ -198`／`@@ -438`／`@@ -1207`）：
  ① 在 provider_token guard **之前**先 `buildSupabaseAuthCookie` 重建並寫回 cookie；
  ② `SaveGoogle` 失敗時保留既有 flow_bearer，不清空；
  ③ cookie 模式刷新時由 JWT `exp` claim 推進 `ExpiresAt`（新增 `extractJWTExpiry`），
     避免 `shouldRefreshAccount()` 誤以為永久凍結。

補丁同時附兩個真行為測試（`internal/service/flowmusic_test.go`）：Supabase 因由可浮現、
provider_token 缺失時仍持久化輪換後的 JWT cookie 與 `expires_at`。

---

## 部署配方

上游 repo：`https://github.com/genz27/FlowMusic2API`（模組 `flowmusic2api`）。
**必須自建 image**：上游 `ghcr.io/genz27/flowmusic2api:latest` **帶 P1/P2 缺陷**；
上游更新時需重新 clone → 重新套本補丁 → 重新 build。

```bash
# 1) 乾淨 clone（或更新既有 src 樹）
sudo rm -rf /opt/flowmusic2api-src
sudo git clone https://github.com/genz27/FlowMusic2API /opt/flowmusic2api-src

# 2) 套補丁（補丁路徑 = 本目錄）
cd /opt/flowmusic2api-src
sudo git apply /home/lenovo/Desktop/image-app/deploy-staging/flowmusic2api/fix-p1p2-20261003.patch
sudo grep -n 'supabase refresh failed' internal/service/accounts.go   # 應命中，確認已套

# 3) 自建 image（tag 帶日期）
sudo docker build -t flowmusic2api:fix-p1p2-20261003 /opt/flowmusic2api-src

# 4) compose 改 image 後只重建該服務
sudo sed -i 's|image: .*flowmusic2api.*|image: flowmusic2api:fix-p1p2-20261003|' /opt/flowmusic2api/docker-compose.yml
cd /opt/flowmusic2api && sudo docker compose up -d --no-deps flowmusic2api
sudo docker ps --filter name=flowmusic2api   # 等 (healthy)
```

### 回滾

建 image 前已把舊 image 打 tag（舊 digest 與 ghcr latest 相同）：

```bash
cd /opt/flowmusic2api
sudo sed -i 's|image: .*flowmusic2api.*|image: flowmusic2api:rollback-20261003|' docker-compose.yml
sudo docker compose up -d --no-deps flowmusic2api
```

（`docker images` 可見 `flowmusic2api:rollback-20261003` 與 `ghcr.io/genz27/flowmusic2api:latest`
同 digest——即修復前版本。如需重建該 tag：`sudo docker tag ghcr.io/genz27/flowmusic2api:latest flowmusic2api:rollback-20261003`。）

---

## 看門狗 `watchdog.py`（systemd timer，每 10 分鐘）

**職責**：讀 `/api/tokens/1` 的 `expires_at`；新鮮 → healthy 離開（絕不消費活 token）；停滯 → 純函數 `classify_session()` 判讀，已知死訊直接寫標記且**不再盲目打 grant**。

### 分類器訊號順序（2026-10-03 教訓）

`classify_session` 判讀**優先序**（純函數，可單測）：

1. `refresh_token_already_used` → `chain_dead/second_consumer_reuse_detected`
2. **`refresh_token_*` 4xx（含 `refresh_token_not_found`）→ `chain_dead/supabase_refresh_token_revoked`**
3. `provider bearer update failed … 401` → `chain_dead/provider_bearer_401`
4. `supabase_refresh_no_provider_token` → `healthy`（健康噪音，非死訊）
5. `expires_at` 未過期 → `healthy`；6. 其他過期 → `stale`

**第 2 條必須排在第 3 條之前**：P1 修復後 Supabase 的真錯誤會與 provider fallback 的
401 **串接在同一行**（實例見下），若 401 規則排在前面就會繼續誤判成
`provider_bearer_401`——這正是本次要修的看門狗缺陷。舊碼只認 `refresh_token_already_used`，
對 family 被吊銷後 Supabase 回的 `refresh_token_not_found` 視而不見。

P1 後生產上出現的真實 `last_st_refresh_result`（2026-10-03 實查）：

```
supabase refresh failed: POST https://sb.flowmusic.app/auth/v1/token?grant_type=refresh_token: HTTP 400 {"code":"refresh_token_not_found","message":"Invalid Refresh Token: Refresh Token Not Found"}; provider fallback failed: provider_token FlowMusic bearer update failed: POST https://www.flowmusic.app/__api/auth/google/save: HTTP 401 {"detail":"Unauthorized"}
```

此串現判 `chain_dead/supabase_refresh_token_revoked`（`test_watchdog_classify.py` Case 1 鎖定），
不再是 `provider_bearer_401`。

### 標記語義（**不得改動**）

- `CHAIN_DEAD` 文字標記 ＋ 結構化 `CHAIN_DEAD.json`（`music-tools` 的 `probeFlowMusic` 讀標記判 `needs_human_login`）。
- `CHAIN_DEAD.json` **已存在就不覆寫**（保留首次偵測時間）。
- 鏈存活出口 `clear_dead_marker()` 把兩檔歸檔為 `.resolved-<UTC>`。
- `log_error` 必須帶 kmsg 風格 `<3>` 前綴才會落 journald `priority=3`（err）。

## 真 oracle（判死活，勿信容器 healthy）

1. `expires_at` 每 30 分鐘推進；
2. `refresh_token` 每次輪換後不同；
3. **一筆真生成**（付費，**需暴君逐次授權**；見 AGENTS.md 付費上游呼叫硬閘）。

容器 `/health`、image 存在、HTTP 200 都不是 oracle。

## 換血紀律

換血（重新導入憑證）前**必讀 skill `flowmusic-session-revival`**，其鐵律
①**排他佔有**（VPS 獨占 session、關閉導出 cookie 的瀏覽器 profile＝斬掉第二消費者）
②讀-改-寫三格五步 ③看門狗體檢＋實彈 oracle ④死訊 vs 健康噪音對照。
VPS runbook：`/opt/flowmusic2api/RUNBOOK-exclusive-session.md`。
