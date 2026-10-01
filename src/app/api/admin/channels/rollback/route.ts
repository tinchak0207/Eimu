// 渠道 overrides 的還原端點：POST { version } 把稽核表裡某個歷史版本的完整快照
// 寫回去。故意不繞過 channel-overrides.ts 既有的寫入路徑——還原後仍要走同一套
// Blob 世代管理/快取失效，否則會製造出一個「稽核表以為現在是舊版，但 Blob 側
// 完全没跑過寫入邏輯」的分裂狀態。
//
// 認證與 route.ts / audit/route.ts 同一套 requireAdminSession。

import { NextRequest, NextResponse } from "next/server";
import { overridableChannelIds } from "@/lib/channel-registry";
import {
  normalizeChannelOverrides,
  readChannelOverrides,
  writeChannelOverrides,
  type ChannelOverrides,
} from "@/lib/channel-overrides";
import { requireAdminSession } from "@/lib/admin-session";
import { diffJson, getConfigChangeSnapshot, nextConfigVersion, recordConfigChange } from "@/lib/admin-audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／閘道／image-data-api blob／控制面）都在矽谷，同區省一趟橫跨美國（2026-10-01 效能審計）

const CONFIG_KEY = "channel-overrides";

function errorResponse(error: unknown) {
  if (error instanceof Error && error.message === "UNAUTHORIZED") {
    return NextResponse.json({ success: false, message: "请先登录管理员后台。" }, { status: 401 });
  }
  const message = error instanceof Error ? error.message : "操作失败。";
  return NextResponse.json({ success: false, message }, { status: 500 });
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireAdminSession();

    const body = (await req.json().catch(() => null)) as { version?: unknown } | null;
    if (!body || typeof body !== "object" || typeof body.version !== "number" || !Number.isInteger(body.version)) {
      return NextResponse.json({ success: false, message: "version 必须是整数。" }, { status: 400 });
    }
    const targetVersion = body.version;

    const snapshot = await getConfigChangeSnapshot(CONFIG_KEY, targetVersion);
    if (snapshot === null) {
      // 找不到：可能是这个版本比 Postgres 稽核表启用得早，或版本号根本不存在——
      // 两种情况都不能静默 no-op，必须让调用端知道还原没有发生。
      return NextResponse.json(
        { success: false, message: `未找到版本 ${targetVersion} 的配置快照（可能早于审计功能启用，或版本号不存在）。` },
        { status: 404 },
      );
    }

    // 白名单校验同 PATCH：快照理论上已经是合法形状，但不信任历史数据，照样过一遍。
    const allowed = new Set(overridableChannelIds());
    const restored: ChannelOverrides = Object.fromEntries(
      Object.entries(normalizeChannelOverrides(snapshot)).filter(([id]) => allowed.has(id)),
    );

    const before = await readChannelOverrides({ fresh: true });
    const { version: writtenVersion } = await writeChannelOverrides(restored);

    const nextVersion = await nextConfigVersion(CONFIG_KEY);
    await recordConfigChange({
      configKey: CONFIG_KEY,
      version: nextVersion,
      actor: session.username,
      action: "rollback",
      previousVersion: targetVersion,
      diff: diffJson(before.overrides, restored),
      fullSnapshot: restored,
    });

    return NextResponse.json({ success: true, overrides: restored, overridesVersion: writtenVersion });
  } catch (error) {
    return errorResponse(error);
  }
}
