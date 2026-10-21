# flowmusic2api — repo 真源（凭证链修复 ＋ 看门狗）

本目录是 FlowMusic 帐号池服务（VPS `/opt/flowmusic2api`，容器 `flowmusic2api`）
**程式码补丁与看门狗的唯一真源**。此前这两样只存在于本机 `/tmp` 与 VPS，
没有任何 repo 真源、没有文件——与 `agent-poller` 同型的「无真源、bug 长存」陷阱
（见记忆 `2026-10-02-poller-unversioned-daemon-adopted`）。自本目录起收敛。

## 档案

| 档 | 说明 | md5 |
|---|---|---|
| `fix-p1p2-20261003.patch` | Go 树（upstream `internal/`）的 P1+P2 修复补丁，311 行 | `0bb86878dfa5436d28ecbbdfb77b6a82` |
| `watchdog.py` | VPS `/opt/flowmusic2api/watchdog.py` 真源；本次新增 revoked 讯号判读 | — |
| `test_watchdog_classify.py` | `classify_session` 纯函数真值表（8 例），`python3 test_watchdog_classify.py` | — |

`watchdog.py` 收进本目录时与 VPS 原档**逐位元相同**（`md5 ed7af9a75f6f9d103a49447d85a505c8`，
2026-10-03 以 `sudo md5sum` 对 `sudo base64` 取回比对）；之后才在本 repo 版本上加分类器修复。

---

## 真根因（2026-10-03 定案）

**Supabase refresh token 被 reuse detection 连坐吊销**——同一个 Supabase session 的
refresh token 被 **第二个消费者**（VPS 之外的浏览器 profile，换血时导出 cookie 的那个）
也拿去轮换，Supabase 判定 reuse 后**把整个 token family 吊销**；family 死后连 token
记录都被清掉，之后 refresh 回 `HTTP 400 {"code":"refresh_token_not_found"}`。

VPS 侧已逐一排除第二消费者：看门狗不打 grant、有 per-account 锁、harness 近 3 日
0 次戳、容器只绑 loopback。**结论是链外（浏览器）的第二消费者。**

> **它不是什么：不是 `provider_token` 过期。** `provider_token` 只是 FlowMusic 网页
> API 的 bearer，Supabase JWT 才是生成的鉴权凭证；把死因读成 provider bearer 401
> 是 2026-09 起连续误判的来源（见下「P1 缺陷」）。

## 两个程式码缺陷（补丁修了什么）

### P1 — 真错误被 provider 401 覆盖（`internal/service/accounts.go`，原 413–446）
`refreshAccountByAvailableCredentials` 先做 Supabase refresh，失败后落 provider
fallback；**fallback 的错误（`SaveGoogle` 401）直接覆盖掉 Supabase 的真错误**再回报
⇒ `last_refresh_result` 永远是「provider bearer 401」这个假线索，导致连续误判为
provider token 问题（真死因是 Supabase family 被吊销）。
- **修法**：保留 Supabase 原错误，与 provider 错误**串接**（`supabase refresh failed: %w; provider fallback failed: %v`）后回报。
- 同档 106–115 一并补上：refresh 成功时把**轮换后的 cookies 持久化**。

### P2 — 早退丢掉刚轮换出的 Supabase JWT（`internal/service/flowmusic.go` `RefreshSupabase`）
Supabase refresh 成功、但 `provider_token` 缺失时，程式在**重建 Supabase JWT cookie
之前就早退**，把刚轮换出的 JWT 丢掉；错误分支也不持久化 cookie；`FlowBearer` 还会被
空字串覆盖。
- **修法**（patch `@@ -162`／`@@ -198`／`@@ -438`／`@@ -1207`）：
  ① 在 provider_token guard **之前**先 `buildSupabaseAuthCookie` 重建并写回 cookie；
  ② `SaveGoogle` 失败时保留既有 flow_bearer，不清空；
  ③ cookie 模式刷新时由 JWT `exp` claim 推进 `ExpiresAt`（新增 `extractJWTExpiry`），
     避免 `shouldRefreshAccount()` 误以为永久冻结。

补丁同时附两个真行为测试（`internal/service/flowmusic_test.go`）：Supabase 因由可浮现、
provider_token 缺失时仍持久化轮换后的 JWT cookie 与 `expires_at`。

---

## 部署配方

上游 repo：`https://github.com/genz27/FlowMusic2API`（模组 `flowmusic2api`）。
**必须自建 image**：上游 `ghcr.io/genz27/flowmusic2api:latest` **带 P1/P2 缺陷**；
上游更新时需重新 clone → 重新套本补丁 → 重新 build。

