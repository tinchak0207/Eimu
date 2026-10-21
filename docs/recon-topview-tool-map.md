# Topview 工具面 ↔ 我方 gateway 节点 kind 映射（侦察报告）

侦察方式：GitHub API + raw 逐文件读取（topviewai/skill@main、topviewai/codex-topview-ai@main、teddypecourt/topview-mcp-server@main），对照我方 workspace。

## 1. Topview 工具清单（证据：topviewai/skill 之 mcp.example.json、INSTALL_FOR_AGENTS.md、topview-generate/SKILL.md 与 references/*.md）

统一 MCP 入口 `topview-mcp`（https://mcp.topview.ai/mcp）。创作类「热工具」直调 `topview_*`/`ta_*`；电商情报域走渐进披露：`use_amazon_data`/`use_tiktok_data`/`use_shopee_data`/`use_youtube_kol` → `get_tool_schema` → `call_tool`（deferred，不出现在 tools/list）。

| 工具 | 能力（taskType） | 异步形状 |
|---|---|---|
| topview_generate_video | text_to_video / image_to_video / omni_reference / motion_control / video_avatar | submit→taskId→query_task |
| topview_avatar_video | avatar4/avatar4Fast 口播数字人（scriptMode text/audio，≤120s/段） | taskType=avatar_video |
| topview_generate_image | text_to_image / image_edit / storyboard | 同上 |
| topview_remove_background | 抠图（可带手绘 mask） | taskType=remove_background |
| topview_product_avatar | 商品进模特场景（auto/manual 放置、keepTarget） | taskType=product_avatar |
| topview_generate_voice / topview_clone_voice / topview_list_voices | TTS / 声音克隆 / 声音列表 | text_to_speech / voice_clone |
| topview_generate_music / topview_generate_audio | 音乐 / 参考音色即时语音 | — |
| ta_upload_credential / ta_upload_check_file | 上传：credential→PUT bytes→check（fileId） | 同步 |
| topview_query_task | 统一轮询 {taskType, taskId, needCloudFrontUrl} | init→running→success/fail |
| topview_list/create_board、list_board_tasks、get_board_task | 结果板（读/建，无改删） | 同步 |
| topview_get_credit / list_credit_logs | 积分余额与流水 | 同步 |
| topview_get_generation_config | 活模型配置（submitModel/requiredSubmitFields/submitParameterOptions/defaultSubmitParameters/modelSelectionPolicy） | 同步 |
| topview_prepare_canvas_jump | >15s 或多场景长视频 → Canvas 预填跳转（sid） | — |

