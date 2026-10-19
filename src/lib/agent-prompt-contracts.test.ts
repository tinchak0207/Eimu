/**
 * Agent 提示词契约测试（吞 AID 产品层单向差，刀 3-③，2026-09-15）。
 * 跑法：
 *   npx --yes tsx --test src/lib/agent-prompt-contracts.test.ts
 *
 * 覆盖：
 *   1. 契约目录结构（非空／agentCode 唯一／与 EXPERT_IDS 逐值对齐／
 *      frozenConstants ≥1／json 模式必有顶层键与必填栏位／getContract 查表）
 *   2. checkJsonOutput 正负样本（每类 ≥4：合法纯 JSON 0 violation／
 *      围栏／缺必填栏位／值内未转义双引号／非 JSON 文本／契约常量缺席／
 *      structured_text 模式只验常量）
 *
 * 样本一律取自真实契约（screenwriter 为主，critic 验「键须在场可为空数组」，
 * director3d 验 structured_text 缺口如实标），不编造栏位名。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  AGENT_PROMPT_CONTRACTS,
  getContract,
  type AgentPromptContract,
} from "./agent-prompt-contracts.ts";
import { checkJsonOutput } from "./agent-prompt-contract-check.ts";
import { EXPERT_IDS } from "./expert-contract.ts";

// ── 夹具 ─────────────────────────────────────────────────────────────────────

const SCREENWRITER = getContract("screenwriter");
if (!SCREENWRITER) throw new Error("契约夹具缺失：screenwriter（contracts 目录被改坏）");
const CRITIC = getContract("critic");
if (!CRITIC) throw new Error("契约夹具缺失：critic（contracts 目录被改坏）");
const DIRECTOR3D = getContract("director3d");
if (!DIRECTOR3D) throw new Error("契约夹具缺失：director3d（contracts 目录被改坏）");
const MUSIC = getContract("music");
if (!MUSIC) throw new Error("契约夹具缺失：music（contracts 目录被改坏）");

/** 合法纯 JSON：music 工具回执全形（YuE2 通路，frozenConstants 全在 + 必填全在 + score_abc 带实体）。 */
const VALID_MUSIC_YUE2_JSON = JSON.stringify({
  ok: true,
  url: "https://gateway/agent/v1/sessions/ses_x/uploads/u1.flac",
  duration_source: "upstream_reported",
  channel: "yue2_modal",
  score_abc: "X:1\nK:D\nQ:4/4\nV:Vocal\nA4 B4 c4 A4",
});

/** 合法纯 JSON：screenwriter 回执顶层契约全形（frozenConstants 全在 + 必填全在）。 */
const VALID_SCREENWRITER_JSON = JSON.stringify({
  ok: true,
  beats: ["开场：主角在雨夜接到一通电话", "转折：发现来电者已死三年"],
  shotlist: [{ description: "雨夜街景，主角握手机特写", scene: 1, duration_sec: 4 }],
  qc: "beats=2; shots=1; verdict=pass",
  artifact_path: "out/screenwriter-1.json",
});

function rules(vs: ReturnType<typeof checkJsonOutput>): string[] {
  return vs.map((v) => v.rule);
}

// ── 1. 契约目录结构 ──────────────────────────────────────────────────────────

test("契约目录非空，且 agentCode 唯一", () => {
  assert.ok(AGENT_PROMPT_CONTRACTS.length > 0, "契约目录不得为空");
  const codes = AGENT_PROMPT_CONTRACTS.map((c) => c.agentCode);
  assert.equal(new Set(codes).size, codes.length, `agentCode 必须唯一，实际：${codes.join("、")}`);
});

test("契约覆盖 EXPERT_IDS 全部八个 Expert（逐值对齐 expert-contract 白名单，不多不少）", () => {
  const codes = AGENT_PROMPT_CONTRACTS.map((c) => c.agentCode).sort();
  assert.deepEqual(codes, [...EXPERT_IDS].sort());
});

