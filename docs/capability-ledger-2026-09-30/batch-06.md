# image-app 第 6 批（47 commits，2026-09-27 ~ 2026-09-28）我方能力窮舉清單

口徑：能力＝**使用者可見或可呼叫的行為**（端點／UI 動作／帳務語義／閘門判準），不是檔案存在。
證據來源：`/tmp/cap/batch-6.txt`（唯一真源）＋ `git show`／`git show --stat` 補證；檔名只作落地位置註記。
領域標籤限用 11 個：生成核心 / 模型與供應商 / 控制平面與計費 / B端API / Agent助理 / 畫布與工作流 / 創作域 / 帳號與增長 / 前端與UI / 運維與觀測 / 團隊與企業。

---

## 生成核心

- [生成核心] 真實結果驅動的模型可用性斷路器（circuit breaker） — 72h 內最近 20 個計入終態樣本（排除 user_input/cancelled），≥5 且 0 成功、或 ≥10 且成功率 <20% 即 open；每 30 分鐘放行 1 單試探，最近計入終態成功即恢復；60s 快取 ｜ 證據: f009cf09
- [生成核心] 斷路器的提交前 fail-fast 與替代模型建議 — 在 submitGenerationCommand 建單／預扣費之前 fail-fast（冪等重放例外），各提交路由映射 503 + 既有穩定碼 no_endpoints（web 為 model_unavailable），訊息含同介質成功率最高的替代模型 ｜ 證據: f009cf09
- [生成核心] 不可用模型的三處一致下架 — /v1/model-status、/api/internal/model-status（自 VPS 收編入 repo）同判 unavailable，/v1/models（agent / MCP list_models）排除之 ｜ 證據: f009cf09
- [生成核心] 供給面斷供判定 — 有 capability 合約但無任何可用「供應商＋合約＋帳號」組合的模型直接判不可用：列表下架、提交前拒單不扣費、不放必敗試探，替代不推斷供模型 ｜ 證據: 43be7f6e
- [生成核心] 影片輪詢窗口可調 — openai-video 上游輪詢窗口 540s → 1200s，支援 OPENAI_VIDEO_MAX_WAIT_MS 覆寫（下限 60s），超時文案同源讀取 ｜ 證據: 782d3214
- [生成核心] 生成預算按 job kind 分級 — 開工後生成預算 video_generate/avatar/lipsync 25 分鐘、其餘維持 15 分鐘（新增純函數 generationBudgetMs） ｜ 證據: 782d3214
- [生成核心] 欠費錯誤分類優先於鑑權分類 — failure-classifier 把欠費判定移到 401/403 鑑權判定之前（xiaoyxiao 欠費回 401 insufficient_user_quota 不再進鑑權桶 → 不再 quarantine → 不再帳號 disabled 空轉到 deadline） ｜ 證據: 43be7f6e

## 模型與供應商

- [模型與供應商] xiaoyxiao 為視頻唯一權威渠道 — registry 只留 xiaoyxiao（openai_video 既有輪子、tier managed_pool、priority 1），移除 metaso/tokenmix/cangyuansuanli/napi/drama/adobe2api-plus 六條視頻條目 ｜ 證據: 8d640263
- [模型與供應商] 上游視頻模型名重映射 — seedance 族由已下架的 sd4-* 改映射到 /v1/models 實查存在的 sd12-seedance-2.0／sd12-seedance-2.0-fast／sd13-seedance-2.0-mini／sd8-seedance-2.5／sd7-seedance-2.0-1080p（每族取最低價；舊名被上游以 "not a public model name" 直接拒收） ｜ 證據: 5da7919e
- [模型與供應商] 欠費文案與錯誤碼詞表補全 — 補齊中英詞與錯誤碼 insufficient_user_quota（原文「预扣费额度失败, 用户剩余额度: ¥1.44…」），欠費不再落 overloaded（retryable）而在退避循環空轉到 deadline ｜ 證據: 5da7919e
- [模型與供應商] 欠費改 30 分鐘冷卻 — 欠費從「永久 disabled」改為「30 分鐘冷卻」，recoverExpiredCooldowns 可自動恢復（fail-fast retryable=false 不變） ｜ 證據: 5da7919e
- [模型與供應商] 成品 URL 多形狀解析 — extractOutputUrl 補頂層 url 分支，支援 xiaoyxiao completed 只回 {"status":"completed","progress":100,"url":"…mp4"} 的形狀，不再把已生成好的成品誤判 upstream_protocol 丟掉 ｜ 證據: 43decfd6
- [模型與供應商] minimax-h3 時長表補齊 — DURATION_RANGES 補 minimax-h3 4–15s，與 catalog durations 對齊（原缺漏使 B 端真單在呼叫上游前被 400 擋下，零上游成本） ｜ 證據: 28aaed8d
- [模型與供應商] 零供貨視頻模型公開下架 — 公開目錄下架 17 條零供貨視頻 model（14 條暴君裁定 + seedance-2.0-fast/-mini/seedance-2.5-30s 無白名單檔位可承接） ｜ 證據: 8d640263
- [模型與供應商] adobe2api 只停 video 認領 — ADOBE2API_MODEL_IDS 只留圖像，16+16 條圖片 capability 不動，video 認領停止 ｜ 證據: 8d640263
- [模型與供應商] 退役供應商標籤防復活 — 新增 RETIRED_SUPPLIER_LABELS（7 條），seed 跳過不碰，修復「worker 重啟即把 DB 停用態沖回」的復活地雷 ｜ 證據: 8d640263

## 控制平面與計費

