// 变装子资产（对称差 D8「变装作为角色的一等子资产」）＋强制补齐的真实行为断言。
//
// 全部走真函式（不 mock、不假卡库、不碰网路）：
//   1. 变装清单为一等子资产（多个具名变装挂同一张角色卡，各带自己的识别与参考图）
//   2. 可新增变装（addCharacterDisguise：命名＋参考图；重复＝覆盖；非法＝null）
//   3. 强制补齐（requiredDisguises 对帐：具名回报缺哪些；缺件不得用主造型顶替）
//      ——**fail-closed 落在资料面**：缺件时参考图与 prompt 片段双清（needsAsset 只是回报栏位，
//      生产端无人读它，光靠旗标挡不住「挑 referenceImages/prompt 就出图」）。
//   4. 消费端 drama-recipe storyboardToBatchTasks：roles → referenceImages 真的取到变装参考；
//      未解析的变装宣告 ⇒ 本镜**所有角色卡**去造型（场景/道具卡不受影响）
//   5. 旧资料相容：只有 variantOf、没有变装清单的卡逐位不变（零回归）
//   6. 作用域不变：AssetScope（含 team）清洗结果与卡上是否带变装无关
//
// 位置索引（本档断言的实作落点，2026-09-28）：
//   - character-cards.ts:133 variantOf 定义／:307-308 写入端清洗／:331 写出栏位／
//     :753 applyCharacterCards 消费注记／:754+ 卡池过滤
//   - character-cards.ts:95-104 CharacterCardDisguise 型别／:140 disguises 栏／
//     :147 requiredDisguises 栏／:311-313 清洗落点／:332-333 写出栏位
//   - character-cards.ts:417 disguiseIdFromName／:427 单笔清洗／:453 清单清洗（去重键＝id 或 name，留最后一张）／
//     :499 新增（addCharacterDisguise）／:529 要求写入／:550 单卡对帐／
//     :583 全库对帐／:603 解析选择／:649 套用变装（缺件＝参考图与 prompt 双清）
//   - drama-recipe.ts:71-93 分镜变装宣告清洗／:188 shot.disguises 栏／:325 清洗接入／
//     :515 变装解析／:527-543 换装落点（未解析宣告⇒本镜全部角色卡去造型）／
//     :567 needsAsset 闸／:597-609 强制补齐闸
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addCharacterDisguise,
  auditCharacterDisguises,
  auditDisguiseRequirements,
  disguiseIdFromName,
  MAX_DISGUISES_PER_CARD,
  MAX_REQUIRED_DISGUISES,
  normalizeCharacterCard,
  normalizeCharacterDisguises,
  normalizeRequiredDisguises,
  resolveCharacterDisguises,
  setRequiredDisguises,
  withCharacterDisguises,
  type CharacterCard,
  type CharacterCardDisguise,
} from "./character-cards";
import { auditDramaDisguiseRequirements, storyboardToBatchTasks } from "./drama-recipe";
import {
  assetShareId,
  canUseAsset,
  filterLockedCardsForProjectUse,
  filterUsableAssets,
  resolveAssetScopeVisibility,
  type AssetScope,
  type AssetUseContext,
} from "./asset-scope";

// ─────────────────────────────────────────── 测试夹具

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

function ref(url: string, name: string, role: "character" | "scene" | "style" = "character") {
  return { url, role, name };
}

/** 男主要角：主造型 + 两个具名变装（每个都有自己的参考图）。 */
function heroWithDisguises(): CharacterCard {
  const base = card({
    id: "C01",
    name: "霍辞渊",
    prompt: "主造型：玄色长袍",
    references: [ref("https://main/hero.png", "男主主图")],
    negativePrompt: "多手指",
    loraIds: ["lora-hero"],
  });
  const withXia = addCharacterDisguise(base, {
    name: "侠客造型",
    prompt: "侠客：斗笠与披风",
    references: [ref("https://dg/xia.png", "侠客定妆")],
  });
  assert.ok(withXia, "夹具：侠客造型新增不应被拒");
  const withWed = addCharacterDisguise(withXia, {
    name: "婚服造型",
    prompt: "婚服：红袍金冠",
    references: [ref("https://dg/wed.png", "婚服定妆")],
  });
  assert.ok(withWed, "夹具：婚服造型新增不应被拒");
  return withWed;
}

function sceneCard(): CharacterCard {
  return card({
    id: "P01",
    name: "雨夜客栈",
    kind: "scene",
    prompt: "雨夜客栈内景",
    references: [ref("https://main/scene.png", "客栈", "scene")],
  });
}

// ═══════════════════════════════════════════ 1. 变装清单为一等子资产

test("一等子资产：一个角色可挂多个具名变装，各带自己的 id/名字/参考图，且不摊平成第二张卡", () => {
  const hero = heroWithDisguises();
  assert.equal(hero.disguises?.length, 2, "同一张卡应同时挂两个变装");
  const names = hero.disguises?.map((d) => d.name);
  assert.deepEqual(names, ["侠客造型", "婚服造型"], "变装名应逐一保留（具名状态的载体）");
  // 每个变装有自己在本卡内唯一的稳定识别。
  const ids = new Set(hero.disguises?.map((d) => d.id));
  assert.equal(ids.size, 2);
  assert.equal(hero.disguises?.[0].id, "侠客造型"); // 由名字导出（disguiseIdFromName）
  // 每个变装有自己的参考图（不是共用主造型的）。
  assert.equal(hero.disguises?.[0].references[0].url, "https://dg/xia.png");
  assert.equal(hero.disguises?.[1].references[0].url, "https://dg/wed.png");
  const allDisguiseUrls = (hero.disguises ?? []).flatMap((d) => d.references.map((r) => r.url));
  assert.equal(allDisguiseUrls.includes("https://main/hero.png"), false, "变装参考不得混入主造型参考");
  // 母卡身分不变：仍是同一张 character 卡，不是新的一张角色卡。
  assert.equal(hero.id, "C01");
  assert.equal(hero.name, "霍辞渊");
  assert.equal(hero.kind, "character");
  assert.equal(hero.references.map((r) => r.url).join(","), "https://main/hero.png");
});

