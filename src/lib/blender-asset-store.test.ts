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

const SCRIPT_A = `# 建一个方块并转 90 度
import bpy
bpy.ops.mesh.primitive_cube_add()   # 方块
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

// ── 指纹确定性 ──────────────────────────────────────────────

test("fingerprintScript：同脚本同指纹（确定性）", () => {
  assert.equal(fingerprintScript(SCRIPT_A), fingerprintScript(SCRIPT_A));
  assert.equal(fingerprintScript(SCRIPT_A), fingerprintScript(SCRIPT_A + "\n"));
});

test("fingerprintScript：去注释/空白差异后同指纹", () => {
  // CRLF 行尾 + 空行 + 行尾空白 + 全注释行，与干净版等价。
  const noisy = [
    "# 头注释",
    "import bpy",
    "",
    "bpy.ops.mesh.primitive_cube_add()   # 方块",
    "obj = bpy.context.active_object",
    "   ",
    "obj.rotation_euler[2] = 1.5708   # 90 度",
    "# 尾注释",
    "",
  ].join("\r\n");
  assert.equal(fingerprintScript(noisy), fingerprintScript(SCRIPT_A));
  assert.equal(fingerprintScript(SCRIPT_A_NORMALIZED_EQUIV), fingerprintScript(SCRIPT_A));
});

test("fingerprintScript：不同脚本不同指纹", () => {
  const fps = new Set([fingerprintScript(SCRIPT_A), fingerprintScript(SCRIPT_B), fingerprintScript(""), fingerprintScript("import bpy")]);
  assert.equal(fps.size, 4);
});

test("fingerprintScript：字符串内的 # 不当注释（引号感知）", () => {
  // 同一文本一个在真注释（被剥）一个在字符串（被保留）→ 指纹必不同。
  const asComment = 'x = 1\n# msg = "hello"\n';
  const asString = 'x = 1\nmsg = "# hello"\n';
  assert.notEqual(fingerprintScript(asComment), fingerprintScript(asString));
});

test("fingerprintScript：缩进层级保留（Python 缩进即语义）", () => {
  const indented = "if x:\n    run()\n";
  const flattened = "if x:\nrun()\n";
  assert.notEqual(fingerprintScript(indented), fingerprintScript(flattened));
});

test("normalizeScript：引号外去注释 + 空白折叠的基础形", () => {
  assert.equal(normalizeScript("a = 1  # note\n\n  b = 2\n"), "a = 1\n b = 2");
  assert.equal(normalizeScript("s = 'a # b'  # real comment"), "s = 'a # b'");
  assert.equal(normalizeScript('s = "x \\" # y"'), 's = "x \\" # y"');
  assert.equal(normalizeScript("'''doc\nstring'''  # c\nrun()"), "'''doc\nstring'''\nrun()");
});

// ── 入库-取出往返 ────────────────────────────────────────────

function bridgeArtifacts() {
  return [
    { path: ".blender-work/out/scene.blend", bytes: 123456, kind: "blend" },
    { path: ".blender-work/out/scene.glb", bytes: 45678, kind: "glb" },
    { path: ".blender-work/out/turntable.mp4", bytes: 999999, kind: "mp4" },
    { path: ".blender-work/out/frame0001.png", bytes: 2048, kind: "png" },
  ];
}

test("saveSceneAssets：脚本+blend/glb 入库，png/mp4 不收，回确定性 id", async () => {
  const result = await saveSceneAssets(USER_ID, bridgeArtifacts(), {
    scene_summary: "立方体转 90 度",
    delegation: { effect_description: "方块旋转展示" },
    script: SCRIPT_A,
  });
  assert.ok(result.ok);
  assert.equal(result.pack_id, BLENDER_ASSET_PACK_ID);
  assert.equal(result.items.length, 3); // bpy_script + blend + glb
  assert.equal(result.deduped, 0);
  const kinds = result.items.map((i) => i.kind).sort();
  assert.deepEqual(kinds, ["bpy_script", "scene_3d", "scene_3d"]);
  // id 内容位址：同内容重算同 id。
  const again = await saveSceneAssets(USER_ID, bridgeArtifacts(), {
    scene_summary: "立方体转 90 度",
    delegation: { effect_description: "方块旋转展示" },
    script: SCRIPT_A,
  });
  assert.ok(again.ok);
  assert.deepEqual(again.items.map((i) => i.id), result.items.map((i) => i.id));
  assert.equal(again.deduped, 3); // 幂等：全部去重
  const packs = await listAssetPacks(USER_ID);
  assert.equal(packs.length, 1); // 没有重复包
});

test("saveSceneAssets → findTemplateByFingerprint 往返（含元数据+脚本全文）", async () => {
  const saved = await saveSceneAssets(USER_ID, bridgeArtifacts(), {
    scene_summary: "立方体转 90 度",
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
  assert.equal(hit.template.sceneSummary, "立方体转 90 度");
  assert.equal(hit.template.packId, BLENDER_ASSET_PACK_ID);
  assert.equal(typeof hit.template.bytes, "number");

  // 大小写不敏感 + trim。
  const hit2 = await findTemplateByFingerprint(USER_ID, `  ${scriptRef.fingerprint!.toUpperCase()} `);
  assert.ok(hit2.ok);

  const miss = await findTemplateByFingerprint(USER_ID, fingerprintScript(SCRIPT_B));
  assert.ok(!miss.ok);
  assert.equal(miss.code, "not_found");
});

test("saveSceneAssets：空产物且无脚本 → 结构化 no_assets", async () => {
  const r1 = await saveSceneAssets(USER_ID, [], {});
  assert.ok(!r1.ok);
  assert.equal(r1.code, "no_assets");
  const r2 = await saveSceneAssets(USER_ID, [{ path: "a.png", bytes: 1, kind: "png" }], {});
  assert.ok(!r2.ok);
  assert.equal(r2.code, "no_assets");
});

test("saveSceneAssets：非法产物（缺 path/bytes）被过滤", async () => {
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

test("saveSceneAssets：入库包符合 MAX_ITEMS_PER_PACK，新资产优先", async () => {
  const first = await saveSceneAssets(USER_ID, [], { script: SCRIPT_A });
  assert.ok(first.ok);
  for (let i = 0; i < 60; i++) {
    const r = await saveSceneAssets(USER_ID, [], { script: `${SCRIPT_A}\n# v${i}\nobj.scale[${i % 3}] = ${i}` });
    assert.ok(r.ok);
  }
  const packs = await listAssetPacks(USER_ID);
  const pack = packs.find((p) => p.id === BLENDER_ASSET_PACK_ID) as AssetPack;
  assert.equal(pack.items.length, 50);
  // 新脚本（60 号）必在；最旧的首个脚本被滚出。
  const newest = await findTemplateByFingerprint(USER_ID, fingerprintScript(`${SCRIPT_A}\n# v59\nobj.scale[2] = 59`));
  assert.ok(newest.ok);
  assert.equal(await findTemplateByFingerprint(USER_ID, fingerprintScript(SCRIPT_A)).then((r) => r.ok), false);
});

// ── 类型校验（normalizeAssetPack 3D 分支）────────────────────

test("normalizeAssetPack：scene_3d 收 artifactPath/bytes/sceneSummary/fingerprint，非法值丢弃", () => {
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

test("normalizeAssetPack：bpy_script 收 content（脚本全文）+ fingerprint；缺 artifactPath 也可", () => {
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

test("normalizeAssetPack：3D kind 进白名单（不再 drop）", () => {
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