- [控制平面與計費] 兌換碼上游分頁全掃 — listGatewayRedemptions 改 p 從 1 起算、按上游 total 翻到盡、按 id 去重（原本 p=0 與 p=1 同頁、只翻 1 頁 ⇒ 415 張碼只看得到最新 100 張且同頁被數兩次） ｜ 證據: bed6f558
- [控制平面與計費] 基線前兌換不再被靜默丟棄 — redeemed_time < 開戶基線的碼改記兩條腿（同一事務）：recharge +Q 讓「錢從哪來」可見 ＋ adjustment −Q 沖銷（淨額 0 不雙算）；先讀兩把冪等鍵、只補缺的那條，避免單腿漂移 ｜ 證據: bed6f558
- [控制平面與計費] 人工碼不記現金 — 新增 isCashBackedRedemptionName（mPay 單命名 = `MP` + out_trade_no 後 18 碼）；現金單維持 source=redemption-sync，人工發碼/贈送碼改記 source=gift-manual-code（命中既有 NON_CASH_RECHARGE_SOURCE） ｜ 證據: bed6f558
- [控制平面與計費] 上游調額不冪等的佔位冪等 — welcome_gift_grant 佔位（ON CONFLICT … WHERE status='failed'）＋ idempotency_ref=adjustment:welcome:<uid>:v1，併發/重放只加一次；上游拋錯時復讀 quota 區分 failed（可重試）與 unknown（不再自動動上游） ｜ 證據: 629b4ae5
- [控制平面與計費] 支付回跳自動兌換 — PricingClient 偵測 ?cdk= 回跳且已登錄即自動兌換一次，成功後移除 URL 中的 cdk（刷新不重兌），失敗保留預填不彈錯 ｜ 證據: be716f12
- [控制平面與計費] 餘額不足就地充值 — 餘額不足 toast 顯示本次所需幣數並帶「去充值」動作 ｜ 證據: be716f12
- [控制平面與計費] 訂單參數自簽三段值 — 訂單參數自簽 `planId.userId.hmac8`（HMAC-SHA256，域 "mapay-order"，timingSafeEqual 驗簽，舊格式／篡改一律回 null）；checkout 已登錄（napi_token cookie → 控面穩定令牌表反查 userId，2.5s 預算）時寫三段值，未登錄／查不到／超時沿用舊格式 plan.id ｜ 證據: e27e3697
- [控制平面與計費] notify 直接入帳（不再依賴用戶回跳兌換碼） — param 驗簽通過 → 控面直達入帳、成功不生成兌換碼；上游明確沒動或通道不可用 → 退回舊發碼流程（保證錢一定落地）；佔位結果未定 → 不開第二條通道並留 warn 交核對 ｜ 證據: e27e3697
- [控制平面與計費] mapay_credit 佔位冪等與狀態機 — 佔位表 mapay_credit(out_trade_no PK) 只插不覆蓋（上游調額不冪等，重放永不雙發）→ adjustGatewayUserQuotaExact → 帳本 recordRecharge（冪等鍵 redemption:<out_trade_no>）；狀態機 pending/applied/failed/unknown；結果詞表 credited/already_credited/failed/in_flight/none/unavailable ｜ 證據: e27e3697
- [控制平面與計費] 控面樂觀重算金額 — /api/internal/mapay-credit 的額度一律控面自己由 planId 重算，不接受呼叫方傳金額（op=credit 入帳、op=status 只讀，biz-key-sync HMAC 通道，域 "mapay-credit"） ｜ 證據: e27e3697
- [控制平面與計費] legacy reserve 失敗不謊報餘額不足 — 非餘額失敗（網關不可達／回滾不確定）不再謊報成餘額不足，改走既有 503 control_plane_unavailable 契約，真因寫服務端日誌 ｜ 證據: a9ceb2f0
- [控制平面與計費] 首充專享・限一次 — FIRST_CHARGE_PLAN（id `first-charge`，¥7 → 300 幣）**故意不進 PLANS 陣列**（不出現在正價梯與價目列頭）；/api/payments/first-charge/eligibility 探資格，有資格才渲染卡，未登錄只顯示文案、點擊先登錄 ｜ 證據: 1b592d5d
- [控制平面與計費] 首充資格帳本口徑 — 資格＝該帳號在 account_ledger 從無 recharge 行 ∧ 名額表未被占；判準唯一真源在控面 /api/internal/first-charge（簽名域 first-charge），金額權威仍是 account_ledger ｜ 證據: 1b592d5d
- [控制平面與計費] 首充併發執法 — 名額表 user_id 主鍵 INSERT … ON CONFLICT DO NOTHING RETURNING：兩單並發只有一單保留 300 幣，輸家按 ¥7 對應正價幣數（70 幣）入帳並記 detail；真正執法在 checkout 403 與入帳時按正價折算 ｜ 證據: 1b592d5d
- [控制平面與計費] 團隊席位價格唯一真源 — team-seat-pricing 為席位價格單一真源（改價只改本檔），現值全為 null＝未配置，未配置一律回 price_not_configured ｜ 證據: c9696948
- [控制平面與計費] 席位下單未接線接縫 — POST /api/v1/team/seats/order 未接線回 501 seat_order_fulfillment_unwired，翻線前一律拒單；刻意不呼叫 mapay 收款面（既有 notify 端 resolvePricingPlan 必然 null ⇒ 會「收錢不履約」） ｜ 證據: c9696948
- [控制平面與計費] 席位 → 成員額度分配 — POST /api/v1/team/seats/allocate 全部委派既有 allocateMemberQuota，不另開第二條分配路徑、不改其不變量語義 ｜ 證據: c9696948
- [控制平面與計費] 團隊用量查詢 — GET /api/v1/team/usage，明細走 account_ledger 逐筆、總額走 new-api ｜ 證據: 2447c874
- [控制平面與計費] 團隊席位上限閘 — GET/POST /api/v1/team/seats：上限不得低於現有成員數、不得超硬上限；席位閘與調整冪等 ｜ 證據: 2447c874

## B端API

