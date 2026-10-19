/**
 * Harness 真实工具面（产品诚实稽核真源，2026-08-31；2026-09-28 再核）。
 *
 * 真源 = VPS /opt/eimu-harness/workspace/.opencode/tools/（排除 .bak），
 * 核对日期 2026-08-31，来源于 agent-evolve 评测。
 * 这是 agent-templates.ts requiredTools 绑定的唯一判定集：
 * 站内 domain registry（agent-tool-contract / 5 个领域档）是宣告层自我认证，
 * 不代表 harness 真的能执行——工具卡诚实与否只以本档为准。
 *
 * ── 2026-09-28 诚实注记（登记 ≠ 可跑） ──
 * 本档是**站点侧登记面**，不是 VPS 现场清单。2026-09-28 现场 `ls` 实测（排除 .bak）
 * 共 **105 支**活体工具（比 08-31 的 101 支多出 4 支影片工具）；本档不可能替
 * VPS 背书「可跑」，只表示「id 已定形、模板可以引用」。已知**未登记**（VPS 有、本档无）：
 * character_card_list / character_card_save / director_manage_group / memory_recall /
 * search_web / subagent_status / subagent_stop / vision_analyze。
 * 另有族前缀未逐支登记：subagent_*（现 3 支：dispatch/status/stop）。
 * workflow_*：人机共笔三件（write/history/rollback）加入后本档登 11 支；
 * **诚实标注**（2026-10-08 更新）：此前 10-03 实测「现场仅 8 支、缺 write/history/rollback」
 * 的落差已消除——write 于 10-05 12:39 UTC 随 558492e418fd 落位，2026-10-08 现场
 * 实测 11 支全齐，登记面与 VPS 现场一致。
 *
 * 实装判定（2026-08-31 源码逐档核对，非实弹调用）：
 * - image_upscale：真调用 POST {API_BASE}/upscale，站点路由
 *   src/app/api/v1/upscale/route.ts 存在 POST handler → 已实装。
 * - image_edit：真调用 POST {API_BASE}/images/edits，站点路由
 *   src/app/api/v1/images/edits/route.ts 存在 POST handler → 已实装。
 * - image_quote：真调用 GET {API_BASE}/models，站点路由
 *   src/app/api/v1/models/route.ts 存在 GET handler → 已实装。
 * - quote_bundle：loadCatalog → GET {API_BASE}/models（同上）→ 已实装。
 * API_BASE = https://image.eimu.dev/v1（harness lib/client.ts L6）。
 *
 * 清单本体（HARNESS_TOOL_ID_LIST / HARNESS_TOOL_IDS / HarnessToolId）已迁到
 * `harness-tool-ids.ts`（客户端安全：不含任何本站模组 import，供浏览器 bundle 侧
 * 如 workflow-dsl/decompile.ts 引入，避免把 blender-tools( node:path ) 拖进客户端）。
 * 本档只 re-export，登记面与现场稽核口径以上述头注为准。
 */

export { HARNESS_TOOL_ID_LIST, HARNESS_TOOL_IDS } from "./harness-tool-ids";
export type { HarnessToolId } from "./harness-tool-ids";

/**
 * 档存在但判定为 stub / throw / 未接 handler 的工具（不混进可用集）。
 * 2026-08-31 稽核：四个可疑工具（image_upscale / image_edit / image_quote /
 * quote_bundle）源码均为真调用站点 API 的完整实现，无 stub；本集为空。
 * 未来若某工具被判定为 stub，在此登记 id → 一句话原因。
 */
export const HARNESS_STUB_TOOLS: Readonly<Record<string, string>> = {};