test("一等子资产：变装清单走存档收口（JSON 往返再清洗）后逐位存活", () => {
  const hero = heroWithDisguises();
  const revived = normalizeCharacterCard(JSON.parse(JSON.stringify(hero)));
  assert.ok(revived);
  assert.deepEqual(revived.disguises, hero.disguises, "往返后变装清单（含参考图）应逐位相同");
});

test("一等子资产：变装参考图与卡参考图共用同一把尺（>8 截尾、非法 URL 丢、data:audio 丢）", () => {
  const many = normalizeCharacterDisguises([
    {
      name: "造型A",
      references: [
        ...Array.from({ length: 10 }, (_, i) => ref(`https://a/${i}.png`, `n${i}`)),
        ref("data:audio/mpeg;base64,AAAA", "内嵌音频", "character" as never),
        ref("ftp://nope/x.png", "非法协议"),
        null,
      ],
    },
  ]);
  assert.equal(many.length, 1);
  assert.equal(many[0].references.length, 8, "单一变装参考上限与 MAX_CARD_REFERENCES 同界（8）");
  assert.deepEqual(
    many[0].references.map((r) => r.url),
    Array.from({ length: 8 }, (_, i) => `https://a/${i}.png`),
  );
  // 非法项（含 data:audio，角色变装不是音频卡）一律丢，不让半形资产进清单。
  assert.equal(many[0].references.some((r) => r.url.includes("audio")), false);
});

test("一等子资产：变装清单清洗的边界（无名丢、非物件丢、同 id 只留最后一张、自指丢）", () => {
  assert.deepEqual(normalizeCharacterDisguises([null, 1, "x", { id: "d" }, { name: "   " }]), []);
  assert.deepEqual(
    normalizeCharacterDisguises([{ id: "d1", name: "甲" }, { id: "d1", name: "乙" }, { name: "丙" }]).map((d) => [
      d.id,
      d.name,
    ]),
    [
      ["d1", "乙"],
      ["丙", "丙"],
    ],
  );
  // 自指（变装 id ＝ 卡本体 id）＝鬼引用，卡片清洗时丢掉（与 variantOf 自环同款处置）。
  const nc = normalizeCharacterCard({
    id: "C01",
    name: "霍辞渊",
    disguises: [{ id: "C01", name: "自指" }, { name: "侠客造型" }],
  });
  assert.deepEqual(nc?.disguises?.map((d) => d.name), ["侠客造型"]);
});

test("一等子资产：清单上限 MAX_DISGUISES_PER_CARD 生效（截尾不炸）", () => {
  const raw = Array.from({ length: MAX_DISGUISES_PER_CARD + 5 }, (_, i) => ({ name: `变装${i}` }));
  assert.equal(normalizeCharacterDisguises(raw).length, MAX_DISGUISES_PER_CARD);
});

// ═══════════════════════════════════════════ 2. 可新增变装

test("新增：为既有角色新增变装（命名＋参考图）后清单与读回结果正确，且不改传入卡", () => {
  const base = card({ id: "C01", name: "霍辞渊", prompt: "主造型" });
  const added = addCharacterDisguise(base, {
    name: "侠客造型",
    prompt: "斗笠披风",
    references: [ref("https://dg/xia.png", "侠客定妆")],
  });
  assert.ok(added);
  assert.equal(added.disguises?.length, 1);
  assert.equal(added.disguises?.[0].name, "侠客造型");
  assert.equal(added.disguises?.[0].prompt, "斗笠披风");
  assert.deepEqual(added.disguises?.[0].references, [ref("https://dg/xia.png", "侠客定妆")]);
  assert.notEqual(added.updatedAt, base.updatedAt, "卡内容变了 → updatedAt 应更新");
  // 纯函式：原卡不动（旧况的 zero-drift）。
  assert.equal(base.disguises, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(base, "disguises"), false);
  // 读回（存档收口 + JSON 往返）仍取得到。
  const revived = normalizeCharacterCard(JSON.parse(JSON.stringify(added)));
  assert.deepEqual(revived?.disguises, added.disguises);
  // 第二个变装独立并入，不动第一个。
  const second = addCharacterDisguise(added, { name: "婚服造型", references: [ref("https://dg/wed.png", "婚服定妆")] });
  assert.deepEqual(second?.disguises?.map((d) => d.name), ["侠客造型", "婚服造型"]);
  assert.deepEqual(second?.disguises?.[0].references[0].url, "https://dg/xia.png");
});

test("新增：重复命名＝覆盖（张数不成长，参考图换新）；同 id 亦覆盖", () => {
  const once = addCharacterDisguise(card({ id: "C01", name: "霍辞渊" }), {
    name: "侠客造型",
    references: [ref("https://dg/v1.png", "旧图")],
  });
  assert.ok(once);
  assert.equal(once.disguises?.length, 1);
  const twice = addCharacterDisguise(once, { name: "侠客造型", references: [ref("https://dg/v2.png", "新图")] });
  assert.equal(twice?.disguises?.length, 1, "同名重复新增不得长出第二张");
  assert.deepEqual(twice?.disguises?.[0].references.map((r) => r.url), ["https://dg/v2.png"]);
  // 同 id（明示 id）亦覆盖，即使名字不同。
  const byId = addCharacterDisguise(once, { id: "侠客造型", name: "换了名字的造型", references: [] });
  assert.equal(byId?.disguises?.length, 1);
  assert.equal(byId?.disguises?.[0].name, "换了名字的造型");
});

