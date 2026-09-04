# 中控外科手術計畫：new-api 穩定內核替換自研屎山

> 2026-08-28 暴君指令：「中控 new-api 化不夠徹底，必須大刀闊斧把屎山替換掉，使用 new-api 的穩定內核」。
> 依據：R4 評測 5.4/10 + h3 視頻死因鏈（磁盤滿→自研 reserve 執行器卡死→24 job 永遠 pending_billing→gateway 誤判超時）+ 189 refunded / 3 succeeded 的歷史帳 + 域 E 修復時撞上的 reconcile 屎山。

## 終局（可測量）

一句話：**暴君的訂單（B 端 API / agent 畫布）→ new-api 唯一內核受理、relay、計費、記日誌 → 控制面只剩薄殼（鑑權/契約/回調/遙測）。任務路徑上零自研狀態機。**

驗收硬指標：
1. `pending_billing` 不再存在於任務路徑（提交即執行，計費是記帳不是閘門）
2. 自研 reserve 執行器與 reconcile 收編邏輯代碼刪除
3. 圖像/視頻/TTS 三類任務 100% 經 new-api（渠道橋：pixai/adobe2api/sub2api/metaso-hailuo/hublinuxdo…）
4. B 端對外契約一字不變（錯誤碼/欄位/冪等/callback_url——承諾永不變）
5. 端到端：B 端 key 提一條 h3 視頻，從提交到出片 URL，全鏈路只出現 new-api 一個任務內核

## 原則

- **對外契約永不變，內部自由演進**——B 端 OpenAI 相容端點、Idempotency-Key、callback_url、錯誤碼原樣保留
- **new-api 做它穩定的事**：relay、渠道管理、配額扣減、請求日誌。我們不再平行維護第二套
- **計費語義升級**：原「計費留自研」的合理內核（B 端對帳、退款、成本感知）保留為**異步記帳層**（從 new-api 消費日誌投影），自研的**阻塞式 reserve 閘門拆除**——計費不許再擋任務路徑
- 每階段可獨立回滾；部署順序：先影子驗證再切流量

## 現狀解剖（已實錘）

