import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(process.cwd(), "src/app/api/auth/github/callback/route.ts"), "utf8");

test("github callback treats success:false register responses as register failures", () => {
  assert.match(source, /data\?\.success/);
  assert.match(source, /!response\.ok \|\| !data\?\.success/);
});

test("github callback logs backend username when login fails", () => {
  assert.match(source, /console\.error\("\[auth\/github\/login\]"/);
  assert.match(source, /username/);
});