test("新增：非法命名／非法情境一律拒收（回 null，不制造半形资产）", () => {
  const hero = card({ id: "C01", name: "霍辞渊" });
  // 名含保留分隔符 `:` → id 导不出 → 拒收。
  assert.equal(addCharacterDisguise(hero, { name: "造型:甲" }), null);
  assert.equal(disguiseIdFromName("造型:甲"), null);
  // 无名／空白名 / 超长名 → 拒收。
  assert.equal(addCharacterDisguise(hero, { name: "   " }), null);
  assert.equal(addCharacterDisguise(hero, { name: "名".repeat(61) }), null);
  // 非角色卡（变装是角色的子资产）→ 拒收。
  assert.equal(addCharacterDisguise(card({ id: "P01", kind: "scene" }), { name: "侠客造型" }), null);
  assert.equal(addCharacterDisguise(card({ id: "P02", kind: "prop" }), { name: "侠客造型" }), null);
  // 自指（id ＝ 卡本体 id）→ 拒收。
  assert.equal(addCharacterDisguise(hero, { id: "C01", name: "自指" }), null);
  // 空白的花式 id 由名字重新导出（不制造鬼 id）。
  const derived = addCharacterDisguise(hero, { id: "  ", name: " 侠客 造型 " });
  assert.equal(derived?.disguises?.[0].id, "侠客-造型");
});

test("新增：满 MAX_DISGUISES_PER_CARD 后新增被拒，但覆盖既有仍允许", () => {
  let full = card({ id: "C01", name: "霍辞渊" });
  for (let i = 0; i < MAX_DISGUISES_PER_CARD; i += 1) {
    const next = addCharacterDisguise(full, { name: `变装${i}` });
    assert.ok(next, `第 ${i + 1} 个变装不应被拒`);
    full = next;
  }
  assert.equal(full.disguises?.length, MAX_DISGUISES_PER_CARD);
  assert.equal(addCharacterDisguise(full, { name: "溢出造型" }), null, "超上限的新增应拒收");
  const overwritten = addCharacterDisguise(full, { name: "变装0", references: [ref("https://dg/new.png", "新图")] });
  assert.equal(overwritten?.disguises?.length, MAX_DISGUISES_PER_CARD, "覆盖不得长出第 13 张");
  assert.deepEqual(overwritten?.disguises?.find((d) => d.name === "变装0")?.references.map((r) => r.url), [
    "https://dg/new.png",
  ]);
});

test("新增 ／ 解析：名字导出 id 的稳定规则（空白折 `-`、trim）", () => {
  assert.equal(disguiseIdFromName(" 侠客 造型 "), "侠客-造型");
  assert.equal(disguiseIdFromName("侠客造型"), "侠客造型");
  assert.equal(disguiseIdFromName(""), null);
  assert.equal(disguiseIdFromName(null), null);
});

// ═══════════════════════════════════════════ 3. 强制补齐

test("强制补齐（正例）：要求全部具备 → complete=true，present 全列、missing 空", () => {
  const hero = heroWithDisguises();
  const required = setRequiredDisguises(hero, ["侠客造型", "婚服造型"]);
  const audit = auditCharacterDisguises(required);
  assert.equal(audit.complete, true);
  assert.deepEqual(audit.required, ["侠客造型", "婚服造型"]);
  assert.deepEqual(audit.present, ["侠客造型", "婚服造型"]);
  assert.deepEqual(audit.missing, []);
  assert.deepEqual(audit.provided, ["侠客造型", "婚服造型"]);
  const report = auditDisguiseRequirements([required, sceneCard()]);
  assert.equal(report.complete, true);
  assert.deepEqual(report.gaps, []);
  assert.deepEqual(report.satisfiedCardIds, ["C01"]);
});

test("强制补齐（反例）：缺件时具名回报缺哪些，且不以主造型冒充已补齐", () => {
  const hero = heroWithDisguises();
  const required = setRequiredDisguises(hero, ["侠客造型", "婚服造型", "战损造型"]);
  const audit = auditCharacterDisguises(required);
  assert.equal(audit.complete, false);
  assert.deepEqual(audit.missing, ["战损造型"], "缺件必须具名回报（不是布林、不是静默）");
  assert.deepEqual(audit.present, ["侠客造型", "婚服造型"]);
  // 完全没补齐的角色：缺件＝全部要求（顺序＝宣告序，回报稳定）。
  const empty = setRequiredDisguises(card({ id: "C02", name: "沈砚" }), ["战损造型", "便服造型"]);
  assert.deepEqual(auditCharacterDisguises(empty).missing, ["战损造型", "便服造型"]);
  // 主造型（references / prompt）不影响对帐：它不是变装，不计入 provided。
  assert.deepEqual(auditCharacterDisguises(empty).provided, []);
});

test("强制补齐：全库对帐逐卡具名（cardId + cardName + missingDisguises），无要求的旧卡零追溯", () => {
  const satisfied = setRequiredDisguises(heroWithDisguises(), ["侠客造型"]);
  const gapped = setRequiredDisguises(card({ id: "C02", name: "沈砚" }), ["战损造型"]);
  const legacy = card({ id: "C03", name: "旧角色" }); // 无 requiredDisguises
  const report = auditDisguiseRequirements([legacy, satisfied, gapped]);
  assert.equal(report.complete, false);
  assert.deepEqual(report.gaps, [{ cardId: "C02", cardName: "沈砚", missingDisguises: ["战损造型"] }]);
  assert.deepEqual(report.satisfiedCardIds, ["C01"]);
  // 没有要求的卡不进 gaps、不进 satisfied（零追溯）。
  assert.equal(report.gaps.some((g) => g.cardId === "C03"), false);
  assert.equal(report.satisfiedCardIds.includes("C03"), false);
  assert.equal(auditDisguiseRequirements([legacy]).complete, true);
});

