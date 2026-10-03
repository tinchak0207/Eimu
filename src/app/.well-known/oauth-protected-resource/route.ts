// RFC 9728 OAuth Protected Resource Metadata（MCP 端點的免授權發現文件）。
//
// 用途：coding agent 對 POST /api/mcp 發未授權請求 → 401 + WWW-Authenticate: Bearer，
// 接著靠這份文件（零憑證、零登入）找到資源位址、授權伺服器與可用 scope，
// 再決定是「帶 B 端密鑰」還是「走 OAuth」。
//
// 本檔只匯出 GET：Next.js 對 route 檔的匯出做白名單型別檢查，
// 值匯出滯留本檔會炸 `next build`（2026-09-23 遠端建置實錘，見 src/app/api/v1/quota/route.ts 檔頭）。
//
// 契約（MCP server 由另一路負責，本檔只做發現面）：
//   POST /api/mcp（JSON-RPC 2.0 / Streamable HTTP），Authorization: Bearer sk-biz-…
//   支援 initialize / tools/list / tools/call；未授權回 401 + WWW-Authenticate: Bearer。

import { getSiteUrlFromEnv } from "@/lib/site-url";

// scope 分組＝我方真實能力邊界（對應 tools/list 的 16 個工具，見 src/lib/mcp/tools.ts），不是任何對手的命名：
//   eimu:models:read → list_models（模型目錄、端點歸屬與單價）
//   eimu:skills:read → list_skills / get_skill（公開技能庫；私有技能永不外露）
//   eimu:image:write → generate_image / edit_image / upscale
//   eimu:video:write → generate_video
//   eimu:audio:write → tts（文字轉語音）
//   eimu:tasks:read  → get_result（異步任務結果輪詢）
//   eimu:quota:read  → get_quota（餘額與幣種）
//   eimu:canvas:read → list_canvas_projects / canvas_get_state / workflow_read / workflow_history（畫布產線讀面）
//   eimu:canvas:write → workflow_write / workflow_rollback（畫布產線聲明式寫入與節點回滾）
//
// 事實上：這些 scope 目前只是**對外公告的能力標籤**。MCP 端點（src/app/api/mcp/route.ts）
// 只驗 B 端密鑰有效性（authenticateBizApiKey）與速率，**不按 scope 逐項鑑權**——
// 任何有效密鑰都能呼叫全部工具。本清單與 /mcp 頁、public/llms.txt 的工具表同口徑。
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
