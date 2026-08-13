// GET /api/generation-jobs/[id] — customer-facing, tenant-scoped generation status.
//
// Two job-origin pipelines land here, so two auth paths are supported rather than
// picking one:
//   - biz (aggregator/API-key) jobs: tenantId `biz:${apiKey.id}`, same
//     `readBearerToken` + `authenticateBizApiKey` helpers used by
//     /api/v1/images/generations — reused as-is, not reinvented.
//   - web (session) jobs: tenantId `web:${user.id}`, same `authenticateImageUser`
//     already used by /api/generate-images, whose durable path sets
//     `Location: /api/generation-jobs/{id}` on 202 responses. Dropping this path
//     would break that already-wired redirect.
// A request presenting a `sk-biz-...` bearer token is treated as biz; anything else
// falls back to the web session check.
//
// The response is a deliberately narrow projection of GenerationJob: no
// promptCiphertext, no workflow_json, no supplier/attempt detail. Only what a
// customer needs to see their own request's outcome.
import { NextRequest, NextResponse } from "next/server";
import { readBearerToken, looksLikeBizApiKey } from "@/lib/biz-api-keys";
import { authenticateBizApiKey } from "@/lib/biz-api-key-store";
import { authenticateImageUser } from "@/lib/image-billing";
import { getGenerationJobForTenant } from "@/lib/generation-core/job-repository";
import { getOrCreateTraceId, withTraceId } from "@/lib/request-trace";
import { generationTaskProjection } from "@/lib/generation-core/task-projection";

export const runtime = "nodejs";

type TenantResolution =
  | { ok: true; tenantId: string }
  | { ok: false; status: number; message: string };

async function resolveTenant(req: NextRequest): Promise<TenantResolution> {
  const bearer = readBearerToken(req.headers.get("authorization"));
  if (bearer && looksLikeBizApiKey(bearer)) {
    const auth = await authenticateBizApiKey(bearer);
    if (!auth.ok) return { ok: false, status: auth.status, message: auth.message };
    return { ok: true, tenantId: `biz:${auth.key.id}` };
  }

  const auth = await authenticateImageUser(req.headers, 0);
  if (!auth.ok) return { ok: false, status: auth.status, message: auth.message };
  return { ok: true, tenantId: `web:${auth.user.id}` };
}

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const traceId = getOrCreateTraceId(req);
  const tenant = await resolveTenant(req);
  if (!tenant.ok) {
    return withTraceId(NextResponse.json({ error: tenant.message }, { status: tenant.status }), traceId);
  }

  const { id } = await context.params;
  const job = await getGenerationJobForTenant(id, tenant.tenantId);
  if (!job) {
    return withTraceId(NextResponse.json({ error: "Generation task was not found." }, { status: 404 }), traceId);
  }

  const body = generationTaskProjection(job, { includePrompt: true });

  return withTraceId(NextResponse.json(body, { headers: { "Cache-Control": "no-store" } }), traceId);
}
