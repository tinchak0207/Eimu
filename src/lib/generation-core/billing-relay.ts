import { createHmac, timingSafeEqual } from "node:crypto";
import { ImageBillingGatewayError, ImageBillingRevertedError, refundImageQuota, reserveImageQuota } from "@/lib/image-billing";

export type BillingRelayOperation = "reserve" | "refund";

export type BillingRelayRequest = {
  jobId: string;
  operation: BillingRelayOperation;
  userId: number;
  amount: number;
};

export type GenerationBillingAdjustment = BillingRelayRequest;

export type GenerationBillingAdapter = {
  reserve(input: GenerationBillingAdjustment): Promise<void>;
  refund(input: GenerationBillingAdjustment): Promise<void>;
};

const MAX_RELAY_CLOCK_SKEW_MS = 5 * 60_000;

function hmac(secret: string, timestamp: string, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

export function signBillingRelayRequest(secret: string, timestamp: string, rawBody: string): string {
  return `sha256=${hmac(secret, timestamp, rawBody)}`;
}

export function verifyBillingRelayRequest(input: {
  secret: string;
  timestamp: string | null;
  signature: string | null;
  rawBody: string;
  now?: number;
}): boolean {
  if (!input.timestamp || !input.signature || !input.secret) return false;
  const timestampMs = Number(input.timestamp);
  if (!Number.isFinite(timestampMs) || Math.abs((input.now ?? Date.now()) - timestampMs) > MAX_RELAY_CLOCK_SKEW_MS) return false;
  const expected = signBillingRelayRequest(input.secret, input.timestamp, input.rawBody);
  const actualBytes = Buffer.from(input.signature);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function relayConfig(env: NodeJS.ProcessEnv = process.env): { url: string; secret: string } | null {
  const url = env.GENERATION_BILLING_RELAY_URL?.trim();
  const secret = env.GENERATION_BILLING_RELAY_SECRET?.trim();
  return url && secret ? { url, secret } : null;
}

function isRelayReply(value: unknown): value is { ok?: unknown; reverted?: unknown; message?: unknown } {
  return Boolean(value) && typeof value === "object";
}

async function invokeBillingRelay(input: GenerationBillingAdjustment, config: { url: string; secret: string }): Promise<void> {
  const rawBody = JSON.stringify({
    job_id: input.jobId,
    operation: input.operation,
    user_id: input.userId,
    amount: input.amount,
  });
  const timestamp = String(Date.now());
  let response: Response;
  try {
    response = await fetch(config.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Generation-Billing-Timestamp": timestamp,
        "X-Generation-Billing-Signature": signBillingRelayRequest(config.secret, timestamp, rawBody),
      },
      body: rawBody,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    // The ledger deliberately converts transport failures to unknown rather than
    // replaying a debit or credit that the relay may already have completed.
    throw error;
  }

  const payload = await response.json().catch(() => null);
  const message = isRelayReply(payload) && typeof payload.message === "string"
    ? payload.message
    : `Billing relay ${input.operation} failed with HTTP ${response.status}.`;
  if (response.ok && isRelayReply(payload) && payload.ok === true) return;
  if (isRelayReply(payload) && payload.reverted === true) throw new ImageBillingRevertedError(message);
  throw new ImageBillingGatewayError(message, response.status, response.headers.get("retry-after"));
}

const directGenerationBilling: GenerationBillingAdapter = {
  reserve: async ({ userId, amount }) => reserveImageQuota(userId, amount),
  refund: async ({ userId, amount }) => refundImageQuota(userId, amount),
};

export function configuredGenerationBillingAdapter(env: NodeJS.ProcessEnv = process.env): GenerationBillingAdapter {
  const config = relayConfig(env);
  if (!config) return directGenerationBilling;
  return {
    reserve: (input) => invokeBillingRelay({ ...input, operation: "reserve" }, config),
    refund: (input) => invokeBillingRelay({ ...input, operation: "refund" }, config),
  };
}
