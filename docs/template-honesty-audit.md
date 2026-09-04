# 模板誠實稽核報告（Template Honesty Audit）

- 日期：2026-08-31｜來源：agent-evolve 評測｜執行：前端整改已落地，後端僅稽核零動作
- 裁定依據（暴君）：模板 requiredTools 裡的假工具卡 = PRD 意圖已完成但後端未實裝，屬進度落後；必須全部誠實標記，不許冒充能力。誠實是雙向的：未實裝要標，已實裝不許裝死。

## 0. 結論速覽

- 前端 8 模板 × 63 步 × 179 個工具宣告：**54 個假工具卡新標 `unsupported: true`**（28 個 distinct 工具 id），**2 個過期標記反向解除**（image_upscale，源碼證明已實裝）。整改後未標記的工具宣告只剩 5 個 harness 真實工具（canvas_apply_ops / canvas_get_state / image_generate / image_edit / image_upscale）。
- 測試判定集真源從「站內 domain registry 自我認證」換血為 `src/lib/harness-tool-registry.ts`（= VPS harness 真實工具面 36 檔），並新增反向防呆測試（已實裝不許裝死）。31/31 全綠。
- 後端 6 個 workflow 模板：節點類型全被引擎支持、model id 全可解析、音軌/成片引擎真能產；但發現 **1 個計費漂移（novel_film 影片秒價 13/16 vs 權威價目 5/10）** 與 **1 個反向誠實過期（description 仍稱配音/成片為「暫不可用」佔位，實已實裝）** 等 5 項落差，僅報告未執行。

## 1. 步驟 1 源碼證據：四個可疑工具的「真實裝」判定

判定標準：harness 工具檔真調用站點 API 且站點路由存在 = 已實裝；stub/throw/未接 handler = 仍 unsupported。harness `lib/client.ts` L6：`export const API_BASE = "https://image.tinchak0207.xyz/v1"`。

| 工具 | harness 源碼關鍵行（VPS .opencode/tools/） | 站點路由（本地 grep） | 判定 |
|---|---|---|---|
| image_upscale | `platformFetch("/upscale", { method: "POST", headers: { "idempotency-key": request_id }, body: JSON.stringify({ image, factor: scale, ... }) })`，含 `probeModelAvailable` / `confirmSpend` 扣費閘門 / `resolveMediaId` / `emitEvent("image.done")` | `src/app/api/v1/upscale/route.ts` L36 `export async function POST` | ✅ 已實裝 |
| image_edit | `platformFetch("/images/edits", { method: "POST", ... })`（默認 model `pixai-tsubaki2`，同全套扣費/探測/事件閉環） | `src/app/api/v1/images/edits/route.ts` L39 `export async function POST` | ✅ 已實裝 |
| image_quote | `platformFetch("/models", {})`，讀 `x_coins_per_image` + `x_capabilities.mediaType` 過濾視頻模型 | `src/app/api/v1/models/route.ts` L25 `export async function GET` | ✅ 已實裝（模板未引用） |
| quote_bundle | `loadCatalog(sessionID)` → GET /v1/models 目錄單價 + `estimateVideoCoins`（720P 5 幣/秒 / 1080P 10 幣/秒），未知價如實標 `price_source: "unknown"` | 同上 /v1/models | ✅ 已實裝（模板未引用） |

四檔均為完整實現，無 stub/throw → `HARNESS_STUB_TOOLS` 為空集。

**⚠️ 反向誠實（原標 unsupported 實已實裝）**：模板在 `agent-ecommerce-launch-pack / 放大精修` 與 `agent-ecommerce-model-grid / 适配分发尺寸` 兩處標 `image_upscale: unsupported`，requiredCapability 寫「generation.upscale（harness 未注册 upscale handler）」——該聲稱已被源碼推翻（handler 存在且調用真實路由），兩處標記已移除。`agent-shortdrama-visual-assets / 产出投放物料` 的 image_upscale 本來就未標，正確。

## 2. 前端整改統計

