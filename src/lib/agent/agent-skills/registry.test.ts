/**
 * 统一技能注册表不变量测试（2026-09-27 立）。
 *
 * 全部为**真行为断言**：调 registry/index 的函式拿实际输出再断言，
 * 不做源码字串扫描（源码层守门件不算已验，见 verification-guards-not-oracles 记忆）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_SKILLS,
  AGENT_SKILL_FAMILIES,
  AGENT_SKILL_FAMILY_LABELS,
  countAgentSkillsByFamily,
  getAgentSkill,
  listAgentSkills,
  searchAgentSkills,
} from "./index.ts";
import {
  AGENT_SKILL_SOURCES,
  RECIPE_SKILLS,
  TEMPLATE_SKILLS,
  getMySkillById,
  getSkillByIdPublic,
  listMySkills,
  listPublicSkills,
  listSkillFamilies,
  registerUserSkillSource,
  searchMySkills,
  searchPublicSkills,
  type AgentSkillView,
} from "./registry.ts";
import { HARNESS_TOOL_IDS } from "../harness-tool-registry.ts";
import { EXPERT_REGISTRY } from "../expert-registry.ts";
import { AGENT_TEMPLATES } from "../agent-templates/index.ts";
import { BUILT_IN_RECIPE_TEMPLATES } from "../recipe-templates.ts";

const BUILTIN_TOTAL = 133;

test("builtin 恰 133 条，公开集合＝builtin 133 / recipe 10 / template 8（永不含 user）", async () => {
  assert.equal(AGENT_SKILLS.length, BUILTIN_TOTAL, `builtin 应恰 ${BUILTIN_TOTAL} 条，实际 ${AGENT_SKILLS.length}`);
  assert.equal(RECIPE_SKILLS.length, BUILT_IN_RECIPE_TEMPLATES.length);
  assert.equal(TEMPLATE_SKILLS.length, AGENT_TEMPLATES.length);

  const all = await listPublicSkills();
  assert.ok(all.length >= BUILTIN_TOTAL, `公开集合总数应 ≥ ${BUILTIN_TOTAL}，实际 ${all.length}`);
  assert.equal(all.length, AGENT_SKILLS.length + RECIPE_SKILLS.length + TEMPLATE_SKILLS.length);
  assert.equal(all.some((skill) => skill.source === "user"), false, "公开集合永不包含 user 来源");

  const bySource = all.reduce<Record<string, number>>((acc, skill) => {
    acc[skill.source] = (acc[skill.source] ?? 0) + 1;
    return acc;
  }, {});
  assert.deepEqual(bySource, {
    builtin: BUILTIN_TOTAL,
    recipe: BUILT_IN_RECIPE_TEMPLATES.length,
    template: AGENT_TEMPLATES.length,
  });
  for (const source of Object.keys(bySource)) {
    assert.ok((AGENT_SKILL_SOURCES as readonly string[]).includes(source), `未知来源 ${source}`);
  }
});

/**
 * 家族分布不变量。
 * 现况：10 个家族宣告皆有条目（`vfx-animation` 已由 12 条补齐，2026-09-27）。
 * 本测试把「无空家族」**钉成显式事实**，而不是放任任一题材家族静默归零。
 */
test("10 个家族全部 ≥ 1 条（无空家族）", () => {
  const counts = countAgentSkillsByFamily(AGENT_SKILLS);
  const empty = AGENT_SKILL_FAMILIES.filter((family) => counts[family] === 0);
  assert.deepEqual(empty, [], `不应有空家族；实际空家族 ${JSON.stringify(empty)}`);
  for (const family of AGENT_SKILL_FAMILIES) {
    assert.ok(counts[family] >= 1, `家族 ${family} 应至少 1 条，实际 ${counts[family]}`);
  }
  const sum = AGENT_SKILL_FAMILIES.reduce((acc, family) => acc + counts[family], 0);
  assert.equal(sum, BUILTIN_TOTAL);
  assert.equal(Object.keys(AGENT_SKILL_FAMILY_LABELS).length, AGENT_SKILL_FAMILIES.length);
});

