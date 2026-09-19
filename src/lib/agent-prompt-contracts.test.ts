/**
 * Agent 提示詞契約測試（吞 AID 產品層單向差，刀 3-③，2026-09-15）。
 * 跑法：
 *   npx --yes tsx --test src/lib/agent-prompt-contracts.test.ts
 *
 * 覆蓋：
 *   1. 契約目錄結構（非空／agentCode 唯一／與 EXPERT_IDS 逐值對齊／
 *      frozenConstants ≥1／json 模式必有頂層鍵與必填欄位／getContract 查表）
 *   2. checkJsonOutput 正負樣本（每類 ≥4：合法純 JSON 0 violation／
 *      圍欄／缺必填欄位／值內未轉義雙引號／非 JSON 文本／契約常量缺席／
 *      structured_text 模式只驗常量）
 *
 * 樣本一律取自真實契約（screenwriter 為主，critic 驗「鍵須在場可為空數組」，
 * director3d 驗 structured_text 缺口如實標），不編造欄位名。
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
if (!SCREENWRITER) throw new Error("契约夹具缺失：screenwriter（contracts 目錄被改壞）");
const CRITIC = getContract("critic");
if (!CRITIC) throw new Error("契约夹具缺失：critic（contracts 目錄被改壞）");
const DIRECTOR3D = getContract("director3d");
if (!DIRECTOR3D) throw new Error("契约夹具缺失：director3d（contracts 目錄被改壞）");
const MUSIC = getContract("music");
if (!MUSIC) throw new Error("契约夹具缺失：music（contracts 目錄被改壞）");

/** 合法純 JSON：music 工具回執全形（YuE2 通路，frozenConstants 全在 + 必填全在 + score_abc 帶實體）。 */
const VALID_MUSIC_YUE2_JSON = JSON.stringify({
  ok: true,
  url: "https://gateway/agent/v1/sessions/ses_x/uploads/u1.flac",
  duration_source: "upstream_reported",
  channel: "yue2_modal",
  score_abc: "X:1\nK:D\nQ:4/4\nV:Vocal\nA4 B4 c4 A4",
});

/** 合法純 JSON：screenwriter 回執頂層契約全形（frozenConstants 全在 + 必填全在）。 */
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

// ── 1. 契約目錄結構 ──────────────────────────────────────────────────────────

test("契約目錄非空，且 agentCode 唯一", () => {
  assert.ok(AGENT_PROMPT_CONTRACTS.length > 0, "契約目錄不得為空");
  const codes = AGENT_PROMPT_CONTRACTS.map((c) => c.agentCode);
  assert.equal(new Set(codes).size, codes.length, `agentCode 必須唯一，實際：${codes.join("、")}`);
});

test("契約覆蓋 EXPERT_IDS 全部八個 Expert（逐值對齊 expert-contract 白名單，不多不少）", () => {
  const codes = AGENT_PROMPT_CONTRACTS.map((c) => c.agentCode).sort();
  assert.deepEqual(codes, [...EXPERT_IDS].sort());
});

test("每個 contract 的 frozenConstants 至少 1 項（不可動常量的錨，空 = 契約無門禁）", () => {
  for (const c of AGENT_PROMPT_CONTRACTS) {
    assert.ok(
      c.frozenConstants.length >= 1,
      `${c.agentCode} 的 frozenConstants 為空：至少要有 1 項（占位符名／欄位名／協議標記）；若該 Expert 確實無機器契約，仍須列入工具回執層的必有鍵，並在 pitfalls 寫明缺口。`,
    );
  }
});

test("每個 contract 有非空 purpose（取 persona DESCRIPTION 常量，非手抄）", () => {
  for (const c of AGENT_PROMPT_CONTRACTS) {
    assert.ok(typeof c.purpose === "string" && c.purpose.trim() !== "", `${c.agentCode} 缺 purpose`);
  }
});

