import type { FailureClass } from "./types";

export interface ClassifiedFailure {
  failureClass: FailureClass;
  retryable: boolean;
  switchSupplier: boolean;
  quarantineSupplier: boolean;
  cooldownUntil: Date | null;
  detail: string;
  httpStatus?: number;
}

export class SupplierRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryAfter?: string | null,
    readonly responseBody?: string,
  ) {
    super(message);
    this.name = "SupplierRequestError";
  }
}

function retryAfterDate(value: string | null | undefined, now: Date): Date {
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return new Date(now.getTime() + seconds * 1000);
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime()) && parsed > now) return parsed;
  }
  return new Date(now.getTime() + 60_000);
}

function containsAny(value: string, patterns: string[]): boolean {
  return patterns.some((pattern) => value.includes(pattern));
}

export function classifySupplierFailure(error: unknown, now = new Date()): ClassifiedFailure {
  const requestError = error instanceof SupplierRequestError ? error : null;
  const status = requestError?.status;
  const detail = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
  const normalized = `${detail} ${requestError?.responseBody ?? ""}`.toLowerCase();

  if (error instanceof Error && error.name === "AbortError") {
    return { failureClass: "network", retryable: true, switchSupplier: true, quarantineSupplier: false, cooldownUntil: new Date(now.getTime() + 30_000), detail };
  }
  if (status === 451 || containsAny(normalized, ["legal_error", "content_rejected", "compliance filter"])) {
    return { failureClass: "content_rejected", retryable: false, switchSupplier: false, quarantineSupplier: false, cooldownUntil: null, detail, httpStatus: status };
  }
  if (containsAny(normalized, ["missing image output", "empty image result", "result was empty"])) {
    return { failureClass: "empty_result", retryable: true, switchSupplier: true, quarantineSupplier: false, cooldownUntil: new Date(now.getTime() + 5 * 60_000), detail, httpStatus: status };
  }
  if (containsAny(normalized, ["failed to download image", "artifact download failed", "output download failed"])) {
    return { failureClass: "artifact_download", retryable: true, switchSupplier: true, quarantineSupplier: false, cooldownUntil: new Date(now.getTime() + 60_000), detail, httpStatus: status };
  }
  if (normalized.includes("malformed image") || normalized.includes("undecodable image")) {
    return { failureClass: "malformed_output", retryable: true, switchSupplier: true, quarantineSupplier: false, cooldownUntil: new Date(now.getTime() + 5 * 60_000), detail, httpStatus: status };
  }
  if (status === 401 || status === 403 || containsAny(normalized, ["invalid api key", "invalid_api_key", "unauthorized", "token expired"])) {
    return { failureClass: "authentication", retryable: true, switchSupplier: true, quarantineSupplier: true, cooldownUntil: null, detail, httpStatus: status };
  }
  if (status === 429 || containsAny(normalized, ["rate limit", "too many requests"])) {
    return { failureClass: "rate_limited", retryable: true, switchSupplier: true, quarantineSupplier: false, cooldownUntil: retryAfterDate(requestError?.retryAfter, now), detail, httpStatus: status };
  }
  if (status === 402 || containsAny(normalized, ["quota exhausted", "insufficient quota", "insufficient_quota", "credit balance"])) {
    return { failureClass: "quota_exhausted", retryable: true, switchSupplier: true, quarantineSupplier: true, cooldownUntil: null, detail, httpStatus: status };
  }
  if (status === 408 || (status !== undefined && status >= 500) || containsAny(normalized, ["system under load", "overloaded", "service unavailable", "temporarily unavailable"])) {
    return { failureClass: "overloaded", retryable: true, switchSupplier: true, quarantineSupplier: false, cooldownUntil: new Date(now.getTime() + 30_000), detail, httpStatus: status };
  }
  if (status === 400 || status === 422 || containsAny(normalized, ["invalid prompt", "invalid image", "unsupported size", "invalid size", "reference image", "content policy", "moderation_blocked"])) {
    const content = containsAny(normalized, ["content policy", "moderation", "safety"]);
    return { failureClass: content ? "content_rejected" : "user_input", retryable: false, switchSupplier: false, quarantineSupplier: false, cooldownUntil: null, detail, httpStatus: status };
  }
  if (status === 404 || containsAny(normalized, ["model not found", "model_not_found", "unsupported model", "does not support"])) {
    return { failureClass: "model_unsupported", retryable: false, switchSupplier: false, quarantineSupplier: false, cooldownUntil: null, detail, httpStatus: status };
  }
  if (containsAny(normalized, ["econnreset", "enotfound", "fetch failed", "socket hang up", "network", "timed out", "timeout"])) {
    return { failureClass: "network", retryable: true, switchSupplier: true, quarantineSupplier: false, cooldownUntil: new Date(now.getTime() + 30_000), detail, httpStatus: status };
  }
  return { failureClass: "unknown", retryable: true, switchSupplier: true, quarantineSupplier: false, cooldownUntil: new Date(now.getTime() + 30_000), detail, httpStatus: status };
}