test("全库 id 唯一（builtin + recipe + template 聚合后）", async () => {
  const all = await listPublicSkills();
  const ids = all.map((skill) => skill.id);
  assert.equal(new Set(ids).size, ids.length, `存在重复 id：${ids.filter((id, i) => ids.indexOf(id) !== i).join(",")}`);
  for (const skill of all) {
    assert.ok(skill.id.trim(), "id 不得为空");
    assert.ok(skill.name.trim(), `${skill.id} 缺 name`);
    assert.ok(skill.oneLiner.trim(), `${skill.id} 缺 oneLiner`);
  }
});

test("toolIds ⊆ HARNESS_TOOL_IDS、expertId ∈ EXPERT_REGISTRY、templateId ∈ AGENT_TEMPLATES", async () => {
  const all = await listPublicSkills();
  const templateIds = new Set(AGENT_TEMPLATES.map((template) => template.id));
  for (const skill of all) {
    assert.ok(skill.toolIds.length > 0, `${skill.id} 未宣告任何 harness 工具`);
    for (const toolId of skill.toolIds) {
      assert.ok(HARNESS_TOOL_IDS.has(toolId), `${skill.id} 的工具 ${toolId} 不在 HARNESS_TOOL_IDS`);
    }
    if (skill.expertId) {
      assert.ok(EXPERT_REGISTRY[skill.expertId], `${skill.id} 的 Expert ${skill.expertId} 不在 EXPERT_REGISTRY`);
    }
    if (skill.templateId) {
      assert.ok(templateIds.has(skill.templateId), `${skill.id} 的 templateId ${skill.templateId} 不在 AGENT_TEMPLATES`);
    }
  }
});

test("recipe 投影忠实原档：id 加前缀、名称/说明取自 BUILT_IN_RECIPE_TEMPLATES、形态为 image", () => {
  const byId = new Map(RECIPE_SKILLS.map((skill) => [skill.id, skill]));
  assert.equal(byId.size, BUILT_IN_RECIPE_TEMPLATES.length);
  for (const template of BUILT_IN_RECIPE_TEMPLATES) {
    const view = byId.get(`recipe-${template.id}`);
    assert.ok(view, `缺 recipe-${template.id} 投影`);
    assert.equal(view.name, template.name);
    assert.equal(view.oneLiner, template.note);
    assert.equal(view.source, "recipe");
    assert.equal(view.outputKind, "image");
    assert.equal(view.templateId, undefined, "配方不是模板，不应挂 templateId");
  }
});

test("template 投影忠实原档：id 加 tpl- 前缀、templateId 指回原 id、family 依 domain 对映", () => {
  const expectedFamily: Record<string, string> = {
    novel: "script",
    ecommerce: "ad-tvc",
    shortdrama: "short-drama",
    art: "cinema-auteur",
  };
  const byId = new Map(TEMPLATE_SKILLS.map((skill) => [skill.id, skill]));
  for (const template of AGENT_TEMPLATES) {
    const view = byId.get(`tpl-${template.id}`);
    assert.ok(view, `缺 tpl-${template.id} 投影`);
    assert.equal(view.templateId, template.id);
    assert.equal(view.name, template.name);
    assert.equal(view.oneLiner, template.note);
    assert.equal(view.source, "template");
    assert.equal(view.family, expectedFamily[template.domain], `${template.id} 的 domain 对映错误`);
  }
});

