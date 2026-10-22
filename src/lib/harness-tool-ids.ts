/**
 * Harness 工具 id 清单本体（客户端安全）。
 *
 * 客户端安全：本档**禁 import 任何本站模组**（含 blender-tools / music-tools 等会拖进
 * `node:path` 的服务端模组），只放纯字面量。凡进入浏览器 bundle 的模组
 * （如 workflow-dsl/decompile.ts）一律从本档取 `HARNESS_TOOL_IDS`。
 *
 * 真源诚实稽核注记（登记 ≠ 可跑、VPS 现场口径、模版绑定判定）见
 * `harness-tool-registry.ts` 头注——本档只是把清单本体搬成客户端可安全引入的形态。
 */

/** blender 工具族 id 元组（字母序，与 HARNESS_TOOL_ID_LIST 登记顺序一致）。
 *  原样搬自 src/lib/blender-tools.ts（保持既有 import 者不破，该档改为 re-export）。 */
export const BLENDER_HARNESS_TOOL_IDS = ["blender_exec", "blender_export_gltf", "blender_render"] as const

/** music 工具族 id 元组（同 BLENDER_HARNESS_TOOL_IDS 范式）。
 *  原样搬自 src/lib/music-tools.ts（保持既有 import 者不破，该档改为 re-export）。 */
export const MUSIC_HARNESS_TOOL_IDS = ["music_gen"] as const

