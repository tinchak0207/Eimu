// 卡 store 测试：记忆体降级路径的 CRUD（测试环境无 BLOB_READ_WRITE_TOKEN）、
// 清洗收口（normalizeCharacterCard 共用）、世代修剪模式与 project-store 对齐。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  __resetCharacterCardStoreForTests,
  CharacterCardPersistError,
  deleteCharacterCards,
  listCharacterCards,
  saveCharacterCard,
} from "./character-card-store";
import type { CharacterCard } from "./character-cards";

function card(id: string, overrides: Partial<CharacterCard> = {}): CharacterCard {
  return {
    id,
    name: `卡-${id}`,
    kind: "character",
    prompt: "红发少女",
    references: [{ url: "https://img.example/a.png", role: "character", name: "定妆照" }],
    createdAt: "2026-08-22T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z",
    ...overrides,
  };
}

test("store（记忆体降级）：save upsert / list / delete 幂等", async () => {
  __resetCharacterCardStoreForTests();
  await saveCharacterCard(1, card("card-a"));
  await saveCharacterCard(1, card("card-b", { kind: "scene" }));
  let cards = await listCharacterCards(1);
  assert.equal(cards.length, 2);

  // upsert：同 id 覆盖，不重复。
  await saveCharacterCard(1, card("card-a", { prompt: "更新后的片段", updatedAt: "2026-08-23T00:00:00.000Z" }));
  cards = await listCharacterCards(1);
  assert.equal(cards.length, 2);
  assert.equal(cards.find((c) => c.id === "card-a")?.prompt, "更新后的片段");

  // 用户隔离。
  const other = await listCharacterCards(2);
  assert.equal(other.length, 0);

  const deleted = await deleteCharacterCards(1, ["card-a", "card-a", "不存在"]);
  assert.equal(deleted, 1);
  assert.equal((await listCharacterCards(1)).length, 1);
  assert.equal(await deleteCharacterCards(1, ["card-a"]), 0); // 再删 = 0
});

test("store：data:image 转存失败时拒绝且不入库", async () => {
  __resetCharacterCardStoreForTests();
  await assert.rejects(
    () => saveCharacterCard(1, card("card-data", {
      references: [{ url: "data:image/png;base64,aaaa", role: "character", name: "内嵌" }],
    })),
    CharacterCardPersistError,
  );
  assert.equal((await listCharacterCards(1)).length, 0);
});

test("store：非法卡静默丢弃（normalizeCharacterCard 收口）", async () => {
  __resetCharacterCardStoreForTests();
  await saveCharacterCard(3, { ...card("card-x"), name: "" });
  assert.equal((await listCharacterCards(3)).length, 0);
});

test("store 使用不可变 blob 世代（与 project-store 同模式）", () => {
  const source = readFileSync("src/lib/character-card-store.ts", "utf8");
  assert.match(source, /list\(\{ prefix: indexPrefix/);
  assert.doesNotMatch(source, /allowOverwrite:\s*true/);
  assert.match(source, /INDEX_GENERATIONS_KEPT = 2/);
  assert.match(source, /MAX_CARDS_PER_USER = 100/);
});
