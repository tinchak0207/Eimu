import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SLASH_MENU_DEBOUNCE_MS,
  SLASH_MENU_LIMIT,
  SLASH_MINE_SECTION_LABEL,
  applySkillPick,
  flattenSlashRows,
  mergeSlashResults,
  moveActiveIndex,
  parseFamilyLabels,
  parseSlashSkills,
  shouldAcceptSlashResponse,
  shouldOpenSlashMenu,
  slashMenuUrl,
  slashMineUrl,
  slashQueryOf,
  slashSkillAt,
  type SlashMenuSkill,
} from "./SkillSlashMenu";
import {
  SKILL_OUTPUT_KINDS,
  deriveToolIds,
  humanizeSkillError,
  mineSkillUrl,
  parseMySkills,
  splitSkillTags,
} from "./MySkillsDialog";
import { HARNESS_TOOL_IDS } from "../../lib/harness-tool-registry";

/**
 * 打「/」直呼 Skill 的入框回归：真行为断言优先——闸门、查询词、写回、上下键、URL 编码、
 * 上游响应解析、竞态判定全部走**纯函数真进真出**（node:test 直跑，无 jsdom / 无 react 渲染库）。
 *
 * 末尾两条是**源码探针**（不是 oracle）：DOM 交互（真键盘、真 pointer、浮层定位）本仓
 * 没有 jsdom 基建，只能用「字面仍在 + 该分支没有 handleSend」这种变更探针挡回归，
 * 真实交互待真浏览器验收——探针不算「已验证」，别把它读成功能通过。
 */

const root = process.cwd();

function read(relPath: string): string {
  return readFileSync(join(root, relPath), "utf8");
}

// <1000 行重构：键盘/斜线分支已拆到 AgentComposer.interaction.ts。
const composer = [
  "AgentComposer.tsx",
  "AgentComposer.attachments.ts",
  "AgentComposer.interaction.ts",
  "AgentComposer.menus.tsx",
  "AgentComposer.send-pipeline.ts",
  "AgentComposer.types.ts",
  "AgentComposer.upload-limits.ts",
]
  .map((f) => read(`src/components/agent-chat/${f}`))
  .join("\n");

