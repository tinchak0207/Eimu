import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

function read(relPath: string) {
  return readFileSync(join(root, relPath), "utf8");
}

test("history api route exposes GET, POST and DELETE handlers", () => {
  const source = read("src/app/api/history/route.ts");
  assert.match(source, /export async function GET/);
  assert.match(source, /export async function POST/);
  assert.match(source, /export async function DELETE/);
});

test("每个历史端点都用校验过的身份，绝不信任 x-user-id 请求头", () => {
  // 这是本次修复的核心。`x-user-id` 由客户端自己填（new-api-client.ts 的 bearerHeader），
  // 旧实现只读它、不看 Authorization —— 于是不带任何令牌的
  // `curl -H 'x-user-id: 42' /api/history` 就能读走 42 号用户的全部历史，
  // POST 同理可以往别人的历史里写。
  for (const relPath of [
    "src/app/api/history/route.ts",
    "src/app/api/history/[id]/route.ts",
    "src/app/api/history/stats/route.ts",
  ]) {
    const source = read(relPath);
    assert.match(source, /requireVerifiedUser/, `${relPath} 必须校验身份`);
    assert.doesNotMatch(
      source,
      /getStoredUserFromHeaders/,
      `${relPath} 不得使用未校验的请求头身份`,
    );
    // 用户 id 只能来自校验结果，不能来自请求体或查询参数。
    assert.doesNotMatch(source, /body\.userId|params\.get\("userId"\)/, `${relPath} 不得从客户端取 userId`);
  }
});

test("requireVerifiedUser 把令牌交给上游核对，并且查看历史不因余额为零被拦", () => {
  const source = read("src/lib/server-user.ts");
  assert.match(source, /authenticateImageUser/);
  // 传 0 而不是默认的出图配额：余额为零的用户仍然有权查看自己的历史。
  assert.match(source, /authenticateImageUser\(req\.headers,\s*0\)/);
});

test("POST /api/history 校验请求体，不再原样落盘", () => {
  // 注释里会引用旧写法做说明，所以只看实际代码。
  const source = read("src/app/api/history/route.ts")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  // 旧实现是 `saveGeneratedHistoryEntry({ ...body, userId })`，body 每个字段都是未校验的客户端输入。
  assert.doesNotMatch(source, /\.\.\.body/);
  // 落盘的必须是规范化之后的对象，且 userId 只能来自校验结果。
  assert.match(source, /saveGeneratedHistoryEntry\(\{\s*\.\.\.normalized,\s*userId:\s*auth\.user\.id\s*\}\)/);
  assert.match(source, /normalizeHistoryEntry/);
  assert.match(source, /HISTORY_MAX_PROMPT_LENGTH/);
  assert.match(source, /HISTORY_MAX_RESULTS_PER_ENTRY/);
});

test("拼进 Blob 路径的片段都经过清洗，挡住路径穿越", () => {
  const store = read("src/lib/server-history-store.ts");
  assert.match(store, /sanitizeBlobSegment/);
  // entryId 与 provider 可能来自 POST 请求体，直接拼路径就能写进别人的目录。
  assert.match(store, /function imageBlobPath[\s\S]*?sanitizeBlobSegment\(entryId/);
  assert.match(store, /function imageBlobPath[\s\S]*?sanitizeBlobSegment\(provider/);
});

test("generate images route persists successful generations to server history", () => {
  const source = read("src/app/api/generate-images/route.ts");

  assert.match(source, /saveGeneratedHistoryEntry/);
  assert.match(source, /workflow/);
  // The entry shape now lives in history-types.ts; the route only supplies the input
  // fields, with `source`/`schemaVersion` filled by the storage layer.
  assert.match(read("src/lib/history-types.ts"), /workflow\?: GenerationWorkflowMetadata/);
  assert.match(read("src/lib/server-history-store.ts"), /SaveHistoryEntryInput/);
});

test("server history store uses the shared blob-backed persistence adapter", () => {
  const source = read("src/lib/server-history-store.ts");
  assert.match(source, /@\/lib\/blob-backend/);
  assert.doesNotMatch(source, /from ["']@vercel\/blob["']/);
  assert.match(source, /put\(/);
  // Writes land on a fresh `history/<user>/index-<ts>.json` per save rather than
  // overwriting one fixed path: cacheControlMaxAge floors at 60s, so an overwritten
  // pathname would leave a just-generated image unreadable for up to a minute.
  assert.match(source, /function indexPrefix/);
  assert.match(source, /\$\{indexPrefix\(userId\)\}\$\{Date\.now\(\)\}/);
  assert.match(source, /function userPrefix/);
  // Legacy fixed-path documents still have to be migrated in, not orphaned.
  assert.match(source, /function legacyIndexPath/);
});
