// Expert 憲法／Orchestrator 派遣手冊「建置可攜性」同步棘輪。
//
// 背景（2026-10-03 Vercel 上傳路徑 × 建置期檔案陷阱）：`deploy-staging/` 同時被
// .vercelignore（95/278 行）與 .gitignore（152 行）排除、且完全未被 git 追蹤，
// 所以它**永遠上不了 Vercel**。九個讀取點原先在**執行期從磁碟**讀這兩份文本
// （delegate 用 process.cwd()、persona/frame 用 import.meta.url 相對定位）⇒
// Vercel serverless 上檔案不存在，beast mode 一被呼叫就結構化硬失敗
// （constitution_unavailable / playbook_unavailable）。修法＝把兩份文本鏡像到
// `src/lib/expert-gateway-assets.json`（會被打包上傳），改為靜態 import；與
// `src/lib/mcp/expert-delivery-contracts.json` 同款輪子。
//
// 本測試四組：
//   (a) 逐位元組同步：JSON 鏡像 vs deploy-staging 原 `.md`（原檔缺席時 skip，不紅）。
//   (b) 平台獨立性（本次缺陷的行為 oracle）：cwd 切到空 tmp 目錄後，beast ON 各組裝
//       入口用**預設載入器**仍須成功。
//   (c) 空資產仍拒絕裸奔：bundle 空白守衛單元斷言 + 各域空載入器結構化拒絕。
//   (d) 接線探針（**變更探針，不計入「已驗證」**）：九檔不再 fs 讀路徑常量、bundle 以
//       JSON import 進建置圖、路徑常量仍在。

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

/** deploy-staging/ 是本機專屬目錄（未進 git）；別人 clone 沒有它 → 同步檢查須 skip，不得紅。 */
const ORIGINAL_ABSENT_MSG =
  "deploy-staging/ 為本機專屬目錄（未進 git），缺席時跳過同步檢查；src 鏡像已隨 git 上傳，不影響建置";

// ── 各域合法委託單（照各 expert-frame.test.ts 的 VALID_INPUT 取最小合法形） ─────────

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
  effect_description: "主角站在懸崖邊，風吹披風",
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

/** 七個 delegate 的組裝入口（可注入 loadConstitution；不注入＝走預設載入器）。 */
function delegateAssemblers(): DelegateAssembler[] {
  const context = (loadConstitution?: () => string) =>
    loadConstitution ? { beastMode: true as const, loadConstitution } : { beastMode: true as const };
  const out: DelegateAssembler[] = [];

  const editor = composeEditorDelegation(EDITOR_INPUT);
  assert.ok(editor.ok, "editor compose 必須成功");
  if (editor.ok) out.push({ name: "editor", invoke: (l) => assembleEditorPrompt(editor.delegation, context(l)) });

  const music = composeMusicDelegation(MUSIC_INPUT);
  assert.ok(music.ok, "music compose 必須成功");
  if (music.ok) out.push({ name: "music", invoke: (l) => assembleMusicDirectorPrompt(music.delegation, context(l)) });

  const screenwriter = composeScreenwriterDelegation(SCREENWRITER_INPUT);
  assert.ok(screenwriter.ok, "screenwriter compose 必須成功");
  if (screenwriter.ok) {
    out.push({ name: "screenwriter", invoke: (l) => assembleScreenwriterPrompt(screenwriter.delegation, context(l)) });
  }

  const critic = composeCriticDelegation(CRITIC_INPUT);
  assert.ok(critic.ok, "critic compose 必須成功");
  if (critic.ok) out.push({ name: "critic", invoke: (l) => assembleCriticPrompt(critic.delegation, context(l)) });

  const video = composeVideoDelegation(VIDEO_INPUT);
  assert.ok(video.ok, "video compose 必須成功");
  if (video.ok) out.push({ name: "video", invoke: (l) => assembleVideoDirectorPrompt(video.delegation, context(l)) });

  const motion = composeMotionDelegation(MOTION_INPUT);
  assert.ok(motion.ok, "motion compose 必須成功");
  if (motion.ok) out.push({ name: "motion", invoke: (l) => assembleMotionPrompt(motion.delegation, context(l)) });

  const web3d = composeWeb3dDelegation(WEB3D_INPUT);
  assert.ok(web3d.ok, "web3d compose 必須成功");
  if (web3d.ok) out.push({ name: "web3d", invoke: (l) => assembleWeb3dPrompt(web3d.delegation, context(l)) });

  return out;
}

/** 七個 delegate 各跑一次（同一載入器）。 */
function runAllDelegateAssemblies(loadConstitution?: () => string): Array<{ name: string; result: AssemblyResult }> {
  return delegateAssemblers().map(({ name, invoke }) => ({ name, result: invoke(loadConstitution) }));
}

// ── (a) 逐位元組同步棘輪 ────────────────────────────────────────────────────────

