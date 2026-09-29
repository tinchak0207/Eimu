// 變裝子資產（對稱差 D8「變裝作為角色的一等子資產」）＋強制補齊的真實行為斷言。
//
// 全部走真函式（不 mock、不假卡庫、不碰網路）：
//   1. 變裝清單為一等子資產（多個具名變裝掛同一張角色卡，各帶自己的識別與參考圖）
//   2. 可新增變裝（addCharacterDisguise：命名＋參考圖；重複＝覆蓋；非法＝null）
//   3. 強制補齊（requiredDisguises 對帳：具名回報缺哪些；缺件不得用主造型頂替）
//   4. 消費端 drama-recipe storyboardToBatchTasks：roles → referenceImages 真的取到變裝參考
//   5. 舊資料相容：只有 variantOf、沒有變裝清單的卡逐位不變（零回歸）
//   6. 作用域不變：AssetScope（含 team）清洗結果與卡上是否帶變裝無關
//
// 位置索引（本檔斷言的實作落點，2026-09-28）：
//   - character-cards.ts:133 variantOf 定義／:307-308 寫入端清洗／:331 寫出欄位／
//     :745 applyCharacterCards 消費註記／:746-748 卡池過濾
//   - character-cards.ts:95-104 CharacterCardDisguise 型別／:140 disguises 欄／
//     :147 requiredDisguises 欄／:311-313 清洗落點／:332-333 寫出欄位
//   - character-cards.ts:417 disguiseIdFromName／:427-441 單筆清洗／:444-456 清單清洗／
//     :489-513 新增（addCharacterDisguise）／:519-525 要求寫入／:540-550 單卡對帳／
//     :573-586 全庫對帳／:593-622 解析選擇／:638-663 套用變裝
//   - drama-recipe.ts:71-93 分鏡變裝宣告清洗／:188 shot.disguises 欄／:325 清洗接入／
//     :515 變裝解析／:518-535 換裝落點／:558 needsAsset 閘／:597-609 強制補齊閘
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

// ─────────────────────────────────────────── 測試夾具

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

/** 男主要角：主造型 + 兩個具名變裝（每個都有自己的參考圖）。 */
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

// ═══════════════════════════════════════════ 1. 變裝清單為一等子資產

test("一等子資產：一個角色可掛多個具名變裝，各帶自己的 id/名字/參考圖，且不攤平成第二張卡", () => {
  const hero = heroWithDisguises();
  assert.equal(hero.disguises?.length, 2, "同一張卡應同時掛兩個變裝");
  const names = hero.disguises?.map((d) => d.name);
  assert.deepEqual(names, ["侠客造型", "婚服造型"], "變裝名應逐一保留（具名狀態的載體）");
  // 每個變裝有自己在本卡內唯一的穩定識別。
  const ids = new Set(hero.disguises?.map((d) => d.id));
  assert.equal(ids.size, 2);
  assert.equal(hero.disguises?.[0].id, "侠客造型"); // 由名字導出（disguiseIdFromName）
  // 每個變裝有自己的參考圖（不是共用主造型的）。
  assert.equal(hero.disguises?.[0].references[0].url, "https://dg/xia.png");
  assert.equal(hero.disguises?.[1].references[0].url, "https://dg/wed.png");
  const allDisguiseUrls = (hero.disguises ?? []).flatMap((d) => d.references.map((r) => r.url));
  assert.equal(allDisguiseUrls.includes("https://main/hero.png"), false, "變裝參考不得混入主造型參考");
  // 母卡身分不變：仍是同一張 character 卡，不是新的一張角色卡。
  assert.equal(hero.id, "C01");
  assert.equal(hero.name, "霍辞渊");
  assert.equal(hero.kind, "character");
  assert.equal(hero.references.map((r) => r.url).join(","), "https://main/hero.png");
});

test("一等子資產：變裝清單走存檔收口（JSON 往返再清洗）後逐位存活", () => {
  const hero = heroWithDisguises();
  const revived = normalizeCharacterCard(JSON.parse(JSON.stringify(hero)));
  assert.ok(revived);
  assert.deepEqual(revived.disguises, hero.disguises, "往返後變裝清單（含參考圖）應逐位相同");
});

