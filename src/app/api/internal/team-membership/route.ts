// 控制面侧的「查某 user 的團隊歸屬」唯讀端點。調用方是 Vercel 上的
// src/app/api/canvas/projects 一族的閘門：站點路線由 Vercel 服務，而 Vercel
// 按設計不持有 GENERATION_DATABASE_URL／GENERATION_CONTROL_PLANE_ENABLED，
// 於是 team-canvas-gate 在那一側看不到名冊，只能走「未配置→放行」。
// 這裡把歸屬查詢留在真正持有 Postgres 的一側，讓閘門能跨運行時拿到答案。
//
// 鑑權復用 biz-key-sync 的 HMAC 通道（signatureDomain "team-membership"，
// 與 "newapi-session-token"/"biz-key-sync" 域分隔，報文不能互相重放），
// 骨架與 src/app/api/internal/newapi-session-token/route.ts 同構；
// 不回顯任何密鑰或內部錯誤細節。
//
// 唯讀保證：本端點只 SELECT（team_member_quota / team_settings），
// 不含任何 INSERT/UPDATE/DELETE，也不建任何影子帳本或點數欄位。
//
// 語義取自 generation-core/team-governance.ts（片F）：
//   ★ 名冊列（member_user_id = 該 user）→ 該列所屬團隊，角色取 role（019 無 role
//     欄時按 023 的 DDL 默認視為 'member'）。
//   ★ 名冊無列 → 語義上「自己的團隊 owner」（resolveActorTeam 的 isMember=false 分支）；
//     但「有沒有團隊」以真源判定：team_settings 有註冊列，或名冊裡有人以他為
//     team_user_id。沒有團隊的散戶回 membership: null（不是錯誤，也不是 404）。
//   ★ 團隊已解散（team_settings.dissolved_at 非空）→ membership: null。
//   ★ enabled=false 的名冊列不在此過濾：逐字對齊 findRosterEntryByUserId 的
//     既有語義，避免橋端與站內閘門給出不同答案。

import { NextRequest, NextResponse } from "next/server";
import {
  BIZ_KEY_SYNC_SIGNATURE_HEADER,
  BIZ_KEY_SYNC_TIMESTAMP_HEADER,
  verifyBizKeySync,
} from "@/lib/biz-key-sync";
import { generationControlPlaneEnabled, getGenerationSql } from "@/lib/generation-core/database";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／閘道／image-data-api blob／控制面）都在矽谷，同區省一趟橫跨美國（2026-10-01 效能審計）

const SIGNATURE_DOMAIN = "team-membership";

export type TeamMembershipRole = "owner" | "admin" | "member";

/** 呼叫端（Vercel）據此判「成員能否建共享畫布」；null = 該 user 不在任何團隊。 */
export interface TeamMembership {
  teamId: string;
  userId: number;
  role: TeamMembershipRole;
  memberCreateCanvas: boolean;
  seats: number;
}

/**
 * 023 之前（或未落 023）的兜底默認：與 team-governance.ts 的
 * defaultTeamSettings() 同源同值（TEAM_DEFAULT_MAX_MEMBERS 默認 10、
 * member_create_canvas 默認 false、名冊 role 默認 'member'）。
 * 023 落地後這些默認由 DB 供給，本函式自動讓位。
 */
function defaultSeats(): number {
  const raw = (process.env.TEAM_DEFAULT_MAX_MEMBERS ?? "").trim();
  const parsed = raw === "" ? Number.NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return 10;
  return Math.min(200, Math.max(2, parsed));
}

function normalizeRole(value: unknown): TeamMembershipRole {
  return value === "owner" || value === "admin" || value === "member" ? value : "member";
}

interface TeamSettingsRow {
  member_create_canvas: boolean;
  seats: number;
  dissolved_at: Date | string | null;
}

interface TeamSchemaShape {
  has_role: boolean;
  has_team_settings: boolean;
}

// 現場 schema 探測：019 與 023 的落地進度兩側可以不同（VPS 控制面可能還沒
// apply 023），查詢因此必須按現場欄位/表存在性分流，不能假設 migration 已到。
let schemaShape: TeamSchemaShape | null = null;

