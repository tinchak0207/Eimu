// 导入已定稿剧本 + 参考图 → 可直接开工的画布项目（吸收 AID「导入后就能进制作，先跑一个镜头试风格」）。
//
// 三个承诺：
//   ①剧本被当作制作依据，不是灵感：每镜 `scriptContent` 是**原文保序切片**，拼回去逐行等于输入
//     （`fidelity.verbatim`），台词原样进 `dialogue`——后面生成、配音都以它为准，不重新解释项目；
//   ②短提示词与定稿剧本走不同策略（`classifyScriptInput`）：只有一两句种子 → `seed`（允许 Agent 扩写），
//     有场次／多行／带台词 → `finished`（禁止改写，只许切镜）；
//   ③参考图连到每一镜（连线），生成时自然带上；`sampleNodeId` 指向第一镜＝「先试一镜再决定整集」。
// 纯函式：不碰存储、不发上游、零花费。

import { CanvasNodeType, type CanvasConnection, type CanvasNode, type CanvasProject } from "./types";

export type ScriptPolicy = "finished" | "seed";

export interface ScriptImportReference {
  url: string;
  name?: string;
  role?: "style" | "character" | "composition";
}

export interface ScriptImportInput {
  script: string;
  title?: string;
  references?: ScriptImportReference[];
  newProjectId: string;
  newId?: () => string;
  now?: string;
}

export interface ScriptImportResult {
  project: CanvasProject;
  policy: ScriptPolicy;
  shotCount: number;
  /** 试风格用的第一镜（无分镜时为 null）。 */
  sampleNodeId: string | null;
  fidelity: { sourceLines: number; coveredLines: number; verbatim: boolean };
}

const HEADING = /^(?:场|scene)\s*([\w-]+)?\s*(.*)$/i;
const DIALOGUE = /^([^：:]{1,80})[：:](.+)$/;
const MAX_LINES_PER_SHOT = 3;
const MAX_SHOTS = 120;

export function classifyScriptInput(script: string): ScriptPolicy {
  const lines = script.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const hasScene = lines.some((l) => HEADING.test(l));
  const hasDialogue = lines.some((l) => DIALOGUE.test(l));
  return lines.length >= 4 || hasScene || (lines.length >= 2 && hasDialogue) || script.trim().length > 200 ? "finished" : "seed";
}

interface ShotDraft {
  lines: string[];
}

export function sliceScriptIntoShots(script: string): string[][] {
  const lines = script.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const drafts: ShotDraft[] = [];
  let current: ShotDraft | null = null;
  for (const line of lines) {
    const startsScene = HEADING.test(line);
    if (!current || startsScene || current.lines.length >= MAX_LINES_PER_SHOT) {
      current = { lines: [] };
      drafts.push(current);
    }
    current.lines.push(line);
  }
  return drafts.slice(0, MAX_SHOTS).map((d) => d.lines);
}

export function buildScriptImportProject(input: ScriptImportInput): ScriptImportResult {
  const newId = input.newId ?? (() => crypto.randomUUID());
  const now = input.now ?? new Date().toISOString();
  const script = input.script.trim();
  const policy = classifyScriptInput(script);
  const groups = sliceScriptIntoShots(script);
  const sourceLines = script.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const coveredLines = groups.reduce((n, g) => n + g.length, 0);
  const verbatim = groups.flat().join("\n") === sourceLines.join("\n");

  const episodeId = newId();
  const references = (input.references ?? []).filter((r) => typeof r.url === "string" && /^https:\/\//.test(r.url)).slice(0, 8);

  const refNodes: CanvasNode[] = references.map((ref, index) => ({
    id: newId(),
    type: CanvasNodeType.Reference,
    title: ref.name?.trim() || `参考图 ${index + 1}`,
    position: { x: 0, y: index * 220 },
    width: 200,
    height: 200,
    metadata: { content: ref.url, referenceRole: ref.role ?? "style" },
  }));

  const shotNodes: CanvasNode[] = groups.map((lines, index) => {
    const shotNumber = String(index + 1);
    const dialogue = lines.filter((l) => DIALOGUE.test(l) && !HEADING.test(l)).map((l) => DIALOGUE.exec(l)![2].trim()).join(" ");
    const action = lines.filter((l) => !DIALOGUE.test(l) || HEADING.test(l)).join("；");
    return {
      id: newId(),
      type: CanvasNodeType.Image,
      title: `第 ${shotNumber} 镜`,
      position: { x: 320 + (index % 4) * 260, y: Math.floor(index / 4) * 260 },
      width: 240,
      height: 240,
      metadata: {
        episodeId,
        storyboardShot: {
          shotNumber,
          scriptContent: lines.join("\n"),
          visualDescription: action || lines.join("；"),
          dialogue,
        },
      },
    } as CanvasNode;
  });

  const connections: CanvasConnection[] = [];
  for (const ref of refNodes) for (const shot of shotNodes) connections.push({ id: newId(), fromNodeId: ref.id, toNodeId: shot.id });

  const project: CanvasProject = {
    id: input.newProjectId,
    title: input.title?.trim() || (sourceLines[0] ?? "导入的剧本").slice(0, 30),
    createdAt: now,
    updatedAt: now,
    nodes: [...refNodes, ...shotNodes],
    connections,
    viewport: { x: 0, y: 0, k: 1 },
    backgroundMode: "dots",
    episodes: [{ id: episodeId, episodeNo: 1, title: "第 1 集", status: "draft", script, createdAt: now, updatedAt: now }],
  };

  return {
    project,
    policy,
    shotCount: shotNodes.length,
    sampleNodeId: shotNodes[0]?.id ?? null,
    fidelity: { sourceLines: sourceLines.length, coveredLines, verbatim },
  };
}
