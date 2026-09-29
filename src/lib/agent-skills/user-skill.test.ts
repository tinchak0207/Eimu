// user-skill（使用者自建 Skill ⇄ agent-memory 文件）行為測試。
//
// 真行為斷言（非源碼字串掃描）：
//   1. 往返契約：validateUserSkill → skillToMemoryDoc → memoryDocToSkill 等價原 skill
//      （3 條不同 family，含 CJK 名／ASCII 名／多行段落／有無 expertId/aesthetic）。
//   2. 落庫契約：產出的 doc 真的過得了 store 的結構／去重／配額閘門（真呼叫
//      ingestMemoryDocs，本機無 blob 憑證 → 走 store 的進程內兜底，與
//      agent-memory-store.test.ts 同款 E2E 路徑），且從 listMemoryDocs 讀回來
//      再解析仍是原 skill。
//   3. 去重**複用 store**：不同名、同一句話的第二條被 store 判 duplicate，
//      本檔不自己寫第二套去重。
//   4. 驗證器正負對照 + 畸形輸入不拋（回 null）。

import test from "node:test";
import assert from "node:assert/strict";
import {
  __resetAgentMemoryStoreForTests,
  ingestMemoryDocs,
  listMemoryDocs,
} from "../agent-memory-store";
import {
  SENSITIVE_REASON_PREFIX,
  deleteMySkill,
  memoryDocToSkill,
  registerUserSkillSource,
  saveMySkill,
  scanSensitiveContent,
  serializeSkillBody,
  skillToMemoryDoc,
  userSkillId,
  userSkillLoader,
  userSkillsFromMemoryDocs,
  validateUserSkill,
  type AgentSkillView,
  type SensitiveScanResult,
} from "./user-skill";
import {
  getMySkillById,
  getSkillByIdPublic,
  listMySkills,
  listPublicSkills,
} from "./registry";

const OWNER_KEY = "owner-hash-user-skill";

function baseDraft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "新中式器物广告",
    oneLiner: "东方留白与器物美学，出一支品牌广告",
    family: "ad-tvc",
    useScenario: "国风品牌年度片、节令广告与东方生活品类上新",
    inputType: "品牌定位一句话 + 产品图或器物清单",
    outputContent: "情绪板、产品静物图、分镜关键帧与成片",
    outputKind: "mixed",
    toolIds: ["product_lock", "emotion_board_matrix", "image_generate"],
    tags: ["新中式", "东方美学", "留白构图"],
    ...overrides,
  };
}

/** 三條樣本：CJK 名 + expert + aesthetic／CJK 名無可選欄位／ASCII 名 + 多行。 */
const SAMPLES: Array<Record<string, unknown>> = [
  baseDraft(),
  baseDraft({
    name: "短剧反转开场",
    oneLiner: "三秒钩子加一次反转，留住划走的人",
    family: "short-drama",
    useScenario: "竖屏短剧前 15 秒，需要立刻抓住观众",
    inputType: "一句故事梗概 + 主角设定",
    outputContent: "开场分镜、首帧画面与字幕节奏",
    outputKind: "video",
    toolIds: ["storyboard_qc_17", "image_edit"],
    tags: ["短剧", "反转", "钩子"],
    expertId: undefined,
    aesthetic: undefined,
  }),
  baseDraft({
    name: "City Walk Vlog",
    oneLiner: "城市漫游的松弛感日常短片",
    family: "travel-life",
    useScenario: "周末街区漫游\n随手记录的日常切片",
    inputType: "路线 + 出镜人物照片",
    outputContent: "分段短片 + 环境音与旁白",
    outputKind: "video",
    toolIds: ["image_generate", "tts_speak"],
    tags: ["City Walk", "松弛感", "日常"],
    expertId: "editor",
    aesthetic: "自然光、手持跟拍、浅景深",
  }),
];

function validated(draft: Record<string, unknown>): AgentSkillView {
  const result = validateUserSkill(draft);
  assert.equal(result.ok, true, `草稿應合法：${JSON.stringify(result)}`);
  if (!result.ok) throw new Error("unreachable");
  return result.skill;
}

