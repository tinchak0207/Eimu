import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function read(relPath: string) {
  return readFileSync(join(process.cwd(), relPath), "utf8");
}

test("agent profile store exposes the L0 contract (profile + lessons, persisted)", () => {
  const source = read("src/lib/agent-profile-store.ts");

  // 类型：画像字段（用户确认过的事实）
  for (const field of ["industry", "assetTypes", "typicalSpecs", "stylePreferences", "prohibitions", "habits", "notes"]) {
    assert.match(source, new RegExp(`${field}\\??:`));
  }
  // 存储：Postgres 优先 + Blob 兜底 + 进程内兜底
  assert.match(source, /CREATE TABLE IF NOT EXISTS agent_user_profiles/);
  assert.match(source, /CREATE TABLE IF NOT EXISTS agent_lessons/);
  assert.match(source, /AGENT_PROFILE_BLOB_PREFIX}\/p\/\$\{userId\}\.json/);
  // 注入：空画像不占上下文
  assert.match(source, /if \(!hasProfile && lessons\.length === 0\) return null/);
});

test("agent profile store sanitizes field sizes and limits lessons", () => {
  const source = read("src/lib/agent-profile-store.ts");
  assert.match(source, /AGENT_LESSONS_INJECT_LIMIT = 8/);
  assert.match(source, /\.slice\(0, 300\)/); // lesson summary 上限
});

test("session creation carries confirmed profile + recent lessons to the gateway", () => {
  const route = read("src/app/api/agent/sessions/route.ts");
  assert.match(route, /loadAgentProfile\(caller\.userId\)/);
  assert.match(route, /listAgentLessons\(caller\.userId\)/);
  assert.match(route, /buildAgentMemoryInjection\(profile, lessons\)/);
  assert.match(route, /payload\.user_profile = memoryInjection\.user_profile/);
  assert.match(route, /payload\.lessons = memoryInjection\.lessons/);
  // 画像存储失败不阻塞开新会话
  assert.match(route, /memoryInjection = null; \/\/ 画像存储失败不阻塞开新会话/);
});

test("profile GET/PUT route keeps the account profile visible and editable", () => {
  const route = read("src/app/api/agent/profile/route.ts");
  assert.match(route, /export async function GET/);
  assert.match(route, /export async function PUT/);
  assert.match(route, /loadAgentProfile\(caller\.userId\)/);
  assert.match(route, /saveAgentProfile\(merged\)/);
  assert.match(route, /sanitizeProfile/);
});

test("lesson digest endpoint extracts lessons silently and fails closed", () => {
  const route = read("src/app/api/agent/profile/lessons/route.ts");
  assert.match(route, /extractLessonsViaGateway/);
  assert.match(route, /addAgentLesson\(\{/);
  assert.match(route, /skipped: "too_short"/);
  assert.match(route, /skipped: "llm_unavailable"/);
  assert.match(route, /llm_unavailable/);
  // 静默：提炼失败不抛错、不阻塞响应
  assert.match(route, /return null; \/\/ 静默失败/);
});

test("frontend lesson-digest chain is offline (PRD D5): hook never calls /profile/lessons", () => {
  const hook = read("src/hooks/use-agent-chat.ts");
  // 同步提炼链已下线（由每日批次取代）：前端不得再引用端点或残留节流常量。
  assert.doesNotMatch(hook, /fireAndForgetLessonDigest|LESSON_DIGEST|\/api\/agent\/profile\/lessons/);
  // turn.done 的僵尸自愈时间锚点保留，删提炼链不得误伤。
  assert.match(hook, /evt\.name === "turn\.done"/);
  assert.match(hook, /lastTurnDoneAtRef\.current = Date\.now\(\);/);
  // 端点本身保留（B 端与向后兼容），只断前端触发链路。
  assert.match(read("src/app/api/agent/profile/lessons/route.ts"), /export async function POST/);
});