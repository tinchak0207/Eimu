import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  BLENDER_ASSET_PACK_ID,
  findTemplateByFingerprint,
  fingerprintScript,
  normalizeScript,
  saveSceneAssets,
} from "./blender-asset-store.ts";
import { __resetAssetPackStoreForTests, listAssetPacks, normalizeAssetPack } from "./asset-pack-store.ts";
import type { AssetPack } from "./asset-pack-store.ts";

beforeEach(() => {
  __resetAssetPackStoreForTests();
});

const USER_ID = 1;

const SCRIPT_A = `# 建一個方塊並轉 90 度
import bpy
bpy.ops.mesh.primitive_cube_add()   # 方塊
obj = bpy.context.active_object
obj.rotation_euler[2] = 1.5708  # 90 度
`;

const SCRIPT_A_NORMALIZED_EQUIV = `import bpy
bpy.ops.mesh.primitive_cube_add()
obj = bpy.context.active_object
obj.rotation_euler[2] = 1.5708
`;

const SCRIPT_B = `import bpy
bpy.ops.mesh.primitive_monkey_add()
bpy.ops.object.shade_smooth()
`;

// ── 指紋確定性 ──────────────────────────────────────────────

test("fingerprintScript：同腳本同指紋（確定性）", () => {
  assert.equal(fingerprintScript(SCRIPT_A), fingerprintScript(SCRIPT_A));
  assert.equal(fingerprintScript(SCRIPT_A), fingerprintScript(SCRIPT_A + "\n"));
});

test("fingerprintScript：去註釋/空白差異後同指紋", () => {
  // CRLF 行尾 + 空行 + 行尾空白 + 全註釋行，與乾淨版等價。
  const noisy = [
    "# 頭註釋",
    "import bpy",
    "",
    "bpy.ops.mesh.primitive_cube_add()   # 方塊",
    "obj = bpy.context.active_object",
    "   ",
    "obj.rotation_euler[2] = 1.5708   # 90 度",
    "# 尾註釋",
    "",
  ].join("\r\n");
  assert.equal(fingerprintScript(noisy), fingerprintScript(SCRIPT_A));
  assert.equal(fingerprintScript(SCRIPT_A_NORMALIZED_EQUIV), fingerprintScript(SCRIPT_A));
});

test("fingerprintScript：不同腳本不同指紋", () => {
  const fps = new Set([fingerprintScript(SCRIPT_A), fingerprintScript(SCRIPT_B), fingerprintScript(""), fingerprintScript("import bpy")]);
  assert.equal(fps.size, 4);
});

test("fingerprintScript：字符串內的 # 不當註釋（引號感知）", () => {
  // 同一文本一個在真註釋（被剝）一個在字符串（被保留）→ 指紋必不同。
  const asComment = 'x = 1\n# msg = "hello"\n';
  const asString = 'x = 1\nmsg = "# hello"\n';
  assert.notEqual(fingerprintScript(asComment), fingerprintScript(asString));
});

test("fingerprintScript：縮進層級保留（Python 縮進即語義）", () => {
  const indented = "if x:\n    run()\n";
  const flattened = "if x:\nrun()\n";
  assert.notEqual(fingerprintScript(indented), fingerprintScript(flattened));
});

test("normalizeScript：引號外去註釋 + 空白摺疊的基礎形", () => {
  assert.equal(normalizeScript("a = 1  # note\n\n  b = 2\n"), "a = 1\n b = 2");
  assert.equal(normalizeScript("s = 'a # b'  # real comment"), "s = 'a # b'");
  assert.equal(normalizeScript('s = "x \\" # y"'), 's = "x \\" # y"');
  assert.equal(normalizeScript("'''doc\nstring'''  # c\nrun()"), "'''doc\nstring'''\nrun()");
});

// ── 入庫-取出往返 ────────────────────────────────────────────

function bridgeArtifacts() {
  return [
    { path: ".blender-work/out/scene.blend", bytes: 123456, kind: "blend" },
    { path: ".blender-work/out/scene.glb", bytes: 45678, kind: "glb" },
    { path: ".blender-work/out/turntable.mp4", bytes: 999999, kind: "mp4" },
    { path: ".blender-work/out/frame0001.png", bytes: 2048, kind: "png" },
  ];
}

test("saveSceneAssets：腳本+blend/glb 入庫，png/mp4 不收，回確定性 id", async () => {
  const result = await saveSceneAssets(USER_ID, bridgeArtifacts(), {
    scene_summary: "立方體轉 90 度",
    delegation: { effect_description: "方塊旋轉展示" },
    script: SCRIPT_A,
  });
  assert.ok(result.ok);
  assert.equal(result.pack_id, BLENDER_ASSET_PACK_ID);
  assert.equal(result.items.length, 3); // bpy_script + blend + glb
  assert.equal(result.deduped, 0);
  const kinds = result.items.map((i) => i.kind).sort();
  assert.deepEqual(kinds, ["bpy_script", "scene_3d", "scene_3d"]);
  // id 內容位址：同內容重算同 id。
  const again = await saveSceneAssets(USER_ID, bridgeArtifacts(), {
    scene_summary: "立方體轉 90 度",
    delegation: { effect_description: "方塊旋轉展示" },
    script: SCRIPT_A,
  });
  assert.ok(again.ok);
  assert.deepEqual(again.items.map((i) => i.id), result.items.map((i) => i.id));
  assert.equal(again.deduped, 3); // 冪等：全部去重
  const packs = await listAssetPacks(USER_ID);
  assert.equal(packs.length, 1); // 沒有重複包
});