test("一等子資產：變裝參考圖與卡參考圖共用同一把尺（>8 截尾、非法 URL 丟、data:audio 丟）", () => {
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
  assert.equal(many[0].references.length, 8, "單一變裝參考上限與 MAX_CARD_REFERENCES 同界（8）");
  assert.deepEqual(
    many[0].references.map((r) => r.url),
    Array.from({ length: 8 }, (_, i) => `https://a/${i}.png`),
  );
  // 非法項（含 data:audio，角色變裝不是音頻卡）一律丟，不讓半形資產進清單。
  assert.equal(many[0].references.some((r) => r.url.includes("audio")), false);
});

test("一等子資產：變裝清單清洗的邊界（無名丟、非物件丟、同 id 只留第一張、自指丟）", () => {
  assert.deepEqual(normalizeCharacterDisguises([null, 1, "x", { id: "d" }, { name: "   " }]), []);
  assert.deepEqual(
    normalizeCharacterDisguises([{ id: "d1", name: "甲" }, { id: "d1", name: "乙" }, { name: "丙" }]).map((d) => [
      d.id,
      d.name,
    ]),
    [
      ["d1", "甲"],
      ["丙", "丙"],
    ],
  );
  // 自指（變裝 id ＝ 卡本體 id）＝鬼引用，卡片清洗時丟掉（與 variantOf 自環同款處置）。
  const nc = normalizeCharacterCard({
    id: "C01",
    name: "霍辞渊",
    disguises: [{ id: "C01", name: "自指" }, { name: "侠客造型" }],
  });
  assert.deepEqual(nc?.disguises?.map((d) => d.name), ["侠客造型"]);
});

test("一等子資產：清單上限 MAX_DISGUISES_PER_CARD 生效（截尾不炸）", () => {
  const raw = Array.from({ length: MAX_DISGUISES_PER_CARD + 5 }, (_, i) => ({ name: `变装${i}` }));
  assert.equal(normalizeCharacterDisguises(raw).length, MAX_DISGUISES_PER_CARD);
});

// ═══════════════════════════════════════════ 2. 可新增變裝

test("新增：為既有角色新增變裝（命名＋參考圖）後清單與讀回結果正確，且不改傳入卡", () => {
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
  assert.notEqual(added.updatedAt, base.updatedAt, "卡內容變了 → updatedAt 應更新");
  // 純函式：原卡不動（舊況的 zero-drift）。
  assert.equal(base.disguises, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(base, "disguises"), false);
  // 讀回（存檔收口 + JSON 往返）仍取得到。
  const revived = normalizeCharacterCard(JSON.parse(JSON.stringify(added)));
  assert.deepEqual(revived?.disguises, added.disguises);
  // 第二個變裝獨立併入，不動第一個。
  const second = addCharacterDisguise(added, { name: "婚服造型", references: [ref("https://dg/wed.png", "婚服定妆")] });
  assert.deepEqual(second?.disguises?.map((d) => d.name), ["侠客造型", "婚服造型"]);
  assert.deepEqual(second?.disguises?.[0].references[0].url, "https://dg/xia.png");
});

test("新增：重複命名＝覆蓋（張數不成長，參考圖換新）；同 id 亦覆蓋", () => {
  const once = addCharacterDisguise(card({ id: "C01", name: "霍辞渊" }), {
    name: "侠客造型",
    references: [ref("https://dg/v1.png", "旧图")],
  });
  assert.ok(once);
  assert.equal(once.disguises?.length, 1);
  const twice = addCharacterDisguise(once, { name: "侠客造型", references: [ref("https://dg/v2.png", "新图")] });
  assert.equal(twice?.disguises?.length, 1, "同名重複新增不得長出第二張");
  assert.deepEqual(twice?.disguises?.[0].references.map((r) => r.url), ["https://dg/v2.png"]);
  // 同 id（明示 id）亦覆蓋，即使名字不同。
  const byId = addCharacterDisguise(once, { id: "侠客造型", name: "换了名字的造型", references: [] });
  assert.equal(byId?.disguises?.length, 1);
  assert.equal(byId?.disguises?.[0].name, "换了名字的造型");
});

