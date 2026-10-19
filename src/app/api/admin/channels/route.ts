// 渠道统一调度的 admin 面：GET 回报「生产此刻会怎么路由」，PATCH 在版本闸下
// 全量替换 overrides（last-write-wins，但 expectedVersion 不符即 409 拒收，
// 附上最新完整 payload 让 UI 重载——这是丢更新防护的评审 blocker）。
//
// 安全铁则：queues 的映射只允许输出 label / host / priority 三个栏位。
// buildModelQueue 回传的端点物件带著渠道密钥，把整个端点序列化出去，
// 等于把密钥交给任何拿到 admin session 的人。host 一律过 safeEndpointHost。

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
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

/** 只回「是否存在（去空白后非空）」的布林，绝不回值。 */
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
 * SUB2API_ENABLED 三态。历史事故：这个开关曾要求原始字串精确等于 "true"，
 * 带换行/BOM/大小写的值会静默切走 sub2api。判定必须与生产队列同源
 * （sub2apiSwitchedOn）：清洗后不分大小写的 true 即生效；"1"、"yes" 之类
 * 仍属「设了但没生效」——admin 必须能一眼看出。
 */
function sub2apiEnabledState(): "true" | "set-but-not-true" | "missing" {
  if (process.env.SUB2API_ENABLED === undefined) return "missing";
  return sub2apiSwitchedOn(process.env) ? "true" : "set-but-not-true";
}

/**
 * GET 与 PATCH（成功、409）共用的完整 payload。pools 与 overrides 各读一次，
 * channels 与 queues 用同一份输入——两边各读一次就可能各说各话，正是渠道
 * 注册表要消灭的病。overrides 用 fresh 读：admin 要看的是最新版本。
 */
async function buildChannelsPayload(
  /**
   * PATCH 成功后传入刚写入的值：Blob list() 不保证写后读一致，重新 list 可能拿回
   * 旧世代，把 admin 刚保存的开关在回应里静默还原、且让下次保存拿旧 version 撞 409。
   */
  known?: { overrides: ChannelOverrides; version: string | null },
) {
  const [pools, { overrides, version }] = await Promise.all([
    readAdminPools(),
    known ? Promise.resolve(known) : readChannelOverrides({ fresh: true }),
  ]);

  const channels = describeChannels(process.env, pools, overrides);
  // 队列端点的生效优先级以 label 对回描述表。
  // 池名是自由文本，可与 env 渠道 label 撞名。Map 后写者
  // 胜，若池在后写入，env 条目会显示池的优先级——所以 env 条目最后写入，
  // 保证同名冲突时以 env 渠道的生效值为准（队列里的 env 条目数量远多于撞名池）。
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
    // 全量替换语意下，漏送 overrides 等于清空全部配置——必须是显式的物件。
    if (typeof body.overrides !== "object" || body.overrides === null || Array.isArray(body.overrides)) {
      return NextResponse.json({ success: false, message: "overrides 必须是对象。" }, { status: 400 });
    }
    if (body.expectedVersion !== null && typeof body.expectedVersion !== "string") {
      return NextResponse.json(
        { success: false, message: "expectedVersion 必须是字符串或 null。" },
        { status: 400 },
      );
    }

    // 白名单校验在路由层做（store 只管形状）：先 normalize 收敛形状，再剔除
    // 不在 overridableChannelIds 的 key——池渠道有自己的 CRUD，垃圾 key 直接丢。
    const allowed = new Set(overridableChannelIds());
    const overrides: ChannelOverrides = Object.fromEntries(
      Object.entries(normalizeChannelOverrides(body.overrides)).filter(([id]) => allowed.has(id)),
    );

    // 丢更新防护：fresh 读最新版本，不符即 409 并附最新完整 payload 让 UI 重载。
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

    // 稽核纪录：整数版本序列独立于 Blob pathname，只活在稽核表里（见 admin-audit.ts
    // 档头注解）。失败不抛错，写入本身已成功，不能因为稽核记不上而回错给前端。
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