test("每个 contract 的 frozenConstants 至少 1 项（不可动常量的锚，空 = 契约无门禁）", () => {
  for (const c of AGENT_PROMPT_CONTRACTS) {
    assert.ok(
      c.frozenConstants.length >= 1,
      `${c.agentCode} 的 frozenConstants 为空：至少要有 1 项（占位符名／栏位名／协议标记）；若该 Expert 确实无机器契约，仍须列入工具回执层的必有键，并在 pitfalls 写明缺口。`,
    );
  }
});

test("每个 contract 有非空 purpose（取 persona DESCRIPTION 常量，非手抄）", () => {
  for (const c of AGENT_PROMPT_CONTRACTS) {
    assert.ok(typeof c.purpose === "string" && c.purpose.trim() !== "", `${c.agentCode} 缺 purpose`);
  }
});

test("outputMode 只能是 json / structured_text；json 模式必有顶层键与必填栏位", () => {
  for (const c of AGENT_PROMPT_CONTRACTS) {
    assert.ok(
      c.outputMode === "json" || c.outputMode === "structured_text",
      `${c.agentCode} outputMode 非法：${String(c.outputMode)}`,
    );
    if (c.outputMode === "json") {
      assert.ok(c.topLevelKeys.length > 0, `${c.agentCode} 是 json 模式但 topLevelKeys 为空`);
      assert.ok(
        c.fields.some((f) => f.required),
        `${c.agentCode} 是 json 模式但没有任何必填栏位（required_fields 检查会退化成空检查）`,
      );
    } else {
      assert.deepEqual(c.fields, [], `${c.agentCode} 是 structured_text 模式，fields 必须为空（禁编造栏位）`);
      assert.ok(
        c.pitfalls.some((p) => p.includes("尚无机器契约")),
        `${c.agentCode} 是 structured_text 模式，pitfalls 必须明写「尚无机器契约」缺口`,
      );
    }
  }
});

test("getContract：命中返回同一物件，未注册返回 undefined（不抛）", () => {
  assert.equal(getContract("screenwriter"), SCREENWRITER);
  assert.equal(getContract("no-such-expert"), undefined);
  assert.equal(getContract(""), undefined);
});

test("每个 json 模式 contract 的必填栏位名都在其 topLevelKeys 内（自洽，防两份清单漂移）", () => {
  for (const c of AGENT_PROMPT_CONTRACTS) {
    if (c.outputMode !== "json") continue;
    for (const f of c.fields.filter((x) => x.required)) {
      assert.ok(
        c.topLevelKeys.includes(f.name),
        `${c.agentCode} 必填栏位 ${f.name} 不在 topLevelKeys（${c.topLevelKeys.join("、")}）内`,
      );
    }
  }
});

test("critic 契约：issues／evidence 必填且型别为数组（键须在场可为空数组，非「可省略」）", () => {
  const issues = CRITIC.fields.find((f) => f.name === "issues");
  const evidence = CRITIC.fields.find((f) => f.name === "evidence");
  assert.ok(issues && issues.required && issues.type === "string[]");
  assert.ok(evidence && evidence.required && evidence.type === "string[]");
});

// ── 2026-09-19 YuE2 白盒接线：music 回执契约收 score_abc／channel（additive 同步） ──

test("music 契约：topLevelKeys 收录 score_abc（YuE2 白盒乐谱，melody_notation 真源）且为非必填", () => {
  assert.ok(MUSIC.topLevelKeys.includes("score_abc"), `music topLevelKeys 应含 score_abc，实际：${MUSIC.topLevelKeys.join("、")}`);
  assert.ok(MUSIC.topLevelKeys.includes("channel"), `music topLevelKeys 应含 channel，实际：${MUSIC.topLevelKeys.join("、")}`);
  const score = MUSIC.fields.find((f) => f.name === "score_abc");
  assert.ok(score, "music fields 应含 score_abc 栏位表项");
  assert.equal(score.required, false, "score_abc 是回执层 additive 键（其余通路 null），非 collect 必查键，必填=false");
  // 设计不变量：frozenConstants ⊆ 必填栏位集（极简样本零误报自检的前提），
  // score_abc 选填故不入 frozenConstants——「栏位一律在场」的回执层锚在 music-tools.ts，非本契约。
  assert.equal(MUSIC.frozenConstants.includes("score_abc"), false, "score_abc 是选填键，不得入 frozenConstants（否则极简样本自检误报）");
});