test("往返契約：skill → doc → skill 等價（3 條不同 family）", () => {
  const families = new Set<string>();
  for (const draft of SAMPLES) {
    const skill = validated(draft);
    families.add(skill.family);

    const doc = skillToMemoryDoc(skill, { ownerKey: OWNER_KEY });
    // 落位契約：slug=id、domain=family、type=workflow、private+ownerKey。
    assert.equal(doc.slug, skill.id);
    assert.equal(doc.domain, skill.family);
    assert.equal(doc.type, "workflow");
    assert.equal(doc.scope, "private");
    assert.equal(doc.ownerKey, OWNER_KEY);
    assert.equal(doc.description, skill.oneLiner);
    assert.ok((doc.links ?? []).includes("user-skill:source=user"));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const back = memoryDocToSkill(doc as any);
    assert.deepEqual(back, skill);
  }
  assert.equal(families.size, 3);
});

test("id 派生決定性：同名同 family 恆等；不同名不碰撞（含純 ASCII 前綴名）", () => {
  const idA = userSkillId("AI 口播带货", "ugc");
  const idB = userSkillId("AI 剪辑", "ugc");
  assert.notEqual(idA, idB, "不同名不得撞同一 id（會靜默覆蓋前一條）");
  assert.match(idA, /^user-ugc-ai-[0-9a-f]{8}$/);
  assert.equal(userSkillId("AI 口播带货", "ugc"), idA, "派生必須是純函式");
  assert.match(userSkillId("短剧反转开场", "short-drama"), /^user-short-drama-[0-9a-f]{8}$/);
  assert.match(
    userSkillId("City Walk Vlog", "travel-life"),
    /^user-travel-life-city-walk-vlog-[0-9a-f]{8}$/,
  );
  assert.ok(userSkillId("City Walk Vlog", "travel-life").length <= 64);
});

test("落庫契約：產出 doc 過 store 閘門，讀回再解析仍是原 skill", async () => {
  __resetAgentMemoryStoreForTests();
  const skill = validated(SAMPLES[0] as Record<string, unknown>);
  const doc = skillToMemoryDoc(skill, { ownerKey: OWNER_KEY });

  const result = await ingestMemoryDocs({ batchId: "user-skill-test-1", docs: [doc] });
  assert.deepEqual(result.rejected, []);
  assert.equal(result.accepted.length, 1);

  const listed = await listMemoryDocs({ scope: "private", ownerKey: OWNER_KEY });
  const stored = listed.find((entry) => entry.slug === skill.id);
  assert.ok(stored, "剛發布的 skill 必須能在私有庫列到");
  assert.equal(stored?.type, "workflow");
  assert.deepEqual(memoryDocToSkill(stored), skill);
});

test("去重複用 store：同名一句話的第二條被 store 判 duplicate，本端不自己判", async () => {
  __resetAgentMemoryStoreForTests();
  const first = validated(baseDraft({ family: "ugc", name: "口播带货第一版" }));
  const second = validated(baseDraft({ family: "ugc", name: "口播带货第二版" }));
  assert.notEqual(first.id, second.id);

  const one = await ingestMemoryDocs({
    batchId: "user-skill-test-2a",
    docs: [skillToMemoryDoc(first, { ownerKey: OWNER_KEY })],
  });
  assert.equal(one.accepted.length, 1);

  const two = await ingestMemoryDocs({
    batchId: "user-skill-test-2b",
    docs: [skillToMemoryDoc(second, { ownerKey: OWNER_KEY })],
  });
  assert.deepEqual(two.rejected, [{ slug: second.id, reason: "duplicate" }]);
  assert.equal(two.accepted.length, 0);
});

