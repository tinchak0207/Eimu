// Expert 宪法／Orchestrator 派遣手册「建置可携性」同步棘轮。
//
// 背景（2026-10-03 Vercel 上传路径 × 建置期档案陷阱）：`deploy-staging/` 同时被
// .vercelignore（95/278 行）与 .gitignore（152 行）排除、且完全未被 git 追踪，
// 所以它**永远上不了 Vercel**。九个读取点原先在**执行期从磁碟**读这两份文本
// （delegate 用 process.cwd()、persona/frame 用 import.meta.url 相对定位）⇒
// Vercel serverless 上档案不存在，beast mode 一被呼叫就结构化硬失败
// （constitution_unavailable / playbook_unavailable）。修法＝把两份文本镜像到
// `src/lib/expert-gateway-assets.json`（会被打包上传），改为静态 import；与
// `src/lib/mcp/expert-delivery-contracts.json` 同款轮子。
//
// 本测试四组：
//   (a) 逐位元组同步：JSON 镜像 vs deploy-staging 原 `.md`（原档缺席时 skip，不红）。
//   (b) 平台独立性（本次缺陷的行为 oracle）：cwd 切到空 tmp 目录后，beast ON 各组装
//       入口用**预设载入器**仍须成功。
//   (c) 空资产仍拒绝裸奔：bundle 空白守卫单元断言 + 各域空载入器结构化拒绝。
//   (d) 接线探针（**变更探针，不计入「已验证」**）：九档不再 fs 读路径常量、bundle 以
//       JSON import 进建置图、路径常量仍在。

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import assets from "./expert-gateway-assets.json";
import {
  EXPERT_CONSTITUTION_TEXT,
  ORCHESTRATOR_DISPATCH_PLAYBOOK_TEXT,
  assertBundledAssetNonEmpty,
  loadBundledExpertConstitution,
  loadBundledOrchestratorPlaybook,
} from "./expert-gateway-assets.ts";
import { buildOrchestratorFrame } from "./orchestrator-beast-frame.ts";
import {
  DIRECTOR_EXPERT_CONSTITUTION_PATH,
  composeDirectorDelegationPrompt,
} from "./blender-director-persona.ts";
import { assembleEditorPrompt, composeEditorDelegation } from "./editor-delegate.ts";
import { assembleMusicDirectorPrompt, composeMusicDelegation } from "./music-delegate.ts";
import { assembleScreenwriterPrompt, composeScreenwriterDelegation } from "./screenwriter-delegate.ts";
import { assembleCriticPrompt, composeCriticDelegation } from "./critic-delegate.ts";
import { assembleVideoDirectorPrompt, composeVideoDelegation } from "./video-delegate.ts";
import { assembleMotionPrompt, composeMotionDelegation } from "./motion-delegate.ts";
import { assembleWeb3dPrompt, composeWeb3dDelegation } from "./web3d-delegate.ts";

const REPO_ROOT = process.cwd();
const ORIG_CONSTITUTION = join(REPO_ROOT, "deploy-staging/expert-gateway/expert-constitution.md");
const ORIG_PLAYBOOK = join(REPO_ROOT, "deploy-staging/expert-gateway/orchestrator-dispatch-playbook.md");

/** deploy-staging/ 是本机专属目录（未进 git）；别人 clone 没有它 → 同步检查须 skip，不得红。 */
const ORIGINAL_ABSENT_MSG =
  "deploy-staging/ 为本机专属目录（未进 git），缺席时跳过同步检查；src 镜像已随 git 上传，不影响建置";

// ── 各域合法委托单（照各 expert-frame.test.ts 的 VALID_INPUT 取最小合法形） ─────────