test("新增：非法命名／非法情境一律拒收（回 null，不製造半形資產）", () => {
  const hero = card({ id: "C01", name: "霍辞渊" });
  // 名含保留分隔符 `:` → id 導不出 → 拒收。
  assert.equal(addCharacterDisguise(hero, { name: "造型:甲" }), null);
  assert.equal(disguiseIdFromName("造型:甲"), null);
  // 無名／空白名 / 超長名 → 拒收。
  assert.equal(addCharacterDisguise(hero, { name: "   " }), null);
  assert.equal(addCharacterDisguise(hero, { name: "名".repeat(61) }), null);
  // 非角色卡（變裝是角色的子資產）→ 拒收。
  assert.equal(addCharacterDisguise(card({ id: "P01", kind: "scene" }), { name: "侠客造型" }), null);
  assert.equal(addCharacterDisguise(card({ id: "P02", kind: "prop" }), { name: "侠客造型" }), null);
  // 自指（id ＝ 卡本體 id）→ 拒收。
  assert.equal(addCharacterDisguise(hero, { id: "C01", name: "自指" }), null);
  // 空白的花式 id 由名字重新導出（不製造鬼 id）。
  const derived = addCharacterDisguise(hero, { id: "  ", name: " 侠客 造型 " });
  assert.equal(derived?.disguises?.[0].id, "侠客-造型");
});

test("新增：滿 MAX_DISGUISES_PER_CARD 後新增被拒，但覆蓋既有仍允許", () => {
  let full = card({ id: "C01", name: "霍辞渊" });
  for (let i = 0; i < MAX_DISGUISES_PER_CARD; i += 1) {
    const next = addCharacterDisguise(full, { name: `变装${i}` });
    assert.ok(next, `第 ${i + 1} 個變裝不應被拒`);
    full = next;
  }
  assert.equal(full.disguises?.length, MAX_DISGUISES_PER_CARD);
  assert.equal(addCharacterDisguise(full, { name: "溢出造型" }), null, "超上限的新增應拒收");
  const overwritten = addCharacterDisguise(full, { name: "变装0", references: [ref("https://dg/new.png", "新图")] });
  assert.equal(overwritten?.disguises?.length, MAX_DISGUISES_PER_CARD, "覆蓋不得長出第 13 張");
  assert.deepEqual(overwritten?.disguises?.find((d) => d.name === "变装0")?.references.map((r) => r.url), [
    "https://dg/new.png",
  ]);
});

test("新增 ／ 解析：名字導出 id 的穩定規則（空白折 `-`、trim）", () => {
  assert.equal(disguiseIdFromName(" 侠客 造型 "), "侠客-造型");
  assert.equal(disguiseIdFromName("侠客造型"), "侠客造型");
  assert.equal(disguiseIdFromName(""), null);
  assert.equal(disguiseIdFromName(null), null);
});

// ═══════════════════════════════════════════ 3. 強制補齊

