// 回调投递外发（outbox）。
//
// 现状：仓库里没有任何生产代码往客户端 callback_url 投递回调 —— generation_job
// 已经有 callback_url 字段，db/migrations/001_generation_control_plane.sql 也已经建好
// callback_delivery 表，但从来没有代码写过它。这个模块补上「排队 -> 认领 -> 投递 ->
// 记录结果」这条链路，供 worker/cron 调用；job-repository.ts / scheduler.ts /
// types.ts 由其他 agent 在改，这里只新增文件、只 import 只读的共享 helper。
//
// 设计对齐 job-repository.ts 里 claimNextGenerationJob 的 CTE + FOR UPDATE SKIP
// LOCKED 认领模式，以及 completeGenerationJob / beginGenerationAttempt 的
// sql.begin 事务写法。

import { createHash, createHmac, randomUUID } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { getGenerationSql, type GenerationSql } from "./database";
import { planReplay, resolveReplayPolicy } from "./operation-registry";

type Row = Record<string, unknown>;

export type CallbackDeliveryStatus = "pending" | "delivering" | "delivered" | "dead_letter";

export interface CallbackDeliveryRow {
  id: string;
  jobId: string;
  callbackUrl: string;
  payloadJson: unknown;
  payloadHash: string;
  hmacKeyVersion: string;
  status: CallbackDeliveryStatus;
  deliveryCount: number;
  nextAttemptAt: Date;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  responseCode: number | null;
  lastError: string | null;
  createdAt: Date;
  deliveredAt: Date | null;
  updatedAt: Date;
}

/**
 * 达到此次数仍未成功，直接判死信，不再重试（等运营/客户介入排查）。
 *
 * FG-03（2026-09-23）：重放预算唯一来源是封闭 operation registry 的
 * `callback.deliver` 政策；呼叫方（含本模组的调用者）不得自带 retry 次数。
 * 这个常量改为 registry 查询结果，不再是一个独立的魔数。
 */
export const MAX_CALLBACK_DELIVERY_ATTEMPTS = resolveReplayPolicy("callback.deliver").maxReplayAttempts;

/**
 * 投递重放裁决（FG-02/03）：只有 registry 的 `callback.deliver` 政策说可以，
 * 且下一次投递序号还在预算内，才排下一次；否则进死信。
 */
export function planCallbackDeliveryReplay(nextAttemptNo: number): ReturnType<typeof planReplay> {
  return planReplay({ operation: "callback.deliver", nextAttemptNo });
}

// ─────────────────────────────────────────────────────────── row mapping

function asDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function nullableDate(value: unknown): Date | null {
  return value === null || value === undefined ? null : asDate(value);
}

function jsonValue<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

export function mapCallbackDelivery(row: Row): CallbackDeliveryRow {
  return {
    id: String(row.id),
    jobId: String(row.job_id),
    callbackUrl: String(row.callback_url),
    payloadJson: jsonValue(row.payload_json, null),
    payloadHash: String(row.payload_hash),
    hmacKeyVersion: String(row.hmac_key_version),
    status: row.status as CallbackDeliveryStatus,
    deliveryCount: Number(row.delivery_count),
    nextAttemptAt: asDate(row.next_attempt_at),
    leaseOwner: row.lease_owner === null || row.lease_owner === undefined ? null : String(row.lease_owner),
    leaseExpiresAt: nullableDate(row.lease_expires_at),
    responseCode: row.response_code === null || row.response_code === undefined ? null : Number(row.response_code),
    lastError: row.last_error === null || row.last_error === undefined ? null : String(row.last_error),
    createdAt: asDate(row.created_at),
    deliveredAt: nullableDate(row.delivered_at),
    updatedAt: asDate(row.updated_at),
  };
}

// ─────────────────────────────────────────────────────────── SSRF guard

