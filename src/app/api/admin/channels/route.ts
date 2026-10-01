// 渠道統一調度的 admin 面：GET 回報「生產此刻會怎麼路由」，PATCH 在版本閘下
// 全量替換 overrides（last-write-wins，但 expectedVersion 不符即 409 拒收，
// 附上最新完整 payload 讓 UI 重載——這是丟更新防護的評審 blocker）。
//
// 安全鐵則：queues 的映射只允許輸出 label / host / priority 三個欄位。
// buildModelQueue 回傳的端點物件帶著渠道密鑰，把整個端點序列化出去，
// 等於把密鑰交給任何拿到 admin session 的人。host 一律過 safeEndpointHost。

import { NextRequest, NextResponse } from "next/server";
import {
  buildModelQueue,
  describeChannels,
  overridableChannelIds,
  safeEndpointHost,
} from "@/lib/channel-registry";
import {
  normalizeChannelOverrides,
  readChannelOverrides,
  writeChannelOverrides,
  type ChannelOverrides,
} from "@/lib/channel-overrides";
import { readAdminPools } from "@/lib/admin-pool-store";
import { requireAdminSession } from "@/lib/admin-session";
import { diffJson, nextConfigVersion, recordConfigChange } from "@/lib/admin-audit";
import { sub2apiSwitchedOn } from "@/lib/sub2api";
import { SUPPORTED_IMAGE_MODEL_IDS } from "@/lib/image-model-ids.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／閘道／image-data-api blob／控制面）都在矽谷，同區省一趟橫跨美國（2026-10-01 效能審計）

/** 只回「是否存在（去空白後非空）」的布林，絕不回值。 */
const ENV_PRESENCE_KEYS = [
  "SUB2API_ENABLED",
  "SUB2API_BASE_URL",
  "SUB2API_API_KEY",
  "SUB2API_IMAGE_GROUP_ID",
  "SUB2API_ADMIN_BASE_URL",
  "SUB2API_ADMIN_API_KEY",
  "IMAGE_API_BASE_URL",
  "IMAGE_API_KEY",
  "IMAGE_API_BASE_URL_FALLBACK",
  "IMAGE_API_KEY_FALLBACK",
  "ADOBE2API_ENABLED",
  "ADOBE2API_BASE_URL",
  "ADOBE2API_API_KEY",
  "GATEWAY_BASE_URL",
  "GATEWAY_ADMIN_ACCESS_TOKEN",
  "GATEWAY_ADMIN_USER_ID",
  "BLOB_READ_WRITE_TOKEN",
] as const;

interface QueueEntry {
  label: string;
  host: string;
  priority?: number;
}

/**
 * SUB2API_ENABLED 三態。歷史事故：這個開關曾要求原始字串精確等於 "true"，
 * 帶換行/BOM/大小寫的值會靜默切走 sub2api。判定必須與生產隊列同源
 * （sub2apiSwitchedOn）：清洗後不分大小寫的 true 即生效；"1"、"yes" 之類
 * 仍屬「設了但沒生效」——admin 必須能一眼看出。
 */
function sub2apiEnabledState(): "true" | "set-but-not-true" | "missing" {
  if (process.env.SUB2API_ENABLED === undefined) return "missing";
  return sub2apiSwitchedOn(process.env) ? "true" : "set-but-not-true";
}

/**
 * GET 與 PATCH（成功、409）共用的完整 payload。pools 與 overrides 各讀一次，
 * channels 與 queues 用同一份輸入——兩邊各讀一次就可能各說各話，正是渠道
 * 註冊表要消滅的病。overrides 用 fresh 讀：admin 要看的是最新版本。
 */