export const HARNESS_TOOL_ID_LIST = [
  "asset_activate",
  "asset_get",
  // ↓ 2026-08-31 片1 实装（VPS .opencode/tools/ 落位 + opencode-server 重启 +
  //   bun 直调 execute 真实/边界样例全绿 + /experimental/tool/ids 活体注册确认）
  "asset_provenance_archive",
  "asset_search",
  // ↓ 2026-09-06 Astra 3D 导演工作站 P0-4（片C）：blender 工具族三件。定义+handler 真源 =
  //   src/lib/blender-tools.ts（桥 HTTP 契约 GET /v1/health + POST /v1/execute，
  //   env BLENDER_BRIDGE_URL 默认 http://127.0.0.1:8765；桥由 P0-1/P0-2 施工）。
  //   诚实标注：本档登记=定义已定形；VPS .opencode/tools/ 落位与活体注册确认待桥就绪后补
  //   （注册≠harness 能跑）；deny 例外暂存与桥接说明见 docs/blender-bridge-notes.md。
  ...BLENDER_HARNESS_TOOL_IDS,
  "canvas_apply_ops",
  "canvas_create_generation_flow",
  "canvas_generate_image",
  "canvas_get_state",
  // ↓ 2026-08-31 片2 实装（图像编排 10 工具：VPS .opencode/tools/ 落位 +
  //   lib/img-orchestrate.ts 共用生图/编辑/VLM 链 + dry_run/真发射 smoke + 活体注册确认）
  "canonical_key_art_lock",
  "cast_asset_lock",
  "character_dna_turnaround",
  "delivery_assets",
  // ↓ 2026-10-10 F2：workspace 文稿入库平台 blob，聊天可点开
  "document_upload",
  "detail_page_manifest",
  // ↓ 2026-09-02 3D导演台实装（18 director_* 工具（含 manage_group + capture_previz）：VPS .opencode/tools/ 落位 +
  //   lib/director-common.ts 共用传输/守卫层 + lib/director/ 纯函数链（kunpeng 轮子：motionTemplates/
  //   cameraTemplates/poses/playback/pathCurve/types + nanoid shim）+ gateway /agent/v1/director 六路由（片3）；
  //   活体注册确认：bun build 18/18 过 + opencode-server 重启后 /experimental/tool/ids 列出
  //   18 id + 实弹 bun 直调 smoke 18 工具全闭环（真 gateway session，42 项断言 PASS））
  "director_apply_proposal",
  "director_create_element",
  "director_delete",
  "director_get_state",
  "director_manage_plan",
  "director_manage_shot",
  "director_prepare_export",
  "director_capture_previz",
  "director_project_control",
  "director_propose_plans",
  "director_select",
  "director_set_camera_keyframe",
  "director_set_lock",
  "director_set_motion_keyframe",
  "director_transport",
  "director_update_element",
  "director_upsert_action",
  "doc_struct",
  "editing_manifest",
  "emotion_board_matrix",
  "exhibition_delivery_manifest",
  "image_edit",
  "image_generate",
  "image_get_result",
  "image_result_download",
  "image_quote",
  "image_upscale",
  "image_upload",
  "keyframe_render",
  "moodboard_diverge_converge",
  "product_conditioned_generation",
  "product_lock",
  "quote_bundle",
  "run_py",
  "scene_pack_batch",
  "script_scene_parse",
  "story_sequence_consistency",
  "storyboard_qc_17",
  "subagent_dispatch",
  "timeline_lint",
  "timeline_master",
  "timeline_mix",
  "timeline_ops",
  "timeline_query",
  "timeline_restore",
  "timeline_rhythm",
  "timeline_style",
  "tts_speak",
  // ↓ 2026-09-28 影片提取四支（VPS .opencode/tools/ 现场已落位，`ls` 实测在列；
  //   本站知识库已把「怎么看参考片」接回这四支——2026-09-28 前正文教了动作却没有工具，属自伤）。
  //   诚实标注：本档=登记面，活体注册与实跑样例待下一轮 harness 稽核补。
  "video_evidence",
  "video_fetch",
  "video_measure",
  "video_quote",
  "video_result_fetch",
  "video_transcribe",
  "video_upload",
  "workflow_add_node",
  "workflow_connect",
  "workflow_disconnect",
  "workflow_generate",
  "workflow_rerun_node",
  "workflow_start",
  "workflow_status",
  "workflow_update_node",
  // ↓ 2026-09-02 隐形转译层新增：AI 笔=紧凑宣告式 DSL，整份编译原子套用到
  //   画布泳道（站点 /v1/workflow/compile 纯编译 → canvas_apply_ops 通道）。
  //   管辖范围=画布工作流（world 1）；执行图（world 2：模板 workflow_start/
  //   素材注入 workflow_add_node/update_node/film 成片）不在 DSL 管辖内，原工具原样保留。
  "workflow_write",
  // ↓ 2026-10-03 人机共笔收口（读／改／回滚三件）：读面＝canvas_get_state 回 dsl；
  //   写面＝workflow_write（上）；版本面＝workflow_history（读版本史）＋
  //   workflow_rollback（revert_node op 回退单节点内容）。前缀族现 11 支。
  "workflow_history",
  "workflow_rollback",
  "world_bible_extract",
  // ↓ 2026-08-31 片3 实装（确定性排版/风格 6 工具：VPS .opencode/tools/ 落位 +
  //   lib/img-composite.ts + lib/imgops.py 共用 PIL 编排链（零生图扣费，仅 VLM chat）+
  //   bun 直调 execute 真实/边界样例全绿 + 产物公网 URL GET 200 + PIL/ffprobe 尺寸实测 +
  //   /experimental/tool/ids 活体注册确认）
  "aspect_reflow",
  "multi_aspect_reflow",
  "platform_reflow",
  "shot_grid_batch",
  "sketch_lock",
  "style_anchor_sref",
  // ↓ 2026-08-31 片5 实装（VLM/抠图 8 工具：VPS .opencode/tools/ 落位 +
  //   lib/batch5-matting.ts 共用 rembg 抠图/blob/VLM 链 +
  //   bun 直调 execute 真实/边界样例全绿 + 产物公网 URL GET 200 + PIL alpha 通道实测 +
  //   upscale_audit 走站点 /upscale 计费链（confirm 闸门批准后真调用）+
  //   /experimental/tool/ids 活体注册确认）
  "background_remove",
  "detail_page_evidence_map",
  "garment_dna_lock",
  "garment_extract",
  "model_identity_lock",
  // ↓ 2026-09-08 MOE Wave1 片B：music_gen 工具（音乐 Expert，三通路优先序 YuE2 > FlowMusic2API > Lyria，2026-09-19 起）。定义+handler 真源 =
  //   src/lib/music-tools.ts（Lyria client = src/lib/music-lyria.ts，Gemini API
  //   v1beta/interactions，env GEMINI_API_KEY；音频落盘复用 gateway 会话上传存储）。
  //   诚实标注：本档登记=定义已定形；VPS .opencode/tools/ 落位与活体注册确认待接线片补
  //   （staging 稿已由 tools/export-music-tools-staging.ts 机械导出至 staging/music-tools/）。
  ...MUSIC_HARNESS_TOOL_IDS,
  "outlier_audit_regenerate",
  "style_dna_extract",
  "upscale_audit",
  // ↓ 2026-08-31 片4 实装（音视频链 2 工具：VPS .opencode/tools/ 落位 +
  //   audio_first_timeline 复用 gateway /agent/v1/tts（tts_speak 同调法）逐行真 TTS +
  //   ffprobe 实测时长 + 累计 offset_ms 锚点；last_frame_video_chain 走站点 /v1/videos/generations
  //   计费链（dry_run 零扣费 + 预算闸 + submit_only），实证 1 镜 seedance-2.0-mini 4s 实扣 32 币、
  //   mp4 GET 200 + ffprobe 4.04s；诚实发现：站点 B 端无 first/last_frame 栏位，帧降级文生视频）+
  //   /experimental/tool/ids 活体注册确认）
  "audio_first_timeline",
  "last_frame_video_chain",
  // ↓ 2026-08-31 片6 实装（硬骨头模板工具 3 个：VPS .opencode/tools/ 落位 +
  //   virtual_tryon 走站点 /v1/images/edits 编辑链（中文指令+garment DNA 锚定，
  //   诚实标 instruction-based edit 非 CatVTON）实弹 1 张产物公网 URL + VLM 抽检 warn 如实回报；
  //   hand_contact_repair VLM 定位→局部修复编辑→前后复验，no_repair_needed 与 repaired 双路径实证
  //   （mediaId 模式真发射，复验 unchanged/identity_kept=warn 诚实证据）；
  //   style_aligned_batch 复用 style_anchor_sref 抽取段 + outlier_audit 审计核心，
  //   dry_run 报价 + 真发射 2 张 2/2 成功审计离群 0 +
  //   /experimental/tool/ids 活体注册确认。style_lora_train_optional 三处侦查无训练通道，
  //   08-31 暴君裁定模板卡片已移除（证据链见 docs/template-honesty-audit.md 附录））
  "virtual_tryon",
  "hand_contact_repair",
  "style_aligned_batch",
] as const;

export type HarnessToolId = (typeof HARNESS_TOOL_ID_LIST)[number];

/** 判定集：模板 requiredTools 的 id 只有在此集合内才算「harness 已实装」。 */
export const HARNESS_TOOL_IDS: ReadonlySet<string> = new Set<string>(HARNESS_TOOL_ID_LIST);