/**
 * SSRF 防护分两层：
 *
 * 1. 入队（`enqueueCallback`）走同步的 `assertSafeCallbackUrl`：只放行 https://，
 *    并以 IP 感知的方式拒绝回环/私网/链路本地/保留地址（IPv4 按网段数值判断，
 *    IPv6 先解析成 16 字节再判，包含 `::ffff:0:0/96`、`::/96`、NAT64 `64:ff9b::/96`
 *    与 6to4 `2002::/16` 的内嵌 IPv4），`localhost` 与 `*.localhost` 一律拒绝。
 *    同步函数不做 DNS，不能在入队时就挡住「域名解析到私网」的攻击面。
 *
 * 2. 交付（`deliverCallback`）在 fetch 前走异步的 `assertDeliverableCallbackUrl`：
 *    对非 IP 字面量的域名做 `dns.lookup({all:true})`，任一解析结果落在上述禁区
 *    即拒绝，解析失败同样拒绝（fail closed）；并且 fetch 设置 `redirect: "manual"`，
 *    3xx 一律视为投递失败，不读 Location、不跟随跳转 —— 入队时校验过的 URL 在
 *    交付时被重新校验，避免 DNS rebinding 与「先存公网域名、再把 DNS 改成私网」
 *    造成的绕过。
 */

/** `dns.lookup` 结果的最小形状，供测试注入真实 resolver。 */
export interface CallbackDnsAddress {
  address: string;
  family: number;
}

export type CallbackDnsResolver = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<readonly CallbackDnsAddress[]>;

const defaultCallbackDnsResolver: CallbackDnsResolver = (hostname, options) => dnsLookup(hostname, options);

/**
 * 主机名归一化：去掉 IPv6 的方括号、转小写、去掉结尾的点。
 * `new URL("https://[::1]/cb").hostname` 返回 `"[::1]"`（带方括号），
 * 不归一化会让所有 IPv6 字面量匹配失准。
 */
function normalizeCallbackHostname(hostname: string): string {
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

/**
 * IPv4 禁区：0/8、10/8、100.64/10、127/8、169.254/16、172.16/12、
 * 192.0.0/24、192.0.2/24、192.168/16、198.18/15、198.51.100/24、
 * 203.0.113/24、以及 >=224（multicast/broadcast/reserved）。
 * 172.32.x 不在 172.16/12 内，必须放行。
 */
function isBlockedIpv4Octets(octets: readonly number[]): boolean {
  const [a, b, c] = octets;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10
  if (a === 127) return true; // 127/8
  if (a === 169 && b === 254) return true; // 169.254/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100/24
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113/24
  return a >= 224; // multicast / reserved / broadcast
}

/**
 * 把 IPv6 字面量解析成 16 个字节；解析不了返回 null（调用方按 fail closed 处理）。
 * 支持 `::` 压缩与末尾内嵌 IPv4 点分写法，并忽略 zone id（`%eth0`）。
 */
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
        // 内嵌点分 IPv4 只允许出现在最后一组。
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

/**
 * 取出 IPv6 地址里内嵌的 IPv4（若有）：
 * `::ffff:0:0/96`（IPv4-mapped）、`::/96`（IPv4-compatible，含 :: 与 ::1）、
 * NAT64 `64:ff9b::/96`、6to4 `2002::/16`。
 */
function extractEmbeddedIpv4(bytes: Uint8Array): number[] | null {
  const zeroRange = (start: number, end: number): boolean => {
    for (let index = start; index < end; index += 1) {
      if (bytes[index] !== 0) return false;
    }
    return true;
  };
  const ipv4At = (offset: number): number[] => [
    bytes[offset],
    bytes[offset + 1],
    bytes[offset + 2],
    bytes[offset + 3],
  ];

  // ::ffff:0:0/96 —— 注意必须先于 ::/96 判断（前 10 字节全 0、第 10/11 字节为 ff）。
  if (zeroRange(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) return ipv4At(12);
  // ::/96（IPv4-compatible）
  if (zeroRange(0, 12)) return ipv4At(12);
  // 64:ff9b::/96（NAT64）
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && zeroRange(4, 12)) {
    return ipv4At(12);
  }
  // 2002::/16（6to4）
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return ipv4At(2);
  return null;
}

/** IPv6 禁区：::、::1、fe80::/10、fc00::/7；内嵌 IPv4 的形态按 IPv4 规则判。 */
function isBlockedIpv6(address: string): boolean {
  const bytes = parseIpv6Bytes(address);
  if (!bytes) return true; // 解析不了 → fail closed

  if (bytes.every((byte) => byte === 0)) return true; // ::
  const isLoopback = bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1;
  if (isLoopback) return true; // ::1
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true; // fe80::/10
  if ((bytes[0] & 0xfe) === 0xfc) return true; // fc00::/7

  const embedded = extractEmbeddedIpv4(bytes);
  if (embedded) return isBlockedIpv4Octets(embedded);
  return false;
}

/** 任意 IP 字面量（v4/v6）是否落在禁区；不是合法 IP 也算禁止（fail closed）。 */
function isBlockedIpAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const octets = parseIpv4Octets(address);
    return octets === null ? true : isBlockedIpv4Octets(octets);
  }
  if (family === 6) return isBlockedIpv6(address);
  return true;
}