```bash
# 1) 干净 clone（或更新既有 src 树）
sudo rm -rf /opt/flowmusic2api-src
sudo git clone https://github.com/genz27/FlowMusic2API /opt/flowmusic2api-src

# 2) 套补丁（补丁路径 = 本目录）
cd /opt/flowmusic2api-src
sudo git apply /home/lenovo/Desktop/image-app/deploy-staging/flowmusic2api/fix-p1p2-20261003.patch
sudo grep -n 'supabase refresh failed' internal/service/accounts.go   # 应命中，确认已套

# 3) 自建 image（tag 带日期）
sudo docker build -t flowmusic2api:fix-p1p2-20261003 /opt/flowmusic2api-src

# 4) compose 改 image 后只重建该服务
sudo sed -i 's|image: .*flowmusic2api.*|image: flowmusic2api:fix-p1p2-20261003|' /opt/flowmusic2api/docker-compose.yml
cd /opt/flowmusic2api && sudo docker compose up -d --no-deps flowmusic2api
sudo docker ps --filter name=flowmusic2api   # 等 (healthy)
```

### 回滚

建 image 前已把旧 image 打 tag（旧 digest 与 ghcr latest 相同）：

```bash
cd /opt/flowmusic2api
sudo sed -i 's|image: .*flowmusic2api.*|image: flowmusic2api:rollback-20261003|' docker-compose.yml
sudo docker compose up -d --no-deps flowmusic2api
```

（`docker images` 可见 `flowmusic2api:rollback-20261003` 与 `ghcr.io/genz27/flowmusic2api:latest`
同 digest——即修复前版本。如需重建该 tag：`sudo docker tag ghcr.io/genz27/flowmusic2api:latest flowmusic2api:rollback-20261003`。）

---

## 看门狗 `watchdog.py`（systemd timer，每 10 分钟）

**职责**：读 `/api/tokens/1` 的 `expires_at`；新鲜 → healthy 离开（绝不消费活 token）；停滞 → 纯函数 `classify_session()` 判读，已知死讯直接写标记且**不再盲目打 grant**。

### 分类器讯号顺序（2026-10-03 教训）

`classify_session` 判读**优先序**（纯函数，可单测）：

1. `refresh_token_already_used` → `chain_dead/second_consumer_reuse_detected`
2. **`refresh_token_*` 4xx（含 `refresh_token_not_found`）→ `chain_dead/supabase_refresh_token_revoked`**
3. `provider bearer update failed … 401` → `chain_dead/provider_bearer_401`
4. `supabase_refresh_no_provider_token` → `healthy`（健康噪音，非死讯）
5. `expires_at` 未过期 → `healthy`；6. 其他过期 → `stale`

**第 2 条必须排在第 3 条之前**：P1 修复后 Supabase 的真错误会与 provider fallback 的
401 **串接在同一行**（实例见下），若 401 规则排在前面就会继续误判成
`provider_bearer_401`——这正是本次要修的看门狗缺陷。旧码只认 `refresh_token_already_used`，
对 family 被吊销后 Supabase 回的 `refresh_token_not_found` 视而不见。

P1 后生产上出现的真实 `last_st_refresh_result`（2026-10-03 实查）：

```
supabase refresh failed: POST https://sb.flowmusic.app/auth/v1/token?grant_type=refresh_token: HTTP 400 {"code":"refresh_token_not_found","message":"Invalid Refresh Token: Refresh Token Not Found"}; provider fallback failed: provider_token FlowMusic bearer update failed: POST https://www.flowmusic.app/__api/auth/google/save: HTTP 401 {"detail":"Unauthorized"}
```

此串现判 `chain_dead/supabase_refresh_token_revoked`（`test_watchdog_classify.py` Case 1 锁定），
不再是 `provider_bearer_401`。

### 标记语义（**不得改动**）

- `CHAIN_DEAD` 文字标记 ＋ 结构化 `CHAIN_DEAD.json`（`music-tools` 的 `probeFlowMusic` 读标记判 `needs_human_login`）。
- `CHAIN_DEAD.json` **已存在就不覆写**（保留首次侦测时间）。
- 链存活出口 `clear_dead_marker()` 把两档归档为 `.resolved-<UTC>`。
- `log_error` 必须带 kmsg 风格 `<3>` 前缀才会落 journald `priority=3`（err）。

## 真 oracle（判死活，勿信容器 healthy）

1. `expires_at` 每 30 分钟推进；
2. `refresh_token` 每次轮换后不同；
3. **一笔真生成**（付费，**需暴君逐次授权**；见 AGENTS.md 付费上游呼叫硬闸）。

容器 `/health`、image 存在、HTTP 200 都不是 oracle。

## 换血纪律

换血（重新导入凭证）前**必读 skill `flowmusic-session-revival`**，其铁律
①**排他占有**（VPS 独占 session、关闭导出 cookie 的浏览器 profile＝斩掉第二消费者）
②读-改-写三格五步 ③看门狗体检＋实弹 oracle ④死讯 vs 健康噪音对照。
VPS runbook：`/opt/flowmusic2api/RUNBOOK-exclusive-session.md`。
