// DSL v2（target:"project"）测试：期望值来自 S0 契约夹具（deploy-staging/gateway/project/contract-fixtures.json）、
// 契约 types.ts 文本、以及手算的 P0 patchForExisting 语义；不镜像实现。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LIMITS } from "../../../deploy-staging/gateway/project/constants";
import type { PatchOp } from "../../../deploy-staging/gateway/project/types";
import { CanvasNodeType } from "../canvas/types";
import { compileWorkflow, compileWorkflowForTarget, workflowNodeId, type WorkflowCompileInput } from "./compile";
import { decompileProject } from "./decompile";
import {
  compileProjectDsl, normalizeProjectCurrent,
  type ProjectCompileInput, type ProjectCurrentNode,
} from "./project-ops";
import { PROJECT_INTENT_MAX, PROJECT_NODE_KINDS, PROJECT_PARAMS_MAX_BYTES, validateProjectDsl, type ProjectDslSource } from "./schema";

const FIXTURES = JSON.parse(readFileSync(join(process.cwd(), "deploy-staging/gateway/project/contract-fixtures.json"), "utf8")) as {
  graphs: { base: { nodes: Record<string, ProjectCurrentNode> } };
  patchOps: Record<string, { op: Record<string, unknown> }>;
};
const TYPES_TS = readFileSync(join(process.cwd(), "deploy-staging/gateway/project/types.ts"), "utf8");
const baseNodes = (): ProjectCurrentNode[] => structuredClone(Object.values(FIXTURES.graphs.base.nodes));
const BASE: ProjectCompileInput = { nodes: baseNodes() };
const EMPTY: ProjectCompileInput = { nodes: [] };

// ─────────────────────────── 契约校验 + 手工套用（引擎 S2 的最小替身，只为往返）

