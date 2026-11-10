// 用户可控 URL 的出站抓取守卫（SSRF）——画布 image-proxy / format-crops / generate 共用。
//
// 立场：只认 https 公网主机；IP 字面量（含十进位/十六进位/八进位/缩写，URL 解析器会先归一成点分四段）
// 一律拒；主机名解析后每个 IP 都过禁区判断（防 A 记录指向内网）；连接钉死在已校验的 IP 上
// （防 DNS rebinding 的二次解析）；重定向手动逐跳跟随（≤3 跳），每跳重新校验，禁止 redirect:"follow"。
//
// 前提（重要）：钉 IP 靠 https.request 的自定义 lookup。若进程开了 NODE_USE_ENV_PROXY=1 / HTTPS_PROXY 一类
// 出站代理，连接走代理、域名由代理自行解析，lookup 钉 IP 对该连接无效（DNS 级校验仍在本进程做，但与代理实际
// 解析结果可能不一致）。部署此守卫的环境不得给这些出站抓取开代理；检测到 NODE_USE_ENV_PROXY 时启动期 warn 一次。
//
// IP 禁区判断逐行取自 generation-core/callback-outbox.ts（IPv4 网段数值判、IPv6 先解析 16 字节再判，
// 含 IPv4-mapped / NAT64 / 6to4 内嵌 IPv4）；该档带 DB 依赖，不能直接 import，故在此原样迁移一份。

import { request as httpsRequest } from "node:https";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Readable, Transform, pipeline } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

/** 目标不是公网 https 地址（协议/主机/解析结果/重定向不合法）。调用方据此回 400，其他错误视为上游故障。 */
export class SsrfBlockedError extends Error {}

/** 响应体（解压后）超过 maxBytes。 */
export class ImageTooLargeError extends Error {}

export const SAFE_FETCH_MAX_REDIRECTS = 3;
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

let proxyWarned = false;
function warnIfEnvProxy(): void {
  if (proxyWarned) return;
  const flag = (process.env.NODE_USE_ENV_PROXY ?? "").trim().toLowerCase();
  if (flag && flag !== "0" && flag !== "false") {
    proxyWarned = true;
    console.warn("[ssrf-guard] NODE_USE_ENV_PROXY 已开启：出站代理自行解析域名，守卫的钉 IP 对代理连接无效。");
  }
}

/**
 * 主机黑名单（字面量层）：IP 字面量（v4/v6）、localhost、内网尾缀。
 * 原样自 /api/canvas/image-proxy 与 /api/canvas/format-crops 的 isForbiddenHost（两处逐行一致）。
 */
export function isForbiddenHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return true;
  // IPv4 字面量
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  // IPv6 字面量（URL hostname 形如 [::1] 去掉中括号后含冒号）
  if (host.includes(":")) return true;
  return false;
}

function normalizeHostname(hostname: string): string {
  let host = hostname.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  while (host.endsWith(".")) host = host.slice(0, -1);
  return host;
}

function parseIpv4Octets(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value < 0 || value > 255) return null;
    octets.push(value);
  }
  return octets;
}

/** IPv4 禁区：0/8、10/8、100.64/10、127/8、169.254/16、172.16/12、192.0.0/24、192.0.2/24、192.168/16、198.18/15、198.51.100/24、203.0.113/24、>=224。 */
function isBlockedIpv4Octets(octets: readonly number[]): boolean {
  const [a, b, c] = octets;
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 192 && b === 88 && c === 99) return true; // 192.88.99.0/24（6to4 中继，已弃用）
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  return a >= 224;
}

