import test from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_TEMPLATES,
  AGENT_TEMPLATE_DOMAIN_LABELS,
  type AgentTemplateDomain,
} from "./agent-templates/index.ts";
// 2026-09-12 首屏减重拆分：执行栏位（initialPrompt/directive/slots/步骤文案）与
// cropTemplate 在 payload 档；本档结构测试以合并后的 FULL 为准。
import { AGENT_TEMPLATES_FULL, AGENT_TEMPLATE_PAYLOADS, cropTemplate } from "./agent-templates-payload/index.ts";
import { recipeTemplateToRecallConfig } from "./recipe-templates.ts";
import { getStyleById } from "./style-library.ts";
// 诚实性红线（2026-09-30）：audio_first_timeline 的 speed 参数上游未支持、传入不生效，
// 产线文案不得反过来教 agent「超时就调语速」。本档一并扫 repo 侧镜像与页面文案。
import { WORKFLOW_TEMPLATES } from "../../deploy-staging/gateway/workflow-templates/index";
import { novelFilmPipelinePage } from "./workflow-pages/novel-film-pipeline.ts";
import { shortdramaVisualAssetsPage } from "./workflow-pages/shortdrama-visual-assets.ts";

const DOMAINS: AgentTemplateDomain[] = ["novel", "ecommerce", "shortdrama", "art"];
const QUALITY_PROFILES = ["draft", "balanced", "print"];

test("agent templates cover four domains with two pipeline blueprints each", () => {
  assert.equal(AGENT_TEMPLATES_FULL.length, 8);
  for (const domain of DOMAINS) {
    assert.equal(
      AGENT_TEMPLATES_FULL.filter((t) => t.domain === domain).length,
      2,
      `domain ${domain} should have exactly 2 templates`,
    );
  }
});

test("pipeline structure is complete: >=4 steps, deliverable + inputFrom + notes, gates present", () => {
  for (const template of AGENT_TEMPLATES_FULL) {
    const { pipeline } = template;
    assert.ok(pipeline.summary.length > 10, `${template.id} pipeline summary`);
    assert.ok(
      pipeline.steps.length >= 4,
      `${template.id} pipeline steps ${pipeline.steps.length} < 4`,
    );
    let gatedSteps = 0;
    for (const step of pipeline.steps) {
      assert.ok(step.name.length > 2, `${template.id} step name`);
      assert.ok(step.deliverable.length > 6, `${template.id} ${step.name} deliverable`);
      assert.ok(step.inputFrom.length > 6, `${template.id} ${step.name} inputFrom`);
      assert.ok(
        step.promptNotes.length >= 2 && step.promptNotes.every((n) => n.length > 6),
        `${template.id} ${step.name} promptNotes`,
      );
      if (step.gate !== undefined) {
        assert.ok(step.gate.length > 6, `${template.id} ${step.name} gate`);
        gatedSteps += 1;
      }
    }
    assert.ok(gatedSteps >= 2, `${template.id} pipeline should have >=2 gated steps`);
    // 衔接关系存在：至少一半步骤显式声明上一步产出如何喂入
    const linked = pipeline.steps.filter((s) => /JSON|cref|sref|参考|注入|锚|门禁|批准|锁定|源图|对拍|seed/i.test(s.inputFrom));
    assert.ok(
      linked.length >= Math.ceil(pipeline.steps.length / 2),
      `${template.id} pipeline inputFrom linkage too weak`,
    );
  }
});

