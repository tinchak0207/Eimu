# 模板诚实稽核报告（Template Honesty Audit）

- 日期：2026-08-31｜来源：agent-evolve 评测｜执行：前端整改已落地，后端仅稽核零动作
- 裁定依据（暴君）：模板 requiredTools 里的假工具卡 = PRD 意图已完成但后端未实装，属进度落后；必须全部诚实标记，不许冒充能力。诚实是双向的：未实装要标，已实装不许装死。

## 0. 结论速览

- 前端 8 模板 × 63 步 × 179 个工具宣告：**54 个假工具卡新标 `unsupported: true`**（28 个 distinct 工具 id），**2 个过期标记反向解除**（image_upscale，源码证明已实装）。整改后未标记的工具宣告只剩 5 个 harness 真实工具（canvas_apply_ops / canvas_get_state / image_generate / image_edit / image_upscale）。
- 测试判定集真源从「站内 domain registry 自我认证」换血为 `src/lib/harness-tool-registry.ts`（= VPS harness 真实工具面 36 档），并新增反向防呆测试（已实装不许装死）。31/31 全绿。
- 后端 6 个 workflow 模板：节点类型全被引擎支持、model id 全可解析、音轨/成片引擎真能产；但发现 **1 个计费漂移（novel_film 影片秒价 13/16 vs 权威价目 5/10）** 与 **1 个反向诚实过期（description 仍称配音/成片为「暂不可用」占位，实已实装）** 等 5 项落差，仅报告未执行。

## 1. 步骤 1 源码证据：四个可疑工具的「真实装」判定

判定标准：harness 工具档真调用站点 API 且站点路由存在 = 已实装；stub/throw/未接 handler = 仍 unsupported。harness `lib/client.ts` L6：`export const API_BASE = "https://image.tinchak0207.xyz/v1"`。

| 工具 | harness 源码关键行（VPS .opencode/tools/） | 站点路由（本地 grep） | 判定 |
|---|---|---|---|
| image_upscale | `platformFetch("/upscale", { method: "POST", headers: { "idempotency-key": request_id }, body: JSON.stringify({ image, factor: scale, ... }) })`，含 `probeModelAvailable` / `confirmSpend` 扣费闸门 / `resolveMediaId` / `emitEvent("image.done")` | `src/app/api/v1/upscale/route.ts` L36 `export async function POST` | ✅ 已实装 |
| image_edit | `platformFetch("/images/edits", { method: "POST", ... })`（默认 model `pixai-tsubaki2`，同全套扣费/探测/事件闭环） | `src/app/api/v1/images/edits/route.ts` L39 `export async function POST` | ✅ 已实装 |
| image_quote | `platformFetch("/models", {})`，读 `x_coins_per_image` + `x_capabilities.mediaType` 过滤视频模型 | `src/app/api/v1/models/route.ts` L25 `export async function GET` | ✅ 已实装（模板未引用） |
| quote_bundle | `loadCatalog(sessionID)` → GET /v1/models 目录单价 + `estimateVideoCoins`（720P 5 币/秒 / 1080P 10 币/秒），未知价如实标 `price_source: "unknown"` | 同上 /v1/models | ✅ 已实装（模板未引用） |

四档均为完整实现，无 stub/throw → `HARNESS_STUB_TOOLS` 为空集。

**⚠️ 反向诚实（原标 unsupported 实已实装）**：模板在 `agent-ecommerce-launch-pack / 放大精修` 与 `agent-ecommerce-model-grid / 适配分发尺寸` 两处标 `image_upscale: unsupported`，requiredCapability 写「generation.upscale（harness 未注册 upscale handler）」——该声称已被源码推翻（handler 存在且调用真实路由），两处标记已移除。`agent-shortdrama-visual-assets / 产出投放物料` 的 image_upscale 本来就未标，正确。

## 2. 前端整改统计

