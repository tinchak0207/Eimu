// 画布工作流模板库（Workflow Templates）
//
// 暴君策略 v2：Deepseek 只当「参数/提示词传达人」，节点流结构骨架由后端模板提供。
// 模板定义「编排好的流程」：Deepseek 填内容（prompt/model/size 等），
// 引擎（workflow-engine.ts）把模板展开成 CanvasNode[] + 连线并执行。
//
// 本目录 = 纯资料 + 纯函式（不依赖 Bun），可单独单测。
// 每个模板一个文件（<template-id>.ts），改一个模板只动一个档，
// 部署与并行修改不再互相冲突。
//
// 注意：部署机制为逐档 SFTP（.gateway-work/sftp-put-443.js），目录结构
// 必须手动在 VPS 上建立 remote-dir 并逐档上传；旧单档 workflow-templates.ts
// 必须删除或重命名，否则会因 extensionless 解析优先命中旧档而掩蔽新目录。

import type { WorkflowNodeSpec, WorkflowConnectionSpec, WorkflowTemplate } from "./types";
import { singleImageTemplate } from "./single_image";
import { characterSheetTemplate } from "./character_sheet";
import { sceneSetupTemplate } from "./scene_setup";
import { singleVideoTemplate } from "./single_video";
import { featureFilmTemplate } from "./feature_film";
import { novelFilmTemplate } from "./novel_film";
import { novelIpTemplate } from "./novel_ip";
import { ecomLaunchTemplate } from "./ecom_launch";
import { ecomModelTemplate } from "./ecom_model";
import { shortdramaVisualTemplate } from "./shortdrama_visual";
import { shortdramaPosterTemplate } from "./shortdrama_poster";
import { artCurationTemplate } from "./art_curation";
import { artStyleTemplate } from "./art_style";

export type { WorkflowNodeSpec, WorkflowConnectionSpec, WorkflowTemplate } from "./types";

export {
  singleImageTemplate,
  characterSheetTemplate,
  sceneSetupTemplate,
  singleVideoTemplate,
  featureFilmTemplate,
  novelFilmTemplate,
  novelIpTemplate,
  ecomLaunchTemplate,
  ecomModelTemplate,
  shortdramaVisualTemplate,
  shortdramaPosterTemplate,
  artCurationTemplate,
  artStyleTemplate,
};

/** 十五个工作流模板（顺序即部署顺序；新增模板在此加一行）。 */
export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  singleImageTemplate,
  characterSheetTemplate,
  sceneSetupTemplate,
  singleVideoTemplate,
  featureFilmTemplate,
  novelFilmTemplate,
  novelIpTemplate,
  ecomLaunchTemplate,
  ecomModelTemplate,
  shortdramaVisualTemplate,
  shortdramaPosterTemplate,
  artCurationTemplate,
  artStyleTemplate,
];

/** 按 id 取模板（undefined 表示不存在）。 */
export function getWorkflowTemplate(id: string): WorkflowTemplate | undefined {
  return WORKFLOW_TEMPLATES.find((t) => t.id === id)
}

/**
 * 0920 暴君裁定（第二版）：模板判定完成即建骨架弹上画布——不等 Expert 去调
 * workflow_start（实锤：Expert 根本没调，右边永远空白，「太慢了」）。
 *
 * 后端 startSync 要求每个 text role 非空，故建构时用「占位内容」先满足验证；
 * Expert 之后同模板呼叫 workflow_start 走 P0 幂等守卫复用同一支 wf，再用
 * workflow_update_node 回填真内容。config/image/video/audio/film role 无需 content。
 */
export function templatePlaceholderContent(templateId: string): Record<string, unknown> {
  const t = getWorkflowTemplate(templateId)
  if (!t) return {}
  const content: Record<string, unknown> = {}
  for (const n of t.nodes) {
    // 契约形状：{ role: { content: "..." } }（startSync 逐 role 读 c.content）；
    // 传纯字串会被判「缺少必要内容」而 400（实锤 2026-09-20）。
    if (n.kind === "text") content[n.role] = { content: `（待填：${n.title}）` }
  }
  return content
}

/** 模板清单（id/name/description/multiShot），用于注册与发现。 */

/**
 * R2-G1（2026-10-10）：策划／禁生成瘦身——只留 text 主节点与其间连线；
 * 剥离 image／video／audio／film／config 生成位，并去掉生成类工具卡
 * （避免骨架上冒出标题为 image_generate 的配方鬼影）。multiShot 关闭，
 * 防止镜头链克隆出 gen／video。加法：原模板物件不改写。
 */
const GENERATION_TOOL_ID_RE =
  /^(?:image_generate|video_generate|audio_generate|music_|tts_|voice_|dreamina|seedance|runway|luma|fal_|pixai)|(?:^|_)(?:i2v|t2v|t2i)(?:_|$)|generate$/i

export function isGenerationToolId(toolId: string): boolean {
  const id = (toolId ?? "").trim()
  if (!id) return false
  if (/^canvas_/.test(id)) return false
  if (/^document_/.test(id)) return false
  if (/^workflow_/.test(id)) return false
  if (/^read$|^bash$|^glob$|^grep$/i.test(id)) return false
  return GENERATION_TOOL_ID_RE.test(id) || /_generate$/.test(id) || id === "image_generate"
}

export function leanTemplateForPlanOnly(template: WorkflowTemplate): WorkflowTemplate {
  const textNodes: WorkflowNodeSpec[] = template.nodes
    .filter((n) => n.kind === "text")
    .map((n) => {
      const tools = (n.tools ?? []).filter((t) => !isGenerationToolId(t.id))
      const next: WorkflowNodeSpec = { ...n }
      if (tools.length) next.tools = tools
      else delete next.tools
      // 视觉入场门禁在禁生成回合易误导；保留可执行的策划门禁文案但去掉「才准渲染／才进生成」。
      if (typeof next.gate === "string" && /渲染|生成图|生成影片|镜头生成|进入任何视觉/.test(next.gate)) {
        next.gate = "策划批准门禁：用户未确认本环文本前，不进入下一策划环；本回合禁生成。"
      }
      return next
    })
  const roles = new Set(textNodes.map((n) => n.role))
  const connections: WorkflowConnectionSpec[] = template.connections.filter(
    (c) => roles.has(c.fromRole) && roles.has(c.toRole),
  )
  return {
    ...template,
    name: `${template.name}（策划瘦身）`,
    description: `禁生成／只要方案：仅文本／结构节点（源模板 ${template.id}）。无 image／video／audio／film／config 生成位。`,
    multiShot: false,
    nodes: textNodes,
    connections,
  }
}

export function listWorkflowTemplates(): { id: string; name: string; description: string; multiShot?: boolean }[] {
  return WORKFLOW_TEMPLATES.map(({ id, name, description, multiShot }) => ({ id, name, description, multiShot }))
}