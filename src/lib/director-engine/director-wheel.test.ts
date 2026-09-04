// director 輪子移植測試：模板清點（28 運鏡/58 動作/12 姿勢）、playback 純函數、
// planning-core 中文 prompt 推理、describeShot 投影描述、svgSchematic SVG 結構合法性。
// 風格對齊 src/lib/workflow-dsl/workflow-dsl.test.ts（node:test + assert/strict）。
import { test } from "node:test";
import assert from "node:assert/strict";

import type { DirectorActionClip, DirectorElement, DirectorPlan, DirectorSequenceShot, Vec3 } from "./types";
import { CAMERA_TEMPLATES, createCameraKeyframes } from "./cameraTemplates";
import { MOTION_TEMPLATES, createMotionKeyframes } from "./motionTemplates";
import { POSE_PRESETS } from "./poses";
import { evaluateDirectorFrame, inspectDirectorPlan, planDuration, shotAtTime } from "./playback";
import { describeShot } from "./shotDescription";
import { fallbackPlans, inferPromptActions } from "./planning-core";
import { renderTopViewSvg, renderCameraViewSvg } from "./svgSchematic";

// ─────────────────────────── fixtures（雨夜追逐戲：2 mannequin + 1 box + walk/run + 2 shots）

const v = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });

function chaseElements(): DirectorElement[] {
  return [
    {
      id: "mq-man", kind: "mannequin", name: "男人", position: v(-2, 0, 0), rotationDeg: v(0, 0, 0),
      scale: v(1, 1, 1), color: "#cccccc", visible: true, groupId: null,
      poseId: "stand", joints: {}, heightM: 1.8, motionScale: 1,
    },
    {
      id: "mq-target", kind: "mannequin", name: "逃亡者", position: v(2, 0, 6), rotationDeg: v(0, 0, 0),
      scale: v(1, 1, 1), color: "#bbbbbb", visible: true, groupId: null,
      poseId: "stand", joints: {}, heightM: 1.75, motionScale: 1,
    },
    {
      id: "box-crate", kind: "box", name: "木箱", position: v(4, 0, 2), rotationDeg: v(0, 0, 0),
      scale: v(1, 1, 1), color: "#999999", visible: true, groupId: null,
    },
  ];
}

function actionClips(): DirectorActionClip[] {
  const manWalkFrom = v(-2, 0, 0);
  const manWalkTo = v(0, 0, 2);
  const targetRunFrom = v(2, 0, 6);
  const targetRunTo = v(2, 0, 2);
  return [
    {
      id: "act-man-walk", elementId: "mq-man", action: "walk", startSec: 0, durationSec: 2.5,
      from: manWalkFrom, to: manWalkTo, source: "agent",
      keyframes: createMotionKeyframes("walk", 2.5, manWalkFrom, manWalkTo, "agent"),
    },
    {
      id: "act-target-run", elementId: "mq-target", action: "run", startSec: 0.2, durationSec: 2.5,
      from: targetRunFrom, to: targetRunTo, source: "agent",
      keyframes: createMotionKeyframes("run", 2.5, targetRunFrom, targetRunTo, "agent"),
    },
  ];
}

function chaseShot1(): DirectorSequenceShot {
  return {
    id: "shot-chase-1", name: "镜头一·雨巷追出", position: v(0, 1.6, -4), target: v(0, 1, 0),
    fov: 45, shotScale: "medium", aspect: "16:9", createdAt: 1_700_000_000_000,
    startSec: 0, durationSec: 3, cameraMove: "push",
    cameraEnd: { position: v(0, 1.6, -2.4), target: v(0, 1, 0), fov: 40 },
    elementStates: {
      "mq-man": { position: v(-2, 0, 0), rotationDeg: v(0, 0, 0), scale: v(1, 1, 1), visible: true },
      "mq-target": { position: v(2, 0, 6), rotationDeg: v(0, 0, 0), scale: v(1, 1, 1), visible: true },
      "box-crate": { position: v(4, 0, 2), rotationDeg: v(0, 0, 0), scale: v(1, 1, 1), visible: true },
    },
    actions: actionClips(),
  };
}

function chaseShot2(): DirectorSequenceShot {
  return {
    id: "shot-chase-2", name: "镜头二·街角回望", position: v(-3, 1.8, 2), target: v(1, 1, 2),
    fov: 50, shotScale: "medium", aspect: "16:9", createdAt: 1_700_000_000_001,
    startSec: 3, durationSec: 2.5, cameraMove: "orbit",
    cameraEnd: { position: v(-2.2, 1.8, 1.2), target: v(1, 1, 2), fov: 48 },
    elementStates: {
      "mq-man": { position: v(0, 0, 2), rotationDeg: v(0, 0, 0), scale: v(1, 1, 1), visible: true },
      "mq-target": { position: v(2, 0, 2), rotationDeg: v(0, 0, 0), scale: v(1, 1, 1), visible: true },
      "box-crate": { position: v(4, 0, 2), rotationDeg: v(0, 0, 0), scale: v(1, 1, 1), visible: true },
    },
    actions: [
      {
        id: "act-man-run2", elementId: "mq-man", action: "run", startSec: 0, durationSec: 1.8,
        from: v(0, 0, 2), to: v(2, 0, 2), source: "agent",
        keyframes: createMotionKeyframes("run", 1.8, v(0, 0, 2), v(2, 0, 2), "agent"),
      },
      {
        id: "act-target-lookback", elementId: "mq-target", action: "look-back", startSec: 0.3, durationSec: 1.2,
        from: v(2, 0, 2), to: v(2, 0, 2), source: "agent",
      },
    ],
  };
}