test("outputMode 只能是 json / structured_text；json 模式必有頂層鍵與必填欄位", () => {
  for (const c of AGENT_PROMPT_CONTRACTS) {
    assert.ok(
      c.outputMode === "json" || c.outputMode === "structured_text",
      `${c.agentCode} outputMode 非法：${String(c.outputMode)}`,
    );
    if (c.outputMode === "json") {
      assert.ok(c.topLevelKeys.length > 0, `${c.agentCode} 是 json 模式但 topLevelKeys 為空`);
      assert.ok(
        c.fields.some((f) => f.required),
        `${c.agentCode} 是 json 模式但沒有任何必填欄位（required_fields 檢查會退化成空檢查）`,
      );
    } else {
      assert.deepEqual(c.fields, [], `${c.agentCode} 是 structured_text 模式，fields 必須為空（禁編造欄位）`);
      assert.ok(
        c.pitfalls.some((p) => p.includes("尚無機器契約")),
        `${c.agentCode} 是 structured_text 模式，pitfalls 必須明寫「尚無機器契約」缺口`,
      );
    }
  }
});

test("getContract：命中返回同一物件，未註冊返回 undefined（不拋）", () => {
  assert.equal(getContract("screenwriter"), SCREENWRITER);
  assert.equal(getContract("no-such-expert"), undefined);
  assert.equal(getContract(""), undefined);
});

test("每個 json 模式 contract 的必填欄位名都在其 topLevelKeys 內（自洽，防兩份清單漂移）", () => {
  for (const c of AGENT_PROMPT_CONTRACTS) {
    if (c.outputMode !== "json") continue;
    for (const f of c.fields.filter((x) => x.required)) {
      assert.ok(
        c.topLevelKeys.includes(f.name),
        `${c.agentCode} 必填欄位 ${f.name} 不在 topLevelKeys（${c.topLevelKeys.join("、")}）內`,
      );
    }
  }
});

test("critic 契約：issues／evidence 必填且型別為數組（鍵須在場可為空數組，非「可省略」）", () => {
  const issues = CRITIC.fields.find((f) => f.name === "issues");
  const evidence = CRITIC.fields.find((f) => f.name === "evidence");
  assert.ok(issues && issues.required && issues.type === "string[]");
  assert.ok(evidence && evidence.required && evidence.type === "string[]");
});

// ── 2026-09-19 YuE2 白盒接線：music 回執契約收 score_abc／channel（additive 同步） ──

test("music 契約：topLevelKeys 收錄 score_abc（YuE2 白盒樂譜，melody_notation 真源）且為非必填", () => {
  assert.ok(MUSIC.topLevelKeys.includes("score_abc"), `music topLevelKeys 應含 score_abc，實際：${MUSIC.topLevelKeys.join("、")}`);
  assert.ok(MUSIC.topLevelKeys.includes("channel"), `music topLevelKeys 應含 channel，實際：${MUSIC.topLevelKeys.join("、")}`);
  const score = MUSIC.fields.find((f) => f.name === "score_abc");
  assert.ok(score, "music fields 應含 score_abc 欄位表項");
  assert.equal(score.required, false, "score_abc 是回執層 additive 鍵（其餘通路 null），非 collect 必查鍵，必填=false");
  // 設計不變量：frozenConstants ⊆ 必填欄位集（極簡樣本零誤報自檢的前提），
  // score_abc 選填故不入 frozenConstants——「欄位一律在場」的回執層錨在 music-tools.ts，非本契約。
  assert.equal(MUSIC.frozenConstants.includes("score_abc"), false, "score_abc 是選填鍵，不得入 frozenConstants（否則極簡樣本自檢誤報）");
});

test("正樣本：music 回執（YuE2，score_abc 帶 ABC 記譜實體）→ 0 violation", () => {
  const vs = checkJsonOutput(VALID_MUSIC_YUE2_JSON, MUSIC);
  assert.deepEqual(vs, [], `合法 music 回執不得報 violation，實際：${JSON.stringify(vs)}`);
});

