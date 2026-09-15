// Agent 账户画像（L0）与跨会话教训存储。
//
// 目标：模型在同一个账户的多个对话之间记住「这个用户是谁、怎么合作」——B 端
// 用户每天生成 1000 张素材，第二天开新会话也应该秒懂，不再从头问一遍行业、
// 规格、风格偏好。这是「账户级记忆」，不是会话内上下文（后者走 canvas_state）。
//
// 存储纪律（沿用 agent-user-key / biz-api-key-store 的兜底链）：
//   1. Postgres（user_profiles / agent_lessons 表）—— 持久、可跨会话查询；
//   2. Blob（新路径 + 修剪旧世代）—— DB 未配置时的回退；
//   3. 进程内 Map —— 两者都不可用时的最后兜底（重启即失，仅本地调试）。
//
// 写读纪律：
//   - profile 是「用户确认过的画像」，只应由确认/编辑入口写入，模型不得静默改写；
//   - lessons 是「模型从会话里提炼的教训」，每个都带 source_session_id + 摘要，
//     防止把一次性的噪音当成稳定规律。

import { randomBytes } from "node:crypto";
import { del, get, list, put } from "@/lib/blob-backend";
import { getGenerationSql } from "@/lib/generation-core/database";

// ─────────────────────────── 类型

export interface AgentProfile {
  userId: number;
  /** 行业 / 领域，如「电商美妆」「短剧分镜」。 */
  industry?: string;
  /** 素材类型，如「商品图」「角色三视图」「分镜关键帧」。 */
  assetTypes?: string[];
  /** 常用画布/输出规格，如「4:5」「1024x1024」「多镜头分镜」。 */
  typicalSpecs?: string[];
  /** 稳定风格偏好（模型名或自然语言），如「pixai-tsubaki2，电影感」。 */
  stylePreferences?: string[];
  /** 明确禁止项（不生成的东西）。 */
  prohibitions?: string[];
  /** 高频参数/习惯，如「每批 4 张」「先出方案再批量」。 */
  habits?: string[];
  /** 自由备注。 */
  notes?: string;
  /** 画像版本，供前端 diff 展示。 */
  version: number;
  /** 最近一次确认/编辑时间（ISO）。 */
  updatedAt: string;
}

export interface AgentLesson {
  id: string;
  userId: number;
  /** 教训正文（一句话）。 */
  summary: string;
  /** 来源：哪个 session 提炼的。 */
  sourceSessionId: string;
  /** 提炼时间（ISO）。 */
  createdAt: string;
  /** 当用户确认这条教训仍然成立时置 true；永不过期地进注入集合。 */
  confirmed?: boolean;
}

export const AGENT_PROFILE_SCHEMA_VERSION = 1;
export const AGENT_PROFILE_VERSION_INIT = 1;
export const AGENT_LESSONS_INJECT_LIMIT = 8;
/** Blob 路径前缀（本项目其它存储同款约定：agent-profile/…）。 */
export const AGENT_PROFILE_BLOB_PREFIX = "agent-profile";

// ─────────────────────────── 进程内兜底

const profileMemory = new Map<number, AgentProfile>();
const lessonsMemory = new Map<string, AgentLesson>();

function emptyProfile(userId: number): AgentProfile {
  return { userId, version: AGENT_PROFILE_VERSION_INIT, updatedAt: new Date(0).toISOString() };
}

// ─────────────────────────── helper

function kvKey(userId: number): string {
  return `${AGENT_PROFILE_BLOB_PREFIX}/p/${userId}.json`;
}

/** 兼容两条 blob 后端读文本：Vercel 返回 { blob }，VPS 返回 { stream }。 */
async function readBlobText(
  result: Awaited<ReturnType<typeof get>> | null,
): Promise<string | null> {
  if (!result) return null;
  const anyResult = result as unknown as { blob?: Blob; stream?: ReadableStream<Uint8Array> | null };
  if (anyResult.blob) return await anyResult.blob.text();
  if (anyResult.stream) {
    const reader = anyResult.stream.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    return new TextDecoder().decode(new Uint8Array(Buffer.concat(chunks as Buffer[])));
  }
  return null;
}

function lessonKey(userId: number, lessonId: string): string {
  return `${AGENT_PROFILE_BLOB_PREFIX}/l/${userId}/${lessonId}.json`;
}

// ─────────────────────────── Postgres 路径

async function dbUpsertProfile(profile: AgentProfile): Promise<void> {
  const sql = getGenerationSql();
  await sql`
    INSERT INTO agent_user_profiles (user_id, industry, asset_types, typical_specs, style_preferences, prohibitions, habits, notes, version, updated_at)
    VALUES (
      ${profile.userId}, ${profile.industry ?? null},
      ${sql.json(profile.assetTypes ?? []) as never},
      ${sql.json(profile.typicalSpecs ?? []) as never},
      ${sql.json(profile.stylePreferences ?? []) as never},
      ${sql.json(profile.prohibitions ?? []) as never},
      ${sql.json(profile.habits ?? []) as never},
      ${profile.notes ?? null}, ${profile.version}, ${profile.updatedAt}
    )
    ON CONFLICT (user_id) DO UPDATE SET
      industry = EXCLUDED.industry,
      asset_types = EXCLUDED.asset_types,
      typical_specs = EXCLUDED.typical_specs,
      style_preferences = EXCLUDED.style_preferences,
      prohibitions = EXCLUDED.prohibitions,
      habits = EXCLUDED.habits,
      notes = EXCLUDED.notes,
      version = EXCLUDED.version,
      updated_at = EXCLUDED.updated_at
  `;
}