/** IPv6 字面量 → 16 字节；解析不了返回 null（调用方 fail closed）。支持 `::` 压缩、末尾内嵌 IPv4、zone id。 */
function parseIpv6Bytes(raw: string): Uint8Array | null {
  const zoneIndex = raw.indexOf("%");
  const address = zoneIndex === -1 ? raw : raw.slice(0, zoneIndex);
  if (!address) return null;
  const halves = address.split("::");
  if (halves.length > 2) return null;

  const parseGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const groups = part.split(":");
    const out: number[] = [];
    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index];
      if (group.includes(".")) {
        if (index !== groups.length - 1) return null;
        const octets = parseIpv4Octets(group);
        if (!octets) return null;
        out.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      out.push(Number.parseInt(group, 16));
    }
    return out;
  };

  const head = parseGroups(halves[0]);
  if (!head) return null;
  const tail = halves.length === 2 ? parseGroups(halves[1]) : [];
  if (!tail) return null;

  let groups: number[];
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head, ...new Array<number>(missing).fill(0), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let index = 0; index < 8; index += 1) {
    bytes[index * 2] = (groups[index] >> 8) & 0xff;
    bytes[index * 2 + 1] = groups[index] & 0xff;
  }
  return bytes;
}

/** IPv6 里内嵌的 IPv4：::ffff:0:0/96、::/96、64:ff9b::/96（NAT64）、2002::/16（6to4）。 */
function extractEmbeddedIpv4(bytes: Uint8Array): number[] | null {
  const zeroRange = (start: number, end: number): boolean => {
    for (let index = start; index < end; index += 1) if (bytes[index] !== 0) return false;
    return true;
  };
  const ipv4At = (offset: number): number[] => [bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]];
  if (zeroRange(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) return ipv4At(12);
  if (zeroRange(0, 12)) return ipv4At(12);
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && zeroRange(4, 12)) {
    return ipv4At(12);
  }
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return ipv4At(2);
  return null;
}

/** IPv6 禁区：::、::1、fe80::/10、fc00::/7；内嵌 IPv4 的形态按 IPv4 规则判。 */
function isBlockedIpv6(address: string): boolean {
  const bytes = parseIpv6Bytes(address);
  if (!bytes) return true;
  if (bytes.every((byte) => byte === 0)) return true;
  if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return true;
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true;
  if ((bytes[0] & 0xfe) === 0xfc) return true;
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0xc0) return true; // fec0::/10 site-local
  if (bytes[0] === 0xff) return true; // ff00::/8 多播（含 ff02::1）
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) return true; // 2001::/32 Teredo
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return true; // 2001:db8::/32 文档段
  // 64:ff9b:1::/48 本地用 NAT64（RFC 8215），前缀不定、不能当公网
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && bytes[4] === 0x00 && bytes[5] === 0x01) {
    return true;
  }
  const embedded = extractEmbeddedIpv4(bytes);
  if (embedded) return isBlockedIpv4Octets(embedded);
  return false;
}

/** 任意 IP（v4/v6）是否落在禁区；不是合法 IP 也算禁止（fail closed）。 */
export function isBlockedIpAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const octets = parseIpv4Octets(address);
    return octets === null ? true : isBlockedIpv4Octets(octets);
  }
  if (family === 6) return isBlockedIpv6(address);
  return true;
}

interface ResolvedTarget {
  url: URL;
  addresses: { address: string; family: number }[];
}

/** 校验一个目标：仅 https、无凭证、非 localhost/内网尾缀/IP 字面量，DNS 解析后每个 IP 都不在禁区。 */
async function resolvePublicHttpsTarget(raw: string | URL): Promise<ResolvedTarget> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfBlockedError("url 不是合法网址");
  }
  if (url.protocol !== "https:") throw new SsrfBlockedError("仅支持 https 公网地址");
  if (url.username || url.password) throw new SsrfBlockedError("不接受带凭证的地址");
  // 只允许默认 443（URL 解析器会把显式 :443 归一成空串）。
  if (url.port !== "" && url.port !== "443") throw new SsrfBlockedError("仅支持 443 端口");
  const host = normalizeHostname(url.hostname);
  if (!host || host.endsWith(".localhost") || host === "metadata" || isForbiddenHost(host) || isIP(host) !== 0) {
    throw new SsrfBlockedError("仅支持 https 公网地址");
  }
  let records: { address: string; family: number }[];
  try {
    records = await dnsLookup(host, { all: true, verbatim: true });
  } catch {
    throw new SsrfBlockedError("主机无法解析");
  }
  if (records.length === 0 || records.some((record) => isBlockedIpAddress(record.address))) {
    throw new SsrfBlockedError("主机解析到受限网络");
  }
  return { url, addresses: records };
}

