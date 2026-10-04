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
  intent: "生成一个 60 帧 turntable 白模预演",
  materials: ["canvas-node:abc123", "asset-pack:kenney/starter"],
  acceptance: ["输出 mp4 turntable", "60 帧 30fps"],
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

test("合法交付物通过闸门（ok:true 且零 errors）", () => {
  const result = validateExpertDeliverable(validDeliverable());
  assert.deepEqual(result, { ok: true, errors: [] });
});

test("缺 qcSignature 拒（人话报错且不误报其他栏位）", () => {
  const d = validDeliverable();
  const broken = { ...d, qcSignature: "" };
  const result = validateExpertDeliverable(broken);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /qcSignature 缺失/);
});

test("qcSignature 被篡改拒", () => {
  const d = validDeliverable();
  const tampered = { ...d, payload: { ...d.payload, scene_summary: "篡改后的摘要" }, qcSignature: d.qcSignature };
  const result = validateExpertDeliverable(tampered);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("不符")));
  // 同一违规交付物，重算签名后应通过（证明篡改检测锁的是内容而非形状）
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
  // 空壳 payload 连正确签名都救不了（内容闸门独立于签名闸门）
  const unsigned = { ...rest, qcSignature: "" };
  const double = validateExpertDeliverable(unsigned);
  assert.ok(double.errors.length >= 2);
});

test("签名确定性：同输入两次同值，key 插入序不影响", () => {
  const d = validDeliverable();
  const again = validDeliverable();
  assert.equal(d.qcSignature, again.qcSignature);
  assert.equal(computeQcSignature(d), d.qcSignature);

  // payload key 顺序颠倒 → 稳定 JSON 排序后同签名
  const reordered = { ...d, payload: { deliverables: ["turntable", "blend"], scene_summary: "白模 turntable 交付" } };
  const { qcSignature: _dropped, ...rest } = reordered;
  assert.equal(computeQcSignature(rest), d.qcSignature);

  // 内容任一变化 → 签名必变
  const changed = { ...d, kind: "music_track" };
  assert.notEqual(computeQcSignature(changed), d.qcSignature);
});

test("expertId 白名单与契约回指：非法值拒、缺 evidence 拒", () => {
  // Wave2a 五域占位（provisioned 不可路由）与两个启用行同列入运行时白名单；
  // 09-15 评测补课片追加独立审核 Expert "critic"（critic-delegate 换挂翻正）。
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

  // 交付物回指的 contract 与派工契约逐栏相等（可追溯）
  const d = validDeliverable();
  assert.deepEqual(d.contract, contract);
});

test("blenderArtifactToEvidence 复用 bridge 产物形（path/bytes → evidence）", () => {
  assert.deepEqual(blenderArtifactToEvidence({ path: "out/turntable.mp4", bytes: 2048, kind: "mp4" }), {
    artifactPath: "out/turntable.mp4",
    bytes: 2048,
  });
  // bytes=0 不造假指针；带上 artifactPath 后签名闸门可过
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
