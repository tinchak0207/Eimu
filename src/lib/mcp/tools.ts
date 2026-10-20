/**
 * MCP 工具表与执行层——**只做转发与投影，零业务、零计费**。
 *
 * 硬规则（改本档前先读，这是本档存在的理由）：
 * 1. **不重写任何业务**。生成/查询类工具「把参数原样交给既有 `/api/v1/**` 端点」
 *    （帐本、幂等、配额预检、退款、上游路由全在那些端点里）；skill 族是对既有注册表的
 *    唯读投影；工作流族（`workflow_write/history/read/rollback`＋`canvas_get_state`）
 *    是既有编译器/画布端点的薄转发（读面只挑栏位投影）。本档**没有**任何金额、
 *    模型白名单、配额、扣费或编译/回滚语义的判断。
 * 2. **鉴权逐字复用**。工具自身不验 key；呼叫者的 `Authorization` 头原样透传，
 *    由同一支 `authenticateBizApiKey` 决定身分与计费主体（见 `src/app/api/mcp/route.ts`）。
 * 3. **私有 skill 永不外露**。只用 registry 的公开族函式（`listPublicSkills` 等），
 *    绝不调 `listMySkills` / `getMySkillById`，也不接受任何 owner 参数。
 * 4. **失败不装死也不炸**。上游 4xx/5xx、网路中断一律回 `isError: true` 的工具结果
 *    （模型看得见原文、能自行修正）；只有「参数不合 schema」才是 JSON-RPC -32602。
 *
 * 传输选择：转发走**站内 HTTP**（`<origin>/api/v1/...`），不是 in-process 呼叫路由函式。
 * 理由写在 `createHttpDispatcher` 的注解里。
 */

export { callTool, listToolNames, MCP_TOOLS, __getToolSchemaForTests } from "./tools/tools-definitions";
export { createHttpDispatcher } from "./tools/dispatch";
export { validateToolArguments } from "./tools/validation";
export { MAX_TOOL_TEXT_LENGTH } from "./protocol";
export type { McpDispatchRequest, McpDispatchResponse, McpDispatcher, McpToolContext, ToolInputSchema, ToolSchemaType } from "./tools/types";