test("強制補齊（正例）：要求全部具備 → complete=true，present 全列、missing 空", () => {
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

test("強制補齊（反例）：缺件時具名回報缺哪些，且不以主造型冒充已補齊", () => {
  const hero = heroWithDisguises();
  const required = setRequiredDisguises(hero, ["侠客造型", "婚服造型", "战损造型"]);
  const audit = auditCharacterDisguises(required);
  assert.equal(audit.complete, false);
  assert.deepEqual(audit.missing, ["战损造型"], "缺件必須具名回報（不是布林、不是靜默）");
  assert.deepEqual(audit.present, ["侠客造型", "婚服造型"]);
  // 完全沒補齊的角色：缺件＝全部要求（順序＝宣告序，回報穩定）。
  const empty = setRequiredDisguises(card({ id: "C02", name: "沈砚" }), ["战损造型", "便服造型"]);
  assert.deepEqual(auditCharacterDisguises(empty).missing, ["战损造型", "便服造型"]);
  // 主造型（references / prompt）不影響對帳：它不是變裝，不計入 provided。
  assert.deepEqual(auditCharacterDisguises(empty).provided, []);
});

test("強制補齊：全庫對帳逐卡具名（cardId + cardName + missingDisguises），無要求的舊卡零追溯", () => {
  const satisfied = setRequiredDisguises(heroWithDisguises(), ["侠客造型"]);
  const gapped = setRequiredDisguises(card({ id: "C02", name: "沈砚" }), ["战损造型"]);
  const legacy = card({ id: "C03", name: "旧角色" }); // 無 requiredDisguises
  const report = auditDisguiseRequirements([legacy, satisfied, gapped]);
  assert.equal(report.complete, false);
  assert.deepEqual(report.gaps, [{ cardId: "C02", cardName: "沈砚", missingDisguises: ["战损造型"] }]);
  assert.deepEqual(report.satisfiedCardIds, ["C01"]);
  // 沒有要求的卡不進 gaps、不進 satisfied（零追溯）。
  assert.equal(report.gaps.some((g) => g.cardId === "C03"), false);
  assert.equal(report.satisfiedCardIds.includes("C03"), false);
  assert.equal(auditDisguiseRequirements([legacy]).complete, true);
});

test("強制補齊：要求清單清洗（去重 / trim / 上限）與清除（空清單＝回缺省，不寫空陣列）", () => {
  assert.deepEqual(normalizeRequiredDisguises(["a", "a", "  a  ", "", 1, null]), ["a"]);
  const many = Array.from({ length: MAX_REQUIRED_DISGUISES + 3 }, (_, i) => `r${i}`);
  assert.equal(normalizeRequiredDisguises(many).length, MAX_REQUIRED_DISGUISES);
  const hero = heroWithDisguises();
  const set = setRequiredDisguises(hero, ["侠客造型"]);
  assert.deepEqual(set.requiredDisguises, ["侠客造型"]);
  const cleared = setRequiredDisguises(set, []);
  assert.equal(Object.prototype.hasOwnProperty.call(cleared, "requiredDisguises"), false, "空清單＝清掉要求，不寫空陣列");
  // 存檔收口：無要求＝不寫該欄位（舊卡零改動）。
  const normalized = normalizeCharacterCard({ id: "C01", name: "霍辞渊" });
  assert.equal(Object.prototype.hasOwnProperty.call(normalized ?? {}, "requiredDisguises"), false);
});

test("強制補齊：不得靜默用主造型頂替——綁定式宣告缺件時該卡參考清空且任務不可提交", () => {
  const hero = heroWithDisguises();
  // 卡側要求：戰損造型尚未補齊 → 設定階段閘必須回報。
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
  // 同一個宣告走任務切分：needsAsset 閘鎖住，且主造型參考不得代打。
  const tasks = storyboardToBatchTasks(storyboard, [required]);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].needsAsset, true, "缺件必須鎖住任務");
  assert.deepEqual(tasks[0].missingDisguiseNames, ["战损造型"]);
  const urls = tasks[0].referenceImages.map((r) => r.url);
  assert.deepEqual(urls, [], "綁定式缺件＝該角色本鏡沒有參考，主造型（https://main/hero.png）不得頂替");
  assert.equal(urls.includes("https://main/hero.png"), false);
});

// ═══════════════════════════════════════════ 4. 消費端（drama-recipe）

test("消費端：分鏡宣告命中變裝 → referenceImages 真的取到變裝參考（不是主造型、也不只斷言被呼叫）", () => {
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
  assert.deepEqual(urls, ["https://dg/xia.png", "https://main/scene.png"], "角色參考＝變裝參考（角色卡優先），場景卡照常");
  const heroRef = task.referenceImages[0];
  assert.equal(heroRef.url, "https://dg/xia.png");
  assert.equal(heroRef.role, "character");
  assert.equal(heroRef.name, "侠客定妆", "取到的是變裝自己的參考（名稱也來自該變裝）");
  assert.equal(urls.includes("https://main/hero.png"), false, "主造型參考不得混入");
  // prompt 片段換成變裝片段（不是主造型片段）。
  assert.ok(task.prompt.includes("侠客：斗笠与披风"), "應注入變裝的鎖定片段");
  assert.equal(task.prompt.includes("主造型：玄色长袍"), false, "主造型片段不得混入");
  // 卡的身分欄位不變（卡 id 序注入與分鏡引用欄零遷移）。
  assert.deepEqual(task.loraIds, ["lora-hero"]);
  assert.equal(task.negativePrompt, "多手指");
  // 換裝後才是注入集：母卡 id 仍是 C01（引用欄不變）。
  assert.equal(hero.id, "C01");
});

test("消費端：同鏡宣告多個變裝 → 參考圖聯集去重；未宣告的鏡次＝主造型（零漂移）", () => {
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
  // 未宣告變裝的鏡次：主造型照舊（逐位相同，不因新機制降格）。
  assert.deepEqual(tasks[1].referenceImages.map((r) => r.url), ["https://main/hero.png"]);
  assert.ok(tasks[1].prompt.includes("主造型：玄色长袍"));
  assert.equal(tasks[1].needsAsset, false);
});

