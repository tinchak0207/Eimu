// Agent 對話代理層的閘道封裝。
//
// 為什麼 gateway 在 store 域名而不是 image 域名：nginx 只在
// https://store.tinchak0207.xyz 底下掛了 /agent/ 這組 route，
// https://image.tinchak0207.xyz 的 /agent/ 開頭路徑是 404 —— 打錯域名等於整條對話功能不可用。
//
// 命名：站上的 GATEWAY_* env 已經指 New API 計費閘道（生圖那條鏈），
// 這裡一律用 AGENT_GATEWAY_* 前綴，避免兩個「閘道」在 config 裡互相污染。
//
// 為什麼不用 src/lib/proxy.ts 的 makeProxy：它把使用者傳來的 token 原樣透傳
// 給上游，而 agent 閘道要的是「驗完人之後，換成服務端持有的 B 端 key」——
// 兩者方向相反。若復用 makeProxy，使用者可以把任意 key 打到閘道，等於繞過
// 本站的帳號體系白嫖上游額度。

export const AGENT_GATEWAY_DEFAULT_ORIGIN = "https://store.tinchak0207.xyz";

/** 10 秒硬超時：對話代理不該把請求掛死。 */
const AGENT_GATEWAY_TIMEOUT_MS = 10_000;

/** 取 agent 閘道 origin，去掉尾部斜線，避免組 URL 時出現雙斜線。 */
export function agentGatewayOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.AGENT_GATEWAY_ORIGIN?.trim();
  return (raw || AGENT_GATEWAY_DEFAULT_ORIGIN).replace(/\/+$/, "");
}

/**
 * 對話功能是否啟用。
 *
 * 預設 origin 存在時（永遠有值），主要開關是 AGENT_CHAT_ENABLED !== "false"；
 * 另允許把 AGENT_GATEWAY_ORIGIN 顯式設成空字串來關閉，作為逃生門。
 */
export function agentGatewayEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.AGENT_CHAT_ENABLED?.trim().toLowerCase() === "false") return false;
  const origin = env.AGENT_GATEWAY_ORIGIN?.trim();
  return origin === undefined ? true : origin.length > 0;
}

export interface AgentGatewayResponse {
  status: number;
  /** body 可被 JSON.parse 時的值；空 body / 非 JSON（如 nginx 502 頁）時為 null。 */
  json: unknown;
  /** 原始 body 字串。gateway 回非 JSON 時也要透傳，不能吞掉真實原因。 */
  text: string;
}

/**
 * 打一次 agent 閘道。
 *
 * 帶上服務端持有的 `sk-biz-` key 作為 Bearer。key 只出現在請求頭裡，
 * 任何 log / 例外訊息都不准包含它 —— 這裡的 fetch 失敗會向上拋，
 * 由路由層統一轉成不帶 key 的 502，就是為了保證 key 不進任何錯誤輸出。
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
    // multipart：FormData 自帶 boundary，不能蓋 Content-Type。
    body = options.form;
  } else if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }

  // 10 秒硬超時。調用方自帶 signal 時兩者都要尊重，用 AbortSignal.any 合併，
  // 任一方觸發都中止，避免「客戶端已放棄但 fetch 還掛著」。
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
  return { status: response.status, json, text };
}
