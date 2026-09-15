import assert from "node:assert/strict";
import test from "node:test";
import {
  EXPERT_IDS,
  computeQcSignature,
  blenderArtifactToEvidence,
  validateExpertDeliverable,
  type ExpertDeliverable,
  type ExpertTaskContract,
} from "./expert-contract";

const contract: ExpertTaskContract = {
  expertId: "director3d",
  intent: "生成一個 60 幀 turntable 白模預演",
  materials: ["canvas-node:abc123", "asset-pack:kenney/starter"],
  acceptance: ["輸出 mp4 turntable", "60 幀 30fps"],
  budgetCoins: 3,
  timeBudgetMinutes: 10,
};

function validDeliverable(): ExpertDeliverable {
  const base = {
    expertId: "director3d" as const,
    kind: "scene_3d",
    payload: { scene_summary: "白模 turntable 交付", deliverables: ["turntable", "blend"] },
    evidence: { url: "https://example.com/out/turntable.mp4", bytes: 1024 },
    contract,
  };
  return { ...base, qcSignature: computeQcSignature(base) };
}

test("合法交付物通過閘門（ok:true 且零 errors）", () => {
  const result = validateExpertDeliverable(validDeliverable());
  assert.deepEqual(result, { ok: true, errors: [] });
});

test("缺 qcSignature 拒（人話報錯且不誤報其他欄位）", () => {
  const d = validDeliverable();
  const broken = { ...d, qcSignature: "" };
  const result = validateExpertDeliverable(broken);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /qcSignature 缺失/);
});

test("qcSignature 被篡改拒", () => {
  const d = validDeliverable();
  const tampered = { ...d, payload: { ...d.payload, scene_summary: "篡改後的摘要" }, qcSignature: d.qcSignature };
  const result = validateExpertDeliverable(tampered);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("不符")));
  // 同一違規交付物，重算簽名後應通過（證明篡改檢測鎖的是內容而非形狀）
  const { qcSignature: _dropped, ...rest } = tampered;
  const repaired = { ...rest, qcSignature: computeQcSignature(rest) };
  assert.deepEqual(validateExpertDeliverable(repaired), { ok: true, errors: [] });
});

test("payload 空拒", () => {
  const d = validDeliverable();
  const { qcSignature: _dropped, ...rest } = { ...d, payload: {} };
  const result = validateExpertDeliverable({ ...rest, qcSignature: computeQcSignature(rest) });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("payload")));
  // 空殼 payload 連正確簽名都救不了（內容閘門獨立於簽名閘門）
  const unsigned = { ...rest, qcSignature: "" };
  const double = validateExpertDeliverable(unsigned);
  assert.ok(double.errors.length >= 2);
});

test("簽名確定性：同輸入兩次同值，key 插入序不影響", () => {
  const d = validDeliverable();
  const again = validDeliverable();
  assert.equal(d.qcSignature, again.qcSignature);
  assert.equal(computeQcSignature(d), d.qcSignature);

  // payload key 順序顛倒 → 穩定 JSON 排序後同簽名
  const reordered = { ...d, payload: { deliverables: ["turntable", "blend"], scene_summary: "白模 turntable 交付" } };
  const { qcSignature: _dropped, ...rest } = reordered;
  assert.equal(computeQcSignature(rest), d.qcSignature);

  // 內容任一變化 → 簽名必變
  const changed = { ...d, kind: "music_track" };
  assert.notEqual(computeQcSignature(changed), d.qcSignature);
});

test("expertId 白名單與契約回指：非法值拒、缺 evidence 拒", () => {
  // Wave2a 五域佔位（provisioned 不可路由）與兩個啟用行同列入運行時白名單；
  // 09-15 評測補課片追加獨立審核 Expert "critic"（critic-delegate 換掛翻正）。
  assert.deepEqual([...EXPERT_IDS], [
    "director3d",
    "music",
    "video-director",
    "editor",
    "screenwriter",
    "motion-director",
    "web3d-director",
    "critic",
  ]);

  const bad = validDeliverable();
  const badId = validateExpertDeliverable({ ...bad, expertId: "rotoscope" as never });
  assert.equal(badId.ok, false);
  assert.ok(badId.errors.some((e) => e.includes("expertId")));

  const noEvidence = validDeliverable();
  const { qcSignature: _dropped, ...rest } = { ...noEvidence, evidence: {} };
  const evResult = validateExpertDeliverable({ ...rest, qcSignature: computeQcSignature(rest) });
  assert.equal(evResult.ok, false);
  assert.ok(evResult.errors.some((e) => e.includes("evidence")));

  // 交付物回指的 contract 與派工契約逐欄相等（可追溯）
  const d = validDeliverable();
  assert.deepEqual(d.contract, contract);
});

test("blenderArtifactToEvidence 復用 bridge 產物形（path/bytes → evidence）", () => {
  assert.deepEqual(blenderArtifactToEvidence({ path: "out/turntable.mp4", bytes: 2048, kind: "mp4" }), {
    artifactPath: "out/turntable.mp4",
    bytes: 2048,
  });
  // bytes=0 不造假指針；帶上 artifactPath 後簽名閘門可過
  const evidence = blenderArtifactToEvidence({ path: "out/scene.blend", bytes: 0, kind: "blend" });
  assert.deepEqual(evidence, { artifactPath: "out/scene.blend" });
  const base = {
    expertId: "director3d" as const,
    kind: "scene_3d",
    payload: { scene_summary: "blend 交付" },
    evidence,
    contract,
  };
  assert.deepEqual(validateExpertDeliverable({ ...base, qcSignature: computeQcSignature(base) }), { ok: true, errors: [] });
});