| 项目 | 数量 |
|---|---|
| 模板 / 步骤 / 工具宣告总数 | 8 / 63 / 179 |
| 模板引用的 distinct 工具 id | 43（harness 内 5，harness 外 38） |
| 新标 `unsupported: true`（含 requiredCapability） | **54 条**（28 个 id） |
| 反向解除标记（image_upscale） | **2 条** |
| 保留既有标记（原文不动） | 14 条（13 个 id） |
| 整改后未标记且不在 harness 的工具 | 0 |

文案风格：同 id 已有既标条目的，requiredCapability 复用原文（style_dna_extract / style_aligned_batch / outlier_audit_regenerate）；其余按「harness 未注册 X（PRD 意图：…，属进度落后待实装）」句式。step 文案 / initialPrompt / directive 零改动。

## 3. 前端矩阵（模板 × 步骤 × 声明工具 × harness 实况）

图例：✅ harness 已实装（未标）｜❌ 未实装、已标 unsupported｜⚠️→✅ 反向诚实修正（原标 unsupported，经源码核对解除）

### agent-novel-film-pipeline（小说影视化）
| 步骤 | 工具 × 实况 |
|---|---|
| 拆解剧本 | script_scene_parse ❌<br>canvas_get_state ✅<br>canvas_apply_ops ✅ |
| 建角色圣经 | cast_asset_lock ❌<br>character_dna_turnaround ❌<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 定美术圣经 | style_anchor_sref ❌<br>style_dna_extract ❌<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 锁定分镜 | storyboard_qc_17 ❌<br>sketch_lock ❌<br>canvas_apply_ops ✅ |
| 渲染关键帧 | keyframe_render ❌<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 合成镜头视频 | last_frame_video_chain ❌<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 配音配乐 | audio_first_timeline ❌<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 组装成片 | editing_manifest ❌<br>delivery_assets ❌<br>canvas_apply_ops ✅ |

### agent-novel-ip-visual-pack（IP视觉包）
| 步骤 | 工具 × 实况 |
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
| 步骤 | 工具 × 实况 |
|---|---|
| 锁产品 | product_lock ❌<br>background_remove ❌<br>canvas_apply_ops ✅ |
| 铺场景包 | scene_pack_batch ❌<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 出模特图 | product_conditioned_generation ❌<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 出主视觉 | canonical_key_art_lock ❌<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 排详情页 | detail_page_manifest ❌<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 批量出画幅 | aspect_reflow ❌<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 放大精修 | upscale_audit ❌<br>image_upscale ⚠️→✅<br>canvas_apply_ops ✅ |
| 审终交付 | upscale_audit ❌<br>canvas_apply_ops ✅ |

### agent-ecommerce-model-grid（模种草线）
| 步骤 | 工具 × 实况 |
|---|---|
| 抠取服装资产 | garment_extract ❌<br>canvas_apply_ops ✅ |
| 选定模特人设 | model_identity_lock ❌<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 上身虚拟试穿 | virtual_tryon ❌<br>garment_dna_lock ❌<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 精修试穿质感 | hand_contact_repair ❌<br>image_edit ✅<br>canvas_apply_ops ✅ |
| 拍齐九宫格 | shot_grid_batch ❌<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 排版详情页 | detail_page_evidence_map ❌<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 适配分发尺寸 | platform_reflow ❌<br>image_upscale ⚠️→✅<br>canvas_apply_ops ✅ |

### agent-shortdrama-visual-assets（剧本视觉化）
| 步骤 | 工具 × 实况 |
|---|---|
| 拆解剧本 | script_scene_parse ❌<br>canvas_get_state ✅<br>canvas_apply_ops ✅ |
| 铸造主演资产 | cast_asset_lock ❌<br>character_dna_turnaround ❌<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 锁定分镜 | storyboard_qc_17 ❌<br>sketch_lock ❌<br>canvas_apply_ops ✅ |
| 渲染关键帧 | keyframe_render ❌<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 合成配音 | audio_first_timeline ❌<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 生成镜头视频 | last_frame_video_chain ❌<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 剪辑成片 | editing_manifest ❌<br>canvas_apply_ops ✅ |
| 产出投放物料 | image_upscale ✅<br>canvas_apply_ops ✅ |