| 項目 | 數量 |
|---|---|
| 模板 / 步驟 / 工具宣告總數 | 8 / 63 / 179 |
| 模板引用的 distinct 工具 id | 43（harness 內 5，harness 外 38） |
| 新標 `unsupported: true`（含 requiredCapability） | **54 條**（28 個 id） |
| 反向解除標記（image_upscale） | **2 條** |
| 保留既有標記（原文不動） | 14 條（13 個 id） |
| 整改後未標記且不在 harness 的工具 | 0 |

文案風格：同 id 已有既標條目的，requiredCapability 復用原文（style_dna_extract / style_aligned_batch / outlier_audit_regenerate）；其餘按「harness 未註冊 X（PRD 意圖：…，屬進度落後待實裝）」句式。step 文案 / initialPrompt / directive 零改動。

## 3. 前端矩陣（模板 × 步驟 × 聲明工具 × harness 實況）

圖例：✅ harness 已實裝（未標）｜❌ 未實裝、已標 unsupported｜⚠️→✅ 反向誠實修正（原標 unsupported，經源碼核對解除）

### agent-novel-film-pipeline（小說影視化）
| 步驟 | 工具 × 實況 |
|---|---|
| 拆解剧本 | script_scene_parse ❌<br>canvas_get_state ✅<br>canvas_apply_ops ✅ |
| 建角色圣经 | cast_asset_lock ❌<br>character_dna_turnaround ❌<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 定美术圣经 | style_anchor_sref ❌<br>style_dna_extract ❌<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 锁定分镜 | storyboard_qc_17 ❌<br>sketch_lock ❌<br>canvas_apply_ops ✅ |
| 渲染关键帧 | keyframe_render ❌<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 合成镜头视频 | last_frame_video_chain ❌<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 配音配乐 | audio_first_timeline ❌<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 组装成片 | editing_manifest ❌<br>delivery_assets ❌<br>canvas_apply_ops ✅ |

### agent-novel-ip-visual-pack（IP視覺包）
| 步驟 | 工具 × 實況 |
|---|---|
| 拆解世界观 | world_bible_extract ❌<br>canvas_get_state ✅<br>canvas_apply_ops ✅ |
| 炼情绪板 | emotion_board_matrix ❌<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 铸风格锚 | style_anchor_sref ❌<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 建主角资产 | character_dna_turnaround ❌<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 绘名场面组图 | story_sequence_consistency ❌<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 造封面主视觉 | canonical_key_art_lock ❌<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 出多画幅 | multi_aspect_reflow ❌<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 铺衍生物料 | asset_provenance_archive ❌<br>multi_aspect_reflow ❌<br>canvas_apply_ops ✅ |

### agent-ecommerce-launch-pack（新品上市包）
| 步驟 | 工具 × 實況 |
|---|---|
| 锁产品 | product_lock ❌<br>background_remove ❌<br>canvas_apply_ops ✅ |
| 铺场景包 | scene_pack_batch ❌<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 出模特图 | product_conditioned_generation ❌<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 出主视觉 | canonical_key_art_lock ❌<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 排详情页 | detail_page_manifest ❌<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 批量出画幅 | aspect_reflow ❌<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 放大精修 | upscale_audit ❌<br>image_upscale ⚠️→✅<br>canvas_apply_ops ✅ |
| 审终交付 | upscale_audit ❌<br>canvas_apply_ops ✅ |

### agent-ecommerce-model-grid（模種草線）
| 步驟 | 工具 × 實況 |
|---|---|
| 抠取服装资产 | garment_extract ❌<br>canvas_apply_ops ✅ |
| 选定模特人设 | model_identity_lock ❌<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 上身虚拟试穿 | virtual_tryon ❌<br>garment_dna_lock ❌<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 精修试穿质感 | hand_contact_repair ❌<br>image_edit ✅<br>canvas_apply_ops ✅ |
| 拍齐九宫格 | shot_grid_batch ❌<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 排版详情页 | detail_page_evidence_map ❌<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 适配分发尺寸 | platform_reflow ❌<br>image_upscale ⚠️→✅<br>canvas_apply_ops ✅ |

