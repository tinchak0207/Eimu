// ===== 常量（S0 同步写入 project/constants.ts）=====
export const LIMITS = {
  PATCH_RECEIPT_BYTES: 1024, RUN_RECEIPT_BYTES: 1024, DIGEST_BYTES: 6144, NODE_VIEW_BYTES: 4096, EVENTS_BYTES: 2048,
  SUBAGENT_SUMMARY_BYTES: 4096, SUBAGENT_NODE_IDS: 20, CONTEXT_WINDOW_STEPS: 6, WAIT_SEC_MAX: 90,
  INTENT_CHARS: 200, BRIEF_ENTRY_CHARS: 12000, TAKES_MAX: 4, REGENERATE_MAX: 2, INPUT_CAP_BYTES: 65536,
  MAIN_TOOLS_MAX: 14, TOMBSTONE_DAYS: 7,
} as const
export const estimateTokens = (s: string) => Math.ceil(new TextEncoder().encode(s).length / 2) // 保守估计：CJK 约 1 token/1.5 字符，按 2 字节/token 偏大
// 起始超集（来自 R/tools/ 目录清单）；S14 必须再扫描 R/tools/*.ts 里直接触达生成端点（generations、/tts、music、blender、image_generate 的 lib 包装）的工具补全，补全结果与“被折叠到哪个节点类型/role/配方、或本期不支持”的清单写进 S14 回报
export const DIRECT_GENERATION_TOOLS = [
  "image_generate","image_edit","image_upscale","background_remove","keyframe_render","canvas_generate_image","canvas_create_generation_flow",
  "character_dna_turnaround","product_conditioned_generation","virtual_tryon","hand_contact_repair","outlier_audit_regenerate",
  "scene_pack_batch","shot_grid_batch","style_aligned_batch","aspect_reflow","multi_aspect_reflow","platform_reflow","moodboard_diverge_converge","emotion_board_matrix",
  "last_frame_video_chain","storyboard_voiceover","music_gen","tts_speak","blender_exec","blender_render","blender_export_gltf",
  "timeline_ops","timeline_mix","timeline_master","timeline_style","timeline_rhythm","timeline_restore","artifact_publish",
] as const