test("searchAgentSkills 命中真子集且非空；负向对照回空", () => {
  // 查询词用**简体**：数据档已于 2026-09-27 由另一路繁转简（简繁不一致会让查询词命中 0 条，
  // 是测试字面过时，不是搜索坏了）。
  const hits = searchAgentSkills("美学");
  assert.ok(hits.length > 0, "查「美学」应有命中");
  assert.ok(hits.length < AGENT_SKILLS.length, `查「美学」不应命中全库（命中 ${hits.length}/${AGENT_SKILLS.length}）`);
  for (const hit of hits) {
    // 命中来源二选一：条目自身文本，或**家族标签**（标签是独立于 skill 物件的另一个真源，
    // 搜索语义明确把标签算作命中字段）。只查 JSON.stringify(hit) 会漏判「靠标签命中」的条目。
    const ownText = JSON.stringify([
      hit.id,
      hit.name,
      hit.oneLiner,
      hit.useScenario,
      hit.inputType,
      hit.outputContent,
      hit.aesthetic ?? "",
      ...hit.tags,
    ]);
    const label = AGENT_SKILL_FAMILY_LABELS[hit.family] ?? "";
    assert.ok(
      ownText.includes("美学") || label.includes("美学"),
      `${hit.id} 自身文本与家族标签都不含查询词却命中`,
    );
  }
  assert.equal(searchAgentSkills("zzz不存在zzz").length, 0);
  assert.deepEqual(searchAgentSkills(""), AGENT_SKILLS, "空查询应回全量");
});

test("聚合搜索：家族标签「电影美学」命中的必属 cinema-auteur，且跨来源（builtin+recipe+template）", async () => {
  const hits = await searchPublicSkills("电影美学");
  assert.ok(
    hits.length >= countAgentSkillsByFamily(AGENT_SKILLS)["cinema-auteur"],
    `「电影美学」命中过少：${hits.length}`,
  );
  for (const hit of hits) {
    assert.equal(hit.family, "cinema-auteur", `${hit.id} 命中家族标签却不在该家族`);
  }
  const sources = new Set(hits.map((hit) => hit.source));
  assert.ok(sources.has("builtin") && sources.has("recipe") && sources.has("template"),
    `命中来源应跨 builtin/recipe/template，实际 ${[...sources].join(",")}`);
  assert.equal((await searchPublicSkills("zzz不存在zzz")).length, 0);
  // 第二个词取正文内容词（数据已繁转简，「美学」不再是有效查询词）：
  // 两词 AND 必须比单词窄，否则 AND 语义失效。
  const multi = await searchPublicSkills("电影美学 留白");
  assert.ok(multi.length > 0 && multi.length < hits.length, `多词 AND 应缩小结果集（${multi.length} vs ${hits.length}）`);
});

test("listAgentSkills 支持 family 筛选与 limit；getAgentSkill 命中/未命中", () => {
  const cinema = listAgentSkills({ family: "cinema-auteur" });
  assert.equal(cinema.length, countAgentSkillsByFamily(AGENT_SKILLS)["cinema-auteur"]);
  assert.ok(cinema.every((skill) => skill.family === "cinema-auteur"));
  assert.equal(listAgentSkills({ family: "vfx-animation" }).length, 12);
  assert.equal(listAgentSkills({ limit: 7 }).length, 7);
  assert.equal(listAgentSkills({ family: "script", limit: 3 }).length, 3);

  const first = AGENT_SKILLS[0];
  assert.equal(getAgentSkill(first.id)?.id, first.id);
  assert.equal(getAgentSkill("nope-zzz"), undefined);
  assert.equal(getAgentSkill("  "), undefined);
});

test("getSkillByIdPublic 只在公开三来源命中；listSkillFamilies 覆盖 10 家族且计数等于公开实况", async () => {
  const all = await listPublicSkills();
  assert.equal((await getSkillByIdPublic(RECIPE_SKILLS[0].id))?.source, "recipe");
  assert.equal((await getSkillByIdPublic(TEMPLATE_SKILLS[0].id))?.source, "template");
  assert.equal((await getSkillByIdPublic(AGENT_SKILLS[0].id))?.source, "builtin");
  assert.equal(await getSkillByIdPublic("nope-zzz"), undefined);

  const families = listSkillFamilies(all);
  assert.equal(families.length, AGENT_SKILL_FAMILIES.length);
  assert.deepEqual(families.map((entry) => entry.id), AGENT_SKILL_FAMILIES);
  for (const entry of families) {
    assert.equal(entry.count, all.filter((skill) => skill.family === entry.id).length, `${entry.id} 计数不符`);
    assert.ok(entry.label.trim(), `${entry.id} 缺标签`);
  }
  assert.equal(families.find((entry) => entry.id === "vfx-animation")?.count, 12);
});

