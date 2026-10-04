// 控制面侧的「查某 user 的团队归属」唯读端点。调用方是 Vercel 上的
// src/app/api/canvas/projects 一族的闸门：站点路线由 Vercel 服务，而 Vercel
// 按设计不持有 GENERATION_DATABASE_URL／GENERATION_CONTROL_PLANE_ENABLED，
// 于是 team-canvas-gate 在那一侧看不到名册，只能走「未配置→放行」。
// 这里把归属查询留在真正持有 Postgres 的一侧，让闸门能跨运行时拿到答案。
//
// 鉴权复用 biz-key-sync 的 HMAC 通道（signatureDomain "team-membership"，
// 与 "newapi-session-token"/"biz-key-sync" 域分隔，报文不能互相重放），
// 骨架与 src/app/api/internal/newapi-session-token/route.ts 同构；
// 不回显任何密钥或内部错误细节。
//
// 唯读保证：本端点只 SELECT（team_member_quota / team_settings），
// 不含任何 INSERT/UPDATE/DELETE，也不建任何影子帐本或点数栏位。
//
// 语义取自 generation-core/team-governance.ts（片F）：
//   ★ 名册列（member_user_id = 该 user）→ 该列所属团队，角色取 role（019 无 role
//     栏时按 023 的 DDL 默认视为 'member'）。
//   ★ 名册无列 → 语义上「自己的团队 owner」（resolveActorTeam 的 isMember=false 分支）；
//     但「有没有团队」以真源判定：team_settings 有注册列，或名册里有人以他为
//     team_user_id。没有团队的散户回 membership: null（不是错误，也不是 404）。
//   ★ 团队已解散（team_settings.dissolved_at 非空）→ membership: null。
//   ★ enabled=false 的名册列不在此过滤：逐字对齐 findRosterEntryByUserId 的
//     既有语义，避免桥端与站内闸门给出不同答案。

import { NextRequest, NextResponse } from "next/server";
import {
  BIZ_KEY_SYNC_SIGNATURE_HEADER,
  BIZ_KEY_SYNC_TIMESTAMP_HEADER,
  verifyBizKeySync,
} from "@/lib/biz-key-sync";
import { generationControlPlaneEnabled, getGenerationSql } from "@/lib/generation-core/database";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

const SIGNATURE_DOMAIN = "team-membership";

export type TeamMembershipRole = "owner" | "admin" | "member";

/** 呼叫端（Vercel）据此判「成员能否建共享画布」；null = 该 user 不在任何团队。 */
export interface TeamMembership {
  teamId: string;
  userId: number;
  role: TeamMembershipRole;
  memberCreateCanvas: boolean;
  seats: number;
}

/**
 * 023 之前（或未落 023）的兜底默认：与 team-governance.ts 的
 * defaultTeamSettings() 同源同值（TEAM_DEFAULT_MAX_MEMBERS 默认 10、
 * member_create_canvas 默认 false、名册 role 默认 'member'）。
 * 023 落地后这些默认由 DB 供给，本函式自动让位。
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

// 现场 schema 探测：019 与 023 的落地进度两侧可以不同（VPS 控制面可能还没
// apply 023），查询因此必须按现场栏位/表存在性分流，不能假设 migration 已到。
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

  // GET 没有请求体，规范签名覆盖空字串；另两种形式是给呼叫端的容错
  // （同一把密钥、同一个域，不构成第二套签名）。
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
      // 无名册列：可能是团队主帐，也可能是完全没有团队的散户 —— 由真源判定。
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
    // 不泄漏内部错误细节（DB 拓扑/SQL 等），只留固定文案；细节进日志。
    console.error("[internal/team-membership] lookup failed", error);
    return NextResponse.json({ ok: false, message: "团队归属查询失败。" }, { status: 500 });
  }
}