test("驗證器正對照：正規化（trim／去重）並派生 id", () => {
  const result = validateUserSkill(
    baseDraft({
      name: "  新中式器物广告  ",
      toolIds: ["image_generate", "image_generate", "product_lock"],
      tags: ["新中式", "新中式", "留白构图"],
      expertId: "video-director",
      aesthetic: "大面积留白、慢推镜头",
    }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.skill.name, "新中式器物广告");
  assert.deepEqual(result.skill.toolIds, ["image_generate", "product_lock"]);
  assert.deepEqual(result.skill.tags, ["新中式", "留白构图"]);
  assert.equal(result.skill.expertId, "video-director");
  assert.equal(result.skill.aesthetic, "大面积留白、慢推镜头");
  assert.equal(result.skill.source, "user");
  assert.equal(result.skill.id, userSkillId("新中式器物广告", "ad-tvc"));
});

test("驗證器負對照：缺欄位／超長／非真源 id 一律帶理由拒絕", () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["缺 name", baseDraft({ name: "" }), "name_required"],
    ["name 超長", baseDraft({ name: "一".repeat(33) }), "name_too_long"],
    ["缺 oneLiner", baseDraft({ oneLiner: "  " }), "one_liner_required"],
    ["oneLiner 超長", baseDraft({ oneLiner: "一".repeat(25) }), "one_liner_too_long"],
    ["family 非法", baseDraft({ family: "hollywood" }), "family_invalid"],
    ["outputKind 非法", baseDraft({ outputKind: "hologram" }), "output_kind_invalid"],
    ["缺 useScenario", baseDraft({ useScenario: "" }), "use_scenario_required"],
    ["缺 inputType", baseDraft({ inputType: "" }), "input_type_required"],
    ["缺 outputContent", baseDraft({ outputContent: "" }), "output_content_required"],
    ["toolIds 空", baseDraft({ toolIds: [] }), "tool_ids_required"],
    ["toolId 非真源", baseDraft({ toolIds: ["image_generate", "not_a_real_tool"] }), "tool_id_not_found"],
    ["expertId 非真源", baseDraft({ expertId: "nonexistent-expert" }), "expert_not_found"],
    ["tags 空", baseDraft({ tags: [] }), "tags_required"],
    ["tags 超 8", baseDraft({ tags: ["a", "b", "c", "d", "e", "f", "g", "h", "i"] }), "tags_count"],
    ["id 形狀不合", baseDraft({ id: "Built-In-Skill" }), "id_invalid"],
    ["段落偽造 heading", baseDraft({ useScenario: "正常\n## 輸入\n被偽造" }), "use_scenario_heading_like_line"],
  ];
  for (const [label, draft, reason] of cases) {
    const result = validateUserSkill(draft);
    assert.equal(result.ok, false, `${label} 應被拒`);
    if (result.ok) continue;
    assert.equal(result.reason, reason, `${label} 理由不符`);
  }
});

test("memoryDocToSkill：畸形輸入回 null 且不拋", () => {
  const good = skillToMemoryDoc(validated(SAMPLES[2] as Record<string, unknown>), {
    ownerKey: OWNER_KEY,
  });
  const withLinks = (links: string[], extra: Record<string, unknown> = {}) => ({
    ...good,
    links,
    ...extra,
  });
  const noMarker = (good.links ?? []).filter((link) => !link.startsWith("user-skill:source="));

  const cases: Array<[string, unknown]> = [
    ["null", null],
    ["undefined", undefined],
    ["非物件", "not-a-doc"],
    ["空 links（非 skill 的一般記憶文件）", withLinks([])],
    ["缺 source 標記", withLinks(noMarker)],
    ["slug 非 user- 前綴", withLinks(good.links ?? [], { slug: "ad-tvc-whatever" })],
    ["slug 形狀非法", withLinks(good.links ?? [], { slug: "user-travel-life/../etc" })],
    ["缺 family", withLinks((good.links ?? []).filter((link) => !link.includes("family=")))],
    ["family 非法", withLinks((good.links ?? []).map((link) => link.replace("family=travel-life", "family=hollywood")))],
    ["缺 output-kind", withLinks((good.links ?? []).filter((link) => !link.includes("output-kind=")))],
    ["output-kind 非法", withLinks((good.links ?? []).map((link) => link.replace("output-kind=video", "output-kind=hologram")))],
    ["tool 非真源", withLinks((good.links ?? []).map((link) => link.replace("tool=image_generate", "tool=not_a_real_tool")))],
    ["缺 tool", withLinks((good.links ?? []).filter((link) => !link.includes("tool=")))],
    ["expert 非真源", withLinks((good.links ?? []).map((link) => link.replace("expert=editor", "expert=nope")))],
    ["缺 tags", withLinks((good.links ?? []).filter((link) => !link.includes("tag=")))],
    ["description 空", { ...good, description: "" }],
    ["body 空", { ...good, body: "" }],
    ["body 非字串", { ...good, body: 42 }],
    ["links 非陣列", { ...good, links: "user-skill:source=user" }],
    ["links 元素非字串", withLinks([123, null, "user-skill:source=user"] as unknown as string[])],
    ["body 缺「交付」段落", { ...good, body: serializeSkillBody(validated(SAMPLES[2] as Record<string, unknown>)).replace("## 交付", "## 產出") }],
  ];
  for (const [label, doc] of cases) {
    let parsed: AgentSkillView | null = null;
    assert.doesNotThrow(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      parsed = memoryDocToSkill(doc as any);
    }, `${label} 不該拋`);
    assert.equal(parsed, null, `${label} 應回 null`);
  }

  // 正對照：同一份 doc 修好後仍解析得出來（證明上面的 null 不是因為全程壞掉）。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.notEqual(memoryDocToSkill(good as any), null);
});