test("(a) 同步棘輪：JSON 鏡像與 deploy-staging 原檔逐位元組相同（原檔缺席則 skip）", (t) => {
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
      `${label} 鏡像與 deploy-staging 原檔不再逐位元組一致（漂移）；請跑 src/lib/expert-gateway-assets.ts 檔頭的重生成指令。` +
        `mirror=${mirror.length}B original=${original.length}B`,
    );
  }
});

// ── (b) 平台獨立性（本次缺陷的行為 oracle） ──────────────────────────────────────

test("(b) 平台獨立性：cwd 切到空 tmp 目錄，beast ON 各組裝入口用預設載入器仍須成功", async () => {
  const before = process.cwd();
  const emptyDir = mkdtempSync(join(tmpdir(), "expert-gateway-empty-cwd-"));
  try {
    process.chdir(emptyDir);

    // Orchestrator 主 prompt 幀（playbook 來自 bundle）。
    const frame = await buildOrchestratorFrame("BASE_PROMPT", { beast_mode: true });
    assert.equal(frame.ok, true, "空 cwd 下 buildOrchestratorFrame 必須成功（playbook 來自 bundle）");
    if (!frame.ok) return;
    assert.equal(frame.injected, true);
    assert.ok(frame.frame.includes("BASE_PROMPT"), "frame 必須含 basePrompt 原文");
    assert.ok(frame.frame.includes("你是 Orchestrator（導演）"), "frame 必須含手冊正文（非空資產）");

    // Blender 導演 persona（fs override 未給 ⇒ 走 bundle）。
    const blender = await composeDirectorDelegationPrompt(BLENDER_INPUT, { beast_mode: true });
    assert.equal(blender.ok, true, "空 cwd 下 composeDirectorDelegationPrompt 必須成功（憲法來自 bundle）");

    // 七個 delegate：全部用預設載入器（不注入 loadConstitution）。
    for (const { name, result } of runAllDelegateAssemblies()) {
      assert.equal(result.ok, true, `空 cwd 下 ${name} 用預設載入器必須成功（憲法來自 bundle）`);
    }
  } finally {
    process.chdir(before);
    rmSync(emptyDir, { recursive: true, force: true });
  }
});

// ── (c) 空資產仍拒絕裸奔 ────────────────────────────────────────────────────────

test("(c) bundle 空白守衛：空／全空白 → 拋「bundled 鏡像為空」；兩份 bundle 非空且含特徵句", () => {
  for (const blank of ["", "   ", "\n\t \r\n"]) {
    assert.throws(
      () => assertBundledAssetNonEmpty(blank, "expert_constitution"),
      /bundled 鏡像為空/,
      `空白輸入 ${JSON.stringify(blank)} 必須拋「bundled 鏡像為空」`,
    );
  }
  assert.equal(assertBundledAssetNonEmpty("x", "expert_constitution"), "x");
  assert.ok(EXPERT_CONSTITUTION_TEXT.trim().length > 0, "憲法 bundle 不得為空");
  assert.ok(ORCHESTRATOR_DISPATCH_PLAYBOOK_TEXT.trim().length > 0, "手冊 bundle 不得為空");
  assert.ok(loadBundledExpertConstitution().includes("誠實鐵律"), "憲法 bundle 必須含特徵句");
  assert.ok(loadBundledOrchestratorPlaybook().includes("你是 Orchestrator（導演）"), "手冊 bundle 必須含特徵句");
});

const CONSTITUTION_PATH_ANCHOR = "deploy-staging/expert-gateway/expert-constitution.md";

// 七個域各一條：注入空字串／全空白 → 既有 constitution_unavailable 誠實拒絕（死因如實寫
// 「载入器回傳空內容」，不得沿用 ENOENT 誤導）；非空白注入仍 ok:true（正控，證明正常路徑未被擋）。
for (const { name, invoke } of delegateAssemblers()) {
  test(`(c) ${name} delegate：空／全空白注入 → constitution_unavailable；非空白注入 → ok:true 且憲法進 prompt 頭`, () => {
    for (const blank of ["", "   \n  "]) {
      const r = invoke(() => blank);
      assert.equal(r.ok, false, `${name} 空白注入必須拒絕（不得裸奔派遣）`);
      assert.equal(r.code, "constitution_unavailable", `${name} 錯誤碼必須是 constitution_unavailable`);
      assert.ok(
        (r.hint ?? "").includes(CONSTITUTION_PATH_ANCHOR),
        `${name} hint 必須保留 EXPERT_CONSTITUTION_PATH 路徑錨`,
      );
      assert.ok((r.hint ?? "").includes("载入器回傳空內容"), `${name} hint 死因須如實寫空內容`);
      assert.equal((r.hint ?? "").includes("ENOENT"), false, `${name} 空內容不得誤導成 ENOENT`);
    }
    const sentinel = "SENTINEL_CONSTITUTION 你是 Expert。";
    const positive = invoke(() => sentinel);
    assert.equal(positive.ok, true, `${name} 非空白注入必須仍成功（正控）`);
    assert.ok((positive.prompt ?? "").startsWith(sentinel), `${name} 憲法原文必須進 prompt 頭`);
  });
}