test("card copy is present and within reasonable length", () => {
  for (const template of AGENT_TEMPLATES_FULL) {
    assert.ok(template.name.length >= 3 && template.name.length <= 6, `${template.id} name length`);
    assert.ok(template.note.length > 6, `${template.id} note`);
    assert.ok(template.painPoint.length > 6, `${template.id} painPoint`);
    assert.ok(
      template.initialPrompt.length >= 30 && template.initialPrompt.length <= 80,
      `${template.id} initialPrompt length ${template.initialPrompt.length}`,
    );
    // 卡面海报区渐变（2026-08-25 视觉主体）：8 张都必须有 Tailwind 三色类。
    assert.match(template.accent, /^from-\[#/, `${template.id} accent gradient class`);
    assert.match(template.accent, /via-\[#/);
    assert.match(template.accent, /to-\[#/);
  }
});

test("ids are unique and follow agent-<domain>-<slug> naming", () => {
  const ids = AGENT_TEMPLATES_FULL.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const template of AGENT_TEMPLATES_FULL) {
    assert.match(template.id, new RegExp(`^agent-${template.domain}-[a-z][a-z0-9-]*$`));
  }
});

test("every template converts to a recall config with non-empty prompt", () => {
  for (const template of AGENT_TEMPLATES_FULL) {
    const config = recipeTemplateToRecallConfig(template);
    assert.ok(config.prompt.length > 10, `${template.id} prompt`);
    if (template.slots.contextPrompt) assert.equal(config.contextPrompt, template.slots.contextPrompt);
    if (template.slots.negativePrompt) assert.equal(config.negativePrompt, template.slots.negativePrompt);
    if (template.slots.composition?.length) {
      assert.deepEqual(
        config.regionalPrompts?.map((item) => item.text),
        template.slots.composition,
      );
    }
    if (template.slots.styleTemplateId) {
      assert.equal(config.styleTemplate, template.slots.styleTemplateId);
    }
    if (template.slots.qualityProfile) {
      assert.equal(config.qualityProfile, template.slots.qualityProfile);
    }
  }
});

test("styleTemplateId references existing style-library entries and qualityProfile is valid", () => {
  for (const template of AGENT_TEMPLATES_FULL) {
    if (template.slots.styleTemplateId) {
      assert.ok(
        getStyleById(template.slots.styleTemplateId),
        `${template.id} styleTemplateId ${template.slots.styleTemplateId} not in style-library`,
      );
    }
    if (template.slots.qualityProfile) {
      assert.ok(
        QUALITY_PROFILES.includes(template.slots.qualityProfile),
        `${template.id} qualityProfile ${template.slots.qualityProfile}`,
      );
    }
  }
});

test("domain labels cover all domains used by templates", () => {
  assert.deepEqual([...DOMAINS], Object.keys(AGENT_TEMPLATE_DOMAIN_LABELS));
  assert.deepEqual(
    new Set(AGENT_TEMPLATES_FULL.map((t) => t.domain)),
    new Set(DOMAINS),
  );
});

// ———— 2026-08-25 工具链绑定：requiredTools 必须指向真实 registry，不许假装能力 ————
// ———— 2026-08-31 产品诚实稽核：判定集真源从「站内 domain registry 自我认证」
//      换血为「harness 真实工具面」（harness-tool-registry.ts，
//      源 = VPS /opt/eimu-harness/workspace/.opencode/tools/）。————

import { HARNESS_TOOL_IDS } from "./harness-tool-registry.ts";

test("toolchain binding: every step declares >=1 requiredTools (工业级可执行工具链)", () => {
  for (const template of AGENT_TEMPLATES_FULL) {
    assert.ok(
      template.pipeline.steps.length >= 7,
      `${template.id} 应为 >=7 步的 SOTA 流水线（实际 ${template.pipeline.steps.length}）`,
    );
    for (const step of template.pipeline.steps) {
      assert.ok(
        Array.isArray(step.requiredTools) && step.requiredTools.length >= 1,
        `${template.id} / ${step.name} 缺少 requiredTools`,
      );
    }
  }
});

test("toolchain binding: available tool ids must exist in the harness tool surface", () => {
  for (const template of AGENT_TEMPLATES_FULL) {
    for (const step of template.pipeline.steps) {
      for (const tool of step.requiredTools ?? []) {
        if (!tool.unsupported) {
          assert.ok(
            HARNESS_TOOL_IDS.has(tool.id),
            `${template.id} / ${step.name} 引用 harness 未注册工具 ${tool.id} 且未标 unsupported`,
          );
        }
      }
    }
  }
});

test("toolchain binding: unsupported marks must be stale-free (harness 已实装的不许继续装死)", () => {
  for (const template of AGENT_TEMPLATES_FULL) {
    for (const step of template.pipeline.steps) {
      for (const tool of step.requiredTools ?? []) {
        if (tool.unsupported) {
          assert.ok(
            !HARNESS_TOOL_IDS.has(tool.id),
            `${template.id} / ${step.name} 工具 ${tool.id} 标 unsupported 但 harness 真源已实装，标记过期须移除`,
          );
        }
      }
    }
  }
});

test("toolchain binding: unsupported tools must not fake availability", () => {
  for (const template of AGENT_TEMPLATES_FULL) {
    for (const step of template.pipeline.steps) {
      for (const tool of step.requiredTools ?? []) {
        if (tool.unsupported) {
          // 未接上游的意图工具必须给出 requiredCapability，让 harness 知道缺什么
          assert.ok(
            tool.requiredCapability !== undefined,
            `${template.id} / ${step.name} 工具 ${tool.id} 标 unsupported 但没说明 requiredCapability`,
          );
        }
      }
    }
  }
});

test("toolchain binding: every template has >=3 gates (门禁是工业级 workflow 的硬性要求)", () => {
  for (const template of AGENT_TEMPLATES_FULL) {
    const gated = template.pipeline.steps.filter((step) => Boolean(step.gate)).length;
    assert.ok(gated >= 3, `${template.id} 门禁数 ${gated} < 3`);
  }
});

test("toolchain binding: expanded canvas cards reach industrial density (>=35)", () => {
  for (const template of AGENT_TEMPLATES_FULL) {
    let cards = 0;
    for (const step of template.pipeline.steps) {
      const deliverables = step.deliverable.split(/[+＋、;；]/).filter((part) => part.trim().length > 1);
      cards += Math.max(1, deliverables.length);
      cards += step.promptNotes.length;
      if (step.gate) cards += 1;
      cards += 1; // 每步至少一张生成卡
    }
    assert.ok(
      cards >= 35,
      `${template.id} 展开后约 ${cards} 张卡，未达工业级密度（>=35）`,
    );
  }
});

// ———— 2026-08-26 环节选择：shortName 锁表 + cropTemplate ————

/** 环节短名表（产品裁定，照抄禁止自创）：步骤原名 → 圆环显示短名。 */
const SHORT_NAME_TABLE: Record<string, string> = {
  // 小说影视化
  拆解剧本: "剧本", 建角色圣经: "角色卡", 定美术圣经: "美术卡", 锁定分镜: "分镜",
  渲染关键帧: "关键帧", 合成镜头视频: "视频", 配音配乐: "配音", 组装成片: "成片",
  // IP视觉包
  拆解世界观: "世界观", 炼情绪板: "情绪板", 铸风格锚: "风格锚", 建主角资产: "主角卡",
  绘名场面组图: "名场面", 造封面主视觉: "封面", 出多画幅: "多画幅", 铺衍生物料: "物料",
  // 新品上市包
  锁产品: "产品卡", 铺场景包: "场景包", 出模特图: "模特图", 出主视觉: "主视觉",
  排详情页: "详情页", 批量出画幅: "画幅", 放大精修: "精修", 审终交付: "交付",
  // 模特种草线
  抠取服装资产: "服装", 选定模特人设: "模特卡", 上身虚拟试穿: "试穿", 精修试穿质感: "质感",
  拍齐九宫格: "九宫格", 排版详情页: "详情页", 适配分发尺寸: "分发",
  // 剧本视觉化
  铸造主演资产: "主演卡", 合成配音: "配音", 生成镜头视频: "视频", 剪辑成片: "成片",
  产出投放物料: "物料",
  // 3D 白模预演（小说影视化 + 剧本视觉化共用，2026-09-03 导演台接入）
  "3D 白模预演": "预演",
  // 投放海报线
  锚定视觉基调: "基调", 提炼主演海报: "海报", 排布CP对戏图: "对戏",
  切片封面批量: "切片", 生成变体测试包: "变体", 回流迭代风格: "迭代", 锁定交付参数: "参数",
  // 策展式创作
  立意结构化: "立意", 发散收情绪板: "情绪板", 锁定构图稿: "构图稿", 成组渲染: "渲染",
  审计一致性: "审计", 布置展陈主视觉: "展陈", 交付多规格: "多规格",
  // 风格深研线
  采代表作: "代表作", 拆DNA: "DNA", 签解构表: "解构表", 拍临摹对照: "临摹",
  跑变体矩阵: "变体", 试LoRA: "LoRA", 做原创成组: "原创", 归档证物链: "证物链",
};

test("every step carries a shortName matching the locked table, unique within its template", () => {
  for (const template of AGENT_TEMPLATES_FULL) {
    const seen = new Set<string>();
    for (const step of template.pipeline.steps) {
      assert.equal(
        step.shortName,
        SHORT_NAME_TABLE[step.name],
        `${template.id} / ${step.name} shortName 偏离锁表`,
      );
      // 圆环短名统一 2-3 字（2026-08-26 视觉模型三审：治排版节奏不均）；LoRA 为 4 字符拉丁特例。
      assert.ok(
        step.shortName.length >= 2 && step.shortName.length <= 5,
        `${template.id} / ${step.name} shortName「${step.shortName}」长度 ${step.shortName.length}`,
      );
      assert.ok(!seen.has(step.shortName), `${template.id} shortName 重复：${step.shortName}`);
      seen.add(step.shortName);
    }
  }
});

test("cropTemplate: empty or full selection returns the original template (zero copy)", () => {
  const template = AGENT_TEMPLATES_FULL[0];
  const all = template.pipeline.steps.map((_, i) => i);
  assert.equal(cropTemplate(template, []), template);
  assert.equal(cropTemplate(template, all), template);
  // 去重后的全选（含重复 index）同样命中零拷贝短路，不产生新对象。
  assert.equal(cropTemplate(template, [...all, ...all]), template);
});

test("cropTemplate: subset keeps only selected steps and appends scope notes", () => {
  const template = AGENT_TEMPLATES_FULL[0];
  // 2026-09-03 插入「3D 白模预演」（index 4）后，「成片」由 7 移到 8；采样语义不变（首/中/末步）。
  const cropped = cropTemplate(template, [0, 3, 8]);
  assert.notEqual(cropped, template);
  assert.deepEqual(cropped.pipeline.steps, [
    template.pipeline.steps[0],
    template.pipeline.steps[3],
    template.pipeline.steps[8],
  ]);
  assert.equal(cropped.pipeline.summary, template.pipeline.summary);
  const shortNames = ["剧本", "分镜", "成片"];
  assert.equal(
    cropped.initialPrompt,
    `${template.initialPrompt}\n本次只执行这些环节：${shortNames.join("、")}。`,
  );
  assert.equal(
    cropped.directive,
    `${template.directive}\n本次执行范围已裁剪：只做 ${shortNames.join("、")}，不要碰未选中的环节。`,
  );
  // 其余字段原样继承。
  assert.equal(cropped.id, template.id);
  assert.equal(cropped.slots, template.slots);
  assert.equal(cropped.accent, template.accent);
  assert.equal(cropped.glow, template.glow);
});

test("cropTemplate: dedupes, sorts ascending, and drops out-of-range indices", () => {
  const template = AGENT_TEMPLATES_FULL[0];
  const cropped = cropTemplate(template, [8, 3, 3, 99, 0, -1]);
  assert.deepEqual(cropped.pipeline.steps, [
    template.pipeline.steps[0],
    template.pipeline.steps[3],
    template.pipeline.steps[8],
  ]);
  // 追加文案按去重排序后的 shortName 生成，与保留的 steps 一一对应。
  assert.ok(cropped.initialPrompt.endsWith("本次只执行这些环节：剧本、分镜、成片。"));
  assert.ok(cropped.directive.endsWith("本次执行范围已裁剪：只做 剧本、分镜、成片，不要碰未选中的环节。"));
});

test("cropTemplate: every template appends scope notes listing exactly the selected shortNames", () => {
  for (const template of AGENT_TEMPLATES_FULL) {
    const selected = [1, 3, 5];
    const cropped = cropTemplate(template, selected);
    const names = selected.map((i) => template.pipeline.steps[i].shortName).join("、");
    // 追加的是 shortName（圆环名字）不是步骤原名黑话；且只追加在原文之后。
    assert.equal(
      cropped.initialPrompt.slice(template.initialPrompt.length),
      `\n本次只执行这些环节：${names}。`,
      `${template.id} initialPrompt 范围说明`,
    );
    assert.equal(
      cropped.directive.slice(template.directive.length),
      `\n本次执行范围已裁剪：只做 ${names}，不要碰未选中的环节。`,
      `${template.id} directive 范围说明`,
    );
  }
});

test("cropTemplate: every built-in template crops to a valid pipeline for the canvas", () => {
  for (const template of AGENT_TEMPLATES_FULL) {
    const selected = template.pipeline.steps.map((_, i) => i).filter((i) => i % 2 === 0);
    const cropped = cropTemplate(template, selected);
    assert.equal(cropped.pipeline.steps.length, selected.length, template.id);
    for (const step of cropped.pipeline.steps) {
      assert.ok(step.shortName.length > 0, template.id);
    }
  }
});

// ———— 2026-09-03 3D 白模预演接入：两大影视模板在「锁定分镜」后进导演台预演 ————

test("director preview step: novel/shortdrama insert 3D 白模预演 between 锁定分镜 and 渲染关键帧 with director toolchain", () => {
  const EXPECTED_TOOLS = [
    "director_get_state",
    "director_propose_plans",
    "director_apply_proposal",
    "director_manage_shot",
    "director_upsert_action",
  ];
  for (const templateId of ["agent-novel-film-pipeline", "agent-shortdrama-visual-assets"]) {
    const template = AGENT_TEMPLATES_FULL.find((t) => t.id === templateId);
    assert.ok(template, `${templateId} 存在`);
    const steps = template!.pipeline.steps;
    const prevIdx = steps.findIndex((s) => s.name === "锁定分镜");
    const stepIdx = steps.findIndex((s) => s.name === "3D 白模预演");
    const nextIdx = steps.findIndex((s) => s.name === "渲染关键帧");
    assert.ok(prevIdx >= 0, `${templateId} 有「锁定分镜」步`);
    assert.ok(nextIdx >= 0, `${templateId} 有「渲染关键帧」步`);
    assert.ok(
      prevIdx < stepIdx && stepIdx < nextIdx,
      `${templateId} 预演步须夹在锁定分镜与渲染关键帧之间（实际 ${prevIdx}/${stepIdx}/${nextIdx}）`,
    );
    const step = steps[stepIdx];
    assert.equal(step.outputKind, "director", `${templateId} 预演步 outputKind=director`);
    assert.equal(step.shortName, "预演", `${templateId} 预演步 shortName`);
    assert.ok(step.deliverable.includes("白模预演"), `${templateId} 预演步 deliverable`);
    assert.ok(step.promptNotes.length >= 2, `${templateId} 预演步 promptNotes`);
    assert.deepEqual(
      (step.requiredTools ?? []).map((t) => t.id),
      EXPECTED_TOOLS,
      `${templateId} 预演步 requiredTools 逐字对齐 harness 工具面`,
    );
    for (const id of EXPECTED_TOOLS) {
      assert.ok(HARNESS_TOOL_IDS.has(id), `${templateId} 工具 ${id} 须在 harness 真源`);
    }
    assert.ok(template!.directive.includes("3D 白模预演"), `${templateId} directive 应含预演环节指导`);
    assert.ok(template!.directive.includes("director_propose_plans"), `${templateId} directive 应点名导演台工具`);
  }
});

// ———— 2026-09-12 首屏减重拆分：显示档必须零执行文案（防再膨胀闸）————

const EXEC_STEP_FIELDS = ["deliverable", "inputFrom", "promptNotes", "gate", "requiredTools"] as const;
const EXEC_TPL_FIELDS = ["initialPrompt", "directive", "slots"] as const;

test("display file carries zero execution payload (首屏消重硬闸)", () => {
  for (const card of AGENT_TEMPLATES) {
    for (const f of EXEC_TPL_FIELDS) {
      assert.ok(
        !(f in card),
        `${card.id} 显示卡不该有执行栏位「${f}」——会把大段文案链进首屏 app/page chunk`,
      );
    }
    for (const step of card.pipeline.steps) {
      for (const f of EXEC_STEP_FIELDS) {
        assert.ok(
          !(f in step),
          `${card.id} / ${step.name} 显示步骤不该有执行栏位「${f}」`,
        );
      }
    }
  }
});

test("every display card hydrates: payload ids and step counts align (拆分两档防漂移)", () => {
  const payloadIds = Object.keys(AGENT_TEMPLATE_PAYLOADS);
  assert.deepEqual(
    [...AGENT_TEMPLATES.map((t) => t.id)].sort(),
    [...payloadIds].sort(),
    "显示档与 payload 档模板 id 必须一比一",
  );
  for (const card of AGENT_TEMPLATES) {
    const payload = AGENT_TEMPLATE_PAYLOADS[card.id];
    assert.ok(payload, `${card.id} 缺 payload`);
    assert.equal(
      payload.steps.length,
      card.pipeline.steps.length,
      `${card.id} 步骤数漂移：显示 ${card.pipeline.steps.length} vs payload ${payload.steps.length}`,
    );
    assert.ok(payload.initialPrompt.length >= 30, `${card.id} payload initialPrompt`);
    assert.ok(payload.directive.length > 10, `${card.id} payload directive`);
    assert.ok(Object.keys(payload.slots).length > 0, `${card.id} payload slots`);
  }
  // FULL = 显示 ∪ payload，合并后执行栏位回齐。
  assert.equal(AGENT_TEMPLATES_FULL.length, AGENT_TEMPLATES.length);
  const full0 = AGENT_TEMPLATES_FULL[0];
  assert.ok(typeof full0.initialPrompt === "string" && full0.initialPrompt.length > 0);
  assert.ok(Array.isArray(full0.pipeline.steps[0].promptNotes));
});

// 诚实性红线（2026-09-30）：TTS 时长对齐不得教 agent 调语速。
// 现场事实：audio_first_timeline 的 speed 参数字面标注「当前上游未支持，传入不生效」，
// 而 harness-tool-registry 记载该工具是「gateway /agent/v1/tts 逐行真 TTS + ffprobe 实测」。
// 所以 agent 真正捏得动的只有两头：① 改短台词文本再逐句重出 ② 调镜头计画秒数（durationSeconds）。
// 教「微调语速」＝教工具做不到的事，agent 只会幻觉或空转。此断言扫全部相关文案本体。
test("配音时长对齐文案不得教 agent 调语速（speed 上游不生效），且必须留下做得到的替代路", () => {
  const corpus: ReadonlyArray<readonly [string, string]> = [
    ["agent-templates-payload（novel/shortdrama 全文）", JSON.stringify(AGENT_TEMPLATES_FULL)],
    ["deploy-staging workflow-templates（gateway 镜像全文）", JSON.stringify(WORKFLOW_TEMPLATES)],
    ["workflow-pages novel-film-pipeline", JSON.stringify(novelFilmPipelinePage)],
    ["workflow-pages shortdrama-visual-assets", JSON.stringify(shortdramaVisualAssetsPage)],
  ];
  // 暗示「语速可调」的字眼（简繁都涵盖）；出现任一即红。
  const forbiddenSpeedPhrases = [
    "微调语速",
    "微调语速",
    "调语速",
    "调语速",
    "调整语速",
    "调整语速",
    "语速对齐",
    "语速对齐",
    "语速锁",
    "语速锁",
  ];
  for (const [label, text] of corpus) {
    for (const phrase of forbiddenSpeedPhrases) {
      assert.ok(
        !text.includes(phrase),
        `${label} 不得出现「${phrase}」：speed 参数上游不生效，调语速是工具做不到的事（教不会的指令 ⇒ 幻觉或空转）`,
      );
    }
    // 反向：必须真的留下两条做得到的路 + 明说不生效，而不是删句子了事。
    assert.ok(text.includes("不生效"), `${label} 必须明说 speed 传入不生效（不得让 agent 误以为可调速）`);
    assert.ok(text.includes("改短"), `${label} 必须保留「改短台词再逐句重出」这条做得到的替代路`);
  }
});

// ── H15：OP/MV 题材不得落竖屏短剧模板 ──
import { resolveHarnessTemplateId, isMvOpTopic } from "./agent-templates/index.ts";

test("H15: OP/MV topics never resolve to vertical shortdrama_visual", () => {
  for (const t of ["我想要日漫风格的百合番MV片头曲 有卡点", "做一支 OP", "角色歌 MV", "music video for my band"]) {
    assert.equal(isMvOpTopic(t), true, t);
    assert.equal(resolveHarnessTemplateId("shortdrama_visual", t), "feature_film", t);
  }
  const ff = WORKFLOW_TEMPLATES.find((x) => x.id === "feature_film");
  assert.ok(ff, "feature_film exists as landscape fallback");
});

test("H15: real shortdrama topics, explicit vertical, and other templates are untouched", () => {
  assert.equal(resolveHarnessTemplateId("shortdrama_visual", "把我的短剧剧本做成视觉资产包"), "shortdrama_visual");
  assert.equal(resolveHarnessTemplateId("shortdrama_visual", "竖屏 MV 切片"), "shortdrama_visual");
  assert.equal(resolveHarnessTemplateId("novel_film", "MV"), "novel_film");
  assert.equal(resolveHarnessTemplateId(undefined, "MV"), undefined);
});

test("H15: shortdrama payload directive carries the MV/OP guard", () => {
  const t = AGENT_TEMPLATES_FULL.find((x) => x.id === "agent-shortdrama-visual-assets");
  assert.ok(t && /feature_film/.test(t.directive) && /OP\/MV/.test(t.directive));
});