test("來源插槽：逐條解析濾掉非 skill；經 registry 註冊後只進私有族，永不進公開族", async () => {
  __resetAgentMemoryStoreForTests();
  const skill = validated(SAMPLES[1] as Record<string, unknown>);
  const skillDoc = skillToMemoryDoc(skill, { ownerKey: OWNER_KEY });
  const plainDoc = {
    ...skillDoc,
    slug: "plain-note",
    description: "一条与 skill 无关的普通记忆（去重用词也不撞 skill 的一句话）",
    links: [],
    type: "domain" as const,
  };

  const parsed = userSkillsFromMemoryDocs([skillDoc as never, plainDoc as never]);
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0], skill);

  // 真落庫 → 用載入器讀回（走 store 的 listMemoryDocs，不是自己造來源）。
  const one = await ingestMemoryDocs({
    batchId: "user-skill-test-4",
    docs: [skillDoc, plainDoc],
  });
  assert.equal(one.accepted.length, 2);

  const loaded = await userSkillLoader(OWNER_KEY);
  assert.deepEqual(loaded, [skill], "載入器應只回 skill 文件，一般記憶文件不冒充 skill");
  assert.deepEqual(await userSkillLoader(""), [], "空 ownerKey 不得回全體");
  assert.deepEqual(await userSkillLoader(undefined), [], "undefined ownerKey 不得回全體");
  assert.deepEqual(await userSkillLoader(null), [], "null ownerKey 不得回全體");
  assert.deepEqual(await userSkillLoader("other-owner"), [], "別的 ownerKey 讀不到這賬戶的 skill");

  // 註冊進 registry（唯一插槽，ownerKey 參數化）→ 只影響私有族；公開族逐字不變。
  const publicBefore = await listPublicSkills();
  registerUserSkillSource(userSkillLoader);
  assert.deepEqual((await listMySkills(OWNER_KEY)).map((s) => s.id), [skill.id], "私有族應命中自己的那條");
  assert.deepEqual(await listMySkills("other-owner"), [], "別的 ownerKey 在 registry 層也讀不到");
  assert.deepEqual(await listMySkills(""), [], "空 ownerKey 在 registry 層不得回全體");
  assert.deepEqual(await listPublicSkills(), publicBefore, "註冊 user 來源後公開集合不得變化");
  assert.equal(await getSkillByIdPublic(skill.id), undefined, "公開族不得以 id 命中 user 技能");
  assert.equal((await getMySkillById(OWNER_KEY, skill.id))?.source, "user", "私有族正對照：本人取得到");
  assert.equal(await getMySkillById("other-owner", skill.id), undefined, "跨 ownerKey 不得命中");

  registerUserSkillSource(async () => []);
  assert.deepEqual(await listMySkills(OWNER_KEY), []);
  assert.deepEqual(await listPublicSkills(), publicBefore);
  __resetAgentMemoryStoreForTests();
});

// ─────────────────────────── 私有 CRUD 往返（route 業務本體的真行為斷言）

