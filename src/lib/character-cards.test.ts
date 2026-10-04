// 角色卡纯逻辑测试（P2 锁定注入语义）：
//   - 注入顺序（卡 id 序）、幂等（同卡两次 / apply 两次）
//   - 负面词合并去重、参考图角色保留与 url 去重
//   - 生成请求体锁定：applyCharacterCardsToPayload 后请求确实含卡内容
//     （UI 宣称「卡生效」的真实能力锁——请求体不含卡内容即测试失败）
//   - 无卡时零漂移：payload 原样返回
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyCharacterCards,
  applyCharacterCardsToPayload,
  CHARACTER_CARD_KIND_LABEL,
  CHARACTER_CARD_KIND_VALUES,
  clearApproval,
  isAssetApproved,
  normalizeApprovalState,
  normalizeCharacterCard,
  setApproval,
  toCharacterCardKind,
  type CharacterCard,
  type CharacterCardKind,
} from "./character-cards";
import {
  ENTITY_TOKEN_PATTERN,
  expandEntityTokens,
  parseEntityTokens,
  resolveEntityTokenKind,
  serializeEntityToken,
} from "./entity-tokens";

function card(partial: Partial<CharacterCard> & { id: string }): CharacterCard {
  return {
    name: partial.id,
    kind: "character",
    prompt: "",
    references: [],
    createdAt: "2026-08-22T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z",
    ...partial,
  };
}

test("applyCharacterCards：卡按 id 升序注入前缀（与传入顺序无关）", () => {
  const a = card({ id: "card-a", prompt: "红发少女，蓝色军装" });
  const b = card({ id: "card-b", prompt: "赛博庞克雨夜街道" });
  const applied = applyCharacterCards("一只柴犬", [b, a]);
  assert.equal(applied.prompt, "红发少女，蓝色军装\n赛博庞克雨夜街道\n一只柴犬");
});

test("applyCharacterCards：幂等——同一卡两次只注入一次；apply 两次结果相同", () => {
  const a = card({ id: "card-a", prompt: "红发少女" });
  const b = card({ id: "card-b", prompt: "雨夜街道" });
  const once = applyCharacterCards("夜景", [a, a, b]);
  assert.equal(once.prompt, "红发少女\n雨夜街道\n夜景");
  const twice = applyCharacterCards(once.prompt, [a, b]);
  assert.equal(twice.prompt, once.prompt);
});

test("applyCharacterCards：正文已含的片段不重复注入", () => {
  const a = card({ id: "card-a", prompt: "红发少女" });
  const applied = applyCharacterCards("红发少女 在海边", [a]);
  assert.equal(applied.prompt, "红发少女 在海边");
});

test("applyCharacterCards：负面词合并去重；无负面词回 null", () => {
  const a = card({ id: "card-a", negativePrompt: "多手指" });
  const b = card({ id: "card-b", negativePrompt: "多手指" }); // 同词 → 去重
  const c = card({ id: "card-c", negativePrompt: "模糊" });
  const applied = applyCharacterCards("夜景", [a, b, c]);
  assert.equal(applied.negativePrompt, "多手指, 模糊");
  assert.equal(applyCharacterCards("夜景", [card({ id: "d" })]).negativePrompt, null);
});

test("applyCharacterCards：参考图角色保留、url 去重、非法 URL 丢弃", () => {
  const a = card({
    id: "card-a",
    references: [
      { url: "https://img.example/char.png", role: "character", name: "角色定妆照" },
      { url: "https://img.example/char.png", role: "style", name: "同 URL 应去重" },
      { url: "javascript:alert(1)", role: "general", name: "非法 URL" },
    ],
  });
  const b = card({
    id: "card-b",
    references: [{ url: "https://img.example/style.png", role: "style", name: "风格" }],
  });
  const applied = applyCharacterCards("夜景", [a, b]);
  assert.equal(applied.references.length, 2);
  assert.equal(applied.references[0].role, "character");
  assert.equal(applied.references[0].name, "角色定妆照");
  assert.equal(applied.references[1].role, "style");
});

test("applyCharacterCardsToPayload：请求体确实含卡内容（锁定生效的真实能力锁）", () => {
  const a = card({
    id: "card-a",
    prompt: "红发少女，蓝色军装",
    negativePrompt: "多手指",
    references: [{ url: "https://img.example/char.png", role: "character", name: "角色定妆照" }],
  });
  const payload = {
    prompt: "在阳台上喝咖啡",
    model: "gpt-image-2",
    count: 1,
    reference_images: [{ url: "https://img.example/manual.png", role: "general", name: "手动引用" }],
  };
  const result = applyCharacterCardsToPayload(payload, [a]);
  assert.ok(result.prompt.startsWith("红发少女，蓝色军装"));
  assert.ok(result.prompt.includes("在阳台上喝咖啡"));
  assert.equal(result.negative_prompt, "多手指");
  // 卡参考图在最前（locked 优先），原有参考保留其后，角色保留。
  assert.equal(result.reference_images?.length, 2);
  assert.equal(result.reference_images?.[0].url, "https://img.example/char.png");
  assert.equal(result.reference_images?.[0].role, "character");
  assert.equal(result.reference_images?.[1].url, "https://img.example/manual.png");
  // 其余栏位不改动。
  assert.equal(result.model, "gpt-image-2");
  assert.equal(result.count, 1);
});