test("正樣本：music 回執（非 YuE2 通路，score_abc=null）→ 0 violation（欄位在場即合契約）", () => {
  const text = JSON.stringify({
    ok: true,
    url: "https://gateway/uploads/u2.mp3",
    duration_source: "ffprobe",
    channel: "flowmusic2api",
    score_abc: null,
  });
  assert.deepEqual(checkJsonOutput(text, MUSIC), []);
});

test("正樣本：music 回執缺 score_abc 鍵（選填鍵缺席不誤報——與必填欄位口徑不同）", () => {
  const text = JSON.stringify({
    ok: true,
    url: "https://gateway/uploads/u3.mp3",
    duration_source: "ffprobe",
    channel: "lyria_gemini",
  });
  const vs = checkJsonOutput(text, MUSIC);
  assert.deepEqual(vs, [], `score_abc 選填：缺席不得報 violation，實際：${JSON.stringify(vs)}`);
});

// ── 2026-09-19 片 K 樂譜編輯：music 回執契約收 cot_mode／abc_sha256（additive 同步） ──

test("music 契約：topLevelKeys 收錄 cot_mode／abc_sha256（樂譜編輯回執鍵）且為非必填", () => {
  assert.ok(MUSIC.topLevelKeys.includes("cot_mode"), `music topLevelKeys 應含 cot_mode，實際：${MUSIC.topLevelKeys.join("、")}`);
  assert.ok(MUSIC.topLevelKeys.includes("abc_sha256"), `music topLevelKeys 應含 abc_sha256，實際：${MUSIC.topLevelKeys.join("、")}`);
  const cotMode = MUSIC.fields.find((f) => f.name === "cot_mode");
  assert.ok(cotMode, "music fields 應含 cot_mode 欄位表項");
  assert.equal(cotMode.required, false, "cot_mode 是回執層 additive 鍵（僅 YuE2 通路在場），非 collect 必查鍵，必填=false");
  const abcSha = MUSIC.fields.find((f) => f.name === "abc_sha256");
  assert.ok(abcSha, "music fields 應含 abc_sha256 欄位表項");
  assert.equal(abcSha.required, false, "abc_sha256 是回執層 additive 鍵（有傳 abc 時在場），非 collect 必查鍵，必填=false");
  // 同 score_abc 設計不變量：選填鍵不入 frozenConstants（極簡樣本零誤報自檢的前提）。
  assert.equal(MUSIC.frozenConstants.includes("cot_mode"), false, "cot_mode 選填，不得入 frozenConstants");
  assert.equal(MUSIC.frozenConstants.includes("abc_sha256"), false, "abc_sha256 選填，不得入 frozenConstants");
});

