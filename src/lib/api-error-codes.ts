// Stable, documented error-code taxonomy for customer-facing API responses.
//
// This is the *external* contract: aggregator platforms and direct API customers
// parse `error.code` programmatically, so once a code ships it must never change
// meaning or disappear. Internal machinery (FailureClass, HTTP status, provider
// error strings) is free to evolve; this module is the only place that translates
// internal detail into the codes we promise to keep stable.
//
// Deliberately NOT 1:1 with FailureClass: several internal failure classes are
// customer-indistinguishable (e.g. malformed_output / empty_result / artifact_download
// are all "we tried, the generation didn't produce a usable result") and are
// collapsed onto one code rather than forcing customers to branch on distinctions
// that only matter to us operationally.
import type { FailureClass } from "./generation-core/types";

export type ApiErrorCode =
  | "invalid_request"
  | "model_unsupported"
  | "content_rejected"
  | "authentication_failed"
  | "quota_exceeded"
  | "rate_limited"
  | "upstream_overloaded"
  | "upstream_network_error"
  | "generation_failed"
  | "deadline_exceeded"
  | "cancelled"
  | "internal_error";

/**
 * Maps an internal FailureClass (src/lib/generation-core/types.ts) onto the
 * stable customer-facing ApiErrorCode taxonomy.
 *
 * The exhaustive switch + `never` assertion in the default case is load-bearing:
 * if generation-core ever adds a new FailureClass without this file being updated,
 * this function fails to typecheck instead of silently falling through to
 * "internal_error" at runtime.
 */
export function failureClassToApiErrorCode(cls: FailureClass): ApiErrorCode {
  switch (cls) {
    case "user_input":
      return "invalid_request";
    case "content_rejected":
      return "content_rejected";
    case "model_unsupported":
      return "model_unsupported";
    case "authentication":
      return "authentication_failed";
    case "quota_exhausted":
      return "quota_exceeded";
    case "rate_limited":
      return "rate_limited";
    case "overloaded":
      return "upstream_overloaded";
    case "network":
      return "upstream_network_error";
    case "malformed_output":
    case "empty_result":
    case "artifact_download":
      return "generation_failed";
    case "deadline_exceeded":
      return "deadline_exceeded";
    case "cancelled":
      return "cancelled";
    case "unknown":
      return "internal_error";
    default: {
      // Exhaustiveness guard: a new FailureClass variant lands here as a type
      // error at compile time, not a silent "internal_error" at runtime.
      const exhaustiveCheck: never = cls;
      throw new Error(`Unmapped FailureClass: ${String(exhaustiveCheck)}`);
    }
  }
}

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    trace_id: string;
  };
}

/**
 * Builds the customer-facing error envelope. Additive by design: existing
 * routes that already return an OpenAI-shaped `{ error: { message, type, code, param } }`
 * body keep that shape and merge `trace_id` in separately — this helper is for
 * call sites (new or being touched) that want the plain `{ error: { code, message, trace_id } }`
 * form directly, most notably the generation-job status endpoint.
 */
export function buildApiErrorBody(code: ApiErrorCode, message: string, traceId: string): ApiErrorBody {
  return { error: { code, message, trace_id: traceId } };
}