const EDITOR_INPUT = {
  source_clips: ["canvas-node-01 开场空镜", "canvas-node-02 产品特写"],
  timeline_ops: ["卡点剪切", "去气口"],
  rhythm_notes: "日常口播保留气口",
  mix_notes: "旁白 -16 LUFS",
  duration_hint: 45.6,
  delivery_spec: "1080p H.264 + AAC",
  deliverables: ["timeline_ops", "duration_sec", "qc"],
};
const MUSIC_INPUT = {
  effect_description: "MV 副歌段落主题曲",
  emotion_contract: { style: "cinematic pop ballad" },
  lyrics: "[Verse]\n夜色压低了呼吸",
  deliverables: ["emotion_contract", "lyrics", "melody_notation", "audio_url", "duration_source", "qc"],
};
const SCREENWRITER_INPUT = {
  logline: "末日废土上，少女带着最后的种子穿越沙暴寻找绿洲",
  genre: "科幻剧情",
  tone: "冷峻而温暖",
  characters: ["少女阿禾：沉默寡言的种子守护者"],
  world_refs: ["canvas-node-42"],
  deliverables: ["beats", "shotlist", "qc"],
};
const CRITIC_INPUT = {
  review_target: "审核 OP 主题曲交付物：三段时长数字与歌词字数须可复算",
  scope: "只核数字可复算性与跨档声称一致性",
  checklist: ["时长三处数字同源于同一算式"],
  reference_deliverables: ["canvas-node-42"],
  deliverables: ["verdict", "issues", "evidence", "qc"],
};
const VIDEO_INPUT = {
  subject: "新品上市 15 秒竖屏广告",
  action: "产品从暗场中被一束顶光点亮",
  shots: ["顶光点亮特写", "360 度产品旋转"],
  duration_hint: 15.4,
  resolution: "720p",
  model_hint: "seedance-2.5",
  camera_notes: "浅景深，微距质感",
  deliverables: ["shots", "duration_sec", "model_hint", "qc"],
};
const MOTION_INPUT = {
  motion_spec: "金属徽标从左侧滑入并带回弹",
  keyframes: ["0s：徽标入画前静置", "1.2s：徽标滑入到位"],
  easing_notes: "入场 ease-out-back",
  duration_hint: 5.6,
  deliverable_format: "mp4",
  deliverables: ["motion_spec", "qc"],
};
const WEB3D_INPUT = {
  scene_spec: "产品展台旋转场景",
  interactions: ["拖拽旋转展台"],
  camera_notes: "默认机位正前方 30 度俯角",
  bundle_hint: "资产包 kenney kit",
  deliverables: ["scene_spec", "bundle_ref", "qc"],
};
const BLENDER_INPUT = {
  effect_description: "主角站在悬崖边，风吹披风",
  shot_count: 2,
  deliverables: ["turntable", "blend", "glb"],
};

interface AssemblyResult {
  ok: boolean;
  code?: string;
  hint?: string;
  prompt?: string;
}

type DelegateAssembler = { name: string; invoke: (loadConstitution?: () => string) => AssemblyResult };

/** 七个 delegate 的组装入口（可注入 loadConstitution；不注入＝走预设载入器）。 */
function delegateAssemblers(): DelegateAssembler[] {
  const context = (loadConstitution?: () => string) =>
    loadConstitution ? { beastMode: true as const, loadConstitution } : { beastMode: true as const };
  const out: DelegateAssembler[] = [];

  const editor = composeEditorDelegation(EDITOR_INPUT);
  assert.ok(editor.ok, "editor compose 必须成功");
  if (editor.ok) out.push({ name: "editor", invoke: (l) => assembleEditorPrompt(editor.delegation, context(l)) });

  const music = composeMusicDelegation(MUSIC_INPUT);
  assert.ok(music.ok, "music compose 必须成功");
  if (music.ok) out.push({ name: "music", invoke: (l) => assembleMusicDirectorPrompt(music.delegation, context(l)) });

  const screenwriter = composeScreenwriterDelegation(SCREENWRITER_INPUT);
  assert.ok(screenwriter.ok, "screenwriter compose 必须成功");
  if (screenwriter.ok) {
    out.push({ name: "screenwriter", invoke: (l) => assembleScreenwriterPrompt(screenwriter.delegation, context(l)) });
  }

  const critic = composeCriticDelegation(CRITIC_INPUT);
  assert.ok(critic.ok, "critic compose 必须成功");
  if (critic.ok) out.push({ name: "critic", invoke: (l) => assembleCriticPrompt(critic.delegation, context(l)) });

  const video = composeVideoDelegation(VIDEO_INPUT);
  assert.ok(video.ok, "video compose 必须成功");
  if (video.ok) out.push({ name: "video", invoke: (l) => assembleVideoDirectorPrompt(video.delegation, context(l)) });

  const motion = composeMotionDelegation(MOTION_INPUT);
  assert.ok(motion.ok, "motion compose 必须成功");
  if (motion.ok) out.push({ name: "motion", invoke: (l) => assembleMotionPrompt(motion.delegation, context(l)) });

  const web3d = composeWeb3dDelegation(WEB3D_INPUT);
  assert.ok(web3d.ok, "web3d compose 必须成功");
  if (web3d.ok) out.push({ name: "web3d", invoke: (l) => assembleWeb3dPrompt(web3d.delegation, context(l)) });

  return out;
}

