import test from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_TEMPLATES,
  AGENT_TEMPLATE_DOMAIN_LABELS,
  type AgentTemplateDomain,
} from "./agent-templates/index.ts";
// 2026-09-12 首屏減重拆分：執行欄位（initialPrompt/directive/slots/步驟文案）與
// cropTemplate 在 payload 檔；本檔結構測試以合併後的 FULL 為準。
import { AGENT_TEMPLATES_FULL, AGENT_TEMPLATE_PAYLOADS, cropTemplate } from "./agent-templates-payload/index.ts";
import { recipeTemplateToRecallConfig } from "./recipe-templates.ts";
import { getStyleById } from "./style-library.ts";

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
    // 卡面海報區漸變（2026-08-25 視覺主體）：8 張都必須有 Tailwind 三色類。
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

// ———— 2026-08-25 工具鏈綁定：requiredTools 必須指向真實 registry，不許假裝能力 ————
// ———— 2026-08-31 產品誠實稽核：判定集真源從「站內 domain registry 自我認證」
//      換血為「harness 真實工具面」（harness-tool-registry.ts，
//      源 = VPS /opt/agent-harness/workspace/.opencode/tools/）。————

import { HARNESS_TOOL_IDS } from "./harness-tool-registry.ts";

test("toolchain binding: every step declares >=1 requiredTools (工业级可执行工具链)", () => {
  for (const template of AGENT_TEMPLATES_FULL) {
    assert.ok(
      template.pipeline.steps.length >= 7,
      `${template.id} 應為 >=7 步的 SOTA 流水線（實際 ${template.pipeline.steps.length}）`,
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
          // 未接上游的意圖工具必須給出 requiredCapability，讓 harness 知道缺什麼
          assert.ok(
            tool.requiredCapability !== undefined,
            `${template.id} / ${step.name} 工具 ${tool.id} 標 unsupported 但沒說明 requiredCapability`,
          );
        }
      }
    }
  }
});

test("toolchain binding: every template has >=3 gates (门禁是工業級 workflow 的硬性要求)", () => {
  for (const template of AGENT_TEMPLATES_FULL) {
    const gated = template.pipeline.steps.filter((step) => Boolean(step.gate)).length;
    assert.ok(gated >= 3, `${template.id} 門禁數 ${gated} < 3`);
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
      cards += 1; // 每步至少一張生成卡
    }
    assert.ok(
      cards >= 35,
      `${template.id} 展開後約 ${cards} 張卡，未達工業級密度（>=35）`,
    );
  }
});

// ———— 2026-08-26 環節選擇：shortName 鎖表 + cropTemplate ————

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
  // 2026-09-03 插入「3D 白模预演」（index 4）後，「成片」由 7 移到 8；採樣語義不變（首/中/末步）。
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

// ———— 2026-09-03 3D 白模预演接入：兩大影視模板在「锁定分镜」后进导演台预演 ————

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
      `${templateId} 预演步 requiredTools 逐字對齊 harness 工具面`,
    );
    for (const id of EXPECTED_TOOLS) {
      assert.ok(HARNESS_TOOL_IDS.has(id), `${templateId} 工具 ${id} 须在 harness 真源`);
    }
    assert.ok(template!.directive.includes("3D 白模预演"), `${templateId} directive 应含预演环节指导`);
    assert.ok(template!.directive.includes("director_propose_plans"), `${templateId} directive 应点名导演台工具`);
  }
});

// ———— 2026-09-12 首屏減重拆分：顯示檔必須零執行文案（防再膨脹閘）————

const EXEC_STEP_FIELDS = ["deliverable", "inputFrom", "promptNotes", "gate", "requiredTools"] as const;
const EXEC_TPL_FIELDS = ["initialPrompt", "directive", "slots"] as const;

test("display file carries zero execution payload (首屏消重硬閘)", () => {
  for (const card of AGENT_TEMPLATES) {
    for (const f of EXEC_TPL_FIELDS) {
      assert.ok(
        !(f in card),
        `${card.id} 顯示卡不該有執行欄位「${f}」——會把大段文案鏈進首屏 app/page chunk`,
      );
    }
    for (const step of card.pipeline.steps) {
      for (const f of EXEC_STEP_FIELDS) {
        assert.ok(
          !(f in step),
          `${card.id} / ${step.name} 顯示步驟不該有執行欄位「${f}」`,
        );
      }
    }
  }
});

test("every display card hydrates: payload ids and step counts align (拆分兩檔防漂移)", () => {
  const payloadIds = Object.keys(AGENT_TEMPLATE_PAYLOADS);
  assert.deepEqual(
    [...AGENT_TEMPLATES.map((t) => t.id)].sort(),
    [...payloadIds].sort(),
    "顯示檔與 payload 檔模板 id 必須一比一",
  );
  for (const card of AGENT_TEMPLATES) {
    const payload = AGENT_TEMPLATE_PAYLOADS[card.id];
    assert.ok(payload, `${card.id} 缺 payload`);
    assert.equal(
      payload.steps.length,
      card.pipeline.steps.length,
      `${card.id} 步驟數漂移：顯示 ${card.pipeline.steps.length} vs payload ${payload.steps.length}`,
    );
    assert.ok(payload.initialPrompt.length >= 30, `${card.id} payload initialPrompt`);
    assert.ok(payload.directive.length > 10, `${card.id} payload directive`);
    assert.ok(Object.keys(payload.slots).length > 0, `${card.id} payload slots`);
  }
  // FULL = 顯示 ∪ payload，合併後執行欄位回齊。
  assert.equal(AGENT_TEMPLATES_FULL.length, AGENT_TEMPLATES.length);
  const full0 = AGENT_TEMPLATES_FULL[0];
  assert.ok(typeof full0.initialPrompt === "string" && full0.initialPrompt.length > 0);
  assert.ok(Array.isArray(full0.pipeline.steps[0].promptNotes));
});
