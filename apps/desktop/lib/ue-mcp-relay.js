// apps/desktop/lib/ue-mcp-relay.js
//
// 装置桥的引擎联动：把云端导演下发的 MCP JSON-RPC 转给本机 UE 编辑器。
//
// 对接的是 UE 5.8 官方 Unreal MCP 插件（ModelContextProtocol＋AllToolsets）：
//   - 端点 http://127.0.0.1:<port>/mcp（预设 8000），Streamable HTTP，无鉴权、只收回环；
//   - 拒收非回环 Origin（Node fetch 不送 Origin，正好）；
//   - 工具在游戏线程上串行执行，官方要求客户端不要并发 tool call ⇒ 本档全域串行。
//   - 开 Tool Search（预设）时 tools/list 只回 list_toolsets／describe_toolset／call_tool 三个元工具。
//
// 安全边界：主机写死 127.0.0.1，端口只收 1024..65535；不收 url／host，装置桥不会被当成内网代理。
// 是否放行由呼叫端（device-bridge-client）先验「完全访问」，本档只管协议。

"use strict";

const PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_PORT = 8000;
const DEFAULT_TIMEOUT_MS = 170_000;
/** 回给云端的结果预算；超出时先把图片块换成说明，再不够才整体截断（由上层 clampResult 负责）。 */
const RESULT_BUDGET_BYTES = 240 * 1024;

class EngineRelayError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** 解析 Streamable HTTP 回应：可能是 application/json，也可能是 text/event-stream。 */
async function readRpcResponse(res, id) {
  const type = (res.headers.get("content-type") || "").toLowerCase();
  const raw = await res.text();
  if (type.includes("text/event-stream")) {
    let found = null;
    for (const frame of raw.split(/\r?\n\r?\n/)) {
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      try {
        const msg = JSON.parse(data);
        if (msg && msg.id === id && (msg.result !== undefined || msg.error !== undefined)) found = msg;
      } catch {
        /* 进度帧等非 JSON 片段跳过 */
      }
    }
    if (!found) throw new EngineRelayError("engine_bad_response", "UE MCP 事件流里没有对应的 JSON-RPC 回应");
    return found;
  }
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    throw new EngineRelayError("engine_bad_response", `UE MCP 回了非 JSON（HTTP ${res.status}）`);
  }
}

/** 把超预算的图片／音频块换成说明，避免 base64 被腰斩成坏数据。 */
function compactResult(result) {
  const size = Buffer.byteLength(JSON.stringify(result ?? null), "utf8");
  if (size <= RESULT_BUDGET_BYTES || !result || !Array.isArray(result.content)) return result;
  const content = result.content.map((block) => {
    if (block && (block.type === "image" || block.type === "audio") && typeof block.data === "string") {
      return {
        type: "text",
        text: `[${block.type} 已省略：${block.mimeType || "未知格式"}，约 ${Math.round((block.data.length * 3) / 4 / 1024)} KB，超过装置桥回传上限；请让 UE 工具把文件存盘后再取]`,
      };
    }
    return block;
  });
  return { ...result, content, eimu_compacted: true };
}

function createUeMcpRelay(deps = {}) {
  const fetchImpl = deps.fetch || globalThis.fetch;
  const clientVersion = deps.clientVersion || "0";
  /** port → { sessionId, initialized } */
  const sessions = new Map();
  let chain = Promise.resolve();
  let nextId = 1;

  function endpoint(port) {
    return `http://127.0.0.1:${port}/mcp`;
  }

  async function post(port, body, session, signal) {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (session && session.sessionId) headers["Mcp-Session-Id"] = session.sessionId;
    if (session && session.initialized) headers["MCP-Protocol-Version"] = PROTOCOL_VERSION;
    try {
      return await fetchImpl(endpoint(port), { method: "POST", headers, body: JSON.stringify(body), signal });
    } catch (err) {
      const reason = err && err.cause && err.cause.code ? err.cause.code : err && err.name ? err.name : "error";
      if (reason === "TimeoutError" || reason === "AbortError") throw new EngineRelayError("engine_timeout", "UE 编辑器在时限内没有回应");
      throw new EngineRelayError(
        "engine_unreachable",
        `连不上本机 UE 编辑器的 MCP 服务（127.0.0.1:${port}，${reason}）。请在 UE 5.8 启用 Unreal MCP 与 All Toolsets 插件，并在输出日志执行 ModelContextProtocol.StartServer`,
      );
    }
  }

  async function ensureSession(port, signal) {
    const existing = sessions.get(port);
    if (existing && existing.initialized) return existing;
    const session = { sessionId: null, initialized: false };
    const id = nextId++;
    const res = await post(
      port,
      {
        jsonrpc: "2.0",
        id,
        method: "initialize",
        params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "eimu-device-bridge", version: clientVersion } },
      },
      session,
      signal,
    );
    if (!res.ok) throw new EngineRelayError("engine_rejected", `UE MCP initialize 被拒（HTTP ${res.status}）`);
    session.sessionId = res.headers.get("mcp-session-id");
    const msg = await readRpcResponse(res, id);
    if (!msg || msg.error) throw new EngineRelayError("engine_rejected", `UE MCP initialize 失败：${msg && msg.error ? msg.error.message : "空回应"}`);
    session.server = msg.result && msg.result.serverInfo ? msg.result.serverInfo : null;
    session.initialized = true;
    const note = await post(port, { jsonrpc: "2.0", method: "notifications/initialized" }, session, signal);
    await note.text().catch(() => "");
    sessions.set(port, session);
    return session;
  }

  async function callOnce(args, signal) {
    const port = Number.isInteger(args.port) ? args.port : DEFAULT_PORT;
    const session = await ensureSession(port, signal);
    const id = nextId++;
    const params = args.method === "tools/list" ? (args.cursor ? { cursor: args.cursor } : {}) : { name: args.name, arguments: args.arguments || {} };
    const res = await post(port, { jsonrpc: "2.0", id, method: args.method, params }, session, signal);
    if (res.status === 404 && session.sessionId) {
      // 会话被编辑器回收（StopServer／重启）：丢掉缓存让上层重试一次。
      sessions.delete(port);
      throw new EngineRelayError("engine_session_expired", "UE MCP 会话已失效");
    }
    if (!res.ok) throw new EngineRelayError("engine_rejected", `UE MCP 拒绝 ${args.method}（HTTP ${res.status}）`);
    const msg = await readRpcResponse(res, id);
    if (!msg) throw new EngineRelayError("engine_bad_response", "UE MCP 回应为空");
    if (msg.error) {
      return { method: args.method, name: args.name || null, ok: false, error: { code: msg.error.code, message: String(msg.error.message || "").slice(0, 2000) }, server: session.server };
    }
    return { method: args.method, name: args.name || null, ok: true, result: compactResult(msg.result), server: session.server };
  }

  /** 串行执行（UE 工具跑在游戏线程，官方要求不要重叠调用）。 */
  function relay(args, opts = {}) {
    const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
    const run = async () => {
      const signal = AbortSignal.timeout(timeoutMs);
      try {
        return await callOnce(args, signal);
      } catch (err) {
        if (err && err.code === "engine_session_expired") return await callOnce(args, signal);
        throw err;
      }
    };
    const next = chain.then(run, run);
    chain = next.catch(() => undefined);
    return next;
  }

  return { relay, sessions };
}

module.exports = { createUeMcpRelay, EngineRelayError, compactResult, PROTOCOL_VERSION, DEFAULT_PORT };