test("强制补齐：要求清单清洗（去重 / trim / 上限）与清除（空清单＝回缺省，不写空阵列）", () => {
  assert.deepEqual(normalizeRequiredDisguises(["a", "a", "  a  ", "", 1, null]), ["a"]);
  const many = Array.from({ length: MAX_REQUIRED_DISGUISES + 3 }, (_, i) => `r${i}`);
  assert.equal(normalizeRequiredDisguises(many).length, MAX_REQUIRED_DISGUISES);
  const hero = heroWithDisguises();
  const set = setRequiredDisguises(hero, ["侠客造型"]);
  assert.deepEqual(set.requiredDisguises, ["侠客造型"]);
  const cleared = setRequiredDisguises(set, []);
  assert.equal(Object.prototype.hasOwnProperty.call(cleared, "requiredDisguises"), false, "空清单＝清掉要求，不写空阵列");
  // 存档收口：无要求＝不写该栏位（旧卡零改动）。
  const normalized = normalizeCharacterCard({ id: "C01", name: "霍辞渊" });
  assert.equal(Object.prototype.hasOwnProperty.call(normalized ?? {}, "requiredDisguises"), false);
});

test("强制补齐：不得静默用主造型顶替——绑定式宣告缺件时该卡参考清空且任务不可提交", () => {
  const hero = heroWithDisguises();
  // 卡侧要求：战损造型尚未补齐 → 设定阶段闸必须回报。
  const required = setRequiredDisguises(hero, ["战损造型"]);
  const storyboard = {
    shots: [
      {
        shotId: "S-01",
        prompt: "血战之后",
        characterCardIds: ["C01"],
        disguises: [{ cardId: "C01", name: "战损造型" }],
      },
    ],
  };
  const report = auditDramaDisguiseRequirements(storyboard, [required]);
  assert.equal(report.complete, false);
  assert.deepEqual(report.missingFromShots, [{ shotId: "S-01", missingDisguiseNames: ["战损造型"] }]);
  assert.deepEqual(report.missingOnCards, [
    { cardId: "C01", cardName: "霍辞渊", missingDisguises: ["战损造型"] },
  ]);
  // 同一个宣告走任务切分：needsAsset 闸锁住，且主造型参考不得代打。
  const tasks = storyboardToBatchTasks(storyboard, [required]);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].needsAsset, true, "缺件必须锁住任务");
  assert.deepEqual(tasks[0].missingDisguiseNames, ["战损造型"]);
  const urls = tasks[0].referenceImages.map((r) => r.url);
  assert.deepEqual(urls, [], "绑定式缺件＝该角色本镜没有参考，主造型（https://main/hero.png）不得顶替");
  assert.equal(urls.includes("https://main/hero.png"), false);
});

// ═══════════════════════════════════════════ 4. 消费端（drama-recipe）

test("消费端：分镜宣告命中变装 → referenceImages 真的取到变装参考（不是主造型、也不只断言被呼叫）", () => {
  const hero = heroWithDisguises();
  const tasks = storyboardToBatchTasks(
    {
      shots: [
        {
          shotId: "S-01",
          prompt: "推门而入",
          characterCardIds: ["C01"],
          sceneCardIds: ["P01"],
          disguises: [{ cardId: "C01", name: "侠客造型" }],
        },
      ],
    },
    [hero, sceneCard()],
  );
  assert.equal(tasks.length, 1);
  const task = tasks[0];
  assert.equal(task.needsAsset, false);
  assert.deepEqual(task.missingDisguiseNames, []);
  const urls = task.referenceImages.map((r) => r.url);
  assert.deepEqual(urls, ["https://dg/xia.png", "https://main/scene.png"], "角色参考＝变装参考（角色卡优先），场景卡照常");
  const heroRef = task.referenceImages[0];
  assert.equal(heroRef.url, "https://dg/xia.png");
  assert.equal(heroRef.role, "character");
  assert.equal(heroRef.name, "侠客定妆", "取到的是变装自己的参考（名称也来自该变装）");
  assert.equal(urls.includes("https://main/hero.png"), false, "主造型参考不得混入");
  // prompt 片段换成变装片段（不是主造型片段）。
  assert.ok(task.prompt.includes("侠客：斗笠与披风"), "应注入变装的锁定片段");
  assert.equal(task.prompt.includes("主造型：玄色长袍"), false, "主造型片段不得混入");
  // 卡的身分栏位不变（卡 id 序注入与分镜引用栏零迁移）。
  assert.deepEqual(task.loraIds, ["lora-hero"]);
  assert.equal(task.negativePrompt, "多手指");
  // 换装后才是注入集：母卡 id 仍是 C01（引用栏不变）。
  assert.equal(hero.id, "C01");
});

test("消费端：同镜宣告多个变装 → 参考图联集去重；未宣告的镜次＝主造型（零漂移）", () => {
  const hero = heroWithDisguises();
  const tasks = storyboardToBatchTasks(
    {
      shots: [
        { shotId: "S-01", prompt: "一身两影", characterCardIds: ["C01"], disguises: [{ name: "侠客造型" }, { name: "婚服造型" }] },
        { shotId: "S-02", prompt: "独自饮酒", characterCardIds: ["C01"] },
      ],
    },
    [hero],
  );
  assert.deepEqual(tasks[0].referenceImages.map((r) => r.url), ["https://dg/xia.png", "https://dg/wed.png"]);
  assert.ok(tasks[0].prompt.includes("侠客：斗笠与披风"));
  assert.ok(tasks[0].prompt.includes("婚服：红袍金冠"));
  // 未宣告变装的镜次：主造型照旧（逐位相同，不因新机制降格）。
  assert.deepEqual(tasks[1].referenceImages.map((r) => r.url), ["https://main/hero.png"]);
  assert.ok(tasks[1].prompt.includes("主造型：玄色长袍"));
  assert.equal(tasks[1].needsAsset, false);
});