/**
 * 入队用的同步校验：只放行 https://，主机名按 IP 字面量做数值判断，
 * `localhost` 与 `*.localhost` 一律拒绝；普通域名原样放行（DNS 留到交付前）。
 */
export function assertSafeCallbackUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid callback URL: ${rawUrl}`);
  }
  if (url.protocol !== "https:") {
    throw new Error("Callback URL must use https://.");
  }
  const hostname = normalizeCallbackHostname(url.hostname);
  if (!hostname) {
    throw new Error(`Callback URL host is not allowed: ${url.hostname}`);
  }
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error(`Callback URL host is not allowed: ${hostname}`);
  }
  if (isIP(hostname) !== 0) {
    if (isBlockedIpAddress(hostname)) {
      throw new Error(`Callback URL host is not allowed: ${hostname}`);
    }
    return url;
  }
  return url;
}

/**
 * 交付前校验：先跑同步校验；hostname 不是 IP 字面量时用 `dns.lookup` 解析，
 * 任一结果为私网/回环/链路本地/保留地址即抛错，解析失败/无结果也抛错（fail closed）。
 * IP 字面量不重复做 DNS。`resolver` 可注入以便真实验证。
 */
export async function assertDeliverableCallbackUrl(
  rawUrl: string,
  resolver: CallbackDnsResolver = defaultCallbackDnsResolver,
): Promise<URL> {
  const url = assertSafeCallbackUrl(rawUrl);
  const hostname = normalizeCallbackHostname(url.hostname);
  if (isIP(hostname) !== 0) return url;

  let addresses: readonly CallbackDnsAddress[];
  try {
    addresses = await resolver(hostname, { all: true, verbatim: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Callback URL host could not be resolved: ${hostname} (${message})`);
  }
  if (!addresses || addresses.length === 0) {
    throw new Error(`Callback URL host resolved to no addresses: ${hostname}`);
  }
  for (const entry of addresses) {
    const address = normalizeCallbackHostname(String(entry?.address ?? ""));
    if (!address || isBlockedIpAddress(address)) {
      throw new Error(`Callback URL host resolves to a blocked address: ${hostname} -> ${address || "(empty)"}`);
    }
  }
  return url;
}

// ─────────────────────────────────────────────────────────── canonical hash + HMAC signing

/**
 * 与 crypto.ts 的 generationRequestHash 相同的规范化策略（key 排序、丢弃
 * undefined），但这里单独实现而不是直接导入它 —— generationRequestHash 是为
 * "请求去重指纹" 设计的语义，命名和用途都属于 job 幂等性，不该被回调载荷复用，
 * 以免以后两处需求分叉时互相牵连。算法保持一致即可。
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function canonicalJson(payload: unknown): string {
  return JSON.stringify(canonicalize(payload));
}

export function payloadHash(payload: unknown): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

/**
 * 可轮换的 HMAC 密钥约定：`CALLBACK_HMAC_KEY_VERSION` 指出当前应该用哪个版本
 * （例如 "v1"），对应密钥读 `CALLBACK_HMAC_SECRET_<VERSION>`（大写），例如
 * CALLBACK_HMAC_SECRET_V1。仓库里没有现成的回调签名密钥约定（admin-auth.ts 的
 * ADMIN_SESSION_SECRET 是会话签名，语义不同，没有复用），这里新建一套但保持
 * "版本号 -> 独立密钥" 的可轮换形状，投递时把用到的版本号存在
 * callback_delivery.hmac_key_version 里，换密钥不影响已入队但未投递的行。
 */
export function currentHmacKeyVersion(env: NodeJS.ProcessEnv = process.env): string {
  const version = (env.CALLBACK_HMAC_KEY_VERSION ?? "v1").trim();
  if (!version) throw new Error("CALLBACK_HMAC_KEY_VERSION must not be blank.");
  return version;
}

export function hmacSecretForVersion(version: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = `CALLBACK_HMAC_SECRET_${version.toUpperCase()}`;
  const secret = (env[key] ?? "").trim();
  if (!secret) throw new Error(`${key} is required to sign callback deliveries.`);
  return secret;
}

