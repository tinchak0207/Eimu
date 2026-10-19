// director 轮子移植测试：模板清点（28 运镜/58 动作/12 姿势）、playback 纯函数、
// planning-core 中文 prompt 推理、describeShot 投影描述、svgSchematic SVG 结构合法性。
// 风格对齐 src/lib/workflow-dsl/workflow-dsl.test.ts（node:test + assert/strict）。
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

// ─────────────────────────── fixtures（雨夜追逐戏：2 mannequin + 1 box + walk/run + 2 shots）

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
    id: "plan-chase", name: "雨夜追逐戏", summary: "雨巷追逐，街角回望", createdAt: 1_700_000_000_000,
    shots: [chaseShot1(), chaseShot2()],
  };
}

// ─────────────────────────── 模板清点

test("CAMERA_TEMPLATES 恰 28 条，逐一 createCameraKeyframes 返回非空关键帧", () => {
  assert.equal(CAMERA_TEMPLATES.length, 28);
  const shot = chaseShot1();
  for (const template of CAMERA_TEMPLATES) {
    const frames = createCameraKeyframes(shot, template.id);
    assert.ok(frames.length >= 2, `${template.id} 应产生至少起讫两帧`);
    for (const frame of frames) {
      assert.ok(Number.isFinite(frame.fov) && Number.isFinite(frame.position.x), `${template.id} 帧数值应有限`);
    }
  }
});

test("MOTION_TEMPLATES 恰 58 条，逐一 createMotionKeyframes 返回非空关键帧", () => {
  assert.equal(MOTION_TEMPLATES.length, 58);
  for (const template of MOTION_TEMPLATES) {
    const frames = createMotionKeyframes(template.id, template.defaultDurationSec, v(), v(2, 0, 0));
    assert.ok(frames.length >= 1, `${template.id} 应产生关键帧`);
  }
});

test("POSE_PRESETS 恰 12 条", () => {
  assert.equal(POSE_PRESETS.length, 12);
});

// ─────────────────────────── playback 纯函数

test("fixture 追逐戏：planDuration>0、shotAtTime 边界正确", () => {
  const plan = chasePlan();
  assert.equal(planDuration(plan), 5.5);
  assert.equal(shotAtTime(plan, 0).id, "shot-chase-1");
  assert.equal(shotAtTime(plan, 2.999).id, "shot-chase-1");
  assert.equal(shotAtTime(plan, 3).id, "shot-chase-2");
  assert.equal(shotAtTime(plan, 5.499).id, "shot-chase-2");
  assert.equal(shotAtTime(plan, 100).id, "shot-chase-2"); // 超时 clamp 到最后一镜
  assert.equal(shotAtTime(plan, -1).id, "shot-chase-1"); // 负时间 clamp 到第一镜
});

test("evaluateDirectorFrame t=0/中/末：camera pose 与元素状态连续演进", () => {
  const plan = chasePlan();
  const elements = chaseElements();

  const atStart = evaluateDirectorFrame(plan, elements, 0);
  assert.ok(atStart, "t=0 应有帧状态");
  assert.ok(atStart.camera.position && Number.isFinite(atStart.camera.fov));
  const manStart = atStart.elements.find((e) => e.id === "mq-man");
  assert.ok(manStart && Math.abs(manStart.position.x - -2) < 0.01, "t=0 男人尚在起点 x=-2");

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
  assert.equal(poseId, "run", "跑步动作姿势应为 run");
});

test("inspectDirectorPlan 对缺陷 plan（入地/动作跳变/摄影机入地）至少报 1 项 issue", () => {
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
  assert.ok(issues.length >= 1, "缺陷方案应报至少 1 项 issue");
  const codes = issues.map((i) => i.id);
  assert.ok(
    codes.some((id) => id.includes("underground") || id.includes("-ground") || id.includes("-jump")),
    `应含入地/跳变类 issue，实得：${codes.join(", ")}`,
  );
});

// ─────────────────────────── planning-core 纯核

test("fallbackPlans 对中文 prompt（雨夜追逐戏原文）产出 3 个非空方案", () => {
  const plans = fallbackPlans(chasePlan(), chaseElements(), "男人走过街角回头开枪");
  assert.equal(plans.length, 3);
  for (const plan of plans) {
    assert.ok(plan.shots.length > 0, `${plan.name} 应有镜头`);
    assert.ok(planDuration(plan) > 0, `${plan.name} 应有正时长`);
  }
});

test("inferPromptActions 对中文动作 prompt 产出非空动作推断", () => {
  // 轮子 ACTION_KEYWORDS 词表为简体；繁体「走过/回头」不在词表，以简体同义 prompt 驱动
  const actions = inferPromptActions("男人走向街角回头开枪", chaseElements());
  assert.ok(actions.length >= 1, "应推断出至少一个动作");
  assert.ok(actions.every((a) => a.elementName && a.action));
});

test("inferPromptActions 对繁体动作 prompt 产出非空动作推断（2026-09-03 繁体变体白名单）", () => {
  // ACTION_KEYWORDS 已补繁体变体：「回头」命中 look-back；走过/开枪不在简体原表（白名单禁新词）
  const actions = inferPromptActions("男人走过街角回头开枪", chaseElements());
  assert.ok(actions.length >= 1, "繁体 prompt 应推断出至少一个动作");
  assert.ok(actions.every((a) => a.elementName && a.action));
});

// ─────────────────────────── describeShot

test("describeShot 返回非空机位描述", () => {
  const elements = chaseElements();
  const snapshots = elements.map((e) => ({
    id: e.id, name: e.name, kind: e.kind, worldPos: e.position,
    forwardDir: v(0, 0, 1), visible: e.visible,
  }));
  const text = describeShot(chaseShot1(), snapshots);
  assert.equal(typeof text, "string");
  assert.ok(text.length > 0);
  assert.ok(text.includes("镜头一·雨巷追出"), `描述应含镜头名，实得：${text.split("\n")[0]}`);
});

// ─────────────────────────── svgSchematic（新胶水）

/** 简易 XML 检查：标签配对闭合 + 自闭合标签合法。 */
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
  assert.ok(svg.startsWith("<svg") && svg.endsWith("</svg>"), `${label} 应为完整 <svg> 文档`);
  assert.ok(Buffer.byteLength(svg, "utf8") <= SVG_BYTE_LIMIT, `${label} 应 ≤32KB`);
  assert.ok(xmlTagBalanceOk(svg), `${label} 标签应配对闭合`);
}

test("renderTopViewSvg：含 <svg>、≤32KB、XML 结构合法", () => {
  const plan = chasePlan();
  const svg = renderTopViewSvg(plan, chaseElements(), plan.shots[0]);
  assertValidSvg(svg, "topView");
  assert.ok(svg.includes(plan.name), "俯视图应含方案名标注");
  assert.ok(svg.includes("镜头一·雨巷追出"), "俯视图应含活动镜头名");
});

test("renderCameraViewSvg：含 <svg>、≤32KB、XML 结构合法", () => {
  const plan = chasePlan();
  const svg = renderCameraViewSvg(plan.shots[0], chaseElements());
  assertValidSvg(svg, "cameraView");
  assert.ok(svg.includes("木箱") || svg.includes("男人") || svg.includes("逃亡者"), "镜头框图应含元素标注");
});

test("renderTopViewSvg 无活动镜头时仍可渲染（全镜头起点）", () => {
  const plan = chasePlan();
  const svg = renderTopViewSvg(plan, chaseElements());
  assertValidSvg(svg, "topView-allShots");
});