- [B端API] /openai/v1/images/generations 同步形狀 — 提交後服務端輪詢到終態，同步回 200 {created, data:[{url}|{b64_json}]}；response_format 預設 url（OpenAI 語義），b64 由服務端複用既有取件後端取回再編碼；等待上限 240s（maxDuration 300 減 60s 結算餘裕，OPENAI_COMPAT_MAX_WAIT_MS 可調） ｜ 證據: 8cb16aea
- [B端API] /openai/v1/chat/completions（含 stream） — 取最後一條 user 訊息當 prompt；stream:true 先送 role delta，出圖前每 10s 送 SSE keep-alive，出圖後送 markdown 圖片 delta，末行 [DONE]（stream_options.include_usage 時補 usage chunk） ｜ 證據: 8cb16aea
- [B端API] /openai/v1/models 只列可出圖模型 — {object:"list", data:[{id, object:"model", owned_by:"eimu"}]}，共用金鑰白名單＋目錄 kind=image＋既有熔斷/斷供閘 ｜ 證據: 8cb16aea
- [B端API] 同步層錯誤信封與未出圖不扣費 — 失敗/超時回 OpenAI 錯誤信封，未出圖不扣費（沿用 durable 退款語義），504 的 message 帶 task id；insufficient_balance 補進 type 值域以便 402 原樣透傳 ｜ 證據: 8cb16aea
- [B端API] 同步層共用層禁直連 DB — openai-compat 共用層的提交/輪詢走被 beforeFiles 代理的 HTTP 入口 /api/v1/images/generations 與 /api/v1/images/{id}；鑑權復用 authenticateBizApiKey（biz key 兩邊通用） ｜ 證據: 8cb16aea
- [B端API] 同步層改在控面執行 — /openai/v1/* 加 beforeFiles 代理改在控面跑（Vercel Hobby 函數硬上限 60s 會硬殺等待中的函數、連 504 都送不出去；models 的熔斷/斷供閘需要 GENERATION_DATABASE_URL，Vercel 不持有該變數只會 fail-open） ｜ 證據: 1b49771a
- [B端API] B 端 /v1 拒絕遙測 — 新表 api_rejection ＋ withApiRejectionTelemetry 出口攔截只記 status>=300（reason 取自回應體的穩定 code，非 JSON 退回 http_<status>），只記 key 前 8 位、不記 prompt/完整 key，寫入 fire-and-forget 儲存層錯誤靜默吞掉 ｜ 證據: af6c6a49
- [B端API] 拒絕遙測覆蓋四個 /v1 出口 — 接線 /v1/images/generations、/v1/images/edits、/v1/images/[id]、/v1/models，寫成邊界包裝使新增出口自動覆蓋（漏記出口沒有任何測試能事後發現） ｜ 證據: af6c6a49
- [B端API] 建 key 成功即給可複製 curl — ApiKeysClient 簽發成功彈窗新增兩段一鍵複製 curl 區塊（通用 gpt-image-2 / PixAI 二次元），model 與 size 一律由 generation-model-catalog 推導 ｜ 證據: 0cbd7c0c
- [B端API] 建 key 彈窗餘額說明 — 「新人禮額度可直接調用；餘額用完返回 402，附充值連結。」＋充值連結 ｜ 證據: 0cbd7c0c
- [B端API] /v1 餘額不足統一 402 insufficient_balance — 所有 /v1 餘額／額度不足出口一律回 {"error":{"message":"余额不足，本次未扣费。充值：https://eimu.dev/pricing","type":"insufficient_balance","code":"insufficient_balance"}}，單一真源＝quota-precheck.ts 的 INSUFFICIENT_BALANCE_ERROR（閘門拒單與 legacy reserve 餘額不足分支共用） ｜ 證據: a9ceb2f0

## Agent助理

- [Agent助理] 剪輯域 Agent 配方庫落庫 — skills/editor/** 新增 7 份 SKILL.md（域根路由表＋lint 閘門鐵律＋四條標準鏈路＋六個子配方 assembly / audio-first / rhythm / look / mix / qc-master），一配方一目錄一 SKILL.md ｜ 證據: 2890c923
- [Agent助理] editor persona 默認注入 7 條 skill 路徑 — EDITOR_PERSONA_SKILL_PATHS 由 [] 填成 7 條真實路徑（原本自陳「skills/ 無剪輯域配方庫 → skill 待補」）；EDITOR_PERSONA_TOOL_IDS 現場已是 10/10 完整未動 ｜ 證據: 2890c923
- [Agent助理] 委派 prompt 質檢閘硬規則 — editor-delegate.ts 委派 prompt 只增一段質檢閘硬規則（紀律層），既有回執契約與 collect 語義零改 ｜ 證據: 2890c923
- [Agent助理] skill 索引可解析性修復 — opencode 只解析 YAML frontmatter 在 byte 0 的 SKILL.md（首為 HTML 註解者靜默不進索引）；115 檔純位移＋1 檔補 frontmatter，skills/ 可解析 8/124 → 124/124 ｜ 證據: 19f7f257
- [Agent助理] skill frontmatter 索引守門測試 — src/lib/skill-frontmatter-indexability.test.ts（repo 級）：①掃描集合 ≥100 ②每份 SKILL.md byte 0 必須 `---` ③frontmatter 含非空 name/description；突變對照可變紅並指名檔路徑 ｜ 證據: 19f7f257
- [Agent助理] timeline 族工具的 subagent 身份 fallback — timeline_* 工具在子代理（editor 跑獨立 opencode 子會話）下 fallback 到 subagentParentState，整族端點不再一律 404 timeline_session_not_found ｜ 證據: 6d395e84
- [Agent助理] timeline 身份閘未放鬆（邊界語義） — `if (!tlState || tlState.apiKey !== key) return 404` 一字未改；subagentParentState 只在可信 internal dispatch 寫入的 byChildOc 命中時回值，父會話非本 key 一律 404，跨租戶隔離不變、零新增模型可控身份輸入面 ｜ 證據: 6d395e84

## 畫布與工作流

- [畫布與工作流] 本機 3D 模型導入通道 — CanvasNodeCreateMenu 增「導入 3D 模型…」，經 POST /api/canvas/scene-3d（requireVerifiedUser + blob-backend.put）把桌面 GLB 帶進畫布成 scene_3d 場景卡 ｜ 證據: 32d9bf2c
- [畫布與工作流] Scene3dCardMetadata 契約放寬 — 底線＝glb_path + scene_summary 非空，turntable_url / stills_urls / blend_path / duration_ms 放寬為可選；新增可選 source: "director" | "import"；落地清洗缺底線整包丟、可選欄型別不符只省略該欄；雙白名單兩端同步 ｜ 證據: 32d9bf2c
- [畫布與工作流] 導入卡卡面減法 — 導入卡只出 GLB 視口 + 下載 + 真實來源摘要，不渲染空播放器、空靜帧網格、死切換鈕、缺席的 .blend 連結 ｜ 證據: 32d9bf2c
- [畫布與工作流] 桌面 Blender 一鍵導出到畫布 — Blender addon 面板新增「Eimu 導出」區（服務器地址／連接碼／導出按鈕），operator blendermcp.export_to_eimu：導出 GLB → stdlib urllib multipart POST → 報結果 ｜ 證據: 13983ce7
- [畫布與工作流] 一次性連接碼鑄發 — POST /api/canvas/scene-3d/link 需登錄鑄碼，code = base64url("scene-3d-link.{userId}.{到期毫秒}") + "." + hmacHex（HMAC-SHA256 無狀態，不新增存儲）；缺 env 時誠實 503，不降級 ｜ 證據: 13983ce7
- [畫布與工作流] 3D 上傳路由多身份來源 — POST /api/canvas/scene-3d 多認一種身份，三條優先序＝Bearer 連接碼 → cookie（requireVerifiedUser，順序與語義逐字不變）→ 表單 code；落地物件鍵仍用驗出來的 userId，與 cookie 路徑同一套 ｜ 證據: 13983ce7
- [畫布與工作流] 畫布 UI 連接 Blender — CanvasNodeCreateMenu 增「連接 Blender」→ 鑄碼 → 顯示可複製連接碼與到期時間 ｜ 證據: 13983ce7
- [畫布與工作流] 團隊命名空間畫布 — project.scope === "team" 且已驗成員身份 → 落 canvas/team/<teamId>，teamId 以 relay 回傳的權威值蓋章（客戶端送來的不採信）；團隊畫布單寫（後寫覆蓋），刻意不做鎖／CRDT／衝突解決 ｜ 證據: c9696948
- [畫布與工作流] 建畫布閘（真資料源走 HMAC relay） — team-canvas-gate 真源改走 /api/internal/team-membership relay（逐行照抄 newapi-session-token 的 ViaRelay 模式，換路徑與 signatureDomain 防跨端點重放）；判定與 team-governance.canCreateSharedCanvas 逐字對齊；relay 回 null → 放行（fail-open 兜底）；先判後存，拒時不呼叫任何 save*、不產生半成品專案，既有專案更新不受事後關閘影響 ｜ 證據: c9696948
- [畫布與工作流] 建畫布閘接入全倉唯一落盤路徑 — PUT /api/canvas/projects（upsert by id，全倉唯一建/落盤路徑）接線；上游三個真實前端建立來源（工具箱新建画布 / agent 下發 canvas_apply_ops 的 debounce 存檔 / 模板鋪畫布）全收斂到它 ｜ 證據: c4c895d3

## 創作域

- [創作域] 剪輯質檢閘（交付／導出門檻） — timeline_lint 在域根與 qc-master 皆寫成「must 級未清不得交付／不得導出」的閘門 ｜ 證據: 2890c923

## 帳號與增長

- [帳號與增長] 新人禮（首次登錄送約 5 張標準圖額度） — 首次登錄即送 5 币（= 5 × 預設模型標準圖真實定價，2,500,000 quota，WELCOME_GIFT_* 具名常量）；資格＝generation_job 無 succeeded；/api/auth/me 驗證通過後掛發放（每實例每用戶只問一次控面，3s 超時，失敗不擋登錄） ｜ 證據: 629b4ae5
- [帳號與增長] 新人禮回溯補發 — /api/internal/welcome-gift 控制面 HMAC 端點 op=grant / op=backfill[dryRun]，追溯未出過圖的既有用戶 ｜ 證據: 629b4ae5
- [帳號與增長] 新人禮站內通知每用戶只一次 — 站內通知改由 Vercel 登錄路徑寫入（welcome-gift-login.ts），控制面回 noticePending、Vercel 寫後經 op=noticed 回執；登錄發放與運維回溯發放都只收一次「新人礼：已送你 5 币，够生成约 5 张图」 ｜ 證據: fc2c8053
- [帳號與增長] 新人禮首登彈窗 — 已發放未展示才彈一次，閘門權威在服務端 welcome_gift_grant.modal_seen_at ＋ internal op=modal_seen（不複用 noticed_at，否則彈窗永遠不出現）；localStorage 只擋同設備重複彈 ｜ 證據: 586d83bd
- [帳號與增長] 彈窗主按鈕只預填不發送 — 「馬上生成第一張」走 AgentChatSurface 既有 prefillRequest 通路（輸入框有字、光標在末尾、聚焦在框上，人再按送出）；示例句與聊天面板空態 chips 共引用 lib/agent-example-prompts 單一真源 ｜ 證據: 586d83bd
- [帳號與增長] 主輸入區被登入擋下的一句話不再消失 — 未登錄在主輸入區送出被 auth 擋下時那句話寫進 PROMO_PENDING_KEY（與宣傳片同一格）並讀回驗證（空句不覆蓋已存），登入態翻真後既有的補送 effect 原樣接手 ｜ 證據: a8362440
- [帳號與增長] 只對 auth 擋下才補送 — onSendBlockedByAuth 只在 closedReason==='auth' 這一種上拋（網路抖動／上游故障不留），notice 文案同時說得出路 ｜ 證據: a8362440
- [帳號與增長] 作品公開分享頁 — /p/<shareId>，shareId 128-bit 隨機（base64url 22 字）不可由 artifact/entry id 推得、不可枚舉；默認不公開（沒點過分享就沒記錄）、可撤銷且撤銷＝刪記錄（同一鏈接當場 404） ｜ 證據: d4b2a8b8
- [帳號與增長] 「做同款」增長回路 — 分享頁「做同款」復用圖庫卡既有交接通道（?agent=1&q=）＋ commit a8362440 的「未登錄不丟話」，未登錄者只差一次登錄 ｜ 證據: d4b2a8b8
- [帳號與增長] 分享鏈路 UTM — 分享鏈接帶 utm_source=share&utm_medium=p&ref=<shareId>，canonical 路徑不帶參數 ｜ 證據: d4b2a8b8
- [帳號與增長] 已驗證真實 email 觸達 — GitHub /user/emails 取 verified（優先 primary）、Google userinfo 取 email_verified===true 的真實 email 落 user_attribution.email；只在已驗證時帶值、未驗證一律 null；每次登錄冪等 upsert（email 最新已驗證值勝出） ｜ 證據: 86fb664b
- [帳號與增長] 註冊來源首觸歸因 — root layout 掛 AttributionCapture，首次進站把 utm_source/medium/campaign、referrer host、落地路徑寫進 eimu_first_touch cookie（90 天，首觸不覆蓋）；註冊/首次登錄經 HMAC 簽名通道落 user_attribution（signup_source = utm_source → referrer host → 'direct'，小寫分組鍵），/api/auth/me 兜底覆蓋微信等無 callback 路徑 ｜ 證據: 86fb664b
- [帳號與增長] 生命週期郵件：新人禮歡迎信 — worker 帳本維護循環（10 分鐘）掛點；email 取自 user_attribution，新人禮 applied 才發 welcome ｜ 證據: 9f883c61
- [帳號與增長] 生命週期郵件：48h 未出圖激活提醒 — nudge 郵件帶 List-Unsubscribe 一鍵退訂（HMAC，域分隔復用 GENERATION_BILLING_RELAY_SECRET），/api/email/unsubscribe 代理至控制面寫 email_preference ｜ 證據: 9f883c61
- [帳號與增長] 郵件發送冪等與錯誤分級 — email_send_log 佔位冪等＋Resend Idempotency-Key；單收件人錯誤記 failed 不重試，系統性錯誤（401/403/429/5xx/網路）釋放佔位並中止本輪、下輪重試；未配置 RESEND_API_KEY 整體 no-op ｜ 證據: 9f883c61
- [帳號與增長] 生命週期郵件三個產品時刻重做 — 首圖 / 未出圖提醒 / 額度用完（新增 depleted：出過圖、餘額不足一張標準圖、從未充值、最後出圖已過 1h → 一次）；正文給出已做張數與最低一檔價格/可做張數，CTA 去充值 ｜ 證據: 350ef376
- [帳號與增長] 郵件品牌版式與真實示例一點即填 — 表格佈局＋preheader＋品牌色（DESIGN.md：#2d3142 CTA、金幣色）＋logo；示例＝同一句 prompt 以 gpt-image-2 真實生成的圖，點擊走 /?agent=1&q= 交接通道（提示詞填進助理輸入框） ｜ 證據: 350ef376
- [帳號與增長] key_idle 召回信 — 建第一把 biz key 滿 24h、卻沒有任何 source=biz 的 job、未退訂、有已驗證 email → 發一次；curl 直接復用 dev-quickstart 的 gpt-image-2 範例，CTA 指向實際存在的 /settings/api-keys 路由 ｜ 證據: a4be1a00
- [帳號與增長] 自簽邀請碼 — src/lib/referral-code.ts 形狀 `<id 36進位>-<hmac8>`／`<userId>-<8hex>`；解碼零查表、簽名防偽（亂填 id 只會被拒），密鑰復用 GENERATION_BILLING_RELAY_SECRET 以域前綴分隔；前端 looksLikeInviteCode 只擋畸形，驗簽一律在服務端 ｜ 證據: e33571e9
- [帳號與增長] 分享即邀請 — share-remix.ts 分享連結首位帶作者邀請碼，看圖的人註冊並出首圖＝作者邀請成功 ｜ 證據: e33571e9
- [帳號與增長] 邀請綁定時機 — 只在被邀請人尚未出圖時綁，首個邀請勝出；碼不合法／自邀／已出圖都回 ok（免得每次登錄重送）；Vercel 側 auth/me 併入 applyInviteBinding（帶記憶避免重試風暴，永不擋登錄） ｜ 證據: e33571e9
- [帳號與增長] 邀請獎勵掛「出第一張圖」 — 被邀請人首圖成功後雙方各發一次；金額口徑＝plans.ts 的 INVITER/INVITEE_REWARD_IMAGES × STANDARD_IMAGE_COINS（與新人禮同一把尺）；每人上限 MAX_REWARDED_INVITES 防小號農場；帳本冪等鍵按角色分開、沿用五態狀態機；上游調額失敗＝整輪停且 quota 未動記 failed 可重試；worker 維護輪接上 ｜ 證據: e33571e9
- [帳號與增長] 邀請定價頁文案與自簽連結 — 文案改「好友出第一張圖你得 N 金幣」，邀請連結改走 /api/user/invite 自簽連結（取代 fetchAffCode），FAQ 補「分享作品連結同樣算邀請」與上限說明 ｜ 證據: e33571e9
- [帳號與增長] 開發者新人禮自動補發 — runWelcomeGiftDevCatchUp()：外部用戶（持有 biz key ∧ 未領過新人禮 ∧ 沒有成功出圖）自動補發，直接複用 grantWelcomeGift，每輪上限 20 人；接入 runAccountMaintenanceOnce，失敗不中斷維護輪 ｜ 證據: 78a019a3
- [帳號與增長] 新人禮排除口徑唯一權威 — welcomeGiftExcludedUserIds() 排除名單唯一權威＝env INTERNAL_USER_IDS（與統計剔除同源），不再按「持有 biz key」排除 ｜ 證據: 78a019a3

## 前端與UI

- [前端與UI] 通知入口搬進「API 密鑰」下拉 — NotificationBell 增 variant?: "icon" | "menuItem"；menuItem 渲染成 DropdownMenuItem 一行（Bell 圖標 + 「站內通知」+ 未讀徽章，>0 才渲染、>9 顯示 9+），Navbar 在密鑰下拉末尾加一行（零 header 寬度成本） ｜ 證據: a6cc34f0
- [前端與UI] 通知面板掛 body 避免退場卸載 — Radix 2.1.24 退場動畫會卸載整棵 content 子樹 ⇒ 面板改由 mountNotificationPanel() 用 createRoot 掛到 body（模組級單例，先卸舊再掛新），面板容器顯式 pointerEvents:auto（菜單退場 200ms Radix 會把 body 設成 pointer-events:none） ｜ 證據: a6cc34f0
- [前端與UI] 通知面板錨點純函式 — computePanelAnchor({rect,barBottom,innerWidth})、nextPanelAnchor(previous, el, innerWidth)（el 為 null 時原樣回 previous，絕不清成 null）；坐標在點擊當下量成數字存起 ｜ 證據: a6cc34f0
- [前端與UI] Navbar 項數回退 — 移除 <NotificationBell /> 與其 import，餘額/歷史/文檔/密鑰/用戶/退出回到通知刀之前的項數並再少一項 ｜ 證據: 2d601be7

## 運維與觀測

- [運維與觀測] 激活漏斗卡 — 窗口（7/30 天）註冊 → 發起生成 → ≥1 成功 → 首次生成後 7 日內回訪 → 現金充值，每步為上一步子集；D1 回訪、未回訪即付費、非現金入帳單列 ｜ 證據: 9218cabf
- [運維與觀測] 內部流量剔除 — INTERNAL_USER_IDS env（預設 117,82），消耗／剩餘額度／漏斗統一按任務擁有者（web:<uid> 或 biz_api_key.user_id）剔除，預設不含、可切換 ｜ 證據: 9218cabf
- [運維與觀測] 新用戶首圖耗時指標 — 註冊 → 首個 succeeded finished_at、首單 created → finished 的 p50/p90（最近秩）；註冊走 new-api 管理 API listGatewayUsersRegisteredSince（不直連 sqlite） ｜ 證據: 9218cabf
- [運維與觀測] 漏斗按來源拆分 — statistics-projection 新增 sources（每來源 註冊/發起/成功/付費），各來源每格加總恒等於總漏斗對應步驟（具名測試釘住）；無歸因事實歸 UNATTRIBUTED 桶（不猜成 direct）；歸因讀取失敗回 sourceBreakdownUnavailable 由 /admin 明示 ｜ 證據: 86fb664b
- [運維與觀測] Next.js maxDuration 段配置須字面量 — maxDuration 只能寫字面量 300，寫常量會炸整包 build（tsc 與單測都抓不到） ｜ 證據: 29e6ca91

## 團隊與企業

- [團隊與企業] 團隊成員角色管理 — GET/POST /api/v1/team/members（action: set_role | remove） ｜ 證據: 2447c874
- [團隊與企業] 建畫布權限開關 — GET/POST /api/v1/team/settings（member_create_canvas） ｜ 證據: 2447c874
- [團隊與企業] 加入審批四態 — GET/POST /api/v1/team/join-requests（apply | decide，四態） ｜ 證據: 2447c874
- [團隊與企業] 團隊生命週期與 48h 冷靜期 — GET/POST /api/v1/team/lifecycle（dissolve | withdraw | leave）；解散 48h 冷靜期內可撤回、過期不可撤回、執行冪等 ｜ 證據: 2447c874
- [團隊與企業] 治理控制台 UI — src/app/settings/team 頁 + TeamConsoleClient 六面（成員角色／建畫布開關／加入審批／席位／解散+冷靜期撤回／用量含守恆檢驗），入口在 Navbar 密鑰小菜單與 ApiKeysClient 頁尾 ｜ 證據: c4c895d3
- [團隊與企業] 治理控制台認證 — 認證走團隊主帳 B 端密鑰（只存 sessionStorage，不落盤不記 log） ｜ 證據: c4c895d3
- [團隊與企業] 席位未接計費的誠實標註 — GET /api/v1/team/seats 加 billing_connected:false ＋ billing_note（addition-only） ｜ 證據: c4c895d3

---

## 非程式碼能力（VPS／部署／DB 遷移／外部服務／運營流程）

- 外部 biz key 首調審計報告（唯讀） — VPS 唯讀查 Postgres + new-api sqlite：23 把外部 key 裡 14 人從未發起任何生成（12/14 與最後登入同一分鐘內）；9 人有發起者首單成功 5 人、首單退款／拒單 4 人（deadline_exceeded×2、model_unsupported×1、billing zombie×1）；23 人 new-api 消費記錄（type=2）為 0 行、top_ups 空表 ｜ 證據: 0f9e2962
- 審計口徑重算為 21 位外部持有者 — 87/90 判為內部帳號（admin 供給型巨額額度、零登入零簽到、建號即簽 key 即出圖）自 23 位扣除；job 級按 failure_class 精確扣除 426 → 401（succeeded 227→215、deadline_exceeded 178→170、model_unsupported 6→2） ｜ 證據: f5018d30
- VPS skill 索引落位 — VPS 側索引 50 → 167（13 份死亡修復 + 104 份本地獨有落位，精準吻合 50+13+104）；VPS 獨有 42 份中 41 份逐位元未動 ｜ 證據: 19f7f257
- timeline 鏈上生產 — timeline_lint 調用 0 → 2 且皆 {"ok":true}、timeline_query 0 → 5 成功；真產物 timelines/25ef4fc6-…/{current.json,versions/1.json,versions/2.json,log.jsonl}（3 clips／1 audio／1 subtitle／9:16），lint 結論被真實消費 ｜ 證據: 6d395e84
- AGENTS.md 付費上游呼叫硬閘規則 — 規則落進工作規則檔（model 白名單為唯一真源、resolution ≤720p、seconds ≤5、提交前先核價、一次授權一次呼叫、花暴君的錢先問） ｜ 證據: e33571e9
- biz-api 「兩種接法」文檔 — 開篇並列 A 標準 OpenAI 同步 base https://eimu.dev/openai/v1（images/generations、chat/completions 含 stream:true、models）與 B 異步 base https://eimu.dev/v1（202+task_id 輪詢／callback／Idempotency-Key），並給 new-api/one-api 加渠道 9 步填法 ｜ 證據: dffaef5b
- openapi／biz-api 契約文檔校正 — response_format 預設改 b64_json、size enum 補 2048x2048、data[0].b64_json 敘述改為 202 異步 + 輪詢取圖、錯誤表改碼、SDK 段落誠實說明 ｜ 證據: a9ceb2f0
- S2 OpenAI 兼容核對報告 — docs/specs-0928/S2-compat-report.md 逐維度差異（異步 202 vs 同步 200、data[] 為 TaskArtifact 無 b64_json、response_format 預設 b64_json、n 1-4、size 固定 4 值）＋三家客戶端接入判定 ｜ 證據: 0cbd7c0c
- /openai/v1 控面部署依賴 runbook — 部署配置必須加 OPENAI_COMPAT_GENERATION_ORIGIN: http://127.0.0.1:3000（兼容層預設打 origin + /api/v1/*，但控面 app 路徑在 /image-control/api/v1/* 底下會落不到 route，真單撞 503 control_plane_unreachable） ｜ 證據: ea31d305
- 決策分界工作規則 — ops／口徑問題自行拍板並在回報寫判準，只有不可逆且偏好因人而異的產品／審美題才回報待裁 ｜ 證據: 8f2eaac2
- DB 遷移 023–031 — 023_team_governance／024_welcome_gift_grant／025_user_attribution／026_welcome_gift_modal_seen／027_lifecycle_email／028_referral／029_api_rejection／030_mapay_credit／031_first_charge_claim（現 repo db/migrations/ 已存在至 033） ｜ 證據: 2447c874 / 629b4ae5 / 86fb664b / 586d83bd / 9f883c61 / e33571e9 / af6c6a49 / e27e3697 / 1b592d5d

## 邊界與拒絕（明確不做／fail-closed／白名單外拒收／誠實降級）

- [邊界語義] 付費上游視頻成本硬閘 fail-closed — model 白名單 7 條外一律拒收；resolution 缺省／空字串拒收；4k/2k/1080p 無條件拒收（上限 ≤720p）；seconds 超上限拒收；三元組 (model,resolution,seconds) 無核價記錄即拒收；拒收寫結構化稽核日誌並拋 400，不重放、不重複燒錢 ｜ 證據: 8d640263
- [邊界語義] 視頻秒數上限先設 10 且三元組顯式枚舉 — PAID_VIDEO_MAX_SECONDS = 10（＝catalog 最短時長），未登錄即 triple_not_priced（非「≤10 全放行」） ｜ 證據: a27b6476
- [邊界語義] 視頻秒數上限放寬至 30 且三元組由 catalog 生成（禁手抄） — PAID_VIDEO_MAX_SECONDS = 30；buildPricedVideoTriples() 由 registry xiaoyxiao claims × GENERATION_MODEL_CATALOG（durations × resolutions）× PAID_VIDEO_ALLOWED_RESOLUTIONS 生成，catalog 改時長/檔位閘門自動跟上；未映射／未核價＝零三元組＝拒收；白名單內但無 claim 維持 fail-closed（grok-video-1.5 依暴君裁定擱置） ｜ 證據: ed732c8e
- [邊界語義] 成本閘作用域收斂 — 三個已退役渠道（cangyuansuanli/napi/drama，僅作協議夾具）豁免；在線渠道與未標明 supplierId 的新渠道一律 fail-closed 拒收，豁免不洩漏 ｜ 證據: 28aaed8d
- [邊界語義] 本機 3D 導入上限由 100MB 收窄為 4MB — 本路由走表單代理，請求體先過平台硬頂（Vercel 4.5MB），100MB 只會讓 4.5–100MB 的檔前端驗證通過卻被平台 413；LibTV 級 100MB 需瀏覽器直傳物件存儲通道，生產 blob 後端是 VPS image-data-api，站內現無該通道 ｜ 證據: 32d9bf2c
- [邊界語義] 連接碼與 OAuth 碼域隔離 — 域前綴與獨立 env SCENE_3D_LINK_SECRET；與 emu-oauth 同密鑰同格式會讓畫布上給用戶複製的連碼變成一把「可鑄 key」的憑證；無狀態的代價（TTL 內無法單獨吊銷，只能等過期或輪換密鑰）寫在檔頭 ｜ 證據: 13983ce7
- [邊界語義] 連接碼驗簽先於域與時效 — 按最後一個 "." 切分 + timingSafeEqual，先驗簽再看域與時效（簽章不過不回報「已過期」，不給「格式對了只是舊了」的假信號） ｜ 證據: 13983ce7
- [邊界語義] 剪輯不做人工多軌時間線 UI — 暴君裁定剪輯由 Agent 做，不做人的多軌時間線 UI，本片只交付站點側契約與配方層 ｜ 證據: 2890c923
- [邊界語義] 審查頁整頁撤除 — 刪 src/app/review/page.tsx 與唯一使用者 src/lib/review-assembler.ts 及其測試；Navbar「審查頁」入口與 robots 的 /review 條目一併拔掉，生產 /review 404（暴君：從沒用過） ｜ 證據: 2d601be7
- [邊界語義] 團隊治理寫入禁影子帳本 — 治理寫入路徑不呼叫任何上游額度調整、不寫任何點數帳本（測試釘死）；配額唯一通路仍是 member-quota.ts（點數權威在 new-api users.quota，分配＝轉移且寫絕對值天然冪等） ｜ 證據: 2447c874
- [邊界語義] 最後一個 owner 不可移除／不可退出 — 409 last_owner ｜ 證據: 2447c874
- [邊界語義] 滿員時加入申請不得通過；member 且開關關閉時建畫布被拒 ｜ 證據: 2447c874
- [邊界語義] 一個 user 同時只屬一個團隊（現場推翻競品假設） — 019 的 member_user_id UNIQUE 使競品「每人可加入 5 團隊」結構上不可達，實際緊約束是配額桶模型，已在 migration 與模組註釋標明 ｜ 證據: 2447c874
- [邊界語義] 治理層未配置／查不到成員身份 fail-open — relay 回 null（未配置／逾時／查不到／載荷不合法）→ 放行；查不到成員身份 → 降級個人命名空間（不拒、也不寫進別人的團隊） ｜ 證據: c9696948
- [邊界語義] 席位未配置絕不當 0 元 — 未配置一律回 price_not_configured（0 元成立訂單＝誠實性事故） ｜ 證據: c9696948
- [邊界語義] 席位下單翻線前一律拒單 — 501 seat_order_fulfillment_unwired；刻意不呼叫 mapay 收款面（既有 notify 端 resolvePricingPlan 必然 null ⇒ 會「收錢不履約」） ｜ 證據: c9696948
- [邊界語義] 成員額度不足／停用 fail-closed — 成員額度讀不到／unlimited 的 503 control_plane_unavailable 行為一字不動 ｜ 證據: a9ceb2f0
- [邊界語義] 402 語義保留 — 預留先於生成不變；非 402 的其他錯誤碼一個沒動 ｜ 證據: a9ceb2f0
- [邊界語義] 首充通道不可用 fail-closed 不給折扣 — 通道不可用時 fail-closed；前端只做顯示閘門，真正執法在 checkout 403 與入帳時按正價折算 ｜ 證據: 1b592d5d
- [邊界語義] 開發範例不編造 model id — PixAI id 走偏好序 + catalog 與可見白名單雙重存在性檢查，查無即不顯示 ｜ 證據: 0cbd7c0c
- [邊界語義] 個資不出邊界 — email 屬個資：永不進日誌、永不進返回值，所有日誌只印 user_id 與布爾狀態 ｜ 證據: 86fb664b
- [邊界語義] 郵件永不嵌入真實 key — curl 範例 key 位置只放 $EMU_API_KEY 佔位符 ｜ 證據: a4be1a00
- [邊界語義] 拒絕遙測不記敏感內容且絕不影響客戶請求 — 只記 key 前 8 位、不記 prompt/完整 key；儲存層錯誤靜默吞掉；成功與 202 不記 ｜ 證據: af6c6a49
- [邊界語義] 斷路器 fail-open 與可回滾 — DB 失敗 fail-open；GENERATION_MODEL_BREAKER_DISABLED=1 回滾；冪等重放例外 ｜ 證據: f009cf09
- [邊界語義] 明確未做（誠實標註） — 團隊支付下單（席位計價／續費／扣款）、任何團隊前端 UI（片F 未做部分）、canvas 側建畫布接線（僅交付 canMemberCreateSharedCanvas）、解散執行接排程器（executeTeamDissolution 已冪等實作，需外部觸發）、團隊建立入口、席位 SKU、控制面副本同步、「團隊共享畫布」存儲層 scope 維度（CanvasProject 目前 per-user，無 team/scope 欄） ｜ 證據: 2447c874 / c4c895d3
- [邊界語義] 建畫布閘在 Vercel 側當時不生效 — /api/canvas/projects 不在 next.config.mjs 的 beforeFiles 代理清單內、由 Vercel 服務，而 Vercel 按設計不持有 GENERATION_DATABASE_URL / GENERATION_CONTROL_PLANE_ENABLED ⇒ governanceStoreEnabled()=false ⇒ 閘走「未配置→放行」；要真生效需三選一（皆超本片權限） ｜ 證據: c4c895d3
- [邊界語義] 被拒時前端 403 降級 — client.ts 把 403 一律降級成 not_authenticated（既有靜默降級設計，未改） ｜ 證據: c4c895d3
- [邊界語義] timeline 孤兒子會話仍維持 404 — 父會話先被刪／收尾時子成孤兒 → parentFallback=no → 維持 404（無主可歸屬）；byChildOc 是 in-memory，gateway 中途重啟會回溯 miss ｜ 證據: 6d395e84
- [邊界語義] 團隊畫布不做鎖／CRDT／衝突解決 — 團隊畫布單寫（後寫覆蓋）為刻意設計 ｜ 證據: c9696948
- [邊界語義] 人工碼禁止計入付費漏斗 — 人工碼是行銷／賠付，不是現金流入 ｜ 證據: bed6f558
- [邊界語義] skill 索引唯一判死條件＝byte 0 不是 `---` — 同時推翻兩個錯誤前提：name ≠ 目錄名不是死因、frontmatter YAML 不合法不是死因（VPS 探針：name-mismatch 與 bad-yaml 都被收錄） ｜ 證據: 19f7f257
- [邊界語義] 未出圖不扣費（B 端同步層） — 失敗／超時回 OpenAI 錯誤信封，沿用 durable 退款語義 ｜ 證據: 8cb16aea
- [邊界語義] /openai/v1 只列可出圖模型 — 金鑰白名單 + 目錄 kind=image + 既有熔斷／斷供閘三閘共用 ｜ 證據: 8cb16aea

## 存疑（訊息不足以判斷者，寫明缺什麼證據）

- 5da7919e 的 sd10 族形狀假設（同 sd4 協議）自陳待有餘額後實彈覆核；且同日 8d640263 把 cangyuansuanli 整條移除 ⇒ 該重映射的生產有效性無法從本批（含訊息與 diff）確認。缺：上游實彈提交證據。
- e27e3697 自陳未落地：控面端點需另行部署到 VPS（本次不部署）；pending/unknown 屬人工核對路徑。缺：部署與真單入帳證據。
- 8cb16aea 當時未部署（本批無生產驗收），1b49771a 與 ea31d305 只是補上代理與部署依賴。缺：本批內的生產驗收。
- c4c895d3 自陳「本片不宣稱生產已生效」（見上 fail-open）；真生效需三選一，超本片權限、已回報待裁。
- 0cbd7c0c 自陳未落地：402 統一為 insufficient_balance 與 contract-lock.test.ts 的 insufficient_quota 契約鎖互斥，依 spec 停下回報；次一 commit a9ceb2f0 以暴君裁定解鎖。
- a8362440 真人瀏覽器端到端（打字→被擋→GitHub 回來→自動送出）未驗（本環境無瀏覽器，認證紅線禁 headless OAuth）。
- e33571e9 自陳未驗：真生產發碼與真實邀請鏈路端到端。
- 2d601be7 只拔 header 入口：通知組件本體（src/components/notifications/*）與通知／公告 API 未動，是否連機制一起撤等暴君一句話。
- 2890c923 的 orchestrator-beast-frame 兩條既有 L152 紅燈逐字未動、仍紅（未掩蓋），非本批新增能力；另 19f7f257 自陳全量測試 fail 恆為既有 2 條。
- 記憶衝突：`2026-09-27-team-seat-pricing-order-allocation.md` 寫「本片未 commit（暴君指定）」，但 c9696948 確實提交了該三刀（檔案與端點現場仍在）。以現場為準；差異僅在「是否 commit」的敘述，能力面無衝突。

---

## 逐條對帳（47/47，一個都沒跳過）

2890c923 — 剪輯域 Agent 配方庫＋persona 默認注入＋交付質檢閘（Agent助理／創作域）
2447c874 — 團隊治理六面 API（團隊與企業）
32d9bf2c — 本機 GLB 導入 3D 場景卡（畫布與工作流）
f009cf09 — 模型可用性斷路器＋提交前 fail-fast＋替代模型建議（生成核心）
629b4ae5 — 新人禮首次登錄發放＋回溯補發＋佔位冪等（帳號與增長／控制平面與計費）
9218cabf — 激活漏斗卡＋內部流量剔除＋新用戶首圖耗時（運維與觀測）
fc2c8053 — 新人禮站內通知每用戶只一次（帳號與增長）
13983ce7 — Blender 一鍵導出＋一次性連接碼＋上傳多身份（畫布與工作流）
bed6f558 — 兌換碼分頁全掃＋基線前兩條腿＋人工碼不記現金（控制平面與計費）
2d601be7 — 撤審查頁＋拔 header 鈴鐺（邊界與拒絕／前端與UI）
6d395e84 — timeline 族子代理身份 fallback（Agent助理）
19f7f257 — skill 索引 byte-0 修復＋索引守門測試（Agent助理）
c4c895d3 — 建畫布閘接入落盤路徑＋治理控制台 UI（團隊與企業）
5da7919e — 上游模型名重映射＋欠費詞表＋欠費 30 分鐘冷卻（模型與供應商）
782d3214 — 影片輪詢窗口 1200s＋生成預算按 kind 分級（生成核心）
43decfd6 — 成品頂層 url 解析（模型與供應商）
a6cc34f0 — 通知入口搬進 API 密鑰下拉＋面板掛 body（前端與UI）
a8362440 — 被登入擋下的話登入後自動補送（帳號與增長）
8d640263 — xiaoyxiao 唯一權威渠道＋付費上游成本硬閘（模型與供應商／邊界與拒絕）
a27b6476 — 視頻秒數上限 10＋三元組顯式枚舉（邊界與拒絕）
c9696948 — 建畫布閘真源 relay＋團隊命名空間＋席位計價/下單接縫/分配（團隊與企業／畫布與工作流／控制平面與計費）
ed732c8e — 視頻秒數上限 30＋三元組由 catalog 生成（邊界與拒絕）
86fb664b — 已驗證真實 email＋首觸歸因＋漏斗按來源拆分（帳號與增長／運維與觀測）
d4b2a8b8 — 作品公開分享頁＋做同款（帳號與增長）
586d83bd — 新人禮首登彈窗＋主按鈕只預填（帳號與增長）
28aaed8d — minimax-h3 時長表補齊＋成本閘作用域收斂（模型與供應商／邊界與拒絕）
9f883c61 — 生命週期郵件 welcome/nudge＋一鍵退訂（帳號與增長）
be716f12 — 支付回跳自動兌換＋餘額不足就地去充值（控制平面與計費）
2e44d778 — 純修復（canvas-meta 測試型別，修控面 next build lint）→ 無新能力
350ef376 — 生命週期郵件三時刻重做＋品牌版式＋真實示例一點即填（帳號與增長）
43be7f6e — 欠費分類前置＋供給面斷供判定（生成核心）
e33571e9 — 自簽邀請碼＋分享即邀請＋首圖後自動發幣（帳號與增長）
af6c6a49 — /v1 拒絕遙測 api_rejection＋出口攔截（B端API／運維與觀測）
0cbd7c0c — 建 key 給可複製 curl＋OpenAI 兼容核對報告（B端API／非程式碼）
e27e3697 — notify 直接入帳＋自簽訂單參數＋mapay_credit 佔位冪等（控制平面與計費）
0f9e2962 — 純文檔（23 把外部 biz key 首調審計報告）→ 非程式碼能力
a9ceb2f0 — /v1 餘額不足統一 402 insufficient_balance＋契約鎖同步（B端API／邊界與拒絕）
1b592d5d — 首充專享限一次＋名額併發執法（控制平面與計費）
f5018d30 — 純文檔（審計口徑重算 21 位外部持有者）→ 非程式碼能力
8f2eaac2 — 純規則（決策分界）→ 非程式碼能力
a4be1a00 — key_idle 召回信（帳號與增長）
78a019a3 — 開發者新人禮自動補發＋排除口徑改 INTERNAL_USER_IDS（帳號與增長）
dffaef5b — 純文檔（biz-api 兩種接法＋new-api 加渠道填法）→ 非程式碼能力
8cb16aea — /openai/v1 同步兼容層三路由（B端API）
1b49771a — 同步層加 beforeFiles 代理改控面執行（B端API／運維與觀測）
29e6ca91 — 純修復（maxDuration 段配置改字面量 300）→ 無新能力，暴露建置邊界語義
ea31d305 — 純文檔（runbook：OPENAI_COMPAT_GENERATION_ORIGIN 部署依賴）→ 非程式碼能力