test("私有 CRUD 往返：建 → 列 → 改（同 id revision+1）→ 刪（retracted，列不到）", async () => {
  __resetAgentMemoryStoreForTests();

  // 建
  const created = await saveMySkill(OWNER_KEY, baseDraft({ name: "CRUD 往返", family: "casting" }));
  assert.equal(created.ok, true, `建立應成功：${JSON.stringify(created)}`);
  if (!created.ok) return;
  assert.equal(created.created, true);
  const id = created.skill.id;

  // 列（私有 loader）＋ 公開族不含
  assert.deepEqual((await userSkillLoader(OWNER_KEY)).map((s) => s.id), [id]);
  assert.equal((await listPublicSkills()).some((s) => s.id === id), false, "私有 skill 不得出現在公開集合");

  // 改：帶自己的 id 且內容變更 → 同 id 更新（store 做 revision+1，不新增第二條）
  const updated = await saveMySkill(
    OWNER_KEY,
    baseDraft({ id, name: "CRUD 往返", family: "casting", oneLiner: "改过的一句话，交付更聚焦" }),
  );
  assert.equal(updated.ok, true, `更新應成功：${JSON.stringify(updated)}`);
  if (!updated.ok) return;
  assert.equal(updated.created, false, "帶自己的 id 應判為更新");
  assert.equal(updated.skill.id, id, "更新必須沿用同 id");
  assert.equal(updated.skill.oneLiner, "改过的一句话，交付更聚焦");

  const listed = await listMemoryDocs({ scope: "private", ownerKey: OWNER_KEY });
  assert.equal(listed.filter((doc) => doc.slug === id).length, 1, "更新不得產生第二條同 slug 文件");
  assert.equal(listed.find((doc) => doc.slug === id)?.revision, 2, "更新應使 revision 遞增");
  assert.equal((await userSkillLoader(OWNER_KEY))[0]?.oneLiner, "改过的一句话，交付更聚焦", "讀回應是新內容");

  // 外來／未知 id：不得改到別人，也不以 409/403 洩漏存在性 → 落成自己庫裡的新條目
  const foreign = await saveMySkill(OWNER_KEY, baseDraft({ id: "user-casting-someone-else-1", name: "外來 id 草稿" }));
  assert.equal(foreign.ok, true);
  if (foreign.ok) {
    assert.equal(foreign.created, true, "外來 id 只能建立成自己的新條目");
    assert.notEqual(foreign.skill.id, "user-casting-someone-else-1", "不得沿用外來 id");
  }

  // 刪：只有自己的那條刪得掉；別人的 id 一律 404
  assert.deepEqual(await deleteMySkill(OWNER_KEY, "user-casting-someone-else-1"), {
    ok: false,
    status: 404,
    error: "not_found",
  });
  assert.deepEqual(await deleteMySkill("other-owner", id), { ok: false, status: 404, error: "not_found" });
  const deleted = await deleteMySkill(OWNER_KEY, id);
  assert.deepEqual(deleted, { ok: true, id });

  const after = await listMemoryDocs({ scope: "private", ownerKey: OWNER_KEY });
  assert.equal(after.some((doc) => doc.slug === id), false, "刪除後（retracted）不得再列到");
  assert.equal((await userSkillLoader(OWNER_KEY)).some((s) => s.id === id), false, "刪除後不得再被解析成 skill");
  // 冪等：再刪一次仍是 404，不拋。
  assert.deepEqual(await deleteMySkill(OWNER_KEY, id), { ok: false, status: 404, error: "not_found" });
  __resetAgentMemoryStoreForTests();
});

