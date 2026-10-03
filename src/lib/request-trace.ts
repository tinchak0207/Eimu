// Request-scoped trace id so a customer has something stable to hand to support
// when a generation call fails. If the client already sends its own request id
// (many aggregator platforms and SDKs do, to correlate their own logs), we trust
// and echo it back — but only if it looks like a plausible id, so an attacker
// can't smuggle arbitrary header content into logs/responses under this key.

export const TRACE_ID_HEADER = "X-Request-Id";
const INBOUND_TRACE_ID_HEADER = "x-request-id";

/** Conservative allowlist: alnum plus `. _ -`, 8-128 chars. */
const TRACE_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;

type HeadersSource = Headers | { headers: Headers };

/**
 * True for ids this module is willing to trust as an inbound `X-Request-Id`.
 * Exported so downstream helpers (generation request headers) reuse the exact
 * same rule instead of re-implementing a second allowlist.
 */
export function isValidTraceId(value: string): boolean {
  return TRACE_ID_PATTERN.test(value);
}

/**
 * Fresh trace id. Prefers the Web Crypto global (`globalThis.crypto.randomUUID`,
 * present in Node 18+ and every browser) rather than importing `node:crypto`, so
 * this module stays importable from client components too — the R5 generation
 * header helper is shared by server routes and the browser bundle.
 */
function randomTraceId(): string {
  const webCrypto = (globalThis as { crypto?: Crypto }).crypto;
  if (webCrypto && typeof webCrypto.randomUUID === "function") return webCrypto.randomUUID();
  throw new Error("crypto.randomUUID is unavailable in this runtime");
}

function resolveHeaders(source: HeadersSource): Headers {
  return source instanceof Headers ? source : source.headers;
}

/**
 * Reads an inbound `X-Request-Id` if present and well-formed, otherwise
 * generates a fresh one via `randomUUID()`. Accepts either a `Headers`
 * instance directly or anything with a `.headers` property (e.g. `NextRequest`).
 */
export function getOrCreateTraceId(headersOrRequest: HeadersSource): string {
  const headers = resolveHeaders(headersOrRequest);
  const inbound = headers.get(INBOUND_TRACE_ID_HEADER)?.trim();
  if (inbound && TRACE_ID_PATTERN.test(inbound)) return inbound;
  return randomTraceId();
}

/**
 * Returns a copy of `response` with `X-Request-Id` set. Works with both plain
 * `Response` and `NextResponse` (a `Response` subclass) — the clone comes back
 * as a plain `Response`, which Next.js route handlers accept just as well.
 *
 * Cloning rather than mutating: `Response.headers` is technically mutable in
 * most runtimes, but Next.js sometimes returns responses with immutable header
 * guards (e.g. ones already handed to the platform), so mutation is not reliable.
 */
export function withTraceId(response: Response, traceId: string): Response {
  const headers = new Headers(response.headers);
  headers.set(TRACE_ID_HEADER, traceId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