test("applyCharacterCardsToPayload：卡与手动引用同 URL 去重；负面词与既有值合并", () => {
  const a = card({
    id: "card-a",
    prompt: "红发少女",
    negativePrompt: "模糊",
    references: [{ url: "https://img.example/same.png", role: "character", name: "卡图" }],
  });
  const payload = {
    prompt: "夜景",
    negative_prompt: "多手指",
    reference_images: [{ url: "https://img.example/same.png", role: "general", name: "手动" }],
  };
  const result = applyCharacterCardsToPayload(payload, [a]);
  assert.equal(result.reference_images?.length, 1);
  // 同 URL：locked 角色优先（卡在前，角色 character 保留）。
  assert.equal(result.reference_images?.[0].role, "character");
  assert.equal(result.negative_prompt, "多手指, 模糊");
});

test("applyCharacterCardsToPayload：无卡 / 空卡原样返回（零行为漂移）", () => {
  const payload = { prompt: "夜景", count: 1 };
  assert.equal(applyCharacterCardsToPayload(payload, []), payload);
  const empty = applyCharacterCardsToPayload(payload, [card({ id: "card-empty" })]);
  assert.equal(empty, payload);
  assert.equal("negative_prompt" in empty, false);
});

test("normalizeCharacterCard：style kind 原样保留（风格卡清洗后不回落 character）", () => {
  const ok = normalizeCharacterCard({
    id: "card-style",
    name: "水彩风格",
    kind: "style",
    prompt: "",
    references: [{ url: "https://img.example/style.png", role: "style", name: "风格样张" }],
  });
  assert.ok(ok);
  assert.equal(ok?.kind, "style");
  assert.equal(ok?.references[0].role, "style");
  // applyCharacterCardsToPayload 对 style 卡照常注入参考图（卡种类不影响锁定语义）。
  const payload = { prompt: "夜景", count: 1 };
  const result = applyCharacterCardsToPayload(payload, [ok!]);
  assert.equal(result.reference_images?.[0].url, "https://img.example/style.png");
  assert.equal(result.reference_images?.[0].role, "style");
});

test("normalizeCharacterCard：清洗、上限与非法输入", () => {
  const ok = normalizeCharacterCard({
    id: "card-1",
    name: "主角",
    kind: "scene",
    prompt: "  沙漠废墟  ",
    references: [{ url: "https://img.example/a.png", role: "bogus", name: "" }],
    negativePrompt: "  ",
    loraIds: ["lora-1", "", 3],
  });
  assert.ok(ok);
  assert.equal(ok?.kind, "scene");
  assert.equal(ok?.prompt, "沙漠废墟");
  assert.equal(ok?.references[0].role, "general"); // 非法角色 → general
  assert.equal(ok?.references[0].name, "主角"); // 空名回退卡名
  assert.equal(ok?.negativePrompt, undefined); // 空白负面词丢弃
  assert.deepEqual(ok?.loraIds, ["lora-1"]);
  assert.equal(normalizeCharacterCard({ id: "", name: "x" }), null);
  assert.equal(normalizeCharacterCard({ id: "x", name: 123 }), null);
  assert.equal(normalizeCharacterCard(null), null);
  assert.equal(toCharacterCardKind("scene"), "scene");
  assert.equal(toCharacterCardKind("style"), "style");
  assert.equal(toCharacterCardKind("nonsense"), "character");
  // 击穿收敛：大小写与近似拼写都不是合法 kind，必须回落 character（旧数据/agent 乱填不炸）。
  assert.equal(toCharacterCardKind("Style"), "character");
  assert.equal(toCharacterCardKind("styles"), "character");
  assert.equal(toCharacterCardKind(123), "character");
});

// ─────────────────────────────────────────── 挂接契约（源码级，仓库既有模式）
// 端到端逻辑验证的替代（不开浏览器、不模拟站内鉴权）：
//   1. 纯函数层：applyCharacterCardsToPayload 已在上面锁定「请求体确实含卡内容」。
//   2. 这里锁定「挂接点真的存在」：CanvasEmbed 的 callCanvasGenerate 必须调用
//      applyCharacterCardsToPayload（否则 UI 宣称的「卡生效」是假的）；
//      hook 必须把 cardIds 持久化进 CanvasProject 并暴露 activeCharacterCards；
//      /api/canvas/generate 必须把 negative_prompt 并进 workflow 下游链路。
import { readFileSync } from "node:fs";