test("正样本：music 回执（YuE2，score_abc 带 ABC 记谱实体）→ 0 violation", () => {
  const vs = checkJsonOutput(VALID_MUSIC_YUE2_JSON, MUSIC);
  assert.deepEqual(vs, [], `合法 music 回执不得报 violation，实际：${JSON.stringify(vs)}`);
});

test("正样本：music 回执（非 YuE2 通路，score_abc=null）→ 0 violation（栏位在场即合契约）", () => {
  const text = JSON.stringify({
    ok: true,
    url: "https://gateway/uploads/u2.mp3",
    duration_source: "ffprobe",
    channel: "flowmusic2api",
    score_abc: null,
  });
  assert.deepEqual(checkJsonOutput(text, MUSIC), []);
});

test("正样本：music 回执缺 score_abc 键（选填键缺席不误报——与必填栏位口径不同）", () => {
  const text = JSON.stringify({
    ok: true,
    url: "https://gateway/uploads/u3.mp3",
    duration_source: "ffprobe",
    channel: "lyria_gemini",
  });
  const vs = checkJsonOutput(text, MUSIC);
  assert.deepEqual(vs, [], `score_abc 选填：缺席不得报 violation，实际：${JSON.stringify(vs)}`);
});

// ── 2026-09-19 片 K 乐谱编辑：music 回执契约收 cot_mode／abc_sha256（additive 同步） ──

test("music 契约：topLevelKeys 收录 cot_mode／abc_sha256（乐谱编辑回执键）且为非必填", () => {
  assert.ok(MUSIC.topLevelKeys.includes("cot_mode"), `music topLevelKeys 应含 cot_mode，实际：${MUSIC.topLevelKeys.join("、")}`);
  assert.ok(MUSIC.topLevelKeys.includes("abc_sha256"), `music topLevelKeys 应含 abc_sha256，实际：${MUSIC.topLevelKeys.join("、")}`);
  const cotMode = MUSIC.fields.find((f) => f.name === "cot_mode");
  assert.ok(cotMode, "music fields 应含 cot_mode 栏位表项");
  assert.equal(cotMode.required, false, "cot_mode 是回执层 additive 键（仅 YuE2 通路在场），非 collect 必查键，必填=false");
  const abcSha = MUSIC.fields.find((f) => f.name === "abc_sha256");
  assert.ok(abcSha, "music fields 应含 abc_sha256 栏位表项");
  assert.equal(abcSha.required, false, "abc_sha256 是回执层 additive 键（有传 abc 时在场），非 collect 必查键，必填=false");
  // 同 score_abc 设计不变量：选填键不入 frozenConstants（极简样本零误报自检的前提）。
  assert.equal(MUSIC.frozenConstants.includes("cot_mode"), false, "cot_mode 选填，不得入 frozenConstants");
  assert.equal(MUSIC.frozenConstants.includes("abc_sha256"), false, "abc_sha256 选填，不得入 frozenConstants");
});

test("正样本：music 回执（YuE2 带谱重渲染，cot_mode=melody＋abc_sha256）→ 0 violation", () => {
  const text = JSON.stringify({
    ok: true,
    url: "https://gateway/uploads/u4.flac",
    duration_source: "upstream_reported",
    channel: "yue2_modal",
    score_abc: "X:1\nK:G\nQ:4/4\nV:Vocal\nG4 A4 B4 c4",
    cot_mode: "melody",
    abc_sha256: "b".repeat(64),
  });
  assert.deepEqual(checkJsonOutput(text, MUSIC), []);
});