async function dbGetProfile(userId: number): Promise<AgentProfile | null> {
  const sql = getGenerationSql();
  const rows = await sql`
    SELECT user_id, industry, asset_types, typical_specs, style_preferences,
           prohibitions, habits, notes, version, updated_at
    FROM agent_user_profiles WHERE user_id = ${userId}
  `;
  const row = rows[0] as
    | {
        user_id: number;
        industry: string | null;
        asset_types: unknown;
        typical_specs: unknown;
        style_preferences: unknown;
        prohibitions: unknown;
        habits: unknown;
        notes: string | null;
        version: number;
        updated_at: string;
      }
    | undefined;
  if (!row) return null;
  return {
    userId: row.user_id,
    industry: row.industry ?? undefined,
    assetTypes: Array.isArray(row.asset_types) ? (row.asset_types as string[]) : [],
    typicalSpecs: Array.isArray(row.typical_specs) ? (row.typical_specs as string[]) : [],
    stylePreferences: Array.isArray(row.style_preferences) ? (row.style_preferences as string[]) : [],
    prohibitions: Array.isArray(row.prohibitions) ? (row.prohibitions as string[]) : [],
    habits: Array.isArray(row.habits) ? (row.habits as string[]) : [],
    notes: row.notes ?? undefined,
    version: row.version,
    updatedAt: row.updated_at,
  };
}

async function dbEnsureSchema(): Promise<void> {
  const sql = getGenerationSql();
  await sql`
    CREATE TABLE IF NOT EXISTS agent_user_profiles (
      user_id       BIGINT PRIMARY KEY,
      industry      TEXT,
      asset_types   JSONB NOT NULL DEFAULT '[]'::jsonb,
      typical_specs JSONB NOT NULL DEFAULT '[]'::jsonb,
      style_preferences JSONB NOT NULL DEFAULT '[]'::jsonb,
      prohibitions  JSONB NOT NULL DEFAULT '[]'::jsonb,
      habits        JSONB NOT NULL DEFAULT '[]'::jsonb,
      notes         TEXT,
      version       INTEGER NOT NULL DEFAULT 1,
      updated_at    TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_lessons (
      id               TEXT PRIMARY KEY,
      user_id          BIGINT NOT NULL,
      summary          TEXT NOT NULL,
      source_session_id TEXT NOT NULL,
      confirmed        BOOLEAN NOT NULL DEFAULT false,
      created_at       TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_lessons_user ON agent_lessons (user_id, confirmed);
  `;
}