### agent-shortdrama-visual-assets（劇本視覺化）
| 步驟 | 工具 × 實況 |
|---|---|
| 拆解剧本 | script_scene_parse ❌<br>canvas_get_state ✅<br>canvas_apply_ops ✅ |
| 铸造主演资产 | cast_asset_lock ❌<br>character_dna_turnaround ❌<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 锁定分镜 | storyboard_qc_17 ❌<br>sketch_lock ❌<br>canvas_apply_ops ✅ |
| 渲染关键帧 | keyframe_render ❌<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 合成配音 | audio_first_timeline ❌<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 生成镜头视频 | last_frame_video_chain ❌<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 剪辑成片 | editing_manifest ❌<br>canvas_apply_ops ✅ |
| 产出投放物料 | image_upscale ✅<br>canvas_apply_ops ✅ |

### agent-shortdrama-poster-line（投放海報線）
| 步驟 | 工具 × 實況 |
|---|---|
| 锚定视觉基调 | style_dna_extract ❌<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 提炼主演海报 | canonical_key_art_lock ❌<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 排布CP对戏图 | story_sequence_consistency ❌<br>image_edit ✅<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 切片封面批量 | shot_grid_batch ❌<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 生成变体测试包 | style_aligned_batch ❌<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 回流迭代风格 | outlier_audit_regenerate ❌<br>canvas_apply_ops ✅ |
| 锁定交付参数 | canvas_get_state ✅<br>canvas_apply_ops ✅ |

### agent-art-curation-series（策展式創作）
| 步驟 | 工具 × 實況 |
|---|---|
| 立意结构化 | moodboard_diverge_converge ❌<br>canvas_get_state ✅<br>canvas_apply_ops ✅ |
| 发散收情绪板 | emotion_board_matrix ❌<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 铸风格锚 | style_anchor_sref ❌<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 锁定构图稿 | sketch_lock ❌<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 成组渲染 | style_aligned_batch ❌<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 审计一致性 | outlier_audit_regenerate ❌<br>canvas_apply_ops ✅ |
| 布置展陈主视觉 | canonical_key_art_lock ❌<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 交付多规格 | exhibition_delivery_manifest ❌<br>multi_aspect_reflow ❌<br>canvas_apply_ops ✅ |

### agent-art-style-immersion（風格深研線）
| 步驟 | 工具 × 實況 |
|---|---|
| 采代表作 | canvas_get_state ✅<br>image_generate ✅ |
| 拆DNA | style_dna_extract ❌<br>canvas_apply_ops ✅ |
| 签解构表 | style_dna_extract ❌<br>canvas_apply_ops ✅ |
| 拍临摹对照 | image_generate ✅<br>canvas_apply_ops ✅ |
| 跑变体矩阵 | style_aligned_batch ❌<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 试LoRA | style_lora_train_optional ❌<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 做原创成组 | style_aligned_batch ❌<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 归档证物链 | asset_provenance_archive ❌<br>canvas_apply_ops ✅ |

## 4. 測試真源換血（src/lib/agent-templates.test.ts）

- 盲點：原 `REGISTRY_IDS` = agent-tool-contract + 5 個 domain registry 的並集，屬站內自我認證，不代表 harness 真實工具面。
- 現況：toolchain binding 判定集改為 `HARNESS_TOOL_IDS`（harness-tool-registry.ts）；原 domain registry import 僅供 REGISTRY_IDS 使用，已移除。
- 新增雙向防呆測試：`unsupported marks must be stale-free`——標了 unsupported 但 id 在 harness 真源內 = 過期標記，測試直接紅（本次 image_upscale 兩處即屬此類）。
- 結果：`npx --yes tsx --test src/lib/agent-templates.test.ts src/components/canvas-workstation/agent-template-canvas.test.ts` → **31 pass / 0 fail**。canvas 測試用自帶 fixture 模板，未受影響，錨點零修改。

## 5. 後端 6 模板稽核（VPS 唯讀，零動作）

對象：`/opt/agent-harness/gateway/workflow-templates.ts`（single_image / character_sheet / scene_setup / single_video / feature_film / novel_film）。

### 5.1 通過項

