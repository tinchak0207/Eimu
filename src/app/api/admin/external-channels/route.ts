// external-channels 的 admin 面：GET 列出所有外部上游（credential 只回「已設定/未設定」
// 旗標，永不回 raw key），POST/PUT 建立/更新，DELETE 刪除。認證照 tier-pricing/admin
// route：requireAdminSession + errorResponse(UNAUTHORIZED→401)，寫入後記錄稽核
// （diffJson + nextConfigVersion + recordConfigChange）。

import { NextRequest, NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin-session";
import { diffJson, nextConfigVersion, recordConfigChange } from "@/lib/admin-audit";
import {
  emptyExternalChannelDocument,
  normalizeExternalChannel,
  toPublicExternalChannel,
  type ExternalChannel,
  type ExternalChannelDocument,
} from "@/lib/external-channels";
import {
  invalidateExternalChannelCache,
  readExternalChannelDocument,
  writeExternalChannelDocument,
} from "@/lib/external-channels-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／閘道／image-data-api blob／控制面）都在矽谷，同區省一趟橫跨美國（2026-10-01 效能審計）

function errorResponse(error: unknown) {
  if (error instanceof Error && error.message === "UNAUTHORIZED") {
    return NextResponse.json({ success: false, message: "请先登录管理员后台。" }, { status: 401 });
  }
  const message = error instanceof Error ? error.message : "操作失败。";
  return NextResponse.json({ success: false, message }, { status: 500 });
}

/** credential 是否已設定（env 存在且非空）——絕不回 raw key。 */
function credentialConfigured(channel: ExternalChannel): boolean {
  const value = process.env[channel.credentialRef];
  return typeof value === "string" && value.trim().length > 0;
}

async function buildPayload(known?: { doc: ExternalChannelDocument; version: string | null }) {
  const { doc, version } = known
    ? known
    : await readExternalChannelDocument({ fresh: true });
  return {
    channels: doc.channels.map((channel) => toPublicExternalChannel(channel, credentialConfigured(channel))),
    version,
    storage: process.env.BLOB_READ_WRITE_TOKEN ? ("blob" as const) : ("memory" as const),
    credentialNote:
      "credentialRef 只存环境变量名，raw key 永不落 Blob/DB。请将真实 API key 放进服务器环境变量后填对应变量名。",
  };
}

export async function GET() {
  try {
    await requireAdminSession();
    return NextResponse.json(await buildPayload());
  } catch (error) {
    return errorResponse(error);
  }
}

interface ChannelMutationBody {
  id?: unknown;
  name?: unknown;
  baseUrl?: unknown;
  credentialRef?: unknown;
  modelMapping?: unknown;
  apiKeyWhitelist?: unknown;
  enabled?: unknown;
}

async function readBody(req: NextRequest): Promise<ChannelMutationBody | null> {
  const body = (await req.json().catch(() => null)) as ChannelMutationBody | null;
  if (!body || typeof body !== "object") return null;
  return body;
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireAdminSession();
    const body = await readBody(req);
    if (!body || typeof body.id !== "string" || !body.id.trim()) {
      return NextResponse.json({ success: false, message: "缺少 id。" }, { status: 400 });
    }

    const channel = normalizeExternalChannel({ ...body, id: body.id.trim(), createdAt: new Date().toISOString() });
    if (!channel) {
      return NextResponse.json(
        { success: false, message: "channel 无效：id / baseUrl（http(s)）/ credentialRef（大写环境变量名）必填。" },
        { status: 400 },
      );
    }

    const { doc: previousDoc } = await readExternalChannelDocument({ fresh: true });
    const dup = previousDoc.channels.find((c) => c.id === channel.id);
    if (dup) {
      return NextResponse.json({ success: false, message: `channel ${channel.id} 已存在，用 PUT 更新。` }, { status: 409 });
    }

    const nextDoc: ExternalChannelDocument = { channels: [...previousDoc.channels, channel] };
    const { version: writtenVersion } = await writeExternalChannelDocument(nextDoc);

    const auditVersion = await nextConfigVersion("external-channels");
    await recordConfigChange({
      configKey: "external-channels",
      version: auditVersion,
      actor: session.username,
      action: "update",
      previousVersion: null,
      diff: diffJson(emptyExternalChannelDocument(), nextDoc),
      fullSnapshot: nextDoc,
    });

    return NextResponse.json(await buildPayload({ doc: nextDoc, version: writtenVersion }));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(req: NextRequest) {
  try {
    const session = await requireAdminSession();
    const body = await readBody(req);
    if (!body || typeof body.id !== "string" || !body.id.trim()) {
      return NextResponse.json({ success: false, message: "缺少 id。" }, { status: 400 });
    }

    const channel = normalizeExternalChannel(body);
    if (!channel) {
      return NextResponse.json(
        { success: false, message: "channel 无效：baseUrl / credentialRef 必填。" },
        { status: 400 },
      );
    }

    const { doc: previousDoc } = await readExternalChannelDocument({ fresh: true });
    const index = previousDoc.channels.findIndex((c) => c.id === channel.id);
    if (index === -1) {
      return NextResponse.json({ success: false, message: `channel ${channel.id} 不存在，用 POST 建立。` }, { status: 404 });
    }

    const existing = previousDoc.channels[index];
    const nextDoc: ExternalChannelDocument = {
      channels: previousDoc.channels.map((c, i) =>
        i === index ? { ...existing, ...channel, id: existing.id, createdAt: existing.createdAt } : c,
      ),
    };
    const { version: writtenVersion } = await writeExternalChannelDocument(nextDoc);

    const auditVersion = await nextConfigVersion("external-channels");
    await recordConfigChange({
      configKey: "external-channels",
      version: auditVersion,
      actor: session.username,
      action: "update",
      previousVersion: auditVersion > 1 ? auditVersion - 1 : null,
      diff: diffJson(previousDoc, nextDoc),
      fullSnapshot: nextDoc,
    });

    return NextResponse.json(await buildPayload({ doc: nextDoc, version: writtenVersion }));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const session = await requireAdminSession();
    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    if (!id) {
      return NextResponse.json({ success: false, message: "缺少 id 参数。" }, { status: 400 });
    }

    const { doc: previousDoc } = await readExternalChannelDocument({ fresh: true });
    const exists = previousDoc.channels.some((c) => c.id === id);
    if (!exists) {
      return NextResponse.json({ success: false, message: `channel ${id} 不存在。` }, { status: 404 });
    }

    const nextDoc: ExternalChannelDocument = { channels: previousDoc.channels.filter((c) => c.id !== id) };
    const { version: writtenVersion } = await writeExternalChannelDocument(nextDoc);

    const auditVersion = await nextConfigVersion("external-channels");
    await recordConfigChange({
      configKey: "external-channels",
      version: auditVersion,
      actor: session.username,
      action: "update",
      previousVersion: auditVersion > 1 ? auditVersion - 1 : null,
      diff: diffJson(previousDoc, nextDoc),
      fullSnapshot: nextDoc,
    });
    invalidateExternalChannelCache();

    return NextResponse.json(await buildPayload({ doc: nextDoc, version: writtenVersion }));
  } catch (error) {
    return errorResponse(error);
  }
}