/** 七个 delegate 各跑一次（同一载入器）。 */
function runAllDelegateAssemblies(loadConstitution?: () => string): Array<{ name: string; result: AssemblyResult }> {
  return delegateAssemblers().map(({ name, invoke }) => ({ name, result: invoke(loadConstitution) }));
}

// ── (a) 逐位元组同步棘轮 ────────────────────────────────────────────────────────

test("(a) 同步棘轮：JSON 镜像与 deploy-staging 原档逐位元组相同（原档缺席则 skip）", (t) => {
  if (!existsSync(ORIG_CONSTITUTION) || !existsSync(ORIG_PLAYBOOK)) {
    t.skip(ORIGINAL_ABSENT_MSG);
    return;
  }
  const pairs: Array<[string, string, string]> = [
    ["expert_constitution", EXPERT_CONSTITUTION_TEXT, ORIG_CONSTITUTION],
    ["orchestrator_dispatch_playbook", ORCHESTRATOR_DISPATCH_PLAYBOOK_TEXT, ORIG_PLAYBOOK],
  ];
  for (const [label, text, originalPath] of pairs) {
    const mirror = Buffer.from(text, "utf8");
    const original = readFileSync(originalPath);
    assert.ok(
      mirror.equals(original),
      `${label} 镜像与 deploy-staging 原档不再逐位元组一致（漂移）；请跑 src/lib/expert-gateway-assets.ts 档头的重生成指令。` +
        `mirror=${mirror.length}B original=${original.length}B`,
    );
  }
});

// ── (b) 平台独立性（本次缺陷的行为 oracle） ──────────────────────────────────────

test("(b) 平台独立性：cwd 切到空 tmp 目录，beast ON 各组装入口用预设载入器仍须成功", async () => {
  const before = process.cwd();
  const emptyDir = mkdtempSync(join(tmpdir(), "expert-gateway-empty-cwd-"));
  try {
    process.chdir(emptyDir);

    // Orchestrator 主 prompt 帧（playbook 来自 bundle）。
    const frame = await buildOrchestratorFrame("BASE_PROMPT", { beast_mode: true });
    assert.equal(frame.ok, true, "空 cwd 下 buildOrchestratorFrame 必须成功（playbook 来自 bundle）");
    if (!frame.ok) return;
    assert.equal(frame.injected, true);
    assert.ok(frame.frame.includes("BASE_PROMPT"), "frame 必须含 basePrompt 原文");
    assert.ok(frame.frame.includes("你是 Orchestrator（导演）"), "frame 必须含手册正文（非空资产）");

    // Blender 导演 persona（fs override 未给 ⇒ 走 bundle）。
    const blender = await composeDirectorDelegationPrompt(BLENDER_INPUT, { beast_mode: true });
    assert.equal(blender.ok, true, "空 cwd 下 composeDirectorDelegationPrompt 必须成功（宪法来自 bundle）");

    // 七个 delegate：全部用预设载入器（不注入 loadConstitution）。
    for (const { name, result } of runAllDelegateAssemblies()) {
      assert.equal(result.ok, true, `空 cwd 下 ${name} 用预设载入器必须成功（宪法来自 bundle）`);
    }
  } finally {
    process.chdir(before);
    rmSync(emptyDir, { recursive: true, force: true });
  }
});

// ── (c) 空资产仍拒绝裸奔 ────────────────────────────────────────────────────────

