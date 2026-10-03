/**
 * Harness 真實工具面（產品誠實稽核真源，2026-08-31；2026-09-28 再核）。
 *
 * 真源 = VPS /opt/agent-harness/workspace/.opencode/tools/（排除 .bak），
 * 核對日期 2026-08-31，來源於 agent-evolve 評測。
 * 這是 agent-templates.ts requiredTools 綁定的唯一判定集：
 * 站內 domain registry（agent-tool-contract / 5 個領域檔）是宣告層自我認證，
 * 不代表 harness 真的能執行——工具卡誠實與否只以本檔為準。
 *
 * ── 2026-09-28 誠實註記（登記 ≠ 可跑） ──
 * 本檔是**站點側登記面**，不是 VPS 現場清單。2026-09-28 現場 `ls` 實測（排除 .bak）
 * 共 **105 支**活體工具（比 08-31 的 101 支多出 4 支影片工具）；本檔不可能替
 * VPS 背書「可跑」，只表示「id 已定形、模板可以引用」。已知**未登記**（VPS 有、本檔無）：
 * character_card_list / character_card_save / director_manage_group / memory_recall /
 * search_web / subagent_status / subagent_stop / vision_analyze。
 * 另有族前綴未逐支登記：subagent_*（現 3 支：dispatch/status/stop）。
 * workflow_*：2026-10-03 人機共筆三件（write/history/rollback）加入後本檔登 11 支；
 * **誠實標注**：VPS 現場並未同步——2026-10-03 現場實測僅 8 支（無 write/history/rollback），
 * 本檔登記的是「已定形可引用」，不是「現場可跑」。補齊清單留給下一輪稽核，
 * 不在此一次灌滿（登記面一旦摻水就失去判定價值）。
 *
 * 實裝判定（2026-08-31 源碼逐檔核對，非實彈調用）：
 * - image_upscale：真調用 POST {API_BASE}/upscale，站點路由
 *   src/app/api/v1/upscale/route.ts 存在 POST handler → 已實裝。
 * - image_edit：真調用 POST {API_BASE}/images/edits，站點路由
 *   src/app/api/v1/images/edits/route.ts 存在 POST handler → 已實裝。
 * - image_quote：真調用 GET {API_BASE}/models，站點路由
 *   src/app/api/v1/models/route.ts 存在 GET handler → 已實裝。
 * - quote_bundle：loadCatalog → GET {API_BASE}/models（同上）→ 已實裝。
 * API_BASE = https://image.tinchak0207.xyz/v1（harness lib/client.ts L6）。
 */

import { BLENDER_HARNESS_TOOL_IDS } from "./blender-tools"
import { MUSIC_HARNESS_TOOL_IDS } from "./music-tools"