export function signCallbackBody(rawBody: string, keyVersion: string, env?: NodeJS.ProcessEnv): string {
  const secret = hmacSecretForVersion(keyVersion, env);
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

// ─────────────────────────────────────────────────────────── backoff

/**
 * 指数退避，封顶一小时：min(2^attempt * 5s, 1h)。attempt 传入的是失败后的
 * delivery_count（从 1 开始），attempt<=0 视为第一次退避。纯函数，方便单测
 * 覆盖增长/封顶而不用碰数据库。
 */
export function backoffSeconds(attempt: number): number {
  const normalized = Math.max(1, Math.floor(attempt));
  const seconds = 2 ** normalized * 5;
  return Math.min(seconds, 3600);
}

// ─────────────────────────────────────────────────────────── enqueue

export interface EnqueueCallbackInput {
  jobId: string;
  callbackUrl: string;
  payload: unknown;
}

/**
 * 每个 job 最多一条回调记录（表上 UNIQUE (job_id) + ON CONFLICT DO NOTHING），
 * 与「一次生成任务只回调一次」的设计保持一致 —— 重复调用是无害的 no-op，
 * 不会覆盖已经在投递/已投递的行。
 */
export async function enqueueCallback(
  input: EnqueueCallbackInput,
  sql: GenerationSql = getGenerationSql(),
): Promise<void> {
  assertSafeCallbackUrl(input.callbackUrl);
  const hash = payloadHash(input.payload);
  const keyVersion = currentHmacKeyVersion();
  // 建 delivery 行前先确认密钥存在，避免入队一条永远签不出名的回调。
  hmacSecretForVersion(keyVersion);

  await sql`
    INSERT INTO callback_delivery (
      id, job_id, callback_url, payload_json, payload_hash, hmac_key_version,
      status, next_attempt_at
    ) VALUES (
      ${randomUUID()}, ${input.jobId}, ${input.callbackUrl}, ${sql.json(input.payload as Parameters<typeof sql.json>[0])}, ${hash},
      ${keyVersion}, 'pending', now()
    )
    ON CONFLICT (job_id) DO NOTHING
  `;
}

// ─────────────────────────────────────────────────────────── claim

/**
 * 事务内认领一批到期的回调，SKIP LOCKED 避免多 worker 抢同一行阻塞；
 * 与 job-repository.ts 的 claimNextGenerationJob 用同样的 CTE + UPDATE ... FROM
 * 认领模式，只是这里一次可以认领多行。
 */
export async function claimDueCallbacks(
  workerId: string,
  limit: number,
  leaseMs: number,
  sql: GenerationSql = getGenerationSql(),
): Promise<CallbackDeliveryRow[]> {
  const rows = await sql<Row[]>`
    WITH candidate AS (
      SELECT id
      FROM callback_delivery
      WHERE status IN ('pending', 'delivering')
        AND next_attempt_at <= now()
        AND (lease_expires_at IS NULL OR lease_expires_at < now())
      ORDER BY next_attempt_at
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    )
    UPDATE callback_delivery delivery
    SET status = 'delivering', lease_owner = ${workerId},
        lease_expires_at = now() + (${leaseMs}::text || ' milliseconds')::interval,
        updated_at = now()
    FROM candidate
    WHERE delivery.id = candidate.id
    RETURNING delivery.*
  `;
  return rows.map(mapCallbackDelivery);
}

// ─────────────────────────────────────────────────────────── deliver

export interface DeliverCallbackResult {
  ok: boolean;
  responseCode?: number;
  error?: string;
}

export async function deliverCallback(
  row: CallbackDeliveryRow,
  fetchImpl: typeof fetch = fetch,
): Promise<DeliverCallbackResult> {
  // 交付前重新校验：入队之后 DNS 可能已经改指向私网，IP 字面量也在这里再过一次。
  // 校验失败绝不发起请求。
  try {
    await assertDeliverableCallbackUrl(row.callbackUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Callback URL rejected before delivery: ${message}` };
  }

  const body = canonicalJson(row.payloadJson);
  let signature: string;
  try {
    signature = signCallbackBody(body, row.hmacKeyVersion);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  try {
    const response = await fetchImpl(row.callbackUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Callback-Signature": `sha256=${signature}`,
        "X-Callback-Id": row.id,
        "X-Callback-Delivery-Count": String(row.deliveryCount + 1),
      },
      body,
      // 不跟随重定向：3xx 会指向本机/内网地址，跟随即绕过上面的校验。
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    const ok = response.status >= 200 && response.status < 300;
    if (ok) return { ok: true, responseCode: response.status };
    if (response.status >= 300 && response.status < 400) {
      // 不读 Location、不跟跳转，直接判失败。
      return {
        ok: false,
        responseCode: response.status,
        error: `Callback endpoint responded with HTTP ${response.status} redirect; redirects are not followed.`,
      };
    }
    const text = await response.text().catch(() => "");
    return { ok: false, responseCode: response.status, error: text.slice(0, 2000) || `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// ─────────────────────────────────────────────────────────── record result

export interface RecordCallbackDeliveryResultInput {
  id: string;
  ok: boolean;
  responseCode?: number;
  error?: string;
}

export async function recordCallbackDeliveryResult(
  input: RecordCallbackDeliveryResultInput,
  sql: GenerationSql = getGenerationSql(),
): Promise<void> {
  const succeeded = input.ok && input.responseCode !== undefined && input.responseCode >= 200 && input.responseCode < 300;

  if (succeeded) {
    await sql`
      UPDATE callback_delivery
      SET status = 'delivered', delivered_at = now(), response_code = ${input.responseCode ?? null},
          last_error = NULL, lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
      WHERE id = ${input.id}
    `;
    return;
  }

  const lastError = (input.error ?? "Unknown callback delivery failure.").slice(0, 2000);

  // 退避秒数取决于新的 delivery_count，这不是纯 SQL 表达式能算清楚的（backoffSeconds
  // 是一个 JS 里可单测的纯函数），所以在事务里先读出当前计数、算好下一步状态，
  // 再一次 UPDATE 写回。FOR UPDATE 防止同一行被并发 worker 同时结算两次。
  await sql.begin(async (tx) => {
    const rows = await tx<{ delivery_count: number }[]>`
      SELECT delivery_count FROM callback_delivery WHERE id = ${input.id} FOR UPDATE
    `;
    if (!rows[0]) return;
    const nextCount = Number(rows[0].delivery_count) + 1;
    // FG-02/03：刚失败的是第 nextCount 次，下一次投递的许可问 registry——
    // 不是问本模组的魔数，也不是问呼叫方传进来的任何预算。
    const replay = planCallbackDeliveryReplay(nextCount + 1);
    const deadLettered = !replay.allowed;

    if (deadLettered) {
      await tx`
        UPDATE callback_delivery
        SET delivery_count = ${nextCount}, response_code = ${input.responseCode ?? null},
            last_error = ${lastError}, status = 'dead_letter',
            lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
        WHERE id = ${input.id}
      `;
      return;
    }

    const nextAttemptAt = new Date(Date.now() + backoffSeconds(nextCount) * 1000);
    await tx`
      UPDATE callback_delivery
      SET delivery_count = ${nextCount}, response_code = ${input.responseCode ?? null},
          last_error = ${lastError}, status = 'pending', next_attempt_at = ${nextAttemptAt},
          lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
      WHERE id = ${input.id}
    `;
  });
}

// ─────────────────────────────────────────────────────────── worker loop

export interface CallbackWorkerSummary {
  delivered: number;
  failed: number;
  deadLettered: number;
}

const DEFAULT_CLAIM_BATCH = 20;
const DEFAULT_LEASE_MS = 30_000;

export async function runCallbackWorkerOnce(
  workerId: string,
  sql: GenerationSql = getGenerationSql(),
): Promise<CallbackWorkerSummary> {
  const claimed = await claimDueCallbacks(workerId, DEFAULT_CLAIM_BATCH, DEFAULT_LEASE_MS, sql);
  const summary: CallbackWorkerSummary = { delivered: 0, failed: 0, deadLettered: 0 };

  for (const row of claimed) {
    const result = await deliverCallback(row);
    await recordCallbackDeliveryResult({ id: row.id, ...result }, sql);
    if (result.ok && result.responseCode !== undefined && result.responseCode >= 200 && result.responseCode < 300) {
      summary.delivered += 1;
    } else if (!planCallbackDeliveryReplay(row.deliveryCount + 2).allowed) {
      summary.deadLettered += 1;
    } else {
      summary.failed += 1;
    }
  }

  return summary;
}