### agent-shortdrama-poster-line（投放海报线）
| 步骤 | 工具 × 实况 |
|---|---|
| 锚定视觉基调 | style_dna_extract ❌<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 提炼主演海报 | canonical_key_art_lock ❌<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 排布CP对戏图 | story_sequence_consistency ❌<br>image_edit ✅<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 切片封面批量 | shot_grid_batch ❌<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 生成变体测试包 | style_aligned_batch ❌<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 回流迭代风格 | outlier_audit_regenerate ❌<br>canvas_apply_ops ✅ |
| 锁定交付参数 | canvas_get_state ✅<br>canvas_apply_ops ✅ |

### agent-art-curation-series（策展式创作）
| 步骤 | 工具 × 实况 |
|---|---|
| 立意结构化 | moodboard_diverge_converge ❌<br>canvas_get_state ✅<br>canvas_apply_ops ✅ |
| 发散收情绪板 | emotion_board_matrix ❌<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 铸风格锚 | style_anchor_sref ❌<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 锁定构图稿 | sketch_lock ❌<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 成组渲染 | style_aligned_batch ❌<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 审计一致性 | outlier_audit_regenerate ❌<br>canvas_apply_ops ✅ |
| 布置展陈主视觉 | canonical_key_art_lock ❌<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 交付多规格 | exhibition_delivery_manifest ❌<br>multi_aspect_reflow ❌<br>canvas_apply_ops ✅ |

### agent-art-style-immersion（风格深研线）
| 步骤 | 工具 × 实况 |
|---|---|
| 采代表作 | canvas_get_state ✅<br>image_generate ✅ |
| 拆DNA | style_dna_extract ❌<br>canvas_apply_ops ✅ |
| 签解构表 | style_dna_extract ❌<br>canvas_apply_ops ✅ |
| 拍临摹对照 | image_generate ✅<br>canvas_apply_ops ✅ |
| 跑变体矩阵 | style_aligned_batch ❌<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 试LoRA | style_lora_train_optional ❌<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 做原创成组 | style_aligned_batch ❌<br>image_generate ✅<br>canvas_apply_ops ✅ |
| 归档证物链 | asset_provenance_archive ❌<br>canvas_apply_ops ✅ |

## 4. 测试真源换血（src/lib/agent-templates.test.ts）

- 盲点：原 `REGISTRY_IDS` = agent-tool-contract + 5 个 domain registry 的并集，属站内自我认证，不代表 harness 真实工具面。
- 现况：toolchain binding 判定集改为 `HARNESS_TOOL_IDS`（harness-tool-registry.ts）；原 domain registry import 仅供 REGISTRY_IDS 使用，已移除。
- 新增双向防呆测试：`unsupported marks must be stale-free`——标了 unsupported 但 id 在 harness 真源内 = 过期标记，测试直接红（本次 image_upscale 两处即属此类）。
- 结果：`npx --yes tsx --test src/lib/agent-templates.test.ts src/components/canvas-workstation/agent-template-canvas.test.ts` → **31 pass / 0 fail**。canvas 测试用自带 fixture 模板，未受影响，锚点零修改。

## 5. 后端 6 模板稽核（VPS 唯读，零动作）

对象：`/opt/agent-harness/gateway/workflow-templates.ts`（single_image / character_sheet / scene_setup / single_video / feature_film / novel_film）。

### 5.1 通过项