export const HARNESS_TOOL_ID_LIST = [
  "asset_activate",
  "asset_get",
  // ↓ 2026-08-31 片1 實裝（VPS .opencode/tools/ 落位 + opencode-server 重啟 +
  //   bun 直調 execute 真實/邊界樣例全綠 + /experimental/tool/ids 活體註冊確認）
  "asset_provenance_archive",
  "asset_search",
  // ↓ 2026-09-06 Astra 3D 導演工作站 P0-4（片C）：blender 工具族三件。定義+handler 真源 =
  //   src/lib/blender-tools.ts（橋 HTTP 契約 GET /v1/health + POST /v1/execute，
  //   env BLENDER_BRIDGE_URL 默認 http://127.0.0.1:8765；橋由 P0-1/P0-2 施工）。
  //   誠實標注：本檔登記=定義已定形；VPS .opencode/tools/ 落位與活體註冊確認待橋就緒後補
  //   （註冊≠harness 能跑）；deny 例外暫存與橋接說明見 docs/blender-bridge-notes.md。
  ...BLENDER_HARNESS_TOOL_IDS,
  "canvas_apply_ops",
  "canvas_create_generation_flow",
  "canvas_generate_image",
  "canvas_get_state",
  // ↓ 2026-08-31 片2 實裝（圖像編排 10 工具：VPS .opencode/tools/ 落位 +
  //   lib/img-orchestrate.ts 共用生圖/編輯/VLM 鏈 + dry_run/真發射 smoke + 活體註冊確認）
  "canonical_key_art_lock",
  "cast_asset_lock",
  "character_dna_turnaround",
  "delivery_assets",
  "detail_page_manifest",
  // ↓ 2026-09-02 3D導演台實裝（16 director_* 工具：VPS .opencode/tools/ 落位 +
  //   lib/director-common.ts 共用傳輸/守衛層 + lib/director/ 純函數鏈（kunpeng 輪子：motionTemplates/
  //   cameraTemplates/poses/playback/pathCurve/types + nanoid shim）+ gateway /agent/v1/director 六路由（片3）；
  //   活體註冊確認：bun build 16/16 過 + opencode-server 重啟後 /experimental/tool/ids 列出
  //   16 id + 實彈 bun 直調 smoke 16 工具全閉環（真 gateway session，42 項斷言 PASS））
  "director_apply_proposal",
  "director_create_element",
  "director_delete",
  "director_get_state",
  "director_manage_plan",
  "director_manage_shot",
  "director_prepare_export",
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
  // ↓ 2026-09-28 影片提取四支（VPS .opencode/tools/ 現場已落位，`ls` 實測在列；
  //   本站知識庫已把「怎麼看參考片」接回這四支——2026-09-28 前正文教了動作卻沒有工具，屬自傷）。
  //   誠實標注：本檔=登記面，活體註冊與實跑樣例待下一輪 harness 稽核補。
  "video_evidence",
  "video_fetch",
  "video_measure",
  "video_quote",
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
  // ↓ 2026-09-02 隱形轉譯層新增：AI 筆=緊湊宣告式 DSL，整份編譯原子套用到
  //   畫布泳道（站點 /v1/workflow/compile 純編譯 → canvas_apply_ops 通道）。
  //   管轄範圍=畫布工作流（world 1）；執行圖（world 2：模板 workflow_start/
  //   素材注入 workflow_add_node/update_node/film 成片）不在 DSL 管轄內，原工具原樣保留。
  "workflow_write",
  // ↓ 2026-10-03 人機共筆收口（讀／改／回滾三件）：讀面＝canvas_get_state 回 dsl；
  //   寫面＝workflow_write（上）；版本面＝workflow_history（讀版本史）＋
  //   workflow_rollback（revert_node op 回退單節點內容）。前綴族現 11 支。
  "workflow_history",
  "workflow_rollback",
  "world_bible_extract",
  // ↓ 2026-08-31 片3 實裝（確定性排版/風格 6 工具：VPS .opencode/tools/ 落位 +
  //   lib/img-composite.ts + lib/imgops.py 共用 PIL 編排鏈（零生圖扣費，僅 VLM chat）+
  //   bun 直調 execute 真實/邊界樣例全綠 + 產物公網 URL GET 200 + PIL/ffprobe 尺寸實測 +
  //   /experimental/tool/ids 活體註冊確認）
  "aspect_reflow",
  "multi_aspect_reflow",
  "platform_reflow",
  "shot_grid_batch",
  "sketch_lock",
  "style_anchor_sref",
  // ↓ 2026-08-31 片5 實裝（VLM/摳圖 8 工具：VPS .opencode/tools/ 落位 +
  //   lib/batch5-matting.ts 共用 rembg 摳圖/blob/VLM 鏈 +
  //   bun 直調 execute 真實/邊界樣例全綠 + 產物公網 URL GET 200 + PIL alpha 通道實測 +
  //   upscale_audit 走站點 /upscale 計費鏈（confirm 閘門批准後真調用）+
  //   /experimental/tool/ids 活體註冊確認）
  "background_remove",
  "detail_page_evidence_map",
  "garment_dna_lock",
  "garment_extract",
  "model_identity_lock",
  // ↓ 2026-09-08 MOE Wave1 片B：music_gen 工具（音樂 Expert，三通路優先序 YuE2 > FlowMusic2API > Lyria，2026-09-19 起）。定義+handler 真源 =
  //   src/lib/music-tools.ts（Lyria client = src/lib/music-lyria.ts，Gemini API
  //   v1beta/interactions，env GEMINI_API_KEY；音頻落盤復用 gateway 會話上傳存儲）。
  //   誠實標注：本檔登記=定義已定形；VPS .opencode/tools/ 落位與活體註冊確認待接線片補
  //   （staging 稿已由 tools/export-music-tools-staging.ts 機械導出至 staging/music-tools/）。
  ...MUSIC_HARNESS_TOOL_IDS,
  "outlier_audit_regenerate",
  "style_dna_extract",
  "upscale_audit",
  // ↓ 2026-08-31 片4 實裝（音視頻鏈 2 工具：VPS .opencode/tools/ 落位 +
  //   audio_first_timeline 復用 gateway /agent/v1/tts（tts_speak 同調法）逐行真 TTS +
  //   ffprobe 實測時長 + 累計 offset_ms 錨點；last_frame_video_chain 走站點 /v1/videos/generations
  //   計費鏈（dry_run 零扣費 + 預算閘 + submit_only），實證 1 鏡 seedance-2.0-mini 4s 實扣 32 幣、
  //   mp4 GET 200 + ffprobe 4.04s；誠實發現：站點 B 端無 first/last_frame 欄位，幀降級文生視頻）+
  //   /experimental/tool/ids 活體註冊確認）
  "audio_first_timeline",
  "last_frame_video_chain",
  // ↓ 2026-08-31 片6 實裝（硬骨頭模板工具 3 個：VPS .opencode/tools/ 落位 +
  //   virtual_tryon 走站點 /v1/images/edits 編輯鏈（中文指令+garment DNA 錨定，
  //   誠實標 instruction-based edit 非 CatVTON）實彈 1 張產物公網 URL + VLM 抽檢 warn 如實回報；
  //   hand_contact_repair VLM 定位→局部修復編輯→前後複驗，no_repair_needed 與 repaired 雙路徑實證
  //   （mediaId 模式真發射，複驗 unchanged/identity_kept=warn 誠實證據）；
  //   style_aligned_batch 復用 style_anchor_sref 抽取段 + outlier_audit 審計核心，
  //   dry_run 報價 + 真發射 2 張 2/2 成功審計離群 0 +
  //   /experimental/tool/ids 活體註冊確認。style_lora_train_optional 三處偵查無訓練通道，
  //   08-31 暴君裁定模板卡片已移除（證據鏈見 docs/template-honesty-audit.md 附錄））
  "virtual_tryon",
  "hand_contact_repair",
  "style_aligned_batch",
] as const;

export type HarnessToolId = (typeof HARNESS_TOOL_ID_LIST)[number];

/** 判定集：模板 requiredTools 的 id 只有在此集合內才算「harness 已實裝」。 */
export const HARNESS_TOOL_IDS: ReadonlySet<string> = new Set<string>(HARNESS_TOOL_ID_LIST);

/**
 * 檔存在但判定為 stub / throw / 未接 handler 的工具（不混進可用集）。
 * 2026-08-31 稽核：四個可疑工具（image_upscale / image_edit / image_quote /
 * quote_bundle）源碼均為真調用站點 API 的完整實現，無 stub；本集為空。
 * 未來若某工具被判定為 stub，在此登記 id → 一句話原因。
 */
export const HARNESS_STUB_TOOLS: Readonly<Record<string, string>> = {};
