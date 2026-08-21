# Topview 工具面 ↔ 我方 gateway 節點 kind 映射（偵察報告）

偵察方式：GitHub API + raw 逐文件讀取（topviewai/skill@main、topviewai/codex-topview-ai@main、teddypecourt/topview-mcp-server@main），對照我方 workspace。

## 1. Topview 工具清單（證據：topviewai/skill 之 mcp.example.json、INSTALL_FOR_AGENTS.md、topview-generate/SKILL.md 與 references/*.md）

統一 MCP 入口 `topview-mcp`（https://mcp.topview.ai/mcp）。創作類「熱工具」直調 `topview_*`/`ta_*`；電商情報域走漸進披露：`use_amazon_data`/`use_tiktok_data`/`use_shopee_data`/`use_youtube_kol` → `get_tool_schema` → `call_tool`（deferred，不出現在 tools/list）。

| 工具 | 能力（taskType） | 異步形狀 |
|---|---|---|
| topview_generate_video | text_to_video / image_to_video / omni_reference / motion_control / video_avatar | submit→taskId→query_task |
| topview_avatar_video | avatar4/avatar4Fast 口播數字人（scriptMode text/audio，≤120s/段） | taskType=avatar_video |
| topview_generate_image | text_to_image / image_edit / storyboard | 同上 |
| topview_remove_background | 抠图（可帶手繪 mask） | taskType=remove_background |
| topview_product_avatar | 商品進模特場景（auto/manual 放置、keepTarget） | taskType=product_avatar |
| topview_generate_voice / topview_clone_voice / topview_list_voices | TTS / 聲音克隆 / 聲音列表 | text_to_speech / voice_clone |
| topview_generate_music / topview_generate_audio | 音樂 / 參考音色即時語音 | — |
| ta_upload_credential / ta_upload_check_file | 上傳：credential→PUT bytes→check（fileId） | 同步 |
| topview_query_task | 統一輪詢 {taskType, taskId, needCloudFrontUrl} | init→running→success/fail |
| topview_list/create_board、list_board_tasks、get_board_task | 結果板（讀/建，無改刪） | 同步 |
| topview_get_credit / list_credit_logs | 積分餘額與流水 | 同步 |
| topview_get_generation_config | 活模型配置（submitModel/requiredSubmitFields/submitParameterOptions/defaultSubmitParameters/modelSelectionPolicy） | 同步 |
| topview_prepare_canvas_jump | >15s 或多場景長視頻 → Canvas 預填跳轉（sid） | — |