test("正样本：music 回执（YuE2 常规生成，cot_mode 在场而 abc_sha256 缺席）→ 0 violation（各自独立选填）", () => {
  const text = JSON.stringify({
    ok: true,
    url: "https://gateway/uploads/u5.flac",
    duration_source: "ffprobe",
    channel: "yue2_modal",
    score_abc: null,
    cot_mode: "full",
  });
  const vs = checkJsonOutput(text, MUSIC);
  assert.deepEqual(vs, [], `abc_sha256 缺席（未带谱委托）不得报 violation，实际：${JSON.stringify(vs)}`);
});

// ── 2026-09-19 片 O 翻唱工作流：music 回执契约收 transcribed_abc_sha256／transcribe_warnings ──

test("music 契约：topLevelKeys 收录 transcribed_abc_sha256／transcribe_warnings（翻唱回执键）且为非必填", () => {
  assert.ok(MUSIC.topLevelKeys.includes("transcribed_abc_sha256"), `music topLevelKeys 应含 transcribed_abc_sha256，实际：${MUSIC.topLevelKeys.join("、")}`);
  assert.ok(MUSIC.topLevelKeys.includes("transcribe_warnings"), `music topLevelKeys 应含 transcribe_warnings，实际：${MUSIC.topLevelKeys.join("、")}`);
  const transcribedSha = MUSIC.fields.find((f) => f.name === "transcribed_abc_sha256");
  assert.ok(transcribedSha, "music fields 应含 transcribed_abc_sha256 栏位表项");
  assert.equal(transcribedSha.required, false, "transcribed_abc_sha256 是回执层 additive 键（带 source_audio 时在场），非 collect 必查键，必填=false");
  const transWarnings = MUSIC.fields.find((f) => f.name === "transcribe_warnings");
  assert.ok(transWarnings, "music fields 应含 transcribe_warnings 栏位表项");
  assert.equal(transWarnings.required, false, "transcribe_warnings 是回执层 additive 键（带 source_audio 时在场），非 collect 必查键，必填=false");
  // 同 score_abc 设计不变量：选填键不入 frozenConstants（极简样本零误报自检的前提）。
  assert.equal(MUSIC.frozenConstants.includes("transcribed_abc_sha256"), false, "transcribed_abc_sha256 选填，不得入 frozenConstants");
  assert.equal(MUSIC.frozenConstants.includes("transcribe_warnings"), false, "transcribe_warnings 选填，不得入 frozenConstants");
});

test("正样本：music 回执（YuE2 翻唱，transcribed_abc_sha256＋transcribe_warnings）→ 0 violation", () => {
  const text = JSON.stringify({
    ok: true,
    url: "https://gateway/uploads/u6.flac",
    duration_source: "upstream_reported",
    channel: "yue2_modal",
    score_abc: null,
    cot_mode: "melody",
    transcribed_abc_sha256: "d".repeat(64),
    transcribe_warnings: ["audio trimmed to 60s"],
  });
  assert.deepEqual(checkJsonOutput(text, MUSIC), []);
});

test("正样本：music 回执（非翻唱委托，transcribed_* 缺席）→ 0 violation（与 abc_sha256 各自独立选填）", () => {
  const text = JSON.stringify({
    ok: true,
    url: "https://gateway/uploads/u7.flac",
    duration_source: "ffprobe",
    channel: "yue2_modal",
    score_abc: "X:1\nK:C\nC D E F|",
    cot_mode: "full",
    abc_sha256: "e".repeat(64),
  });
  const vs = checkJsonOutput(text, MUSIC);
  assert.deepEqual(vs, [], `transcribed_* 缺席（非翻唱委托）不得报 violation，实际：${JSON.stringify(vs)}`);
});

// ── 2. checkJsonOutput：正样本 ────────────────────────────────────────────────

