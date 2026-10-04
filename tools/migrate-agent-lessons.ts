#!/usr/bin/env -S npx tsx
//
// P1-2：旧 `AgentLesson`（blob `agent-profile/l/{userId}/{lessonId}.json`）一次性迁移
// 为新私有记忆档（type=feedback）。默认 **dry-run**，只出计画表，零写入；`--apply` 才落库。
//
// 迁移映射（PRD §4.3 / §10 P1-2）：旧 lesson 是 `type=feedback` doc 的退化版——
// 每条 lesson → 一条 private doc：ownerKey=该用户正典 key 的 hash12、
// domain=「协作记忆」、slug=`legacy-{lessonId 净化}`、description=summary 截 120、
// body=summary 原文＋feedback 型硬带的 Why/How to apply 两段、evidenceKind=user_confirmed、
// selfScore=4、promptVersion=legacy-migration、batchId=migration-2026-09-15。
//
// 幂等（G5）：store 以「scope+ownerKey+slug」认条目，同 slug 重跑走更新（revision+1，
// 不翻倍、不占配额）；`legacy-{lessonId}` 由 lesson id 决定性净化得来，重跑稳定。
// 配额（G7）：private ≤10/日/owner、「协作记忆」domain ≤8/日（全局计）——存量超过时
// 多余条目会被 store 拒（quota_scope/quota_domain），次日重跑续迁（更新路径不受配额限）。
//
// 旧路径 stop-write：属 gateway 侧（前端链已 D5 下线＝事实已 stop-write），本 tool 不碰。
// **迁移后旧 blob（agent-profile/l/）保留 30 天再议删除；本 tool 不删任何旧档。**
//
// 覆盖面注记：旧 addAgentLesson 优先写 Postgres、blob 为回退，故 blob 枚举覆盖的是
// blob 世代留下的 lesson；DB 路径条目的处置属 gateway/中控侧决策，不在本片范围（PRD P1-2 指定枚举 blob）。
//
// 用法：
//   npx tsx tools/migrate-agent-lessons.ts                          # dry-run 全量
//   npx tsx tools/migrate-agent-lessons.ts --user 12                # dry-run 单用户
//   npx tsx tools/migrate-agent-lessons.ts --apply [--user 12]      # 真写（ingestMemoryDocs）
//   npx tsx tools/migrate-agent-lessons.ts --dry-run --selftest     # 内存样例纯逻辑断言（无需凭证）
//
// 需要环境变量（--apply / 真库 dry-run）：BLOB_READ_WRITE_TOKEN（或 VPS blob 后端）＋
// AGENT_KEY_ENCRYPTION_SECRET（getOrCreateAgentKeyForUser 解密派生 key）。--selftest 不需要。

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type {
  AgentMemoryDocInput,
  MemoryIngestInput,
  MemoryIngestResult,
} from "../src/lib/agent-memory-store";

const root = process.cwd();