test("私有 CRUD 負對照：未帶 ownerKey 不寫不刪；普通記憶文件不被刪除端點誤刪", async () => {
  __resetAgentMemoryStoreForTests();

  const noOwner = await saveMySkill("", baseDraft({ family: "ugc" }));
  assert.deepEqual(noOwner, { ok: false, status: 401, error: "unauthorized", reason: "not_signed_in" });
  assert.deepEqual(await deleteMySkill(null, "user-ugc-x"), { ok: false, status: 401, error: "unauthorized" });

  // 同庫裡的普通記憶文件（非 skill）不得被 deleteMySkill 當成 skill 刪掉。
  const plain = {
    scope: "private" as const,
    ownerKey: OWNER_KEY,
    domain: "script",
    slug: "plain-note-not-a-skill",
    description: "一条与 skill 无关的普通记忆（去重用词也不撞 skill 的一句话）",
    type: "domain" as const,
    body: "普通正文",
    links: [],
    evidenceKind: "user_confirmed" as const,
    selfScore: 0.5,
  };
  const ingested = await ingestMemoryDocs({ batchId: "user-skill-test-plain", docs: [plain] });
  assert.equal(ingested.accepted.length, 1);
  assert.deepEqual(await deleteMySkill(OWNER_KEY, "plain-note-not-a-skill"), {
    ok: false,
    status: 404,
    error: "not_found",
  });
  assert.equal(
    (await listMemoryDocs({ scope: "private", ownerKey: OWNER_KEY })).some(
      (doc) => doc.slug === "plain-note-not-a-skill",
    ),
    true,
    "普通記憶文件必須仍在",
  );
  __resetAgentMemoryStoreForTests();
});

// ─────────────────────────── 憑證／秘密閘（2026-09-27）

// 假憑證一律**拼接構造**：明顯非真值，且不讓完整憑證格式字面留在 repo。
const FAKE_SK = ["sk", "testtest"].join("-");
const FAKE_JWT = "eyJ" + "a".repeat(6) + "." + "b".repeat(6) + "." + "c".repeat(6);
const FAKE_PEM = [
  "-----BEGIN",
  "RSA PRIVATE",
  "KEY-----",
  "MIIFakePemBody",
  "-----END",
  "RSA PRIVATE",
  "KEY-----",
].join(" ");
const FAKE_BEARER = "Bearer " + "fake" + "z".repeat(6);
const FAKE_ASSIGNED = "secret=" + "fakedummy";
const FAKE_MOBILE = "1" + "3800138000";

test("憑證閘：各類憑證被拒，reason 只帶種類代碼（不含命中原文）", () => {
  // 第四欄 = 「必須不外洩的原文片段」。**不能**用 sample.slice(0,6)：種類代碼本身
  // 就含關鍵詞（`assigned_secret` 含 "secret"），拿關鍵詞當片段會誤判成洩漏。
  // 真正的洩漏是**payload 值**跑到 reason／回應體裡，故逐案指定 payload。
  const cases: Array<[string, string, string, string]> = [
    ["sk- API key", FAKE_SK, "api_key_sk", "testtest"],
    ["JWT", FAKE_JWT, "jwt", "aaaaaa"],
    ["PEM 私鑰", FAKE_PEM, "pem_private_key", "MIIFakePemBody"],
    ["Bearer token", FAKE_BEARER, "bearer_token", "fakezzzzzz"],
    ["secret= 賦值", FAKE_ASSIGNED, "assigned_secret", "fakedummy"],
    ["中國手機號", FAKE_MOBILE, "cn_mobile", "13800138000"],
  ];
  for (const [label, sample, kind, payload] of cases) {
    // 真行為斷言：直接跑掃描器拿結果（非源碼字串掃描）。
    const scan = scanSensitiveContent(sample);
    assert.equal(scan.clean, false, `${label} 應被掃出`);
    assert.ok(
      scan.hits.some((hit) => hit.kind === kind),
      `${label} 種類不符：${JSON.stringify(scan.hits)}`,
    );
    assert.ok(
      scan.hits.every((hit) => typeof hit.index === "number" && hit.index >= 0),
      `${label} index 應為非負數字`,
    );
    assert.equal(JSON.stringify(scan).includes(payload), false, `${label} 掃描結果不得回傳原文`);
    assert.ok(
      scan.hits.every((hit) => hit.index >= 0 && hit.index < sample.length),
      `${label} 命中索引必須落在樣本內`,
    );

    const result = validateUserSkill(baseDraft({ useScenario: `参考 ${sample} 使用` }));
    assert.equal(result.ok, false, `${label} 應被 validateUserSkill 拒絕`);
    if (result.ok) continue;
    assert.equal(result.reason, `${SENSITIVE_REASON_PREFIX}${kind}`, `${label} 理由不符`);
    assert.equal(result.reason.includes(payload), false, `${label} 理由不得含命中原文片段`);
  }
});