test("(c2) blender：opts.constitutionPath 指向全空白檔（fs override 分支）→ constitution_unavailable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "expert-empty-override-"));
  const emptyPath = join(dir, "empty-constitution.md");
  writeFileSync(emptyPath, "   \n\t");
  try {
    const r = await composeDirectorDelegationPrompt(
      BLENDER_INPUT,
      { beast_mode: true },
      { constitutionPath: emptyPath },
    );
    assert.equal(r.ok, false, "空檔案 override 必須結構化拒絕");
    if (r.ok) return;
    assert.equal(r.code, "constitution_unavailable");
    assert.ok(r.hint.includes(DIRECTOR_EXPERT_CONSTITUTION_PATH), "hint 必須保留 DIRECTOR_EXPERT_CONSTITUTION_PATH");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── (d) 接線探針（變更探針，不計入「已驗證」） ──────────────────────────────────

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

test("(d) 接線探針：九檔不再 fs 讀路徑常量、bundle 以 JSON import 進建置圖、路徑常量仍在", () => {
  // 七個 delegate + orchestrator frame：不得再有 readFileSync(...) 執行期讀檔。
  for (const rel of [...DELEGATE_FILES, FRAME_FILE]) {
    const src = readFileSync(join(REPO_ROOT, rel), "utf8");
    assert.equal(/readFileSync\s*\(/.test(src), false, `${rel} 不得再有 readFileSync(...) 執行期讀檔`);
    // 亦不得再有對兩個路徑常量的 readFileSync（精確比對，防未來偷偷加回）。
    assert.equal(
      /readFileSync\s*\([^)]*(EXPERT_CONSTITUTION_PATH|ORCHESTRATOR_DISPATCH_PLAYBOOK_PATH)/s.test(src),
      false,
      `${rel} 不得再 readFileSync 路徑常量`,
    );
  }

  // blender：override 分支保留 fs，預設分支走 bundle。
  const blender = readFileSync(join(REPO_ROOT, PERSONA_FILE), "utf8");
  assert.ok(/readFileSync\s*\(/.test(blender), "blender override 分支必須保留 fs 讀取");
  assert.ok(blender.includes("opts.constitutionPath"), "blender override 分支必須保留 opts.constitutionPath");
  assert.ok(blender.includes("loadBundledExpertConstitution"), "blender 預設分支必須走 bundle");

  // bundle 模組：靜態 JSON import、無 node:fs 執行期讀檔（檔頭註釋含重生成指令的
  // `fs.readFileSync` 字樣，故以「是否 import node:fs」為準，不掃字串）。
  const bundle = readFileSync(join(REPO_ROOT, BUNDLE_FILE), "utf8");
  assert.ok(bundle.includes('from "./expert-gateway-assets.json"'), "bundle 模組必須靜態 import JSON 鏡像");
  assert.equal(
    /^\s*import\b[^\n]*from\s+"node:fs"/m.test(bundle),
    false,
    "bundle 模組不得 import node:fs（不得執行期讀檔）",
  );

  // 路徑常量仍宣告（聲明面／錯誤訊息／測試的錨）。
  for (const rel of DELEGATE_FILES) {
    assert.ok(
      readFileSync(join(REPO_ROOT, rel), "utf8").includes("EXPERT_CONSTITUTION_PATH ="),
      `${rel} 必須保留 EXPERT_CONSTITUTION_PATH 常量`,
    );
  }
  assert.ok(
    readFileSync(join(REPO_ROOT, FRAME_FILE), "utf8").includes("ORCHESTRATOR_DISPATCH_PLAYBOOK_PATH ="),
    "orchestrator 必須保留 ORCHESTRATOR_DISPATCH_PLAYBOOK_PATH 常量",
  );
  assert.ok(
    readFileSync(join(REPO_ROOT, PERSONA_FILE), "utf8").includes("DIRECTOR_EXPERT_CONSTITUTION_PATH ="),
    "blender 必須保留 DIRECTOR_EXPERT_CONSTITUTION_PATH 常量",
  );

  // 九檔皆不得再有指向 deploy-staging 的靜態 import。
  for (const rel of [...DELEGATE_FILES, FRAME_FILE, PERSONA_FILE, BUNDLE_FILE]) {
    const offenders = readFileSync(join(REPO_ROOT, rel), "utf8")
      .split("\n")
      .filter((line) => /^\s*import\s.*from\s/.test(line))
      .filter((line) => line.includes("deploy-staging"));
    assert.deepEqual(offenders, [], `${rel} 仍有指向 deploy-staging 的靜態 import：${JSON.stringify(offenders)}`);
  }

  // JSON 鏡像 ↔ 導出常量一致（bundle 接線）。
  assert.equal(assets.expert_constitution, EXPERT_CONSTITUTION_TEXT);
  assert.equal(assets.orchestrator_dispatch_playbook, ORCHESTRATOR_DISPATCH_PLAYBOOK_TEXT);
});