/** 从 env 档载入脚本需要的变量（逐行抄 issue-biz-key.ts 的惯例）。 */
function loadEnv(): void {
  const candidates = [".env.production.local", ".env.production", ".env.local"];
  for (const file of candidates) {
    let content: string;
    try {
      content = readFileSync(join(root, file), "utf8");
    } catch {
      continue;
    }
    for (const line of content.split(/\r?\n/)) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (!match) continue;
      const [, key, rawValue] = match;
      const value = rawValue.replace(/^"(.*)"$/, "$1");
      if (!value || value === "[SENSITIVE]") continue;
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}

function readFlag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

// ─────────────────────────── 常量（契约口径）

const LESSON_BLOB_PREFIX = "agent-profile/l/";
const BATCH_ID = "migration-2026-09-15";
const PROMPT_VERSION = "legacy-migration";
const DOMAIN = "协作记忆";
const DESCRIPTION_MAX = 120;
const BODY_MAX = 2000;
const SLUG_MAX = 64;
const SLUG_PATTERN = /^[a-z0-9-]{1,64}$/;

// ─────────────────────────── 旧 lesson 形状（agent-profile-store.ts AgentLesson）

interface LegacyLesson {
  id: string;
  userId: number;
  summary: string;
  sourceSessionId: string;
}

interface LessonBlobEntry {
  pathname: string;
  text: string | null;
}

// ─────────────────────────── 纯逻辑：净化与映射（selftest 与生产共用同一份）

/** 按 code point 截断，避免锯开 surrogate pair。 */
function clip(value: string, max: number): string {
  const chars = Array.from(value);
  return chars.length > max ? chars.slice(0, max).join("") : value;
}

/** lessonId → slug：小写化、非 [a-z0-9-] 收敛为 `-`、去首尾 `-`、`legacy-` 前缀、≤64。 */
export function sanitizeLessonSlug(lessonId: string): string {
  const cleaned = String(lessonId ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  const fallback = `h-${createHash("sha256").update(String(lessonId ?? ""), "utf8").digest("hex").slice(0, 16)}`;
  const core = (cleaned || fallback).slice(0, SLUG_MAX - "legacy-".length);
  return `legacy-${core}`.replace(/-+$/g, "") || `legacy-${fallback}`;
}

/** 反推自 agent-memory-store.isStructurallyValid 的本地防线（提前报 skip，不代替 store 闸门）。 */
function structureIssue(doc: AgentMemoryDocInput): string | null {
  if (doc.scope !== "private") return "scope 非 private";
  if (!String(doc.ownerKey ?? "").trim()) return "ownerKey 未解析";
  if (!SLUG_PATTERN.test(doc.slug)) return `slug 不合规则：${doc.slug}`;
  if (!doc.description || doc.description.length > DESCRIPTION_MAX) return "description 长度不合法";
  if (!doc.body || doc.body.length > BODY_MAX) return "body 长度不合法";
  return null;
}

type MapOutcome =
  | { ok: true; doc: AgentMemoryDocInput }
  | { ok: false; reason: string };

/** 单条 lesson → ingestMemoryDocs 入参候选（反馈型硬带 Why/How to apply）。 */
export function lessonToFeedbackDoc(lesson: LegacyLesson, ownerKey: string): MapOutcome {
  const summary = String(lesson.summary ?? "").trim();
  if (!summary) return { ok: false, reason: "summary 为空" };
  const sourceSessionId = String(lesson.sourceSessionId ?? "").trim() || "unknown";
  const slug = sanitizeLessonSlug(lesson.id);
  const description = clip(summary, DESCRIPTION_MAX);
  const suffix = `\n\n**Why:** 来自会话 ${sourceSessionId} 的提炼。\n**How to apply:** 与当前对话冲突时以现场为准。`;
  const head = summary.slice(0, Math.max(0, BODY_MAX - suffix.length));
  const body = `${head}${suffix}`;
  const doc: AgentMemoryDocInput = {
    scope: "private",
    ownerKey,
    domain: DOMAIN,
    slug,
    description,
    type: "feedback",
    body,
    evidence: summary,
    evidenceKind: "user_confirmed",
    selfScore: 4,
    promptVersion: PROMPT_VERSION,
  };
  const issue = structureIssue(doc);
  if (issue) return { ok: false, reason: issue };
  return { ok: true, doc };
}

// ─────────────────────────── 计画构建（依赖注入，selftest 用假件走同一码路径）

interface MigrationDeps {
  /** 枚举 blob `agent-profile/l/` 全部 lesson JSON（含分页翻尽）。 */
  listLessonBlobs(): Promise<LessonBlobEntry[]>;
  /** userId → 正典化 ownerKey（hash12）。抛错＝该用户整体跳过。 */
  resolveOwnerKey(userId: number): Promise<string>;
  /** 真写（仅 --apply 调用）。 */
  ingest(input: MemoryIngestInput): Promise<MemoryIngestResult>;
  /** 近重复预警用现成 Jaccard（store 导出）。 */
  jaccard(a: string, b: string): number;
}

interface UserPlan {
  userId: number;
  ownerKey?: string;
  ownerKeyError?: string;
  docs: AgentMemoryDocInput[];
  skipped: Array<{ lessonId: string; reason: string }>;
  nearDuplicates: Array<{ slug: string; similarTo: string }>;
}

function parseLesson(entry: LessonBlobEntry): { lesson?: LegacyLesson; reason?: string } {
  if (entry.text === null) return { reason: "blob 读取失败" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(entry.text);
  } catch {
    return { reason: "JSON 解析失败" };
  }
  const obj = (parsed ?? {}) as Partial<LegacyLesson>;
  const pathMatch = /^agent-profile\/l\/(\d+)\/(.+)\.json$/.exec(entry.pathname);
  const pathUserId = pathMatch ? Number(pathMatch[1]) : NaN;
  const pathId = pathMatch ? pathMatch[2] : "";
  const userId = Number.isFinite(Number(obj.userId)) && Number(obj.userId) > 0 ? Number(obj.userId) : pathUserId;
  const id = String(obj.id ?? pathId).trim();
  if (!Number.isFinite(userId) || userId <= 0) return { reason: "userId 缺失且路径无法反推" };
  if (!id) return { reason: "lesson id 缺失且路径无法反推" };
  return {
    lesson: {
      id,
      userId,
      summary: String(obj.summary ?? ""),
      sourceSessionId: String(obj.sourceSessionId ?? ""),
    },
  };
}

export async function planMigration(deps: MigrationDeps, userFilter?: number): Promise<UserPlan[]> {
  const entries = await deps.listLessonBlobs();
  const byUser = new Map<number, LegacyLesson[]>();
  const orphanSkips = new Map<number, Array<{ lessonId: string; reason: string }>>();

  for (const entry of entries) {
    const { lesson, reason } = parseLesson(entry);
    const pathMatch = /^agent-profile\/l\/(\d+)\/(.+)\.json$/.exec(entry.pathname);
    const guessUser = pathMatch ? Number(pathMatch[1]) : NaN;
    if (!lesson) {
      const uid = Number.isFinite(guessUser) ? guessUser : 0;
      if (!orphanSkips.has(uid)) orphanSkips.set(uid, []);
      orphanSkips.get(uid)!.push({ lessonId: pathMatch?.[2] ?? entry.pathname, reason: reason ?? "未知" });
      continue;
    }
    if (!byUser.has(lesson.userId)) byUser.set(lesson.userId, []);
    byUser.get(lesson.userId)!.push(lesson);
  }

  const userIds = [...new Set([...byUser.keys(), ...orphanSkips.keys()])]
    .filter((uid) => (userFilter === undefined ? true : uid === userFilter))
    .sort((a, b) => a - b);

  const plans: UserPlan[] = [];
  for (const userId of userIds) {
    const plan: UserPlan = { userId, docs: [], skipped: orphanSkips.get(userId) ?? [], nearDuplicates: [] };
    if (!plan.ownerKey) {
      try {
        plan.ownerKey = (await deps.resolveOwnerKey(userId)).trim();
      } catch (error) {
        plan.ownerKeyError = error instanceof Error ? error.message : String(error);
      }
    }
    const lessons = (byUser.get(userId) ?? []).sort(
      (a, b) => a.id.localeCompare(b.id),
    );
    for (const lesson of lessons) {
      const outcome = lessonToFeedbackDoc(lesson, plan.ownerKey ?? "");
      if (!outcome.ok) {
        plan.skipped.push({ lessonId: lesson.id, reason: outcome.reason });
        continue;
      }
      // 近重复预警（同 description 的 Jaccard>0.8）：apply 时 store 的 G5 会真拒，这里只提前报。
      for (const kept of plan.docs) {
        if (deps.jaccard(kept.description, outcome.doc.description) > 0.8) {
          plan.nearDuplicates.push({ slug: outcome.doc.slug, similarTo: kept.slug });
          break;
        }
      }
      plan.docs.push(outcome.doc);
    }
    plans.push(plan);
  }
  return plans;
}

function printPlan(plans: UserPlan[], apply: boolean): void {
  const totalDocs = plans.reduce((n, p) => n + p.docs.length, 0);
  const totalSkips = plans.reduce((n, p) => n + p.skipped.length, 0);
  console.log(
    `\n迁移计画（${apply ? "APPLY：将真写入" : "DRY-RUN：零写入"}）：` +
      `${plans.length} 用户 / ${totalDocs} 条候选 / ${totalSkips} 条跳过\n`,
  );
  for (const plan of plans) {
    const owner = plan.ownerKey ? `ownerKey=${plan.ownerKey}` : `ownerKey=未解析（${plan.ownerKeyError ?? "?"}）`;
    console.log(`用户 ${plan.userId}：${owner} · 候选 ${plan.docs.length} · 跳过 ${plan.skipped.length}`);
    for (const doc of plan.docs) {
      console.log(`  [入] slug=${doc.slug} desc=「${clip(doc.description, 40)}」`);
    }
    for (const dup of plan.nearDuplicates) {
      console.log(`  [预警] ${dup.slug} 与 ${dup.similarTo} 近重复（>0.8），apply 时将被 G5 拒为 duplicate`);
    }
    for (const skip of plan.skipped) {
      console.log(`  [跳] ${skip.lessonId}：${skip.reason}`);
    }
  }
}

// ─────────────────────────── 生产依赖组装（动态 import：必须等 loadEnv 跑完）

async function buildRealDeps(): Promise<MigrationDeps> {
  const blob = await import("../src/lib/blob-backend");
  const injection = await import("../src/lib/agent-memory-injection");
  const userKey = await import("../src/lib/agent-user-key");
  const store = await import("../src/lib/agent-memory-store");

  /** 兼容两 blob 后端读文本（抄 agent-profile-store.readBlobText：Vercel { blob }／VPS { stream }）。 */
  async function readBlobText(result: Awaited<ReturnType<typeof blob.get>> | null): Promise<string | null> {
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

  return {
    async listLessonBlobs() {
      const out: LessonBlobEntry[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = await blob.list({
          prefix: LESSON_BLOB_PREFIX,
          limit: 500,
          ...(cursor ? { cursor } : {}),
        });
        for (const item of page.blobs ?? []) {
          if (!item.pathname.endsWith(".json")) continue;
          let text: string | null = null;
          try {
            text = await readBlobText(await blob.get(item.pathname, { access: "private" }));
          } catch {
            text = null;
          }
          out.push({ pathname: item.pathname, text });
        }
        const nextCursor = (page as { cursor?: string | null }).cursor ?? undefined;
        if (!page.hasMore || !nextCursor || nextCursor === cursor) break;
        cursor = nextCursor;
      }
      return out;
    },
    async resolveOwnerKey(userId) {
      const rawKey = await userKey.getOrCreateAgentKeyForUser(userId);
      const owner = await injection.deriveMemoryOwnerKey(rawKey);
      if (!owner) throw new Error("派生 key 解析为空 ownerKey");
      return owner;
    },
    ingest: (input) => store.ingestMemoryDocs(input),
    jaccard: (a, b) => store.memoryJaccard(a, b),
  };
}

async function applyPlans(deps: MigrationDeps, plans: UserPlan[]): Promise<void> {
  for (const plan of plans) {
    if (plan.docs.length === 0) continue;
    if (!plan.ownerKey) {
      console.log(`用户 ${plan.userId}：ownerKey 未解析（${plan.ownerKeyError ?? "?"}），整组跳过。`);
      continue;
    }
    const result = await deps.ingest({ batchId: BATCH_ID, promptVersion: PROMPT_VERSION, docs: plan.docs });
    console.log(
      `用户 ${plan.userId}：入库 accepted=${result.accepted.length}/${result.stats.received}` +
        (result.rejected.length ? ` · 拒=${result.rejected.map((r) => `${r.slug}(${r.reason})`).join("，")}` : ""),
    );
  }
  console.log(`\n完成。旧 blob（${LESSON_BLOB_PREFIX}*）保留 30 天再议删除，本 tool 未删任何旧档。`);
  console.log("如出现 quota_scope/quota_domain 拒收：次日重跑续迁（同 slug 重跑走 G5 更新，不翻倍）。");
}

// ─────────────────────────── selftest（内存样例 3 条×2 用户，同一代码路径）

async function runSelftest(): Promise<void> {
  const assert: typeof import("node:assert").strict = (await import("node:assert")).strict;
  const injection = await import("../src/lib/agent-memory-injection");
  const store = await import("../src/lib/agent-memory-store");

  const fakeLessons: LessonBlobEntry[] = [
    { pathname: "agent-profile/l/7/sessA-00ff1122.json", text: JSON.stringify({ id: "sessA-00ff1122", userId: 7, summary: "用户偏好每批先出 4 张缩图再询问精修。", sourceSessionId: "sessA", createdAt: "2026-09-01T00:00:00.000Z" }) },
    { pathname: "agent-profile/l/7/Sess/../B C_01%.json", text: JSON.stringify({ id: "Sess/../B C_01%", userId: 7, summary: "导出前必须确认长宽比为 4:5，不得默认 1:1。", sourceSessionId: "sessB", createdAt: "2026-09-02T00:00:00.000Z" }) },
    { pathname: "agent-profile/l/7/sessC-33.json", text: JSON.stringify({ id: "sessC-33", userId: 7, summary: "用户是电商服饰卖家，素材以实拍风为主。", sourceSessionId: "sessC", createdAt: "2026-09-03T00:00:00.000Z" }) },
    { pathname: "agent-profile/l/42/sessD-44.json", text: JSON.stringify({ id: "sessD-44", userId: 42, summary: "分镜需求一律先给文字脚本再生图。", sourceSessionId: "sessD", createdAt: "2026-09-04T00:00:00.000Z" }) },
    { pathname: "agent-profile/l/42/sessE-55.json", text: JSON.stringify({ id: "sessE-55", userId: 42, summary: "   ", sourceSessionId: "sessE", createdAt: "2026-09-05T00:00:00.000Z" }) },
    { pathname: "agent-profile/l/42/sessF-66.json", text: "{not-json" },
  ];
  const fakeKeyFor = (userId: number) => `sk-biz-fakeuser${userId}`;
  const identityResolver = async (key: string) => key;

  let ingestCalls = 0;
  const fakeDeps = (): MigrationDeps => ({
    async listLessonBlobs() {
      return fakeLessons.map((entry) => ({ pathname: entry.pathname, text: entry.text }));
    },
    async resolveOwnerKey(userId) {
      const owner = await injection.deriveMemoryOwnerKey(fakeKeyFor(userId), identityResolver);
      if (!owner) throw new Error("fake resolve failed");
      return owner;
    },
    async ingest(input) {
      ingestCalls += 1;
      assert.equal(input.batchId, BATCH_ID);
      return { accepted: input.docs.map((d) => `${BATCH_ID}-${d.slug}`), rejected: [], stats: { received: input.docs.length, accepted: input.docs.length, index_lines: input.docs.length } };
    },
    jaccard: (a, b) => store.memoryJaccard(a, b),
  });

  const plans1 = await planMigration(fakeDeps());
  const plans2 = await planMigration(fakeDeps());
  assert.equal(ingestCalls, 0, "dry-run 路径不得触发 ingest（零写入）");

  // 分组：用户 0（坏 JSON 按路径归属）与用户 7、42。
  const u7 = plans1.find((p) => p.userId === 7)!;
  const u42 = plans1.find((p) => p.userId === 42)!;
  assert.equal(u7.docs.length, 3, "用户 7 应有 3 条候选");
  assert.equal(u42.docs.length, 1, "用户 42：1 入选");
  assert.ok(u42.skipped.some((s) => s.lessonId === "sessE-55" && s.reason.includes("summary")), "空 summary 应被跳过并报因");
  assert.ok(u42.skipped.some((s) => s.lessonId === "sessF-66" && s.reason.includes("JSON")), "坏 JSON 应被跳过并报因");

  // ownerKey 恒等：同用户两次计画同值；且＝gateway hashKey 镜像（UTF-8 SHA-256 前 12 bytes 小写 hex）。
  for (const [plan, userId] of [[u7, 7], [u42, 42]] as const) {
    const again = plans2.find((p) => p.userId === userId)!;
    assert.equal(plan.ownerKey, again.ownerKey);
    assert.match(String(plan.ownerKey), /^[0-9a-f]{24}$/);
    const independent = createHash("sha256").update(fakeKeyFor(userId), "utf8").digest().subarray(0, 12).toString("hex");
    assert.equal(plan.ownerKey, independent, "ownerKey 必须等于 SHA-256(key) 前 12 bytes 小写 hex（与 gateway hashKey 同算法）");
  }

  for (const doc of [...u7.docs, ...u42.docs]) {
    // slug 净化：脏 id 也要过正则、带 legacy- 前缀、≤64。
    assert.match(doc.slug, SLUG_PATTERN);
    assert.ok(doc.slug.startsWith("legacy-"));
    assert.ok(doc.slug.length <= SLUG_MAX);
    // feedback 型契约：Why/How to apply 硬带、栏位口径。
    assert.ok(doc.body.includes("**Why:** 来自会话") && doc.body.includes("**How to apply:** 与当前对话冲突时以现场为准。"));
    assert.ok(typeof doc.evidence === "string" && doc.body.includes(doc.evidence), "body 应含 summary 原文");
    assert.equal(doc.scope, "private");
    assert.equal(doc.domain, DOMAIN);
    assert.equal(doc.type, "feedback");
    assert.equal(doc.evidenceKind, "user_confirmed");
    assert.equal(doc.selfScore, 4);
    assert.equal(doc.promptVersion, PROMPT_VERSION);
    assert.ok(doc.description.length <= DESCRIPTION_MAX);
    assert.ok(doc.body.length <= BODY_MAX);
  }
  assert.ok(u7.docs.some((d) => d.slug === "legacy-sessa-00ff1122"), "id 小写净化后 slug 稳定");
  assert.ok(u7.docs.some((d) => d.slug === "legacy-sess-b-c-01"), "路径跳脱字元／空格／符号全部净化为单一连字号");

  // apply 路径：两个有效用户组各触发一次 ingest（dry-run 全程 0 次 → 现为 2 次）。
  await applyPlans(fakeDeps(), plans1);
  assert.equal(ingestCalls, 2, "--apply 应每用户调用一次 ingest");

  console.log("[selftest] 样例 3 条×2 用户：ownerKey 恒等（gateway hashKey 镜像）✓ slug 净化 ✓ feedback 契约 ✓ dry-run 零写入 ✓ apply 写入路径 ✓");
  console.log("[selftest] PASS");
}

// ─────────────────────────── 入口

async function main(): Promise<void> {
  if (hasFlag("selftest")) {
    await runSelftest();
    return;
  }

  loadEnv();
  const blobBackend = await import("../src/lib/blob-backend");
  if (!process.env.BLOB_READ_WRITE_TOKEN && !blobBackend.useVpsBlobBackend()) {
    console.error(`缺少 BLOB_READ_WRITE_TOKEN（且未配置 VPS blob 后端）。请先：npx vercel env pull .env.production.local --environment=production`);
    process.exit(1);
  }

  const apply = hasFlag("apply");
  const userFlag = readFlag("user");
  const userFilter = userFlag !== undefined ? Number(userFlag) : undefined;
  if (userFlag !== undefined && !Number.isFinite(userFilter)) {
    console.error("--user 需要整数。");
    process.exit(1);
  }

  const deps = await buildRealDeps();
  const plans = await planMigration(deps, userFilter);
  printPlan(plans, apply);
  if (!apply) {
    console.log(`\ndry-run 完成，零写入（确认后加 --apply；旧 blob 保留 30 天再议删除）。`);
    return;
  }
  await applyPlans(deps, plans);
}

main().catch((error) => {
  console.error("迁移失败：", error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