test("消费端：字串（非绑定式）宣告命中＝换装；未命中＝具名缺件（needsAsset）", () => {
  const hero = heroWithDisguises();
  const tasks = storyboardToBatchTasks(
    {
      shots: [
        { shotId: "S-01", prompt: "夜行", characterCardIds: ["C01"], disguises: ["侠客造型"] },
        { shotId: "S-02", prompt: "晨起", characterCardIds: ["C01"], disguises: ["不存在的造型"] },
      ],
    },
    [hero],
  );
  assert.deepEqual(tasks[0].referenceImages.map((r) => r.url), ["https://dg/xia.png"], "非绑定式命中即换装");
  assert.equal(tasks[0].needsAsset, false);
  assert.equal(tasks[1].needsAsset, true);
  assert.deepEqual(tasks[1].missingDisguiseNames, ["不存在的造型"], "缺件必须具名回报");
});

test("消费端：变装宣告清洗（字串／物件别名、缺 name 丢、同 (cardId,name) 去重）", () => {
  const hero = heroWithDisguises();
  const tasks = storyboardToBatchTasks(
    {
      shots: [
        {
          shotId: "S-01",
          prompt: "别名形态",
          characterCardIds: ["C01"],
          disguises: [
            { characterCardId: "C01", look: "侠客造型" }, // 物件＋别名 look/characterCardId
            { card_id: "C01", disguise: "侠客造型" }, // 同 (cardId,name) → 去重
            { name: "无 cardId 的绑定量" },
            { nothing: 1 }, // 缺 name → 丢
            "",
          ],
        },
      ],
    },
    [hero],
  );
  const task = tasks[0];
  assert.deepEqual(task.referenceImages.map((r) => r.url), ["https://dg/xia.png"]);
  // 缺 name 的条目不得进缺件（不是「要求」就没有缺件）。
  assert.deepEqual(task.missingDisguiseNames, ["无 cardId 的绑定量"]);
  assert.equal(task.needsAsset, true);
});

test("消费端：绑定式缺件时 prompt 片段与参考图**双清**（fail-closed 落在资料面，不只靠 needsAsset）", () => {
  const hero = heroWithDisguises();
  const tasks = storyboardToBatchTasks(
    {
      shots: [{ shotId: "S-01", prompt: "换装场景", characterCardIds: ["C01"], disguises: [{ cardId: "C01", name: "缺的造型" }] }],
    },
    [hero],
  );
  // 收口后：参考图**与** prompt 片段都清空。理由——needsAsset 只是回报栏位，
  // repo 内没有任何生产消费端读它，光靠旗标挡不住「挑 referenceImages/prompt 就出图」的路径。
  assert.deepEqual(tasks[0].referenceImages, []);
  assert.equal(
    tasks[0].prompt.startsWith("主造型：玄色长袍"),
    false,
    "缺件不得沿用卡本体片段（否则参考图空了、文字还在＝用主造型出图）",
  );
  assert.equal(tasks[0].prompt.includes("主造型"), false);
  assert.equal(tasks[0].needsAsset, true, "回报栏位仍在：缺件任务具名给出");
});

test("消费端：非绑定式缺件时，本镜**所有**角色卡一起去造型；场景/道具卡不受影响", () => {
  // 宣告了变装却找不到同名变装（且没绑 cardId）＝无法归属到哪张卡；
  // 但作者既然宣告了变装，就不该让任何角色以主造型出图 ⇒ 全部角色卡清造型。
  const hero = heroWithDisguises();
  const other = addCharacterDisguise(
    card({ id: "C02", name: "沈砚", prompt: "沈砚：青衫", references: [ref("https://main/shen.png", "沈砚主图")] }),
    { name: "战损造型", prompt: "战损：血衣", references: [ref("https://dg/shen-hurt.png", "沈砚战损")] },
  );
  assert.ok(other, "夹具：沈砚战损新增不应被拒");
  const tasks = storyboardToBatchTasks(
    {
      shots: [
        {
          shotId: "S-02",
          prompt: "对峙",
          characterCardIds: ["C01", "C02"],
          sceneCardIds: ["P01"],
          disguises: [{ name: "缺的造型" }],
        },
      ],
    },
    [hero, other, sceneCard()],
  );
  const task = tasks[0];
  assert.deepEqual(task.missingDisguiseNames, ["缺的造型"]);
  assert.equal(task.needsAsset, true);
  // 两张角色卡的主造型参考都没进（C01 主图 / C02 主图 / 任一变装图皆无），场景参考照进。
  assert.deepEqual(task.referenceImages.map((r) => r.url), ["https://main/scene.png"]);
  assert.equal(task.prompt.includes("主造型"), false, "C01 主造型片段不得出现");
  assert.equal(task.prompt.includes("沈砚：青衫"), false, "C02 主造型片段不得出现");
  assert.equal(task.prompt.includes("雨夜客栈内景"), true, "场景卡照常注入（只清角色造型，不殃及他类）");
});

test("消费端：旧分镜（无 disguises 栏）任务物件逐位不变（零回归）", () => {
  const hero = heroWithDisguises();
  const tasks = storyboardToBatchTasks(
    {
      shots: [
        {
          shotId: "L-01",
          prompt: "推门而入",
          characterCardIds: ["C01"],
          sceneCardIds: ["P01"],
          negativePrompt: "模糊",
          durationSeconds: 3,
        },
      ],
    },
    [hero, sceneCard()],
  );
  assert.deepEqual(tasks, [
    {
      shotId: "L-01",
      prompt: "主造型：玄色长袍\n雨夜客栈内景\n推门而入",
      referenceImages: [
        { url: "https://main/hero.png", role: "character", name: "男主主图" },
        { url: "https://main/scene.png", role: "general", name: "客栈" },
      ],
      negativePrompt: "模糊, 多手指",
      loraIds: ["lora-hero"],
      size: null,
      durationSeconds: 3,
      needsAsset: false,
      missingCardIds: [],
      missingDisguiseNames: [],
    },
  ]);
});