test("正样本：合法纯 JSON → 0 violation", () => {
  const vs = checkJsonOutput(VALID_SCREENWRITER_JSON, SCREENWRITER);
  assert.deepEqual(vs, [], `合法纯 JSON 不得报 violation，实际：${JSON.stringify(vs)}`);
});

test("正样本：合法纯 JSON 带 markdown 之外的换行/缩排（多行格式化）→ 0 violation", () => {
  const pretty = JSON.stringify(
    {
      ok: true,
      beats: ["a", "b"],
      shotlist: [{ description: "x" }],
      qc: "verdict=pass",
    },
    null,
    2,
  );
  assert.deepEqual(checkJsonOutput(pretty, SCREENWRITER), []);
});

test("正样本：critic 空数组合法形态（issues/evidence 在场且为 []）→ 0 violation", () => {
  const text = JSON.stringify({
    ok: true,
    verdict: "pass",
    issues: [],
    evidence: ["recount: bytes=1024 vs claimed=1024"],
    qc: "verdict=pass; issues=0; evidence=1",
    artifact_path: "out/critic-1.json",
  });
  assert.deepEqual(checkJsonOutput(text, CRITIC), []);
});

test("正样本：值内用中文引号「」→ 0 violation（引号规则的正确写法）", () => {
  const text = JSON.stringify({
    ok: true,
    beats: ["他说「你好」然后转身离开"],
    shotlist: [{ description: "「以退为进」的对话场景" }],
    qc: "verdict=pass",
  });
  assert.deepEqual(checkJsonOutput(text, SCREENWRITER), []);
});

test("正样本：值内含合法转义双引号（\\\"）→ 0 violation（转义不算未转义引号）", () => {
  const text = '{"ok":true,"beats":["他说\\"你好\\""],"shotlist":[{"description":"x"}],"qc":"pass"}';
  assert.deepEqual(checkJsonOutput(text, SCREENWRITER), []);
});

// ── 3. checkJsonOutput：负样本 ────────────────────────────────────────────────

test("负样本：带 ``` 围栏 → 命中 no_markdown_fence（且不得抛）", () => {
  const text = "```json\n" + VALID_SCREENWRITER_JSON + "\n```";
  const vs = checkJsonOutput(text, SCREENWRITER);
  assert.ok(rules(vs).includes("no_markdown_fence"), `应报 no_markdown_fence，实际：${JSON.stringify(vs)}`);
});

test("负样本：缺必填栏位（缺 shotlist／qc）→ 命中 required_fields 并列出缺项", () => {
  const text = JSON.stringify({ ok: true, beats: ["a"] });
  const vs = checkJsonOutput(text, SCREENWRITER);
  const hit = vs.find((v) => v.rule === "required_fields");
  assert.ok(hit, `应报 required_fields，实际：${JSON.stringify(vs)}`);
  assert.ok(hit.detail.includes("shotlist"), "detail 必须列出缺失栏位名 shotlist");
  assert.ok(hit.detail.includes("qc"), "detail 必须列出缺失栏位名 qc");
});

test("负样本：值内含未转义英文双引号 → 命中 chinese_quotes_in_values（不抛）", () => {
  const text = '{"ok":true,"beats":["他说"你好""],"shotlist":[],"qc":"pass"}';
  const vs = checkJsonOutput(text, SCREENWRITER);
  assert.ok(
    rules(vs).includes("chinese_quotes_in_values"),
    `应报 chinese_quotes_in_values，实际：${JSON.stringify(vs)}`,
  );
  const hit = vs.find((v) => v.rule === "chinese_quotes_in_values");
  assert.ok(hit !== undefined && hit.detail.includes("「」"), "detail 必须提示改用中文「」");
});

test("负样本：非 JSON 文本（纯散文）→ 命中 pure_json", () => {
  const vs = checkJsonOutput("好的，我已经完成了分镜，包含三拍：开场、转折、收尾。", SCREENWRITER);
  assert.ok(rules(vs).includes("pure_json"), `应报 pure_json，实际：${JSON.stringify(vs)}`);
});