test("(c) bundle 空白守卫：空／全空白 → 抛「bundled 镜像为空」；两份 bundle 非空且含特征句", () => {
  for (const blank of ["", "   ", "\n\t \r\n"]) {
    assert.throws(
      () => assertBundledAssetNonEmpty(blank, "expert_constitution"),
      /bundled 镜像为空/,
      `空白输入 ${JSON.stringify(blank)} 必须抛「bundled 镜像为空」`,
    );
  }
  assert.equal(assertBundledAssetNonEmpty("x", "expert_constitution"), "x");
  assert.ok(EXPERT_CONSTITUTION_TEXT.trim().length > 0, "宪法 bundle 不得为空");
  assert.ok(ORCHESTRATOR_DISPATCH_PLAYBOOK_TEXT.trim().length > 0, "手册 bundle 不得为空");
  assert.ok(loadBundledExpertConstitution().includes("诚实铁律"), "宪法 bundle 必须含特征句");
  assert.ok(loadBundledOrchestratorPlaybook().includes("你是 Orchestrator（导演）"), "手册 bundle 必须含特征句");
});

const CONSTITUTION_PATH_ANCHOR = "deploy-staging/expert-gateway/expert-constitution.md";

// 七个域各一条：注入空字串／全空白 → 既有 constitution_unavailable 诚实拒绝（死因如实写
// 「载入器回传空内容」，不得沿用 ENOENT 误导）；非空白注入仍 ok:true（正控，证明正常路径未被挡）。
for (const { name, invoke } of delegateAssemblers()) {
  test(`(c) ${name} delegate：空／全空白注入 → constitution_unavailable；非空白注入 → ok:true 且宪法进 prompt 头`, () => {
    for (const blank of ["", "   \n  "]) {
      const r = invoke(() => blank);
      assert.equal(r.ok, false, `${name} 空白注入必须拒绝（不得裸奔派遣）`);
      assert.equal(r.code, "constitution_unavailable", `${name} 错误码必须是 constitution_unavailable`);
      assert.ok(
        (r.hint ?? "").includes(CONSTITUTION_PATH_ANCHOR),
        `${name} hint 必须保留 EXPERT_CONSTITUTION_PATH 路径锚`,
      );
      assert.ok((r.hint ?? "").includes("载入器回传空内容"), `${name} hint 死因须如实写空内容`);
      assert.equal((r.hint ?? "").includes("ENOENT"), false, `${name} 空内容不得误导成 ENOENT`);
    }
    const sentinel = "SENTINEL_CONSTITUTION 你是 Expert。";
    const positive = invoke(() => sentinel);
    assert.equal(positive.ok, true, `${name} 非空白注入必须仍成功（正控）`);
    assert.ok((positive.prompt ?? "").startsWith(sentinel), `${name} 宪法原文必须进 prompt 头`);
  });
}