async function readSchemaShape(sql: ReturnType<typeof getGenerationSql>): Promise<TeamSchemaShape> {
  if (schemaShape) return schemaShape;
  const rows = await sql<TeamSchemaShape[]>`
    SELECT
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'team_member_quota' AND column_name = 'role'
      ) AS has_role,
      to_regclass('public.team_settings') IS NOT NULL AS has_team_settings
  `;
  schemaShape = {
    has_role: rows[0]?.has_role === true,
    has_team_settings: rows[0]?.has_team_settings === true,
  };
  return schemaShape;
}

export async function GET(req: NextRequest) {
  const secret = process.env.GENERATION_BILLING_RELAY_SECRET?.trim();
  if (!secret) return NextResponse.json({ ok: false, message: "签名通道未配置。" }, { status: 503 });

  // GET 沒有請求體，規範簽名覆蓋空字串；另兩種形式是給呼叫端的容錯
  // （同一把密鑰、同一個域，不構成第二套簽名）。
  const rawUserId = req.nextUrl.searchParams.get("user_id") ?? "";
  const userId = /^\d+$/.test(rawUserId) ? Number(rawUserId) : Number.NaN;
  if (!Number.isInteger(userId) || userId <= 0) {
    return NextResponse.json({ ok: false, message: "缺少 user_id。" }, { status: 400 });
  }

  const timestamp = req.headers.get(BIZ_KEY_SYNC_TIMESTAMP_HEADER);
  const signature = req.headers.get(BIZ_KEY_SYNC_SIGNATURE_HEADER);
  const verified = ["", String(userId), `user_id=${userId}`].some((rawBody) =>
    verifyBizKeySync({ secret, timestamp, signature, rawBody, signatureDomain: SIGNATURE_DOMAIN }),
  );
  if (!verified) return NextResponse.json({ ok: false, message: "签名校验失败。" }, { status: 401 });

  if (!generationControlPlaneEnabled()) {
    return NextResponse.json({ ok: false, message: "团队映射层未配置。" }, { status: 503 });
  }

  try {
    const sql = getGenerationSql();
    const shape = await readSchemaShape(sql);

    const rosterRows = shape.has_role
      ? await sql<{ team_user_id: number; role: string | null }[]>`
          SELECT team_user_id, role FROM team_member_quota
          WHERE member_user_id = ${userId} LIMIT 1
        `
      : await sql<{ team_user_id: number }[]>`
          SELECT team_user_id FROM team_member_quota
          WHERE member_user_id = ${userId} LIMIT 1
        `;
    const roster = rosterRows[0] as { team_user_id: number; role?: string | null } | undefined;

    let teamUserId: number;
    let role: TeamMembershipRole;
    if (roster) {
      teamUserId = Number(roster.team_user_id);
      role = shape.has_role ? normalizeRole(roster.role) : "member";
    } else {
      // 無名冊列：可能是團隊主帳，也可能是完全沒有團隊的散戶 —— 由真源判定。
      teamUserId = userId;
      role = "owner";
      if (shape.has_team_settings) {
        const probe = await sql<{ team_user_id: number }[]>`
          SELECT team_user_id FROM team_settings WHERE team_user_id = ${teamUserId} LIMIT 1
        `;
        if (!probe[0]) return NextResponse.json({ ok: true, membership: null });
      } else {
        const probe = await sql<{ count: number }[]>`
          SELECT count(*)::int AS count FROM team_member_quota WHERE team_user_id = ${teamUserId}
        `;
        if (Number(probe[0]?.count ?? 0) <= 0) return NextResponse.json({ ok: true, membership: null });
      }
    }

    let memberCreateCanvas = false;
    let seats = defaultSeats();
    if (shape.has_team_settings) {
      const settingsRows = await sql<TeamSettingsRow[]>`
        SELECT member_create_canvas, seats, dissolved_at FROM team_settings
        WHERE team_user_id = ${teamUserId} LIMIT 1
      `;
      const settings = settingsRows[0];
      if (settings) {
        if (settings.dissolved_at) return NextResponse.json({ ok: true, membership: null });
        memberCreateCanvas = settings.member_create_canvas === true;
        seats = Number(settings.seats);
      }
    }

    const membership: TeamMembership = {
      teamId: String(teamUserId),
      userId,
      role,
      memberCreateCanvas,
      seats,
    };
    return NextResponse.json({ ok: true, membership });
  } catch (error) {
    // 不洩漏內部錯誤細節（DB 拓撲/SQL 等），只留固定文案；細節進日誌。
    console.error("[internal/team-membership] lookup failed", error);
    return NextResponse.json({ ok: false, message: "团队归属查询失败。" }, { status: 500 });
  }
}