test("消費端：字串（非綁定式）宣告命中＝換裝；未命中＝具名缺件（needsAsset）", () => {
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
  assert.deepEqual(tasks[0].referenceImages.map((r) => r.url), ["https://dg/xia.png"], "非綁定式命中即換裝");
  assert.equal(tasks[0].needsAsset, false);
  assert.equal(tasks[1].needsAsset, true);
  assert.deepEqual(tasks[1].missingDisguiseNames, ["不存在的造型"], "缺件必須具名回報");
});

test("消費端：變裝宣告清洗（字串／物件別名、缺 name 丟、同 (cardId,name) 去重）", () => {
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
  // 缺 name 的條目不得進缺件（不是「要求」就沒有缺件）。
  assert.deepEqual(task.missingDisguiseNames, ["无 cardId 的绑定量"]);
  assert.equal(task.needsAsset, true);
});

test("消費端：綁定式缺件時 prompt 片段與參考圖的處置（記錄現況，非斷言設計偏好）", () => {
  const hero = heroWithDisguises();
  const tasks = storyboardToBatchTasks(
    {
      shots: [{ shotId: "S-01", prompt: "换装场景", characterCardIds: ["C01"], disguises: [{ cardId: "C01", name: "缺的造型" }] }],
    },
    [hero],
  );
  // 現況（withCharacterDisguises 文件明載）：參考圖一律清空（不頂替），
  // prompt 在變裝無片段時沿用卡本體片段（母卡的基礎外觀描述）。
  assert.deepEqual(tasks[0].referenceImages, []);
  assert.equal(tasks[0].prompt.startsWith("主造型：玄色长袍"), true);
  assert.equal(tasks[0].needsAsset, true, "閘在 needsAsset：缺件任務不可提交");
});