test("正樣本：music 回執（YuE2 帶譜重渲染，cot_mode=melody＋abc_sha256）→ 0 violation", () => {
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

test("正樣本：music 回執（YuE2 常規生成，cot_mode 在場而 abc_sha256 缺席）→ 0 violation（各自獨立選填）", () => {
  const text = JSON.stringify({
    ok: true,
    url: "https://gateway/uploads/u5.flac",
    duration_source: "ffprobe",
    channel: "yue2_modal",
    score_abc: null,
    cot_mode: "full",
  });
  const vs = checkJsonOutput(text, MUSIC);
  assert.deepEqual(vs, [], `abc_sha256 缺席（未帶譜委託）不得報 violation，實際：${JSON.stringify(vs)}`);
});

// ── 2026-09-19 片 O 翻唱工作流：music 回執契約收 transcribed_abc_sha256／transcribe_warnings ──

test("music 契約：topLevelKeys 收錄 transcribed_abc_sha256／transcribe_warnings（翻唱回執鍵）且為非必填", () => {
  assert.ok(MUSIC.topLevelKeys.includes("transcribed_abc_sha256"), `music topLevelKeys 應含 transcribed_abc_sha256，實際：${MUSIC.topLevelKeys.join("、")}`);
  assert.ok(MUSIC.topLevelKeys.includes("transcribe_warnings"), `music topLevelKeys 應含 transcribe_warnings，實際：${MUSIC.topLevelKeys.join("、")}`);
  const transcribedSha = MUSIC.fields.find((f) => f.name === "transcribed_abc_sha256");
  assert.ok(transcribedSha, "music fields 應含 transcribed_abc_sha256 欄位表項");
  assert.equal(transcribedSha.required, false, "transcribed_abc_sha256 是回執層 additive 鍵（帶 source_audio 時在場），非 collect 必查鍵，必填=false");
  const transWarnings = MUSIC.fields.find((f) => f.name === "transcribe_warnings");
  assert.ok(transWarnings, "music fields 應含 transcribe_warnings 欄位表項");
  assert.equal(transWarnings.required, false, "transcribe_warnings 是回執層 additive 鍵（帶 source_audio 時在場），非 collect 必查鍵，必填=false");
  // 同 score_abc 設計不變量：選填鍵不入 frozenConstants（極簡樣本零誤報自檢的前提）。
  assert.equal(MUSIC.frozenConstants.includes("transcribed_abc_sha256"), false, "transcribed_abc_sha256 選填，不得入 frozenConstants");
  assert.equal(MUSIC.frozenConstants.includes("transcribe_warnings"), false, "transcribe_warnings 選填，不得入 frozenConstants");
});

test("正樣本：music 回執（YuE2 翻唱，transcribed_abc_sha256＋transcribe_warnings）→ 0 violation", () => {
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

test("正樣本：music 回執（非翻唱委託，transcribed_* 缺席）→ 0 violation（與 abc_sha256 各自獨立選填）", () => {
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
  assert.deepEqual(vs, [], `transcribed_* 缺席（非翻唱委託）不得報 violation，實際：${JSON.stringify(vs)}`);
});

// ── 2. checkJsonOutput：正樣本 ────────────────────────────────────────────────

test("正樣本：合法純 JSON → 0 violation", () => {
  const vs = checkJsonOutput(VALID_SCREENWRITER_JSON, SCREENWRITER);
  assert.deepEqual(vs, [], `合法純 JSON 不得報 violation，實際：${JSON.stringify(vs)}`);
});

test("正樣本：合法純 JSON 帶 markdown 之外的換行/縮排（多行格式化）→ 0 violation", () => {
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

test("正樣本：critic 空數組合法形態（issues/evidence 在場且為 []）→ 0 violation", () => {
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

test("正樣本：值內用中文引號「」→ 0 violation（引號規則的正確寫法）", () => {
  const text = JSON.stringify({
    ok: true,
    beats: ["他說「你好」然後轉身離開"],
    shotlist: [{ description: "「以退為進」的對話場景" }],
    qc: "verdict=pass",
  });
  assert.deepEqual(checkJsonOutput(text, SCREENWRITER), []);
});

test("正樣本：值內含合法轉義雙引號（\\\"）→ 0 violation（轉義不算未轉義引號）", () => {
  const text = '{"ok":true,"beats":["他说\\"你好\\""],"shotlist":[{"description":"x"}],"qc":"pass"}';
  assert.deepEqual(checkJsonOutput(text, SCREENWRITER), []);
});

// ── 3. checkJsonOutput：負樣本 ────────────────────────────────────────────────

test("負樣本：帶 ``` 圍欄 → 命中 no_markdown_fence（且不得拋）", () => {
  const text = "```json\n" + VALID_SCREENWRITER_JSON + "\n```";
  const vs = checkJsonOutput(text, SCREENWRITER);
  assert.ok(rules(vs).includes("no_markdown_fence"), `應報 no_markdown_fence，實際：${JSON.stringify(vs)}`);
});

test("負樣本：缺必填欄位（缺 shotlist／qc）→ 命中 required_fields 並列出缺項", () => {
  const text = JSON.stringify({ ok: true, beats: ["a"] });
  const vs = checkJsonOutput(text, SCREENWRITER);
  const hit = vs.find((v) => v.rule === "required_fields");
  assert.ok(hit, `應報 required_fields，實際：${JSON.stringify(vs)}`);
  assert.ok(hit.detail.includes("shotlist"), "detail 必須列出缺失欄位名 shotlist");
  assert.ok(hit.detail.includes("qc"), "detail 必須列出缺失欄位名 qc");
});

test("負樣本：值內含未轉義英文雙引號 → 命中 chinese_quotes_in_values（不拋）", () => {
  const text = '{"ok":true,"beats":["他说"你好""],"shotlist":[],"qc":"pass"}';
  const vs = checkJsonOutput(text, SCREENWRITER);
  assert.ok(
    rules(vs).includes("chinese_quotes_in_values"),
    `應報 chinese_quotes_in_values，實際：${JSON.stringify(vs)}`,
  );
  const hit = vs.find((v) => v.rule === "chinese_quotes_in_values");
  assert.ok(hit !== undefined && hit.detail.includes("「」"), "detail 必須提示改用中文「」");
});

test("負樣本：非 JSON 文本（純散文）→ 命中 pure_json", () => {
  const vs = checkJsonOutput("好的，我已经完成了分镜，包含三拍：开场、转折、收尾。", SCREENWRITER);
  assert.ok(rules(vs).includes("pure_json"), `應報 pure_json，實際：${JSON.stringify(vs)}`);
});

test("負樣本：JSON 前後帶說明文字（有合法 JSON 但非整段）→ 命中 pure_json", () => {
  const text = `好的，以下是结果：\n${VALID_SCREENWRITER_JSON}`;
  const vs = checkJsonOutput(text, SCREENWRITER);
  const pureJson = vs.filter((v) => v.rule === "pure_json");
  assert.ok(pureJson.length >= 1, `應報 pure_json，實際：${JSON.stringify(vs)}`);
  assert.ok(rules(vs).includes("no_markdown_fence") === false, "無圍欄時不應誤報 no_markdown_fence");
});

test("負樣本：frozen_constants 缺席（screenwriter 文本缺 beats 鍵）→ 命中 frozen_constants", () => {
  const vs = checkJsonOutput('{"ok":true,"shotlist":[],"qc":"pass"}', SCREENWRITER);
  const hit = vs.find((v) => v.rule === "frozen_constants");
  assert.ok(hit, `應報 frozen_constants，實際：${JSON.stringify(vs)}`);
  assert.ok(hit.detail.includes("beats"));
});

test("負樣本：structured_text 模式（director3d）餵散文 → 只按常量判定，不冒充 JSON 檢查", () => {
  const vs = checkJsonOutput("渲染完成，已交付 turntable 与静帧。", DIRECTOR3D);
  const rs = rules(vs);
  assert.equal(rs.includes("pure_json"), false, "structured_text 模式不得報 pure_json（尚無機器契約，不冒充）");
  assert.ok(rs.includes("frozen_constants"), `缺工具回執層常量應報 frozen_constants，實際：${JSON.stringify(vs)}`);
  assert.ok(rs.every((r) => r === "frozen_constants"));
});

test("負樣本：空字串 / 非字串輸入 → 回報 violation 且絕不拋異常", () => {
  assert.ok(checkJsonOutput("", SCREENWRITER).length > 0);
  // 型別防禦：呼叫端傳錯型別也只回 violation（runtime 兜底，非型別系統職責）
  const vs = checkJsonOutput(undefined as unknown as string, SCREENWRITER);
  assert.ok(Array.isArray(vs) && vs.length > 0);
});

test("結構保證：任何輸入下 checkJsonOutput 都返回 ContractViolation[]（rule/detail 皆非空字串）", () => {
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

test("契約自檢：所有 contract 對自己的合法極簡樣本不誤報（frozenConstants ∩ 樣本鍵）", () => {
  const contracts: AgentPromptContract[] = [...AGENT_PROMPT_CONTRACTS];
  for (const c of contracts) {
    if (c.outputMode !== "json") continue;
    // 用契約自己的必填欄位造最小合法樣本（值一律用型別合法的最小值）
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
      `${c.agentCode} 對自己的必填欄位最小樣本誤報：${JSON.stringify(vs)}（樣本 ${text}）`,
    );
  }
});
