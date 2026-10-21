import type { fetchGatewayUser } from "@/lib/gateway-admin";

import { readAccountLedger, type LedgerEntry } from "../account-ledger";
import type { GenerationSql } from "../database";
import { readTeamQuotaView, toCoins } from "../member-quota";
import { listTeamRoster, readTeamSettings, reasonOf } from "./store";
import { teamCapacity, type TeamMemberUsage, type TeamUsageRecord, type TeamUsageSummary } from "./types";

// ─────────────────────────────────────────── 面 6：用量统计
function mapLedgerRecord(entry: LedgerEntry): TeamUsageRecord {
  return {
    id: entry.id,
    userId: entry.billingUserId,
    entryType: entry.entryType,
    amount: entry.amount,
    amountCoins: toCoins(entry.amount),
    source: entry.source,
    sourceRef: entry.sourceRef,
    jobId: entry.jobId,
    operationId: entry.operationId,
    createdAt: entry.createdAt ?? null,
  };
}

export type TeamLedgerReader = (billingUserId: number, sql?: GenerationSql) => Promise<LedgerEntry[]>;

/**
 * 团队／成员维度用量汇总：数字一律读既有权威面（new-api 经 member-quota 的可视面；
 * 逐笔明细读既有 account_ledger），**不新建统计帐本**。
 */
export async function readTeamUsage(
  input: { teamUserId: number; memberKeyId?: string },
  deps: {
    sql?: GenerationSql;
    fetchUser?: typeof fetchGatewayUser;
    readLedger?: TeamLedgerReader;
  } = {},
): Promise<TeamUsageSummary | null> {
  const view = await readTeamQuotaView({ teamUserId: input.teamUserId }, { sql: deps.sql, fetchUser: deps.fetchUser });
  if (!view) return null;
  const settings = await readTeamSettings(input.teamUserId, deps.sql);
  const roleByUser = new Map((await listTeamRoster(input.teamUserId, deps.sql)).map((entry) => [entry.memberUserId, entry.role]));
  const readLedger = deps.readLedger ?? ((userId: number, sql?: GenerationSql) => readAccountLedger(userId, { sql }));

  const members: TeamMemberUsage[] = [];
  const allRecords: TeamUsageRecord[] = [];
  let membersRemaining = 0;
  for (const member of view.members) {
    if (input.memberKeyId && member.memberKeyId !== input.memberKeyId) continue;
    let records: TeamUsageRecord[] = [];
    try {
      records = (await readLedger(member.memberUserId, deps.sql)).map(mapLedgerRecord);
    } catch (error) {
      console.error(`[team-governance] 成员用量明细读取失败 user=${member.memberUserId}: ${reasonOf(error)}`);
    }
    membersRemaining += member.remaining;
    members.push({
      memberKeyId: member.memberKeyId,
      memberUserId: member.memberUserId,
      displayName: member.displayName,
      role: roleByUser.get(member.memberUserId) ?? "member",
      enabled: member.enabled,
      granted: member.granted,
      used: member.used,
      remaining: member.remaining,
      coins: member.coins,
      unavailable: member.unavailable,
      records,
    });
    allRecords.push(...records);
  }
  allRecords.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));

  const teamRemaining = view.team.remaining;
  return {
    teamUserId: view.teamUserId,
    seats: settings.seats,
    memberCount: view.members.length,
    capacity: teamCapacity(),
    totals: {
      granted: view.allocated,
      used: view.used,
      remaining: teamRemaining,
      coins: { granted: view.allocatedCoins, used: view.usedCoins, remaining: view.team.coins },
    },
    conservation: {
      masterRemaining: view.master.remaining,
      membersRemaining,
      teamRemaining,
      consumed: view.used,
      balanced: view.master.remaining + membersRemaining === teamRemaining,
      formula: "主帐手上余额 + Σ成员桶剩余 = 团队未消耗总额",
    },
    members,
    records: allRecords,
  };
}