// ═══════════════════════════════════════════ 5. 旧资料相容（variantOf）

test("旧资料：只有 variantOf、没有变装清单的卡逐位不变，且不新增变装栏位", () => {
  const legacyRaw = {
    id: "C01",
    name: "霍辞渊",
    kind: "character",
    prompt: "黑衣",
    references: [{ url: "https://a/1.png", role: "character", name: "主图" }],
    negativePrompt: "多手指",
    loraIds: ["lora-1"],
    variantOf: "C00",
    lineage: [{ kind: "derivation", assetId: "C00", at: "2026-01-01T00:00:00.000Z" }],
    scope: { owner: "project", projectId: "proj-1" },
    approval: { status: "pending", reason: "待确认" },
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
  };
  const normalized = normalizeCharacterCard(legacyRaw);
  assert.ok(normalized);
  // 逐位不变：与输入（白名单栏位）完全等值，且不新增任何变装栏位。
  assert.deepEqual(normalized, {
    id: "C01",
    name: "霍辞渊",
    kind: "character",
    prompt: "黑衣",
    references: [{ url: "https://a/1.png", role: "character", name: "主图" }],
    negativePrompt: "多手指",
    loraIds: ["lora-1"],
    variantOf: "C00",
    lineage: [{ kind: "derivation", assetId: "C00", at: "2026-01-01T00:00:00.000Z" }],
    scope: { owner: "project", projectId: "proj-1" },
    approval: { status: "pending", reason: "待确认" },
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
  });
  assert.equal(Object.prototype.hasOwnProperty.call(normalized, "disguises"), false, "无变装＝不写栏位（旧卡零改动）");
  assert.equal(Object.prototype.hasOwnProperty.call(normalized, "requiredDisguises"), false);
  // 往返（＝blob store 读回路径）逐位元相同：洁净器幂等、variantOf 不清洗掉。
  assert.deepEqual(normalizeCharacterCard(JSON.parse(JSON.stringify(normalized))), normalized);
});

test("旧资料：variantOf 清洗规则未被本刀改动（保留 / 含 `:` 省略 / 自环省略 / 非字串省略）", () => {
  assert.equal(normalizeCharacterCard({ id: "C01", name: "x", variantOf: "  C00  " })?.variantOf, "C00");
  const colon = normalizeCharacterCard({ id: "C01", name: "x", variantOf: "card:base" });
  assert.equal(colon?.variantOf, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(colon ?? {}, "variantOf"), false);
  const selfRef = normalizeCharacterCard({ id: "C01", name: "x", variantOf: "C01" });
  assert.equal(Object.prototype.hasOwnProperty.call(selfRef ?? {}, "variantOf"), false);
  for (const bad of [null, 1, {}, "", "   "]) {
    const n = normalizeCharacterCard({ id: "C01", name: "x", variantOf: bad });
    assert.ok(n, `variantOf=${String(bad)} 不应让整张卡消失`);
    assert.equal(n?.variantOf, undefined);
  }
});

test("旧资料：只有 variantOf 的既有卡在分镜套用路径逐位不变（不降格、不丢卡）", () => {
  const variant = card({
    id: "C09",
    name: "劼后-霍辞渊",
    prompt: "侠客造型片段",
    references: [ref("https://main/variant.png", "变体图")],
    variantOf: "C01",
  });
  const tasks = storyboardToBatchTasks(
    { shots: [{ shotId: "L-02", prompt: "登场", characterCardIds: ["C09"] }] },
    [variant],
  );
  assert.deepEqual(tasks, [
    {
      shotId: "L-02",
      prompt: "侠客造型片段\n登场",
      referenceImages: [{ url: "https://main/variant.png", role: "character", name: "变体图" }],
      negativePrompt: null,
      loraIds: [],
      size: null,
      durationSeconds: null,
      needsAsset: false,
      missingCardIds: [],
      missingDisguiseNames: [],
    },
  ]);
  // 母卡缺席（variantOf 指不到存在的卡）＝fail-open，照常参与注入、不丢卡。
  const orphan = storyboardToBatchTasks(
    { shots: [{ shotId: "L-03", prompt: "登场", characterCardIds: ["C09"] }] },
    [card({ id: "C09", name: "孤儿变体", prompt: "孤儿片段", variantOf: "C-ghost" })],
  );
  assert.equal(orphan[0].needsAsset, false);
  assert.equal(orphan[0].prompt, "孤儿片段\n登场");
  assert.deepEqual(orphan[0].missingDisguiseNames, []);
});

test("旧资料：无变装宣告的分镜其审计回报 complete（零回归，不新增闸）", () => {
  const hero = heroWithDisguises();
  const report = auditDramaDisguiseRequirements(
    { shots: [{ shotId: "L-01", prompt: "推门", characterCardIds: ["C01"] }] },
    [hero],
  );
  assert.deepEqual(report, { complete: true, missingFromShots: [], missingOnCards: [] });
});

// ═══════════════════════════════════════════ 6. 作用域不变（AssetScope 含 team）

const SCOPE_CASES: [string, AssetScope | undefined][] = [
  ["缺省（personal 省略栏位）", undefined],
  ["显式 personal", { owner: "personal" }],
  ["project", { owner: "project", projectId: "proj-1" }],
  ["project 鬼状态", { owner: "project" }],
  ["team", { owner: "team", teamId: "t-1" }],
  ["team 鬼状态", { owner: "team" }],
  ["跨栏残留", { owner: "team", teamId: "t-1", projectId: "proj-9" } as AssetScope],
];