test("消費端：舊分鏡（無 disguises 欄）任務物件逐位不變（零回歸）", () => {
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

// ═══════════════════════════════════════════ 5. 舊資料相容（variantOf）

test("舊資料：只有 variantOf、沒有變裝清單的卡逐位不變，且不新增變裝欄位", () => {
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
  // 逐位不變：與輸入（白名單欄位）完全等值，且不新增任何變裝欄位。
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
  assert.equal(Object.prototype.hasOwnProperty.call(normalized, "disguises"), false, "無變裝＝不寫欄位（舊卡零改動）");
  assert.equal(Object.prototype.hasOwnProperty.call(normalized, "requiredDisguises"), false);
  // 往返（＝blob store 讀回路徑）逐位元相同：潔淨器冪等、variantOf 不清洗掉。
  assert.deepEqual(normalizeCharacterCard(JSON.parse(JSON.stringify(normalized))), normalized);
});

test("舊資料：variantOf 清洗規則未被本刀改動（保留 / 含 `:` 省略 / 自環省略 / 非字串省略）", () => {
  assert.equal(normalizeCharacterCard({ id: "C01", name: "x", variantOf: "  C00  " })?.variantOf, "C00");
  const colon = normalizeCharacterCard({ id: "C01", name: "x", variantOf: "card:base" });
  assert.equal(colon?.variantOf, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(colon ?? {}, "variantOf"), false);
  const selfRef = normalizeCharacterCard({ id: "C01", name: "x", variantOf: "C01" });
  assert.equal(Object.prototype.hasOwnProperty.call(selfRef ?? {}, "variantOf"), false);
  for (const bad of [null, 1, {}, "", "   "]) {
    const n = normalizeCharacterCard({ id: "C01", name: "x", variantOf: bad });
    assert.ok(n, `variantOf=${String(bad)} 不應讓整張卡消失`);
    assert.equal(n?.variantOf, undefined);
  }
});

test("舊資料：只有 variantOf 的既有卡在分鏡套用路徑逐位不變（不降格、不丟卡）", () => {
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
  // 母卡缺席（variantOf 指不到存在的卡）＝fail-open，照常參與注入、不丟卡。
  const orphan = storyboardToBatchTasks(
    { shots: [{ shotId: "L-03", prompt: "登场", characterCardIds: ["C09"] }] },
    [card({ id: "C09", name: "孤儿变体", prompt: "孤儿片段", variantOf: "C-ghost" })],
  );
  assert.equal(orphan[0].needsAsset, false);
  assert.equal(orphan[0].prompt, "孤儿片段\n登场");
  assert.deepEqual(orphan[0].missingDisguiseNames, []);
});

test("舊資料：無變裝宣告的分鏡其審計回報 complete（零回歸，不新增閘）", () => {
  const hero = heroWithDisguises();
  const report = auditDramaDisguiseRequirements(
    { shots: [{ shotId: "L-01", prompt: "推门", characterCardIds: ["C01"] }] },
    [hero],
  );
  assert.deepEqual(report, { complete: true, missingFromShots: [], missingOnCards: [] });
});

// ═══════════════════════════════════════════ 6. 作用域不變（AssetScope 含 team）

const SCOPE_CASES: [string, AssetScope | undefined][] = [
  ["缺省（personal 省略欄位）", undefined],
  ["顯式 personal", { owner: "personal" }],
  ["project", { owner: "project", projectId: "proj-1" }],
  ["project 鬼狀態", { owner: "project" }],
  ["team", { owner: "team", teamId: "t-1" }],
  ["team 鬼狀態", { owner: "team" }],
  ["跨欄殘留", { owner: "team", teamId: "t-1", projectId: "proj-9" } as AssetScope],
];

test("作用域：卡上帶不帶變裝，scope 清洗結果逐位相同（含 team / 鬼狀態）", () => {
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
    assert.deepEqual(disguised?.scope, plain?.scope, `${label}：變裝不得改變 scope 落盤形狀`);
    assert.equal(
      Object.prototype.hasOwnProperty.call(disguised ?? {}, "scope"),
      Object.prototype.hasOwnProperty.call(plain ?? {}, "scope"),
      `${label}：scope 欄位有無也必須一致`,
    );
    assert.equal(disguised?.disguises?.length, 1, `${label}：變裝仍照常清洗存活（不因 scope 降格或丟卡）`);
  }
  // 鬼狀態落盤形狀＝GHOST_ASSET_SCOPE（不降格 personal）。
  const ghost = normalizeCharacterCard({
    id: "C01",
    name: "霍辞渊",
    scope: { owner: "team" },
    disguises: [{ name: "侠客造型" }],
  });
  assert.deepEqual(ghost?.scope, { owner: "project" });
  assert.equal(ghost?.disguises?.length, 1, "鬼狀態不得連帶丟掉變裝子資產（卡本體仍在）");
});

test("作用域：可見性／可用性裁決（personal / project / team 含無團隊上下文）與變裝無關", () => {
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
      "同一 ctx 下可見性不得因卡上帶變裝而變",
    );
    assert.equal(canUseAsset(asAsset(disguised), ctx), canUseAsset(asAsset(plain), ctx));
  }
  // 既有結論本身：同團隊可見、無團隊上下文 fail-closed、別隊不可見。
  assert.equal(resolveAssetScopeVisibility(asAsset(plain), withTeam), "in-team");
  assert.equal(resolveAssetScopeVisibility(asAsset(plain), withoutTeam), null);
  assert.equal(resolveAssetScopeVisibility(asAsset(plain), otherTeam), null);
  const teamUsable = filterUsableAssets([asAsset(plain), asAsset(disguised)], withTeam);
  assert.equal(teamUsable.length, 2);
  assert.equal(filterUsableAssets([asAsset(plain), asAsset(disguised)], withoutTeam).length, 0);
});

