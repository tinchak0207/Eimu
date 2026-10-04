// RFC 9728 OAuth Protected Resource Metadata（MCP 端点的免授权发现文件）。
//
// 用途：coding agent 对 POST /api/mcp 发未授权请求 → 401 + WWW-Authenticate: Bearer，
// 接著靠这份文件（零凭证、零登入）找到资源位址、授权伺服器与可用 scope，
// 再决定是「带 B 端密钥」还是「走 OAuth」。
//
// 本档只汇出 GET：Next.js 对 route 档的汇出做白名单型别检查，
// 值汇出滞留本档会炸 `next build`（2026-09-23 远端建置实锤，见 src/app/api/v1/quota/route.ts 档头）。
//
// 契约（MCP server 由另一路负责，本档只做发现面）：
//   POST /api/mcp（JSON-RPC 2.0 / Streamable HTTP），Authorization: Bearer sk-biz-…
//   支援 initialize / tools/list / tools/call；未授权回 401 + WWW-Authenticate: Bearer。

import { getSiteUrlFromEnv } from "@/lib/site-url";

// scope 分组＝我方真实能力边界（对应 tools/list 的 23 个工具，见 src/lib/mcp/tools.ts），不是任何对手的命名：
//   eimu:models:read → list_models（模型目录、端点归属与单价）
//   eimu:skills:read → list_skills / get_skill（公开技能库；私有技能永不外露）
//   eimu:image:write → generate_image / edit_image / upscale
//   eimu:video:write → generate_video
//   eimu:audio:write → tts（文字转语音）
//   eimu:tasks:read  → get_result（异步任务结果轮询）
//   eimu:quota:read  → get_quota（余额与币种）
//   eimu:canvas:read → list_canvas_projects / canvas_get_state / workflow_read / workflow_history（画布产线读面）
//   eimu:canvas:write → workflow_write / workflow_rollback（画布产线声明式写入与节点回滚）
//   eimu:agent:read  → list_agent_sessions / get_agent_session / get_agent_settings（Eimu agent 会话读面：
//                      会话清单、单一会话的对话与产物、该帐号的 agent 设定，含 beast_mode 野兽模式开关）
//   eimu:agent:write → run_agent / abort_agent_session（写面：把工作交给 Eimu 的 agent orchestrator
//                      执行并取回带成品 URL 的回覆；中止一个正在跑的会话）
//   eimu:harness:read → check_delivery_contract / evaluate_media_quality（交付契约栏位校验、媒体确定性硬质检；
//                      harness 指南资源 eimu://harness/guide、eimu://harness/delivery-contracts 与提示模板
//                      eimu-harness 亦属此能力面；皆为唯读自检，不呼叫模型）
//
// 事实上：这些 scope 目前只是**对外公告的能力标签**。MCP 端点（src/app/api/mcp/route.ts）
// 只验 B 端密钥有效性（authenticateBizApiKey）与速率，**不按 scope 逐项鉴权**——
// 任何有效密钥都能呼叫全部工具。本清单与 /mcp 页、public/llms.txt 的工具表同口径。
const SCOPES_SUPPORTED = [
  "eimu:models:read",
  "eimu:skills:read",
  "eimu:image:write",
  "eimu:video:write",
  "eimu:audio:write",
  "eimu:tasks:read",
  "eimu:quota:read",
  "eimu:canvas:read",
  "eimu:canvas:write",
  "eimu:agent:read",
  "eimu:agent:write",
  "eimu:harness:read",
];

export function GET(): Response {
  const origin = getSiteUrlFromEnv();

  return Response.json(
    {
      resource: `${origin}/api/mcp`,
      authorization_servers: [origin],
      scopes_supported: SCOPES_SUPPORTED,
      resource_documentation: `${origin}/mcp`,
      bearer_methods_supported: ["header"],
    },
    {
      headers: {
        "Cache-Control": "public, max-age=3600",
        "Access-Control-Allow-Origin": "*",
      },
    },
  );
}
