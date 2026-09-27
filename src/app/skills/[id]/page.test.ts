// /skills/[id] 单技能页的真行为断言：
//   1. generateStaticParams 覆盖全部内建技能 id；
//   2. 真渲染：oneLiner / useScenario / inputType / outputContent / outputKind 中文标签 /
//      tags / 家族标签 / 每个 toolId 都在场；有 aesthetic 才渲染「美学锚」；
//   3. 查不到的 id 与私有技能 id 都走 notFound()（NEXT_HTTP_ERROR_FALLBACK;404）；
//   4. generateMetadata 的 canonical 自指该技能完整 URL，未知 id 返回空 metadata；
//   5. 不出现评分 / 使用次数 / 作者 / 收藏等未提供的假字段。
//
// 运行器沿用仓库既有约定（见 src/app/mcp/page.test.ts）：node:test + renderToStaticMarkup。

import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import SkillDetailPage, { generateMetadata, generateStaticParams } from "./page";
import { AGENT_SKILLS, AGENT_SKILL_FAMILY_LABELS } from "@/lib/agent-skills";
import type { AgentSkillView } from "@/lib/agent-skills/registry";
import { registerUserSkillSource } from "@/lib/agent-skills/registry";
import { OUTPUT_KIND_LABELS } from "../page";
import { getSiteUrlFromEnv } from "@/lib/site-url";

const SITE_URL = getSiteUrlFromEnv();

async function renderSkill(id: string): Promise<string> {
  const element = await SkillDetailPage({ params: Promise.resolve({ id }) });
  return renderToStaticMarkup(element);
}

const NOT_FOUND_DIGEST = "NEXT_HTTP_ERROR_FALLBACK;404";

test("generateStaticParams：覆盖全部内建技能 id，无重复", () => {
  const params = generateStaticParams();
  assert.equal(params.length, AGENT_SKILLS.length, "静态参数数必须等于内建技能总数");
  assert.equal(new Set(params.map((p) => p.id)).size, AGENT_SKILLS.length, "静态参数 id 不得重复");
  const ids = new Set(params.map((p) => p.id));
  for (const skill of AGENT_SKILLS) {
    assert.ok(ids.has(skill.id), `generateStaticParams 缺 ${skill.id}`);
  }
});

test("真渲染：spec 里真有的字段逐条在场，有 aesthetic 才渲染美学锚", async () => {
  const skill = AGENT_SKILLS.find((item) => item.aesthetic);
  assert.ok(skill, "必须存在带 aesthetic 的技能");

  const html = await renderSkill(skill.id);

  assert.ok(html.includes(skill.name), "缺名称");
  assert.ok(html.includes(skill.oneLiner), "缺 oneLiner");
  assert.ok(html.includes(skill.useScenario), "缺 useScenario");
  assert.ok(html.includes(skill.inputType), "缺 inputType");
  assert.ok(html.includes(skill.outputContent), "缺 outputContent");
  assert.ok(html.includes(OUTPUT_KIND_LABELS[skill.outputKind]), "缺 outputKind 中文标签");
  assert.ok(html.includes(AGENT_SKILL_FAMILY_LABELS[skill.family]), "缺家族标签");
  for (const tag of skill.tags) {
    assert.ok(html.includes(tag), `缺 tag ${tag}`);
  }
  for (const toolId of skill.toolIds) {
    assert.ok(html.includes(toolId), `缺 toolId ${toolId}`);
  }
  assert.ok(html.includes(skill.aesthetic), "有 aesthetic 时必须渲染美学锚");
  assert.ok(html.includes("美学锚"), "有 aesthetic 时必须出现「美学锚」小节");

  // 对照：无 aesthetic 的技能不得凭空多出这一节
  const plain = AGENT_SKILLS.find((item) => !item.aesthetic);
  assert.ok(plain, "必须存在不带 aesthetic 的技能");
  const plainHtml = await renderSkill(plain.id);
  assert.ok(!plainHtml.includes("美学锚"), "无 aesthetic 时不得渲染美学锚小节");
});

test("查不到的 id 走 notFound()（404 fallback，不是渲染空页）", async () => {
  await assert.rejects(
    () => SkillDetailPage({ params: Promise.resolve({ id: "no-such-skill-xyz" }) }),
    (error: unknown) => {
      assert.ok(error instanceof Error, "notFound 必须抛 Error");
      assert.equal((error as Error & { digest?: string }).digest, NOT_FOUND_DIGEST);
      return true;
    },
  );
});

test("私有技能 id 也走 notFound()：详情页只读 AGENT_SKILLS 这条公开真源", async () => {
  const privateSkill: AgentSkillView = {
    id: "user-private-sentinel-xyz",
    name: "私有哨兵技能",
    oneLiner: "不得出现在公开技能详情页",
    family: "script",
    useScenario: "边界断言",
    inputType: "无",
    outputContent: "无",
    outputKind: "text",
    toolIds: [],
    tags: [],
    source: "user",
  };
  registerUserSkillSource(async () => [privateSkill]);
  try {
    await assert.rejects(
      () => SkillDetailPage({ params: Promise.resolve({ id: privateSkill.id }) }),
      (error: unknown) => {
        assert.equal((error as Error & { digest?: string }).digest, NOT_FOUND_DIGEST);
        return true;
      },
    );
    // 同时确认这位哨兵的 metadata 也不会被生成
    const md = await generateMetadata({ params: Promise.resolve({ id: privateSkill.id }) });
    assert.deepEqual(md, {});
  } finally {
    registerUserSkillSource(async () => []);
  }
});

test("generateMetadata：canonical 自指该技能完整 URL；未知 id 回空", async () => {
  const skill = AGENT_SKILLS[0];
  const md = await generateMetadata({ params: Promise.resolve({ id: skill.id }) });
  const canonical = (md.alternates as { canonical?: string } | undefined)?.canonical;
  assert.equal(canonical, `${SITE_URL}/skills/${skill.id}`, "canonical 必须自指，不得继承首页");
  assert.equal(md.openGraph?.url, `${SITE_URL}/skills/${skill.id}`);

  const missing = await generateMetadata({ params: Promise.resolve({ id: "no-such-skill-xyz" }) });
  assert.deepEqual(missing, {});
});

test("诚实用词：详情页不出现评分 / 使用次数 / 点赞 等伪造元数据字段", async () => {
  const skill = AGENT_SKILLS[0];
  const html = await renderSkill(skill.id);
  // 只扫「一旦出现就只能是伪造元数据」的词；像「作者/收藏/热度」这些词本身就在真实技能
  // 文案里（作者风格、收藏感），拿它们做负向断言会误伤内容。
  for (const forbidden of ["评分", "使用次数", "点赞", "示例图", "下载量", "收藏数", "最近使用"]) {
    assert.ok(!html.includes(forbidden), `详情页出现了未提供字段的假内容：${forbidden}`);
  }
});
