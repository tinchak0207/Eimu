import { tool } from "@opencode-ai/plugin/tool";
import { ok, fail } from "../lib/client";
import { buildWorldAuditPython, parseWorldAuditResult } from "../lib/game-asset-audit";

// ue_editor — 驱动使用者本机的 Unreal Editor（UE 5.9.0 官方 Unreal MCP 插件）。
//
// 链路：本工具（VPS）→ 闸道 /internal/device/invoke op=ue_mcp → 使用者桌面端装置桥（出站长轮询）
//       → 本机回环 http://127.0.0.1:<port>/mcp（UE 编辑器内嵌的 MCP 服务）。
// 本工具只透传 MCP 的 tools/list 与 tools/call，**不猜 UE 工具的参数格式**：
// 工具清单与参数 schema 一律以 UE 实际回来的为准（先 list，再 describe，再 call）。
// 放行条件在闸道与装置两侧各验一次：装置必须开「完全访问」（mode=full），因为这是写操作。

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081";
const pythonSchemas = new Map<string, { toolset: string; tool: string; schema: Record<string, any>; discoveredAt: number }>();
const editorSchemas = new Map<string, { discoveredAt: number; schemas: unknown }>();

function structured(result: any): any {
  if (result?.structuredContent) return result.structuredContent;
  for (const block of result?.content ?? []) {
    if (block.type !== "text") continue;
    try { return JSON.parse(block.text); } catch { /* Text-only discovery is handled separately. */ }
  }
  return null;
}