function chasePlan(): DirectorPlan {
  return {
    id: "plan-chase", name: "雨夜追逐戲", summary: "雨巷追逐，街角回望", createdAt: 1_700_000_000_000,
    shots: [chaseShot1(), chaseShot2()],
  };
}

// ─────────────────────────── 模板清點

test("CAMERA_TEMPLATES 恰 28 條，逐一 createCameraKeyframes 返回非空關鍵幀", () => {
  assert.equal(CAMERA_TEMPLATES.length, 28);
  const shot = chaseShot1();
  for (const template of CAMERA_TEMPLATES) {
    const frames = createCameraKeyframes(shot, template.id);
    assert.ok(frames.length >= 2, `${template.id} 應產生至少起訖兩幀`);
    for (const frame of frames) {
      assert.ok(Number.isFinite(frame.fov) && Number.isFinite(frame.position.x), `${template.id} 幀數值應有限`);
    }
  }
});

test("MOTION_TEMPLATES 恰 58 條，逐一 createMotionKeyframes 返回非空關鍵幀", () => {
  assert.equal(MOTION_TEMPLATES.length, 58);
  for (const template of MOTION_TEMPLATES) {
    const frames = createMotionKeyframes(template.id, template.defaultDurationSec, v(), v(2, 0, 0));
    assert.ok(frames.length >= 1, `${template.id} 應產生關鍵幀`);
  }
});

test("POSE_PRESETS 恰 12 條", () => {
  assert.equal(POSE_PRESETS.length, 12);
});

// ─────────────────────────── playback 純函數

test("fixture 追逐戲：planDuration>0、shotAtTime 邊界正確", () => {
  const plan = chasePlan();
  assert.equal(planDuration(plan), 5.5);
  assert.equal(shotAtTime(plan, 0).id, "shot-chase-1");
  assert.equal(shotAtTime(plan, 2.999).id, "shot-chase-1");
  assert.equal(shotAtTime(plan, 3).id, "shot-chase-2");
  assert.equal(shotAtTime(plan, 5.499).id, "shot-chase-2");
  assert.equal(shotAtTime(plan, 100).id, "shot-chase-2"); // 超時 clamp 到最後一鏡
  assert.equal(shotAtTime(plan, -1).id, "shot-chase-1"); // 負時間 clamp 到第一鏡
});

test("evaluateDirectorFrame t=0/中/末：camera pose 與元素狀態連續演進", () => {
  const plan = chasePlan();
  const elements = chaseElements();

  const atStart = evaluateDirectorFrame(plan, elements, 0);
  assert.ok(atStart, "t=0 應有幀狀態");
  assert.ok(atStart.camera.position && Number.isFinite(atStart.camera.fov));
  const manStart = atStart.elements.find((e) => e.id === "mq-man");
  assert.ok(manStart && Math.abs(manStart.position.x - -2) < 0.01, "t=0 男人尚在起點 x=-2");

  const atMid = evaluateDirectorFrame(plan, elements, 2.75);
  assert.ok(atMid);
  assert.equal(atMid.shot.id, "shot-chase-1");
  const manMid = atMid.elements.find((e) => e.id === "mq-man");
  assert.ok(manMid && Math.abs(manMid.position.x - 0) < 0.01, "t=2.75 男人已走到 x=0");

  const atEnd = evaluateDirectorFrame(plan, elements, 5.49);
  assert.ok(atEnd);
  assert.equal(atEnd.shot.id, "shot-chase-2");
  const manEnd = atEnd.elements.find((e) => e.id === "mq-man");
  assert.ok(manEnd && Math.abs(manEnd.position.x - 2) < 0.01, "t=5.49 男人已跑到 x=2");
  const poseId = manEnd.kind === "mannequin" ? manEnd.poseId : "";
  assert.equal(poseId, "run", "跑步動作姿勢應為 run");
});

