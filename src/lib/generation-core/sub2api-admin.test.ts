import test from "node:test";
import assert from "node:assert/strict";

import {
  applyRecentAccountFailures,
  buildAccountImportRequest,
  buildCodexImportPayload,
  mapSub2APIAccounts,
  normalizeAccountImportResult,
  recentAccountFailureFromOps,
  sanitizeSub2APIError,
  shouldDeleteSub2APIAccount,
} from "./sub2api-admin.ts";

test("builds a bounded codex-session import without parsing or persisting tokens", () => {
  const payload = buildCodexImportPayload({
    contents: [
      JSON.stringify({ access_token: "at-secret", refresh_token: "rt-secret" }),
      JSON.stringify({ tokens: { accessToken: "at-two", refreshToken: "rt-two" } }),
    ],
    name: "  主号池  ",
    concurrency: 4,
    priority: 20,
    updateExisting: false,
  }, { SUB2API_IMAGE_GROUP_ID: "7" });

  assert.deepEqual(payload, {
    contents: [
      JSON.stringify({ access_token: "at-secret", refresh_token: "rt-secret" }),
      JSON.stringify({ tokens: { accessToken: "at-two", refreshToken: "rt-two" } }),
    ],
    name: "主号池",
    group_ids: [7],
    proxy_id: null,
    concurrency: 4,
    priority: 20,
    rate_multiplier: 1,
    load_factor: 0,
    expires_at: null,
    auto_pause_on_expired: true,
    update_existing: false,
  });
  assert.throws(() => buildCodexImportPayload({ contents: [] }), /JSON/);
  assert.throws(() => buildCodexImportPayload({ contents: ["x".repeat(2_000_001)] }), /2 MB/);
});

test("routes Sub2API data exports to the native data import endpoint", () => {
  const data = { type: "sub2api-data", version: 1, proxies: [], accounts: [{ name: "agent" }] };
  const request = buildAccountImportRequest({ contents: [JSON.stringify(data)] });

  assert.deepEqual(request, {
    path: "/api/v1/admin/accounts/data",
    payload: { data, skip_default_group_bind: false },
    format: "sub2api-data",
  });
  assert.deepEqual(normalizeAccountImportResult({
    data: { account_created: 1, account_failed: 0 },
  }, "sub2api-data"), {
    total: 1,
    created: 1,
    updated: 0,
    skipped: 0,
    failed: 0,
  });
});

test("sanitizes upstream errors without reflecting credentials", () => {
  const message = sanitizeSub2APIError({
    message: "invalid access_token at-secret refresh_token rt-secret",
    data: { token: "nested-secret" },
  }, 400);

  assert.equal(message, "Sub2API 拒绝了导入内容，请检查 JSON 格式和账号状态。");
  assert.doesNotMatch(message, /at-secret|rt-secret|nested-secret/);
  assert.equal(
    sanitizeSub2APIError({ code: "ADMIN_COMPLIANCE_ACK_REQUIRED", message: "internal" }, 403),
    "Sub2API 管理员需先完成合规确认。",
  );
});

test("maps only safe account fields from Sub2API list responses", () => {
  const result = mapSub2APIAccounts({
    code: 0,
    data: {
      total: 1,
      items: [{
        id: 7,
        name: "user@example.com",
        status: "active",
        schedulable: true,
        priority: 50,
        concurrency: 3,
        last_used_at: "2026-07-21T00:00:00Z",
        error_message: "",
        credentials: { access_token: "must-not-leak" },
        credentials_status: { has_access_token: true, has_refresh_token: true },
        group_ids: [7],
      }],
    },
  });

  assert.deepEqual(result, {
    total: 1,
    items: [{
      id: 7,
      name: "user@example.com",
      status: "active",
      schedulable: true,
      priority: 50,
      concurrency: 3,
      lastUsedAt: "2026-07-21T00:00:00Z",
      errorMessage: "",
      hasAccessToken: true,
      hasRefreshToken: true,
      authMode: "",
      groupIds: [7],
      temporaryUnschedulableUntil: null,
      recentResult: "succeeded",
      recentResultAt: "2026-07-21T00:00:00Z",
      recentFailureStatus: null,
    }],
  });
  assert.equal(JSON.stringify(result).includes("must-not-leak"), false);
});

test("uses the newest upstream result rather than configured schedulability as account status", () => {
  const accounts = mapSub2APIAccounts({
    data: {
      total: 1,
      items: [{ id: 9, name: "account", status: "active", schedulable: true, priority: 1, concurrency: 1, last_used_at: "2026-07-21T00:00:00Z", credentials_status: {} }],
    },
  }).items;
  const latestFailure = recentAccountFailureFromOps({ data: { items: [{ account_id: 9, created_at: "2026-07-22T00:00:00Z", status_code: 403 }] } }, 9);
  assert.deepEqual(applyRecentAccountFailures(accounts, latestFailure ? [latestFailure] : [])[0], {
    ...accounts[0],
    recentResult: "failed",
    recentResultAt: "2026-07-22T00:00:00Z",
    recentFailureStatus: 403,
  });
  const staleFailure = recentAccountFailureFromOps({ data: { items: [{ account_id: 9, created_at: "2026-07-20T00:00:00Z", status_code: 403 }] } }, 9);
  assert.equal(applyRecentAccountFailures(accounts, staleFailure ? [staleFailure] : [])[0].recentResult, "succeeded");
});

test("selects only terminal 402 and 403 account failures for deletion", () => {
  const account = mapSub2APIAccounts({
    data: { total: 1, items: [{ id: 9, name: "account", status: "active", schedulable: true, priority: 1, concurrency: 1, credentials_status: {} }] },
  }).items[0];

  assert.equal(shouldDeleteSub2APIAccount({ ...account, recentFailureStatus: 403 }), true);
  assert.equal(shouldDeleteSub2APIAccount({ ...account, errorMessage: "Workspace deactivated (402)" }), true);
  assert.equal(shouldDeleteSub2APIAccount({ ...account, recentFailureStatus: 429, errorMessage: "rate limited" }), false);
});

test("does not report temporarily unschedulable accounts as dispatchable", () => {
  const result = mapSub2APIAccounts({
    data: {
      total: 1,
      items: [{
        id: 8,
        name: "temporary-failure",
        status: "active",
        schedulable: true,
        priority: 1,
        concurrency: 1,
        temp_unschedulable_until: "2999-01-01T00:00:00Z",
        temp_unschedulable_reason: "Agent runtime has been deleted.",
        credentials_status: {},
      }],
    },
  });

  assert.equal(result.items[0].schedulable, false);
  assert.equal(result.items[0].errorMessage, "Agent runtime has been deleted.");
  assert.equal(result.items[0].temporaryUnschedulableUntil, "2999-01-01T00:00:00Z");
});

test("orders displayed accounts by the same Sub2API priority used for dispatch", () => {
  const result = mapSub2APIAccounts({
    data: {
      total: 2,
      items: [
        { id: 2, name: "later", status: "active", schedulable: true, priority: 50, concurrency: 1, credentials_status: {} },
        { id: 1, name: "first", status: "active", schedulable: true, priority: 1, concurrency: 1, credentials_status: {} },
      ],
    },
  });

  assert.deepEqual(result.items.map((account) => account.id), [1, 2]);
});