function textOf(result: any): string {
  return (result?.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
}

const NEXT_STEP: Record<string, string> = {
  no_device_registered: "使用者的 Eimu 桌面端没有连上。请对方打开 Eimu 桌面端并登录，开启本机桥接与「完全访问」。",
  device_offline: "使用者的 Eimu 桌面端离线了。请对方打开桌面端后再试。",
  permission_denied: "UE 联动是写操作，需要使用者在 Eimu 桌面端把本机权限切到「完全访问」。",
  device_timeout: "UE 编辑器在时限内没有回应（可能卡在导入／编译）。先 tools/list 确认编辑器仍在线，再决定是否重试；不要连续重复同一个写操作。",
};

export default tool({
  description:
    "驱动使用者本机的 Unreal Editor（已在 UE 5.9.0 实测：官方 Unreal MCP 经 Eimu 桌面端本机桥中继），做游戏关卡时用。" +
    "用法：① method=tools/list 看 UE 暴露的元工具（list_toolsets／describe_toolsets／describe_tools／call_tool）；" +
    "② name=list_toolsets 看工具集，name=describe_toolsets 取工具名与 schema；" +
    "③ name=call_tool，arguments={toolset_name, tool_name, arguments} 调用。" +
    "已知工具集（5.9.0）：EditorToolset.ActorToolset（改 actor 变换、标签、组件）、EditorToolset.LevelToolset（加 actor 到场景、查关卡）、" +
    "EditorToolset.AssetToolset（查找／移动／删除资产，不含导入）、EditorToolset.MaterialInstanceToolset（材质实例参数）；" +
    "editor_toolset.toolsets.python_scripting.PythonScriptingTools.execute_python 可跑 unreal Python（先调 read_me 一次）——导入 GLB 等没有现成工具的动作走它。" +
    "参数格式只信 UE 回来的 schema，禁止凭印象编字段。UE 工具在游戏线程串行执行，一次只发一个调用，等结果再发下一个。" +
    "回执 is_error=true 表示 UE 工具本身报错（照原文修参数），不是链路坏了。" +
    "action=discover_editor 按当前编辑器身份和版本发现并缓存关卡、资产、Python与截图schema（五分钟）；读回对账用 action=verify_world，传设计阶段确定的 world_plan 和资产清单 assets；不允许从当前 actor 倒推计划。" +
    "截图使用运行时发现的 SceneCaptureToolset.Capture（显式 camera、Lit 模式）或 CaptureEditorViewport；旋转必须写 pitch/yaw/roll，Python Rotator 使用具名参数，不能猜位置参数轴序。" +
    "前提：使用者开着 Eimu 桌面端（完全访问）且 UE 5.9 已启用 Unreal MCP＋All Toolsets 插件并执行 ModelContextProtocol.StartServer；不满足时回执会写明缺哪一步，照原文转告使用者，不要假装已放好。",
  args: {
    action: tool.schema.enum(["verify_world", "discover_editor"]).optional().describe("verify_world 核对设计计划与真实资产；discover_editor 返回当前版本的运行时schema缓存。"),
    world_plan: tool.schema.record(tool.schema.string(), tool.schema.any()).optional().describe("独立设计文档中的 world_plan；缺失时不能宣称 G2 通过。"),
    assets: tool.schema.array(tool.schema.record(tool.schema.string(), tool.schema.any())).optional().describe("资产清单：id/local_path/ue_asset_paths/source/sha256/triangles/cost_coins。"),
    method: tool.schema.enum(["tools/list", "tools/call"]).optional().describe("MCP 方法；未指定 action 时必填。"),
    name: tool.schema.string().optional().describe("tools/call 的工具名（如 list_toolsets／describe_toolsets／call_tool，或 UE 列出的具体工具名）。"),
    arguments: tool.schema
      .record(tool.schema.string(), tool.schema.any())
      .optional()
      .describe("tools/call 的参数对象，字段以 UE 回来的 inputSchema 为准。"),
    cursor: tool.schema.string().optional().describe("tools/list 分页游标（UE 回了 nextCursor 时才用）。"),
    port: tool.schema.number().int().min(1024).max(65535).optional().describe("UE MCP 端口，预设 8000（使用者改过才填）。"),
    timeout_seconds: tool.schema.number().int().min(5).max(600).optional().describe("单次等待上限，预设 180 秒；大批量导入可放宽。"),
  },
  async execute(args, context) {
    if (!args.action && !args.method) return fail("bad_request", "需要 method 或 action=verify_world。");
    if (args.action) {
      const invoke = async (method: string, name?: string, parameters?: Record<string, unknown>) => {
        const response = await fetch(`${GATEWAY}/internal/device/invoke?session_id=${encodeURIComponent(context.sessionID)}`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ op: "ue_mcp", method, ...(name ? { name, arguments: parameters ?? {} } : {}),
            ...(args.port ? { port: args.port } : {}), ...(args.timeout_seconds ? { timeout_ms: args.timeout_seconds * 1000 } : {}) }),
          signal: context.abort,
        });
        const data: any = await response.json();
        if (!response.ok || !data.ok || data.result?.ok === false || data.result?.result?.isError) {
          throw new Error(data.error?.message ?? data.result?.error?.message ?? textOf(data.result?.result) ?? `HTTP ${response.status}`);
        }
        if (data.truncated || data.result?.result?.eimu_compacted) throw new Error("UE 核验回执不完整，不能判为通过。");
        return data.result;
      };
      try {
        // Live top-level discovery also binds the cache to the observed editor version and this caller.
        const top = await invoke("tools/list");
        const names = new Set((top.result?.tools ?? []).map((entry: any) => entry.name));
        if (!names.has("list_toolsets") || !names.has("describe_toolsets") || !names.has("call_tool")) {
          return fail("ue_schema_unsupported", "当前编辑器没有声明核验所需的工具发现入口；保留未知，不猜协议。");
        }
        const cacheable = typeof top.server?.name === "string" && !!top.server.name && typeof top.server?.version === "string" && !!top.server.version;
        const key = `${context.sessionID}:${args.port ?? 8000}:${JSON.stringify(top.server)}`;
        if (args.action === "discover_editor") {
          let cached = cacheable ? editorSchemas.get(key) : undefined;
          if (!cached || Date.now() - cached.discoveredAt > 5 * 60_000) {
            const listing = await invoke("tools/call", "list_toolsets", {});
            const toolsets = [...textOf(listing.result).matchAll(/^- ([^:\n]+):/gm)].map(match => match[1]);
            const candidates = toolsets.filter(name => /python|scene.?capture/i.test(name) || /^EditorToolset\.(Actor|Level|Asset)Toolset$/.test(name));
            if (!candidates.length) return fail("ue_schema_unavailable", "编辑器未公开关卡、资产或截图工具集。");
            const described = await invoke("tools/call", "describe_toolsets", { toolset_names: candidates, include_schemas: true });
            const schemas = structured(described.result);
            if (!schemas?.toolsets || Object.keys(schemas.errors ?? {}).length) {
              return fail("ue_schema_incomplete", "编辑器schema发现不完整，不能作为调用依据。", { discovery: schemas });
            }
            cached = { discoveredAt: Date.now(), schemas };
            if (editorSchemas.size >= 64) editorSchemas.delete(editorSchemas.keys().next().value!);
            if (cacheable) editorSchemas.set(key, cached);
          }
          return ok({ title: "UE 运行时schema", server: top.server, discovered_at: new Date(cached.discoveredAt).toISOString(), expires_in_ms: Math.max(0, 5 * 60_000 - (Date.now() - cached.discoveredAt)), schemas: cached.schemas });
        }
        let python = cacheable ? pythonSchemas.get(key) : undefined;
        if (!python || Date.now() - python.discoveredAt > 5 * 60_000) {
          const listing = await invoke("tools/call", "list_toolsets", {});
          const toolsets = [...textOf(listing.result).matchAll(/^- ([^:\n]+):/gm)].map(match => match[1]);
          const candidates = toolsets.filter(name => /python/i.test(name));
          if (!candidates.length) return fail("ue_python_unavailable", "UE 没有公开 Python 工具集；请启用 Python Editor Script Plugin 与 All Toolsets。");
          const described = await invoke("tools/call", "describe_toolsets", { toolset_names: candidates, include_schemas: true });
          const describedSets = structured(described.result)?.toolsets ?? {};
          for (const [toolsetName, set] of Object.entries(describedSets) as [string, any][]) {
            const descriptor = (set.tools ?? []).find((entry: any) => entry.name?.endsWith(".execute_python") && entry.inputSchema?.properties?.script?.properties?.content?.type === "string");
            if (descriptor) {
              python = { toolset: toolsetName, tool: descriptor.name.slice(toolsetName.length + 1), schema: descriptor.inputSchema, discoveredAt: Date.now() };
              if (pythonSchemas.size >= 64) pythonSchemas.delete(pythonSchemas.keys().next().value!);
              const readMe = (set.tools ?? []).find((entry: any) => entry.name?.endsWith(".read_me"));
              if (readMe) await invoke("tools/call", "call_tool", { toolset_name: toolsetName, tool_name: readMe.name.slice(toolsetName.length + 1), arguments: {} });
              if (cacheable) pythonSchemas.set(key, python);
              break;
            }
          }
        }
        if (!python) return fail("ue_schema_unsupported", "编辑器返回的 Python schema 不支持此核验，未执行。");
        const script = buildWorldAuditPython({ world_plan: args.world_plan, assets: args.assets });
        const audited = await invoke("tools/call", "call_tool", { toolset_name: python.toolset, tool_name: python.tool, arguments: { script: { content: script, language: "Python" } } });
        return ok({ title: "UE 关卡与资产读回核验", server: audited.server, report: parseWorldAuditResult(audited.result) });
      } catch (error) {
        return fail("ue_verification_unavailable", `UE 核验未完成：${(error as Error).message}；没有证据的项目保持未知。`);
      }
    }
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