// —— 公开 / 私有分离（2026-09-27 核心隔离）——
// 放最后：注册 user 插槽后逐条验「公开族不受影响、私有族只回自己的」，测完登出。
function stubSkill(id: string, name: string): AgentSkillView {
  return {
    id,
    name,
    oneLiner: `${name}的一句话`,
    family: "script",
    useScenario: "测试场景",
    inputType: "测试输入",
    outputContent: "测试交付",
    outputKind: "text",
    toolIds: ["doc_struct"],
    tags: ["测试"],
    source: "user",
  };
}

test("隔离：公开列举永不含 user；listMySkills(ownerA) 只回 A，跨租户负对照全空", async () => {
  const publicBefore = await listPublicSkills();
  const stubA = stubSkill("user-a-skill", "甲的自建技能");
  const stubB = stubSkill("user-b-skill", "乙的自建技能");

  // 注册一个「按 ownerKey 分租户」的来源（真行为：函数被调用时按参选数据）。
  const seenOwners: string[] = [];
  registerUserSkillSource(async (ownerKey: string) => {
    seenOwners.push(ownerKey);
    if (ownerKey === "owner-a") return [stubA];
    if (ownerKey === "owner-b") return [stubB];
    return [];
  });

  // ① 公开族与身份无关：注册了 user 来源后公开集合**逐字不变**。
  const publicAfter = await listPublicSkills();
  assert.deepEqual(publicAfter, publicBefore, "注册 user 来源后公开集合不得变化");
  assert.equal(publicAfter.some((skill) => skill.source === "user"), false, "公开集合永不含 user");

  // ② 私有族只回自己的那一条。
  assert.deepEqual(await listMySkills("owner-a"), [stubA]);
  assert.deepEqual(await listMySkills("owner-b"), [stubB]);

  // ③ 跨租户负对照：别人的 id 在公开族 / 在别人名下 / 在无 key 视角一律取不到。
  assert.equal(await getSkillByIdPublic(stubA.id), undefined, "公开族不得命中 user 技能 id");
  assert.equal(await getMySkillById("owner-b", stubA.id), undefined, "owner-b 不得读到 owner-a 的技能");
  assert.equal((await getMySkillById("owner-a", stubA.id))?.source, "user", "正对照：本人的技能取得到");
  assert.deepEqual(await listMySkills(null), [], "无 ownerKey 不得回全体");
  assert.deepEqual(await listMySkills(""), [], "空 ownerKey 不得回全体");
  assert.deepEqual(await listMySkills(undefined), [], "undefined ownerKey 不得回全体");
  assert.deepEqual(await listMySkills("nobody"), [], "未注册过的 ownerKey 回空");

  // ④ 搜索面同样分家：公开搜索不含，本人搜索含。
  assert.equal((await searchPublicSkills(stubA.name)).some((s) => s.id === stubA.id), false);
  assert.deepEqual((await searchMySkills("owner-a", stubA.name)).map((s) => s.id), [stubA.id]);
  assert.deepEqual(await searchMySkills("owner-b", stubA.name), [], "owner-b 搜不到 owner-a 的技能");

  // ⑤ 来源抛错只影响私有族，公开族仍照常（不把个人库故障放大成全站故障）。
  registerUserSkillSource(async () => {
    throw new Error("boom");
  });
  assert.deepEqual(await listMySkills("owner-a"), [], "来源抛错应 fallback 空集合");
  assert.deepEqual(await listPublicSkills(), publicBefore, "来源抛错后公开集合照常");

  // ⑥ 来源被调用时确实拿到 ownerKey（隔离的骨架是参数，不是调用端自觉）。
  registerUserSkillSource(async (ownerKey: string) => (ownerKey === "owner-a" ? [stubA] : []));
  await listMySkills("owner-a");
  assert.ok(seenOwners.includes("owner-a") && seenOwners.includes("owner-b"), "来源必须按 ownerKey 被调用");

  registerUserSkillSource(async () => []);
  assert.deepEqual(await listPublicSkills(), publicBefore, "重置后公开集合不变");
  assert.deepEqual(await listMySkills("owner-a"), [], "重置后私有集合回空");
});
