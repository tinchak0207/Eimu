import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("Adobe direct cookie import stays behind the Image Studio admin session", () => {
  const source = readFileSync(join(process.cwd(), "src/app/api/admin/adobe2api/import/route.ts"), "utf8");

  assert.match(source, /requireAdminSession\(\)/);
  assert.match(source, /ADOBE2API_ADMIN_BASE_URL/);
  assert.match(source, /ADOBE2API_ADMIN_USERNAME/);
  assert.match(source, /ADOBE2API_ADMIN_PASSWORD/);
  assert.match(source, /refresh-profiles\/import-cookie/);
  assert.doesNotMatch(source, /NextResponse\.json\(\{[^}]*cookie/);
});