test("(c2) blender：opts.constitutionPath 指向全空白档（fs override 分支）→ constitution_unavailable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "expert-empty-override-"));
  const emptyPath = join(dir, "empty-constitution.md");
  writeFileSync(emptyPath, "   \n\t");
  try {
    const r = await composeDirectorDelegationPrompt(
      BLENDER_INPUT,
      { beast_mode: true },
      { constitutionPath: emptyPath },
    );
    assert.equal(r.ok, false, "空档案 override 必须结构化拒绝");
    if (r.ok) return;
    assert.equal(r.code, "constitution_unavailable");
    assert.ok(r.hint.includes(DIRECTOR_EXPERT_CONSTITUTION_PATH), "hint 必须保留 DIRECTOR_EXPERT_CONSTITUTION_PATH");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── (d) 接线探针（变更探针，不计入「已验证」） ──────────────────────────────────

const DELEGATE_FILES = [
  "src/lib/editor-delegate.ts",
  "src/lib/video-delegate.ts",
  "src/lib/screenwriter-delegate.ts",
  "src/lib/music-delegate.ts",
  "src/lib/critic-delegate.ts",
  "src/lib/motion-delegate.ts",
  "src/lib/web3d-delegate.ts",
];
const FRAME_FILE = "src/lib/orchestrator-beast-frame.ts";
const PERSONA_FILE = "src/lib/blender-director-persona.ts";
const BUNDLE_FILE = "src/lib/expert-gateway-assets.ts";

test("(d) 接线探针：九档不再 fs 读路径常量、bundle 以 JSON import 进建置图、路径常量仍在", () => {
  // 七个 delegate + orchestrator frame：不得再有 readFileSync(...) 执行期读档。
  for (const rel of [...DELEGATE_FILES, FRAME_FILE]) {
    const src = readFileSync(join(REPO_ROOT, rel), "utf8");
    assert.equal(/readFileSync\s*\(/.test(src), false, `${rel} 不得再有 readFileSync(...) 执行期读档`);
    // 亦不得再有对两个路径常量的 readFileSync（精确比对，防未来偷偷加回）。
    assert.equal(
      /readFileSync\s*\([^)]*(EXPERT_CONSTITUTION_PATH|ORCHESTRATOR_DISPATCH_PLAYBOOK_PATH)/s.test(src),
      false,
      `${rel} 不得再 readFileSync 路径常量`,
    );
  }

  // blender：override 分支保留 fs，预设分支走 bundle。
  const blender = readFileSync(join(REPO_ROOT, PERSONA_FILE), "utf8");
  assert.ok(/readFileSync\s*\(/.test(blender), "blender override 分支必须保留 fs 读取");
  assert.ok(blender.includes("opts.constitutionPath"), "blender override 分支必须保留 opts.constitutionPath");
  assert.ok(blender.includes("loadBundledExpertConstitution"), "blender 预设分支必须走 bundle");

  // bundle 模组：静态 JSON import、无 node:fs 执行期读档（档头注释含重生成指令的
  // `fs.readFileSync` 字样，故以「是否 import node:fs」为准，不扫字串）。
  const bundle = readFileSync(join(REPO_ROOT, BUNDLE_FILE), "utf8");
  assert.ok(bundle.includes('from "./expert-gateway-assets.json"'), "bundle 模组必须静态 import JSON 镜像");
  assert.equal(
    /^\s*import\b[^\n]*from\s+"node:fs"/m.test(bundle),
    false,
    "bundle 模组不得 import node:fs（不得执行期读档）",
  );

  // 路径常量仍宣告（声明面／错误讯息／测试的锚）。
  for (const rel of DELEGATE_FILES) {
    assert.ok(
      readFileSync(join(REPO_ROOT, rel), "utf8").includes("EXPERT_CONSTITUTION_PATH ="),
      `${rel} 必须保留 EXPERT_CONSTITUTION_PATH 常量`,
    );
  }
  assert.ok(
    readFileSync(join(REPO_ROOT, FRAME_FILE), "utf8").includes("ORCHESTRATOR_DISPATCH_PLAYBOOK_PATH ="),
    "orchestrator 必须保留 ORCHESTRATOR_DISPATCH_PLAYBOOK_PATH 常量",
  );
  assert.ok(
    readFileSync(join(REPO_ROOT, PERSONA_FILE), "utf8").includes("DIRECTOR_EXPERT_CONSTITUTION_PATH ="),
    "blender 必须保留 DIRECTOR_EXPERT_CONSTITUTION_PATH 常量",
  );

  // 九档皆不得再有指向 deploy-staging 的静态 import。
  for (const rel of [...DELEGATE_FILES, FRAME_FILE, PERSONA_FILE, BUNDLE_FILE]) {
    const offenders = readFileSync(join(REPO_ROOT, rel), "utf8")
      .split("\n")
      .filter((line) => /^\s*import\s.*from\s/.test(line))
      .filter((line) => line.includes("deploy-staging"));
    assert.deepEqual(offenders, [], `${rel} 仍有指向 deploy-staging 的静态 import：${JSON.stringify(offenders)}`);
  }

  // JSON 镜像 ↔ 导出常量一致（bundle 接线）。
  assert.equal(assets.expert_constitution, EXPERT_CONSTITUTION_TEXT);
  assert.equal(assets.orchestrator_dispatch_playbook, ORCHESTRATOR_DISPATCH_PLAYBOOK_TEXT);
});
