import { tool } from "@opencode-ai/plugin/tool";
import { ok, fail } from "../lib/client";

// ue_editor — 驱动使用者本机的 Unreal Editor（UE 5.8 官方 Unreal MCP 插件）。
//
// 链路：本工具（VPS）→ 闸道 /internal/device/invoke op=ue_mcp → 使用者桌面端装置桥（出站长轮询）
//       → 本机回环 http://127.0.0.1:<port>/mcp（UE 编辑器内嵌的 MCP 服务）。
// 本工具只透传 MCP 的 tools/list 与 tools/call，**不猜 UE 工具的参数格式**：
// 工具清单与参数 schema 一律以 UE 实际回来的为准（先 list，再 describe，再 call）。
// 放行条件在闸道与装置两侧各验一次：装置必须开「完全访问」（mode=full），因为这是写操作。

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081";

const NEXT_STEP: Record<string, string> = {
  no_device_registered: "使用者的 Eimu 桌面端没有连上。请对方打开 Eimu 桌面端并登录，开启本机桥接与「完全访问」。",
  device_offline: "使用者的 Eimu 桌面端离线了。请对方打开桌面端后再试。",
  permission_denied: "UE 联动是写操作，需要使用者在 Eimu 桌面端把本机权限切到「完全访问」。",
  device_timeout: "UE 编辑器在时限内没有回应（可能卡在导入／编译）。先 tools/list 确认编辑器仍在线，再决定是否重试；不要连续重复同一个写操作。",
};

export default tool({
  description:
    "驱动使用者本机的 Unreal Editor（UE 5.8 官方 Unreal MCP，经 Eimu 桌面端本机桥中继），做游戏关卡时用。" +
    "能做什么只以 UE 回来的工具清单为准：官方 5.8 文档列的是场景、Actor、材质实例、对象四类工具集，没有列导入资产或执行脚本；" +
    "tools/list 回来之前不要向用户承诺具体能力（尤其不要说能导入模型），清单里真有再说。" +
    "用法固定三步：① method=tools/list 看 UE 暴露了什么（开 Tool Search 时只有 list_toolsets／describe_toolset／call_tool 三个元工具）；" +
    "② tools/call name=list_toolsets → name=describe_toolset 取目标工具的参数 schema；" +
    "③ tools/call name=call_tool（或 UE 列出的具体工具名）照 schema 传 arguments。" +
    "参数格式只信 UE 回来的 schema，禁止凭印象编字段。UE 工具在游戏线程串行执行，一次只发一个调用，等结果再发下一个。" +
    "回执 is_error=true 表示 UE 工具本身报错（照原文修参数），不是链路坏了。" +
    "前提：使用者开着 Eimu 桌面端（完全访问）且 UE 5.8 已启用 Unreal MCP＋All Toolsets 插件并执行 ModelContextProtocol.StartServer；不满足时回执会写明缺哪一步，照原文转告使用者，不要假装已放好。",
  args: {
    method: tool.schema.enum(["tools/list", "tools/call"]).describe("MCP 方法：tools/list 列工具；tools/call 调工具。"),
    name: tool.schema.string().optional().describe("tools/call 的工具名（如 list_toolsets／describe_toolset／call_tool，或 UE 列出的具体工具名）。"),
    arguments: tool.schema
      .record(tool.schema.string(), tool.schema.any())
      .optional()
      .describe("tools/call 的参数对象，字段以 UE 回来的 inputSchema 为准。"),
    cursor: tool.schema.string().optional().describe("tools/list 分页游标（UE 回了 nextCursor 时才用）。"),
    port: tool.schema.number().int().min(1024).max(65535).optional().describe("UE MCP 端口，预设 8000（使用者改过才填）。"),
    timeout_seconds: tool.schema.number().int().min(5).max(600).optional().describe("单次等待上限，预设 180 秒；大批量导入可放宽。"),
  },
  async execute(args, context) {
    if (args.method === "tools/call" && !(typeof args.name === "string" && args.name.trim())) {
      return fail("bad_request", "tools/call 需要 name（先 tools/list 看有哪些工具）。");
    }
    const body: Record<string, unknown> = { op: "ue_mcp", method: args.method };
    if (args.name !== undefined) body.name = args.name;
    if (args.arguments !== undefined) body.arguments = args.arguments;
    if (args.cursor !== undefined) body.cursor = args.cursor;
    if (args.port !== undefined) body.port = args.port;
    if (args.timeout_seconds !== undefined) body.timeout_ms = args.timeout_seconds * 1000;

    let res: Response;
    try {
      res = await fetch(`${GATEWAY}/internal/device/invoke?session_id=${encodeURIComponent(context.sessionID)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: context.abort,
      });
    } catch (e) {
      return fail("internal_error", `无法连上本机桥闸道：${(e as Error).message}`);
    }
    const data = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok || !data?.ok) {
      const err = (data?.error ?? {}) as Record<string, unknown>;
      const code = typeof err.code === "string" && err.code ? err.code : "internal_error";
      const message = typeof err.message === "string" ? err.message : `HTTP ${res.status}`;
      // 装置端失败会以 internal_error 包回，原文里带 engine_unreachable 等码与「去 UE 里做哪一步」。
      const engineCode = /^(engine_[a-z_]+|permission_denied):/.exec(message)?.[1];
      return fail(engineCode ?? code, message, { next_step: NEXT_STEP[engineCode ?? code] ?? null });
    }
    const relayed = (data.result ?? {}) as Record<string, any>;
    if (relayed.ok === false) {
      return fail("ue_rpc_error", String(relayed.error?.message ?? "UE MCP 返回 JSON-RPC 错误"), { rpc_code: relayed.error?.code ?? null });
    }
    const result = relayed.result ?? null;
    return ok({
      title: args.method === "tools/list" ? "UE 工具清单" : `UE · ${args.name}`,
      server: relayed.server ?? null,
      is_error: result?.isError === true,
      result,
      truncated: data.truncated === true,
      compacted: result?.eimu_compacted === true,
    });
  },
});
