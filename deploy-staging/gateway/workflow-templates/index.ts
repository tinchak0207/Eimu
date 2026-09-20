// 画布工作流模板库（Workflow Templates）
//
// 暴君策略 v2：Deepseek 只当「参数/提示词传达人」，节点流结构骨架由后端模板提供。
// 模板定义「编排好的流程」：Deepseek 填内容（prompt/model/size 等），
// 引擎（workflow-engine.ts）把模板展开成 CanvasNode[] + 连线并执行。
//
// 本目录 = 纯资料 + 纯函式（不依赖 Bun），可单独单测。
// 每个模板一个文件（<template-id>.ts），改一個模板只動一個檔，
// 部署與并行修改不再互相冲突。
//
// 注意：部署機制為逐檔 SFTP（.gateway-work/sftp-put-443.js），目錄結構
// 必須手動在 VPS 上建立 remote-dir 並逐檔上傳；舊單檔 workflow-templates.ts
// 必須刪除或重命名，否則會因 extensionless 解析優先命中舊檔而掩蔽新目錄。

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
 * 0920 暴君裁定（第二版）：模板判定完成即建骨架彈上畫布——不等 Expert 去調
 * workflow_start（實錘：Expert 根本沒調，右邊永遠空白，「太慢了」）。
 *
 * 後端 startSync 要求每個 text role 非空，故建構時用「佔位內容」先滿足驗證；
 * Expert 之後同模板呼叫 workflow_start 走 P0 冪等守衛復用同一支 wf，再用
 * workflow_update_node 回填真內容。config/image/video/audio/film role 無需 content。
 */
export function templatePlaceholderContent(templateId: string): Record<string, unknown> {
  const t = getWorkflowTemplate(templateId)
  if (!t) return {}
  const content: Record<string, unknown> = {}
  for (const n of t.nodes) {
    // 契約形狀：{ role: { content: "..." } }（startSync 逐 role 讀 c.content）；
    // 傳純字串會被判「缺少必要内容」而 400（實錘 2026-09-20）。
    if (n.kind === "text") content[n.role] = { content: `（待填：${n.title}）` }
  }
  return content
}

/** 模板清单（id/name/description/multiShot），用于注册与发现。 */
export function listWorkflowTemplates(): { id: string; name: string; description: string; multiShot?: boolean }[] {
  return WORKFLOW_TEMPLATES.map(({ id, name, description, multiShot }) => ({ id, name, description, multiShot }))
}