import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { sub2APIAdminFetch, sanitizeSub2APIError } from "@/lib/sub2api-admin";
import { sub2APIImageGroupId } from "@/lib/sub2api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * One-off remediation for accounts imported before SUB2API_IMAGE_GROUP_ID was correctly
 * set: buildCodexImportPayload() only tags group_ids at import time, so any account
 * imported while the env var was unset/invalid was created with group_ids: [] and is
 * permanently invisible to the scheduler for that group — confirmed by sub2api-vps's own
 * log: "no available accounts", excluded_account_count: 0 (the candidate pool was empty,
 * not merely unhealthy). This walks every account missing the configured group and adds
 * it via PATCH, using the same admin credential the account-pool listing already proves
 * works (GET /api/v1/admin/accounts already succeeds through it).
 *
 * Gated by a bearer token, not admin session, mirroring image-upstream-probe/route.ts.
 */

function fixToken(): string {
  return (process.env.IMAGE_UPSTREAM_PROBE_TOKEN ?? "").trim();
}

function authorized(req: NextRequest): boolean {
  const expected = fixToken();
  const actual = req.headers.get("x-image-upstream-probe") ?? "";
  if (!expected || expected.length !== actual.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const groupId = sub2APIImageGroupId(process.env);
  if (!groupId) return NextResponse.json({ error: "SUB2API_IMAGE_GROUP_ID is not a valid positive integer." }, { status: 400 });

  const listResponse = await sub2APIAdminFetch("/api/v1/admin/accounts?page=1&page_size=200&platform=openai&type=oauth&sort_by=priority&sort_order=asc&lite=true");
  const listBody = await listResponse.json().catch(() => null);
  if (!listResponse.ok) {
    return NextResponse.json({ error: sanitizeSub2APIError(listBody, listResponse.status), status: listResponse.status, raw: listBody }, { status: 502 });
  }

  const items: Array<Record<string, unknown>> = Array.isArray((listBody as { data?: { items?: unknown } })?.data?.items)
    ? ((listBody as { data: { items: unknown[] } }).data.items as Array<Record<string, unknown>>)
    : [];

  const results = [];
  for (const item of items) {
    const id = Number(item.id);
    if (!Number.isFinite(id)) continue;
    const currentGroups = Array.isArray(item.group_ids) ? item.group_ids.map(Number) : [];
    if (currentGroups.includes(groupId)) {
      const credentials = (item.credentials ?? {}) as Record<string, unknown>;
      results.push({
        id,
        name: item.name,
        action: "skipped",
        reason: "already in group",
        groupIds: currentGroups,
        authMode: credentials.auth_mode,
        agentRuntimeId: credentials.agent_runtime_id,
        source: (item.extra as Record<string, unknown> | undefined)?.source,
        credentialsStatus: item.credentials_status,
      });
      continue;
    }
    const nextGroups = [...new Set([...currentGroups, groupId])];
    // The exact verb/shape this backend expects for an account update isn't documented
    // here, so PATCH is tried first and PUT only if the route/method itself is rejected
    // (404/405) — a real validation error from either verb is reported as-is, not masked.
    let response = await sub2APIAdminFetch(`/api/v1/admin/accounts/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ group_ids: nextGroups }),
    });
    let attemptedMethod = "PATCH";
    if (response.status === 404 || response.status === 405) {
      response = await sub2APIAdminFetch(`/api/v1/admin/accounts/${id}`, {
        method: "PUT",
        body: JSON.stringify({ group_ids: nextGroups }),
      });
      attemptedMethod = "PUT";
    }
    const responseBody = await response.json().catch(() => null);
    results.push({
      id,
      name: item.name,
      action: response.ok ? "updated" : "failed",
      method: attemptedMethod,
      status: response.status,
      previousGroups: currentGroups,
      requestedGroups: nextGroups,
      response: responseBody,
    });
  }

  return NextResponse.json({ groupId, totalAccounts: items.length, results });
}