/** 单跳请求：连接钉死在已校验的 IP 上（自定义 lookup），不再让底层二次解析；响应体边读边限（解压后）大小。 */
function requestPinned(target: ResolvedTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Response> {
  const { url, addresses } = target;
  return new Promise<Response>((resolve, reject) => {
    const req = httpsRequest(
      url,
      {
        method: "GET",
        headers: { "accept-encoding": "identity", accept: "image/*,*/*;q=0.5" },
        signal,
        lookup: ((_hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) =>
          options?.all
            ? callback(null, addresses)
            : callback(null, addresses[0].address, addresses[0].family)) as never,
      },
      (incoming) => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) for (const item of value) headers.append(name, item);
          else if (value != null) headers.set(name, value);
        }
        const status = incoming.statusCode ?? 502;
        const empty = status === 204 || status === 205 || status === 304 || (status >= 300 && status < 400);
        if (empty) {
          incoming.resume();
          resolve(new Response(null, { status, headers }));
          return;
        }
        // 服务端可能无视 identity：支持 gzip/deflate/br 流式解压，其余编码直接拒。
        const coding = (headers.get("content-encoding") ?? "identity").trim().toLowerCase();
        let decoder: Transform | null = null;
        if (coding === "gzip" || coding === "x-gzip") decoder = createGunzip();
        else if (coding === "deflate") decoder = createInflate();
        else if (coding === "br") decoder = createBrotliDecompress();
        else if (coding !== "identity" && coding !== "") {
          incoming.destroy();
          reject(new Error("unsupported content-encoding"));
          return;
        }
        if (decoder) {
          headers.delete("content-encoding");
          headers.delete("content-length");
        }
        // 计数发生在解压之后：压缩炸弹同样受 maxBytes 约束；超限即销毁整条管线（连同上游连接）。
        let received = 0;
        const limiter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            received += chunk.length;
            if (received > maxBytes) callback(new ImageTooLargeError("response too large"));
            else callback(null, chunk);
          },
        });
        const stages: (NodeJS.ReadableStream | NodeJS.WritableStream)[] = decoder ? [incoming, decoder, limiter] : [incoming, limiter];
        (pipeline as unknown as (...args: unknown[]) => void)(...stages, () => {});
        resolve(new Response(Readable.toWeb(limiter) as unknown as ReadableStream, { status, headers }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/**
 * 抓取用户提供的公网 https URL（图片）。重定向手动逐跳跟随（默认 ≤3 跳），每跳（含首跳）重新做
 * 协议/主机/端口(443)/DNS 解析校验并钉住连接 IP。响应体（解压后）超过 maxBytes（默认 25MB）时流以
 * ImageTooLargeError 报错并中断上游连接。不合规抛 SsrfBlockedError；网络错误原样抛出。
 */
export async function safeFetchPublicImage(
  rawUrl: string | URL,
  init: { signal?: AbortSignal; maxRedirects?: number; maxBytes?: number } = {},
): Promise<Response> {
  warnIfEnvProxy();
  const maxBytes = init.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = init.maxRedirects ?? SAFE_FETCH_MAX_REDIRECTS;
  let current: string | URL = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const target = await resolvePublicHttpsTarget(current);
    const response = await requestPinned(target, init.signal, maxBytes);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new SsrfBlockedError("重定向地址缺失");
      try {
        current = new URL(location, target.url);
      } catch {
        throw new SsrfBlockedError("重定向地址不合法");
      }
      continue;
    }
    return response;
  }
  throw new SsrfBlockedError("重定向次数过多");
}
