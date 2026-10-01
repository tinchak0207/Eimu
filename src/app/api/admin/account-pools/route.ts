import { NextResponse } from "next/server";
import { applyRecentAccountFailures, mapSub2APIAccounts, recentAccountFailureFromOps, sanitizeSub2APIError, shouldDeleteSub2APIAccount, sub2APIAdminFetch, type RecentAccountFailure } from "@/lib/sub2api-admin";
import { requireAdminSession } from "@/lib/admin-session";
import { inferSupportedModels } from "@/lib/admin-pools";
import { describeEnvChannels, probeSub2APIGateway, sub2APIImageGroupId } from "@/lib/sub2api";
import { getRuntimeChannelOverrides } from "@/lib/channel-overrides";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／閘道／image-data-api blob／控制面）都在矽谷，同區省一趟橫跨美國（2026-10-01 效能審計）

export async function GET() {
  try {
    await requireAdminSession();
    const response = await sub2APIAdminFetch("/api/v1/admin/accounts?page=1&page_size=100&platform=openai&type=oauth&sort_by=priority&sort_order=asc&lite=true");
    const body = await response.json().catch(() => null);
    if (!response.ok) return NextResponse.json({ success: false, message: sanitizeSub2APIError(body, response.status) }, { status: 502 });
    const accounts = mapSub2APIAccounts(body);
    const failures = await Promise.all(accounts.items.map(async (account) => {
      try {
        const errorResponse = await sub2APIAdminFetch(`/api/v1/admin/ops/upstream-errors?account_id=${account.id}&page=1&page_size=1`);
        if (!errorResponse.ok) return null;
        return recentAccountFailureFromOps(await errorResponse.json().catch(() => null), account.id);
      } catch {
        return null;
      }
    }));
    accounts.items = applyRecentAccountFailures(accounts.items, failures.filter((failure): failure is RecentAccountFailure => failure !== null));
    const deletedAccountIds = new Set((await Promise.all(accounts.items
      .filter(shouldDeleteSub2APIAccount)
      .map(async (account) => {
        try {
          const deleteResponse = await sub2APIAdminFetch(`/api/v1/admin/accounts/${account.id}`, { method: "DELETE" });
          return deleteResponse.ok || deleteResponse.status === 404 ? account.id : null;
        } catch {
          return null;
        }
      }))).filter((id): id is number => id !== null));
    if (deletedAccountIds.size) {
      accounts.items = accounts.items.filter((account) => !deletedAccountIds.has(account.id));
      accounts.total = Math.max(0, accounts.total - deletedAccountIds.size);
    }
    // 診斷用與生產隊列完全相同的生效判定：describeEnvChannels 給出 sub2api 的配置
    // 與預設狀態，override.enabled ?? defaultEnabled 就是 buildModelQueue 的取捨——
    // 兩個方向都要如實：admin 停用後這裡不得宣稱生效（舊病），admin 在
    // SUB2API_ENABLED 非 true 時強制啟用後，這裡也不得宣稱未配置（強制啟用時
    // 生產真的在燒這批賬號）。
    const overrides = await getRuntimeChannelOverrides();
    const sub2apiChannel = describeEnvChannels(process.env).find((channel) => channel.label === "sub2api");
    const sub2apiOverride = overrides["env:sub2api"] ?? {};
    const sub2apiEffectivelyEnabled = sub2apiOverride.enabled ?? sub2apiChannel?.defaultEnabled ?? false;
    const sub2apiDisabledByOverride = sub2apiOverride.enabled === false;
    const sub2apiEnabledByOverride = sub2apiOverride.enabled === true && !(sub2apiChannel?.defaultEnabled ?? false);
    const generationEndpoint = sub2apiEffectivelyEnabled ? sub2apiChannel?.endpoint ?? undefined : undefined;
    const groupId = sub2APIImageGroupId(process.env);
    const authenticated = generationEndpoint ? await probeSub2APIGateway(generationEndpoint) : false;
    const schedulableAccounts = groupId
      ? accounts.items.filter((account) => account.groupIds.includes(groupId) && account.status === "active" && account.schedulable)
      : [];
    return NextResponse.json({
      success: true,
      data: {
        ...accounts,
        routing: {
          configured: Boolean((sub2apiChannel?.configured ?? false) && groupId),
          authenticated,
          enabled: Boolean(generationEndpoint && groupId && authenticated && schedulableAccounts.length),
          disabledByOverride: sub2apiDisabledByOverride,
          enabledByOverride: sub2apiEnabledByOverride,
          reason: sub2apiDisabledByOverride
            ? "sub2api 已在路由调度中被停用"
            : sub2apiEnabledByOverride
              ? "sub2api 由路由调度强制启用（SUB2API_ENABLED 未开启）"
              : null,
          groupId,
          schedulableAccounts: schedulableAccounts.length,
          supportedModels: generationEndpoint ? inferSupportedModels(generationEndpoint) : [],
        },
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return NextResponse.json({ success: false, message: "请先登录管理员后台。" }, { status: 401 });
    }
    const message = error instanceof Error && error.message === "SUB2API_NOT_CONFIGURED"
      ? "Sub2API 管理连接尚未配置。"
      : "无法读取 Sub2API 账号池。";
    return NextResponse.json({ success: false, message }, { status: 503 });
  }
}
