// Agent 对话代理层的闸道封装。
//
// 为什么 gateway 在 store 域名而不是 image 域名：nginx 只在
// https://store.tinchak0207.xyz 底下挂了 /agent/ 这组 route，
// https://image.tinchak0207.xyz 的 /agent/ 开头路径是 404 —— 打错域名等于整条对话功能不可用。
//
// 命名：站上的 GATEWAY_* env 已经指 New API 计费闸道（生图那条链），
// 这里一律用 AGENT_GATEWAY_* 前缀，避免两个「闸道」在 config 里互相污染。
//
// 为什么不用 src/lib/proxy.ts 的 makeProxy：它把使用者传来的 token 原样透传
// 给上游，而 agent 闸道要的是「验完人之后，换成服务端持有的 B 端 key」——
// 两者方向相反。若复用 makeProxy，使用者可以把任意 key 打到闸道，等于绕过
// 本站的帐号体系白嫖上游额度。

import {
  isErrorShapedPayload,
  sanitizeUpstreamMessage,
  sanitizeUpstreamValue,
  stripInternalSuccessKeys,
} from "@/lib/upstream-sanitizer";

export const AGENT_GATEWAY_DEFAULT_ORIGIN = "https://store.tinchak0207.xyz";

/** 10 秒硬超时：对话代理不该把请求挂死。 */
const AGENT_GATEWAY_TIMEOUT_MS = 10_000;

/** 取 agent 闸道 origin，去掉尾部斜线，避免组 URL 时出现双斜线。 */
export function agentGatewayOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.AGENT_GATEWAY_ORIGIN?.trim();
  return (raw || AGENT_GATEWAY_DEFAULT_ORIGIN).replace(/\/+$/, "");
}

/**
 * 对话功能是否启用。
 *
 * 预设 origin 存在时（永远有值），主要开关是 AGENT_CHAT_ENABLED !== "false"；
 * 另允许把 AGENT_GATEWAY_ORIGIN 显式设成空字串来关闭，作为逃生门。
 */
export function agentGatewayEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.AGENT_CHAT_ENABLED?.trim().toLowerCase() === "false") return false;
  const origin = env.AGENT_GATEWAY_ORIGIN?.trim();
  return origin === undefined ? true : origin.length > 0;
}

export interface AgentGatewayResponse {
  status: number;
  /** body 可被 JSON.parse 时的值；空 body / 非 JSON（如 nginx 502 页）时为 null。 */
  json: unknown;
  /** 原始 body 字串。gateway 回非 JSON 时也要透传，不能吞掉真实原因。 */
  text: string;
}

/**
 * 打一次 agent 闸道。
 *
 * 带上服务端持有的 `sk-biz-` key 作为 Bearer。key 只出现在请求头里，
 * 任何 log / 例外讯息都不准包含它 —— 这里的 fetch 失败会向上抛，
 * 由路由层统一转成不带 key 的 502，就是为了保证 key 不进任何错误输出。
 */
export async function callAgentGateway(
  path: string,
  options: { method: string; key: string; body?: unknown; form?: FormData; signal?: AbortSignal },
): Promise<AgentGatewayResponse> {
  const origin = agentGatewayOrigin();
  const url = `${origin}${path.startsWith("/") ? path : `/${path}`}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${options.key}`,
    Accept: "application/json",
  };
  let body: string | FormData | undefined;
  if (options.form) {
    // multipart：FormData 自带 boundary，不能盖 Content-Type。
    body = options.form;
  } else if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }

  // 10 秒硬超时。调用方自带 signal 时两者都要尊重，用 AbortSignal.any 合并，
  // 任一方触发都中止，避免「客户端已放弃但 fetch 还挂著」。
  const timeoutSignal = AbortSignal.timeout(AGENT_GATEWAY_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([timeoutSignal, options.signal]) : timeoutSignal;

  const response = await fetch(url, {
    method: options.method,
    headers,
    body,
    cache: "no-store",
    signal,
  });

  const text = await response.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  if (response.ok) {
    // HTTP 200 也可能是错误体（例：{"success":false,"New-Api-User":"7","model_ratio":5}）——
    // 「只看 response.ok 就透传」会漏掉这路泄漏（红队 2026-10-05 Hack 实测：键名原样外泄）。
    // 判据见 upstream-sanitizer 的 isErrorShapedPayload；判为错误形状则键名与值一并清洗。
    if (json !== null && isErrorShapedPayload(json)) {
      const safeJson = sanitizeUpstreamValue(json, { cleanKeys: true });
      return {
        status: response.status,
        json: safeJson,
        text: JSON.stringify(safeJson),
      };
    }
    // 正常成功体是功能面：逐位透传，不套清洗（呼叫方靠 json 取值）；但内部基础设施
    // 键名过同一道栏位闸（`stripInternalSuccessKeys`，与 middleware／proxy 共用 helper，
    // 避免下次再分叉）。命中才改写；未命中回原 json/text 参照，字节不变。
    if (json !== null) {
      const { value, changed } = stripInternalSuccessKeys(json);
      if (changed) {
        return { status: response.status, json: value, text: JSON.stringify(value) };
      }
    }
    return { status: response.status, json, text };
  }
  // 非 2xx：闸道／其后端会把内部实作细节（SQL 栏位名、内部头名、扫描错误）放进错误体。
  // 各 agent 路由把这个 body 原样回给浏览器（`resp.json`／`resp.text`）＝一条对外泄漏路。
  // 在**唯一**的出入点清洗，避免逐路由手写（红队 2026-10-05 实测）。
  return {
    status: response.status,
    json: json === null ? null : sanitizeUpstreamValue(json, { cleanKeys: true }),
    text: sanitizeUpstreamMessage(text) ?? text,
  };
}