test("saveSceneAssets → findTemplateByFingerprint 往返（含元數據+腳本全文）", async () => {
  const saved = await saveSceneAssets(USER_ID, bridgeArtifacts(), {
    scene_summary: "立方體轉 90 度",
    script: SCRIPT_A,
    script_path: ".blender-work/out/scene.py",
  });
  assert.ok(saved.ok);
  const scriptRef = saved.items.find((i) => i.kind === "bpy_script");
  assert.ok(scriptRef?.fingerprint);

  const hit = await findTemplateByFingerprint(USER_ID, scriptRef.fingerprint!);
  assert.ok(hit.ok);
  assert.equal(hit.template.script, SCRIPT_A);
  assert.equal(hit.template.artifactPath, ".blender-work/out/scene.py");
  assert.equal(hit.template.sceneSummary, "立方體轉 90 度");
  assert.equal(hit.template.packId, BLENDER_ASSET_PACK_ID);
  assert.equal(typeof hit.template.bytes, "number");

  // 大小寫不敏感 + trim。
  const hit2 = await findTemplateByFingerprint(USER_ID, `  ${scriptRef.fingerprint!.toUpperCase()} `);
  assert.ok(hit2.ok);

  const miss = await findTemplateByFingerprint(USER_ID, fingerprintScript(SCRIPT_B));
  assert.ok(!miss.ok);
  assert.equal(miss.code, "not_found");
});

test("saveSceneAssets：空產物且無腳本 → 結構化 no_assets", async () => {
  const r1 = await saveSceneAssets(USER_ID, [], {});
  assert.ok(!r1.ok);
  assert.equal(r1.code, "no_assets");
  const r2 = await saveSceneAssets(USER_ID, [{ path: "a.png", bytes: 1, kind: "png" }], {});
  assert.ok(!r2.ok);
  assert.equal(r2.code, "no_assets");
});

test("saveSceneAssets：非法產物（缺 path/bytes）被過濾", async () => {
  const r = await saveSceneAssets(
    USER_ID,
    [
      { path: "", bytes: 10, kind: "blend" },
      { path: "ok.glb", bytes: Number.NaN, kind: "glb" },
      { path: "good.blend", bytes: 5, kind: "blend" },
    ],
    {},
  );
  assert.ok(r.ok);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].artifact_path, "good.blend");
});

test("saveSceneAssets：入庫包符合 MAX_ITEMS_PER_PACK，新資產優先", async () => {
  const first = await saveSceneAssets(USER_ID, [], { script: SCRIPT_A });
  assert.ok(first.ok);
  for (let i = 0; i < 60; i++) {
    const r = await saveSceneAssets(USER_ID, [], { script: `${SCRIPT_A}\n# v${i}\nobj.scale[${i % 3}] = ${i}` });
    assert.ok(r.ok);
  }
  const packs = await listAssetPacks(USER_ID);
  const pack = packs.find((p) => p.id === BLENDER_ASSET_PACK_ID) as AssetPack;
  assert.equal(pack.items.length, 50);
  // 新腳本（60 號）必在；最舊的首個腳本被滾出。
  const newest = await findTemplateByFingerprint(USER_ID, fingerprintScript(`${SCRIPT_A}\n# v59\nobj.scale[2] = 59`));
  assert.ok(newest.ok);
  assert.equal(await findTemplateByFingerprint(USER_ID, fingerprintScript(SCRIPT_A)).then((r) => r.ok), false);
});

// ── 類型校驗（normalizeAssetPack 3D 分支）────────────────────

test("normalizeAssetPack：scene_3d 收 artifactPath/bytes/sceneSummary/fingerprint，非法值丟棄", () => {
  const pack = normalizeAssetPack({
    id: "p1",
    title: "t",
    items: [
      {
        kind: "scene_3d",
        title: "s",
        artifactPath: "  .blender-work/out/a.blend  ",
        bytes: 123.7,
        sceneSummary: "  摘要  ",
        fingerprint: "0123abcd0123abcd",
        content: "不收",
        imageUrl: "不收",
      },
      {
        kind: "scene_3d",
        title: "bad",
        artifactPath: "   ",
        bytes: "big" as unknown as number,
        sceneSummary: 42 as unknown as string,
        fingerprint: "  ",
      },
    ],
  });
  assert.ok(pack);
  const [good, bad] = pack.items;
  assert.equal(good.artifactPath, ".blender-work/out/a.blend");
  assert.equal(good.bytes, 123.7);
  assert.equal(good.sceneSummary, "摘要");
  assert.equal(good.fingerprint, "0123abcd0123abcd");
  assert.equal(good.content, undefined);
  assert.equal(good.imageUrl, undefined);
  assert.equal(bad.artifactPath, undefined);
  assert.equal(bad.bytes, undefined);
  assert.equal(bad.sceneSummary, undefined);
  assert.equal(bad.fingerprint, undefined);
});

test("normalizeAssetPack：bpy_script 收 content（腳本全文）+ fingerprint；缺 artifactPath 也可", () => {
  const pack = normalizeAssetPack({
    id: "p1",
    title: "t",
    items: [{ kind: "bpy_script", title: "script", content: SCRIPT_A, fingerprint: "ab" }],
  });
  assert.ok(pack);
  const [item] = pack.items;
  assert.equal(item.content, SCRIPT_A);
  assert.equal(item.fingerprint, "ab");
});

test("normalizeAssetPack：3D kind 進白名單（不再 drop）", () => {
  const pack = normalizeAssetPack({
    id: "p1",
    title: "t",
    items: [
      { kind: "scene_3d", title: "s1" },
      { kind: "bpy_script", title: "s2" },
      { kind: "video", title: "still-bad" },
    ],
  });
  assert.ok(pack);
  assert.equal(pack.items.length, 2);
});