| 層 | 現狀 | 判決 |
|---|---|---|
| B 端契約 /v1/* | OpenAI 相容，正常 | **保留** |
| biz-key 鑑權 | 自研表 biz_api_key | **保留**（與 new-api token 建映射） |
| 自研計費閘 | billing_operation reserve/commit/refund 阻塞式執行器，會卡死不自愈 | **拆除**（計費改異步記帳投影） |
| 任務狀態機 | generation_job + 自研 submit/poll + worker 迭代 | **拆除雙頭**：任務語義歸 new-api 原生 task；控制面只做狀態同步與回調 |
| 上游適配器 | metaso-upstream.ts 等自研協議層 vs new-api 渠道 8 | **拆除重複**：渠道橋只作為 new-api channel 存在 |
| 調度/lease/supplier gate | 换血後已名存實亡 | **拆除**（殘骸清掃） |
| 遙測 /v1/model-status、/admin | 正常 | **保留**（數據源改投影） |
| 工件存儲/URL、callback 投遞 | 正常 | **保留** |

## 階段

### P0 止血（域 E，進行中）
reserve 自愈修復 + 24+14 殭屍清帳 + 誠實超時話術 + 視頻提交路徑偵查（是否已走 new-api 渠道 8）。
→ E 的偵查結論直接餵 P1 施工圖。此階段產物在手术后全部退役，但讓生產先不流血。

### P1 單內核切換（核心刀）
1. **計費閘拆除**：任務提交路徑的 pending_billing 阻塞刪除；改為——提交前僅做 new-api token 配額原子檢查（無狀態、無執行器、不可能卡）；提交後從 new-api 消費日誌異步投影記帳（billing_operation 保留表結構做對帳投影，新增 reconcile 從 new-api logs 讀真實消耗）
2. **任務語義歸一**：video/image/tts 三類提交與輪詢全部走 new-api 原生語義；generation_job 降級為「投影表」（同步 new-api 任務狀態，供 B 端 GET /v1/{images,videos,tts}/{id} 與 callback 用），不再自己驅動上游
3. **biz-key ↔ new-api token 映射**：每把 biz key 對應 new-api token（配額執法在 new-api 內核）；映射表入 control DB；/v1/quota 已讀 new-api users.quota，映射已有基礎
4. 驗收：三類各一條真實任務端到端 + 殭屍零增長 + B 端契約回歸測試全綠

### P1.5 事件賬本 + probe 偵查面（與 P1 同刀口，暴君 2026-08-28 點名）

> 暴君原話：「現在每次生成失敗都要追溯整整一個小時深入 vps 繞過中控的謊言」。

**一小時偵查的三宗罪（本輪 h3 實錘）**：①真相散落六處（gateway journald／控制面 DB／容器日誌／new-api sqlite／渠道橋日誌／opencode 日誌）②中控會撒謊——假超時話術、花费数据暂缺、健康檢查假陽性（診斷查詢與執行門檻不一致舊案）③generation_job 無事件史（連 last_error 欄位都沒有，每次都是 SQL 考古）。

**手術後的答案：一條 probe 命令，30 秒出死因。**

1. **job_events append-only 賬本**（根治撒謊的結構手段）：
   - 表：`job_events(job_id, at, event, actor, upstream_raw, detail)`，每次狀態遷移追加一行
   - 鐵律：generation_job 狀態欄位**只能由事件寫出**（寫狀態必寫事件，無事件的狀態=bug）；上游錯誤**原文入庫不改寫**；話術只許存在於展示層
   - 隨 P1 投影表改造一起建（同一戰場，同步 new-api 狀態時順手埋點）
2. **probe 查詢面**（admin key 門禁；biz key 只許查自己名下 job）：
   - `GET /v1/jobs/{id}/timeline`：一條查詢 join 投影表+job_events+billing_operation+new-api logs/tasks+渠道橋末次回應 → 完整時間線（建單→配額預檢→受理（new-api task id）→上游受理→輪詢→終態+上游原文）
   - `probe --stuck`：滯留 >N 分鐘 job 名單+死因分類（未受理／上游無回應／輪詢斷／記帳投影斷）
   - 健康真相：/v1/model-status 已真產物驅動（R3-A）；補 probe/health 報真實鏈路（worker 存活/DB 可寫/new-api 可達/每渠道 last-success 時間戳），自檢**永不模擬成功**
3. **驗收**：任意一筆失敗 job，probe 一條命令 30 秒內給出死因+上游錯誤原文，全程不開 `docker exec`、不進 VPS。

### P2 拆除與清掃
- 刪：reserve/commit/refund 執行器、reconcile 收編、supplier lease/capability 門禁、metaso-upstream 自研協議層（若 P1 證實冗餘）、worker 的 submit/poll 重複實現
- worker 瘦身為：new-api 任務狀態同步 + callback 投遞 + 遙測聚合三個純函數循環
- 驗收：`grep reserve` 任務路徑零命中；全量 smoke；前端生圖/畫布/agent 全鏈路實測

### P3 總驗收
- R5 評測：同一本《大明最後的十七年》整本 PDF 重放（同 R4 姿勢），對比 5.4 分
- 死線對帳：暴君三死線逐項勾銷
- 記憶沉澱 + 中控新架構圖入 MEMORY

## 風險與回滾

- P1 是心臟手術：影子期雙寫（新舊路徑並行跑一輪對比帳），B 端契約測試鎖死
- new-api token 配額若與現有 biz key 餘額不一致 → 以 new-api users.quota 為唯一真源，一次性對帳遷移
- 回滾點：每階段 git tag + 鏡像 tag（沿用 rollback-YYYYMMDD 慣例）

## 執行紀律

- 每階段派 subagent，orchestrator 統一部署；白名單式改動（指定檔案指定函數），禁止順手重構
- 計費金額語義（amount/500000、commit/refund 數學）原樣保留，只拆「阻塞」不拆「帳本」
- KEY 永不入 log/memory/commit
