// /skills 技能库首页的真行为断言（渲染层，不是源码字串扫描）：
//   1. 渲染出的条目数 == AGENT_SKILLS.length，且 id 集合逐条相等；
//   2. family query 真的过滤（只渲染该家族，且家族计数来自真源）；
//   3. 负向对照：注册一把「私有」user 来源后，它不得出现在公开页面；
//   4. 诚实用词：页面不得出现评分 / 使用次数 / 作者 / 收藏这类未提供的假字段；
//   5. canonical 自指 /skills，sitemap 收录 /skills、每条 /skills/<id> 与 /mcp。
//
// 运行器沿用仓库既有约定（见 src/app/mcp/page.test.ts）：node:test + renderToStaticMarkup。

import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import SkillsIndexPage, { metadata } from "./page";
import { AGENT_SKILLS, AGENT_SKILL_FAMILIES, AGENT_SKILL_FAMILY_LABELS } from "@/lib/agent-skills";
import type { AgentSkillFamily } from "@/lib/agent-skills/types";
import { registerUserSkillSource } from "@/lib/agent-skills/registry";
import type { AgentSkillView } from "@/lib/agent-skills/registry";
import sitemap from "../sitemap";
import { getSiteUrlFromEnv } from "@/lib/site-url";

const SITE_URL = getSiteUrlFromEnv();

async function renderIndex(searchParams: Record<string, string | string[]> = {}): Promise<string> {
  const element = await SkillsIndexPage({ searchParams: Promise.resolve(searchParams) });
  return renderToStaticMarkup(element);
}

function extractSkillIds(html: string): string[] {
  return [...html.matchAll(/data-skill-id="([^"]+)"/g)].map((match) => match[1]);
}

// 一把假「私有」技能：只经由 registry 的 user 插槽注册，页面若误读私有枚举就会渲染出来。
const PRIVATE_SENTINEL: AgentSkillView = {
  id: "user-private-sentinel-xyz",
  name: "私有哨兵技能",
  oneLiner: "这段内容不得出现在公开技能库页面",
  family: "script",
  useScenario: "仅用于公开/私有边界的行为断言",
  inputType: "无",
  outputContent: "无",
  outputKind: "text",
  toolIds: [],
  tags: ["私有"],
  source: "user",
};

test("/skills 首页真渲染：条目数 == AGENT_SKILLS.length，且 id 集合逐条相等", async () => {
  const html = await renderIndex();
  const renderedIds = extractSkillIds(html);

  assert.equal(renderedIds.length, AGENT_SKILLS.length, "渲染出的卡片数必须等于内建技能总数");
  assert.deepEqual(
    [...renderedIds].sort(),
    AGENT_SKILLS.map((skill) => skill.id).sort(),
    "渲染出的 id 集合必须与 AGENT_SKILLS 完全一致",
  );

  // 抽查一条：名称与一句话必须在真实 HTML 里
  const sample = AGENT_SKILLS[0];
  assert.ok(html.includes(sample.name), `缺技能名称 ${sample.name}`);
  assert.ok(html.includes(sample.oneLiner), `缺 oneLiner ${sample.oneLiner}`);
});

test("/skills 首页真渲染：10 个家族标签与其条目数都来自真源", async () => {
  const html = await renderIndex();
  for (const family of AGENT_SKILL_FAMILIES) {
    const label = AGENT_SKILL_FAMILY_LABELS[family];
    assert.ok(html.includes(label), `缺家族标签 ${label}`);
    assert.ok(
      html.includes(`href="/skills?family=${family}"`),
      `缺家族筛选链接 /skills?family=${family}`,
    );
    const count = AGENT_SKILLS.filter((skill) => skill.family === family).length;
    assert.ok(html.includes(`${label} ${count}`), `家族 ${label} 的条目数 ${count} 未出现`);
  }
  assert.ok(html.includes(`全部 ${AGENT_SKILLS.length}`), "「全部」筛选应显示总条数");
});

test("/skills?family= 真的过滤：只渲染该家族条目", async () => {
  const family: AgentSkillFamily = "script";
  const expected = AGENT_SKILLS.filter((skill) => skill.family === family);
  assert.ok(expected.length > 0 && expected.length < AGENT_SKILLS.length, "测试家族必须是真子集");

  const html = await renderIndex({ family });
  const renderedIds = extractSkillIds(html);

  assert.equal(renderedIds.length, expected.length, "过滤后卡片数必须等于该家族条目数");
  assert.deepEqual([...renderedIds].sort(), expected.map((skill) => skill.id).sort());

  const outside = AGENT_SKILLS.find((skill) => skill.family !== family);
  assert.ok(outside, "必须存在其它家族的技能");
  assert.ok(!html.includes(`data-skill-id="${outside.id}"`), `过滤后仍渲染了别的家族技能 ${outside.id}`);

  // 未知 family 值一律退回「全部」，不泄成空页也不报错
  const fallback = await renderIndex({ family: "does-not-exist" });
  assert.equal(extractSkillIds(fallback).length, AGENT_SKILLS.length, "未知 family 应退回全部");
});

test("负向对照：注册私有 user 来源后，/skills 页仍不出现任何私有技能", async () => {
  registerUserSkillSource(async () => [PRIVATE_SENTINEL]);
  try {
    const html = await renderIndex();
    assert.ok(!html.includes("data-skill-id=\"user-private-sentinel-xyz\""), "私有技能 id 泄漏到公开页");
    assert.ok(!html.includes(PRIVATE_SENTINEL.name), "私有技能名称泄漏到公开页");
    assert.ok(!html.includes(PRIVATE_SENTINEL.oneLiner), "私有技能描述泄漏到公开页");
    assert.ok(!/data-skill-id="user-/.test(html), "公开页不得出现任何 user 前缀技能");
  } finally {
    // 复位插槽，避免污染同进程后续断言
    registerUserSkillSource(async () => []);
  }
});

test("诚实用词：页面不出现评分 / 使用次数 / 点赞 等伪造元数据字段", async () => {
  const html = await renderIndex();
  // 只扫「一旦出现就只能是伪造元数据」的词；像「作者/收藏/热度」这些词本身就在真实技能
  // 文案里（作者风格、收藏感），拿它们做负向断言会误伤内容。
  for (const forbidden of ["评分", "使用次数", "点赞", "示例图", "下载量", "收藏数", "最近使用"]) {
    assert.ok(!html.includes(forbidden), `页面出现了未提供字段的假内容：${forbidden}`);
  }
});

test("/skills metadata：canonical 自指 /skills", () => {
  const canonical = (metadata.alternates as { canonical?: string } | undefined)?.canonical;
  assert.equal(canonical, `${SITE_URL}/skills`);
  assert.equal(metadata.openGraph?.url, `${SITE_URL}/skills`);
});

test("sitemap：收录 /skills、每条 /skills/<id> 与 /mcp", async () => {
  const entries = await sitemap();
  const urls = new Set(entries.map((entry) => entry.url));

  assert.ok(urls.has(`${SITE_URL}/skills`), "sitemap 缺 /skills");
  assert.ok(urls.has(`${SITE_URL}/mcp`), "sitemap 缺 /mcp");
  for (const skill of AGENT_SKILLS) {
    assert.ok(urls.has(`${SITE_URL}/skills/${skill.id}`), `sitemap 缺 /skills/${skill.id}`);
  }
  assert.equal(
    entries.filter((entry) => entry.url.startsWith(`${SITE_URL}/skills/`)).length,
    AGENT_SKILLS.length,
    "sitemap 里的技能详情页数必须等于内建技能总数",
  );
});
