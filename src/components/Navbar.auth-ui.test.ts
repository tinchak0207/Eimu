import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("navbar logged-in state shows the key affordance and account name", () => {
  const source = readFileSync(join(process.cwd(), "src/components/Navbar.tsx"), "utf8");
  // 2026-08-27 暴君裁定（二轮）：钥匙是独立按钮 + 专属 key 菜单（只放
  // 复制/管理）；名字右侧按钮只承担退出；三点 Ellipsis 已废。
  assert.match(source, /<KeyRound className="h-3\.5 w-3\.5/);
  assert.match(source, /copyApiKey/);
  assert.match(source, /aria-label="退出登录"/);
  assert.doesNotMatch(source, /<Ellipsis/);
  assert.match(source, /user\.display_name \|\| user\.username/);
});