底層 REST（codex 倉 legacy scripts/shared/client.py，api.topview.ai，headers Topview-Uid + Bearer）：每 taskType 一對 `/v*/common_task|photo_avatar|voice|product_avatar/…/task/submit|query`（如 /v1/common_task/text2video/task/submit、/v2/common_task/image2video/…、/v3/product_avatar/task/image_replace/…），envelope 統一 `{code,message,result}`；上傳 /v1/upload/credential + /v1/upload/check；板 /boards/*；積分 /user/credit/*。

## 2. 映射表（我方證據：src/lib/canvas/types.ts、docs/agent-native-ultimate-blueprint-zh.md §3.5/3.6、docs/biz-api.md、src/lib/generation-core/）

| Topview | 我方對應物 | 判定 |
|---|---|---|
| get_generation_config | GET /v1/capabilities + MCP discover_capabilities（availability/queue_eta/price_from） | 已有，且更強（含價格與隊列 ETA） |
| ta_upload_credential/check | POST /v1/uploads（signed PUT+Idempotency-Key）+ create_upload | 已有 |
| generate_image / generate_video | generate_image + edit_image（MCP）/ /v1/images/generations + /v1/image-jobs | 圖已全有；**視頻生成=P1** |
| avatar_video（數字人） | — | **P1**（無口播數字人渠道） |
| remove_background | /v1/images/edits 可吸收；顯式 remove_bg 意圖工具 | P1（低優先，作 workflow SKU） |
| product_avatar | run_workflow（workflow SKU：remove_bg→edit 鏈） | P1（模板層，非新 kind） |
| generate_voice / clone_voice / music | — | **P1**（音頻域空白；canvas 節點 kind 已預留 audio） |
| query_task | get_generation / GET /v1/image-jobs/{id}（next_action） | 已有 |
| boards 4 工具 | CanvasAgentOp 8 op + canvas.* SSE 事件（多節點圖、derive、budget） | 已有且更強（板=平面夾，我方=圖） |
| get_credit / credit_logs | get_usage / /v1/billing/balance / billing/quotes（報價先行） | 已有，且 quote/退款策略更完整 |
| prepare_canvas_jump | N/A——我方 canvas 即 agent 原生面，無需跳轉 | 反向印證我方哲學 |
| use_*_data 情報域 / social-media-uploader 發布 / content-collector 調研 | — | **Won't do**（選品情報與發布分發非執行層職責；我們是被調用的 B 端執行層） |

## 3. 「模板 SKU = skill 文本 + 固定工具鏈」實例

- **商品模特圖 SKU**（references/product_avatar.md）：list_product_avatar_categories → list_product_avatars → remove_background → 以 `bgRemovedImageFileId` 直鏈 product_avatar（中間產物不落盤不上傳）→ poll。
- **長口播 SKU**（references/avatar4.md）：>120s 劇本按句切分段、鎖定同一 voice/mode/caption/caption/motion，並行 submit 各段、各自輪詢、按序交付。
- **腳本→視頻 SKU**（codex 倉 skills/video-script-writer/SKILL.md）：先產 Hook→Body→CTA 劇本與分鏡 → ai_image `--type storyboard` 出分鏡預覽圖 → video_gen `--type omni --storyboard-image`，prompt 固定句式「图一是分镜参考图，图二是xxx…」——模板=文本契約+固定調用順序，非獨立工具。
- **情報→素材 SKU**（amazon-ops tool_routing.md）：market_research→keyword→review 後「chain to topview-generate」跨 skill 交接。

## 4. 異步與錯誤碼設計要點（references/error_handling.md、client.py、社區 poll.ts/constants.ts）

- submit/query 成對；query 需同時帶 taskType+taskId（路由鍵+身份）。狀態機 init→running→success/fail；允許部分成功（只重試失敗項）。
- **輪詢 4–5s 間隔、5–10min 超時；timeout≠fail**：保留 ID 續查、嚴禁盲目重提（重複扣費）。服務端另有 4007「存在未完成任務」防併發重複。
- 社區版工具含 `waitForCompletion`（默認 true=工具內代步輪詢返成品；false=返 taskId 手動查）——與我方 `Prefer: respond-async` 同一取捨。
- 錯誤分類：401 認證；4000/4001/4003 參數（需重讀 config）；4100 積分不足（先查餘額）；4007 併發鎖；5003 忙（10–30s 退避重試）；5000/5001 內部（重試一次）；6001 安全拒絕；DURATION_EXCEEDS_MCP_LIMIT 則改道 Canvas。核心紀律：**4000/4100 後未經用戶同意不得換模型**。
- 計費：按 taskType 明碼（TTS 0.1、product_avatar 0.5 credits），失敗退款，先查可負擔性再提交——對應我方 quote→reserve→refund 鏈，我方 failure-classifier/status-query/callback-outbox 已覆蓋，可補的是「部分成功只重試失敗項」與「4007 式併發鎖」語義。

## 5. 許可證邊界與可借鑑模式

- topviewai/skill：**Apache-2.0**（文檔模式可借鑑，需 attribution）；topviewai/codex-topview-ai：**MIT**（含 THIRD_PARTY_NOTICES）；teddypecourt/topview-mcp-server：**無 LICENSE 文件**（默認保留全部權利——只看 API 形狀，勿抄代碼）。
- 可借鑑（只抄模式不抄殼）：① 活配置單一真相（get_generation_config 統一 submitModel/必填/枚舉，禁本地模型註冊表）——強化我方 /v1/capabilities 權威性；② 漸進披露（deferred 工具經 get_tool_schema/call_tool）緩解工具清單膨脹，未來工具>30 個時採用；③ 意圖路由表（用戶意圖→工具+taskType 二維表）寫進 skill 文本；④ 結果可分享 URL（boardResultId 深鏈）對應我方 canvas 節點/artifact 深鏈；⑤ 邊界誠實聲明（不可用操作直說，不教繞路）。
- 不借鑑：統一 `{code,message,result}` 數字碼信封（我方已承諾 OpenAI 兼容形狀+structured error+next_action）；>15s 踢去自家 Canvas 的能力截斷（我方無此產品分層）。
