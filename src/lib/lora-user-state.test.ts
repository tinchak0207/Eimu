import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";

function read(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

test("LoRA favorites and recents use authenticated server-owned state", () => {
  const migration = read("db/migrations/006_lora_user_state.sql");
  const route = read("src/app/api/lora-preferences/route.ts");
  const repository = read("src/lib/lora-user-state.ts");

  assert.match(migration, /PRIMARY KEY \(user_id, model_version_id\)/);
  assert.match(migration, /favorite boolean/);
  assert.match(migration, /last_used_at timestamptz/);
  assert.match(route, /requireVerifiedUser/);
  assert.match(route, /upsertLoraUserState/);
  assert.match(repository, /ON CONFLICT \(user_id, model_version_id\)/);
});

test("LoRA library offers favorites, recents and large preview without multi-select", () => {
  const source = read("src/components/pro-workstation/LoraLibraryPanel.tsx");
  assert.match(source, /"favorites"/);
  assert.match(source, /"recent"/);
  assert.match(source, /Maximize2/);
  assert.match(source, /\/api\/lora-preferences/);
  assert.doesNotMatch(source, /SelectedLora\[\]|value: SelectedLora\[\]/);
});