- **節點類型**：模板用到 text/config/image/video/audio/film 全部 6 種，引擎全支持——`workflow-engine.ts` L11 `WorkflowNodeKind` 六型齊備；`workflow-service.ts` L674 text/config 跳過（純資料）、image/video 走 `submitWorkflowNode`；`index.ts` L1293 audio、L1317 film 有專屬執行分支。
- **model id**：`pixai-tsubaki2` / `minimax-h3` 不在 `agent-models.json`——但該檔是 agent LLM 綁定登記表（deepseek-v4-flash / MiniMax-M3 等文字模型），非生圖目錄；生成模型權威 = 平台 `/v1/models` 目錄 + supplier-channels：`minimax-h3` 見本地 `src/lib/supplier-channels.config.ts` L83 與 `newapi-video-upstream.ts`（渠道 8 已驗證出真片），`pixai-tsubaki2` 見 `pixai-model-map.ts`。判定：可解析，非落差。
- **聲明產物**：音軌——audio 分支真調 TTS 上游（`index.ts` L1293-1315：probe → POST speech → mp3 落盤 → 公網 URL + `estimateTtsCoins` 計費），上游失敗誠實報錯；成片——`assembleFilmNode`（L1483+）真 ffmpeg 拼接（shotN 排序 → exportSelectedMainClips → probeRenderedVideo 校驗門 → 自動混入上游 audio 音軌），ffmpeg 缺失/無鏡頭輸入如實報錯。引擎代碼層面不造假。

### 5.2 落差清單（B1/B2 已於複核後落地修復；B3-B5 待裁決）

| # | 嚴重度 | 落差 | 證據 | 建議修法 | 狀態 |
|---|---|---|---|---|---|
| B1 | **高（計費）** | novel_film 影片秒價偏離權威價目表：`video_gen` defaults `unit_price_per_second: 13`、`unit_price_per_second_1080p: 16`，而同檔頭註明與 single_video / feature_film 均為 5/10。`resolveVideoPerSecond`（workflow-service.ts）錨點價優先 → novel_film 影片節點按 2.6×（720P）/1.6×（1080P）灌水報價與扣費 | workflow-templates.ts novel_film 段 vs 同檔 unit_price_per_second 註解「720P = 5 幣/秒、1080P = 10 幣/秒（暴君價目表）」 | 把 novel_film `video_gen` defaults 改回 `5` / `10`（或刪錨點走档位兜底），與價目表同源 | ✅ **已修復**（08-31：L185 改 5/10，與 L104/L133 同源；備份 `workflow-templates.ts.bak-honesty-0831`；gateway 重啟後 active） |
| B2 | 中（反向誠實過期） | novel_film description 仍稱「配音/成片為編排佔位：執行時如實回報 TTS/拼裝上游暫不可用」——引擎已實裝真 TTS 閉環與真 ffmpeg 成片，文案低報能力、與代碼不同步（`workflow-engine.ts` L9-10 頭註同病） | index.ts L1293-1320、assembleFilmNode L1483+ | description 改為「配音=真 TTS 閉環（探測失敗誠實報錯）；成片=真 ffmpeg 拼接+混音（缺 ffmpeg/無鏡頭誠實報錯）」 | ✅ **已修復**（description 改「配音为真实 TTS 生成、成片为真实拼接＋混音」；`workflow-engine.ts` 頭註屬內部註解非用戶面，未動） |
| B3 | 低（回退隱患） | TTS 代碼默認值為 `canopylabs/orpheus-v1-english`（voice tara，英文語音模型）；運行時 `.env` 已覆蓋為 `http://127.0.0.1:8893` + `FunAudioLLM/CosyVoice2-0.5B`（edge-tts 殼，08-30 已 E2E 真出中文 MP3）——現況誠實，但 env 丟失會**靜默回退英文模型**承接中文台詞環，且 `probeTtsUpstream` 只驗「載荷像音頻」（magic bytes）不驗語言 | index.ts L5505-5509 默認值 vs /opt/agent-harness/.env L13-15 | 把代碼默認值改成與 env 同源（CosyVoice2），或 probe 加語言適配斷言，消除靜默回退 |
| B4 | 低 | novel_film 的 text 環（结构化剧本/分镜表）無引擎側生成器：text/config 節點「視為完成」，內容全靠 agent 經 `workflow_update_node` 注入，引擎側無門禁把關 | workflow-service.ts L674 | 可接受（編排設計如此）；若要硬門禁，在 film/video 執行前校驗上游 text 節點非空 |
| B5 | 低 | character_sheet / feature_film 的「四视图设定表」實為 4 個獨立 image 節點（count:4），非單張四格圖；標題語義略過 | workflow-templates.ts sheet: "4-view" | 文案改「四張視圖圖」或在 prompt 內要求單張四格佈局 |