- **节点类型**：模板用到 text/config/image/video/audio/film 全部 6 种，引擎全支持——`workflow-engine.ts` L11 `WorkflowNodeKind` 六型齐备；`workflow-service.ts` L674 text/config 跳过（纯资料）、image/video 走 `submitWorkflowNode`；`index.ts` L1293 audio、L1317 film 有专属执行分支。
- **model id**：`pixai-tsubaki2` / `minimax-h3` 不在 `agent-models.json`——但该档是 agent LLM 绑定登记表（deepseek-v4-flash / MiniMax-M3 等文字模型），非生图目录；生成模型权威 = 平台 `/v1/models` 目录 + supplier-channels：`minimax-h3` 见本地 `src/lib/supplier-channels.config.ts` L83 与 `newapi-video-upstream.ts`（渠道 8 已验证出真片），`pixai-tsubaki2` 见 `pixai-model-map.ts`。判定：可解析，非落差。
- **声明产物**：音轨——audio 分支真调 TTS 上游（`index.ts` L1293-1315：probe → POST speech → mp3 落盘 → 公网 URL + `estimateTtsCoins` 计费），上游失败诚实报错；成片——`assembleFilmNode`（L1483+）真 ffmpeg 拼接（shotN 排序 → exportSelectedMainClips → probeRenderedVideo 校验门 → 自动混入上游 audio 音轨），ffmpeg 缺失/无镜头输入如实报错。引擎代码层面不造假。

### 5.2 落差清单（B1/B2 已于复核后落地修复；B3-B5 待裁决）

| # | 严重度 | 落差 | 证据 | 建议修法 | 状态 |
|---|---|---|---|---|---|
| B1 | **高（计费）** | novel_film 影片秒价偏离权威价目表：`video_gen` defaults `unit_price_per_second: 13`、`unit_price_per_second_1080p: 16`，而同档头注明与 single_video / feature_film 均为 5/10。`resolveVideoPerSecond`（workflow-service.ts）锚点价优先 → novel_film 影片节点按 2.6×（720P）/1.6×（1080P）灌水报价与扣费 | workflow-templates.ts novel_film 段 vs 同档 unit_price_per_second 注解「720P = 5 币/秒、1080P = 10 币/秒（暴君价目表）」 | 把 novel_film `video_gen` defaults 改回 `5` / `10`（或删锚点走档位兜底），与价目表同源 | ✅ **已修复**（08-31：L185 改 5/10，与 L104/L133 同源；备份 `workflow-templates.ts.bak-honesty-0831`；gateway 重启后 active） |
| B2 | 中（反向诚实过期） | novel_film description 仍称「配音/成片为编排占位：执行时如实回报 TTS/拼装上游暂不可用」——引擎已实装真 TTS 闭环与真 ffmpeg 成片，文案低报能力、与代码不同步（`workflow-engine.ts` L9-10 头注同病） | index.ts L1293-1320、assembleFilmNode L1483+ | description 改为「配音=真 TTS 闭环（探测失败诚实报错）；成片=真 ffmpeg 拼接+混音（缺 ffmpeg/无镜头诚实报错）」 | ✅ **已修复**（description 改「配音为真实 TTS 生成、成片为真实拼接＋混音」；`workflow-engine.ts` 头注属内部注解非用户面，未动） |
| B3 | 低（回退隐患） | TTS 代码默认值为 `canopylabs/orpheus-v1-english`（voice tara，英文语音模型）；运行时 `.env` 已覆盖为 `http://127.0.0.1:8893` + `FunAudioLLM/CosyVoice2-0.5B`（edge-tts 壳，08-30 已 E2E 真出中文 MP3）——现况诚实，但 env 丢失会**静默回退英文模型**承接中文台词环，且 `probeTtsUpstream` 只验「载荷像音频」（magic bytes）不验语言 | index.ts L5505-5509 默认值 vs /opt/agent-harness/.env L13-15 | 把代码默认值改成与 env 同源（CosyVoice2），或 probe 加语言适配断言，消除静默回退 |
| B4 | 低 | novel_film 的 text 环（结构化剧本/分镜表）无引擎侧生成器：text/config 节点「视为完成」，内容全靠 agent 经 `workflow_update_node` 注入，引擎侧无门禁把关 | workflow-service.ts L674 | 可接受（编排设计如此）；若要硬门禁，在 film/video 执行前校验上游 text 节点非空 |
| B5 | 低 | character_sheet / feature_film 的「四视图设定表」实为 4 个独立 image 节点（count:4），非单张四格图；标题语义略过 | workflow-templates.ts sheet: "4-view" | 文案改「四张视图图」或在 prompt 内要求单张四格布局 |