test("憑證閘：正文每個落庫欄位都被掃（name/oneLiner/inputType/outputContent/tags/aesthetic）", () => {
  const fields: Array<[string, Record<string, unknown>]> = [
    ["name", { name: FAKE_SK }],
    ["oneLiner", { oneLiner: FAKE_JWT }],
    ["inputType", { inputType: FAKE_MOBILE }],
    ["outputContent", { outputContent: FAKE_PEM }],
    ["tags", { tags: [FAKE_BEARER] }],
    ["aesthetic", { aesthetic: FAKE_ASSIGNED }],
  ];
  for (const [field, override] of fields) {
    const result = validateUserSkill(baseDraft(override));
    assert.equal(result.ok, false, `${field} 內的憑證應被拒`);
    if (result.ok) continue;
    assert.match(result.reason, /^sensitive_content:[a-z_]+$/, `${field} 理由形狀不符`);
  }
});

test("掃描器邊界：空／純中文／無後綴 sk-／光禿 password 不誤殺；畸形輸入不拋", () => {
  const cleanCases: Array<[string, string]> = [
    ["空字串", ""],
    ["純中文描述", "用东方留白做一支品牌广告，交付静物图与分镜关键帧"],
    ["只有 sk- 前綴無後續字元", "我们约定先写 sk- 再接名称"],
    ["password 一詞但無賦值", "发布前请填写 password 字段（此处不是赋值）"],
    ["token 一詞但無賦值", "这个 token 字段留空即可"],
    ["英文散文含 Key 字樣", "The key idea is to keep the frame still"],
  ];
  for (const [label, text] of cleanCases) {
    const scan = scanSensitiveContent(text);
    assert.equal(scan.clean, true, `${label} 不該被掃出：${JSON.stringify(scan.hits)}`);
    assert.deepEqual(scan.hits, []);
  }

  for (const bad of [null, undefined, 42, {}, []]) {
    let scan: SensitiveScanResult | null = null;
    assert.doesNotThrow(() => {
      scan = scanSensitiveContent(bad as unknown as string);
    });
    assert.equal(scan?.clean, true, `畸形輸入 ${JSON.stringify(bad)} 應回乾淨且不拋`);
  }

  // 正對照：同一批假憑證確實會被抓到（證明上面的 clean 不是「掃描器全程壞掉」）。
  assert.equal(scanSensitiveContent(FAKE_SK).clean, false);
  assert.equal(scanSensitiveContent(FAKE_PEM).clean, false);
});

test("憑證閘正負對照：乾淨草稿真落庫；帶憑證草稿被拒且不落庫", async () => {
  __resetAgentMemoryStoreForTests();
  const clean = baseDraft({ name: "凭证闸正对照", family: "storyboard" });
  const cleanResult = validateUserSkill(clean);
  assert.equal(cleanResult.ok, true);
  if (!cleanResult.ok) return;

  // 落庫正文逐欄真掃（跑掃描器拿結果，非源碼字串斷言）。
  const bodyScan = scanSensitiveContent(serializeSkillBody(cleanResult.skill));
  assert.equal(bodyScan.clean, true, `乾淨 skill 正文不該命中：${JSON.stringify(bodyScan.hits)}`);

  const accepted = await ingestMemoryDocs({
    batchId: "user-skill-sensitive-ok",
    docs: [skillToMemoryDoc(cleanResult.skill, { ownerKey: OWNER_KEY })],
  });
  assert.deepEqual(accepted.rejected, []);
  assert.equal(accepted.accepted.length, 1);

  // 負對照：夾帶憑證的草稿被拒，其 id 不得出現在私有庫。
  const dirtyId = userSkillId("凭证闸负对照", "storyboard");
  const dirty = validateUserSkill(
    baseDraft({ name: "凭证闸负对照", family: "storyboard", useScenario: `参考 ${FAKE_SK} 使用` }),
  );
  assert.equal(dirty.ok, false);
  if (!dirty.ok) assert.equal(dirty.reason, `${SENSITIVE_REASON_PREFIX}api_key_sk`);
  const listed = await listMemoryDocs({ scope: "private", ownerKey: OWNER_KEY });
  assert.equal(listed.some((doc) => doc.slug === dirtyId), false, "被拒草稿不得寫入記憶庫");
  __resetAgentMemoryStoreForTests();
});