## 6. 未觀察項（誠實聲明）

- 本次判定全部基於**源碼與路由存在性**，未實彈調用任何 harness 工具或後端工作流（未產生真實扣費/真實產物）。
- 「已實裝」= 工具檔真調站點 API 且路由有 handler；端到端可用性（出真圖/真片）屬另一命題，歷史證據見 newapi-video-upstream 測試（渠道 8 出真片）。
- 稽核階段 VPS 零寫入（僅 `cat`/`grep`/`sed -n`）；報告定稿後經複核，由 orchestrator 落地 B1/B2 修復（`workflow-templates.ts` 精確斷言替換 + 重啟 `agent-gateway.service`，驗證 active + 新值在檔 + 舊文案計數 0）。
- B3 的運行時 TTS 上游已由 `.env` 指向中文模型（08-30 E2E 證據在 memory），本次未重跑實彈；B1 修復後未重跑 novel_film 端到端報價（修復為純數值對齊權威價目表，`resolveVideoPerSecond` 讀檔即生效）。

## 7. 觸檔清單

| 檔 | 動作 |
|---|---|
| `src/lib/harness-tool-registry.ts` | 新建（36 工具真源 + 實裝判定註解 + 空 HARNESS_STUB_TOOLS） |
| `src/lib/agent-templates.ts` | 54 新標 unsupported、2 解除、requiredTools 欄位文檔註解改指真源；step 文案零改動 |
| `src/lib/agent-templates.test.ts` | 判定集換 HARNESS_TOOL_IDS、移除 domain registry import、新增 stale-free 雙向測試 |
| `docs/template-honesty-audit.md` | 本檔 |

## 附錄：片6 style_lora_train 偵查證據（2026-08-31，零扣費、零訓練提交）

`style_lora_train_optional`——08-31 暴君後續裁定**從模板移除**（永久死路能力不上產品面，不再以 unsupported 卡呈現；本附錄保留證據鏈，站內 `art-workflows/tool-registry.ts` 契約與 `docs/skills/style-deep-research.md` 反偽訓練門禁保留作內部守欄）。三處通道偵查結論與證據：

| # | 偵查點 | 方法 | 證據 | 結論 |
|---|---|---|---|---|
| ① | pixai-pool bridge（`pixai-pool/bridge/app.py`） | 通讀端點面 + grep `train\|finetune\|lora` | 檔頭自述「OpenAI-compatible /v1/images/generations in front of the PixAI pool」，僅 `generate_image/handle_generation/run_generation` 生圖路徑；全檔零 train/finetune/lora 匹配 | 無訓練能力（純生圖代理） |
| ② | pixai 官方 API（`api.pixai.art`，pool token 只探不練） | REST GET 探 `/v2/trainings` `/v2/training` `/v2/lora-trainings` `/v2/training-jobs` `/v2/models`；GraphQL introspection + 訓練字段名探測（`trainingList`/`loras`/`myTrainings`/`userTrainings`） | REST 五路徑全 404；GraphQL introspection 回 400（禁用），字段探測全回 `Cannot query field ... on type "Query"`（建議被閘道 `<redacted>` 遮蔽）；token 認證被接受（非 401），排除鑑權誤判 | 無可編程訓練端點 |
| ③ | 站點 repo（`src/app/api/`） | grep `train\|finetune\|lora` 路由 | 僅 `lora-models/route.ts`（GET 轉發 bridge `/v1/lora-models` 社群 LoRA **目錄**）與 `lora-preferences/route.ts`（用戶 LoRA **偏好**）；`use-cases/base-training.ts` 為展示文案非訓練碼；無任何提交訓練的路由 | 無訓練通道 |

**精確缺口**：要摘掉 unsupported，需出現以下任一上游——(a) PixAI 官方公開的 LoRA 訓練 API（目前僅 web 端私有流程）；(b) 自建 ComfyUI/waifu-diffusion 訓練 worker 並接入 generation-worker 路由；(c) 第三方訓練託管（如 civitai/baseten finetune API）接入 bridge。三者皆為【能力建設】級工程，非本檔工具可繞過。