test("负样本：JSON 前后带说明文字（有合法 JSON 但非整段）→ 命中 pure_json", () => {
  const text = `好的，以下是结果：\n${VALID_SCREENWRITER_JSON}`;
  const vs = checkJsonOutput(text, SCREENWRITER);
  const pureJson = vs.filter((v) => v.rule === "pure_json");
  assert.ok(pureJson.length >= 1, `应报 pure_json，实际：${JSON.stringify(vs)}`);
  assert.ok(rules(vs).includes("no_markdown_fence") === false, "无围栏时不应误报 no_markdown_fence");
});

test("负样本：frozen_constants 缺席（screenwriter 文本缺 beats 键）→ 命中 frozen_constants", () => {
  const vs = checkJsonOutput('{"ok":true,"shotlist":[],"qc":"pass"}', SCREENWRITER);
  const hit = vs.find((v) => v.rule === "frozen_constants");
  assert.ok(hit, `应报 frozen_constants，实际：${JSON.stringify(vs)}`);
  assert.ok(hit.detail.includes("beats"));
});

test("负样本：structured_text 模式（director3d）喂散文 → 只按常量判定，不冒充 JSON 检查", () => {
  const vs = checkJsonOutput("渲染完成，已交付 turntable 与静帧。", DIRECTOR3D);
  const rs = rules(vs);
  assert.equal(rs.includes("pure_json"), false, "structured_text 模式不得报 pure_json（尚无机器契约，不冒充）");
  assert.ok(rs.includes("frozen_constants"), `缺工具回执层常量应报 frozen_constants，实际：${JSON.stringify(vs)}`);
  assert.ok(rs.every((r) => r === "frozen_constants"));
});

test("负样本：空字串 / 非字串输入 → 回报 violation 且绝不抛异常", () => {
  assert.ok(checkJsonOutput("", SCREENWRITER).length > 0);
  // 型别防御：呼叫端传错型别也只回 violation（runtime 兜底，非型别系统职责）
  const vs = checkJsonOutput(undefined as unknown as string, SCREENWRITER);
  assert.ok(Array.isArray(vs) && vs.length > 0);
});

test("结构保证：任何输入下 checkJsonOutput 都返回 ContractViolation[]（rule/detail 皆非空字串）", () => {
  const inputs = [
    VALID_SCREENWRITER_JSON,
    "```",
    "{}",
    "[]",
    "null",
    "{}garbage",
    '{"a":1,}',
  ];
  for (const input of inputs) {
    const vs = checkJsonOutput(input, SCREENWRITER);
    assert.ok(Array.isArray(vs));
    for (const v of vs) {
      assert.ok(typeof v.rule === "string" && v.rule.length > 0);
      assert.ok(typeof v.detail === "string" && v.detail.length > 0);
    }
  }
});

test("契约自检：所有 contract 对自己的合法极简样本不误报（frozenConstants ∩ 样本键）", () => {
  const contracts: AgentPromptContract[] = [...AGENT_PROMPT_CONTRACTS];
  for (const c of contracts) {
    if (c.outputMode !== "json") continue;
    // 用契约自己的必填栏位造最小合法样本（值一律用型别合法的最小值）
    const sample: Record<string, unknown> = {};
    for (const f of c.fields.filter((x) => x.required)) {
      if (f.type === "string[]") sample[f.name] = [];
      else if (f.type === "number") sample[f.name] = 1;
      else if (f.type === "boolean") sample[f.name] = true;
      else sample[f.name] = "";
    }
    const text = JSON.stringify(sample);
    const vs = checkJsonOutput(text, c);
    assert.deepEqual(
      vs,
      [],
      `${c.agentCode} 对自己的必填栏位最小样本误报：${JSON.stringify(vs)}（样本 ${text}）`,
    );
  }
});