const OP_KEYS: Record<string, { req: string[]; opt: string[] }> = {
  add_node: { req: ["node"], opt: [] }, set: { req: ["node", "path", "value"], opt: ["ifRev"] }, remove_node: { req: ["node"], opt: [] },
  connect: { req: ["to", "input", "from"], opt: ["port"] }, disconnect: { req: ["to", "input"], opt: [] },
  lock: { req: ["node", "fields"], opt: [] }, unlock: { req: ["node"], opt: [] }, pin: { req: ["node"], opt: ["take", "reason"] },
  unpin: { req: ["node"], opt: [] }, replace_output: { req: ["node", "artifactId"], opt: [] }, select_take: { req: ["node", "take"], opt: [] },
  reroll: { req: ["node"], opt: [] }, write_result: { req: ["node", "value"], opt: [] }, set_targets: { req: ["targets"], opt: [] },
  set_defaults: { req: ["defaults"], opt: [] }, apply_recipe: { req: ["recipe", "params"], opt: [] },
};
const NODE_ID = /^[a-z][a-z0-9_]{0,47}(#[a-z0-9_]{1,32})?$/;

function assertContractOp(op: PatchOp): void {
  const o = op as unknown as Record<string, unknown>;
  assert.ok(o.op as string in FIXTURES.patchOps, `op ${String(o.op)} 必须是夹具里的 16 种 op 之一`);
  const spec = OP_KEYS[o.op as string];
  for (const k of spec.req) assert.ok(k in o, `${String(o.op)} 缺必填键 ${k}`);
  for (const k of Object.keys(o)) assert.ok(k === "op" || spec.req.includes(k) || spec.opt.includes(k), `${String(o.op)} 不应有键 ${k}`);
  if (op.op === "add_node") {
    assert.match(op.node.id, NODE_ID);
    assert.ok((PROJECT_NODE_KINDS as readonly string[]).includes(op.node.type));
    for (const k of Object.keys(op.node)) assert.ok(["id", "type", "intent", "params", "inputs", "refs", "forEach", "takes", "onFail"].includes(k), `NewNode 不应有键 ${k}`);
  }
  if (op.op === "set") assert.match(op.path, /^(intent|params\.[^.]+|takes|onFail|forEach|refs)$/);
  if (op.op === "connect" || op.op === "disconnect") assert.match(op.to, NODE_ID);
}

function applyOps(state: ProjectCompileInput, ops: PatchOp[]): ProjectCompileInput {
  const nodes = new Map(state.nodes.map((n) => [n.id, structuredClone(n)]));
  for (const op of ops) {
    if (op.op === "add_node") {
      nodes.set(op.node.id, { id: op.node.id, type: op.node.type, intent: op.node.intent ?? "", params: { ...(op.node.params ?? {}) }, inputs: {}, refs: op.node.refs ?? [],
        ...(op.node.forEach ? { forEach: op.node.forEach } : {}), ...(op.node.takes ? { takes: op.node.takes } : {}), ...(op.node.onFail ? { onFail: op.node.onFail } : {}), pinned: null });
    } else if (op.op === "set") {
      const n = nodes.get(op.node)!;
      if (op.path.startsWith("params.")) n.params = { ...(n.params ?? {}), [op.path.slice(7)]: op.value };
      else (n as unknown as Record<string, unknown>)[op.path] = op.value === null ? undefined : op.value;
    } else if (op.op === "connect") {
      nodes.get(op.to)!.inputs = { ...(nodes.get(op.to)!.inputs ?? {}), [op.input]: op.port === undefined ? { from: op.from } : { from: op.from, port: op.port } };
    } else if (op.op === "disconnect") {
      const n = nodes.get(op.to)!;
      const { [op.input]: _drop, ...rest } = n.inputs ?? {};
      n.inputs = rest;
    } else if (op.op === "pin") {
      nodes.get(op.node)!.pinned = { ...(op.take !== undefined ? { take: op.take } : {}), ...(op.reason !== undefined ? { reason: op.reason } : {}) };
    } else if (op.op === "unpin") {
      nodes.get(op.node)!.pinned = null;
    }
  }
  return { nodes: [...nodes.values()] };
}

function mustCompile(source: unknown, current: ProjectCompileInput) {
  const r = compileProjectDsl(source, current);
  assert.equal(r.ok, true, r.ok ? "" : JSON.stringify(r.errors));
  if (!r.ok) throw new Error("unreachable");
  r.ops.forEach(assertContractOp);
  return r;
}

// ─────────────────────────── 契约锁定

test("常量与契约同源锁定：NodeType 清单 = types.ts 的联合、intent/params 上限 = LIMITS", () => {
  const union = /export type NodeType =([\s\S]*?)\n\nexport type NodeStatus/.exec(TYPES_TS)![1];
  const fromContract = [...union.matchAll(/\| "([a-z0-9]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual([...PROJECT_NODE_KINDS].sort(), fromContract);
  assert.equal(PROJECT_INTENT_MAX, LIMITS.INTENT_CHARS);
  assert.equal(PROJECT_PARAMS_MAX_BYTES, LIMITS.INPUT_CAP_BYTES);
});

// ─────────────────────────── 新 kind + forEach/takes/onFail/refs/intent 输出

const FULL: ProjectDslSource = {
  steps: [
    { id: "cast", kind: "reference", intent: "主角参考", params: { source: "upload", artifactId: "art_aaaaaaaaaaaaaaaa" } },
    { id: "script", kind: "script", intent: "剧本", params: { text: "开场" } },
    { id: "shots", kind: "shotlist", needs: ["script"], params: { kind: "shots", rows: [{ id: "a", action: "倒咖啡" }, { id: "b", action: "举杯" }] } },
    {
      id: "kf", kind: "keyframe", intent: "逐镜关键帧", needs: ["cast"],
      params: { prompt: "${row.action}", model: "m-img", size: "1024x1024", seed: 7, role: "keyframe", n: 1 },
      forEach: { over: "shots", as: "shot" },
      takes: { n: 2, select: "qc", rubric: "r_keyframe" },
      onFail: { action: "regenerate", max: 2, on: "any", then: "ask_user" },
      refs: [{ artifactId: "art_bbbbbbbbbbbbbbbb", role: "style" }],
    },
    { id: "clip", kind: "clip", inputs: { start: { from: "kf", port: "out" } }, forEach: { over: "shots", as: "shot" }, params: { prompt: "${row.action}", model: "m-vid", seconds: 3, resolution: "720p" } },
    { id: "vo", kind: "voice", needs: ["script"], params: { text: "你好", voice: "v1", speed: 1 } },
    { id: "bgm", kind: "music", params: { prompt: "轻爵士", seconds: 15 } },
    { id: "tl", kind: "timeline", needs: ["clip", "vo"], params: { aspect: "16:9", fps: 25 } },
    { id: "sub", kind: "subtitle", needs: ["tl"], params: { style: "default", burnIn: true } },
    { id: "mx", kind: "mix", needs: ["vo", "bgm"], params: { targetLufs: -16 } },
    { id: "r3", kind: "render3d", params: { script: "bpy.ops.mesh.primitive_cube_add()", engine: "cycles" } },
    { id: "qc1", kind: "qc", needs: ["tl"], params: { mode: "machine" } },
    { id: "out", kind: "export", inputs: { video: { from: "tl" }, audio: { from: "mx" } }, params: { preset: "landscape_169" } },
  ],
};

test("新 kind 全覆盖：13 种类型都能 add_node，forEach/takes/onFail/refs/intent 原样落进 NewNode，通过契约形状校验", () => {
  const r = mustCompile(FULL, EMPTY);
  const adds = r.ops.filter((o): o is Extract<PatchOp, { op: "add_node" }> => o.op === "add_node");
  assert.equal(adds.length, 13);
  assert.deepEqual(new Set(adds.map((a) => a.node.type)), new Set(PROJECT_NODE_KINDS));
  const kf = adds.find((a) => a.node.id === "kf")!.node;
  assert.deepEqual(kf.forEach, { over: "shots", as: "shot" });
  assert.deepEqual(kf.takes, { n: 2, select: "qc", rubric: "r_keyframe" });
  assert.deepEqual(kf.onFail, { action: "regenerate", max: 2, on: "any", then: "ask_user" });
  assert.deepEqual(kf.refs, [{ artifactId: "art_bbbbbbbbbbbbbbbb", role: "style" }]);
  assert.equal(kf.intent, "逐镜关键帧");
  assert.equal(kf.params?.prompt, "${row.action}", "引用串原样保留，交 S4 解析");
  // shots 必须先于 kf/clip（forEach.over 是排序依赖，但不生成 connect）
  const idx = (id: string) => adds.findIndex((a) => a.node.id === id);
  assert.ok(idx("shots") < idx("kf") && idx("kf") < idx("clip") && idx("clip") < idx("tl") && idx("tl") < idx("out"));
  assert.equal(r.ops.some((o) => o.op === "connect" && o.to === "kf" && o.from === "shots"), false);
  // 连线：needs → 口名=依赖 id；inputs 保留口名与 port
  const conns = r.ops.filter((o): o is Extract<PatchOp, { op: "connect" }> => o.op === "connect");
  assert.deepEqual(conns.find((c) => c.to === "clip"), { op: "connect", to: "clip", input: "start", from: "kf", port: "out" });
  assert.deepEqual(conns.find((c) => c.to === "kf"), { op: "connect", to: "kf", input: "cast", from: "cast" });
  assert.deepEqual(conns.find((c) => c.to === "out" && c.input === "video"), { op: "connect", to: "out", input: "video", from: "tl" });
  assert.equal(conns.length, 12, "手数：shots1 kf1 clip1 vo1 tl2 sub1 mx2 qc1 out2 = 12");
  // 连线在全部 add_node 之后
  assert.ok(r.ops.findIndex((o) => o.op === "connect") > r.ops.map((o) => o.op).lastIndexOf("add_node"));
  assert.deepEqual(r.summary, { added: 13, updated: 0, connected: 12, pinned: 0, warnings: [], lockedDropped: [] });
});

test("不产出运行类 op：只会有 add_node/set/connect/disconnect/pin/unpin", () => {
  const withBase = mustCompile({ steps: [{ id: "k1", params: { prompt: "新" }, pinned: true }, { id: "k9", kind: "keyframe", needs: ["r1"] }] }, BASE);
  const allowed = new Set(["add_node", "set", "connect", "disconnect", "pin", "unpin"]);
  for (const o of [...withBase.ops, ...mustCompile(FULL, EMPTY).ops]) {
    assert.ok(allowed.has(o.op), `意外 op ${o.op}`);
    assert.doesNotMatch(o.op, /run|generate|exec/);
  }
});

// ─────────────────────────── 往返

test("往返：规范形式 DSL → compile → 套用 → decompile 与原 DSL 逐项相等，再 compile 零 op", () => {
  const r1 = mustCompile(FULL, EMPTY);
  const state = applyOps(EMPTY, r1.ops);
  const back = decompileProject(state);
  assert.ok(back);
  assert.deepEqual(back, FULL);
  const r2 = mustCompile(back, state);
  assert.deepEqual(r2.ops, [], "往返后重编译零 op（幂等）");
  assert.deepEqual(r2.summary, { added: 0, updated: 0, connected: 0, pinned: 0, warnings: [], lockedDropped: [] });
});

test("往返：非规范写法（prompt/model/size/count 快捷字段、title、meta）→ 语义等价，decompile 后是不动点", () => {
  const loose: ProjectDslSource = { steps: [
    { id: "a", kind: "image", title: "第一张", prompt: "猫", model: "m-img", size: "512x512", count: 2, meta: { seed: 3, role: "ref" } },
    { id: "b", kind: "video", needs: ["a"], prompt: "猫跳" },
  ] };
  const r1 = mustCompile(loose, EMPTY);
  const add = r1.ops.find((o) => o.op === "add_node" && o.node.id === "a") as Extract<PatchOp, { op: "add_node" }>;
  assert.equal(add.node.type, "keyframe", "image→keyframe 别名");
  assert.equal(add.node.intent, "第一张", "缺 intent 用 title");
  assert.deepEqual(add.node.params, { seed: 3, role: "ref", prompt: "猫", model: "m-img", size: "512x512", n: 2 });
  const state = applyOps(EMPTY, r1.ops);
  const canon = decompileProject(state)!;
  assert.deepEqual(mustCompile(canon, state).ops, []);
  assert.deepEqual(decompileProject(applyOps(EMPTY, mustCompile(canon, EMPTY).ops)), canon);
});

test("pinned：true 对已有节点发 pin；已钉住不重复发；{take,reason} 透传；false 解钉；新增节点忽略并回 warning；往返保留", () => {
  const r = mustCompile({ steps: [{ id: "k1", pinned: { take: 2, reason: "用户满意" } }] }, BASE);
  assert.deepEqual(r.ops, [{ op: "pin", node: "k1", take: 2, reason: "用户满意" }]);
  const pinnedState = applyOps(BASE, r.ops);
  assert.deepEqual(mustCompile({ steps: [{ id: "k1", pinned: { take: 2 } }] }, pinnedState).ops, [], "同 take 已钉住不重发");
  assert.deepEqual(mustCompile({ steps: [{ id: "k1", pinned: false }] }, pinnedState).ops, [{ op: "unpin", node: "k1" }]);
  assert.deepEqual(mustCompile({ steps: [{ id: "k1", pinned: false }] }, BASE).ops, [], "本来没钉住，解钉无 op");
  const back = decompileProject(pinnedState)!;
  assert.deepEqual(back.steps.find((s) => s.id === "k1")!.pinned, { take: 2, reason: "用户满意" });
  const fresh = mustCompile({ steps: [{ id: "n1", kind: "keyframe", pinned: true }] }, BASE);
  assert.equal(fresh.ops.some((o) => o.op === "pin"), false);
  assert.ok(fresh.summary.warnings.some((w) => w.includes("n1") && w.includes("pinned")));
});

// ─────────────────────────── 增量与 locked（对照 P0 patchForExisting）

test("已有节点只发有差异的 set；DSL 与现值一致 → 零 op；未提及的 params 键不删", () => {
  const r = mustCompile({ steps: [{ id: "k1", intent: "新意图", params: { prompt: "咖啡杯特写", model: "m-img", seed: 99 } }] }, BASE);
  // 夹具 k1.params.prompt/model 已是这两个值 → 只有 intent 与 seed 变
  assert.deepEqual(r.ops, [
    { op: "set", node: "k1", path: "intent", value: "新意图" },
    { op: "set", node: "k1", path: "params.seed", value: 99 },
  ]);
  assert.deepEqual(r.summary.updated, 1);
  assert.deepEqual(mustCompile({ steps: [{ id: "k1", params: { prompt: "咖啡杯特写" }, needs: ["r1"] }] }, { nodes: [{ ...BASE.nodes.find((n) => n.id === "k1")!, inputs: { r1: { from: "r1" } } }, ...BASE.nodes.filter((n) => n.id !== "k1")] }).ops, []);
});

test("locked（旧语义 true / '*' / LockState）：整节点 set 全丢 + lockedDropped；无差异不告警；连线与 pin 不受影响（同 P0）", () => {
  for (const locked of [true, "*", { by: "user", fields: "*", at: "2026-10-28T00:00:00.000Z" }] as ProjectCurrentNode["locked"][]) {
    const cur: ProjectCompileInput = { nodes: BASE.nodes.map((n) => (n.id === "k1" ? { ...n, locked } : n)) };
    const r = mustCompile({ steps: [{ id: "k1", intent: "改", params: { prompt: "别的", seed: 5 }, needs: ["s1"], pinned: true }] }, cur);
    assert.equal(r.ops.some((o) => o.op === "set"), false, "被锁节点不得有 set");
    assert.deepEqual(r.summary.lockedDropped, ["k1"]);
    assert.ok(r.summary.warnings.some((w) => w.includes("lockedDropped") && w.includes("k1")));
    assert.ok(r.ops.some((o) => o.op === "connect" && o.to === "k1" && o.from === "s1"), "连线照发（P0 locked 节点连线不被抑制）");
    assert.ok(r.ops.some((o) => o.op === "pin"));
    assert.equal(r.summary.updated, 0);
    // 与现值相同 → 不告警
    const quiet = mustCompile({ steps: [{ id: "k1", params: { prompt: "咖啡杯特写" } }] }, cur);
    assert.deepEqual(quiet.summary.lockedDropped, []);
    assert.deepEqual(quiet.summary.warnings, []);
  }
});

test("locked 指定字段：只丢被锁路径，其余 set 照发", () => {
  const cur: ProjectCompileInput = { nodes: BASE.nodes.map((n) => (n.id === "k1" ? { ...n, locked: { by: "user", fields: ["params.prompt"], at: "x" } as never } : n)) };
  const r = mustCompile({ steps: [{ id: "k1", params: { prompt: "改", seed: 8 } }] }, cur);
  assert.deepEqual(r.ops, [{ op: "set", node: "k1", path: "params.seed", value: 8 }]);
  assert.deepEqual(r.summary.lockedDropped, ["k1"]);
});

test("P0 对照：同一场景下画布编译与工程编译的 locked 判定一致（有差异才告警、告警都点名该步骤）", () => {
  // 画布侧（P0 语义，compile.ts patchForExisting）：locked 节点 + DSL 改 prompt
  const nid = workflowNodeId("w", "s1");
  const canvasCur: WorkflowCompileInput = { connections: [], nodes: [{ id: nid, type: CanvasNodeType.Image, title: "锁定", position: { x: 0, y: 0 }, width: 1, height: 1, metadata: { locked: true, prompt: "原", kind: "image", workflow_id: "w", workflow_ns: "w", stepId: "s1", stepIndex: 1 } as never }] };
  const changed = compileWorkflow({ workflow: "w", steps: [{ id: "s1", title: "锁定", prompt: "改" }] }, canvasCur);
  const unchanged = compileWorkflow({ workflow: "w", steps: [{ id: "s1", title: "锁定", prompt: "原" }] }, canvasCur);
  assert.ok(changed.ok && unchanged.ok);
  if (!changed.ok || !unchanged.ok) return;
  assert.equal(changed.summary.warnings.length, 1);
  assert.equal(unchanged.summary.warnings.length, 0);
  // 工程侧
  const cur: ProjectCompileInput = { nodes: [{ id: "s1", type: "script", params: { prompt: "原" }, locked: "*" }] };
  const pChanged = mustCompile({ steps: [{ id: "s1", prompt: "改" }] }, cur);
  const pUnchanged = mustCompile({ steps: [{ id: "s1", prompt: "原" }] }, cur);
  assert.equal(pChanged.summary.lockedDropped.length, 1);
  assert.equal(pUnchanged.summary.lockedDropped.length, 0);
  assert.equal(pChanged.ops.some((o) => o.op === "set"), false);
});

test("连线：口被占且来源不同 → disconnect + connect；相同 → 跳过", () => {
  const cur: ProjectCompileInput = { nodes: BASE.nodes.map((n) => (n.id === "k1" ? { ...n, inputs: { ref: { from: "r1" } } } : n)) };
  assert.deepEqual(mustCompile({ steps: [{ id: "k1", inputs: { ref: { from: "r1" } } }] }, cur).ops, []);
  assert.deepEqual(mustCompile({ steps: [{ id: "k1", inputs: { ref: { from: "s1" } } }] }, cur).ops, [
    { op: "disconnect", to: "k1", input: "ref" },
    { op: "connect", to: "k1", input: "ref", from: "s1" },
  ]);
});

test("清除：forEach/takes/onFail 写 null → set value null（仅当现值存在）", () => {
  const cur: ProjectCompileInput = { nodes: [...BASE.nodes.filter((n) => n.id !== "k1"), { ...BASE.nodes.find((n) => n.id === "k1")!, takes: { n: 2, select: "first" } }] };
  assert.deepEqual(mustCompile({ steps: [{ id: "k1", takes: null, onFail: null }] }, cur).ops, [{ op: "set", node: "k1", path: "takes", value: null }]);
});

// ─────────────────────────── 错误

function errorsOf(source: unknown, current: ProjectCompileInput = BASE) {
  const r = compileProjectDsl(source, current);
  assert.equal(r.ok, false);
  return r.ok ? [] : r.errors;
}

test("语义错误：改类型 / 新节点缺 kind / 引用不存在 / 自依赖 / 环 / id 重复", () => {
  assert.ok(errorsOf({ steps: [{ id: "k1", kind: "clip" }] }).some((e) => e.field === "kind" && e.step === "k1"));
  assert.ok(errorsOf({ steps: [{ id: "nn" }] }).some((e) => e.field === "kind" && e.step === "nn"));
  assert.ok(errorsOf({ steps: [{ id: "nn", kind: "clip", needs: ["ghost"] }] }).some((e) => e.field === "needs"));
  assert.ok(errorsOf({ steps: [{ id: "nn", kind: "clip", needs: ["nn"] }] }).some((e) => e.field === "needs"));
  const cyc = errorsOf({ steps: [{ id: "a", kind: "clip", needs: ["b"] }, { id: "b", kind: "clip", needs: ["a"] }] });
  assert.ok(cyc.length > 0 && cyc[0].message.includes("循环"));
  assert.ok(errorsOf({ steps: [{ id: "a", kind: "clip" }, { id: "a", kind: "clip" }] }).some((e) => e.field === "id"));
});

test("forEach / takes / onFail / refs / pinned 边界（契约 §3.3、§3.5）", () => {
  const sl = { id: "sl2", kind: "shotlist" };
  assert.ok(errorsOf({ steps: [{ id: "x", kind: "keyframe", forEach: { over: "k1", as: "s" } }] }).some((e) => e.field === "forEach"), "over 必须是 shotlist");
  assert.ok(errorsOf({ steps: [sl, { id: "x", kind: "keyframe", forEach: { over: "sl2", as: "row" } }] }).some((e) => e.field === "forEach"), "as 不能是 row");
  assert.ok(errorsOf({ steps: [sl, { id: "x", kind: "keyframe", forEach: { over: "sl2", as: "s" } }, { id: "y", kind: "clip", forEach: { over: "x", as: "t" } }] }).some((e) => e.field === "forEach"), "不得 over 非 shotlist/forEach 节点");
  assert.ok(errorsOf({ steps: [{ id: "x", kind: "keyframe", takes: { n: 1, select: "qc" } }] }).some((e) => e.field === "takes"), "n 须 2..4");
  assert.ok(errorsOf({ steps: [{ id: "x", kind: "keyframe", takes: { n: 5, select: "qc" } }] }).some((e) => e.field === "takes"));
  assert.ok(errorsOf({ steps: [{ id: "x", kind: "keyframe", onFail: { action: "regenerate", max: 3 } }] }).some((e) => e.field === "onFail"), "max 须 1..2");
  assert.ok(errorsOf({ steps: [{ id: "x", kind: "keyframe", onFail: { action: "retry" } }] }).some((e) => e.field === "onFail"));
  assert.ok(errorsOf({ steps: [{ id: "x", kind: "keyframe", refs: [{ artifactId: "bad", role: "style" }] }] }).some((e) => e.field === "refs"));
  assert.ok(errorsOf({ steps: [{ id: "ex", pinned: true }] }).some((e) => e.field === "pinned"), "export 不可 pin");
  assert.ok(errorsOf({ steps: [{ id: "x", kind: "keyframe", intent: "x".repeat(201) }] }).some((e) => e.field === "intent"));
  assert.ok(errorsOf({ steps: [{ id: "x", kind: "keyframe", params: { "a.b": 1 } }] }).some((e) => e.field === "params"));
  assert.ok(errorsOf({ steps: [{ id: "x", kind: "nope" }] }).some((e) => e.field === "kind"));
  assert.ok(errorsOf({ steps: [{ id: "x", kind: "audio" }] }).some((e) => e.field === "kind"), "audio 须明确 voice/music");
});

test("旧字段 gate/tool 在 project 下忽略并回 warning；校验入口拒绝非对象/空 steps", () => {
  const r = mustCompile({ steps: [{ id: "nn", kind: "image", gate: true, tool: "image_generate" }] }, EMPTY);
  assert.equal(r.summary.warnings.length, 2);
  assert.equal(validateProjectDsl(null).ok, false);
  assert.equal(validateProjectDsl({ steps: [] }).ok, false);
  assert.equal(validateProjectDsl({ workflow: "Bad Name", steps: [{ id: "a", kind: "clip" }] }).ok, false);
});

// ─────────────────────────── 旧路径不受影响 + 分派 + 路由输入归一

test("旧 canvas 编译：新 kind 仍被拒（行为不变）；含 v2 字段的旧 DSL 编译成功但回 warning；分派入口 canvas 与直调等价", () => {
  const bad = compileWorkflow({ workflow: "w", steps: [{ id: "a", title: "A", kind: "keyframe" as never }] }, { nodes: [], connections: [] });
  assert.equal(bad.ok, false);
  const withV2 = compileWorkflow({ workflow: "w", steps: [{ id: "a", title: "A", forEach: { over: "x", as: "y" } } as never] }, { nodes: [], connections: [] });
  assert.ok(withV2.ok && withV2.summary.warnings.some((w) => w.includes("target")));
  const src = { workflow: "w", steps: [{ id: "a", title: "A", prompt: "p" }] };
  assert.deepEqual(compileWorkflowForTarget("canvas", src, { nodes: [], connections: [] }), compileWorkflow(src, { nodes: [], connections: [] }));
  const viaDispatch = compileWorkflowForTarget("project", { steps: [{ id: "a", kind: "clip" }] }, EMPTY);
  assert.ok(viaDispatch.ok && (viaDispatch.ops[0] as { op: string }).op === "add_node");
});

test("normalizeProjectCurrent：数组与 {id:node} 对象都收，坏项丢弃；可直接吃夹具 ProjectNode", () => {
  const asRecord = normalizeProjectCurrent(FIXTURES.graphs.base.nodes);
  assert.deepEqual(asRecord.nodes.map((n) => n.id).sort(), ["ex", "k1", "r1", "s1", "sl"]);
  assert.equal(normalizeProjectCurrent([{ id: "a", type: "clip" }, null, { id: "b" }, "x", { type: "clip" }]).nodes.length, 1);
  assert.deepEqual(normalizeProjectCurrent(undefined).nodes, []);
});

test("decompileProject：跳过 forEach 实例与 scratch；空工程返回 null", () => {
  assert.equal(decompileProject(EMPTY), null);
  const state: ProjectCompileInput = { nodes: [{ id: "shots", type: "shotlist" }, { id: "kf", type: "keyframe", forEach: { over: "shots", as: "s" } }, { id: "kf#a", type: "keyframe", derivedFrom: { template: "kf", rowId: "a" } }, { id: "tmp", type: "keyframe", scratch: { expiresAt: "x" } }] };
  assert.deepEqual(decompileProject(state)!.steps.map((s) => s.id), ["shots", "kf"]);
});
