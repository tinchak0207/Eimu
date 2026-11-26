import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  KUNPENG_SOURCE,
  KUNPENG_STYLE_ASSETS,
  KUNPENG_STYLE_CATEGORY_LABELS,
  buildKunpengStylePrompt,
  getKunpengStyleById,
  kunpengStyleSummary,
} from "./kunpeng-style-assets.ts";
import {
  KUNPENG_PROMPT_TEMPLATES,
} from "./kunpeng-prompt-templates.ts";
import {
  KUNPENG_KNOWLEDGE_SECTIONS,
  KUNPENG_SEEDANCE_RECONCILIATION,
  KUNPENG_SKILL_AUDIT,
  buildKunpengKnowledgeInjection,
} from "./kunpeng-knowledge.ts";
import { KUNPENG_SEEDANCE_SUPPLEMENT, PROMPT_DIRECTOR_SYSTEM_PROMPT } from "./agent-prompt-director.ts";

/**
 * 鲲鹏资产接入契约（2026-08-27）：
 * - 161 条风格四件套逐字（源 index.json 原样导入，仅白名单接入字段）
 * - 来源声明 pin commit + MIT
 * - 缩略图不导入（thumbnail 字段仅溯源）
 * - 注入文本不得出现我们后端没有的工具名（断链红线）
 */

test("kunpeng style library ships all 161 styles verbatim with pinned source", () => {
  assert.equal(KUNPENG_SOURCE.sourceName, "pengfeiqiao/kunpeng");
  assert.equal(KUNPENG_SOURCE.sourceUrl, "https://github.com/pengfeiqiao/kunpeng");
  assert.equal(KUNPENG_SOURCE.sourceCommit, "872a58b");
  assert.equal(KUNPENG_SOURCE.license, "MIT");

  assert.equal(KUNPENG_STYLE_ASSETS.length, 161, "风格库必须整 161 条");
  const categories = new Set(KUNPENG_STYLE_ASSETS.map((style) => style.category));
  assert.deepEqual([...categories].sort(), ["2d-animation", "live-action"]);
  assert.equal(KUNPENG_STYLE_CATEGORY_LABELS["live-action"], "真人风格");
  assert.equal(KUNPENG_STYLE_CATEGORY_LABELS["2d-animation"], "2D风格");

  // id 唯一；四件套全部非空（逐字完整性的形状校验）
  const ids = new Set(KUNPENG_STYLE_ASSETS.map((style) => style.id));
  assert.equal(ids.size, 161);
  for (const style of KUNPENG_STYLE_ASSETS) {
    assert.ok(style.name.length > 0, style.id);
    assert.ok(style.promptTemplate.length > 0, style.id);
    assert.ok(style.visualDNA.length > 0, style.id);
    assert.ok(style.cameraLanguage.length > 0, style.id);
    assert.ok(style.promptSuffix.length > 0, style.id);
  }
});

test("kunpeng style data is byte-identical to the vendored source json", (t) => {
  // 原样导入铁证：数据文件与源仓库 index.json 逐字节一致（四件套不可能被改写）。
  // 源仓候选：/tmp/kp-assets（vendoring 时的临时 checkout）→ ~/Desktop/kunpeng-vendor（持久轮子仓）。
  // 两者皆缺（如 CI/新机器）= 无法对证源仓，如实 skip 不谎报通过。
  const candidates = [
    "/tmp/kp-assets/aigc-memory/style-library/index.json",
    join(process.env.HOME ?? "", "Desktop/kunpeng-vendor/aigc-memory/style-library/index.json"),
  ];
  const sourcePath = candidates.find((p) => {
    try { readFileSync(p); return true; } catch { return false; }
  });
  if (!sourcePath) { t.skip("kunpeng 源仓不在本机（/tmp/kp-assets 与 ~/Desktop/kunpeng-vendor 皆缺）"); return; }
  const source = readFileSync(sourcePath, "utf8");
  const vendored = readFileSync(join(process.cwd(), "src/data/kunpeng-style-library.json"), "utf8");
  assert.equal(vendored, source);
  const parsed = JSON.parse(vendored) as { styles: Array<Record<string, string>> };
  assert.equal(parsed.styles.length, KUNPENG_STYLE_ASSETS.length);
  for (let index = 0; index < parsed.styles.length; index += 1) {
    const raw = parsed.styles[index];
    const asset = KUNPENG_STYLE_ASSETS[index];
    assert.equal(asset.id, raw.id);
    assert.equal(asset.name, raw.name);
    assert.equal(asset.promptTemplate, raw.promptTemplate);
    assert.equal(asset.visualDNA, raw.visualDNA);
    assert.equal(asset.cameraLanguage, raw.cameraLanguage);
    assert.equal(asset.promptSuffix, raw.promptSuffix);
  }
});