async function buildChannelsPayload(
  /**
   * PATCH 成功後傳入剛寫入的值：Blob list() 不保證寫後讀一致，重新 list 可能拿回
   * 舊世代，把 admin 剛保存的開關在回應裡靜默還原、且讓下次保存拿舊 version 撞 409。
   */
  known?: { overrides: ChannelOverrides; version: string | null },
) {
  const [pools, { overrides, version }] = await Promise.all([
    readAdminPools(),
    known ? Promise.resolve(known) : readChannelOverrides({ fresh: true }),
  ]);

  const channels = describeChannels(process.env, pools, overrides);
  // 隊列端點的生效優先級以 label 對回描述表。
  // 池名是自由文本，可與 env 渠道 label 撞名。Map 後寫者
  // 勝，若池在後寫入，env 條目會顯示池的優先級——所以 env 條目最後寫入，
  // 保證同名衝突時以 env 渠道的生效值為準（隊列裡的 env 條目數量遠多於撞名池）。
  const priorityByLabel = new Map<string, number>();
  for (const channel of channels.filter((item) => item.kind === "pool")) {
    priorityByLabel.set(channel.label, channel.priority);
  }
  for (const channel of channels.filter((item) => item.kind !== "pool")) {
    priorityByLabel.set(channel.label, channel.priority);
  }

  const queues: Record<string, QueueEntry[]> = {};
  for (const modelId of SUPPORTED_IMAGE_MODEL_IDS) {
    queues[modelId] = buildModelQueue(modelId, process.env, pools, overrides).map((endpoint) => {
      const priority =
        priorityByLabel.get(endpoint.label) ?? priorityByLabel.get(endpoint.label.replace(/-\d+$/, ""));
      return {
        label: endpoint.label,
        host: safeEndpointHost(endpoint.baseURL),
        ...(priority !== undefined ? { priority } : {}),
      };
    });
  }

  const envPresence: Record<string, boolean> = {};
  for (const key of ENV_PRESENCE_KEYS) {
    envPresence[key] = Boolean(process.env[key]?.trim());
  }

  return {
    channels,
    queues,
    overrides,
    overridesVersion: version,
    storage: process.env.BLOB_READ_WRITE_TOKEN ? ("blob" as const) : ("memory" as const),
    envPresence,
    sub2apiEnabledState: sub2apiEnabledState(),
    dangerFlags: {
      mockMode: process.env.ENABLE_MOCK_MODE === "true",
      localTestMode: process.env.NEXT_PUBLIC_LOCAL_TEST_MODE === "true",
    },
    propagationNote:
      "保存后本实例立即生效；其他温实例的配置缓存最长 15 秒后刷新，期间可能仍按旧配置调度。",
  };
}

function errorResponse(error: unknown) {
  if (error instanceof Error && error.message === "UNAUTHORIZED") {
    return NextResponse.json({ success: false, message: "请先登录管理员后台。" }, { status: 401 });
  }
  const message = error instanceof Error ? error.message : "操作失败。";
  return NextResponse.json({ success: false, message }, { status: 500 });
}

export async function GET() {
  try {
    await requireAdminSession();
    return NextResponse.json(await buildChannelsPayload());
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const session = await requireAdminSession();

    const body = (await req.json().catch(() => null)) as
      | { overrides?: unknown; expectedVersion?: unknown }
      | null;
    if (!body || typeof body !== "object") {
      return NextResponse.json({ success: false, message: "请求体必须是 JSON 对象。" }, { status: 400 });
    }
    // 全量替換語意下，漏送 overrides 等於清空全部配置——必須是顯式的物件。
    if (typeof body.overrides !== "object" || body.overrides === null || Array.isArray(body.overrides)) {
      return NextResponse.json({ success: false, message: "overrides 必须是对象。" }, { status: 400 });
    }
    if (body.expectedVersion !== null && typeof body.expectedVersion !== "string") {
      return NextResponse.json(
        { success: false, message: "expectedVersion 必须是字符串或 null。" },
        { status: 400 },
      );
    }

    // 白名單校驗在路由層做（store 只管形狀）：先 normalize 收斂形狀，再剔除
    // 不在 overridableChannelIds 的 key——池渠道有自己的 CRUD，垃圾 key 直接丟。
    const allowed = new Set(overridableChannelIds());
    const overrides: ChannelOverrides = Object.fromEntries(
      Object.entries(normalizeChannelOverrides(body.overrides)).filter(([id]) => allowed.has(id)),
    );

    // 丟更新防護：fresh 讀最新版本，不符即 409 並附最新完整 payload 讓 UI 重載。
    const { overrides: previousOverrides, version: currentVersion } = await readChannelOverrides({ fresh: true });
    if (body.expectedVersion !== currentVersion) {
      return NextResponse.json(
        {
          ...(await buildChannelsPayload()),
          success: false,
          message: "渠道配置已被其他会话更新，页面数据已刷新，请确认后重新保存。",
        },
        { status: 409 },
      );
    }

    const { version: writtenVersion } = await writeChannelOverrides(overrides);

    // 稽核紀錄：整數版本序列獨立於 Blob pathname，只活在稽核表裡（見 admin-audit.ts
    // 檔頭註解）。失敗不拋錯，寫入本身已成功，不能因為稽核記不上而回錯給前端。
    const auditVersion = await nextConfigVersion("channel-overrides");
    await recordConfigChange({
      configKey: "channel-overrides",
      version: auditVersion,
      actor: session.username,
      action: "update",
      previousVersion: auditVersion > 1 ? auditVersion - 1 : null,
      diff: diffJson(previousOverrides, overrides),
      fullSnapshot: overrides,
    });

    return NextResponse.json(await buildChannelsPayload({ overrides, version: writtenVersion }));
  } catch (error) {
    return errorResponse(error);
  }
}