async function dbListLessons(userId: number, limit = AGENT_LESSONS_INJECT_LIMIT): Promise<AgentLesson[]> {
  const sql = getGenerationSql();
  const rows = await sql`
    SELECT id, user_id, summary, source_session_id, confirmed, created_at
    FROM agent_lessons WHERE user_id = ${userId}
    ORDER BY confirmed DESC, created_at DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => ({
    id: r.id as string,
    userId: r.user_id as number,
    summary: r.summary as string,
    sourceSessionId: r.source_session_id as string,
    confirmed: Boolean(r.confirmed),
    createdAt: r.created_at as string,
  }));
}

async function dbAddLesson(lesson: AgentLesson): Promise<void> {
  const sql = getGenerationSql();
  await sql`
    INSERT INTO agent_lessons (id, user_id, summary, source_session_id, confirmed, created_at)
    VALUES (${lesson.id}, ${lesson.userId}, ${lesson.summary}, ${lesson.sourceSessionId}, ${lesson.confirmed ?? false}, ${lesson.createdAt})
    ON CONFLICT (id) DO NOTHING
  `;
}

async function dbConfirmLesson(userId: number, lessonId: string, confirmed: boolean): Promise<void> {
  const sql = getGenerationSql();
  await sql`
    UPDATE agent_lessons SET confirmed = ${confirmed}
    WHERE id = ${lessonId} AND user_id = ${userId}
  `;
}

// ─────────────────────────── 对外 API

export interface AgentProfileStorePaths {
  /** DB 可用时 true；否则走 Blob/内存。调用方可据此决定是否提示「画像暂存本地」。 */
  persistent: boolean;
}

function dbAvailable(): boolean {
  try {
    getGenerationSql();
    return true;
  } catch {
    return false;
  }
}

/** 读取账户画像；从未建立时返回空画像（userId 已填）。 */
export async function loadAgentProfile(userId: number): Promise<AgentProfile> {
  if (dbAvailable()) {
    try {
      await dbEnsureSchema();
      const fromDb = await dbGetProfile(userId);
      if (fromDb) return fromDb;
      return emptyProfile(userId);
    } catch {
      // DB 抖动 → 回退 Blob，不把错误抛给调用方。
    }
  }
  const cached = profileMemory.get(userId);
  if (cached) return cached;
  try {
    const result = await get(kvKey(userId), { access: "private" }).catch(() => null);
    const text = await readBlobText(result);
    if (text !== null) {
      const parsed = JSON.parse(text) as AgentProfile;
      profileMemory.set(userId, parsed);
      return parsed;
    }
  } catch {
    // Blob 也失败 → 空画像。
  }
  return emptyProfile(userId);
}

/** 保存画像（仅确认/编辑入口调用）。返回新版本号。 */
export async function saveAgentProfile(profile: AgentProfile): Promise<{ profile: AgentProfile; persistent: boolean }> {
  const next = {
    ...profile,
    version: Math.max(AGENT_PROFILE_VERSION_INIT, (profile.version ?? 0) + 1),
    updatedAt: new Date().toISOString(),
  };
  if (dbAvailable()) {
    try {
      await dbEnsureSchema();
      await dbUpsertProfile(next);
      return { profile: next, persistent: true };
    } catch {
      // DB 抖动 → 继续走 Blob。
    }
  }
  try {
    await put(kvKey(next.userId), JSON.stringify(next), {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
    });
  } catch {
    // Blob 也失败 → 内存。
  }
  profileMemory.set(next.userId, next);
  return { profile: next, persistent: false };
}

/** 从会话提炼一条教训。同一 session 对同一摘要幂等（防重复注入）。 */
export async function addAgentLesson(params: {
  userId: number;
  summary: string;
  sourceSessionId: string;
}): Promise<AgentLesson> {
  const lesson: AgentLesson = {
    id: `${params.sourceSessionId.slice(0, 24)}-${randomBytes(4).toString("hex")}`,
    userId: params.userId,
    summary: params.summary.trim().slice(0, 300),
    sourceSessionId: params.sourceSessionId,
    createdAt: new Date().toISOString(),
    confirmed: false,
  };
  if (dbAvailable()) {
    try {
      await dbEnsureSchema();
      await dbAddLesson(lesson);
      return lesson;
    } catch {
      // 回退 Blob。
    }
  }
  try {
    await put(lessonKey(params.userId, lesson.id), JSON.stringify(lesson), {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
    });
  } catch {
    lessonsMemory.set(lesson.id, lesson);
  }
  return lesson;
}

/** 列出该账户最近的教训（注入用）。 */
export async function listAgentLessons(userId: number, limit = AGENT_LESSONS_INJECT_LIMIT): Promise<AgentLesson[]> {
  if (dbAvailable()) {
    try {
      await dbEnsureSchema();
      return await dbListLessons(userId, limit);
    } catch {
      // 回退 Blob。
    }
  }
  const all = Array.from(lessonsMemory.values())
    .filter((l) => l.userId === userId)
    .sort((a, b) => Number(b.confirmed ?? false) - Number(a.confirmed ?? false) || b.createdAt.localeCompare(a.createdAt));
  return all.slice(0, limit);
}

/**
 * 用户确认/否认一条教训（确认后才保证进注入集合）。
 * 未啟用：全倉零調用點（2026-09-15 盤點，PRD D3），隨 P2 記憶 UI 決定去留。
 */
export async function confirmAgentLesson(userId: number, lessonId: string, confirmed: boolean): Promise<void> {
  if (dbAvailable()) {
    try {
      await dbEnsureSchema();
      await dbConfirmLesson(userId, lessonId, confirmed);
      return;
    } catch {
      // 回退 Blob。
    }
  }
  for (const lesson of lessonsMemory.values()) {
    if (lesson.id === lessonId && lesson.userId === userId) {
      lesson.confirmed = confirmed;
    }
  }
}

/** 组装注入网关的画像+教训摘要（system 上下文）。空画像时返回 null，不占上下文。 */
export function buildAgentMemoryInjection(
  profile: AgentProfile,
  lessons: AgentLesson[],
  opts?: { maxLessons?: number },
): { user_profile: Record<string, unknown>; lessons: string[] } | null {
  const maxLessons = opts?.maxLessons ?? AGENT_LESSONS_INJECT_LIMIT;
  const profileFields: Record<string, unknown> = {};
  const sets: Array<[keyof AgentProfile, string]> = [
    ["industry", "行业"],
    ["assetTypes", "素材类型"],
    ["typicalSpecs", "常用规格"],
    ["stylePreferences", "风格偏好"],
    ["prohibitions", "禁止项"],
    ["habits", "协作习惯"],
    ["notes", "备注"],
  ];
  for (const [key, label] of sets) {
    const value = profile[key];
    if (Array.isArray(value) && value.length > 0) {
      profileFields[label] = value;
    } else if (typeof value === "string" && value.trim().length > 0) {
      profileFields[label] = value;
    }
  }
  const hasProfile = profile.userId >= 0 && Object.keys(profileFields).length > 0;
  if (!hasProfile && lessons.length === 0) return null;

  const lessonLines = lessons.slice(0, maxLessons).map((l) => `- ${l.summary}`);
  return {
    user_profile: profileFields,
    lessons: lessonLines,
  };
}