test("kunpeng style thumbnails are never imported as renderable assets", () => {
  // 298M jpg + 商用授权未确认：缩略图字段仅保留源路径做溯源，UI 不导入不渲染。
  for (const style of KUNPENG_STYLE_ASSETS) {
    assert.match(style.thumbnail, /^(live-action|2d-animation)\//);
  }
  // 面板代码不允许出现任何指向源缩略图的 URL 或本地图片引用。
  const panel = readFileSync(join(process.cwd(), "src/components/pro-workstation/CreatorResourcePanel.tsx"), "utf8");
  assert.doesNotMatch(panel, /thumbnail|\.jpg|raw\.githubusercontent.*kunpeng|kp-assets/);
});

test("style apply helpers compose the four-part text without rewriting it", () => {
  const first = KUNPENG_STYLE_ASSETS[0];
  const prompt = buildKunpengStylePrompt(first);
  assert.ok(prompt.includes(first.promptSuffix));
  assert.ok(prompt.includes(first.visualDNA));
  assert.ok(prompt.includes(first.cameraLanguage));
  // 首条（Wes Anderson 布达佩斯大饭店）摘要来自 visualDNA 首行，非编造。
  const summary = kunpengStyleSummary(first);
  assert.match(summary, /色调/);
  assert.equal(getKunpengStyleById(first.id)?.name, first.name);
  assert.equal(getKunpengStyleById("nonexistent"), undefined);
});

test("kunpeng prompt templates expose seedance and gpt-image-2 single-shot verbatim", () => {
  const ids = KUNPENG_PROMPT_TEMPLATES.map((template) => template.id);
  assert.ok(ids.includes("kunpeng-seedance-single-shot"));
  assert.ok(ids.includes("kunpeng-gpt-image-2-single-shot"));

  const seedance = KUNPENG_PROMPT_TEMPLATES.find((t) => t.id === "kunpeng-seedance-single-shot")!;
  // 四层组织、符号规范、@图片N、多主体定义、realPersonMode 逐字存在
  assert.match(seedance.body, /官方四层顺序组织/);
  assert.match(seedance.body, /\| 台词 \| `\{\}` \|/);
  assert.match(seedance.body, /\| 音效 \| `<>` \|/);
  assert.match(seedance.body, /@图片一/);
  assert.match(seedance.body, /将@图片N中的\[2-3个稳定静态特征\]定义为<主体N>/);
  assert.match(seedance.body, /realPersonMode/);
  assert.match(seedance.body, /用@音频一的音色/);
  // 白名单改写：CLI 与 bytedance 端点必须已剔除
  assert.doesNotMatch(seedance.body, /runninghub|python3|--api-key|bytedance\/seedance/);
  for (const template of KUNPENG_PROMPT_TEMPLATES) {
    assert.equal(template.sourceCommit, "872a58b");
    assert.equal(template.license, "MIT");
  }
});

test("kunpeng knowledge sections wire own video tools and still reject external-only tooling", () => {
  const ids = KUNPENG_KNOWLEDGE_SECTIONS.map((section) => section.id);
  assert.deepEqual(ids, [
    "kunpeng-pre-generation-checklist",
    "kunpeng-shot-patterns",
    "kunpeng-reference-image-rules",
    "kunpeng-script-doctor",
    "kunpeng-film-master",
    "kunpeng-scene-image-anchor",
    "kunpeng-storyboard-sketch",
    "kunpeng-video-style-replication",
  ]);

  const injection = buildKunpengKnowledgeInjection();
  // 断链红线（2026-09-28 松绑后仍有底线）：知识正文绝不教会模型调用**我们后端没有的外部工具**。
  //   - 松绑：`ffmpeg` 与本站自己的影片工具名（video_evidence / video_transcribe / video_measure /
  //     video_fetch）现在**允许**出现在正文里——2026-09-28 起这三支影片取证/转写/量测工具已在
  //     harness 交付（本地登记见 harness-tool-registry.ts），正文教的动作确实做得到了；
  //     旧红线的 `ffmpeg` 禁字是因为当时「无 ffmpeg 工具」才立的，理由已不成立（留字面禁令会逼
  //     知识库继续假装没有取帧能力，等于自伤）。
  //   - 未松绑：Kimi / 飞书 / dmxapi / vision_video_analysis / timeline_analyze_reference_video /
  //     timeline_kimi_edit_plan 这些**外部工具与外部端点**仍然禁止——它们不是我们的工具，写了就是断链。
  //   - 另注：toolContract 边界声明会点名这些工具并声明它们不可用，那是防线不是断链，
  //     所以这里检查的是知识段落拼接体而非完整注入文本。
  const knowledgeBody = KUNPENG_KNOWLEDGE_SECTIONS.map((section) => section.text).join("\n");
  for (const forbidden of [
    "runninghub",
    "lark-cli",
    "vision_video_analysis",
    "timeline_analyze_reference_video",
    "timeline_kimi_edit_plan",
    "message action=send",
    "channel=feishu",
    "dmxapi",
    "DMXAPI_KEY",
    "main.py",
    "飞书",
    "Kimi",
    "ConversationGuide",
  ]) {
    assert.doesNotMatch(knowledgeBody, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `知识正文不得包含：${forbidden}`);
  }

  // 反过来必须**真的接上**本站影片工具（不是删断言了事）：四支工具名 + 两条诚实边界 + 我方口吻。
  for (const wired of ["video_evidence", "video_transcribe", "video_measure", "video_fetch"]) {
    assert.match(knowledgeBody, new RegExp(wired), `知识正文必须点名本站工具：${wired}`);
  }
  assert.match(knowledgeBody, /asr_unavailable/, "必须写明 ASR 未配置的降级边界（不得让 agent 以为必定成功）");
  assert.match(knowledgeBody, /video_fetch_unavailable/, "必须写明远端抓取未 prepare 的降级边界");
  assert.match(knowledgeBody, /rate: 4\.5/, "台词量测必须写明我方短剧口吻 4.5 字/秒");
  assert.match(knowledgeBody, /eimu\.transcript@1/, "词级时间必须写明返回形状");
  // 方法论正文不许删（开场钩子/信息顺序/平均镜长/景别分布/机位运镜/表演节奏/转场/声音/字幕包装逐条在）
  assert.match(knowledgeBody, /开场钩子、信息顺序、平均镜长、景别分布、机位与运镜、表演节奏、转场、声音、字幕和图形包装/);
  assert.match(knowledgeBody, /机械式相邻帧变化候选＋分数/);
  // 完整注入文本必须包含工具边界声明（防线本身存在）
  assert.match(injection, /工具边界/);
  assert.match(injection, /绝不虚构工具调用/);

  // 核心规则语义逐字保留（抽 pillar 断言）
  const checklist = KUNPENG_KNOWLEDGE_SECTIONS[0].text;
  assert.match(checklist, /第1张→@图片一（场景）/);
  assert.match(checklist, /duration \/ resolution \/ ratio \/ generateAudio 是否已设置/);
  assert.match(checklist, /VO 行用对了吗/);
  // 剔除项确实不在
  assert.doesNotMatch(checklist, /□ 6\.|□ 9\.|□ 12\.|□ 16\.|□ 17\./);

  const shotPatterns = KUNPENG_KNOWLEDGE_SECTIONS[1].text;
  assert.match(shotPatterns, /遵循 180 度法则/);
  assert.match(shotPatterns, /快切，15-30帧\/镜头/);
  assert.match(shotPatterns, /时长：6-12秒/);

  const referenceRules = KUNPENG_KNOWLEDGE_SECTIONS[2].text;
  assert.match(referenceRules, /始终是场景参考图/);
  assert.match(referenceRules, /不用三视图\/多视图/);
  assert.match(referenceRules, /Seedance API 只认.*@图片一.*~.*@图片五/);
  // 飞书阶段一整段已剔除，但阶段二提交规则保留
  assert.doesNotMatch(referenceRules, /阶段一/);
  assert.match(referenceRules, /提交前红线/);
});

test("kunpeng skill audit table covers all five audited skills with decisions", () => {
  const audited = KUNPENG_SKILL_AUDIT.map((entry) => entry.skill);
  assert.deepEqual(audited.sort(), [
    "film-master",
    "scene-image-anchor",
    "script-doctor",
    "storyboard-sketch",
    "video-style-replication",
  ]);
  // 明确不接入的六个工具脚本型 skill 不出现在知识正文里
  // （审计表的 toolRewrites 字段会点名它们以说明改写明细——那是审计记录不是注入内容）
  const knowledgeBody = KUNPENG_KNOWLEDGE_SECTIONS.map((section) => section.text).join("\n");
  for (const excluded of ["lark-cli", "rhtv", "jimeng", "minimax-docx", "pptx-generator", "car-model-skill", "omni-mg-animation"]) {
    assert.doesNotMatch(knowledgeBody, new RegExp(excluded));
  }
});

test("seedance reconciliation is additive and the director keeps existing rules intact", () => {
  // 对账结论三段齐全
  assert.ok(KUNPENG_SEEDANCE_RECONCILIATION.consistent.length >= 5);
  assert.ok(KUNPENG_SEEDANCE_RECONCILIATION.added.length >= 5);
  assert.ok(KUNPENG_SEEDANCE_RECONCILIATION.conflicts.length >= 2);

  // director 现有 13 条 hard rules 一条不删（逐条锚定）
  for (const rule of [
    "POSITIVE PHRASING ONLY",
    "ANTI-SLOP",
    "EMOTION = MUSCLE",
    "NAME THE CAMERA WITH AN ENDPOINT",
    "ONE PRIMARY ACTION",
    "AGE-BLIND",
    "IP AND REAL PEOPLE",
    "FOV IN DEGREES ONLY",
    "MEASURABLE LANGUAGE",
    "HOMOGRAPH TRAP",
    "END WITH A QUALITY TAIL",
    "CUT DISCIPLINE",
    "POSITIVE LOCKS",
  ]) {
    assert.match(PROMPT_DIRECTOR_SYSTEM_PROMPT, new RegExp(rule));
  }

  // kunpeng 补充段以 additive 姿态进入，且声明冲突时现有规则优先
  assert.match(PROMPT_DIRECTOR_SYSTEM_PROMPT, /SEEDANCE SUPPLEMENTARY RULES/);
  assert.match(PROMPT_DIRECTOR_SYSTEM_PROMPT, /additive only; when they conflict with the rules above, the rules above win/);
  assert.match(KUNPENG_SEEDANCE_SUPPLEMENT, /VO lines/);
  assert.match(KUNPENG_SEEDANCE_SUPPLEMENT, /realPersonMode=true/);
  assert.match(KUNPENG_SEEDANCE_SUPPLEMENT, /不用多视图|never three-view/);
  // 补充段不得引入我们没有的端点/CLI
  for (const forbidden of ["bytedance/seedance", "runninghub", "python3", "--api-key"]) {
    assert.doesNotMatch(KUNPENG_SEEDANCE_SUPPLEMENT, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("workstation wires kunpeng apply handlers through the existing apply chain", () => {
  const workstation = readFileSync(join(process.cwd(), "src/components/pro-workstation/InvokeInspiredWorkstation.tsx"), "utf8");
  const panel = readFileSync(join(process.cwd(), "src/components/pro-workstation/CreatorResourcePanel.tsx"), "utf8");
  const leftTab = readFileSync(join(process.cwd(), "src/components/pro-workstation/panels/LeftPromptTab.tsx"), "utf8");

  // 沿现有 applyCreatorResource 同一条状态链（templateUndo 快照 + setPrompt + setCanvasNotice）
  assert.match(workstation, /const applyKunpengStyle = useEventCallback/);
  assert.match(workstation, /const applyKunpengPromptTemplate = useEventCallback/);
  assert.match(workstation, /buildKunpengStylePrompt\(style\)/);
  assert.match(workstation, /onApplyKunpengStyle=\{applyKunpengStyle\}/);
  assert.match(workstation, /onApplyKunpengPromptTemplate=\{applyKunpengPromptTemplate\}/);
  // 面板有独立页签且 UI 文案简体中文
  assert.match(panel, /风格库/);
  assert.match(panel, /提示词模板/);
  assert.match(panel, /鲲鹏资产/);
  // 数据只进面板 chunk，不进入场 chunk（性能契约：入场文件只拿类型）
  const workstationCode = workstation
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.doesNotMatch(workstationCode, /KUNPENG_STYLE_ASSETS/);
  assert.doesNotMatch(workstationCode, /KUNPENG_PROMPT_TEMPLATES/);
  assert.match(panel, /KUNPENG_STYLE_ASSETS/);
  assert.match(panel, /KUNPENG_PROMPT_TEMPLATES/);
  // LeftPromptTab 透传
  assert.match(leftTab, /onApplyKunpengStyle/);
  assert.match(leftTab, /onApplyKunpengPromptTemplate/);
});
