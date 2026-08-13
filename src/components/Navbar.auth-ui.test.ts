import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("navbar logged-in state shows the default user avatar and account name", () => {
  const source = readFileSync(join(process.cwd(), "src/components/Navbar.tsx"), "utf8");
  assert.match(source, /<User className="h-3\.5 w-3\.5/);
  assert.match(source, /user\.display_name \|\| user\.username/);
});