/** 一条真实上游形状（GET /api/skills → AgentSkillView[]）。 */
function skillView(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "cine-hopper-light",
    name: "霍珀式夜光",
    oneLiner: "低照度自然光里的人造霓虹",
    family: "cinema-auteur",
    useScenario: "夜景城市独白",
    inputType: "一句场景描述",
    outputContent: "一张夜景图或一条分镜",
    outputKind: "image",
    toolIds: ["image_generate"],
    expertId: "video-director",
    tags: ["夜景", "霓虹"],
    source: "builtin",
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* 闸门：什么时候允许开菜单                                             */
/* ------------------------------------------------------------------ */

test("闸门：空框或首字符「/」才允许；普通文字与句中的「/」一律不开", () => {
  assert.equal(shouldOpenSlashMenu("/"), true);
  assert.equal(shouldOpenSlashMenu("/cine"), true);
  assert.equal(shouldOpenSlashMenu(""), true);
  // 负向对照：普通文字不是指令。
  assert.equal(shouldOpenSlashMenu("帮我写一个三分钟的短剧"), false);
  // 负向对照：「/」在句中（网址、分数、路径）不是指令。
  assert.equal(shouldOpenSlashMenu("看看 /api/skills 怎么返回"), false);
  assert.equal(shouldOpenSlashMenu("1/2 的构图比例"), false);
  // 首字符是空格再打「/」也不算（要求的是「首字符」）。
  assert.equal(shouldOpenSlashMenu(" /cine"), false);
});

test("查询词＝「/」之后的文字；非指令形态恒回空串", () => {
  assert.equal(slashQueryOf("/cine"), "cine");
  assert.equal(slashQueryOf("/ 电影美学 "), "电影美学");
  assert.equal(slashQueryOf("/"), "");
  assert.equal(slashQueryOf(""), "");
  assert.equal(slashQueryOf("看电影/cine"), "");
});

/* ------------------------------------------------------------------ */
/* 选中＝写回输入框（不送出、不覆盖既有文字）                             */
/* ------------------------------------------------------------------ */

test("选中一条技能＝把「/技能名 」写回输入框（指令形态替换查询词）", () => {
  assert.equal(applySkillPick("/cin", { name: "霍珀式夜光" }), "/霍珀式夜光 ");
  assert.equal(applySkillPick("/", { name: "霍珀式夜光" }), "/霍珀式夜光 ");
  assert.equal(applySkillPick("", { name: "霍珀式夜光" }), "/霍珀式夜光 ");
  // 末尾留一格：紧接着打字就是这条技能的需求描述，而不是继续拼技能名。
  assert.ok(applySkillPick("/cin", { name: "x" }).endsWith(" "));
  // 非指令形态（理论上菜单不开）不吃掉使用者已打的字：指令接在后面（同 D-24 prefill 规矩）。
  assert.equal(applySkillPick("先看看这个", { name: "霍珀式夜光" }), "先看看这个 /霍珀式夜光 ");
  // 写回的是文字，绝不带换行——它不会被误当成 Enter 送出。
  assert.doesNotMatch(applySkillPick("/c", { name: "x" }), /\n/);
});

/* ------------------------------------------------------------------ */
/* 上下键：回绕、越界、空列表                                           */
/* ------------------------------------------------------------------ */

test("上下键移动：两端回绕，越界/空列表不落 undefined", () => {
  const len = 8;
  assert.equal(moveActiveIndex(0, 1, len), 1);
  assert.equal(moveActiveIndex(7, 1, len), 0, "末行向下回到首行");
  assert.equal(moveActiveIndex(0, -1, len), 7, "首行向上回到末行");
  assert.equal(moveActiveIndex(3, -1, len), 2);
  // 列表刚变短、父层还没复位：越界按首行起算，不回 -1 / NaN。
  assert.equal(moveActiveIndex(9, 1, 3), 1);
  assert.equal(moveActiveIndex(-4, -1, 3), 2);
  // 空列表恒定 0（Enter 会因为取不到项而什么都不做，不会崩）。
  assert.equal(moveActiveIndex(0, 1, 0), 0);
  assert.equal(moveActiveIndex(5, -1, 0), 0);
});

/* ------------------------------------------------------------------ */
/* 请求 URL：真编码（中文 / & / 空格 / limit）                          */
/* ------------------------------------------------------------------ */

test("查询 URL：中文与 & 真编码，limit 随参数走，往返解析回原查询词", () => {
  const url = slashMenuUrl("帮我 & 你");
  const parsed = new URL(url, "https://eimu.dev");
  assert.equal(parsed.pathname, "/api/skills");
  assert.equal(parsed.searchParams.get("q"), "帮我 & 你", "往返必须回到原查询词");
  assert.equal(parsed.searchParams.get("limit"), String(SLASH_MENU_LIMIT));
  // 查询词里的 & 不许串成新的参数。
  assert.equal(parsed.searchParams.get("你"), null);
  // 空查询词照样带 q（列举形态），不是 omit。
  assert.equal(new URL(slashMenuUrl(" "), "https://x").searchParams.get("q"), "");
});

/* ------------------------------------------------------------------ */
/* 上游响应解析：真形状照收，畸形条目丢掉，不伪造                          */
/* ------------------------------------------------------------------ */

test("解析上游 skills：真形状照收（name / oneLiner / family 三栏齐）", () => {
  const skills = parseSlashSkills({ skills: [skillView()], total: 1, families: [] });
  assert.equal(skills.length, 1);
  assert.deepEqual(skills[0], {
    id: "cine-hopper-light",
    name: "霍珀式夜光",
    oneLiner: "低照度自然光里的人造霓虹",
    family: "cinema-auteur",
  });
});

test("解析上游 skills：畸形条目丢列、非数组回空、上限截断（不猜不补）", () => {
  const messy = parseSlashSkills({
    skills: [
      skillView({ id: "ok-1" }),
      null,
      "not-an-object",
      { name: "没有 id" },
      { id: "no-name" },
      { id: "  ", name: "  " },
      skillView({ id: "ok-2", name: "  第二条  ", oneLiner: undefined, family: undefined }),
    ],
  });
  assert.deepEqual(
    messy.map((s) => s.id),
    ["ok-1", "ok-2"],
    "有效条目一条不少、畸形一条不留",
  );
  assert.equal(messy[1].name, "第二条", "前后空白裁掉");
  assert.equal(messy[1].oneLiner, "", "缺字段给空串，不编造文案");
  assert.equal(messy[1].family, "");

  assert.deepEqual(parseSlashSkills({ error: "skill_read_failed", skills: undefined }), []);
  assert.deepEqual(parseSlashSkills(null), []);
  assert.deepEqual(parseSlashSkills([skillView()]), [], "裸数组不是契约形状");

  const many = parseSlashSkills({
    skills: Array.from({ length: 12 }, (_, i) => skillView({ id: `s-${i}`, name: `技能${i}` })),
  });
  assert.equal(many.length, SLASH_MENU_LIMIT, "最多 8 列");
});

test("解析 families → id 对简体标签（标签真源在上游，缺席退回原始 id）", () => {
  const labels = parseFamilyLabels({
    families: [
      { id: "cinema-auteur", label: "电影美学", count: 40 },
      { id: "ad-tvc", label: "商业广告", count: 10 },
      { id: "no-label" },
      null,
      "junk",
    ],
  });
  assert.deepEqual(labels, { "cinema-auteur": "电影美学", "ad-tvc": "商业广告" });
  assert.deepEqual(parseFamilyLabels({ skills: [] }), {});
  assert.deepEqual(parseFamilyLabels(undefined), {});
});

/* ------------------------------------------------------------------ */
/* 竞态保护：先发的旧请求后到，不得覆盖新结果                            */
/* ------------------------------------------------------------------ */

test("竞态判定：换代或取消的请求一律丢弃（真 AbortController）", () => {
  const stale = new AbortController();
  const fresh = new AbortController();

  assert.equal(shouldAcceptSlashResponse(true, fresh.signal), true, "活着的新请求可用");

  // 用户又打了一个字：effect cleanup＝旧请求作废（abort + alive=false）。
  stale.abort();
  const staleAlive = false;
  assert.equal(shouldAcceptSlashResponse(staleAlive, stale.signal), false);
  // 只有 abort 传到、alive 还没翻的窗口，也必须是丢弃（双保险）。
  assert.equal(shouldAcceptSlashResponse(true, stale.signal), false, "abort 后旧响应仍不得覆盖新结果");
  assert.equal(shouldAcceptSlashResponse(staleAlive, fresh.signal), false, "已换代的 effect 不再采信任何响应");
  // 后到的是新请求 → 照收。
  assert.equal(shouldAcceptSlashResponse(true, fresh.signal), true);
});

test("debounce 常量在下限之上（≥150ms，本片取 160ms）", () => {
  assert.ok(
    SLASH_MENU_DEBOUNCE_MS >= 150,
    `debounce ${SLASH_MENU_DEBOUNCE_MS}ms 必须 ≥150ms（每次击键都打上游＝打必应）`,
  );
});

/* ------------------------------------------------------------------ */
/* 源码探针（变更探针，非 oracle）：DOM 交互待真浏览器验收                */
/* ------------------------------------------------------------------ */

test("源码探针：Esc 分支不送出不清理，关着菜单时的既有送出契约逐字未变", () => {
  const slashBlockStart = composer.indexOf("if (P.slashMenuOpen) {");
  assert.ok(slashBlockStart >= 0, "composer 必须有斜线菜单的键盘分支");
  const slashBlockEnd = composer.indexOf("// Enter 发送，Shift+Enter 换行。");
  assert.ok(slashBlockEnd > slashBlockStart, "键盘分支边界必须能定位");
  const slashBlock = composer.slice(slashBlockStart, slashBlockEnd);

  // Esc 只收菜单：这个分支里不许出现送出/清空输入框的调用（不送出＝本片硬要求）。
  assert.doesNotMatch(slashBlock, /handleSend\(/, "Esc/上下键分支不得触发送出");
  assert.doesNotMatch(slashBlock, /setText\(/, "Esc 不得清掉使用者打的指令");
  assert.match(slashBlock, /P\.setSlashArmed\(false\)/);
  // Enter/Tab 是「选中」：写回输入框走 handleSlashPick，不自动送出。
  assert.match(slashBlock, /handleSlashPick\(picked\)/);
  assert.match(composer, /onPick=\{handleSlashPick\}/);

  // 关着菜单的既有行为（送出/换行/IME）逐字仍在——本片不许动这条路径。
  assert.match(composer, /if \(event\.key === "Enter" && !event\.shiftKey\) \{/);
  assert.match(composer, /if \(event\.nativeEvent\.isComposing \|\| event\.keyCode === 229\) return;/);
  assert.match(composer, /const canSend = computeCanSend\(P\.trimmed, readyRefs\.length, P\.attachments\);/);
});

/* ================================================================== */
/* 「我的技能」并入斜线菜单（2026-09-27）：合并／分区／跨区索引／错误人话 */
/* ================================================================== */

/** 菜单一列（与 SlashMenuSkill 同构）。 */
function menuSkill(id: string, family = "cinema-auteur"): SlashMenuSkill {
  return { id, name: `技能-${id}`, oneLiner: `${id} 的一句话`, family };
}

test("两路合并：公开在上、我的在下；空 my 区不产生分区标题", () => {
  const pub = [menuSkill("pub-1"), menuSkill("pub-2")];
  const sections = mergeSlashResults(pub, [menuSkill("mine-1")]);
  assert.deepEqual(
    sections.map((section) => section.key),
    ["public", "mine"],
    "分区顺序固定：公开在上、我的在下",
  );
  assert.equal(sections[0].label, "", "公开区不挂标题");
  assert.equal(sections[1].label, SLASH_MINE_SECTION_LABEL);
  assert.deepEqual(
    flattenSlashRows(sections).map((skill) => skill.id),
    ["pub-1", "pub-2", "mine-1"],
  );

  // 未登入（401 静默略过 → my 为空）＝没有分区标题、没有空区块。
  const publicOnly = mergeSlashResults(pub, []);
  assert.equal(publicOnly.length, 1);
  assert.equal(publicOnly[0].key, "public");
  assert.ok(!publicOnly.some((section) => section.label.includes("我的")));

  // 公开为空、我的有命中 → 只渲染我的区（不摆空的公开标题）。
  const mineOnly = mergeSlashResults([], [menuSkill("mine-1")]);
  assert.deepEqual(mineOnly.map((section) => section.key), ["mine"]);

  // 两边都空 → 空表（渲染层给「没有匹配的技能」，不伪造条目）。
  assert.deepEqual(mergeSlashResults([], []), []);
});

test("两路合并：按 id 去重（公开那条优先）＋各自上限截断", () => {
  const sections = mergeSlashResults(
    [menuSkill("same"), menuSkill("pub-2")],
    [menuSkill("same"), menuSkill("mine-1")],
  );
  const rows = flattenSlashRows(sections);
  assert.deepEqual(rows.map((skill) => skill.id), ["same", "pub-2", "mine-1"]);
  assert.equal(rows.filter((skill) => skill.id === "same").length, 1, "同一 id 不得出现两列");

  const many = (prefix: string) =>
    Array.from({ length: 12 }, (_, i) => menuSkill(`${prefix}-${i}`));
  const merged = flattenSlashRows(mergeSlashResults(many("p"), many("m")));
  assert.equal(merged.length, SLASH_MENU_LIMIT * 2, "两区各自截到 menu limit");
  assert.equal(merged.filter((skill) => skill.id.startsWith("p-")).length, SLASH_MENU_LIMIT);
  assert.equal(merged.filter((skill) => skill.id.startsWith("m-")).length, SLASH_MENU_LIMIT);
});

test("跨区索引：展平顺序＝公开+我的；分区标题不进选区、越界/空区回 undefined", () => {
  const sections = mergeSlashResults(
    [menuSkill("p1"), menuSkill("p2")],
    [menuSkill("m1")],
  );
  const rows = flattenSlashRows(sections);
  assert.equal(rows.length, 3, "分区标题（我的技能）不算一列");

  assert.equal(slashSkillAt(rows, 0)?.id, "p1");
  assert.equal(slashSkillAt(rows, 2)?.id, "m1", "跨区第 3 列就是我的首条");
  assert.equal(slashSkillAt(rows, 3), undefined, "越界回 undefined，不崩");
  assert.equal(slashSkillAt(rows, -1), undefined);
  assert.equal(slashSkillAt(rows, 1.5), undefined, "非整数索引不落项");
  assert.equal(slashSkillAt([], 0), undefined, "空表取项恒 undefined");

  // 上下键跨两区连续移动（公开末行 → 我的首行；我的首行 → 公开首行＝回绕）。
  assert.equal(slashSkillAt(rows, moveActiveIndex(1, 1, rows.length))?.id, "m1");
  assert.equal(slashSkillAt(rows, moveActiveIndex(2, 1, rows.length))?.id, "p1");
  assert.equal(slashSkillAt(rows, moveActiveIndex(0, -1, rows.length))?.id, "m1");

  // 空 my 区：展平长度＝公开数，回绕取项不落 undefined。
  const publicOnly = flattenSlashRows(mergeSlashResults([menuSkill("p1")], []));
  assert.equal(publicOnly.length, 1);
  assert.notEqual(slashSkillAt(publicOnly, moveActiveIndex(0, 1, publicOnly.length)), undefined);
});

test("竞态判定：两路各自独立（一路作废不牵连另一路）", () => {
  const publicController = new AbortController();
  const mineController = new AbortController();

  publicController.abort();
  assert.equal(shouldAcceptSlashResponse(true, publicController.signal), false);
  assert.equal(
    shouldAcceptSlashResponse(true, mineController.signal),
    true,
    "公开路被取消，不得让「我的技能」路一起丢结果",
  );
  assert.equal(shouldAcceptSlashResponse(true, mineController.signal), true);

  // 换查询词：两路一起作废（cleanup abort 两个 controller）。
  mineController.abort();
  assert.equal(shouldAcceptSlashResponse(true, mineController.signal), false);
  assert.equal(shouldAcceptSlashResponse(false, new AbortController().signal), false);
});

test("我的技能端点 URL：列举固定路由，单条删除做真编码", () => {
  assert.equal(slashMineUrl(), "/api/skills/mine");
  assert.equal(mineSkillUrl("user-cinema-abc12345"), "/api/skills/mine/user-cinema-abc12345");
  assert.equal(mineSkillUrl("a/b c"), "/api/skills/mine/a%2Fb%20c", "id 里的斜线/空格必须编码");
});

test("解析我的技能：真形状照收（编辑要用的栏位齐全），畸形条目丢掉", () => {
  const rows = parseMySkills({
    skills: [
      {
        id: "user-cine-1",
        name: "霓虹夜路",
        oneLiner: "低照度霓虹",
        family: "cinema-auteur",
        useScenario: "夜景独白",
        inputType: "一句场景",
        outputContent: "一张夜景图",
        outputKind: "image",
        tags: ["夜景", "霓虹"],
        toolIds: ["image_generate"],
        source: "user",
      },
      { name: "没有 id" },
      null,
      "junk",
    ],
  });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    id: "user-cine-1",
    name: "霓虹夜路",
    oneLiner: "低照度霓虹",
    family: "cinema-auteur",
    useScenario: "夜景独白",
    inputType: "一句场景",
    outputContent: "一张夜景图",
    outputKind: "image",
    tags: ["夜景", "霓虹"],
  });
  assert.deepEqual(parseMySkills({ error: "unauthorized" }), []);
  assert.deepEqual(parseMySkills(undefined), []);
});

test("标签切分：逗号/顿号/换行都算分隔，去空去重、上限 8", () => {
  assert.deepEqual(splitSkillTags("夜景，霓虹、手持\n留白"), ["夜景", "霓虹", "手持", "留白"]);
  assert.deepEqual(splitSkillTags("  ,,，、、\n "), []);
  assert.deepEqual(splitSkillTags("a，a，b"), ["a", "b"], "重复标签去掉");
  const nine = splitSkillTags(Array.from({ length: 10 }, (_, i) => `t${i}`).join("，"));
  assert.equal(nine.length, 8, "上限 8 个");
});

test("错误人话：各档都翻译成中文，且绝不回传原始 reason 原文", () => {
  const cases: Array<[unknown, number | undefined]> = [
    ["invalid_skill", 400],
    ["sensitive_content:api_key_sk", 400],
    ["sensitive_content:pem_private_key", 400],
    ["name_required", 400],
    ["use_scenario_too_long", 400],
    ["quota_exceeded", 429],
    ["duplicate", 409],
    ["network_error", undefined],
    [undefined, 401],
    [undefined, 404],
    ["unauthorized", 401],
    [undefined, 503],
    ["some_future_reason_we_do_not_know", 400],
  ];
  for (const [reason, status] of cases) {
    const text = humanizeSkillError(reason, status);
    assert.ok(text.length > 0, "必须给出一句话");
    assert.match(text, /[\u4e00-\u9fa5]/, "必须是中文人话");
    assert.doesNotMatch(text, /[a-z_]+_[a-z_]+/, "不得出现后端 snake_case 代码");
    assert.doesNotMatch(text, /sensitive_content|api_key|sk-/i, "凭证类不得回传原始代码/命中种类");
    assert.doesNotMatch(text, /invalid_skill|quota_exceeded|unauthorized|duplicate/);
    if (typeof reason === "string") {
      assert.ok(!text.includes(reason), "任何情况下都不得原样回传 reason");
    }
  }

  assert.match(humanizeSkillError(undefined, 401), /登录/);
  assert.match(humanizeSkillError("sensitive_content:api_key_sk", 400), /密钥|隐私/);
  assert.equal(
    humanizeSkillError("some_future_reason_we_do_not_know", 400),
    "操作没成功，请检查填写内容后重试。",
    "不认识的代码给通用人话，不转发原文",
  );
  assert.match(humanizeSkillError("network_error"), /网络/);
});

test("型别推导的 toolIds 全部来自真实 harness 注册表（不在表里的进不去）", () => {
  for (const kind of SKILL_OUTPUT_KINDS) {
    const ids = deriveToolIds(kind.id);
    assert.ok(ids.length > 0, `${kind.id} 必须推导出至少一个工具`);
    for (const id of ids) {
      assert.ok(HARNESS_TOOL_IDS.has(id), `${kind.id} 推导的 ${id} 必须在 HARNESS_TOOL_IDS 内`);
    }
  }
  assert.deepEqual(deriveToolIds("not-a-kind"), [], "未知型别回空（呼叫端据此挡下送出，不猜）");
});

test("源码探针：管理面用翻译过的错误、删除要二次确认、未登入不假成功", () => {
  const dialog = read("src/components/agent-chat/MySkillsDialog.tsx");
  assert.match(dialog, /登录后可以保存自己的技能/);
  assert.match(dialog, /humanizeSkillError\(reason, res\.status\)/, "400/404 的 reason 必须过人话翻译");
  assert.doesNotMatch(
    dialog,
    /setError\(\s*(?:data\.)?reason\s*\)/,
    "不得把后端 reason 原文直接当使用者文案",
  );
  assert.match(dialog, /确定删除？/, "删除要二次确认");
  assert.match(dialog, /method: "DELETE"/);
  assert.match(dialog, /method: "POST"/);
  assert.match(dialog, /\/api\/skills\/mine/);
  // 入口只在既有设定弹层（不造第二个入口）。
  const settings = read("src/components/agent-chat/AgentSettingsPopover.tsx");
  assert.match(settings, /我的技能/);
  assert.match(settings, /<MySkillsDialog onClose=\{\(\) => setSkillsOpen\(false\)\} \/>/);
});