test("挂接契约：CanvasEmbed 生成唯一出口注入卡（手动+agent 同路）", () => {
  // 2026-08-22 CanvasEmbed 域拆分（Task 7）：生成编排搬 embed/use-canvas-generation.ts、
  // 存为卡搬 embed/use-canvas-interaction.ts、卡面板搬 embed/CanvasEmbedOverlays.tsx——
  // 断言语义不变，read 路径改为壳+新档拼接（同本档 use-canvas-chat 拆分后的模式）。
  const source = [
    "src/components/canvas/CanvasEmbed.tsx",
    "src/components/canvas/embed/use-canvas-generation.ts",
    "src/components/canvas/embed/use-canvas-interaction.ts",
    "src/components/canvas/embed/context-menu-items.ts",
    "src/components/canvas/embed/CanvasEmbedOverlays.tsx",
  ].map((p) => readFileSync(p, "utf8")).join("\n");
  assert.match(source, /applyCharacterCardsToPayload\(payload as CardAwareGeneratePayload/);
  assert.match(source, /canvasStateRef\.current\.activeCharacterCards/);
  // 存为卡动作 + 卡面板（生效 badge）
  assert.match(source, /存为卡并锁定/);
  assert.match(source, /toggleCharacterCard/);
});

test("挂接契约：use-canvas-chat 持久化 cardIds 并暴露锁定卡", () => {
  const source = [
    "src/hooks/use-canvas-chat.ts",
    "src/hooks/canvas/canvas-chat-types.ts",
    "src/hooks/canvas/canvas-project-sync.ts",
    "src/hooks/canvas/use-canvas-cards.ts",
    "src/hooks/canvas/canvas-event-settler.ts",
    "src/hooks/canvas/canvas-reducer-adapter.ts",
  ].map((p) => readFileSync(p, "utf8")).join("\n");
  assert.match(source, /activeCardIdsRef\.current,/);
  assert.match(source, /target\.cardIds/);
  assert.match(source, /const activeCharacterCards = useMemo/);
  // agent 上行摘要含锁定卡
  assert.match(source, /base\.character_cards/);
});

test("挂接契约：/api/canvas/generate 把卡负面词并进 workflow 链路", () => {
  const source = readFileSync("src/app/api/canvas/generate/route.ts", "utf8");
  assert.match(source, /negative_prompt\?: string/);
  assert.match(source, /negativePrompt \? \{ negativePrompt \}/);
  // JSON 与 multipart 两条路径都带 workflow
  assert.match(source, /\.\.\.\(workflowField \? \{ workflow: workflowField \} : \{\}\)/);
  assert.match(source, /if \(workflowField\) form\.append\("workflow", workflowField\)/);
});

test("挂接契约：/api/character-cards 站内鉴权 + blob store", () => {
  const route = readFileSync("src/app/api/character-cards/route.ts", "utf8");
  assert.match(route, /requireVerifiedUser/);
  assert.match(route, /saveCharacterCard/);
  assert.match(route, /deleteCharacterCards/);
  const store = readFileSync("src/lib/character-card-store.ts", "utf8");
  // 后端判断已收口到 blob-backend.ts 的单一真源（VPS selector ∪ BLOB_READ_WRITE_TOKEN）；
  // store 必须经共用门禁 ensureBlobBackendWritable，不得自带 token-only 判断（会静默降级到记忆体）。
  assert.match(store, /from "@\/lib\/blob-backend"/);
  assert.match(store, /ensureBlobBackendWritable/);
  assert.doesNotMatch(store, /BLOB_READ_WRITE_TOKEN/);
});

// ─────────────────────────────────────────── 实体模型扩充（道具/音频/变体 + 行内 token）
// 全部为**行为断言**：跑真函式、比对真输出（源码字串断言不计入「已验证」）。

test("kind 值域：五种 kind 都过 normalizeCharacterCard，prop/audio 不回退 character", () => {
  assert.equal(CHARACTER_CARD_KIND_VALUES.length, 5);
  assert.deepEqual([...CHARACTER_CARD_KIND_VALUES], ["character", "scene", "style", "prop", "audio"]);
  for (const kind of CHARACTER_CARD_KIND_VALUES) {
    const normalized = normalizeCharacterCard({
      id: `card-${kind}`,
      name: `名称-${kind}`,
      kind,
      prompt: `${kind} 描述`,
      references: [{ url: `https://img.example/${kind}.png`, role: "general", name: `${kind} 图` }],
    });
    assert.ok(normalized, `${kind} 卡清洗后不应为 null`);
    assert.equal(normalized?.kind, kind, `${kind} 不应被收敛成其他 kind`);
    assert.equal(normalized?.references[0].url, `https://img.example/${kind}.png`);
  }
  assert.equal(toCharacterCardKind("prop"), "prop");
  assert.equal(toCharacterCardKind("audio"), "audio");
  // 未知/中文种类字仍收敛 character（旧数据不炸），但合法值一个都不许掉。
  assert.equal(toCharacterCardKind("道具"), "character");
  assert.equal(toCharacterCardKind("Prop"), "character");
  assert.equal(CHARACTER_CARD_KIND_LABEL.prop, "道具");
  assert.equal(CHARACTER_CARD_KIND_LABEL.audio, "音频");

  // 真行为：道具卡（kind=prop）与角色卡同权参与视觉锁定——不因新 kind 被静默丢弃。
  const prop = normalizeCharacterCard({
    id: "card-prop",
    name: "青铜匕首",
    kind: "prop",
    prompt: "祖传青铜匕首，刃口缺口",
    references: [{ url: "https://img.example/dagger.png", role: "general", name: "道具图" }],
  });
  const applied = applyCharacterCards("握在手中", [prop!]);
  assert.equal(applied.prompt, "祖传青铜匕首，刃口缺口\n握在手中");
  assert.equal(applied.references[0].url, "https://img.example/dagger.png");
});

test("kind 值域：音频卡被视觉链路完全忽略（不进前缀、不进参考图，负面词也不进）", () => {
  const visual = card({ id: "card-a", prompt: "红发少女" });
  const audio = card({
    id: "card-b",
    kind: "audio",
    prompt: "轻快钢琴配乐",
    negativePrompt: "杂音",
    references: [{ url: "https://img.example/bgm.png", role: "general", name: "音频封面" }],
  });
  const applied = applyCharacterCards("夜景", [visual, audio]);
  assert.equal(applied.prompt, "红发少女\n夜景");
  assert.equal(applied.references.length, 0);
  assert.equal(applied.negativePrompt, null);
});

test("variantOf 清洗：正常保留、含 `:` 省略、自环省略、非字串省略，且不影响整张卡存活", () => {
  const base = normalizeCharacterCard({ id: "card-base", name: "霍辞渊", kind: "character" });
  assert.ok(base);
  const variant = normalizeCharacterCard({
    id: "card-variant",
    name: "劼后-霍辞渊",
    kind: "character",
    variantOf: "  card-base  ",
    prompt: "劼后造型",
  });
  assert.ok(variant, "变体母卡指针坏掉不该让卡本身消失");
  assert.equal(variant?.variantOf, "card-base"); // trim 后保留
  assert.equal(variant?.kind, "character"); // 变体不新增 kind
  // 走 JSON 往返再清洗（＝blob store 读回路径）→ variantOf 逐字存活、不收敛。
  const reloaded = normalizeCharacterCard(JSON.parse(JSON.stringify(variant)));
  assert.deepEqual(reloaded, variant);
  // 含保留分隔符 `:` → 只省略该栏位
  const colon = normalizeCharacterCard({ id: "card-c", name: "x", variantOf: "card:base" });
  assert.ok(colon);
  assert.equal(colon?.variantOf, undefined);
  assert.equal("variantOf" in (colon ?? {}), false);
  // 自环 → 省略（不制造鬼引用）
  const selfRef = normalizeCharacterCard({ id: "card-self", name: "x", variantOf: "card-self" });
  assert.ok(selfRef);
  assert.equal(selfRef?.variantOf, undefined);
  // 非字串 / 控制字元 / 超长 → 省略
  for (const bad of [123, null, {}, "", "   ", "card\u0000base", "a".repeat(101)]) {
    const normalized = normalizeCharacterCard({ id: "card-x", name: "x", variantOf: bad });
    assert.ok(normalized, `variantOf=${String(bad)} 不应让整张卡回 null`);
    assert.equal(normalized?.variantOf, undefined, `variantOf=${String(bad)} 应被省略`);
  }
});

test("variantOf：母卡存在或缺席都照常参与注入（fail-open，不报错不丢卡）", () => {
  const mother = card({ id: "card-mother", name: "霍辞渊", prompt: "银发红瞳" });
  const variant = card({
    id: "card-variant",
    name: "劼后-霍辞渊",
    prompt: "劼后造型，金冠",
    variantOf: "card-mother",
    references: [{ url: "https://img.example/jie.png", role: "character", name: "劼后定妆" }],
  });
  const orphan = card({ id: "card-orphan", name: "无母变体", prompt: "孤儿造型", variantOf: "card-ghost" });
  const applied = applyCharacterCards("站著", [mother, variant, orphan]);
  assert.equal(applied.prompt, "银发红瞳\n孤儿造型\n劼后造型，金冠\n站著"); // id 升序：mother < orphan < variant
  assert.equal(applied.references.length, 1);
  assert.equal(applied.references[0].url, "https://img.example/jie.png");
});

// ── 行内 token：解析 / 序列化 / 种类字正规化

test("resolveEntityTokenKind：正/简/英文皆收，其余 null", () => {
  const cases: [string, CharacterCardKind][] = [
    ["角色", "character"],
    ["人物", "character"],
    ["character", "character"],
    ["场景", "scene"],
    ["场景", "scene"],
    ["scene", "scene"],
    ["风格", "style"],
    ["风格", "style"],
    ["style", "style"],
    ["道具", "prop"],
    ["prop", "prop"],
    ["音频", "audio"],
    ["音频", "audio"],
    ["音效", "audio"],
    ["配乐", "audio"],
    ["配乐", "audio"],
    ["audio", "audio"],
    [" 角色 ", "character"], // 两侧空白容忍
  ];
  for (const [label, expected] of cases) {
    assert.equal(resolveEntityTokenKind(label), expected, `${label} 应映射 ${expected}`);
  }
  for (const bogus of ["", "   ", "怪物", "Character", "scenes", "声优", "video"]) {
    assert.equal(resolveEntityTokenKind(bogus), null, `${bogus} 应回 null`);
  }
});

test("parseEntityTokens：位置正确、先后有序、重复呼叫不串味（lastIndex 不泄漏）", () => {
  const prompt = "前 @[角色:霍辞渊] 中 @[场景:雨夜街道] 后";
  const first = parseEntityTokens(prompt);
  assert.equal(first.length, 2);
  assert.equal(prompt.slice(first[0].start, first[0].end), "@[角色:霍辞渊]");
  assert.equal(prompt.slice(first[1].start, first[1].end), "@[场景:雨夜街道]");
  // 全域正则共用会残留 lastIndex：同一输入解析两次必须逐字相同。
  assert.deepEqual(parseEntityTokens(prompt), first);
  assert.equal(ENTITY_TOKEN_PATTERN.global, true);
  // 名称含种类字/英数/中文标点皆可；巢状 `[` `]` 不匹配。
  const messy = parseEntityTokens("@[道具:破旧的[青铜]匕首]");
  assert.equal(messy.length, 0);
  assert.deepEqual(parseEntityTokens(""), []);
});

test("serializeEntityToken：往返一致（序列化→解析得回同一种类与名称）", () => {
  for (const kind of CHARACTER_CARD_KIND_VALUES) {
    const token = serializeEntityToken({ kind, name: "测试实体" });
    assert.ok(token.startsWith("@[") && token.endsWith("]"));
    const hits = parseEntityTokens(`看 ${token} 一眼`);
    assert.equal(hits.length, 1, `${kind} 的 token 应可被解析`);
    assert.equal(hits[0].name, "测试实体");
    assert.equal(resolveEntityTokenKind(hits[0].kindLabel), kind, `${kind} 序列化后应解析回同一 kind`);
    assert.equal(serializeEntityToken({ kind, name: hits[0].name }), token);
  }
});

test("expandEntityTokens：命中就地展开（在原位置，不是搬到开头）", () => {
  const her = card({ id: "card-her", name: "霍辞渊", prompt: "银发红瞳少女" });
  const scene = card({ id: "card-scene", kind: "scene", name: "雨夜街道", prompt: "赛博庞克雨夜街道" });
  const source = "镜头1：@[角色:霍辞渊] 站在 @[场景:雨夜街道] 前";
  const result = expandEntityTokens(source, [her, scene]);
  assert.equal(result.prompt, "镜头1：银发红瞳少女 站在 赛博庞克雨夜街道 前");
  assert.notEqual(result.prompt, `${her.prompt}\n${source}`); // 不是前缀搬移
  assert.deepEqual(result.usedCardIds, ["card-her", "card-scene"]); // 首次出现序
  assert.deepEqual(result.unresolved, []);
  // 不 mutate 输入
  assert.equal(source, "镜头1：@[角色:霍辞渊] 站在 @[场景:雨夜街道] 前");
  assert.equal(her.prompt, "银发红瞳少女");
});

test("expandEntityTokens：未命中保留原样并回报；零 token 逐位元不变", () => {
  const her = card({ id: "card-her", name: "霍辞渊", prompt: "银发红瞳" });
  const miss = expandEntityTokens("带上 @[角色:不存在] 和 @[怪物:外神] 和 @[角色:不存在] 前进", [her]);
  assert.equal(miss.prompt, "带上 @[角色:不存在] 和 @[怪物:外神] 和 @[角色:不存在] 前进");
  assert.deepEqual(miss.usedCardIds, []);
  assert.deepEqual(miss.unresolved, ["@[角色:不存在]", "@[怪物:外神]"]); // 去重、首次出现序
  const none = expandEntityTokens("完全没有 token 的正文", [her]);
  assert.equal(none.prompt, "完全没有 token 的正文");
  assert.deepEqual(none.usedCardIds, []);
  assert.deepEqual(none.unresolved, []);
});

test("expandEntityTokens：同名同 kind 多张卡取阵列第一张；空片段回退卡名", () => {
  const first = card({ id: "card-1", name: "小美", prompt: "红裙" });
  const second = card({ id: "card-2", name: "小美", prompt: "蓝裙" });
  const hit = expandEntityTokens("@[角色:小美] 出场", [first, second]);
  assert.equal(hit.prompt, "红裙 出场");
  assert.deepEqual(hit.usedCardIds, ["card-1"]); // 刻意 fail-safe：取第一张
  const bare = card({ id: "card-3", name: "水彩风", kind: "style", prompt: "" });
  const bareHit = expandEntityTokens("@[风格:水彩风] 上色", [bare]);
  assert.equal(bareHit.prompt, "水彩风 上色"); // 空片段 → 用卡名，不留空
  // 种类对不上不命中：kind 必须一致（同名 scene 卡不吃 character token）。
  const wrongKind = card({ id: "card-4", name: "小美", kind: "scene", prompt: "场景小美" });
  assert.equal(expandEntityTokens("@[角色:小美] 出场", [wrongKind]).prompt, "@[角色:小美] 出场");
});

// ── applyCharacterCards 新语义

test("applyCharacterCards：token 引用的卡不重复进前缀；未引用卡照常前缀", () => {
  const her = card({ id: "card-her", name: "霍辞渊", prompt: "银发红瞳少女" });
  const scene = card({ id: "card-scene", kind: "scene", name: "雨夜街道", prompt: "赛博庞克雨夜街道" });
  const style = card({ id: "card-style", kind: "style", name: "水彩", prompt: "水彩画风" });
  const applied = applyCharacterCards("@[角色:霍辞渊] 在 @[场景:雨夜街道] 回头", [her, scene, style]);
  assert.equal(applied.prompt, "水彩画风\n银发红瞳少女 在 赛博庞克雨夜街道 回头");
  // 被引用的两张卡不进前缀（不重复），未引用的风格卡进前缀。
  assert.equal(applied.prompt.split("银发红瞳少女").length, 2);
  assert.equal(applied.prompt.split("水彩画风").length, 2);
});

test("applyCharacterCards：幂等（含 referenceScope: \"referenced\"）", () => {
  const her = card({
    id: "card-her",
    name: "霍辞渊",
    prompt: "银发红瞳少女",
    references: [{ url: "https://img.example/her.png", role: "character", name: "定妆" }],
  });
  const scene = card({
    id: "card-scene",
    kind: "scene",
    name: "雨夜街道",
    prompt: "赛博庞克雨夜街道",
    references: [{ url: "https://img.example/scene.png", role: "general", name: "场景" }],
  });
  for (const options of [undefined, { referenceScope: "referenced" as const }]) {
    const source = "@[角色:霍辞渊] 走进 @[场景:雨夜街道]";
    const once = applyCharacterCards(source, [her, scene], options);
    assert.equal(once.prompt, "银发红瞳少女 走进 赛博庞克雨夜街道");
    const twice = applyCharacterCards(once.prompt, [her, scene], options);
    assert.equal(twice.prompt, once.prompt, "第二次必须逐字相同（靠 base.includes 判准挡掉重复前缀）");
    assert.equal(applyCharacterCards(twice.prompt, [her, scene], options).prompt, once.prompt);
  }
  // 纯文字（无 token）路径的既有幂等同样保住。
  const plain = applyCharacterCards("夜景", [her, scene]);
  assert.equal(applyCharacterCards(plain.prompt, [her, scene]).prompt, plain.prompt);
});

test("applyCharacterCards：referenceScope \"referenced\" 只收被引用卡的参考图；无 token 退回 all", () => {
  const her = card({
    id: "card-her",
    name: "霍辞渊",
    prompt: "银发红瞳少女",
    negativePrompt: "多手指",
    references: [{ url: "https://img.example/her.png", role: "character", name: "定妆" }],
  });
  const scene = card({
    id: "card-scene",
    kind: "scene",
    name: "雨夜街道",
    prompt: "赛博庞克雨夜街道",
    negativePrompt: "白天",
    references: [{ url: "https://img.example/scene.png", role: "general", name: "场景" }],
  });
  const scoped = applyCharacterCards("@[角色:霍辞渊] 特写", [her, scene], { referenceScope: "referenced" });
  assert.deepEqual(scoped.references.map((r) => r.url), ["https://img.example/her.png"]);
  // 负面词不随参考图收窄（收窄会让画面失控）。
  assert.equal(scoped.negativePrompt, "多手指, 白天");
  // 零 token → 退回全收，不静默丢参考图。
  const fallback = applyCharacterCards("两人都要", [her, scene], { referenceScope: "referenced" });
  assert.deepEqual(fallback.references.map((r) => r.url), [
    "https://img.example/her.png",
    "https://img.example/scene.png",
  ]);
  // 出参契约：未命中 token 不算「有引用」（usedCardIds 空）→ 同样退回 all，
  // 未命中的 token 原样留在正文（fail-open），卡片段照常前缀。
  const missOnly = applyCharacterCards("@[角色:查无此人] 特写", [her, scene], { referenceScope: "referenced" });
  assert.equal(missOnly.prompt, "银发红瞳少女\n赛博庞克雨夜街道\n@[角色:查无此人] 特写");
  assert.equal(missOnly.references.length, 2);
});

test("applyCharacterCards：target \"audio\" 只吃音频卡、references 一律空", () => {
  const visual = card({ id: "card-a", prompt: "红发少女", negativePrompt: "多手指" });
  const bgm = card({
    id: "card-bgm",
    kind: "audio",
    name: "离别配乐",
    prompt: "轻快钢琴配乐",
    negativePrompt: "杂音",
    references: [{ url: "https://img.example/bgm.png", role: "general", name: "封面" }],
  });
  const applied = applyCharacterCards("黄昏的离别", [visual, bgm], { target: "audio" });
  assert.equal(applied.prompt, "轻快钢琴配乐\n黄昏的离别");
  assert.deepEqual(applied.references, []);
  assert.equal(applied.negativePrompt, "杂音"); // 视觉卡的负面词不进音频链路
  // 音频 token 同样就地展开（音频链路没有「参考图」但有「指名」）。
  const named = applyCharacterCards("@[音频:离别配乐] 但更慢", [bgm], { target: "audio" });
  assert.equal(named.prompt, "轻快钢琴配乐 但更慢");
  // 卡清单里没有音频卡 → 原样返回。
  const none = applyCharacterCards("黄昏的离别", [visual], { target: "audio" });
  assert.equal(none.prompt, "黄昏的离别");
  assert.deepEqual(none.references, []);
  assert.equal(none.negativePrompt, null);
  assert.equal(applyCharacterCards("黄昏的离别", [], { target: "audio" }).prompt, "黄昏的离别");
});

test("音频卡参考物清洗：data:audio/ 不得被纯图片尺静默丢掉（kind-aware 收口；视觉卡尺不放宽）", () => {
  const embeddedAudio = "data:audio/mpeg;base64,SUQzBAo=";
  const remoteAudio = "https://store.example/bgm.mp3";
  const coverImage = "data:image/png;base64,iVBORw0KGgo=";
  const normalized = normalizeCharacterCard({
    id: "card-bgm",
    name: "离别配乐",
    kind: "audio",
    prompt: "轻快钢琴配乐",
    references: [
      { url: embeddedAudio, role: "general", name: "内嵌样本" },
      { url: remoteAudio, role: "general", name: "远端样本" },
      { url: coverImage, role: "general", name: "封面图" },
    ],
  });
  assert.ok(normalized, "音频卡清洗后不得为 null");
  // 旧尺（只认 http / data:image）会把内嵌音频静默丢掉 → 卡变成没有载体的空壳。
  assert.deepEqual(normalized?.references.map((r) => r.url), [embeddedAudio, remoteAudio, coverImage]);
  // 幂等往复：清洗后的卡再清洗一次逐栏不变（储存层每次写入都过这把尺）。
  assert.deepEqual(normalizeCharacterCard(normalized), normalized);
  // 视觉卡同一把尺不放宽：data:audio/ 不是图片 → 该条丢、卡本体存活。
  const visual = normalizeCharacterCard({
    id: "card-visual",
    name: "霍辞渊",
    kind: "character",
    references: [{ url: embeddedAudio, role: "character", name: "误传音频" }],
  });
  assert.ok(visual);
  assert.deepEqual(visual?.references, []);
  // 未给 kind（旧资料/agent 乱填）＝收敛 character → 同样不收 data:audio/（不放宽未知值）。
  assert.deepEqual(
    normalizeCharacterCard({ id: "card-x", name: "x", references: [{ url: embeddedAudio }] })?.references,
    [],
  );
});

test("音频卡注入语义（真输出）：只吃音频片段、参考物不进 references、负面词只收音频卡", () => {
  const character = card({
    id: "card-char",
    name: "霍辞渊",
    prompt: "银发红瞳少女",
    negativePrompt: "多手指",
    references: [{ url: "https://img.example/her.png", role: "character", name: "定妆" }],
  });
  const bgm = card({
    id: "card-bgm",
    kind: "audio",
    name: "离别配乐",
    prompt: "轻快钢琴配乐",
    negativePrompt: "杂音",
    references: [{ url: "data:audio/mpeg;base64,SUQzBAo=", role: "general", name: "样本" }],
  });
  const applied = applyCharacterCards("黄昏的离别", [character, bgm], { target: "audio" });
  assert.equal(applied.prompt, "轻快钢琴配乐\n黄昏的离别");
  assert.equal(applied.prompt.includes("银发红瞳少女"), false, "视觉卡的片段不得进音频 prompt");
  assert.deepEqual(applied.references, [], "音频链路没有参考图语义（音频参考物不得冒充图片）");
  assert.equal(applied.negativePrompt, "杂音", "负面词只收参与音频链路的卡");
  // 幂等：拿上一次输出再跑一次逐栏相同。
  assert.deepEqual(applyCharacterCards(applied.prompt, [character, bgm], { target: "audio" }), applied);

  // 请求体挂接：prompt 带音频片段、负面词就位，其余栏位逐位不动、参考图栏不被音频参考物污染。
  const payload: {
    prompt: string;
    model: string;
    reference_images: { url: string; role: "general"; name: string }[];
    negative_prompt?: string | null;
  } = { prompt: "黄昏的离别", model: "tts-default", reference_images: [] };
  const hooked = applyCharacterCardsToPayload(payload, [character, bgm], { target: "audio" });
  assert.equal(hooked.prompt, "轻快钢琴配乐\n黄昏的离别");
  assert.equal(hooked.negative_prompt, "杂音");
  assert.deepEqual(hooked.reference_images, []);
  assert.equal(hooked.model, "tts-default");
});

test("target 缺省＝零回归：带 data:audio/ 参考与负面词的音频卡对视觉请求体零影响", () => {
  const character = card({ id: "card-char", prompt: "银发红瞳少女" });
  const bgm = card({
    id: "card-bgm",
    kind: "audio",
    prompt: "轻快钢琴配乐",
    negativePrompt: "杂音",
    references: [{ url: "data:audio/mpeg;base64,SUQzBAo=", role: "general", name: "样本" }],
  });
  const payload: {
    prompt: string;
    model: string;
    reference_images: { url: string; role: "general"; name: string }[];
    negative_prompt?: string | null;
  } = {
    prompt: "特写",
    model: "gpt-image-2",
    reference_images: [{ url: "https://img.example/manual.png", role: "general", name: "手动" }],
  };
  const hooked = applyCharacterCardsToPayload(payload, [character, bgm]);
  assert.equal(hooked.prompt, "银发红瞳少女\n特写");
  assert.deepEqual(hooked.reference_images?.map((r) => r.url), ["https://img.example/manual.png"]);
  assert.equal(hooked.negative_prompt, undefined, "音频卡的负面词不得进视觉请求体");
  // 清单里只有音频卡 → 原样返回同一物件（零漂移）。
  assert.equal(applyCharacterCardsToPayload(payload, [bgm]), payload);
  // 音频 token 在缺省 target 下不展开（fail-open 原样留在正文）：`@[音频:…]` 不会凭空变片段。
  assert.equal(applyCharacterCards("@[音频:离别配乐] 特写", [bgm]).prompt, "@[音频:离别配乐] 特写");
});

test("applyCharacterCards：target 缺省＝既有行为（改动前语义等价对照）", () => {
  const a = card({ id: "card-a", prompt: "红发少女，蓝色军装", negativePrompt: "多手指" });
  const b = card({ id: "card-b", prompt: "赛博庞克雨夜街道" });
  const c = card({ id: "card-c", kind: "style", prompt: "水彩画风" });
  const base = "一只柴犬";
  const legacy = "红发少女，蓝色军装\n赛博庞克雨夜街道\n水彩画风\n一只柴犬";
  assert.equal(applyCharacterCards(base, [c, b, a]).prompt, legacy); // id 升序无关传入序
  assert.deepEqual(applyCharacterCards(base, [a, b, c]), applyCharacterCards(base, [a, b, c], {}));
  assert.deepEqual(
    applyCharacterCards(base, [a, b, c]),
    applyCharacterCards(base, [a, b, c], { target: "visual", referenceScope: "all" }),
  );
  // 含 token 的正文在缺省 target 下也走视觉链路（audio 卡被忽略）。
  const audio = card({ id: "card-d", kind: "audio", prompt: "配乐" });
  assert.equal(applyCharacterCards(base, [a, audio]).prompt, "红发少女，蓝色军装\n一只柴犬");
});

test("applyCharacterCardsToPayload：options 透传且不改动其余栏位", () => {
  const her = card({
    id: "card-her",
    name: "霍辞渊",
    prompt: "银发红瞳少女",
    negativePrompt: "多手指",
    references: [{ url: "https://img.example/her.png", role: "character", name: "定妆" }],
  });
  const scene = card({
    id: "card-scene",
    kind: "scene",
    name: "雨夜街道",
    prompt: "赛博庞克雨夜街道",
    references: [{ url: "https://img.example/scene.png", role: "general", name: "场景" }],
  });
  const payload = {
    prompt: "@[角色:霍辞渊] 站在 @[场景:雨夜街道] 前",
    model: "gpt-image-2",
    reference_images: [{ url: "https://img.example/manual.png", role: "general" as const, name: "手动" }],
  };
  // 没被 token 点到的风格卡：正文里没有它的 token，片段不进前缀、参考图被收窄排除。
  const style = card({
    id: "card-style-extra",
    kind: "style",
    name: "水彩",
    prompt: "水彩画风",
    references: [{ url: "https://img.example/style.png", role: "style", name: "风格样张" }],
  });
  const result = applyCharacterCardsToPayload(payload, [her, scene, style], { referenceScope: "referenced" });
  // 未引用的风格卡片段照常前缀（referenceScope 只管参考图，不管片段注入）。
  assert.equal(result.prompt, "水彩画风\n银发红瞳少女 站在 赛博庞克雨夜街道 前");
  assert.equal(result.negative_prompt, "多手指");
  // 两张卡都被 token 引用 → 两张卡的参考图都在；未引用的风格卡参考图被排除。
  assert.deepEqual(result.reference_images?.map((r) => r.url), [
    "https://img.example/her.png",
    "https://img.example/scene.png",
    "https://img.example/manual.png",
  ]);
  assert.equal(result.model, "gpt-image-2");
  // 同输入改回缺省 scope → 风格卡的参考图重新参与（收窄是 opt-in，不是新默认）。
  const widened = applyCharacterCardsToPayload(payload, [her, scene, style]);
  assert.equal(widened.prompt, result.prompt);
  assert.equal(widened.reference_images?.length, 4);
  // 音频链路：无音频卡 → 原样同一物件（零漂移）。
  assert.equal(applyCharacterCardsToPayload(payload, [her], { target: "audio" }), payload);
});

// ─────────────────────────────────────────── 资产批准状态（2026-09-24 决策 23/4）

test("isAssetApproved：缺省 approval ＝ 已批准（决策 23 存量相容）；未给 mode 一律已批准", () => {
  assert.equal(isAssetApproved(undefined), true);
  assert.equal(isAssetApproved(undefined, "collaborate"), true);
  assert.equal(isAssetApproved(null, "collaborate"), true);
  assert.equal(isAssetApproved({ status: "approved" }, "collaborate"), true);
  assert.equal(isAssetApproved({ status: "pending" }, "collaborate"), false);
  assert.equal(isAssetApproved({ status: "rejected", reason: "光影不对" }, "collaborate"), false);
});

test("护城河：全自动两档（preset/auto）对 pending/rejected 卡一律视为已批准、不挡", () => {
  for (const mode of ["preset", "auto"] as const) {
    for (const status of ["pending", "rejected"] as const) {
      assert.equal(isAssetApproved({ status }, mode), true, `${mode}/${status} 必须放行`);
    }
  }
});

test("setApproval/clearApproval：纯函式回新卡；驳回理由可原样读回（含 normalize 唯一收口往复）", () => {
  const base = card({ id: "card-her", name: "霍辞渊" });
  const rejected = setApproval(base, "rejected", {
    decidedAt: "2026-09-24T10:00:00.000Z",
    reason: "光影与剧本不符",
  });
  assert.equal(base.approval, undefined, "不改传入卡（纯函式）");
  assert.deepEqual(rejected.approval, {
    status: "rejected",
    decidedAt: "2026-09-24T10:00:00.000Z",
    reason: "光影与剧本不符",
  });
  assert.equal(rejected.updatedAt, "2026-09-24T10:00:00.000Z", "批准动作更新 updatedAt（列表按它排序）");
  // 唯一收口：写入的卡过 normalizeCharacterCard 逐栏不变（decidedAt/reason 不被吞）
  assert.deepEqual(normalizeCharacterCard(JSON.parse(JSON.stringify(rejected))), rejected);

  const approved = setApproval(rejected, "approved", { decidedAt: "2026-09-24T11:00:00.000Z" });
  assert.deepEqual(approved.approval, { status: "approved", decidedAt: "2026-09-24T11:00:00.000Z" }, "换状态不残留旧 reason");
  assert.equal(isAssetApproved(approved.approval, "collaborate"), true);

  const cleared = clearApproval(approved);
  assert.equal("approval" in cleared, false, "清除＝回到缺省（栏位整个消失）");
  assert.equal(isAssetApproved(cleared.approval, "collaborate"), true);
  assert.equal(clearApproval(base), base, "本来就没有 approval → 回同一物件（呼叫端可略过写入）");
});

test("normalizeCharacterCard：approval 非三值域/半形 → 栏位省略（＝已批准），不整张卡作废", () => {
  for (const junk of [{ status: "maybe" }, { reason: "没有 status" }, "approved", ["approved"], { status: 7 }]) {
    const normalized = normalizeCharacterCard({ id: "card-x", name: "x", approval: junk });
    assert.ok(normalized, `approval=${JSON.stringify(junk)} 不得让整张卡作废`);
    assert.equal("approval" in normalized, false, `approval=${JSON.stringify(junk)} 应省略栏位`);
    assert.equal(isAssetApproved(normalized.approval, "collaborate"), true);
  }
  const blankReason = normalizeCharacterCard({ id: "card-y", name: "y", approval: { status: "rejected", reason: "   " } });
  assert.deepEqual(blankReason?.approval, { status: "rejected" }, "纯空白理由＝没有理由");
  assert.equal(normalizeApprovalState({ status: "pending" })?.status, "pending");
  assert.equal(normalizeApprovalState(undefined), null);
});