底层 REST（codex 仓 legacy scripts/shared/client.py，api.topview.ai，headers Topview-Uid + Bearer）：每 taskType 一对 `/v*/common_task|photo_avatar|voice|product_avatar/…/task/submit|query`（如 /v1/common_task/text2video/task/submit、/v2/common_task/image2video/…、/v3/product_avatar/task/image_replace/…），envelope 统一 `{code,message,result}`；上传 /v1/upload/credential + /v1/upload/check；板 /boards/*；积分 /user/credit/*。

## 2. 映射表（我方证据：src/lib/canvas/types.ts、docs/agent-native-ultimate-blueprint-zh.md §3.5/3.6、docs/biz-api.md、src/lib/generation-core/）

| Topview | 我方对应物 | 判定 |
|---|---|---|
| get_generation_config | GET /v1/capabilities + MCP discover_capabilities（availability/queue_eta/price_from） | 已有，且更强（含价格与队列 ETA） |
| ta_upload_credential/check | POST /v1/uploads（signed PUT+Idempotency-Key）+ create_upload | 已有 |
| generate_image / generate_video | generate_image + edit_image（MCP）/ /v1/images/generations + /v1/image-jobs | 图已全有；**视频生成=P1** |
| avatar_video（数字人） | — | **P1**（无口播数字人渠道） |
| remove_background | /v1/images/edits 可吸收；显式 remove_bg 意图工具 | P1（低优先，作 workflow SKU） |
| product_avatar | run_workflow（workflow SKU：remove_bg→edit 链） | P1（模板层，非新 kind） |
| generate_voice / clone_voice / music | — | **P1**（音频域空白；canvas 节点 kind 已预留 audio） |
| query_task | get_generation / GET /v1/image-jobs/{id}（next_action） | 已有 |
| boards 4 工具 | CanvasAgentOp 8 op + canvas.* SSE 事件（多节点图、derive、budget） | 已有且更强（板=平面夹，我方=图） |
| get_credit / credit_logs | get_usage / /v1/billing/balance / billing/quotes（报价先行） | 已有，且 quote/退款策略更完整 |
| prepare_canvas_jump | N/A——我方 canvas 即 agent 原生面，无需跳转 | 反向印证我方哲学 |
| use_*_data 情报域 / social-media-uploader 发布 / content-collector 调研 | — | **Won't do**（选品情报与发布分发非执行层职责；我们是被调用的 B 端执行层） |

## 3. 「模板 SKU = skill 文本 + 固定工具链」实例

- **商品模特图 SKU**（references/product_avatar.md）：list_product_avatar_categories → list_product_avatars → remove_background → 以 `bgRemovedImageFileId` 直链 product_avatar（中间产物不落盘不上传）→ poll。
- **长口播 SKU**（references/avatar4.md）：>120s 剧本按句切分段、锁定同一 voice/mode/caption/caption/motion，并行 submit 各段、各自轮询、按序交付。
- **脚本→视频 SKU**（codex 仓 skills/video-script-writer/SKILL.md）：先产 Hook→Body→CTA 剧本与分镜 → ai_image `--type storyboard` 出分镜预览图 → video_gen `--type omni --storyboard-image`，prompt 固定句式「图一是分镜参考图，图二是xxx…」——模板=文本契约+固定调用顺序，非独立工具。
- **情报→素材 SKU**（amazon-ops tool_routing.md）：market_research→keyword→review 后「chain to topview-generate」跨 skill 交接。

## 4. 异步与错误码设计要点（references/error_handling.md、client.py、社区 poll.ts/constants.ts）

- submit/query 成对；query 需同时带 taskType+taskId（路由键+身份）。状态机 init→running→success/fail；允许部分成功（只重试失败项）。
- **轮询 4–5s 间隔、5–10min 超时；timeout≠fail**：保留 ID 续查、严禁盲目重提（重复扣费）。服务端另有 4007「存在未完成任务」防并发重复。
- 社区版工具含 `waitForCompletion`（默认 true=工具内代步轮询返成品；false=返 taskId 手动查）——与我方 `Prefer: respond-async` 同一取舍。
- 错误分类：401 认证；4000/4001/4003 参数（需重读 config）；4100 积分不足（先查余额）；4007 并发锁；5003 忙（10–30s 退避重试）；5000/5001 内部（重试一次）；6001 安全拒绝；DURATION_EXCEEDS_MCP_LIMIT 则改道 Canvas。核心纪律：**4000/4100 后未经用户同意不得换模型**。
- 计费：按 taskType 明码（TTS 0.1、product_avatar 0.5 credits），失败退款，先查可负担性再提交——对应我方 quote→reserve→refund 链，我方 failure-classifier/status-query/callback-outbox 已覆盖，可补的是「部分成功只重试失败项」与「4007 式并发锁」语义。

## 5. 许可证边界与可借鉴模式

- topviewai/skill：**Apache-2.0**（文档模式可借鉴，需 attribution）；topviewai/codex-topview-ai：**MIT**（含 THIRD_PARTY_NOTICES）；teddypecourt/topview-mcp-server：**无 LICENSE 文件**（默认保留全部权利——只看 API 形状，勿抄代码）。
- 可借鉴（只抄模式不抄壳）：① 活配置单一真相（get_generation_config 统一 submitModel/必填/枚举，禁本地模型注册表）——强化我方 /v1/capabilities 权威性；② 渐进披露（deferred 工具经 get_tool_schema/call_tool）缓解工具清单膨胀，未来工具>30 个时采用；③ 意图路由表（用户意图→工具+taskType 二维表）写进 skill 文本；④ 结果可分享 URL（boardResultId 深链）对应我方 canvas 节点/artifact 深链；⑤ 边界诚实声明（不可用操作直说，不教绕路）。
- 不借鉴：统一 `{code,message,result}` 数字码信封（我方已承诺 OpenAI 兼容形状+structured error+next_action）；>15s 踢去自家 Canvas 的能力截断（我方无此产品分层）。