test("inspectDirectorPlan 對缺陷 plan（入地/動作跳變/攝影機入地）至少報 1 項 issue", () => {
  const base = chaseShot1();
  const defective: DirectorPlan = {
    id: "plan-bad", name: "缺陷方案", summary: "故意埋雷", createdAt: 1,
    shots: [
      {
        ...base,
        id: "shot-bad", position: v(0, 0.02, -4), cameraEnd: { ...base.cameraEnd, position: v(0, 1.6, -2.4) },
        actions: [
          {
            id: "act-bad-1", elementId: "mq-man", action: "walk", startSec: 0, durationSec: 1,
            from: v(-2, 0, 0), to: v(0, 0, 0), source: "agent",
          },
          {
            id: "act-bad-2", elementId: "mq-man", action: "walk", startSec: 1.2, durationSec: 1,
            from: v(-1, -0.5, 5), to: v(-1, -0.5, 5), source: "agent",
          },
        ],
      },
    ],
  };
  const issues = inspectDirectorPlan(defective, chaseElements());
  assert.ok(issues.length >= 1, "缺陷方案應報至少 1 項 issue");
  const codes = issues.map((i) => i.id);
  assert.ok(
    codes.some((id) => id.includes("underground") || id.includes("-ground") || id.includes("-jump")),
    `應含入地/跳變類 issue，實得：${codes.join(", ")}`,
  );
});

// ─────────────────────────── planning-core 純核

test("fallbackPlans 對中文 prompt（雨夜追逐戲原文）產出 3 個非空方案", () => {
  const plans = fallbackPlans(chasePlan(), chaseElements(), "男人走過街角回頭開槍");
  assert.equal(plans.length, 3);
  for (const plan of plans) {
    assert.ok(plan.shots.length > 0, `${plan.name} 應有鏡頭`);
    assert.ok(planDuration(plan) > 0, `${plan.name} 應有正時長`);
  }
});

test("inferPromptActions 對中文動作 prompt 產出非空動作推斷", () => {
  // 輪子 ACTION_KEYWORDS 詞表為簡體；繁體「走過/回頭」不在詞表，以簡體同義 prompt 驅動
  const actions = inferPromptActions("男人走向街角回头开枪", chaseElements());
  assert.ok(actions.length >= 1, "應推斷出至少一個動作");
  assert.ok(actions.every((a) => a.elementName && a.action));
});

test("inferPromptActions 對繁體動作 prompt 產出非空動作推斷（2026-09-03 繁體變體白名單）", () => {
  // ACTION_KEYWORDS 已補繁體變體：「回頭」命中 look-back；走過/開槍不在簡體原表（白名單禁新詞）
  const actions = inferPromptActions("男人走過街角回頭開槍", chaseElements());
  assert.ok(actions.length >= 1, "繁體 prompt 應推斷出至少一個動作");
  assert.ok(actions.every((a) => a.elementName && a.action));
});

// ─────────────────────────── describeShot

test("describeShot 返回非空機位描述", () => {
  const elements = chaseElements();
  const snapshots = elements.map((e) => ({
    id: e.id, name: e.name, kind: e.kind, worldPos: e.position,
    forwardDir: v(0, 0, 1), visible: e.visible,
  }));
  const text = describeShot(chaseShot1(), snapshots);
  assert.equal(typeof text, "string");
  assert.ok(text.length > 0);
  assert.ok(text.includes("镜头一·雨巷追出"), `描述應含鏡頭名，實得：${text.split("\n")[0]}`);
});

// ─────────────────────────── svgSchematic（新膠水）

/** 簡易 XML 檢查：標籤配對閉合 + 自閉合標籤合法。 */
function xmlTagBalanceOk(svg: string): boolean {
  const stack: string[] = [];
  const re = /<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^"'>])*)>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(svg)) !== null) {
    const [, closing, name, attrs] = match;
    if (closing) {
      if (stack.pop() !== name) return false;
    } else if (!attrs.trimEnd().endsWith("/")) {
      stack.push(name);
    }
  }
  return stack.length === 0;
}

const SVG_BYTE_LIMIT = 32 * 1024;

function assertValidSvg(svg: string, label: string) {
  assert.ok(svg.startsWith("<svg") && svg.endsWith("</svg>"), `${label} 應為完整 <svg> 文檔`);
  assert.ok(Buffer.byteLength(svg, "utf8") <= SVG_BYTE_LIMIT, `${label} 應 ≤32KB`);
  assert.ok(xmlTagBalanceOk(svg), `${label} 標籤應配對閉合`);
}

test("renderTopViewSvg：含 <svg>、≤32KB、XML 結構合法", () => {
  const plan = chasePlan();
  const svg = renderTopViewSvg(plan, chaseElements(), plan.shots[0]);
  assertValidSvg(svg, "topView");
  assert.ok(svg.includes(plan.name), "俯視圖應含方案名標注");
  assert.ok(svg.includes("镜头一·雨巷追出"), "俯視圖應含活動鏡頭名");
});

test("renderCameraViewSvg：含 <svg>、≤32KB、XML 結構合法", () => {
  const plan = chasePlan();
  const svg = renderCameraViewSvg(plan.shots[0], chaseElements());
  assertValidSvg(svg, "cameraView");
  assert.ok(svg.includes("木箱") || svg.includes("男人") || svg.includes("逃亡者"), "鏡頭框圖應含元素標注");
});

test("renderTopViewSvg 無活動鏡頭時仍可渲染（全鏡頭起點）", () => {
  const plan = chasePlan();
  const svg = renderTopViewSvg(plan, chaseElements());
  assertValidSvg(svg, "topView-allShots");
});