## 6. 未观察项（诚实声明）

- 本次判定全部基于**源码与路由存在性**，未实弹调用任何 harness 工具或后端工作流（未产生真实扣费/真实产物）。
- 「已实装」= 工具档真调站点 API 且路由有 handler；端到端可用性（出真图/真片）属另一命题，历史证据见 newapi-video-upstream 测试（渠道 8 出真片）。
- 稽核阶段 VPS 零写入（仅 `cat`/`grep`/`sed -n`）；报告定稿后经复核，由 orchestrator 落地 B1/B2 修复（`workflow-templates.ts` 精确断言替换 + 重启 `agent-gateway.service`，验证 active + 新值在档 + 旧文案计数 0）。
- B3 的运行时 TTS 上游已由 `.env` 指向中文模型（08-30 E2E 证据在 memory），本次未重跑实弹；B1 修复后未重跑 novel_film 端到端报价（修复为纯数值对齐权威价目表，`resolveVideoPerSecond` 读档即生效）。

## 7. 触档清单

| 档 | 动作 |
|---|---|
| `src/lib/harness-tool-registry.ts` | 新建（36 工具真源 + 实装判定注解 + 空 HARNESS_STUB_TOOLS） |
| `src/lib/agent-templates.ts` | 54 新标 unsupported、2 解除、requiredTools 栏位文档注解改指真源；step 文案零改动 |
| `src/lib/agent-templates.test.ts` | 判定集换 HARNESS_TOOL_IDS、移除 domain registry import、新增 stale-free 双向测试 |
| `docs/template-honesty-audit.md` | 本档 |

## 附录：片6 style_lora_train 侦查证据（2026-08-31，零扣费、零训练提交）

`style_lora_train_optional`——08-31 暴君后续裁定**从模板移除**（永久死路能力不上产品面，不再以 unsupported 卡呈现；本附录保留证据链，站内 `art-workflows/tool-registry.ts` 契约与 `docs/skills/style-deep-research.md` 反伪训练门禁保留作内部守栏）。三处通道侦查结论与证据：

| # | 侦查点 | 方法 | 证据 | 结论 |
|---|---|---|---|---|
| ① | pixai-pool bridge（`pixai-pool/bridge/app.py`） | 通读端点面 + grep `train\|finetune\|lora` | 档头自述「OpenAI-compatible /v1/images/generations in front of the PixAI pool」，仅 `generate_image/handle_generation/run_generation` 生图路径；全档零 train/finetune/lora 匹配 | 无训练能力（纯生图代理） |
| ② | pixai 官方 API（`api.pixai.art`，pool token 只探不练） | REST GET 探 `/v2/trainings` `/v2/training` `/v2/lora-trainings` `/v2/training-jobs` `/v2/models`；GraphQL introspection + 训练字段名探测（`trainingList`/`loras`/`myTrainings`/`userTrainings`） | REST 五路径全 404；GraphQL introspection 回 400（禁用），字段探测全回 `Cannot query field ... on type "Query"`（建议被闸道 `<redacted>` 遮蔽）；token 认证被接受（非 401），排除鉴权误判 | 无可编程训练端点 |
| ③ | 站点 repo（`src/app/api/`） | grep `train\|finetune\|lora` 路由 | 仅 `lora-models/route.ts`（GET 转发 bridge `/v1/lora-models` 社群 LoRA **目录**）与 `lora-preferences/route.ts`（用户 LoRA **偏好**）；`use-cases/base-training.ts` 为展示文案非训练码；无任何提交训练的路由 | 无训练通道 |

**精确缺口**：要摘掉 unsupported，需出现以下任一上游——(a) PixAI 官方公开的 LoRA 训练 API（目前仅 web 端私有流程）；(b) 自建 ComfyUI/waifu-diffusion 训练 worker 并接入 generation-worker 路由；(c) 第三方训练托管（如 civitai/baseten finetune API）接入 bridge。三者皆为【能力建设】级工程，非本档工具可绕过。