test("作用域：卡上带不带变装，scope 清洗结果逐位相同（含 team / 鬼状态）", () => {
  for (const [label, scope] of SCOPE_CASES) {
    const plain = normalizeCharacterCard({
      id: "C01",
      name: "霍辞渊",
      kind: "character",
      references: [{ url: "https://a/1.png", role: "character", name: "n" }],
      ...(scope ? { scope } : {}),
    });
    const disguised = normalizeCharacterCard({
      id: "C01",
      name: "霍辞渊",
      kind: "character",
      references: [{ url: "https://a/1.png", role: "character", name: "n" }],
      disguises: [{ name: "侠客造型", references: [{ url: "https://a/dg.png", role: "character", name: "dg" }] }],
      ...(scope ? { scope } : {}),
    });
    assert.deepEqual(disguised?.scope, plain?.scope, `${label}：变装不得改变 scope 落盘形状`);
    assert.equal(
      Object.prototype.hasOwnProperty.call(disguised ?? {}, "scope"),
      Object.prototype.hasOwnProperty.call(plain ?? {}, "scope"),
      `${label}：scope 栏位有无也必须一致`,
    );
    assert.equal(disguised?.disguises?.length, 1, `${label}：变装仍照常清洗存活（不因 scope 降格或丢卡）`);
  }
  // 鬼状态落盘形状＝GHOST_ASSET_SCOPE（不降格 personal）。
  const ghost = normalizeCharacterCard({
    id: "C01",
    name: "霍辞渊",
    scope: { owner: "team" },
    disguises: [{ name: "侠客造型" }],
  });
  assert.deepEqual(ghost?.scope, { owner: "project" });
  assert.equal(ghost?.disguises?.length, 1, "鬼状态不得连带丢掉变装子资产（卡本体仍在）");
});

test("作用域：可见性／可用性裁决（personal / project / team 含无团队上下文）与变装无关", () => {
  const plain = card({ id: "C-T", name: "团队卡", scope: { owner: "team", teamId: "t-1" } });
  const disguised: CharacterCard = {
    ...plain,
    disguises: [{ id: "d1", name: "侠客造型", references: [] }],
    requiredDisguises: ["侠客造型"],
  };
  const asAsset = (c: CharacterCard) => ({ id: c.id, kind: "card" as const, scope: c.scope, ownerUserId: 7 });
  const withTeam: AssetUseContext = { viewerUserId: 7, projectId: "proj-1", teamId: "t-1", shares: [] };
  const withoutTeam: AssetUseContext = { viewerUserId: 7, projectId: "proj-1", shares: [] };
  const otherTeam: AssetUseContext = { viewerUserId: 7, projectId: "proj-1", teamId: "t-2", shares: [] };
  for (const ctx of [withTeam, withoutTeam, otherTeam]) {
    assert.equal(
      resolveAssetScopeVisibility(asAsset(disguised), ctx),
      resolveAssetScopeVisibility(asAsset(plain), ctx),
      "同一 ctx 下可见性不得因卡上带变装而变",
    );
    assert.equal(canUseAsset(asAsset(disguised), ctx), canUseAsset(asAsset(plain), ctx));
  }
  // 既有结论本身：同团队可见、无团队上下文 fail-closed、别队不可见。
  assert.equal(resolveAssetScopeVisibility(asAsset(plain), withTeam), "in-team");
  assert.equal(resolveAssetScopeVisibility(asAsset(plain), withoutTeam), null);
  assert.equal(resolveAssetScopeVisibility(asAsset(plain), otherTeam), null);
  const teamUsable = filterUsableAssets([asAsset(plain), asAsset(disguised)], withTeam);
  assert.equal(teamUsable.length, 2);
  assert.equal(filterUsableAssets([asAsset(plain), asAsset(disguised)], withoutTeam).length, 0);
});

test("作用域：filterLockedCardsForProjectUse 的剔除结果与卡上是否带变装无关（含 team 卡）", () => {
  const cases: CharacterCard[] = [
    card({ id: "C-personal" }),
    card({ id: "C-proj-in", scope: { owner: "project", projectId: "proj-1" } }),
    card({ id: "C-proj-out", scope: { owner: "project", projectId: "proj-2" } }),
    card({ id: "C-ghost", scope: { owner: "project" } }),
    card({ id: "C-team", scope: { owner: "team", teamId: "t-1" } }),
  ];
  const withDisguise = cases.map((c) => ({ ...c, disguises: [{ id: "d1", name: "侠客造型", references: [] }] }));
  for (const projectId of ["proj-1", "proj-2", null]) {
    const plainIds = filterLockedCardsForProjectUse(cases, { projectId, shares: [] }).map((c) => c.id);
    const disguisedIds = filterLockedCardsForProjectUse(withDisguise, { projectId, shares: [] }).map((c) => c.id);
    assert.deepEqual(disguisedIds, plainIds, `projectId=${projectId}：锁定卡剔除结果必须与变装无关`);
  }
  // 既有结论本身（逐字不变）：个人卡恒可见；本项目卡在项目上下文可见、跨项目剔除；鬼状态剔除。
  assert.deepEqual(filterLockedCardsForProjectUse(cases, { projectId: "proj-1", shares: [] }).map((c) => c.id), [
    "C-personal",
    "C-proj-in",
  ]);
  assert.deepEqual(filterLockedCardsForProjectUse(cases, { projectId: null, shares: [] }).map((c) => c.id), [
    "C-personal",
  ]);
  // 显式分享：跨项目仍可见（既有路径不受本刀影响）。
  const shared = filterLockedCardsForProjectUse(cases, {
    projectId: "proj-1",
    shares: [
      {
        id: assetShareId("card", "C-proj-out", "proj-2", "proj-1"),
        assetKind: "card",
        assetId: "C-proj-out",
        fromProjectId: "proj-2",
        toProjectId: "proj-1",
        createdAt: "2026-09-01T00:00:00.000Z",
      },
    ],
  }).map((c) => c.id);
  assert.deepEqual(shared, ["C-personal", "C-proj-in", "C-proj-out"]);
});