test("作用域：filterLockedCardsForProjectUse 的剔除結果與卡上是否帶變裝無關（含 team 卡）", () => {
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
    assert.deepEqual(disguisedIds, plainIds, `projectId=${projectId}：鎖定卡剔除結果必須與變裝無關`);
  }
  // 既有結論本身（逐字不變）：個人卡恆可見；本項目卡在項目上下文可見、跨項目剔除；鬼狀態剔除。
  assert.deepEqual(filterLockedCardsForProjectUse(cases, { projectId: "proj-1", shares: [] }).map((c) => c.id), [
    "C-personal",
    "C-proj-in",
  ]);
  assert.deepEqual(filterLockedCardsForProjectUse(cases, { projectId: null, shares: [] }).map((c) => c.id), [
    "C-personal",
  ]);
  // 顯式分享：跨項目仍可見（既有路徑不受本刀影響）。
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

// ═══════════════════════════════════════════ 附：套用層（withCharacterDisguises）母卡身分

test("套用：withCharacterDisguises 保留母卡身分欄位，只換 prompt 片段與參考圖", () => {
  const hero = heroWithDisguises();
  const disguise: CharacterCardDisguise = hero.disguises![0];
  const applied = withCharacterDisguises(hero, [disguise]);
  assert.equal(applied.id, hero.id);
  assert.equal(applied.name, hero.name);
  assert.equal(applied.kind, hero.kind);
  assert.deepEqual(applied.loraIds, ["lora-hero"]);
  assert.equal(applied.negativePrompt, "多手指");
  assert.deepEqual(applied.disguises, hero.disguises, "變裝清單本身仍在卡上");
  assert.equal(applied.prompt, "侠客：斗笠与披风");
  assert.deepEqual(applied.references.map((r) => r.url), ["https://dg/xia.png"]);
  // 原卡不動（純函式）。
  assert.equal(hero.prompt, "主造型：玄色长袍");
  assert.deepEqual(hero.references.map((r) => r.url), ["https://main/hero.png"]);
});

test("套用：空變裝清單＝參考圖清空（宣告「本鏡不是主造型」），不退化成主造型", () => {
  const hero = heroWithDisguises();
  const applied = withCharacterDisguises(hero, []);
  assert.deepEqual(applied.references, []);
  assert.equal(applied.prompt, "主造型：玄色长袍", "變裝無片段＝沿用卡本體片段（角色的基礎外觀描述）");
  assert.notEqual(applied, hero, "仍回 clone，不原地改");
});

test("解析：resolveCharacterDisguises 的命中／具名缺件／cardId 綁定（含宣告序與去重）", () => {
  const hero = heroWithDisguises();
  const other = addCharacterDisguise(card({ id: "C02", name: "沈砚" }), {
    name: "侠客造型",
    references: [ref("https://dg/shen.png", "沈砚侠客")],
  });
  assert.ok(other);
  const cards = [hero, other];
  // 非綁定式同名到多卡＝全命中（按卡序）。
  const both = resolveCharacterDisguises(cards, [{ name: "侠客造型" }]);
  assert.deepEqual(both.matched.map((h) => [h.cardId, h.disguise.references[0].url]), [
    ["C01", "https://dg/xia.png"],
    ["C02", "https://dg/shen.png"],
  ]);
  assert.deepEqual(both.missing, []);
  // 綁定式只在那張卡上找。
  const bound = resolveCharacterDisguises(cards, [{ cardId: "C02", name: "侠客造型" }]);
  assert.deepEqual(bound.matched.map((h) => h.cardId), ["C02"]);
  // 綁到不存在的卡＝具名缺件。
  const ghostCard = resolveCharacterDisguises(cards, [{ cardId: "C-ghost", name: "侠客造型" }]);
  assert.deepEqual(ghostCard.missing, ["侠客造型"]);
  assert.deepEqual(ghostCard.matched, []);
  // 缺件名 trim 去重、按宣告序。
  const dedup = resolveCharacterDisguises(cards, [{ name: "婚服造型" }, { name: " 婚服造型 " }, { name: "战损造型" }, { name: "" }]);
  assert.deepEqual(dedup.missing, ["婚服造型", "战损造型"]);
});

// ═══════════════════════════════════════════ 已知現況（非偏好斷言，供 orchestrator 判定）

test("現況記錄：清單清洗只按 id 去重（同名不同 id 兩條都存活），新增路徑才是按名字覆蓋", () => {
  const cleaned = normalizeCharacterDisguises([
    { id: "d1", name: "侠客造型", references: [ref("https://dg/a.png", "a")] },
    { id: "d2", name: "侠客造型", references: [ref("https://dg/b.png", "b")] },
  ]);
  assert.equal(cleaned.length, 2, "同名不同 id：清洗器兩條都留（去重鍵是 id）");
  // 下游按名字解析 → 取第一條；新增路徑（addCharacterDisguise）則不會產生這種資料。
  assert.deepEqual(resolveCharacterDisguises([card({ id: "C01", disguises: cleaned })], [{ name: "侠客造型" }]).matched[0].disguise.id, "d1");
});