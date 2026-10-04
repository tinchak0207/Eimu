// 控制面侧的密钥写入端点。只接受 HMAC 签名请求，不接受管理员会话 ——
// 这个端点的调用方是 Vercel 上的 admin 路由，不是浏览器。
//
// 对应关系见 src/lib/biz-key-sync.ts 的头注释：权威源 Postgres 在这台机器上，
// 但 Vercel 连不上它的端口，于是走这条签名通道。

import { NextRequest, NextResponse } from "next/server";
import {
  BIZ_KEY_SYNC_SIGNATURE_HEADER,
  BIZ_KEY_SYNC_TIMESTAMP_HEADER,
  verifyBizKeySync,
  type BizKeySyncOperation,
} from "@/lib/biz-key-sync";
import {
  bizKeyDatabaseEnabled,
  deleteBizKeyFromDatabase,
  insertBizKeyIntoDatabase,
  listBizKeysFromDatabase,
  updateBizKeyInDatabase,
} from "@/lib/biz-api-key-repository";
import type { BizApiKey } from "@/lib/biz-api-keys";
import { gatherLocalDiagnostics } from "@/lib/control-plane-diagnostics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

function fail(message: string, status: number) {
  return NextResponse.json({ ok: false, message }, { status });
}

function isValidRecord(value: unknown): value is BizApiKey {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<BizApiKey>;
  return typeof record.id === "string"
    && typeof record.keyHash === "string"
    && /^[0-9a-f]{64}$/i.test(record.keyHash)
    && typeof record.userId === "number"
    && typeof record.label === "string";
}

export async function POST(req: NextRequest) {
  const secret = process.env.GENERATION_BILLING_RELAY_SECRET?.trim();
  if (!secret) return fail("密钥同步通道未配置。", 503);

  // 必须读原文再解析：签名覆盖的是字节，JSON.stringify(parsed) 不保证等价。
  const rawBody = await req.text();
  const verified = verifyBizKeySync({
    secret,
    timestamp: req.headers.get(BIZ_KEY_SYNC_TIMESTAMP_HEADER),
    signature: req.headers.get(BIZ_KEY_SYNC_SIGNATURE_HEADER),
    rawBody,
  });
  if (!verified) return fail("签名校验失败。", 401);

  let operation: BizKeySyncOperation;
  try {
    operation = JSON.parse(rawBody) as BizKeySyncOperation;
  } catch {
    return fail("请求体不是合法 JSON。", 400);
  }

  // 诊断在库不可用时反而最该能跑通，所以库的检查只挡读写密钥的操作。
  if (operation.op !== "diagnostics" && !bizKeyDatabaseEnabled()) {
    return fail("控制面数据库未配置。", 503);
  }

  try {
    switch (operation.op) {
      case "list": {
        return NextResponse.json({ ok: true, data: await listBizKeysFromDatabase() });
      }
      case "insert": {
        if (!isValidRecord(operation.record)) return fail("密钥记录字段不完整。", 400);
        await insertBizKeyIntoDatabase(operation.record);
        return NextResponse.json({ ok: true, data: operation.record });
      }
      case "update": {
        if (typeof operation.id !== "string" || !operation.id) return fail("缺少密钥 id。", 400);
        return NextResponse.json({ ok: true, data: await updateBizKeyInDatabase(operation.id, operation.patch ?? {}) });
      }
      case "delete": {
        if (typeof operation.id !== "string" || !operation.id) return fail("缺少密钥 id。", 400);
        return NextResponse.json({ ok: true, data: await deleteBizKeyFromDatabase(operation.id) });
      }
      case "diagnostics": {
        // 只读，且只回布尔与计数，不含任何密钥值。
        return NextResponse.json({ ok: true, data: await gatherLocalDiagnostics() });
      }
      default:
        return fail("未知操作。", 400);
    }
  } catch (error) {
    console.error("[biz-keys-sync] 操作失败。", error);
    return fail(error instanceof Error ? error.message : "操作失败。", 500);
  }
}