// ═══════════════════════════════════════════ 附：套用层（withCharacterDisguises）母卡身分

test("套用：withCharacterDisguises 保留母卡身分栏位，只换 prompt 片段与参考图", () => {
  const hero = heroWithDisguises();
  const disguise: CharacterCardDisguise = hero.disguises![0];
  const applied = withCharacterDisguises(hero, [disguise]);
  assert.equal(applied.id, hero.id);
  assert.equal(applied.name, hero.name);
  assert.equal(applied.kind, hero.kind);
  assert.deepEqual(applied.loraIds, ["lora-hero"]);
  assert.equal(applied.negativePrompt, "多手指");
  assert.deepEqual(applied.disguises, hero.disguises, "变装清单本身仍在卡上");
  assert.equal(applied.prompt, "侠客：斗笠与披风");
  assert.deepEqual(applied.references.map((r) => r.url), ["https://dg/xia.png"]);
  // 原卡不动（纯函式）。
  assert.equal(hero.prompt, "主造型：玄色长袍");
  assert.deepEqual(hero.references.map((r) => r.url), ["https://main/hero.png"]);
});

test("套用：空变装清单＝参考图**与 prompt 片段都清空**（宣告「本镜不是主造型」），不退化成主造型", () => {
  const hero = heroWithDisguises();
  const applied = withCharacterDisguises(hero, []);
  assert.deepEqual(applied.references, []);
  assert.equal(
    applied.prompt,
    "",
    "空清单＝宣告了变装却没命中（缺件）：不得沿用卡本体片段，否则等于用主造型出图",
  );
  assert.notEqual(applied, hero, "仍回 clone，不原地改");
});

test("套用：命中变装但变装自己没写 prompt＝沿用卡本体片段（基础外观描述）；有写就用变装片段", () => {
  const hero = heroWithDisguises();
  // 命中、且变装带 prompt → 用变装片段（不混卡本体）。
  const matched = withCharacterDisguises(hero, [hero.disguises![0]]);
  assert.equal(matched.prompt, "侠客：斗笠与披风");
  // 命中、但变装没写 prompt → 沿用卡本体片段（角色基础外观仍成立，本镜只换造型）。
  const silent = withCharacterDisguises(hero, [{ id: "d-silent", name: "静默造型", references: [ref("https://dg/silent.png", "静默")] }]);
  assert.equal(silent.prompt, "主造型：玄色长袍");
  assert.deepEqual(silent.references.map((r) => r.url), ["https://dg/silent.png"]);
});

test("解析：resolveCharacterDisguises 的命中／具名缺件／cardId 绑定（含宣告序与去重）", () => {
  const hero = heroWithDisguises();
  const other = addCharacterDisguise(card({ id: "C02", name: "沈砚" }), {
    name: "侠客造型",
    references: [ref("https://dg/shen.png", "沈砚侠客")],
  });
  assert.ok(other);
  const cards = [hero, other];
  // 非绑定式同名到多卡＝全命中（按卡序）。
  const both = resolveCharacterDisguises(cards, [{ name: "侠客造型" }]);
  assert.deepEqual(both.matched.map((h) => [h.cardId, h.disguise.references[0].url]), [
    ["C01", "https://dg/xia.png"],
    ["C02", "https://dg/shen.png"],
  ]);
  assert.deepEqual(both.missing, []);
  // 绑定式只在那张卡上找。
  const bound = resolveCharacterDisguises(cards, [{ cardId: "C02", name: "侠客造型" }]);
  assert.deepEqual(bound.matched.map((h) => h.cardId), ["C02"]);
  // 绑到不存在的卡＝具名缺件。
  const ghostCard = resolveCharacterDisguises(cards, [{ cardId: "C-ghost", name: "侠客造型" }]);
  assert.deepEqual(ghostCard.missing, ["侠客造型"]);
  assert.deepEqual(ghostCard.matched, []);
  // 缺件名 trim 去重、按宣告序。
  const dedup = resolveCharacterDisguises(cards, [{ name: "婚服造型" }, { name: " 婚服造型 " }, { name: "战损造型" }, { name: "" }]);
  assert.deepEqual(dedup.missing, ["婚服造型", "战损造型"]);
});

// ═══════════════════════════════════════════ 已知现况（非偏好断言，供 orchestrator 判定）

test("去重键与新增路径一致：同名不同 id 在清洗端就收敛成一条，解析不再取决于清单序", () => {
  // 这一条原本是「现况记录」（清洗器只按 id 去重、同名两条并存、下游按 name 取第一条 ⇒ 结果取决于清单序）。
  // 收口后：清洗器与 addCharacterDisguise 用同一组去重键（id 或 name），且都留最后一张。
  const cleaned = normalizeCharacterDisguises([
    { id: "d1", name: "侠客造型", references: [ref("https://dg/a.png", "a")] },
    { id: "d2", name: "侠客造型", references: [ref("https://dg/b.png", "b")] },
  ]);
  assert.equal(cleaned.length, 1, "同名不同 id：清洗端即收敛成唯一（去重键＝id 或 name）");
  assert.equal(cleaned[0].id, "d2", "留最后一张（与 addCharacterDisguise 的覆盖语义同向）");
  assert.deepEqual(cleaned[0].references.map((r) => r.url), ["https://dg/b.png"], "留下的是最后一张的参考图");

  // 解析结果因此是确定的：同一份输入无论顺序如何，命中的都是唯一那一条。
  const matchedId = resolveCharacterDisguises([card({ id: "C01", disguises: cleaned })], [{ name: "侠客造型" }])
    .matched[0].disguise.id;
  assert.equal(matchedId, "d2");
});